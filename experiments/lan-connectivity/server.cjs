const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { MAX_UPLOAD_BYTES, createTransferStore } = require('../../packages/transfer/index.cjs');
const { pipeline } = require('node:stream/promises');
const { createWorkspaceAccess } = require('./workspace-access.cjs');
const { workspaceUI } = require('./workspace-ui.cjs');

function createLanServer({ uploadsDirectory = path.join(__dirname, 'uploads'), auth, preview } = {}) {
const uploads = uploadsDirectory;
const access = createWorkspaceAccess({ auth, preview });
const maxUploadBytes = MAX_UPLOAD_BYTES;
const transferStore = createTransferStore(uploads);
const safeName = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.bin$/;

function sanitizeFilename(value) {
  const name = String(value).split(/[\\/]/).pop()
    .replace(/[\x00-\x1f\x7f-\x9f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '');
  if (!name) return 'download';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name;
}

function contentDisposition(name) {
  const clean = sanitizeFilename(name);
  const fallback = clean.replace(/[^\x20-\x7e]|[%]/g, '_');
  const encoded = encodeURIComponent(clean).replace(/['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function handle(request, response) {
  if (await access.handle(request, response)) return;
  if (request.method === 'GET' && request.url === '/project.mjs') {
    response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    response.end(await fs.readFile(path.join(__dirname, '../../packages/transfer/project.mjs'), 'utf8'));
    return;
  }
  if (request.method === 'GET' && request.url === '/secret-scan.mjs') {
    response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    response.end(await fs.readFile(path.join(__dirname, '../../packages/transfer/secret-scan.mjs'), 'utf8'));
    return;
  }
  if (request.method === 'GET' && request.url === '/sha256.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    response.end(await fs.readFile(require.resolve('../../packages/transfer/browser-sha256.js'), 'utf8'));
    return;
  }
  if (request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      message: 'EchoDrop LAN server is running',
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  if (request.method === 'GET' && request.url === '/') {
    await fs.mkdir(uploads, { recursive: true });
    const files = (await fs.readdir(uploads, { withFileTypes: true }))
      .filter((file) => file.isFile() && safeName.test(file.name));
    const links = await Promise.all(files.map(async (file) => {
      if (!await transferStore.isDownloadable(file.name)) return '';
      let originalName = file.name;
      try {
        originalName = JSON.parse(await fs.readFile(path.join(uploads, `${file.name}.json`), 'utf8'))
          .originalName || file.name;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const label = sanitizeFilename(originalName).replace(/[&<>"']/g,
        (character) => `&#${character.charCodeAt(0)};`);
      return `<li><a href="/files/${file.name}" download="${label}">${label}</a></li>`;
    }));
    const workspacePage = await workspaceUI(request.scriptNonce, links.join(''));
    if (workspacePage) {
      response.setHeader('Content-Security-Policy', response.getHeader('Content-Security-Policy') + `; style-src 'nonce-${request.scriptNonce}'`);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(workspacePage);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>EchoDrop workspace</title>
<h1>EchoDrop workspace</h1>
<p>Plain HTTP LAN: no encryption or MITM protection. Approved members share workspace files. Sessions expire after 8 hours and on server restart.</p>
<a href="/join">Join again</a>
<button id="preview-grant">Get LivePreview link</button><a id="preview-link" target="_blank" rel="noopener noreferrer" hidden>Open LivePreview</a><p id="preview-status" role="status"></p>
<p>Maximum file size: 100 MB (100,000,000 bytes). Select the same file again to resume an interrupted upload.</p>
<form id="upload"><input id="file" type="file" required><button>Upload</button></form>
<progress id="progress" value="0" max="1"></progress>
<p id="status" role="status"></p>
<ul id="files">${links.join('')}</ul>
<script nonce="${request.scriptNonce}" src="/sha256.js"></script>
<script type="module" nonce="${request.scriptNonce}">
import { withSharingCheck } from "/secret-scan.mjs";
function workspaceFetch(url, options = {}) {
  if (options.method && options.method !== 'GET') {
    options = { ...options, headers: { ...options.headers, 'X-EchoDrop-Request': '1' } };
  }
  return fetch(url, { ...options, signal: AbortSignal.timeout(120000) });
}
document.getElementById('preview-grant').onclick = async () => {
  const link = document.getElementById('preview-link'); link.hidden = true; link.removeAttribute('href');
  try {
    const response = await workspaceFetch('/preview/grant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!response.ok) throw new Error(await response.text());
    const grant = await response.json(); link.href = grant.url; link.hidden = false;
    document.getElementById('preview-status').textContent = 'Preview link expires ' + new Date(grant.expiresAt).toLocaleTimeString();
  } catch (error) { document.getElementById('preview-status').textContent = error.message; }
};
document.getElementById('upload').addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = document.getElementById('file').files[0];
  const status = document.getElementById('status');
  if (!file) return;
  if (file.size > ${maxUploadBytes}) { status.textContent = 'File exceeds 100 MB.'; return; }
  const button = event.currentTarget.querySelector('button');
  const progress = document.getElementById('progress');
  button.disabled = true;
  progress.max = file.size || 1;
  progress.value = 0;
  status.textContent = '0 / ' + file.size + ' bytes uploaded';
  let transfer;
  let storageKey;
  try {
    status.textContent = 'Checking file locally for sensitive content…';
    const shared = await withSharingCheck(file, async result => confirm(file.name + ': ' + [...result.categories, ...result.limitations].join('; ') + ' Share anyway with approved workspace members over plain HTTP?'), async () => {
    status.textContent = 'Hashing file…';
    const hash = await sha256File(file);
    storageKey = 'echodrop:transfer:' + hash + ':' + file.size + ':' + encodeURIComponent(file.name);
    const headers = { 'X-File-Name': encodeURIComponent(file.name), 'X-File-Size': String(file.size), 'X-File-SHA256': hash };
    let savedId = localStorage.getItem(storageKey);
    const pendingKey = storageKey + ':creating';
    if (savedId && localStorage.getItem(pendingKey) !== savedId) {
      const resumed = await workspaceFetch('/transfers/' + encodeURIComponent(savedId) + '/resume', { method: 'POST', headers });
      if (resumed.ok) transfer = await resumed.json();
      else if ((resumed.status === 404 || resumed.status === 410) && confirm('The host cannot resume this upload. Start a new upload of this file?')) savedId = null;
      else throw new Error(await resumed.text());
    }
    if (!transfer) {
      if (!savedId) {
        const value = crypto.getRandomValues(new Uint8Array(16));
        value[6] = (value[6] & 15) | 64; value[8] = (value[8] & 63) | 128;
        const hex = Array.from(value, b => b.toString(16).padStart(2, '0')).join('');
        savedId = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
      }
      localStorage.setItem(storageKey, savedId);
      localStorage.setItem(pendingKey, savedId);
      const started = await workspaceFetch('/transfers', { method: 'POST', headers: { ...headers, 'X-Transfer-ID': savedId } });
      if (!started.ok) {
        if (started.status === 410) localStorage.removeItem(pendingKey);
        throw new Error(await started.text());
      }
      transfer = await started.json();
      localStorage.removeItem(pendingKey);
    }
    progress.value = transfer.retainedBytes;
    status.textContent = transfer.retainedBytes + ' / ' + file.size + ' bytes retained';
    while (transfer.state !== 'completed' && transfer.nextIndex * transfer.chunkSize < file.size) {
      const offset = transfer.nextIndex * transfer.chunkSize;
      const result = await workspaceFetch('/transfers/' + transfer.id + '/chunks/' + transfer.nextIndex, {
        method: 'PUT', body: file.slice(offset, offset + transfer.chunkSize),
      });
      if (!result.ok) throw new Error(await result.text());
      transfer = await result.json();
      progress.value = transfer.retainedBytes;
      status.textContent = transfer.retainedBytes + ' / ' + file.size + ' bytes uploaded';
    }
    status.textContent = 'Verifying upload…';
    const completed = await workspaceFetch('/transfers/' + transfer.id + '/complete', { method: 'POST' });
    if (!completed.ok) throw new Error(await completed.text());
    progress.value = file.size || 1;
    const uploaded = await completed.json();
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = uploaded.download;
    link.download = uploaded.originalName;
    link.textContent = uploaded.originalName;
    item.appendChild(link);
    if (!Array.from(document.querySelectorAll('#files a')).some(a => a.getAttribute('href') === uploaded.download)) document.getElementById('files').appendChild(item);
    status.textContent = 'Upload verified.';
    });
    if (!shared) { document.getElementById('file').value = ''; status.textContent = 'Sharing cancelled. No new file bytes were uploaded.'; }
  } catch (error) {
    let retained = null;
    if (transfer) {
      try {
        const result = await workspaceFetch('/transfers/' + transfer.id);
        if (result.ok) {
          const latest = await result.json();
          retained = latest.retainedBytes;
          progress.value = retained;
        }
      } catch { /* Keep the saved ID when the server is unreachable. */ }
    }
    status.textContent = error.message + (retained === null ? '' : ' (' + retained + ' bytes retained.)');
  }
  finally { button.disabled = false; }
});
</script></html>`);
    return;
  }

  const resumeRoute = /^\/transfers\/([^/]+)\/resume$/.exec(request.url);
  if (request.method === 'POST' && (request.url === '/transfers' || resumeRoute)) {
    const sizeHeader = request.headers['x-file-size'];
    if (!sizeHeader || !/^[0-9]+$/.test(sizeHeader)) {
      response.writeHead(400);
      response.end('Invalid file size.');
      return;
    }
    let originalName;
    try {
      originalName = sanitizeFilename(decodeURIComponent(request.headers['x-file-name'] || 'download'));
    } catch {
      response.writeHead(400);
      response.end('Invalid filename.');
      return;
    }
    const transfer = resumeRoute
      ? await transferStore.resume(resumeRoute[1], originalName, Number(sizeHeader), request.headers['x-file-sha256'])
      : await transferStore.create(originalName, Number(sizeHeader), request.headers['x-file-sha256'], request.headers['x-transfer-id']);
    response.writeHead(resumeRoute ? 200 : 201, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(transfer));
    return;
  }

  const statusRoute = /^\/transfers\/([^/]+)$/.exec(request.url);
  if (request.method === 'GET' && statusRoute) {
    const result = await transferStore.status(statusRoute[1]);
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(result));
    return;
  }

  const chunkRoute = /^\/transfers\/([^/]+)\/chunks\/(0|[1-9][0-9]*)$/.exec(request.url);
  if (request.method === 'PUT' && chunkRoute) {
    const result = await transferStore.append(chunkRoute[1], Number(chunkRoute[2]), request);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result));
    return;
  }

  const completeRoute = /^\/transfers\/([^/]+)\/complete$/.exec(request.url);
  if (request.method === 'POST' && completeRoute) {
    const result = await transferStore.complete(completeRoute[1]);
    response.writeHead(201, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result));
    return;
  }

  if (request.method === 'GET' && request.url.startsWith('/files/')) {
    const name = request.url.slice('/files/'.length);
    // Accept only generated names: no decoding, separators, or user filenames.
    if (!safeName.test(name)) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (!await transferStore.isDownloadable(name)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const filename = path.join(uploads, name);
    const stat = await fs.lstat(filename);
    if (!stat.isFile()) {
      response.writeHead(404);
      response.end();
      return;
    }
    let originalName = name;
    try {
      originalName = JSON.parse(await fs.readFile(`${filename}.json`, 'utf8')).originalName || name;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const disposition = contentDisposition(originalName);
    const file = await fs.open(filename, 'r');
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': disposition,
      'Content-Length': stat.size,
      'X-Content-Type-Options': 'nosniff',
    });
    await pipeline(file.createReadStream(), response);
    return;
  }

  response.writeHead(request.url.startsWith('/transfers/') ? 400 : 404);
  response.end();
}

const server = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(error.status || (error.code === 'ENOENT' ? 404 : 500), { Connection: 'close' });
    response.end(error.status ? error.message : (error.code === 'ENOENT' ? 'Not found.' : 'Request failed.'));
    request.resume();
  });
});

server.on('close', () => { access.close().catch(() => {}); });
return { server, bootstrapToken: access.bootstrapToken };
}

module.exports = { createLanServer };

if (require.main === module) {
  const { server, bootstrapToken } = createLanServer();
  server.listen(3000, '0.0.0.0', () => {
    console.log('Host controls: http://localhost:3000/host');
    console.log('Host code (local-only; keep private): ' + bootstrapToken);
    console.log('Plain HTTP LAN: no encryption or MITM protection.');
  });
}
