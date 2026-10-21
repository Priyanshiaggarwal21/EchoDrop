import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { importFolder, readPackage, receiveProject } from '../../packages/transfer/project-node.mjs';
import { packageProject, parseProject, compatibility, importBrowserProject, FILE_LIMIT } from '../../packages/transfer/project.mjs';
import { scanProject, withSharingCheck } from '../../packages/transfer/secret-scan.mjs';
const { createLanServer } = createRequire(import.meta.url)('./server.cjs');
const entry = (name, text) => ({ path: name, data: Buffer.from(text).toString('base64') });
const bundle = files => ({ format: 'echodrop-project', version: 1, name: 'demo', files });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echodrop-project-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('echodrop-project-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
async function write(root, name, text) { const target = path.join(root, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, text); }

test('project journey: import, inspect, consent, authenticated resumable share, receive and inspect folder', async t => {
  const root = await fixture(t), source = path.join(root, 'source'), destination = path.join(root, 'received');
  await fs.mkdir(destination);
  const manifest = JSON.stringify({ engines: { node: '>=20' }, packageManager: 'npm@10.0.0', scripts: { dev: 'DO_NOT_EXECUTE', postinstall: 'DO_NOT_EXECUTE' }, dependencies: { react: '*' }, devDependencies: { typescript: '*' } });
  await write(source, 'package.json', manifest);
  await write(source, 'package-lock.json', '{}');
  await write(source, 'src/index.ts', 'export const answer = 42;\n' + ' '.repeat(1100000));
  await write(source, '.env', 'EXAMPLE=value');
  await write(source, 'node_modules/ignored.js', 'ignored');
  await write(source, '.git/config', 'ignored');
  await write(source, 'dist/index.js', 'ignored');
  const before = await fs.stat(path.join(source, 'package.json'));
  const imported = await importFolder(source);
  assert.deepEqual(imported.project.files.map(f => f.path).sort(), ['.env', 'package-lock.json', 'package.json', 'src/index.ts']);
  assert(imported.excluded.includes('node_modules'));
  assert.equal(await fs.readFile(path.join(source, 'package.json'), 'utf8'), manifest);
  assert.equal((await fs.stat(path.join(source, 'package.json'))).mtimeMs, before.mtimeMs);
  const report = compatibility(imported.project);
  assert(report.facts.some(f => f.includes('React')));
  assert(report.facts.some(f => f.includes('TypeScript')));
  assert(report.facts.some(f => f.includes('>=20')));
  assert(report.unknowns.some(f => f.includes('not verified')));
  const findings = await scanProject(imported.project);
  assert(findings.some(f => f.path === '.env'));
  let transfers = 0;
  const file = new File([packageProject(imported.project)], 'source.echoproject');
  await withSharingCheck(file, async () => false, async () => { transfers++; });
  assert.equal(transfers, 0);

  const service = createLanServer({ uploadsDirectory: path.join(root, 'uploads') });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  t.after(async () => { service.server.closeAllConnections(); await new Promise(resolve => service.server.close(resolve)); });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const request = (route, cookie = '', options = {}) => fetch(base + route, { ...options, headers: { Cookie: cookie, 'X-EchoDrop-Request': '1', ...options.headers } });
  const json = async (response, code) => { assert.equal(response.status, code, await response.clone().text()); return response.json(); };
  const post = (route, value, cookie = '') => request(route, cookie, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const login = await post('/auth/host', { token: service.bootstrapToken }); await json(login, 200);
  const host = login.headers.getSetCookie()[0].split(';')[0];
  const invitation = await json(await post('/host/invitations', {}, host), 201);
  const join = await post('/auth/join', { invitationToken: invitation.token, deviceName: 'Project test client' });
  const pending = await json(join, 202);
  await json(await post(`/host/joins/${pending.id}/approve`, {}, host), 200);
  const claimed = await post('/auth/claim', {}, join.headers.getSetCookie()[0].split(';')[0]); await json(claimed, 200);
  const member = claimed.headers.getSetCookie()[0].split(';')[0];
  let id;
  await withSharingCheck(file, async result => { assert(result.categories.some(c => c.includes('.env'))); return true; }, async () => {
    transfers++;
    const bytes = Buffer.from(await file.arrayBuffer());
    const headers = { 'X-File-Name': file.name, 'X-File-Size': String(bytes.length), 'X-File-SHA256': createHash('sha256').update(bytes).digest('hex'), 'X-Transfer-ID': randomUUID() };
    assert.equal((await request('/transfers', '', { method: 'POST', headers })).status, 401);
    let state = await json(await request('/transfers', member, { method: 'POST', headers }), 201); id = state.id;
    const first = bytes.subarray(0, state.chunkSize);
    state = await json(await request(`/transfers/${id}/chunks/0`, member, { method: 'PUT', body: first }), 200);
    // Retry a lost acknowledgement, then resume through the real persisted protocol.
    state = await json(await request(`/transfers/${id}/chunks/0`, member, { method: 'PUT', body: first }), 200);
    assert.equal(state.retainedBytes, first.length);
    state = await json(await request(`/transfers/${id}/resume`, member, { method: 'POST', headers }), 200);
    while (state.nextIndex * state.chunkSize < bytes.length) state = await json(await request(`/transfers/${id}/chunks/${state.nextIndex}`, member, { method: 'PUT', body: bytes.subarray(state.nextIndex * state.chunkSize, (state.nextIndex + 1) * state.chunkSize) }), 200);
    const complete = await json(await post(`/transfers/${id}/complete`, {}, member), 201);
    assert.equal(complete.state, 'completed');
    assert.equal((await request(complete.download)).status, 401);
    const download = await request(complete.download, host);
    const receivedBytes = Buffer.from(await download.arrayBuffer());
    assert.deepEqual(receivedBytes, bytes);
    const project = parseProject(receivedBytes.toString('utf8'));
    const received = await receiveProject(project, destination);
    assert.equal(await fs.readFile(path.join(received.directory, 'src/index.ts'), 'utf8'), await fs.readFile(path.join(source, 'src/index.ts'), 'utf8'));
    assert.equal(await fs.readFile(path.join(received.directory, 'package.json'), 'utf8'), manifest);
    const second = await receiveProject(project, destination);
    assert.notEqual(second.directory, received.directory);
    assert.deepEqual((await fs.readdir(path.join(root, 'uploads'))).filter(n => n.endsWith('.bin')), [id + '.bin']);
  });
  assert.equal(transfers, 1);
});

test('removing flagged files removes their bytes and scanner findings from deterministic package', async () => {
  const project = bundle([entry('.env', 'SECRET_DO_NOT_COPY'), entry('src/app.ts', 'export {}')]);
  project.files = project.files.filter(f => f.path !== '.env');
  const serialized = packageProject(project);
  assert.equal(serialized, packageProject({ ...project, files: [...project.files].reverse() }));
  assert(!serialized.includes(Buffer.from('SECRET_DO_NOT_COPY').toString('base64')));
  assert.deepEqual(await scanProject(parseProject(serialized)), []);
});

test('unsafe paths, collisions, malformed encoding and generated directories are rejected before extraction', async t => {
  const root = await fixture(t);
  for (const name of ['../escape', '/absolute', 'C:/escape', 'a\\b', 'file:stream', 'CON.txt', 'dir/../escape', 'a./file', 'node_modules/x', '.git/config']) {
    await assert.rejects(receiveProject(bundle([entry(name, 'x')]), root));
  }
  for (const files of [[entry('App.ts', 'a'), entry('app.ts', 'b')], [entry('src', 'x'), entry('src/a.ts', 'y')], [entry('src/a.ts', 'y'), entry('src', 'x')], [{ path: 'a', data: 'not-base64!' }]]) await assert.rejects(receiveProject(bundle(files), root));
  assert.deepEqual(await fs.readdir(root), []);
  assert.throws(() => parseProject('{broken json'));
  assert.throws(() => packageProject(bundle([entry('large', Buffer.alloc(FILE_LIMIT + 1))])));
});

test('desktop import skips junctions and hard links without reading outside source', async t => {
  const root = await fixture(t), source = path.join(root, 'source'), outside = path.join(root, 'outside');
  await write(source, 'package.json', '{}'); await write(outside, 'secret.txt', 'outside');
  await fs.symlink(outside, path.join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.link(path.join(outside, 'secret.txt'), path.join(source, 'hardlink'));
  const result = await importFolder(source);
  assert.deepEqual(result.project.files.map(f => f.path), ['package.json']);
  assert(result.excluded.includes('linked')); assert(result.excluded.includes('hardlink'));
});

test('compatibility distinguishes declarations from unknowns, conflicting lockfiles and missing manifests', () => {
  const report = compatibility(bundle([entry('package.json', JSON.stringify({ scripts: { dev: 'echo secret-value' } })), entry('yarn.lock', ''), entry('pnpm-lock.yaml', '')]));
  assert(report.unknowns.some(s => s.includes('Multiple package managers')));
  assert(!JSON.stringify(report).includes('secret-value'));
  assert(compatibility(bundle([entry('readme.md', 'hi')])).unknowns.some(s => s.includes('No root package.json')));
  assert(compatibility(bundle([entry('package.json', 'invalid')])).unknowns.some(s => s.includes('could not be inspected')));
});

test('browser folder import preserves paths and excludes generated files; downloaded package can be reopened', async t => {
  const root = await fixture(t);
  const files = [['demo/package.json', '{}'], ['demo/src/app.ts', 'export {}'], ['demo/build/ignored', 'skip']].map(([name, contents]) => { const file = new File([contents], path.basename(name)); Object.defineProperty(file, 'webkitRelativePath', { value: name }); return file; });
  const imported = await importBrowserProject(files);
  assert.deepEqual(imported.project.files.map(f => f.path), ['package.json', 'src/app.ts']);
  assert.deepEqual(imported.excluded, ['build/ignored']);
  const target = path.join(root, 'demo.echoproject');
  await fs.writeFile(target, packageProject(imported.project));
  assert.deepEqual(await readPackage(target), parseProject(packageProject(imported.project)));
});

test('desktop picker, receive and open IPC only use authorized selections and received folders', async t => {
  const root = await fixture(t), source = path.join(root, 'source');
  await write(source, 'package.json', '{}');
  const imported = await importFolder(source);
  const packageFile = path.join(root, 'demo.echoproject');
  await fs.writeFile(packageFile, packageProject(imported.project));
  const { installProjects } = createRequire(import.meta.url)('../../apps/desktop/project.cjs');
  let handler, authorization = true;
  const choices = [source, packageFile, root];
  const opened = [];
  installProjects({
    ipcMain: { handle(name, callback) { assert.equal(name, 'workspace:project'); handler = callback; } },
    trusted(event) { if (!event.trusted) throw new Error('Untrusted client'); },
    parent: () => null,
    authorize: async () => { if (!authorization) throw new Error('Expired host session'); },
    download: async () => { assert.fail('No download expected'); },
    ui: { dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [choices.shift()] }) }, shell: { openPath: async directory => { opened.push(directory); return ''; } } },
  });
  await assert.rejects(handler({}, 'select'), /Untrusted/);
  authorization = false;
  await assert.rejects(handler({ trusted: true }, 'select'), /Expired/);
  authorization = true;
  await assert.rejects(handler({ trusted: true }, 'receive', '../outside'), /Invalid shared/);
  await assert.rejects(handler({ trusted: true }, 'open', source), /Receive this/);
  assert.deepEqual((await handler({ trusted: true }, 'select')).project, imported.project);
  const received = await handler({ trusted: true }, 'receive');
  assert.equal(opened.length, 0);
  await handler({ trusted: true }, 'open', received.id);
  assert.deepEqual(opened, [received.directory]);
  assert.equal(await fs.readFile(path.join(received.directory, 'package.json'), 'utf8'), '{}');
});

test('runtime declarations and package-manager disagreements remain explicit', () => {
  const report = compatibility(bundle([entry('package.json', '{"packageManager":"npm@10.0.0"}'), entry('pnpm-lock.yaml', ''), entry('.nvmrc', 'v20.10.0'), entry('.env.example', '')]));
  assert(report.facts.some(s => s.includes('v20.10.0')));
  assert(report.facts.some(s => s.includes('Environment configuration')));
  assert(report.unknowns.some(s => s.includes('disagree')));
});

test('browser excludes a large generated tree before reading contents or applying source file limits', async () => {
  const source = new File(['{}'], 'package.json');
  Object.defineProperty(source, 'webkitRelativePath', { value: 'demo/package.json' });
  const ignored = Array.from({ length: 5100 }, (_, i) => ({ webkitRelativePath: `demo/node_modules/p/${i}.js`, arrayBuffer() { assert.fail('Generated content must not be read'); } }));
  const result = await importBrowserProject([source, ...ignored]);
  assert.equal(result.project.files.length, 1);
  assert.equal(result.excluded.length, 100);
});
