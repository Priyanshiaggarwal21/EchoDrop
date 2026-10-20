const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { lanInterfaces } = require('./onboarding-assets.cjs');
const { createLanServer } = require('./server.cjs');

test('advertised interfaces retain adapter identity and actual port without public or loopback addresses', () => {
  const entry = (address, family = 'IPv4', internal = false) => ({ address, family, internal });
  const interfaces = {
    VPN: [entry('10.8.0.2')],
    'Wi-Fi': [entry('192.168.1.20', 4), entry('fe80::1', 'IPv6')],
    Duplicate: [entry('192.168.1.20')],
    Loopback: [entry('127.0.0.1', 'IPv4', true)],
    Public: [entry('8.8.8.8')],
    Ethernet: [entry('169.254.1.2')],
    Missing: undefined,
  };
  assert.deepEqual(lanInterfaces(43127, interfaces), [
    { name: 'VPN', address: '10.8.0.2', origin: 'http://10.8.0.2:43127', linkLocal: false },
    { name: 'Wi-Fi', address: '192.168.1.20', origin: 'http://192.168.1.20:43127', linkLocal: false },
    { name: 'Ethernet', address: '169.254.1.2', origin: 'http://169.254.1.2:43127', linkLocal: true },
  ]);
  assert.deepEqual(lanInterfaces(43127, {}), []);
  assert.throws(() => lanInterfaces(0, interfaces));
});

test('IPv4 wildcard listener serves the machine LAN address while host controls stay loopback-only', async (t) => {
  // A socket test on this computer, not evidence of phone/router/firewall reachability.
  const candidate = lanInterfaces(1).find(entry => !entry.linkLocal);
  if (!candidate) return t.skip('No private IPv4 adapter on this test machine.');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'echodrop-lan-check-'));
  const { server, bootstrapToken } = createLanServer({ uploadsDirectory: temporary });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert(path.basename(temporary).startsWith('echodrop-lan-check-'));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  const port = server.address().port;
  const local = `http://127.0.0.1:${port}`;
  const lan = `http://${candidate.address}:${port}`;
  const request = (base, route, cookie = '', value) => fetch(base + route, {
    signal: AbortSignal.timeout(5000),
    ...(value === undefined ? {} : { method: 'POST', body: JSON.stringify(value) }),
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-EchoDrop-Request': '1' },
  });
  const expect = async (response, status) => {
    const text = await response.text();
    assert.equal(response.status, status, text);
    return response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
  };
  const cookie = (response, name) => response.headers.getSetCookie().find(value => value.startsWith(name + '=')).split(';')[0];
  const login = await request(local, '/auth/host', '', { token: bootstrapToken });
  await expect(login, 200);
  const host = cookie(login, 'echo_host');
  const state = await expect(await request(local, '/host/state', host), 200);
  assert(state.lanUrls.includes(lan));
  assert(state.lanInterfaces.some(entry => entry.origin === lan && entry.name === candidate.name));
  await expect(await request(lan, '/health'), 200);
  const joinPage = await expect(await request(lan, '/join'), 200);
  assert.match(joinPage, /id="omni-root" data-page="join"/);
  await expect(await request(lan, '/host/state', host), 403);
  await expect(await request(lan, '/auth/host', '', { token: bootstrapToken }), 403);
  await expect(await request(lan, '/'), 401);
  const invite = await expect(await request(local, '/host/invitations', host, {}), 201);
  const join = await request(lan, '/auth/join', '', { invitationToken: invite.token, deviceName: 'LAN socket test' });
  const pending = await expect(join, 202);
  const pendingCookie = cookie(join, 'echo_join');
  await expect(await request(lan, '/auth/claim', pendingCookie, {}), 403);
  await expect(await request(local, `/host/joins/${pending.id}/approve`, host, {}), 200);
  const claim = await request(lan, '/auth/claim', pendingCookie, {});
  await expect(claim, 200);
  await expect(await request(lan, '/', cookie(claim, 'echo_session')), 200);
});
