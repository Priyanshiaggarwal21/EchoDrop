const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { createLanServer } = require('../../experiments/lan-connectivity/server.cjs');
const { installPreview } = require('./preview.cjs');

const entry = pathToFileURL(path.join(__dirname, '../web/dist/index.html')).href;
let service, origin, credential, starting, window;
const marker = () => path.join(app.getPath('userData'), 'workspace.json');

async function api(route) {
  const response = await fetch(origin + route, { headers: { Cookie: credential }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Workspace unavailable (${response.status}). Reopen EchoDrop to renew your session.`);
  return response;
}
async function start() {
  if (starting) return starting;
  starting = (async () => {
    if (!service) {
      service = createLanServer({ uploadsDirectory: path.join(app.getPath('userData'), 'workspace', 'uploads') });
      try {
        await new Promise((resolve, reject) => {
          service.server.once('error', reject);
          service.server.listen(0, '0.0.0.0', resolve);
        });
        origin = `http://localhost:${service.server.address().port}`;
        const response = await fetch(origin + '/auth/host', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EchoDrop-Request': '1' },
          body: JSON.stringify({ token: service.bootstrapToken }), signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error('Could not authenticate the local host.');
        credential = response.headers.get('set-cookie').split(';')[0];
        await session.defaultSession.cookies.set({ url: origin, name: 'echo_host', value: credential.slice('echo_host='.length), httpOnly: true, sameSite: 'strict', path: '/' });
      } catch (error) {
        service.server.close(); service = null; throw error;
      }
    }
    await api('/host/state');
    await fs.mkdir(path.dirname(marker()), { recursive: true });
    await fs.writeFile(marker(), JSON.stringify({ version: 1 }));
    return { ready: true };
  })();
  try { return await starting; } finally { starting = null; }
}
function trusted(event) {
  if (event.sender !== window.webContents || event.senderFrame.url.split('#')[0] !== entry) throw new Error('Untrusted client.');
}
installPreview({ ipcMain, trusted, parent: () => window, request: async (route, body) => {
  if (!service) throw new Error('Create your workspace first.');
  const response = await fetch(origin + route, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: credential, 'Content-Type': 'application/json', 'X-EchoDrop-Request': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(await response.text() || `Preview request failed (${response.status}).`);
  return response.json();
} });
ipcMain.handle('workspace:restore', async (event) => {
  trusted(event);
  try { await fs.access(marker()); } catch { return { ready: false }; }
  return start();
});
ipcMain.handle('workspace:start', (event) => { trusted(event); return start(); });
ipcMain.handle('workspace:pairing', async (event, route, body) => {
  trusted(event);
  const id = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  const read = route === '/host/state' && body === undefined;
  const write = typeof route === 'string' && new RegExp(`^/host/(joins/${id}/(approve|reject)|sessions/${id}/revoke)$`).test(route)
    && body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0;
  if (!service || (!read && !write)) throw new Error('Unsupported host operation.');
  const response = await fetch(origin + route, { method: read ? 'GET' : 'POST', headers: { Cookie: credential, 'Content-Type': 'application/json', 'X-EchoDrop-Request': '1' }, ...(write ? { body: '{}' } : {}), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
});
ipcMain.handle('workspace:transfer', async (event, value) => {
  trusted(event);
  if (!service) throw new Error('Create your workspace first.');
  const { path: route, method = 'GET', headers = {}, bytes } = value || {};
  const id = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  const allowed = method === 'GET' && (route === '/' || new RegExp(`^/transfers/${id}$`).test(route))
    || method === 'POST' && (route === '/transfers' || new RegExp(`^/transfers/${id}/(resume|complete)$`).test(route))
    || method === 'PUT' && new RegExp(`^/transfers/${id}/chunks/(0|[1-9][0-9]*)$`).test(route);
  if (!allowed || typeof route !== 'string') throw new Error('Unsupported transfer operation.');
  if (bytes !== undefined && (!(bytes instanceof ArrayBuffer) || bytes.byteLength > 1024 * 1024 || method !== 'PUT')) throw new Error('Invalid chunk.');
  const safeHeaders = { Cookie: credential, ...(method !== 'GET' ? { 'X-EchoDrop-Request': '1' } : {}) };
  for (const [key, value] of Object.entries(headers)) {
    if (!['X-File-Name', 'X-File-Size', 'X-File-SHA256', 'X-Transfer-ID'].includes(key) || typeof value !== 'string' || value.length > 4096) throw new Error('Invalid transfer header.');
    safeHeaders[key] = value;
  }
  const response = await fetch(origin + route, { method, headers: safeHeaders, ...(bytes ? { body: Buffer.from(bytes) } : {}), signal: AbortSignal.timeout(120000) });
  return { status: response.status, text: await response.text() };
});
ipcMain.handle('workspace:download', async (event, route) => {
  trusted(event);
  if (typeof route !== 'string' || !/^\/files\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.bin$/.test(route)) throw new Error('Invalid file.');
  await api('/host/state');
  window.webContents.downloadURL(origin + route);
});
ipcMain.handle('workspace:state', async (event) => {
  trusted(event);
  if (!service) throw new Error('Create your local workspace first.');
  const [health, state, files] = await Promise.all([api('/health').then(r => r.json()), api('/host/state').then(r => r.json()), api('/').then(r => r.text())]);
  return { health, state, files };
});
ipcMain.handle('workspace:open', async (event, area) => {
  trusted(event);
  if (!['files', 'devices', 'preview'].includes(area)) throw new Error('Unknown workspace area.');
  await api('/host/state');
  const client = new BrowserWindow({ width: 980, height: 760, parent: window, autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  // Preserve the existing authenticated transfer, pairing and preview interfaces.
  client.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
  client.webContents.setWindowOpenHandler(({ url }) => {
    const target = new URL(url);
    if (target.protocol !== 'http:' || target.hostname !== 'localhost' || !/^\/p\/[0-9a-f]{64}\//.test(target.pathname)) return { action: 'deny' };
    return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } } };
  });
  client.webContents.on('did-create-window', (previewWindow) => {
    previewWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    previewWindow.webContents.on('will-navigate', event => event.preventDefault());
  });
  await client.loadURL(origin + (area === 'files' ? '/' : area === 'devices' ? '/host/pairing' : '/host'));
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(() => {
    window = new BrowserWindow({ width: 1280, height: 860, minWidth: 380, minHeight: 560, backgroundColor: '#19211e', autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.loadURL(entry);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { if (service) service.server.close(); });
}
