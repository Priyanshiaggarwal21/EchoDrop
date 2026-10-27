import {createDevicePairing} from './device-pairing.mjs';
import {deviceInvitation,parseDeviceInvitation} from '../../packages/core/device-pairing.mjs';
import {createPulseStore} from './pulse-store.mjs';
import {derivePulse,pulseClientModel} from '../../packages/core/pulse.mjs';
import {captureEnvironment} from './environment-capture.mjs';
import {createEnvironmentStore} from './environment-store.mjs';
import {environmentFields,environmentClientModel,compareEnvironments} from '../../packages/core/environments.mjs';
import {createContractStore} from './contract-store.mjs';
import {contractClientModel,validateContractDocument} from '../../packages/core/contracts.mjs';
import {compareContracts} from '../../packages/core/contract-compatibility.mjs';
import {createIntentionStore} from './intention-store.mjs';
import {createIntentionClient} from './intention-client.mjs';
import {intentPath,intentFields,intentCollisions} from '../../packages/core/intentions.mjs';
import { createSecureContentStore } from './secure-content-store.mjs';
import { createContentReceiver } from './secure-content-receiver.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import tls from 'node:tls';
import net from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { createCollaborationStore } from './collaboration-store.mjs';
import { createRemoteTransport } from './remote-transport.mjs';
import { readCertificate, checkKey } from './remote-identity.mjs';
import { validateRemoteReply } from './remote-reply.mjs';
import { createTestCredentials } from './test-credentials.mjs';

const credentials = {};
for (const name of ['host', 'peer', 'attacker']) credentials[name] = await createTestCredentials(`EchoDrop TEST ONLY ${name}`);
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
    const item = { file, projectId, otherId, store, projects, protection, transport: createRemoteTransport(store,undefined,undefined,undefined,undefined,undefined,createDevicePairing(path.join(root,name+'-devices.json'),store,{protection}).handle), fingerprint: readCertificate(credentials[name].certificate).fingerprint };
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




async function setup(t){const f=await fixture(t);f.devices=createDevicePairing(path.join(f.root,'host-devices.json'),f.host.store,{protection:f.host.protection});f.invite=()=>f.devices.local(f.host.projectId,'create',{fingerprint:f.peer.fingerprint,deviceName:'Peer desktop'});f.ask=(i,action,extra={})=>f.peer.transport.query(f.host.fingerprint,'127.0.0.1',f.port,{version:1,id:i.id,action,...extra});return f;}
test('QR and manual parsing share strict public-only validation',()=>{const payload={v:1,id:randomUUID(),projectId:randomUUID(),host:'127.0.0.1',port:1234,fingerprint:readCertificate(credentials.host.certificate).fingerprint,recipient:readCertificate(credentials.peer.certificate).fingerprint,expiresAt:Date.now()+300000};assert.deepEqual(parseDeviceInvitation(deviceInvitation(payload)),payload);for(const value of ['http://host/?token=secret','echodrop-pair:bad',deviceInvitation(payload)+'extra'])assert.throws(()=>parseDeviceInvitation(value));assert.throws(()=>deviceInvitation({...payload,privateKey:'secret'}));assert.throws(()=>deviceInvitation({...payload,port:0}));});
test('real TLS claim, both-device approval, single-use acceptance and persisted reconnect',async t=>{const f=await setup(t),i=await f.invite();const before=await f.host.store.snapshot(f.host.projectId);await assert.rejects(f.ask(i,'device-accept'));await f.ask(i,'device-request',{deviceName:'Verified laptop'});await assert.rejects(f.devices.local(f.host.projectId,'approve',{id:i.id,fingerprint:f.host.fingerprint}));await f.devices.local(f.host.projectId,'approve',{id:i.id,fingerprint:f.peer.fingerprint});assert.equal((await f.ask(i,'device-accept')).status,'accepted');await assert.rejects(f.ask(i,'device-accept'));const result=await f.ask(i,'device-reconnect');assert(result.lastSeen);const restored=createDevicePairing(path.join(f.root,'host-devices.json'),f.host.store,{protection:f.host.protection});assert.equal((await restored.local(f.host.projectId,'list'))[0].status,'accepted');const after=await f.host.store.snapshot(f.host.projectId);assert.deepEqual(after.members,before.members);assert.equal((await f.query('access')).length,0);});
test('simultaneous joins consume invitation once and decline is terminal',async t=>{const f=await setup(t),i=await f.invite();const replies=await Promise.allSettled([f.ask(i,'device-request',{deviceName:'First'}),f.ask(i,'device-request',{deviceName:'Second'})]);assert.equal(replies.filter(x=>x.status==='fulfilled').length,1);await f.ask(i,'device-decline');await assert.rejects(f.ask(i,'device-request',{deviceName:'Replay'}));await assert.rejects(f.devices.local(f.host.projectId,'approve',{id:i.id,fingerprint:f.peer.fingerprint}));});
test('expiry and corruption fail closed without replacing records',async t=>{const f=await setup(t);let now=Date.now();const file=path.join(f.root,'expiring-devices.json');const devices=createDevicePairing(file,f.host.store,{protection:f.host.protection,now:()=>now});const i=await devices.local(f.host.projectId,'create',{fingerprint:f.peer.fingerprint,deviceName:'Expiring'});now+=300001;await assert.rejects(devices.handle(f.peer.fingerprint,{version:1,action:'device-request',id:i.id,deviceName:'Late'}));assert.equal((await devices.local(f.host.projectId,'list'))[0].status,'expired');await fs.writeFile(file,'broken');await assert.rejects(devices.local(f.host.projectId,'list'),/corrupt/);assert.equal(await fs.readFile(file,'utf8'),'broken');});
test('identity binding, context isolation and global revocation prevent reconnection',async t=>{const f=await setup(t),i=await f.invite();await assert.rejects(f.devices.handle(f.host.fingerprint,{version:1,id:i.id,action:'device-request',deviceName:'Impersonator'}));await assert.rejects(f.devices.local(f.host.projectId,'create',{fingerprint:f.peer.fingerprint,deviceName:'Escalated',contextId:randomUUID()}));await assert.rejects(f.peer.transport.query(f.host.fingerprint,'127.0.0.1',f.port,{version:1,id:i.id,action:'device-request',deviceName:'Escalated',role:'owner'}));await f.devices.local(f.host.projectId,'revoke',{id:i.id});await assert.rejects(f.ask(i,'device-reconnect'));await assert.rejects(f.invite());});
