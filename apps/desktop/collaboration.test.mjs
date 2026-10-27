import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createCollaborationStore } from './collaboration-store.mjs';
import { validateCollaboration, contextAccess } from '../../packages/core/collaboration.mjs';
const { installCollaboration } = createRequire(import.meta.url)('./collaboration-ipc.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echodrop-collaboration-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('echodrop-collaboration-')); await fs.rm(root, { recursive: true, force: true }); });
  const file = path.join(root, 'collaboration.json'), a = randomUUID(), b = randomUUID();
  const getProjects = async () => ({ projects: [{ id: a }, { id: b }], readOnly: false, warning: '' });
  const store = createCollaborationStore(file, getProjects);
  const initial = await store.snapshot(a);
  return { root, file, a, b, getProjects, store, owner: initial.actor.id };
}
async function person(store, projectId, name = 'Alex', role = 'member') {
  const result = await store.execute(projectId, { action: 'add-project-member', displayName: name, role });
  return result.members.find(member => member.displayName === name).principalId;
}
async function context(store, projectId, name = 'Release') {
  const result = await store.execute(projectId, { action: 'create-context', name, purpose: 'Coordinate a release' });
  return result.contexts.find(item => item.name === name).id;
}
test('solo enrollment persists one stable local owner without duplicate grants', async t => {
  const f = await fixture(t); await f.store.snapshot(f.a);
  const restored = await createCollaborationStore(f.file, f.getProjects).snapshot(f.a);
  assert.equal(restored.actor.id, f.owner); assert.equal(restored.members.length, 1); assert.equal(restored.role, 'owner'); assert.equal(restored.teams.length, 0);
});
test('project membership and approved-looking device identifiers never confer cross-project access', async t => {
  const f = await fixture(t); const member = await person(f.store, f.a); await f.store.snapshot(f.b);
  await assert.rejects(f.store.snapshotAs(f.b, member), /access denied/);
  await assert.rejects(f.store.snapshotAs(f.a, randomUUID()), /access denied/);
  await assert.rejects(f.store.execute(f.a, { action: 'create-team', displayName: 'Forged', actorId: member }), /Unsupported/);
});
test('reusable team associations do not enroll the roster in either project', async t => {
  const f = await fixture(t); const result = await f.store.execute(f.a, { action: 'create-team', displayName: 'Studio' }); const teamId = result.teams[0].id;
  const withMember = await f.store.execute(f.a, { action: 'add-team-member', teamId, displayName: 'Taylor', role: 'member' });
  const id = withMember.teams[0].members.find(member => member.displayName === 'Taylor').principalId;
  await f.store.execute(f.b, { action: 'associate-team', teamId });
  await assert.rejects(f.store.snapshotAs(f.a, id), /access denied/); await assert.rejects(f.store.snapshotAs(f.b, id), /access denied/);
  assert.equal((await f.store.snapshot(f.b)).teams[0].id, teamId);
});
test('team administration requires explicit team authority as well as project authority', async t => {
  const f = await fixture(t); const admin = await person(f.store, f.a, 'Admin', 'admin');
  const teamId = (await f.store.execute(f.a, { action: 'create-team', displayName: 'Private team' })).teams[0].id;
  await assert.rejects(f.store.executeAs(f.a, admin, { action: 'rename-team', teamId, displayName: 'Stolen' }), /permission/);
  const view = await f.store.snapshotAs(f.a, admin); assert.equal(view.teams.length, 0); assert.equal(view.restrictedTeams, 1);
});
test('member and guest actors cannot mutate project, team or context grants', async t => {
  const f = await fixture(t);
  for (const role of ['member', 'guest']) {
    const id = await person(f.store, f.a, role, role);
    for (const command of [{ action: 'create-team', displayName: 'No' }, { action: 'create-context', name: 'No', purpose: '' }, { action: 'add-project-member', displayName: 'No', role: 'owner' }]) await assert.rejects(f.store.executeAs(f.a, id, command), /permission/);
  }
});
test('admins can change member/guest roles but cannot promote or modify admins/owners', async t => {
  const f = await fixture(t); const admin = await person(f.store, f.a, 'Admin', 'admin'); const member = await person(f.store, f.a);
  await f.store.executeAs(f.a, admin, { action: 'change-project-member', principalId: member, role: 'guest' });
  assert.equal((await f.store.snapshotAs(f.a, member)).role, 'guest');
  for (const command of [{ action: 'change-project-member', principalId: member, role: 'admin' }, { action: 'change-project-member', principalId: f.owner, role: 'guest' }, { action: 'change-project-member', principalId: admin, remove: true }]) await assert.rejects(f.store.executeAs(f.a, admin, command), /Only an owner/);
});
test('final project owner cannot be removed or demoted; local administrator cannot be locked out', async t => {
  const f = await fixture(t);
  for (const change of [{ remove: true }, { role: 'admin' }]) await assert.rejects(f.store.execute(f.a, { action: 'change-project-member', principalId: f.owner, ...change }), /final active owner/);
  await person(f.store, f.a, 'Second owner', 'owner');
  await assert.rejects(f.store.execute(f.a, { action: 'change-project-member', principalId: f.owner, remove: true }), /local administrator/);
});
test('owner can promote, demote and remove other owners without losing the final owner', async t => {
  const f = await fixture(t); const id = await person(f.store, f.a);
  await f.store.execute(f.a, { action: 'change-project-member', principalId: id, role: 'owner' });
  await f.store.execute(f.a, { action: 'change-project-member', principalId: id, role: 'admin' });
  await f.store.execute(f.a, { action: 'change-project-member', principalId: id, remove: true });
  await assert.rejects(f.store.snapshotAs(f.a, id), /access denied/);
});
test('project membership gives no implicit context access, even to a project admin', async t => {
  const f = await fixture(t); const admin = await person(f.store, f.a, 'Admin', 'admin'); const contextId = await context(f.store, f.a);
  assert.equal((await f.store.snapshotAs(f.a, admin)).contexts.length, 0);
  await assert.rejects(f.store.executeAs(f.a, admin, { action: 'edit-context', contextId, name: 'No', purpose: '' }), /Context access denied/);
});
test('context IDs from another project cannot be viewed, edited or used for grants', async t => {
  const f = await fixture(t); const contextId = await context(f.store, f.a); await f.store.snapshot(f.b);
  assert.equal((await f.store.snapshot(f.b)).contexts.length, 0);
  await assert.rejects(f.store.execute(f.b, { action: 'edit-context', contextId, name: 'No', purpose: '' }), /Context access denied/);
  await assert.rejects(f.store.execute(f.b, { action: 'add-context-member', contextId, principalId: f.owner, role: 'owner' }), /Context access denied/);
});
test('context membership requires an active project grant, not merely team membership', async t => {
  const f = await fixture(t); const teamId = (await f.store.execute(f.a, { action: 'create-team', displayName: 'Team' })).teams[0].id;
  const team = await f.store.execute(f.a, { action: 'add-team-member', teamId, displayName: 'Team only', role: 'member' }); const id = team.teams[0].members.find(member => member.displayName === 'Team only').principalId;
  const contextId = await context(f.store, f.a);
  await assert.rejects(f.store.execute(f.a, { action: 'add-context-member', contextId, principalId: id, role: 'member' }), /before granting context/);
  await f.store.execute(f.a, { action: 'add-project-member', principalId: id, role: 'member' });
  await f.store.execute(f.a, { action: 'add-context-member', contextId, principalId: id, role: 'member' });
  assert.equal((await f.store.snapshotAs(f.a, id)).contexts.length, 1);
});
test('context scopes stay independent and effective access uses the least privileged grant', async t => {
  const f = await fixture(t); const id = await person(f.store, f.a, 'Guest', 'guest'); const a = await context(f.store, f.a, 'A'); await context(f.store, f.a, 'B');
  await f.store.execute(f.a, { action: 'add-context-member', contextId: a, principalId: id, role: 'member' });
  const view = await f.store.snapshotAs(f.a, id); assert.equal(view.contexts.length, 1); assert.equal(view.contexts[0].id, a); assert.equal(view.contexts[0].access.canContribute, false); assert.equal(view.contexts[0].access.canManage, false);
  await assert.rejects(f.store.execute(f.a, { action: 'change-context-member', contextId: a, principalId: id, role: 'admin' }), /also need project/);
});
test('project removal atomically revokes its contexts but not other projects or team memberships', async t => {
  const f = await fixture(t); const id = await person(f.store, f.a); const contextId = await context(f.store, f.a);
  const teamId = (await f.store.execute(f.a, { action: 'create-team', displayName: 'Shared' })).teams[0].id;
  await f.store.execute(f.a, { action: 'add-team-member', teamId, principalId: id, role: 'member' }); await f.store.execute(f.b, { action: 'associate-team', teamId });
  await f.store.execute(f.b, { action: 'add-project-member', principalId: id, role: 'member' });
  await f.store.execute(f.a, { action: 'add-context-member', contextId, principalId: id, role: 'member' });
  await f.store.execute(f.a, { action: 'change-project-member', principalId: id, remove: true });
  assert.equal((await f.store.snapshotAs(f.b, id)).role, 'member');
  const stored = JSON.parse(await fs.readFile(f.file)); assert.equal(stored.contextMembers.find(member => member.principalId === id).status, 'removed'); assert.equal(stored.teamMembers.find(member => member.principalId === id).status, 'active');
  await f.store.execute(f.a, { action: 'add-project-member', principalId: id, role: 'member' }); assert.equal((await f.store.snapshotAs(f.a, id)).contexts.length, 0);
});
test('team unlink/removal do not silently revoke independent project grants', async t => {
  const f = await fixture(t); const id = await person(f.store, f.a); const teamId = (await f.store.execute(f.a, { action: 'create-team', displayName: 'Shared' })).teams[0].id;
  await f.store.execute(f.a, { action: 'add-team-member', teamId, principalId: id, role: 'member' });
  await f.store.execute(f.a, { action: 'change-team-member', teamId, principalId: id, remove: true }); assert.equal((await f.store.snapshotAs(f.a, id)).role, 'member');
  await f.store.execute(f.a, { action: 'unlink-team', teamId }); assert.equal((await f.store.snapshot(f.a)).availableTeams[0].id, teamId);
});
test('context owner protection prevents orphaning during project removal or demotion', async t => {
  const f = await fixture(t); const id = await person(f.store, f.a, 'Admin', 'admin');
  const result = await f.store.executeAs(f.a, id, { action: 'create-context', name: 'Private context', purpose: '' }); const contextId = result.contexts[0].id;
  for (const change of [{ remove: true }, { role: 'member' }]) await assert.rejects(f.store.execute(f.a, { action: 'change-project-member', principalId: id, ...change }), /another context owner/);
  await assert.rejects(f.store.executeAs(f.a, id, { action: 'change-context-member', contextId, principalId: id, remove: true }), /Only an owner/);
});
test('restart restores team/context IDs, grants and removal tombstones', async t => {
  const f = await fixture(t); const id = await person(f.store, f.a); const contextId = await context(f.store, f.a);
  await f.store.execute(f.a, { action: 'add-context-member', contextId, principalId: id, role: 'member' }); await f.store.execute(f.a, { action: 'change-context-member', contextId, principalId: id, remove: true });
  const teamId = (await f.store.execute(f.a, { action: 'create-team', displayName: 'Team' })).teams[0].id;
  const restarted = createCollaborationStore(f.file, f.getProjects); const view = await restarted.snapshot(f.a);
  assert.equal(view.teams[0].id, teamId); assert.equal(view.contexts[0].id, contextId); assert.equal(view.contexts[0].members.find(member => member.principalId === id).status, 'removed');
});
test('concurrent membership mutations serialize without losing records', async t => {
  const f = await fixture(t); await Promise.all(Array.from({ length: 8 }, (_, i) => person(f.store, f.a, `Member ${i}`)));
  assert.equal((await f.store.snapshot(f.a)).members.length, 9);
});
test('invalid JSON fails closed and preserves the original collaboration registry', async t => {
  const f = await fixture(t); await fs.writeFile(f.file, '{broken');
  await assert.rejects(f.store.snapshot(f.a), /Access is blocked/); await assert.rejects(f.store.execute(f.a, { action: 'create-team', displayName: 'No' }), /preserved/); assert.equal(await fs.readFile(f.file, 'utf8'), '{broken');
});
test('future versions, duplicate grants and orphan context grants fail closed', async t => {
  const f = await fixture(t); const id = await context(f.store, f.a); const original = JSON.parse(await fs.readFile(f.file));
  for (const change of [data => data.version = 2, data => data.projectMembers.push({ ...data.projectMembers[0], id: randomUUID() }), data => data.contextMembers[0].principalId = randomUUID(), data => data.contexts[0].projectId = randomUUID()]) {
    const data = structuredClone(original); change(data); const raw = JSON.stringify(data); await fs.writeFile(f.file, raw);
    await assert.rejects(f.store.snapshot(f.a), /Access is blocked/); assert.equal(await fs.readFile(f.file, 'utf8'), raw);
  }
  assert(contextAccess(original, f.a, id, f.owner).canManage);
});
test('unknown metadata is preserved and failed atomic writes leave prior grants intact', async t => {
  const f = await fixture(t); const data = JSON.parse(await fs.readFile(f.file)); data.extension = { future: true }; data.scopes[0].metadata.future = 'preserve'; await fs.writeFile(f.file, JSON.stringify(data));
  await person(f.store, f.a); const raw = await fs.readFile(f.file, 'utf8'); assert.equal(JSON.parse(raw).extension.future, true); assert.equal(JSON.parse(raw).scopes[0].metadata.future, 'preserve');
  const failing = createCollaborationStore(f.file, f.getProjects, { ...fs, rename: async () => { throw new Error('Simulated rename failure'); } });
  await assert.rejects(failing.execute(f.a, { action: 'create-team', displayName: 'No' }), /Simulated/); assert.equal(await fs.readFile(f.file, 'utf8'), raw); assert.deepEqual(await fs.readdir(f.root), ['collaboration.json']);
});
test('malformed commands, missing projects and read-only project registries cannot create grants', async t => {
  const f = await fixture(t); const before = await fs.readFile(f.file, 'utf8');
  for (const command of [{ action: 'delete-project' }, { action: 'create-team', displayName: ' ' }, { action: 'create-team', displayName: 'x', actorId: f.owner }, { action: 'change-project-member', principalId: f.owner, remove: true, role: 'guest' }]) await assert.rejects(f.store.execute(f.a, command));
  await assert.rejects(f.store.execute(f.a, undefined)); await assert.rejects(f.store.snapshot(randomUUID()), /not found/);
  const blocked = createCollaborationStore(f.file, async () => ({ projects: [{ id: f.a }], readOnly: true })); await assert.rejects(blocked.snapshot(f.a), /needs recovery/);
  assert.equal(await fs.readFile(f.file, 'utf8'), before); validateCollaboration(JSON.parse(before));
});
test('IPC rejects untrusted devices and exposes no actor-switching operation', async t => {
  const f = await fixture(t); let handler, opened = false;
  installCollaboration({ ipcMain: { handle: (_name, value) => handler = value }, trusted: event => { if (!event.local) throw new Error('Untrusted'); }, registryFile: () => { opened = true; return f.file; }, getProjects: f.getProjects });
  for (const action of ['snapshot', 'execute']) await assert.rejects(handler({}, action, f.a, { action: 'create-team', displayName: 'No' }), /Untrusted/);
  assert.equal(opened, false);
  await assert.rejects(handler({ local: true }, 'executeAs', f.a), /Unsupported/);
  const view = await handler({ local: true }, 'snapshot', f.a); assert.equal(view.actor.id, f.owner);
  await assert.rejects(handler({ local: true }, 'execute', f.a, { action: 'create-team', displayName: 'No', actorId: randomUUID() }), /Unsupported/);
});

test('final team and context owners are protected independently of project ownership', async t => {
  const f = await fixture(t);
  const teamId = (await f.store.execute(f.a, { action: 'create-team', displayName: 'Team' })).teams[0].id;
  const contextId = await context(f.store, f.a);
  for (const change of [{ remove: true }, { role: 'member' }]) {
    await assert.rejects(f.store.execute(f.a, { action: 'change-team-member', teamId, principalId: f.owner, ...change }), /final active owner/);
    await assert.rejects(f.store.execute(f.a, { action: 'change-context-member', contextId, principalId: f.owner, ...change }), /final active owner/);
  }
});
test('unrelated person IDs cannot be used to discover or implicitly enroll private roster records', async t => {
  const f = await fixture(t); const id = await person(f.store, f.a, 'Private person'); await f.store.snapshot(f.b);
  assert.equal((await f.store.snapshot(f.b)).directory.some(person => person.id === id), false);
  await assert.rejects(f.store.execute(f.b, { action: 'add-project-member', principalId: id, role: 'guest' }), /visible in this project/);
});
