const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const fail = (status, message) => Object.assign(new Error(message), { status });
const digest = (value) => createHash('sha256').update(value).digest();
const types = new Map(Object.entries({ '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' }));
const privateName = /^(?:[._]|node_modules$|private(?:\.|$)|secrets?(?:\.|$)|credentials?(?:\.|$)|config(?:\.|$)|.*\.(?:private|secret)\.)/i;
const safePart = (part) => part && !privateName.test(part) && !/[\\:\x00-\x1f\x7f<>"|?*]/.test(part)
  && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part);

async function checkHidden(filename) {
  if (process.platform !== 'win32') return;
  // Node stat does not expose Windows Hidden/System attributes. Fail closed if this check fails.
  const literal = filename.replace(/'/g, "''");
  const command = `$ErrorActionPreference='Stop'; [int]((Get-Item -Force -LiteralPath '${literal}').Attributes -band 6)`;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 5000 });
  if (stdout.trim() !== '0') throw fail(403, 'Private file unavailable.');
}

function createLivePreview({ now = Date.now } = {}) {
  let active = null, changing = false;
  async function stop() {
    const old = active;
    active = null;
    if (old) {
      old.grants.clear();
      old.server.closeAllConnections();
      await new Promise((resolve) => old.server.close(resolve));
    }
  }
  async function handle(state, request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=(), payment=()');
    // Opaque sandbox origin prevents access to shared-host cookies/storage and workspace DOM.
    response.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; worker-src 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'; object-src 'none'");
    const local = request.socket.localAddress.replace(/^::ffff:/, '');
    if (![`${local}:${state.port}`, ...(local === '127.0.0.1' ? [`localhost:${state.port}`] : [])].includes(request.headers.host)) throw fail(400, 'Invalid preview host.');
    if (!['GET', 'HEAD'].includes(request.method)) throw fail(405, 'Static preview only.');
    const route = /^\/p\/([a-f0-9]{64})(\/[^?#]*)?(?:\?[^#]*)?$/.exec(request.url);
    if (!route || active !== state) throw fail(401, 'Preview grant required.');
    const key = digest(route[1]).toString('hex');
    const grant = state.grants.get(key);
    if (!grant || !timingSafeEqual(grant.hash, digest(route[1])) || grant.expiresAt <= now() || !grant.authorized()) {
      state.grants.delete(key); throw fail(401, 'Preview grant expired or invalid.');
    }
    // Sandboxed module scripts/fonts use an opaque Origin. Only preview-granted static
    // resources allow it; workspace CORS policy and credentials remain untouched.
    if (request.headers.origin === 'null') response.setHeader('Access-Control-Allow-Origin', 'null');
    response.setHeader('Vary', 'Origin');
    if (!route[2]) { response.writeHead(302, { Location: `/p/${route[1]}/` }); response.end(); return; }
    let decoded;
    try { decoded = decodeURIComponent(route[2]); } catch { throw fail(400, 'Invalid path.'); }
    if (decoded.includes('%') || decoded.includes('\\')) throw fail(403, 'Invalid path.');
    const parts = decoded.slice(1).split('/');
    if (parts.at(-1) === '') parts[parts.length - 1] = 'index.html';
    if (!parts.every(safePart)) throw fail(403, 'Private or invalid path.');
    const type = types.get(path.extname(parts.at(-1)).toLowerCase());
    if (!type) throw fail(403, 'File type is not public static content.');
    let target = state.root;
    // Reject all symlinks/junctions, including in-root links. No directory listing or fallback routing.
    for (const part of parts) {
      target = path.join(target, part);
      const info = await fs.lstat(target);
      if (info.isSymbolicLink()) throw fail(403, 'Links unavailable.');
      await checkHidden(target);
    }
    const resolved = await fs.realpath(target);
    if (!resolved.startsWith(state.root + path.sep)) throw fail(403, 'Outside preview directory.');
    const before = await fs.lstat(target);
    if (!before.isFile() || before.nlink !== 1 || before.size > 100000000) throw fail(403, 'File unavailable.');
    const file = await fs.open(target, 'r');
    try {
      const opened = await file.stat();
      if (opened.size > 100000000 || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev || (await fs.realpath(target)) !== resolved
        || (await fs.lstat(target)).isSymbolicLink()) throw fail(403, 'Project changed during access.');
      // A bounded read ensures checks finish before any project bytes are released.
      const bytes = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      if ((await fs.realpath(target)) !== resolved || (await fs.lstat(target)).isSymbolicLink()) throw fail(403, 'Project changed during access.');
      if (active !== state || grant.expiresAt <= now() || !grant.authorized()) throw fail(401, 'Preview stopped or expired.');
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': offset });
      response.end(request.method === 'HEAD' ? undefined : bytes.subarray(0, offset));
    } finally { await file.close(); }
  }
  return {
    async stop() {
      if (changing) throw fail(409, 'Preview change in progress.');
      changing = true;
      try { await stop(); } finally { changing = false; }
    },
    status() { return { running: !!active, port: active?.port }; },
    async start(directory) {
      if (changing) throw fail(409, 'Preview change in progress.');
      changing = true;
      try {
        if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.length > 1024
          || /[\x00-\x1f]/.test(directory) || directory.startsWith('\\\\')) throw fail(400, 'Select an absolute local project directory.');
        if ((await fs.lstat(directory)).isSymbolicLink()) throw fail(403, 'Project links unavailable.');
        const root = await fs.realpath(directory);
        if (!safePart(path.basename(root))) throw fail(403, 'Private project directory unavailable.');
        for (let cursor = path.resolve(directory); cursor !== path.parse(cursor).root; cursor = path.dirname(cursor)) {
          if ((await fs.lstat(cursor)).isSymbolicLink()) throw fail(403, 'Project links unavailable.');
        }
        if (!(await fs.stat(root)).isDirectory() || root === path.parse(root).root) throw fail(400, 'Select a project directory.');
        await checkHidden(root);
        await stop();
        const state = { root, grants: new Map(), server: null, port: null };
        state.server = http.createServer((req, res) => handle(state, req, res).catch((error) => {
          if (res.headersSent) return res.destroy();
          res.writeHead(error.status || (error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500));
          res.end(error.status ? error.message : 'Preview file unavailable.');
        }));
        await new Promise((resolve, reject) => { state.server.once('error', reject); state.server.listen(0, '0.0.0.0', resolve); });
        state.port = state.server.address().port;
        active = state;
        return this.status();
      } finally { changing = false; }
    },
    grant(authorized) {
      if (!active) throw fail(409, 'Host has not started a preview.');
      for (const [key, value] of active.grants) if (value.expiresAt <= now()) active.grants.delete(key);
      if (active.grants.size >= 256) throw fail(429, 'Preview grant capacity reached.');
      const token = randomBytes(32).toString('hex'), hash = digest(token), expiresAt = now() + 5 * 60 * 1000;
      active.grants.set(hash.toString('hex'), { hash, expiresAt, authorized });
      return { port: active.port, pathname: `/p/${token}/`, expiresAt };
    },
  };
}

module.exports = { createLivePreview };
