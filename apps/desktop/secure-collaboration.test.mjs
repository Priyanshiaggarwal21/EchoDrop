import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCollaborationStore } from './collaboration-store.mjs';
import { osIdentityProtection } from './participant-identity.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echodrop-identity-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('echodrop-identity-')); await fs.rm(root, { recursive: true, force: true }); });
  // Test double only: real Windows DPAPI is provided by Electron safeStorage.
  const sealed = new Map();
  const protection = { seal(value) { const token = randomUUID(); sealed.set(token, value); return token; }, open(token) { if (!sealed.has(token)) throw Error('Wrong account'); return sealed.get(token); } };
  const file = path.join(root, 'collaboration.json'), a = randomUUID(), b = randomUUID();
  const projects = async () => ({ projects: [{ id: a }, { id: b }] });
  const restart = () => createCollaborationStore(file, projects, undefined, protection);
  const store = restart(); const initial = await store.snapshot(a);
  const result = await store.execute(a, { action: 'add-project-member', displayName: 'Recipient', role: 'member' });
  const recipientId = result.members.find(member => member.displayName === 'Recipient').principalId;
  const command = { action: 'prepare-invitation-draft', recipientId, role: 'member', expiresAt: null };
  return { file, a, b, store, restart, projects, initial, recipientId, command };
}

test('protected local identity persists across restart, binds existing owner and never exports seal', async t => {
  const f = await fixture(t); const restored = await f.restart().snapshot(f.a);
  assert.deepEqual(restored.localParticipant, f.initial.localParticipant);
  assert.equal(restored.localParticipant.principalId, restored.actor.id);
  const raw = JSON.parse(await fs.readFile(f.file));
  assert(raw.localParticipant.seal); assert(!JSON.stringify(restored).includes(raw.localParticipant.seal));
});
test('legacy enrollment is additive and keeps the original administrator', async t => {
  const f = await fixture(t); const raw = JSON.parse(await fs.readFile(f.file)); delete raw.localParticipant;
  await fs.writeFile(f.file, JSON.stringify(raw)); const view = await f.restart().snapshot(f.a);
  assert.equal(view.actor.id, f.initial.actor.id); assert.equal(view.members.length, 2);
});
test('identity mismatch, wrong account and missing protection fail closed without rewriting', async t => {
  const f = await fixture(t); const raw = JSON.parse(await fs.readFile(f.file)); raw.localParticipant.principalId = f.recipientId;
  const text = JSON.stringify(raw); await fs.writeFile(f.file, text);
  await assert.rejects(f.restart().snapshot(f.a), /could not be verified/);
  assert.equal(await fs.readFile(f.file, 'utf8'), text);
  await assert.rejects(createCollaborationStore(f.file, f.projects).snapshot(f.a), /provider/);
  raw.localParticipant.principalId = raw.localPrincipalId; raw.localParticipant.seal = 'unknown'; await fs.writeFile(f.file, JSON.stringify(raw));
  await assert.rejects(f.restart().snapshot(f.a), /could not be verified/);
});
test('OS protection refuses unavailable encryption and Linux plaintext fallback', () => {
  assert.throws(() => osIdentityProtection({ isEncryptionAvailable: () => false }).seal('secret'), /unavailable/);
  assert.throws(() => osIdentityProtection({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' }, 'linux').open('secret'), /unavailable/);
});
test('drafts persist without granting membership, duplicates and terminal replay are rejected', async t => {
  const f = await fixture(t); const before = await f.store.snapshot(f.a);
  const view = await f.store.execute(f.a, f.command); const id = view.invitationDrafts[0].id;
  assert.deepEqual(view.members, before.members);
  assert.equal((await f.restart().snapshot(f.a)).invitationDrafts[0].id, id);
  await assert.rejects(f.store.execute(f.a, f.command), /already exists/);
  await f.store.execute(f.a, { action: 'revoke-invitation-draft', invitationId: id });
  await assert.rejects(f.store.execute(f.a, { action: 'revoke-invitation-draft', invitationId: id }), /terminal/);
  assert.notEqual((await f.store.execute(f.a, f.command)).invitationDrafts[1].id, id);
});
test('project and context boundaries deny draft creation, viewing and revocation', async t => {
  const f = await fixture(t); const draft = (await f.store.execute(f.a, f.command)).invitationDrafts[0];
  assert.equal((await f.store.snapshot(f.b)).invitationDrafts.length, 0);
  await assert.rejects(f.store.execute(f.b, { action: 'revoke-invitation-draft', invitationId: draft.id }), /denied/);
  await assert.rejects(f.store.execute(f.b, f.command), /visible/);
  const ctx = (await f.store.execute(f.b, { action: 'create-context', name: 'Private', purpose: '' })).contexts[0];
  await assert.rejects(f.store.execute(f.a, { ...f.command, contextId: ctx.id }), /permission/);
});
test('unauthorized actors and role escalation are denied; device and accept commands are not supported', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.executeAs(f.a, f.recipientId, f.command), /permission/);
  const view = await f.store.execute(f.a, { action: 'add-project-member', displayName: 'Admin', role: 'admin' });
  const admin = view.members.find(member => member.displayName === 'Admin').principalId;
  await assert.rejects(f.store.executeAs(f.a, admin, { ...f.command, role: 'owner' }), /permission/);
  for (const action of ['accept-invitation', 'decline-invitation']) await assert.rejects(f.store.execute(f.a, { action }), /Unsupported/);
  await assert.rejects(f.store.execute(f.a, { ...f.command, actorId: admin }), /Unsupported/);
  await assert.rejects(f.store.execute(f.a, { ...f.command, deviceSession: 'approved' }), /Unsupported/);
});
test('expiry is persisted on read and cannot be replayed', async t => {
  const f = await fixture(t); await f.store.execute(f.a, f.command);
  const raw = JSON.parse(await fs.readFile(f.file)); const draft = raw.invitationDrafts[0];
  draft.createdAt = '2020-01-01T00:00:00.000Z'; draft.expiresAt = '2020-01-02T00:00:00.000Z';
  await fs.writeFile(f.file, JSON.stringify(raw));
  assert.equal((await f.restart().snapshot(f.a)).invitationDrafts[0].status, 'expired');
  assert.equal(JSON.parse(await fs.readFile(f.file)).invitationDrafts[0].status, 'expired');
  await assert.rejects(f.store.execute(f.a, { action: 'revoke-invitation-draft', invitationId: draft.id }), /terminal/);
});
test('issuer demotion revokes pending drafts and context grants remain explicit', async t => {
  const f = await fixture(t);
  const view = await f.store.execute(f.a, { action: 'add-project-member', displayName: 'Admin', role: 'admin' });
  const admin = view.members.find(member => member.displayName === 'Admin').principalId;
  await f.store.executeAs(f.a, admin, f.command);
  const result = await f.store.execute(f.a, { action: 'change-project-member', principalId: admin, role: 'member' });
  assert.equal(result.invitationDrafts[0].status, 'revoked');
  const ctx = (await f.store.execute(f.a, { action: 'create-context', name: 'Release', purpose: '' })).contexts[0];
  await assert.rejects(f.store.executeAs(f.a, admin, { ...f.command, contextId: ctx.id }), /permission/);
  const prepared = await f.store.execute(f.a, { ...f.command, contextId: ctx.id });
  assert.equal(prepared.contexts[0].members.length, 1);
});
test('corrupt draft scope is preserved and blocks registry access', async t => {
  const f = await fixture(t); await f.store.execute(f.a, f.command);
  const raw = JSON.parse(await fs.readFile(f.file)); raw.invitationDrafts[0].contextId = randomUUID();
  const text = JSON.stringify(raw); await fs.writeFile(f.file, text);
  await assert.rejects(f.restart().snapshot(f.a), /corrupt/);
  assert.equal(await fs.readFile(f.file, 'utf8'), text);
});

test('context draft is revoked when recipient project access is removed', async t => {
  const f = await fixture(t);
  const ctx = (await f.store.execute(f.a, { action: 'create-context', name: 'Release', purpose: '' })).contexts[0];
  await f.store.execute(f.a, { ...f.command, contextId: ctx.id });
  const view = await f.store.execute(f.a, { action: 'change-project-member', principalId: f.recipientId, remove: true });
  assert.equal(view.invitationDrafts[0].status, 'revoked');
});
