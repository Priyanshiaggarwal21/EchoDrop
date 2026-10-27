import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import tls from 'node:tls';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { createCollaborationStore } from './collaboration-store.mjs';
import { createRemoteTransport } from './remote-transport.mjs';
import { readCertificate, checkKey } from './remote-identity.mjs';
import { validateRemoteReply } from './remote-reply.mjs';
import { createExpiredCertificate, createSignedChildCredentials, createTestCredentials } from './test-credentials.mjs';

const credentials = {};
let hostGenerated;
for (const name of ['host', 'peer', 'attacker']) {
  const generated = await createTestCredentials(`EchoDrop TEST ONLY ${name}`, undefined, name === 'host');
  if (name === 'host') hostGenerated = generated;
  credentials[name] = { certificate: generated.certificate, key: generated.key };
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echodrop-remote-'));
  const sealed = new Map();
  // Unit test OS-protection double; native DPAPI is exercised separately in Electron.
  const protection = { seal(value) { const token = randomUUID(); sealed.set(token, value); return token; }, open(token) { if (!sealed.has(token)) throw Error('Cannot decrypt'); return sealed.get(token); } };
  const endpoints = [];
  t.after(async () => {
    for (const endpoint of endpoints) await endpoint.transport.stop();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('echodrop-remote-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  async function endpoint(name) {
    const file = path.join(root, `${name}.json`), projectId = randomUUID(), otherId = randomUUID();
    const projects = async () => ({ projects: [{ id: projectId, name: `${name} project`, description: 'PRIVATE DESCRIPTION', localRoot: 'C:/PRIVATE' }, { id: otherId, name: 'OTHER PRIVATE PROJECT' }] });
    const store = createCollaborationStore(file, projects, undefined, protection); await store.snapshot(projectId);
    await store.remoteLocal(projectId, 'import-identity', credentials[name]);
    const item = { file, projectId, otherId, store, projects, protection, transport: createRemoteTransport(store), fingerprint: readCertificate(credentials[name].certificate).fingerprint };
    endpoints.push(item); return item;
  }
  async function trust(from, to) {
    await from.store.remoteLocal(from.projectId, 'create-invitee', { displayName: 'Verified person' });
    const snapshot = await from.store.snapshot(from.projectId);
    const principalId = snapshot.directory.filter(person => person.kind === 'record').at(-1).id;
    await from.store.remoteLocal(from.projectId, 'trust-peer', { certificate: credentials[to === host ? 'host' : to === peer ? 'peer' : 'attacker'].certificate, fingerprint: to.fingerprint, principalId });
    return principalId;
  }
  const host = await endpoint('host'), peer = await endpoint('peer'), attacker = await endpoint('attacker');
  const recipientId = await trust(host, peer); await trust(peer, host); await trust(attacker, host);
  const { port } = await host.transport.start();
  const query = (action, invitationId, from = peer) => from.transport.query(host.fingerprint, '127.0.0.1', port, { version: 1, action, ...(invitationId ? { invitationId } : {}) });
  async function offer(contextId, role = 'member') {
    const snapshot = await host.store.execute(host.projectId, { action: 'prepare-invitation-draft', recipientId, role, expiresAt: null, ...(contextId ? { contextId } : {}) });
    const id = snapshot.invitationDrafts.at(-1).id;
    await host.store.remoteLocal(host.projectId, 'offer', { invitationId: id }); return id;
  }
  return { root, host, peer, attacker, recipientId, query, offer, trust, port };
}

test('real mutual TLS delivers addressed invitations; acceptance atomically creates membership', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.query('inbox'), []); assert.deepEqual(await f.query('access'), []);
  const id = await f.offer();
  assert.equal((await f.host.store.snapshot(f.host.projectId)).members.length, 1);
  const inbox = await f.query('inbox'); assert.equal(inbox[0].id, id); assert.equal(inbox[0].status, 'offered');
  assert(!JSON.stringify(inbox).includes('PRIVATE')); assert(!JSON.stringify(inbox).includes('localRoot'));
  assert.deepEqual(await f.query('access'), []);
  assert.equal((await f.query('accept', id)).status, 'accepted');
  assert.equal((await f.host.store.snapshot(f.host.projectId)).members.find(member => member.principalId === f.recipientId).role, 'member');
  assert.equal((await f.query('access'))[0].role, 'member');
});
test('untrusted client certificate and a pinned-server mismatch fail before application disclosure', async t => {
  const f = await fixture(t); await f.offer();
  await assert.rejects(f.query('inbox', undefined, f.attacker), /Secure connection/);
  const fake = await f.attacker.transport.start();
  await assert.rejects(f.peer.transport.query(f.host.fingerprint, '127.0.0.1', fake.port, { version: 1, action: 'inbox' }), /Secure connection/);
  assert.throws(() => checkKey(credentials.peer.certificate, credentials.attacker.key), /does not match/);
});
test('stolen invitation IDs and supplied actor IDs do not authorize another trusted participant', async t => {
  const f = await fixture(t); await f.trust(f.host, f.attacker); await f.host.transport.stop(); const { port } = await f.host.transport.start();
  const id = await f.offer();
  const ask = request => f.attacker.transport.query(f.host.fingerprint, '127.0.0.1', port, request);
  assert.deepEqual(await ask({ version: 1, action: 'inbox' }), []);
  await assert.rejects(ask({ version: 1, action: 'accept', invitationId: id }), /denied/);
  await assert.rejects(ask({ version: 1, action: 'accept', invitationId: id, actorId: f.recipientId }), /denied/);
  assert.equal((await f.host.store.snapshot(f.host.projectId)).members.length, 1);
});
test('accept retry is idempotent; removal and revocation prevent regrant on replay', async t => {
  const f = await fixture(t); const id = await f.offer();
  await Promise.all([f.query('accept', id), f.query('accept', id)]);
  assert.equal((await f.host.store.snapshot(f.host.projectId)).members.length, 2);
  await f.host.store.execute(f.host.projectId, { action: 'change-project-member', principalId: f.recipientId, remove: true });
  await assert.rejects(f.query('accept', id), /denied/); assert.deepEqual(await f.query('access'), []);
  assert.equal((await f.query('inbox'))[0].status, 'revoked');
});
test('decline is durable and terminal; revoked offer cannot be accepted', async t => {
  const f = await fixture(t); const id = await f.offer();
  assert.equal((await f.query('decline', id)).status, 'declined');
  assert.equal((await f.query('decline', id)).status, 'declined');
  await assert.rejects(f.query('accept', id), /denied/);
  const next = await f.offer(); await f.host.store.remoteLocal(f.host.projectId, 'revoke', { invitationId: next });
  await assert.rejects(f.query('accept', next), /denied/);
});
test('expired offers cannot create membership and expiry survives a restart', async t => {
  const f = await fixture(t); const id = await f.offer();
  const raw = JSON.parse(await fs.readFile(f.host.file)); const draft = raw.invitationDrafts[0]; draft.createdAt = '2020-01-01T00:00:00.000Z'; draft.expiresAt = '2020-01-02T00:00:00.000Z';
  await fs.writeFile(f.host.file, JSON.stringify(raw));
  await assert.rejects(f.query('accept', id), /denied/);
  assert.equal((await f.query('inbox'))[0].status, 'expired');
  const restored = createCollaborationStore(f.host.file, f.host.projects, undefined, f.host.protection);
  assert.equal((await restored.snapshot(f.host.projectId)).invitationDrafts[0].status, 'expired');
});
test('context access is explicit; project revocation removes all dependent remote scope access', async t => {
  const f = await fixture(t); const id = await f.offer(); await f.query('accept', id);
  const ctx = (await f.host.store.execute(f.host.projectId, { action: 'create-context', name: 'Private context', purpose: 'PRIVATE PURPOSE' })).contexts[0];
  assert.equal((await f.query('access')).length, 1);
  const contextId = await f.offer(ctx.id, 'guest'); await f.query('accept', contextId);
  const scopes = await f.query('access'); assert.equal(scopes.length, 2); assert.equal(scopes[1].role, 'guest'); assert(!JSON.stringify(scopes).includes('PURPOSE'));
  await f.host.store.remoteLocal(f.host.projectId, 'revoke', { invitationId: id });
  assert.deepEqual(await f.query('access'), []); await assert.rejects(f.query('accept', contextId), /denied/);
});
test('cross-project offer/revoke and remote administration are rejected; role caps cannot escalate', async t => {
  const f = await fixture(t); const id = await f.offer(); await f.query('accept', id);
  await f.host.store.snapshot(f.host.otherId);
  await assert.rejects(f.host.store.remoteLocal(f.host.otherId, 'revoke', { invitationId: id }), /denied/);
  await assert.rejects(f.query('create-team'), /denied/);
  await f.host.store.execute(f.host.projectId, { action: 'change-project-member', principalId: f.recipientId, role: 'owner' });
  assert.equal((await f.query('access'))[0].role, 'member');
  await f.host.store.execute(f.host.projectId, { action: 'change-project-member', principalId: f.recipientId, role: 'guest' });
  assert.equal((await f.query('access'))[0].role, 'guest');
});
test('restart restores key binding, trust, decisions and memberships; listener stays opt-in', async t => {
  const f = await fixture(t); const id = await f.offer(); await f.query('accept', id); await f.host.transport.stop();
  const restored = createCollaborationStore(f.host.file, f.host.projects, undefined, f.host.protection);
  const transport = createRemoteTransport(restored); t.after(() => transport.stop());
  assert.equal(transport.state().listening, false); const { port } = await transport.start();
  const result = await f.peer.transport.query(f.host.fingerprint, '127.0.0.1', port, { version: 1, action: 'accept', invitationId: id });
  assert.equal(result.status, 'accepted'); assert.equal((await restored.snapshot(f.host.projectId)).members.length, 2);
});
test('revoking certificate trust blocks already provisioned transport and all its invitations', async t => {
  const f = await fixture(t); const id = await f.offer(); await f.query('accept', id);
  await f.host.store.remoteLocal(f.host.projectId, 'revoke-peer', { fingerprint: f.peer.fingerprint });
  await assert.rejects(f.query('inbox'), /Secure connection/);
  assert.equal((await f.host.store.snapshot(f.host.projectId)).invitationDrafts[0].status, 'revoked');
  await assert.rejects(f.host.store.remoteLocal(f.host.projectId, 'trust-peer', { certificate: credentials.peer.certificate, fingerprint: f.peer.fingerprint, principalId: f.recipientId }), /already bound/);
});
test('corrupt identity binding is preserved; neither keys nor seal reach renderer snapshots', async t => {
  const f = await fixture(t); const snapshot = await f.host.store.snapshot(f.host.projectId); const status = await f.host.store.remoteStatus();
  assert(!JSON.stringify([snapshot, status]).includes('PRIVATE KEY')); assert(!JSON.stringify([snapshot, status]).includes('sealedKey'));
  const raw = JSON.parse(await fs.readFile(f.host.file)); raw.remoteIdentity.participantId = randomUUID(); const text = JSON.stringify(raw); await fs.writeFile(f.host.file, text);
  await assert.rejects(f.host.store.remoteCredentials(), /corrupt/); assert.equal(await fs.readFile(f.host.file, 'utf8'), text);
});
test('failed atomic acceptance leaves the offered invitation and all memberships unchanged', async t => {
  const f = await fixture(t); const id = await f.offer(); const before = await fs.readFile(f.host.file, 'utf8');
  const failing = createCollaborationStore(f.host.file, f.host.projects, { ...fs, rename: async () => { throw Error('Disk failure'); } }, f.host.protection);
  await assert.rejects(failing.remoteRequest(f.peer.fingerprint, { version: 1, action: 'accept', invitationId: id }), /Disk failure/);
  assert.equal(await fs.readFile(f.host.file, 'utf8'), before); assert.deepEqual(await f.query('access'), []);
});
test('plaintext and TLS 1.2 cannot use the collaboration listener', async t => {
  const f = await fixture(t);
  await new Promise((resolve, reject) => {
    const socket = net.connect(f.port, '127.0.0.1', () => socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n'));
    const timer = setTimeout(() => { socket.destroy(); reject(Error('Plaintext socket not closed')); }, 3000);
    socket.on('error', () => {}); socket.on('data', data => assert(!data.toString().includes('project'))); socket.on('close', () => { clearTimeout(timer); resolve(); });
  });
  await new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port: f.port, maxVersion: 'TLSv1.2', rejectUnauthorized: false });
    socket.once('secureConnect', () => { socket.destroy(); reject(Error('Legacy TLS connected')); }); socket.once('error', () => resolve());
  });
});
test('untrusted reply shapes and fake fingerprint confirmation are rejected', async t => {
  const f = await fixture(t);
  assert.throws(() => validateRemoteReply({ actor: 'owner', path: 'C:/PRIVATE' }), /unsupported/);
  await f.host.store.remoteLocal(f.host.projectId, 'create-invitee', { displayName: 'Another person' });
  const principalId = (await f.host.store.snapshot(f.host.projectId)).directory.at(-1).id;
  await assert.rejects(f.host.store.remoteLocal(f.host.projectId, 'trust-peer', { certificate: credentials.attacker.certificate, fingerprint: f.peer.fingerprint, principalId }), /does not match/);
});

test('a certificate signed by a trusted peer is not the pinned participant identity', async t => {
  const f = await fixture(t);
  const child = await createSignedChildCredentials(hostGenerated);
  await new Promise((resolve, reject) => {
    let applicationBytes = 0;
    const socket = tls.connect({ host: '127.0.0.1', port: f.port, key: child.key, cert: child.certificate, ca: [credentials.host.certificate], rejectUnauthorized: true, minVersion: 'TLSv1.3', ALPNProtocols: ['echodrop-collaboration/1'], checkServerIdentity: (_host, cert) => cert.fingerprint256 === f.host.fingerprint ? undefined : Error('Wrong host') });
    const timer = setTimeout(() => { socket.destroy(); reject(Error('Unpinned identity was not disconnected')); }, 3000);
    socket.on('secureConnect', () => socket.write(JSON.stringify({ version: 1, action: 'inbox' }) + '\n'));
    socket.on('data', data => { applicationBytes += data.length; }); socket.on('error', () => {});
    socket.once('close', () => { clearTimeout(timer); try { assert.equal(applicationBytes, 0); resolve(); } catch (error) { reject(error); } });
  });
});
test('expired certificates and unsupported Electron runtimes are rejected', async () => {
  const expired = await createExpiredCertificate();
  assert.throws(() => readCertificate(expired), /not currently valid/);
  const { runtimeBlocker } = await import('./remote-transport.mjs');
  assert.match(runtimeBlocker({ electron: '33.4.11', node: '20.18.3' }), /Electron 45/);
  assert.equal(runtimeBlocker({ electron: '45.0.0', node: '24.22.0' }), null);
});
test('pre-existing local membership and certificate trust never confer remote project access', async t => {
  const f = await fixture(t);
  await f.host.store.execute(f.host.projectId, { action: 'add-project-member', principalId: f.recipientId, role: 'member' });
  assert.deepEqual(await f.query('access'), []);
  const id = await f.offer(); assert.deepEqual(await f.query('access'), []);
  await f.query('accept', id); assert.equal((await f.query('access')).length, 1);
});
test('remote IPC denies untrusted frames before disk/dialog/network work and cannot import renderer key material', async t => {
  const { createRequire } = await import('node:module');
  const { installRemoteCollaboration } = createRequire(import.meta.url)('./remote-ipc.cjs');
  let reads = 0; const handlers = new Map();
  const f = await fixture(t);
  installRemoteCollaboration({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trusted: event => { if (event !== 'local') throw Error('Untrusted'); }, getStore: async () => { reads++; return f.host.store; } });
  const invoke = handlers.get('workspace:remote-collaboration');
  await assert.rejects(invoke('LAN device', f.host.projectId, 'start'), /Untrusted/); assert.equal(reads, 0);
  await assert.rejects(invoke('local', f.host.projectId, 'executeAs', { actorId: f.recipientId }), /Unsupported/);
  await assert.rejects(invoke('local', f.host.projectId, 'import-identity', { certificate: 'injected', key: 'injected' }), /native certificate/);
});

test('context capability stays capped by the accepted project invitation after local role promotion', async t => {
  const f = await fixture(t); const id = await f.offer(undefined, 'guest'); await f.query('accept', id);
  const ctx = (await f.host.store.execute(f.host.projectId, { action: 'create-context', name: 'Restricted context', purpose: '' })).contexts[0];
  const contextId = await f.offer(ctx.id, 'member'); await f.query('accept', contextId);
  await f.host.store.execute(f.host.projectId, { action: 'change-project-member', principalId: f.recipientId, role: 'member' });
  const scopes = await f.query('access'); assert.equal(scopes.length, 2); assert(scopes.every(scope => scope.role === 'guest'));
});
