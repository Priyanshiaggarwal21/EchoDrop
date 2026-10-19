const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
const { createLanServer } = require('./server.cjs');
const { createWorkspaceAuth } = require('../../packages/core/workspace-auth.cjs');

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'echodrop-auth-'));
  let clock = Date.now();
  let server, base, bootstrapToken;
  async function start() {
    ({ server, bootstrapToken } = createLanServer({
      uploadsDirectory: temporary, auth: createWorkspaceAuth({ now: () => clock }),
    }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  const api = {
    get base() { return base; },
    get bootstrapToken() { return bootstrapToken; },
    advance(ms) { clock += ms; },
    request(route, { cookie = '', ...options } = {}) {
      return fetch(base + route, { ...options, headers: { Cookie: cookie, 'X-EchoDrop-Request': '1', ...options.headers } });
    },
    post(route, value, cookie = '') {
      return api.request(route, { method: 'POST', cookie, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    },
    async host() {
      const result = await api.post('/auth/host', { token: bootstrapToken });
      await expect(result, 200);
      return readCookie(result, 'echo_host');
    },
    async invite(host) {
      const response = await api.post('/host/invitations', {}, host);
      return (await expect(response, 201)).token;
    },
    async join(token, deviceName = 'Android browser') {
      const response = await api.post('/auth/join', { invitationToken: token, deviceName });
      const pending = await expect(response, 202);
      return { ...pending, cookie: readCookie(response, 'echo_join') };
    },
    async member() {
      const host = await api.host();
      const pending = await api.join(await api.invite(host));
      await expect(await api.post(`/host/joins/${pending.id}/approve`, {}, host), 200);
      const claim = await api.post('/auth/claim', {}, pending.cookie);
      await expect(claim, 200);
      return { host, pending, cookie: readCookie(claim, 'echo_session') };
    },
    async restart() { await stop(); await start(); },
  };
  t.after(async () => {
    await stop();
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert(path.basename(temporary).startsWith('echodrop-auth-'));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await start();
  return api;
}

function readCookie(response, name) {
  const cookie = response.headers.getSetCookie().find((entry) => entry.startsWith(`${name}=`));
  assert(cookie);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=/);
  return cookie.split(';')[0];
}

async function expect(response, code) {
  const text = await response.text();
  assert.equal(response.status, code, text);
  if (response.headers.get('content-type')?.includes('application/json')) return JSON.parse(text);
  return text;
}

async function transfer(api, cookie) {
  const bytes = Buffer.from('EchoDrop authenticated workspace upload');
  const headers = {
    'X-File-Name': 'photo.jpg', 'X-File-Size': String(bytes.length),
    'X-File-SHA256': createHash('sha256').update(bytes).digest('hex'),
  };
  const created = await expect(await api.request('/transfers', { method: 'POST', cookie, headers }), 201);
  return { created, bytes, headers };
}

test('approved access: browser-bound claim and authenticated upload/download', async (t) => {
  const api = await fixture(t);
  const { cookie, pending, host } = await api.member();
  await expect(await api.post('/auth/claim', {}, pending.cookie), 401); // Claim replay.
  await expect(await api.post('/auth/claim', { id: pending.id }), 400); // ID is not proof.
  const page = await api.request('/', { cookie });
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  await expect(page, 200);
  await expect(await api.request('/sha256.js', { cookie }), 200);
  const { created, bytes } = await transfer(api, cookie);
  await expect(await api.request(`/transfers/${created.id}/chunks/0`, { method: 'PUT', cookie, body: bytes }), 200);
  await expect(await api.post(`/transfers/${created.id}/complete`, {}, cookie), 201);
  const download = await api.request(`/files/${created.id}.bin`, { cookie });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /photo\.jpg/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  await expect(await api.request('/host/state', { cookie }), 403);
  const devices = await expect(await api.request('/host/state', { cookie: host }), 200);
  await expect(await api.post(`/host/sessions/${devices.devices[0].id}/revoke`, {}, host), 200);
  await expect(await api.request('/', { cookie }), 401);
});

test('unapproved access: pending, forged names/IDs, and anonymous requests denied', async (t) => {
  const api = await fixture(t);
  const host = await api.host();
  const pending = await api.join(await api.invite(host), 'Host');
  await expect(await api.request('/'), 401);
  await expect(await api.request('/', { cookie: pending.cookie }), 401);
  await expect(await api.post('/auth/claim', {}, pending.cookie), 403);
  await expect(await api.request('/', { cookie: `echo_session=${pending.id}`, headers: { 'X-Device-Name': 'Host', 'X-Device-ID': pending.id } }), 401);
  await expect(await api.request('/transfers', { method: 'POST', cookie: pending.cookie }), 401);
  await expect(await api.request('/sha256.js'), 401);
  await expect(await api.request('/host/state'), 403);
  await expect(await api.post(`/host/joins/${pending.id}/approve`, {}, pending.cookie), 403);
});

test('rejected joins: cannot claim, reuse invitation, or approve themselves', async (t) => {
  const api = await fixture(t);
  const host = await api.host();
  const token = await api.invite(host);
  const pending = await api.join(token);
  await expect(await api.post(`/host/joins/${pending.id}/reject`, {}, host), 200);
  assert.equal((await expect(await api.request('/auth/join-status', { cookie: pending.cookie }), 200)).state, 'rejected');
  await expect(await api.post('/auth/claim', {}, pending.cookie), 403);
  await expect(await api.post('/auth/join', { invitationToken: token, deviceName: 'Another' }), 401);
  await expect(await api.post(`/host/joins/${pending.id}/approve`, {}, host), 409);
});

test('expired invitations and pending approvals are denied', async (t) => {
  const api = await fixture(t);
  const host = await api.host();
  const token = await api.invite(host);
  api.advance(2 * 60 * 1000);
  await expect(await api.post('/auth/join', { invitationToken: token, deviceName: 'Android' }), 401);
  const pending = await api.join(await api.invite(host));
  api.advance(10 * 60 * 1000);
  await expect(await api.post(`/host/joins/${pending.id}/approve`, {}, host), 404);
  await expect(await api.post('/auth/claim', {}, pending.cookie), 401);
});

test('invitation replay: concurrent redemption permits exactly one pending join', async (t) => {
  const api = await fixture(t);
  const host = await api.host();
  const token = await api.invite(host);
  const responses = await Promise.all([
    api.post('/auth/join', { invitationToken: token, deviceName: 'One' }),
    api.post('/auth/join', { invitationToken: token, deviceName: 'Two' }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [202, 401]);
  await Promise.all(responses.map((response) => response.text()));
  const state = await expect(await api.request('/host/state', { cookie: host }), 200);
  assert.equal(state.requests.length, 1);
});

test('unauthorized download and listing denied for existing files', async (t) => {
  const api = await fixture(t);
  const { cookie } = await api.member();
  const { created, bytes } = await transfer(api, cookie);
  await expect(await api.request(`/transfers/${created.id}/chunks/0`, { method: 'PUT', cookie, body: bytes }), 200);
  await expect(await api.post(`/transfers/${created.id}/complete`, {}, cookie), 201);
  await expect(await api.request(`/files/${created.id}.bin`), 401);
  await expect(await api.request(`/files/${created.id}.bin`, { method: 'HEAD' }), 401);
  const listing = await expect(await api.request('/'), 401);
  assert(!listing.includes(created.id));
});

test('unauthorized upload, chunk, status, resume and finalize access denied', async (t) => {
  const api = await fixture(t);
  const { cookie, pending } = await api.member();
  const { created, headers } = await transfer(api, cookie);
  for (const invalidCookie of ['', pending.cookie, `echo_session=${randomUUID()}.${'0'.repeat(64)}`]) {
    for (const [route, method] of [
      ['/transfers', 'POST'], ['/upload', 'POST'],
      [`/transfers/${created.id}/chunks/0`, 'PUT'], [`/transfers/${created.id}`, 'GET'],
      [`/transfers/${created.id}/resume`, 'POST'], [`/transfers/${created.id}/complete`, 'POST'],
    ]) {
      await expect(await api.request(route, { method, cookie: invalidCookie, headers }), 401);
    }
  }
  const status = await expect(await api.request(`/transfers/${created.id}`, { cookie }), 200);
  assert.equal(status.retainedBytes, 0);
});

test('session expiry denies access even with an otherwise valid cookie', async (t) => {
  const api = await fixture(t);
  const { cookie } = await api.member();
  await expect(await api.request('/', { cookie }), 200);
  api.advance(8 * 60 * 60 * 1000);
  await expect(await api.request('/', { cookie }), 401);
  await expect(await api.request('/transfers', { method: 'POST', cookie }), 401);
});

test('restart invalidates sessions, invitations, pending requests and host codes', async (t) => {
  const api = await fixture(t);
  const { cookie, host } = await api.member();
  const token = await api.invite(host);
  const pending = await api.join(await api.invite(host));
  const oldHostCode = api.bootstrapToken;
  await api.restart();
  await expect(await api.request('/', { cookie }), 401);
  await expect(await api.request('/host/state', { cookie: host }), 403);
  await expect(await api.post('/auth/join', { invitationToken: token, deviceName: 'Android' }), 401);
  await expect(await api.request('/auth/join-status', { cookie: pending.cookie }), 401);
  await expect(await api.post('/auth/host', { token: oldHostCode }), 401);
});

test('cross-origin requests, Host spoofing and malformed input denied', async (t) => {
  const api = await fixture(t);
  const { cookie, host } = await api.member();
  // Fetch normalizes Host; use an actual raw HTTP Host override for this assertion.
  const spoofedStatus = await new Promise((resolve, reject) => {
    const request = http.get(api.base + '/', { headers: { Host: 'attacker.example', Cookie: cookie } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
  assert.equal(spoofedStatus, 400);
  await expect(await api.request('/', { cookie, headers: { Origin: 'http://attacker.example' } }), 403);
  await expect(await api.request('/host/invitations', {
    method: 'POST', cookie: host, headers: { 'Content-Type': 'application/json', 'X-EchoDrop-Request': '' }, body: '{}',
  }), 403);
  await expect(await api.post('/auth/join', { invitationToken: 'bad', deviceName: 'name', deviceId: 'host' }), 400);
  await expect(await api.request('/', { cookie: `${cookie}; ${cookie}` }), 401);
  const invite = await api.invite(host);
  const tampered = invite.slice(0, -1) + (invite.endsWith('0') ? '1' : '0');
  await expect(await api.post('/auth/join', { invitationToken: tampered, deviceName: 'Android' }), 401);
});
