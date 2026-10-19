const { randomBytes } = require('node:crypto');
const { createWorkspaceAuth } = require('../../packages/core/workspace-auth.cjs');
const onboarding = require('./onboarding-assets.cjs');
const { createLivePreview } = require('../../packages/core/live-preview.cjs');

const failure = (status, message) => Object.assign(new Error(message), { status });
const loopback = (address) => address === '::1' || /^127\./.test((address || '').replace(/^::ffff:/, ''));
const notice = 'Plain HTTP LAN: traffic and credentials are not encrypted. No MITM protection. Use only a trusted network.';

function cookies(request) {
  const result = {};
  for (const entry of (request.headers.cookie || '').split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    const key = entry.slice(0, separator).trim();
    if (!['echo_host', 'echo_session', 'echo_join'].includes(key)) continue;
    if (Object.hasOwn(result, key)) throw failure(401, 'Ambiguous session cookie.');
    result[key] = entry.slice(separator + 1).trim();
  }
  return result;
}

function cookie(name, credential, maxAge) {
  // Secure cannot be used for ordinary HTTP LAN origins. Never put credentials in URLs or localStorage.
  return `${name}=${credential}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

async function body(request, keys) {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) {
    throw failure(415, 'JSON required.');
  }
  if (Number(request.headers['content-length']) > 2048) throw failure(413, 'Request too large.');
  const parts = [];
  let size = 0;
  for await (const part of request.iterator({ destroyOnReturn: false })) {
    size += part.length;
    if (size > 2048) throw failure(413, 'Request too large.');
    parts.push(part);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw failure(400, 'Invalid JSON.'); }
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).length !== keys.length || keys.some((key) => typeof value[key] !== 'string')) {
    throw failure(400, 'Invalid request fields.');
  }
  return value;
}

function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

function page(response, nonce, title, content, script) {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<h1>${title}</h1><p>${notice}</p>${content}<p id="status" role="status"></p><a href="/onboarding/licenses.txt">Third-party notices</a>
<script nonce="${nonce}" src="/onboarding/bootstrap.js"></script>
<script nonce="${nonce}" src="/onboarding/qr-generator.js"></script>
<script nonce="${nonce}" src="/onboarding/qr-reader.js"></script>
<script nonce="${nonce}" src="/onboarding/browser.js"></script>
<script nonce="${nonce}">
const status = document.getElementById('status');
async function api(url, value) {
  const response = await fetch(url, value === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EchoDrop-Request': '1' }, body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
${script}
</script></html>`);
}

function hostPage(response, nonce) {
  page(response, nonce, 'EchoDrop host', `
<form id="login"><label>Host code from the server terminal <input id="code" type="password" autocomplete="off" required></label><button>Unlock host controls</button></form>
<p>Host controls work only on this computer via localhost. Device labels are unverified: confirm the request ID with the person before approving.</p>
<label>Host LAN URL <select id="lan-url"></select></label>
<button id="invite">Create invitation (valid for 2 minutes, single use)</button><p id="invitation"></p>
<canvas id="qr" aria-label="Invitation QR code" hidden></canvas>
<p>Scan with your phone camera, or open the host LAN URL and enter the invitation token. QR and sound only carry the host URL and invitation token.</p>
<p>Acoustic is experimental. Anyone nearby may hear the invitation. Lower device volume first; do not use headphones. Reception is not confirmed.</p>
<button id="send-audio" disabled>Send invitation quietly (experimental)</button><button id="stop-audio">Stop audio</button>
<button id="refresh">Refresh requests and devices</button><ul id="requests"></ul><ul id="devices"></ul>
<form id="preview-start"><label>Local static project directory <input id="project-directory" required></label><button>Start LivePreview</button></form>
<button id="preview-stop">Stop LivePreview</button><p id="preview-state"></p>
<p>Only select a project intended for sharing. Preview links expire after five minutes. Preview scripts are sandboxed; network requests, forms and browser storage are blocked.</p><a href="/">Open workspace</a>`, `
document.getElementById('preview-start').onsubmit = async (event) => {
  event.preventDefault();
  try { await api('/host/preview/start', { directory: document.getElementById('project-directory').value }); await refresh(); }
  catch (error) { status.textContent = error.message; }
};
document.getElementById('preview-stop').onclick = async () => {
  try { await api('/host/preview/stop', {}); await refresh(); } catch (error) { status.textContent = error.message; }
};
let invitationPayload = '', invitationExpiry = 0, expiryTimer, stopAudio, audioAbort;
function clearInvitation() {
  invitationPayload = ''; invitationExpiry = 0;
  document.getElementById('invitation').textContent = 'Invitation expired. Create a new one.';
  document.getElementById('qr').hidden = true;
  document.getElementById('qr').width = 0;
  document.getElementById('send-audio').disabled = true;
  if (stopAudio) stopAudio();
}
async function refresh() {
  const data = await api('/host/state');
  document.getElementById('preview-state').textContent = data.preview.running ? 'LivePreview running on port ' + data.preview.port : 'LivePreview stopped.';
  const select = document.getElementById('lan-url');
  const previous = select.value;
  select.replaceChildren();
  for (const origin of data.lanUrls) {
    const option = document.createElement('option'); option.value = origin; option.textContent = origin; select.appendChild(option);
  }
  if (data.lanUrls.includes(previous)) select.value = previous;
  for (const kind of ['requests', 'devices']) {
    const list = document.getElementById(kind);
    list.replaceChildren();
    for (const record of data[kind]) {
      const row = document.createElement('li');
      row.textContent = record.deviceName + ' | ' + record.id + ' | expires ' + new Date(record.expiresAt).toLocaleTimeString() + ' ';
      for (const action of (kind === 'requests' ? ['approve', 'reject'] : ['revoke'])) {
        const button = document.createElement('button');
        button.textContent = action;
        button.onclick = async () => {
          try { await api('/host/' + (kind === 'requests' ? 'joins/' : 'sessions/') + record.id + '/' + action, {}); await refresh(); }
          catch (error) { status.textContent = error.message; }
        };
        row.appendChild(button);
      }
      list.appendChild(row);
    }
  }
  status.textContent = 'Host controls ready.';
}
document.getElementById('login').onsubmit = async (event) => {
  event.preventDefault();
  const input = document.getElementById('code');
  const token = input.value;
  input.value = '';
  try { await api('/auth/host', { token }); await refresh(); }
  catch (error) { status.textContent = error.message; }
};
document.getElementById('invite').onclick = async () => {
  try {
    const host = EchoDropBootstrap.origin(document.getElementById('lan-url').value);
    if (audioAbort) audioAbort.abort();
    if (stopAudio) stopAudio();
    const invitation = await api('/host/invitations', {});
    invitationPayload = EchoDropBootstrap.create(host, invitation.token);
    invitationExpiry = invitation.expiresAt;
    document.getElementById('invitation').textContent = 'Host: ' + host + ' | Token: ' + invitation.token + ' | expires ' + new Date(invitation.expiresAt).toLocaleTimeString();
    EchoDropOnboarding.drawQR(document.getElementById('qr'), invitationPayload);
    document.getElementById('qr').hidden = false;
    document.getElementById('send-audio').disabled = false;
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(clearInvitation, Math.max(0, invitationExpiry - Date.now()));
  } catch (error) { status.textContent = error.message + ' Connect the host to a private IPv4 LAN if no URL is listed.'; }
};
document.getElementById('send-audio').onclick = async () => {
  if (!invitationPayload || Date.now() >= invitationExpiry - 15000) { status.textContent = 'Create a fresh invitation before sending audio.'; return; }
  const button = document.getElementById('send-audio');
  button.disabled = true;
  try {
    if (audioAbort) audioAbort.abort();
    if (stopAudio) stopAudio();
    audioAbort = new AbortController();
    stopAudio = await EchoDropOnboarding.transmit(invitationPayload, (message) => { status.textContent = message; }, audioAbort.signal);
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = !invitationPayload; }
};
document.getElementById('stop-audio').onclick = () => { if (audioAbort) audioAbort.abort(); if (stopAudio) stopAudio(); status.textContent = 'Audio stopped.'; };
addEventListener('pagehide', () => { if (audioAbort) audioAbort.abort(); if (stopAudio) stopAudio(); clearTimeout(expiryTimer); });
document.getElementById('refresh').onclick = () => refresh().catch((error) => { status.textContent = error.message; });
refresh().catch(() => { status.textContent = 'Enter the host code from the terminal.'; });
`);
}

function joinPage(response, nonce) {
  page(response, nonce, 'Join EchoDrop', `
<form id="join"><label>Host LAN URL <input id="host-url" type="url" required></label>
<label>Invitation token or QR invitation URL <input id="token" type="password" autocomplete="off" required></label>
<label>Device label <input id="name" maxlength="64" autocomplete="off" required></label><button>Request access</button></form>
<p id="destination"></p><a id="open-host" hidden rel="noreferrer">Open the scanned host</a>
<label>Scan a QR photo/file <input id="qr-file" type="file" accept="image/png,image/jpeg,image/webp" capture="environment"></label>
<button id="camera">Enable camera and scan QR</button><video id="preview" width="320" autoplay muted playsinline></video>
<p id="capture-note"></p><button id="microphone">Enable microphone (experimental, 30 seconds)</button><button id="stop-capture">Stop camera/microphone</button>
<p>Acoustic invitations are experimental. No audio is recorded or uploaded. On Android HTTP LAN pages, live camera and microphone may be blocked; use a QR photo/file, the phone camera app, or manual entry.</p>
<p id="request-id"></p><button id="check">Check approval</button><a href="/">Open workspace</a>`, `
let stopCapture, captureAbort;
const tokenInput = document.getElementById('token');
const hostInput = document.getElementById('host-url');
hostInput.value = location.origin;
function received(payload) {
  const invitation = EchoDropBootstrap.parse(payload);
  hostInput.value = invitation.host; tokenInput.value = invitation.token;
  const link = document.getElementById('open-host');
  link.hidden = invitation.host === location.origin;
  if (!link.hidden) {
    link.href = EchoDropBootstrap.create(invitation.host, invitation.token);
    document.getElementById('destination').textContent = 'Invitation targets ' + invitation.host + '. Confirm this host with the person inviting you before opening it.';
    status.textContent = 'Open the scanned host to continue. No invitation has been submitted.';
  } else status.textContent = 'Invitation loaded. Enter your device label and request access.';
}
const fragment = location.hash;
if (fragment) {
  history.replaceState(null, '', '/join'); // Remove the token from the current history entry immediately.
  try { received(location.origin + '/join' + fragment); } catch (error) { status.textContent = error.message; }
}
async function check() {
  const request = await api('/auth/join-status');
  document.getElementById('request-id').textContent = 'Request ID: ' + request.id;
  if (request.state === 'approved') { await api('/auth/claim', {}); location.assign('/'); }
  else status.textContent = request.state === 'rejected' ? 'Host rejected this request. Ask for a new invitation.' : 'Waiting for host approval. Confirm this request ID with the host.';
}
document.getElementById('join').onsubmit = async (event) => {
  event.preventDefault();
  try {
    if (tokenInput.value.startsWith('http:')) received(tokenInput.value.trim());
    const invitationToken = EchoDropBootstrap.token(tokenInput.value.trim());
    if (hostInput.value !== location.origin) { received(EchoDropBootstrap.create(hostInput.value, invitationToken)); return; }
    tokenInput.value = '';
    document.getElementById('open-host').removeAttribute('href');
    document.getElementById('open-host').hidden = true;
    await api('/auth/join', { invitationToken, deviceName: document.getElementById('name').value.trim() });
    await check();
  } catch (error) { status.textContent = error.message; }
};
document.getElementById('qr-file').onchange = async (event) => {
  try { received(await EchoDropOnboarding.scanFile(event.target.files[0])); }
  catch (error) { status.textContent = error.message; }
  finally { event.target.value = ''; }
};
const available = EchoDropOnboarding.mediaAvailable();
document.getElementById('camera').disabled = !available;
document.getElementById('microphone').disabled = !available;
document.getElementById('capture-note').textContent = available ? 'Camera/microphone start only after you click and grant permission.' : 'Live camera and microphone are unsupported on this HTTP LAN page. Use QR photo/file, your phone camera app, or manual entry.';
document.getElementById('camera').onclick = async () => {
  try {
    if (captureAbort) captureAbort.abort();
    if (stopCapture) stopCapture();
    captureAbort = new AbortController();
    stopCapture = await EchoDropOnboarding.camera(document.getElementById('preview'), received, (message) => { status.textContent = message; }, captureAbort.signal);
  } catch (error) { status.textContent = error.message; }
};
document.getElementById('microphone').onclick = async () => {
  try {
    if (captureAbort) captureAbort.abort();
    if (stopCapture) stopCapture();
    captureAbort = new AbortController();
    stopCapture = await EchoDropOnboarding.listen(received, (message) => { status.textContent = message; }, captureAbort.signal);
  } catch (error) { status.textContent = error.message; }
};
document.getElementById('stop-capture').onclick = () => { if (captureAbort) captureAbort.abort(); if (stopCapture) stopCapture(); status.textContent = 'Capture stopped.'; };
addEventListener('pagehide', () => { if (captureAbort) captureAbort.abort(); if (stopCapture) stopCapture(); });
document.getElementById('check').onclick = () => check().catch((error) => { status.textContent = error.message; });
check().catch(() => { if (!tokenInput.value && !fragment) status.textContent = 'Enter an invitation from the host.'; });
`);
}

function createWorkspaceAccess({ auth = createWorkspaceAuth(), preview = createLivePreview() } = {}) {
  return {
    close: () => preview.stop(),
    bootstrapToken: auth.bootstrapToken,
    async handle(request, response) {
      const nonce = randomBytes(16).toString('base64');
      request.scriptNonce = nonce;
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; worker-src 'self'; media-src blob:`);
      const host = request.headers.host;
      let origin;
      try {
        const url = new URL(`http://${host}`);
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const local = request.socket.localAddress.replace(/^::ffff:/, '');
        const localHost = hostname === 'localhost' && loopback(local);
        if (!host || url.host !== host || url.username || url.password || url.pathname !== '/'
          || Number(url.port || 80) !== request.socket.localPort || (!localHost && hostname !== local)) throw new Error();
        origin = url.origin;
      } catch { throw failure(400, 'Use this server\'s IP address or localhost.'); }
      if (!request.url.startsWith('/') || /[?#\\\x00-\x20]/.test(request.url)) throw failure(400, 'Invalid request path.');
      if (request.headers.origin && request.headers.origin !== origin) throw failure(403, 'Cross-origin access denied.');
      const joinNavigation = request.method === 'GET' && request.url === '/join'
        && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';
      if (request.headers['sec-fetch-site'] === 'cross-site' && !joinNavigation) throw failure(403, 'Cross-site access denied.');
      if (!['GET', 'HEAD'].includes(request.method) && request.headers['x-echodrop-request'] !== '1') {
        throw failure(403, 'Same-origin request header required.');
      }
      if (await onboarding.serve(request, response)) return true;
      const jar = cookies(request);
      const localHost = loopback(request.socket.remoteAddress) && loopback(request.socket.localAddress);
      if (request.method === 'GET' && request.url === '/health') return false;
      if (request.method === 'GET' && request.url === '/join') { joinPage(response, nonce); return true; }
      if (request.url === '/host' && request.method === 'GET') {
        if (!localHost) throw failure(403, 'Host controls are local-only.');
        hostPage(response, nonce); return true;
      }
      if (request.url === '/auth/host' && request.method === 'POST') {
        if (!localHost) throw failure(403, 'Host controls are local-only.');
        const { token } = await body(request, ['token']);
        const result = auth.hostLogin(token);
        response.setHeader('Set-Cookie', cookie('echo_host', result.credential, 8 * 60 * 60));
        json(response, { expiresAt: result.record.expiresAt }); return true;
      }
      if (request.url.startsWith('/host/')) {
        if (!localHost) throw failure(403, 'Host controls are local-only.');
        if (request.url === '/host/state' && request.method === 'GET') {
          json(response, { ...auth.manage(jar.echo_host), lanUrls: onboarding.lanOrigins(request.socket.localPort), preview: preview.status() }); return true;
        }
        if (request.method === 'POST' && ['/host/preview/start', '/host/preview/stop'].includes(request.url)) {
          auth.manage(jar.echo_host);
          if (request.url.endsWith('/start')) {
            const { directory } = await body(request, ['directory']);
            json(response, await preview.start(directory));
          } else { await body(request, []); await preview.stop(); json(response, preview.status()); }
          return true;
        }
        if (request.url === '/host/invitations' && request.method === 'POST') {
          await body(request, []);
          json(response, auth.invite(jar.echo_host), 201); return true;
        }
        const decision = /^\/host\/joins\/([^/]+)\/(approve|reject)$/.exec(request.url);
        if (decision && request.method === 'POST') {
          await body(request, []);
          json(response, auth.decide(jar.echo_host, decision[1], decision[2])); return true;
        }
        const revoke = /^\/host\/sessions\/([^/]+)\/revoke$/.exec(request.url);
        if (revoke && request.method === 'POST') {
          await body(request, []);
          auth.revoke(jar.echo_host, revoke[1]);
          json(response, { revoked: true }); return true;
        }
        throw failure(403, 'Host action unavailable.');
      }
      if (request.url === '/auth/join' && request.method === 'POST') {
        const value = await body(request, ['invitationToken', 'deviceName']);
        const result = auth.join(value.invitationToken, value.deviceName);
        response.setHeader('Set-Cookie', cookie('echo_join', result.credential, 10 * 60));
        json(response, { id: result.record.id, state: 'pending', expiresAt: result.record.expiresAt }, 202); return true;
      }
      if (request.url === '/auth/join-status' && request.method === 'GET') {
        json(response, auth.joinStatus(jar.echo_join)); return true;
      }
      if (request.url === '/auth/claim' && request.method === 'POST') {
        await body(request, []);
        const result = auth.claim(jar.echo_join);
        response.setHeader('Set-Cookie', [cookie('echo_session', result.credential, 8 * 60 * 60), cookie('echo_join', '', 0)]);
        json(response, { expiresAt: result.record.expiresAt }); return true;
      }
      if (request.url === '/auth/logout' && request.method === 'POST') {
        await body(request, []);
        auth.logout(jar.echo_session);
        if (localHost) auth.logout(jar.echo_host);
        response.setHeader('Set-Cookie', [cookie('echo_session', '', 0), cookie('echo_host', '', 0), cookie('echo_join', '', 0)]);
        json(response, { loggedOut: true }); return true;
      }
      // Every remaining route, including unknown future file/transfer routes, requires a session.
      const credential = localHost && jar.echo_host ? jar.echo_host : jar.echo_session;
      try {
        const session = auth.authenticate(credential);
        if (session.role === 'host' && !localHost) throw failure(403, 'Host access is local-only.');
        request.workspaceSession = session;
      } catch (error) {
        if (request.method === 'GET' && request.url === '/') {
          response.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
          response.end(`<!doctype html><meta charset="utf-8"><p>Host approval required.</p><a href="/join">Join workspace</a>${localHost ? ' <a href="/host">Host controls</a>' : ''}`);
          return true;
        }
        throw error;
      }
      if (request.method === 'POST' && request.url === '/preview/grant') {
        await body(request, []);
        const grant = preview.grant(() => { try { auth.authenticate(credential); return true; } catch { return false; } });
        const url = new URL(origin); url.port = String(grant.port); url.pathname = grant.pathname;
        json(response, { url: url.href, expiresAt: grant.expiresAt }); return true;
      }
      return false;
    },
  };
}

module.exports = { createWorkspaceAccess };
