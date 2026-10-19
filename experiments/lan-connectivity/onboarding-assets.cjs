const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const bootstrap = require('../../packages/core/invitation-bootstrap.js');

// Exact local allowlist: never expose node_modules, uploads, or filesystem paths generally.
const assets = new Map([
  ['/onboarding/bootstrap.js', require.resolve('../../packages/core/invitation-bootstrap.js')],
  ['/onboarding/qr-generator.js', require.resolve('qrcode-generator')],
  ['/onboarding/qr-reader.js', require.resolve('jsqr')],
  ['/onboarding/ggwave.js', require.resolve('ggwave')],
  ['/onboarding/browser.js', path.join(__dirname, 'onboarding/browser.js')],
  ['/onboarding/acoustic-worker.js', path.join(__dirname, 'onboarding/acoustic-worker.js')],
  ['/onboarding/licenses.txt', path.join(__dirname, 'onboarding/third-party-notices.txt')],
]);
async function serve(request, response) {
  if (request.method !== 'GET' || !assets.has(request.url)) return false;
  if (request.url === '/onboarding/acoustic-worker.js') {
    // Emscripten 0.4.0 requires Function() for bindings. Confine that permission to this worker.
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'none'");
  }
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  let source = await fs.readFile(assets.get(request.url), 'utf8');
  if (request.url === '/onboarding/ggwave.js') {
    // Supply the package's embedded WASM directly: its default worker loader otherwise uses XHR.
    // This keeps the isolated worker's connect-src 'none' policy and needs no network requests.
    const embedded = /wasmBinaryFile="data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)"/.exec(source);
    if (!embedded) throw new Error('Pinned ggwave embedded WASM not found.');
    source = `globalThis.EchoDropGgWaveBinary=Uint8Array.from(atob("${embedded[1]}"),c=>c.charCodeAt(0));\n` + source;
  }
  response.writeHead(200, { 'Content-Type': request.url.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'text/javascript; charset=utf-8' });
  response.end(source);
  return true;
}
function lanOrigins(port) {
  const origins = new Set();
  for (const entries of Object.values(os.networkInterfaces())) for (const entry of entries || []) {
    if (entry.internal || entry.family !== 'IPv4') continue;
    try { origins.add(bootstrap.origin(`http://${entry.address}:${port}`)); } catch { /* Not a private IPv4 LAN interface. */ }
  }
  return [...origins];
}
module.exports = { serve, lanOrigins };
