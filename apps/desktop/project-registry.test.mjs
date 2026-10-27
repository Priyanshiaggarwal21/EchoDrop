import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createProjectRegistry } from './project-registry.mjs';
import { PROJECT_TYPES, validateProjectInput, validateProject, validateProjectPatch } from '../../packages/core/projects.mjs';
const { installProjectRegistry } = createRequire(import.meta.url)('./registry-ipc.cjs');
const input = { name: ' First project ', description: 'A local idea', type: 'Personal Project', origin: 'new' };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echodrop-registry-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('echodrop-registry-')); await fs.rm(root, { recursive: true, force: true }); });
  return { root, file: path.join(root, 'projects', 'registry.json') };
}
test('all seven project types validate independently of lifecycle status', () => {
  assert.deepEqual(PROJECT_TYPES, ['Personal Project', 'College Project', 'Team Project', 'Future Idea', 'Startup / Client', 'Hackathon', 'Custom Space']);
  for (const type of PROJECT_TYPES) assert.equal(validateProjectInput({ ...input, type }).type, type);
  assert.equal(validateProjectInput(input).name, 'First project');
});
test('validation rejects empty/oversized names, unknown types and injected filesystem fields', () => {
  for (const change of [{ name: ' ' }, { name: 'a'.repeat(121) }, { description: 'a'.repeat(2001) }, { type: 'Active' }, { origin: 'clone' }, { localRoot: 'C:\\private' }, { name: 'bad\0name' }]) assert.throws(() => validateProjectInput({ ...input, ...change }));
  for (const patch of [{ localRoot: 'C:\\private' }, { id: 'replace' }, { status: 'Hackathon' }, { pinned: 'yes' }, {}]) assert.throws(() => validateProjectPatch(patch));
});
test('create/update survive a new registry instance with stable IDs and unknown metadata preserved', async t => {
  const { file } = await fixture(t); const store = createProjectRegistry(file);
  const project = await store.create(input);
  assert.equal(project.status, 'Planned'); assert.equal(project.version, 1);
  await store.update(project.id, { status: 'Active', pinned: true });
  const raw = JSON.parse(await fs.readFile(file, 'utf8')); raw.projects[0].metadata.future = { nested: ['value'] }; raw.extension = 'preserve';
  await fs.writeFile(file, JSON.stringify(raw));
  const restarted = createProjectRegistry(file);
  await restarted.update(project.id, { description: 'Updated' });
  const restored = (await restarted.list()).projects[0];
  assert.equal(restored.id, project.id); assert.equal(restored.pinned, true); assert.equal(restored.status, 'Active'); assert.equal(restored.description, 'Updated');
  assert.deepEqual(restored.metadata.future, { nested: ['value'] }); assert.equal(JSON.parse(await fs.readFile(file)).extension, 'preserve');
});
test('serialized concurrent creation and updates do not lose projects', async t => {
  const { file } = await fixture(t); const store = createProjectRegistry(file);
  const projects = await Promise.all(Array.from({ length: 12 }, (_, i) => store.create({ ...input, name: `Project ${i}` })));
  await Promise.all(projects.map(project => store.update(project.id, { pinned: true })));
  const restored = await createProjectRegistry(file).list(); assert.equal(restored.projects.length, 12); assert(restored.projects.every(project => project.pinned)); assert.equal(new Set(projects.map(project => project.id)).size, 12);
});
test('import requires a real directory and does not modify its files', async t => {
  const { root, file } = await fixture(t); const source = path.join(root, 'source'); await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'package.json'), '{"scripts":{"postinstall":"DO_NOT_RUN"}}');
  const store = createProjectRegistry(file);
  await assert.rejects(store.create({ ...input, origin: 'import' }), /folder/);
  await assert.rejects(store.create(input, path.join(source, 'package.json')), /folder/);
  const project = await store.create({ ...input, origin: 'import' }, source); assert.equal(project.localRoot, source);
  assert.equal(await fs.readFile(path.join(source, 'package.json'), 'utf8'), '{"scripts":{"postinstall":"DO_NOT_RUN"}}');
  assert.deepEqual(await fs.readdir(source), ['package.json']);
});
test('invalid JSON is preserved byte-for-byte and blocks writes', async t => {
  const { file } = await fixture(t); await fs.mkdir(path.dirname(file)); await fs.writeFile(file, '{interrupted');
  const store = createProjectRegistry(file); assert.equal((await store.list()).readOnly, true);
  await assert.rejects(store.create(input), /preserved/); assert.equal(await fs.readFile(file, 'utf8'), '{interrupted');
});
test('partial corruption and duplicate IDs retain readable records without destructive repair', async t => {
  const { file } = await fixture(t); const store = createProjectRegistry(file); const project = await store.create(input);
  const raw = JSON.stringify({ version: 1, projects: [project, { broken: true }, project] }); await fs.writeFile(file, raw);
  const state = await store.list(); assert.equal(state.projects.length, 1); assert.equal(state.readOnly, true); assert.match(state.warning, /2 invalid/);
  await assert.rejects(store.update(project.id, { pinned: true }), /read-only/); assert.equal(await fs.readFile(file, 'utf8'), raw);
});
test('future registry and record versions are never downgraded or overwritten', async t => {
  const { file } = await fixture(t); const store = createProjectRegistry(file); const project = await store.create(input);
  assert.throws(() => validateProject({ ...project, version: 2 }));
  const raw = JSON.stringify({ version: 2, projects: [project] }); await fs.writeFile(file, raw);
  assert.equal((await store.list()).readOnly, true); await assert.rejects(store.create(input), /unsupported/); assert.equal(await fs.readFile(file, 'utf8'), raw);
});
test('failed atomic replacement preserves the prior registry and clears temporary files', async t => {
  const { file } = await fixture(t); const store = createProjectRegistry(file); await store.create(input); const original = await fs.readFile(file, 'utf8');
  const failing = createProjectRegistry(file, { ...fs, rename: async () => { throw new Error('Simulated write failure'); } });
  await assert.rejects(failing.create(input), /Simulated/); assert.equal(await fs.readFile(file, 'utf8'), original); assert.deepEqual(await fs.readdir(path.dirname(file)), ['registry.json']);
});
test('validation failure does not poison later serialized writes', async t => {
  const { file } = await fixture(t); const store = createProjectRegistry(file);
  await assert.rejects(store.create({ ...input, name: '' })); await store.create(input); assert.equal((await store.list()).projects.length, 1);
});
test('native registry IPC rejects remote callers before any dialog or disk access', async () => {
  let handler; let accessed = false;
  installProjectRegistry({ ipcMain: { handle: (_channel, callback) => handler = callback }, trusted: () => { throw new Error('Untrusted'); }, parent: () => null, registryFile: () => { accessed = true; return ''; }, ui: { dialog: { showOpenDialog: () => { accessed = true; } }, shell: {} } });
  for (const action of ['list', 'select-folder', 'create', 'update', 'open-folder']) await assert.rejects(handler({}, action, {}), /Untrusted/);
  assert.equal(accessed, false);
});
test('native folder tokens bind imports to picker selections and opening requires a registered ID', async t => {
  const { root, file } = await fixture(t); let handler, opened;
  installProjectRegistry({ ipcMain: { handle: (_channel, callback) => handler = callback }, trusted: () => {}, parent: () => null, registryFile: () => file, ui: { dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) }, shell: { openPath: async directory => { opened = directory; return ''; } } } });
  await assert.rejects(handler({}, 'create', { input, folderToken: root }), /Select the folder again/);
  const selected = await handler({}, 'select-folder'); assert.equal(selected.label, path.basename(root)); assert.notEqual(selected.token, root);
  const project = await handler({}, 'create', { input: { ...input, origin: 'import' }, folderToken: selected.token });
  await assert.rejects(handler({}, 'create', { input, folderToken: selected.token }), /Select the folder again/);
  await assert.rejects(handler({}, 'open-folder', root), /no associated folder/);
  await handler({}, 'open-folder', project.id); assert.equal(opened, await fs.realpath(root));
  await assert.rejects(handler({}, 'delete', project.id), /Unsupported/);
});
