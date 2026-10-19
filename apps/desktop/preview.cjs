const { BrowserWindow, dialog } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Picker selections and grants stay in the main process. No arbitrary renderer URLs or file reads.
function installPreview({ ipcMain, trusted, parent, request }) {
  let selection = null, active = null, grant = null, viewer = null, timer = null, changing = false;
  function closeViewer() { clearTimeout(timer); timer = null; if (viewer && !viewer.isDestroyed()) viewer.destroy(); viewer = null; }
  async function status() {
    const state = await request('/host/state');
    if (!state.preview.running || active?.port !== state.preview.port) { active = null; grant = null; closeViewer(); }
    return { ...state.preview, project: active ? { name: active.name, entry: active.entry, directory: active.directory } : null, lanUrls: state.lanUrls };
  }
  async function issue() {
    const state = await status();
    if (!state.running) throw new Error('Preview is stopped. Start a project first.');
    const value = await request('/preview/grant', {});
    const url = new URL(value.url);
    if (url.protocol !== 'http:' || url.hostname !== 'localhost' || Number(url.port) !== state.port || !/^\/p\/[a-f0-9]{64}\/$/.test(url.pathname)) throw new Error('Unexpected preview grant.');
    url.pathname += encodeURIComponent(active?.entry || 'index.html');
    const response = await fetch(url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(response.status === 404 ? 'The preview entry file is missing. Choose a folder with index.html or select an HTML file.' : `Preview entry unavailable (${response.status}). Private files, links and files over 100 MB cannot be previewed.`);
    grant = { url: url.href, expiresAt: value.expiresAt };
    return grant;
  }
  async function show() {
    if (!grant || grant.expiresAt <= Date.now()) throw new Error('Preview access expired. Refresh to request a new grant.');
    const url = grant.url;
    closeViewer();
    const current = new BrowserWindow({ width: 1120, height: 800, show: false, parent: parent(), autoHideMenuBar: true, title: active ? `${active.name} · LivePreview` : 'EchoDrop LivePreview', webPreferences: { partition: `preview-${randomUUID()}`, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
    viewer = current;
    current.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    current.webContents.session.setPermissionCheckHandler(() => false);
    current.webContents.session.on('will-download', event => event.preventDefault());
    current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const allowed = value => { try { const target = new URL(value), base = new URL(url); return target.origin === base.origin && target.pathname.startsWith(base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1)); } catch { return false; } };
    current.webContents.on('will-navigate', (event, target) => { if (!allowed(target)) event.preventDefault(); });
    current.webContents.on('will-redirect', (event, target) => { if (!allowed(target)) event.preventDefault(); });
    current.on('closed', () => { if (viewer === current) viewer = null; });
    timer = setTimeout(closeViewer, Math.max(0, grant.expiresAt - Date.now()));
    try { await current.loadURL(url); if (!current.isDestroyed()) current.show(); }
    catch { closeViewer(); throw new Error('The preview window could not load. Check that the host is running, then refresh access.'); }
  }
  ipcMain.handle('workspace:preview', async (event, action, kind) => {
    trusted(event);
    if (action === 'status') return changing ? null : status();
    if (changing) throw new Error('A preview operation is in progress.');
    changing = true;
    try {
      if (action === 'select') {
        await request('/host/state');
        if (!['folder', 'html'].includes(kind)) throw new Error('Unsupported picker.');
        const result = await dialog.showOpenDialog(parent(), { title: kind === 'folder' ? 'Select a static project with index.html' : 'Select an HTML entry file', properties: kind === 'folder' ? ['openDirectory'] : ['openFile'], ...(kind === 'html' ? { filters: [{ name: 'HTML entry', extensions: ['html', 'htm'] }] } : {}) });
        if (result.canceled || !result.filePaths[0]) return null;
        const picked = result.filePaths[0];
        const directory = kind === 'folder' ? picked : path.dirname(picked);
        const entry = kind === 'folder' ? 'index.html' : path.basename(picked);
        if (!/\.html?$/i.test(entry)) throw new Error('Select an HTML or HTM entry file.');
        let info;
        try { info = await fs.lstat(path.join(directory, entry)); } catch { throw new Error('Entry file not found. Choose a folder containing index.html or select its HTML entry file.'); }
        if (!info.isFile() || info.isSymbolicLink() || info.size > 100000000) throw new Error('Select a regular HTML file under the 100 MB limit. Links are unsupported.');
        selection = { directory, entry, name: path.basename(directory) };
        return selection;
      }
      if (action === 'start') {
        if (!selection) throw new Error('Select a project first.');
        const result = await request('/host/preview/start', { directory: selection.directory });
        active = { ...selection, port: result.port }; grant = null; closeViewer();
        try { await issue(); await show(); }
        catch (error) { await request('/host/preview/stop', {}).catch(() => {}); active = null; grant = null; closeViewer(); throw error; }
        return { ...(await status()), grant };
      }
      if (action === 'refresh') { await issue(); await show(); return { ...(await status()), grant }; }
      if (action === 'open') { await status(); await show(); return { grant }; }
      if (action === 'grant') { await issue(); return { ...(await status()), grant }; }
      if (action === 'stop') { await request('/host/preview/stop', {}); active = null; grant = null; closeViewer(); return status(); }
      throw new Error('Unsupported preview operation.');
    } finally { changing = false; }
  });
}
module.exports = { installPreview };
