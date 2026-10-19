const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { createLanServer } = require('./server.cjs');
const { createLivePreview } = require('../../packages/core/live-preview.cjs');
const { createWorkspaceAuth } = require('../../packages/core/workspace-auth.cjs');

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'echodrop-preview-'));
  const root = path.join(temp, 'project'); await fs.mkdir(root);
  await fs.mkdir(path.join(root, 'assets'));
  await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><link rel="stylesheet" href="assets/site.css"><script src="assets/site.js"></script><p>Preview</p>');
  await fs.writeFile(path.join(root, 'assets/site.css'), 'body { color: green; }');
  await fs.writeFile(path.join(root, 'assets/site.js'), 'document.title = "Preview loaded";');
  let time = Date.now();
  const auth = createWorkspaceAuth({ now: () => time });
  const preview = createLivePreview({ now: () => time });
  const { server } = createLanServer({ auth, preview, uploadsDirectory: path.join(temp, 'uploads') });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const host = auth.hostLogin(auth.bootstrapToken).credential;
  const join = auth.join(auth.invite(host).token, 'Test browser');
  auth.decide(host, join.record.id, 'approve');
  const member = auth.claim(join.credential);
  const hostCookie = `echo_host=${host}`, memberCookie = `echo_session=${member.credential}`;
  async function post(route, value = {}, cookie = memberCookie) {
    return fetch(base + route, { method: 'POST', headers: { Cookie: cookie, 'X-EchoDrop-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  }
  t.after(async () => {
    await preview.stop(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    assert.equal(path.dirname(temp), os.tmpdir()); assert(path.basename(temp).startsWith('echodrop-preview-'));
    await fs.rm(temp, { recursive: true, force: true });
  });
  async function start() { const result = await post('/host/preview/start', { directory: root }, hostCookie); assert.equal(result.status, 200, await result.text()); }
  async function grant() { const result = await post('/preview/grant'); assert.equal(result.status, 200); return (await result.json()).url; }
  return { temp, root, auth, preview, base, host, hostCookie, member, memberCookie, post, start, grant, advance: (ms) => { time += ms; } };
}
function raw(url, route) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    http.get({ hostname: target.hostname, port: target.port, path: route }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

test('LivePreview loads HTML/CSS/JS, relative assets and refresh with restrictive headers', async (t) => {
  const f = await fixture(t); await f.start(); const url = await f.grant();
  assert.notEqual(new URL(url).port, new URL(f.base).port);
  for (const file of ['', 'assets/site.css', 'assets/site.js', '?refresh=1']) {
    const res = await fetch(url + file); assert.equal(res.status, 200, await res.text());
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-security-policy'), /sandbox allow-scripts;/);
    assert.match(res.headers.get('content-security-policy'), /connect-src 'none'/);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.headers.get('set-cookie'), null);
  }
  await fs.writeFile(path.join(f.root, 'assets/site.css'), 'body { color: blue; }');
  assert.equal(await (await fetch(url + 'assets/site.css')).text(), 'body { color: blue; }');
  const module = await fetch(url + 'assets/site.js', { headers: { Origin: 'null' } });
  assert.equal(module.headers.get('access-control-allow-origin'), 'null');
  assert.equal(module.headers.get('access-control-allow-credentials'), null);
});

test('LivePreview denies unapproved grants, client host controls and unauthorized preview requests', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post('/preview/grant', {}, '')).status, 401);
  assert.equal((await f.post('/host/preview/start', { directory: f.root })).status, 403);
  assert.equal((await f.post('/host/preview/stop')).status, 403);
  await f.start(); const url = await f.grant();
  assert.equal((await fetch(new URL(url).origin)).status, 401);
  assert.equal((await fetch(url.replace(/\/p\/[^/]+/, '/p/' + '0'.repeat(64)))).status, 401);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  assert.equal((await f.post('/preview/grant', {}, f.memberCookie)).status, 200);
  // Preview sandbox requests carry an opaque Origin, never a trusted workspace Origin.
  assert.equal((await fetch(f.base + '/preview/grant', { method: 'POST', headers: { Cookie: f.memberCookie, Origin: 'null', 'X-EchoDrop-Request': '1' } })).status, 403);
});

test('LivePreview expires grants and immediately invalidates revoked workspace access', async (t) => {
  const f = await fixture(t); await f.start(); const old = await f.grant();
  f.advance(300001); assert.equal((await fetch(old)).status, 401);
  const url = await f.grant(); f.auth.revoke(f.host, f.member.record.id);
  assert.equal((await fetch(url)).status, 401);
});

test('LivePreview rejects traversal, private files, symlink/junction escapes and listings', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, '.secret.html'), 'secret');
  await fs.writeFile(path.join(f.root, 'config.js'), 'secret');
  await fs.writeFile(path.join(f.root, 'keys.pem'), 'secret');
  await fs.mkdir(path.join(f.temp, 'outside')); await fs.writeFile(path.join(f.temp, 'outside/index.html'), 'outside');
  await fs.symlink(path.join(f.temp, 'outside'), path.join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await f.start(); const url = await f.grant(), prefix = new URL(url).pathname;
  for (const suffix of ['../outside/index.html', '%2e%2e/outside/index.html', '%252e%252e/index.html', 'assets%5c..%5cindex.html', '.secret.html', 'config.js', 'keys.pem', 'escape/index.html', 'index.html:secret', 'assets/']) {
    assert([403, 404].includes(await raw(url, prefix + suffix)), suffix);
  }
  if (process.platform === 'win32') {
    await fs.writeFile(path.join(f.root, 'hidden.html'), 'hidden');
    await promisify(execFile)('attrib.exe', ['+H', path.join(f.root, 'hidden.html')], { windowsHide: true });
    assert.equal((await fetch(url + 'hidden.html')).status, 403);
  }
});

test('LivePreview host start/stop closes the port and invalidates previous grants', async (t) => {
  const f = await fixture(t); assert.equal((await f.post('/preview/grant')).status, 409);
  await f.start(); const old = await f.grant();
  assert.equal((await f.post('/host/preview/stop', {}, f.hostCookie)).status, 200);
  await assert.rejects(fetch(old));
  await f.start(); const next = await f.grant();
  assert.equal((await fetch(new URL(next).origin + new URL(old).pathname)).status, 401);
  assert.equal((await fetch(next)).status, 200);
});
