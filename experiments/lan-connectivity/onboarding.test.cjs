const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const http = require('node:http');
const { once } = require('node:events');
const { randomUUID, randomBytes } = require('node:crypto');
const qrcode = require('qrcode-generator');
const jsQR = require('jsqr');
const bootstrap = require('../../packages/core/invitation-bootstrap.js');
const { createWorkspaceAuth } = require('../../packages/core/workspace-auth.cjs');
const { createLanServer } = require('./server.cjs');

const lanOrigin = 'http://192.168.1.20:3000';
const token = () => `${randomUUID()}.${randomBytes(32).toString('hex')}`;
async function fixture(t) {
  let clock = Date.now();
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'echodrop-onboard-'));
  const { server, bootstrapToken } = createLanServer({ uploadsDirectory: temp, auth: createWorkspaceAuth({ now: () => clock }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert(path.basename(temp).startsWith('echodrop-onboard-'));
    await fsp.rm(temp, { recursive: true, force: true });
  });
  const request = (url, { cookie = '', ...options } = {}) => fetch(base + url, {
    ...options, headers: { Cookie: cookie, 'X-EchoDrop-Request': '1', ...options.headers },
  });
  const post = (url, value, cookie = '') => request(url, {
    method: 'POST', cookie, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  const login = await post('/auth/host', { token: bootstrapToken });
  assert.equal(login.status, 200); await login.text();
  const hostCookie = login.headers.getSetCookie()[0].split(';')[0];
  return {
    request, post, hostCookie, base,
    advance(ms) { clock += ms; },
    async invite() {
      const result = await post('/host/invitations', {}, hostCookie);
      assert.equal(result.status, 201); return result.json();
    },
  };
}

function decodeQR(payload) {
  const qr = qrcode(0, 'M'); qr.addData(payload, 'Byte'); qr.make();
  const count = qr.getModuleCount(), scale = 5, margin = 4, size = (count + 2 * margin) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < count; y++) for (let x = 0; x < count; x++) if (qr.isDark(y, x)) {
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const at = (((y + margin) * scale + dy) * size + (x + margin) * scale + dx) * 4;
      data[at] = data[at + 1] = data[at + 2] = 0;
    }
  }
  const result = jsQR(data, size, size);
  assert(result, 'Bundled jsQR must decode the generated QR');
  return result.data;
}

async function approve(api, pendingResponse) {
  assert.equal(pendingResponse.status, 202, await pendingResponse.clone().text());
  const pending = await pendingResponse.json();
  const pendingCookie = pendingResponse.headers.getSetCookie()[0].split(';')[0];
  const early = await api.post('/auth/claim', {}, pendingCookie);
  assert.equal(early.status, 403); await early.text();
  const approved = await api.post(`/host/joins/${pending.id}/approve`, {}, api.hostCookie);
  assert.equal(approved.status, 200); await approved.text();
  const claimed = await api.post('/auth/claim', {}, pendingCookie);
  assert.equal(claimed.status, 200); await claimed.text();
  const cookie = claimed.headers.getSetCookie().find((entry) => entry.startsWith('echo_session=')).split(';')[0];
  const page = await api.request('/', { cookie });
  assert.equal(page.status, 200); await page.text();
}

test('manual joining and host approval use the existing validation flow', async (t) => {
  const api = await fixture(t);
  const invitation = await api.invite();
  bootstrap.token(invitation.token);
  await approve(api, await api.post('/auth/join', { invitationToken: invitation.token, deviceName: 'Manual Windows' }));
});

test('actual QR generation/decoding, payload validation, and approval integration', async (t) => {
  const api = await fixture(t);
  const invitation = await api.invite();
  const payload = bootstrap.create(lanOrigin, invitation.token);
  const decoded = decodeQR(payload);
  assert.equal(decoded, payload);
  assert.deepEqual(bootstrap.parse(decoded), { host: lanOrigin, token: invitation.token });
  await approve(api, await api.post('/auth/join', { invitationToken: bootstrap.parse(decoded).token, deviceName: 'QR Android' }));
  for (const invalid of [
    payload + '&session=secret', payload.replace('/join#', '/files#'), payload.replace('/join#', '/join?token='),
    payload.replace('192.168.1.20', 'example.com'), payload.replace('192.168.1.20', '127.0.0.1'),
    payload.replace('http:', 'https:'), payload.replace('http:', 'javascript:'),
    payload.replace('http://', 'http://user:password@'), payload.replace('192.168.1.20', '3232235796'),
    JSON.stringify({ host: lanOrigin, token: invitation.token, file: 'private data' }),
  ]) assert.throws(() => bootstrap.parse(invalid));
});

test('expired and replayed QR/manual invitations cannot bypass validation', async (t) => {
  const api = await fixture(t);
  const expired = await api.invite();
  const payload = decodeQR(bootstrap.create(lanOrigin, expired.token));
  api.advance(120000);
  const expiredResult = await api.post('/auth/join', { invitationToken: bootstrap.parse(payload).token, deviceName: 'Expired QR' });
  assert.equal(expiredResult.status, 401); await expiredResult.text();
  const fresh = await api.invite();
  const first = await api.post('/auth/join', { invitationToken: fresh.token, deviceName: 'Manual first' });
  assert.equal(first.status, 202); await first.text();
  const replay = bootstrap.parse(decodeQR(bootstrap.create(lanOrigin, fresh.token)));
  const second = await api.post('/auth/join', { invitationToken: replay.token, deviceName: 'QR replay' });
  assert.equal(second.status, 401); await second.text();
});

test('join-page fragment handling, cross-host confirmation and HTTP media fallbacks', async (t) => {
  const api = await fixture(t);
  const invitation = await api.invite();
  const response = await api.request('/join');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert(!response.headers.get('content-security-policy').includes('unsafe-eval'));
  const other = bootstrap.create('http://10.0.0.4:3000', invitation.token);
  assert.match(html, /id="token"/);
  assert.match(html, /id="camera"/);
  assert.match(html, /id="microphone"/);
  assert.match(html, /onboarding\/browser\.js/);
  assert.equal(bootstrap.parse(other).host, 'http://10.0.0.4:3000');
  assert.equal(bootstrap.parse(other).token, invitation.token);
  const joined = await api.post('/auth/join', { invitationToken: invitation.token, deviceName: 'Fallback browser' });
  assert.equal(joined.status, 202);
  await joined.text();
  const navigationStatus = await new Promise((resolve, reject) => {
    const request = http.get(api.base + '/join', { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } }, (response) => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
  assert.equal(navigationStatus, 200);
});

test('local assets and acoustic worker CSP do not weaken workspace page policy', async (t) => {
  const api = await fixture(t);
  for (const route of ['/onboarding/bootstrap.js', '/onboarding/qr-generator.js', '/onboarding/qr-reader.js', '/onboarding/ggwave.js', '/onboarding/browser.js', '/onboarding/licenses.txt']) {
    const response = await api.request(route); assert.equal(response.status, 200); await response.text();
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  }
  const worker = await api.request('/onboarding/acoustic-worker.js');
  assert.match(worker.headers.get('content-security-policy'), /connect-src 'none'/); await worker.text();
  const host = await api.request('/host');
  assert(!host.headers.get('content-security-policy').includes('unsafe-eval'));
  const hostHTML = await host.text();
  new vm.Script(hostHTML.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1]);
  assert(hostHTML.includes('manual') || hostHTML.includes('invitation token'));
  const denied = await api.request('/onboarding/../../package.json');
  assert.equal(denied.status, 401); await denied.text();
});

test('real bundled ggwave worker encodes and decodes a full invitation (digital PCM only)', { timeout: 20000 }, async (t) => {
  const api = await fixture(t);
  const scripts = {};
  for (const route of ['/onboarding/bootstrap.js', '/onboarding/ggwave.js', '/onboarding/acoustic-worker.js']) {
    const result = await api.request(route);
    assert.equal(result.status, 200);
    scripts[route] = await result.text();
  }
  const output = [];
  const context = vm.createContext({
    URL, TextEncoder, TextDecoder, ArrayBuffer, Uint8Array, Int8Array, Float32Array, atob,
    setTimeout, clearTimeout, console: { log() {}, error() {} },
    location: { href: 'http://localhost/onboarding/acoustic-worker.js' },
    postMessage(value) { output.push(value); },
  });
  context.self = context;
  context.importScripts = (...urls) => {
    for (const url of urls) { assert(scripts[url]); vm.runInContext(scripts[url], context); }
  };
  vm.runInContext(scripts['/onboarding/acoustic-worker.js'], context);
  let sequence = 0;
  async function call(type, values = {}) {
    await context.onmessage({ data: { id: ++sequence, type, ...values } });
    const reply = output.pop(); assert(reply, 'Worker must reply'); assert(!reply.error, reply.error); return reply;
  }
  await call('init', { rate: 48000 });
  const payload = bootstrap.create(lanOrigin, token());
  const encoded = await call('encode', { payload });
  assert(encoded.waveform.byteLength > 0);
  const floats = new Float32Array(encoded.waveform);
  assert(floats.every((value) => Number.isFinite(value) && Math.abs(value) <= 0.11), 'Low-amplitude finite output');
  await call('init', { rate: 48000 });
  let decoded = '';
  for (let offset = 0; offset < encoded.waveform.byteLength; offset += 4096) {
    const reply = await call('decode', { samples: encoded.waveform.slice(offset, offset + 4096) });
    if (reply.payload) decoded = reply.payload;
  }
  assert.equal(decoded, payload);
  assert.deepEqual(bootstrap.parse(decoded), bootstrap.parse(payload));
});
