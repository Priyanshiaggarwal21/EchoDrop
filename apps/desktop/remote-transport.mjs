import tls from 'node:tls';
import { isIP } from 'node:net';
import { readCertificate } from './remote-identity.mjs';

const ALPN = 'echodrop-collaboration/1';
const LIMIT = 2 * 1024 * 1024;
function pin(socket) {
  if (!socket.authorized || socket.getProtocol() !== 'TLSv1.3' || socket.alpnProtocol !== ALPN) throw Error('Mutual TLS authentication required.');
  const raw = socket.getPeerCertificate().raw;
  if (!raw) throw Error('Participant certificate required.');
  // readCertificate also verifies the self-signed identity profile and validity period.
  const pem = `-----BEGIN CERTIFICATE-----\n${raw.toString('base64')}\n-----END CERTIFICATE-----`;
  return readCertificate(pem).fingerprint;
}
function frame(socket, limit, callback) {
  let buffer = Buffer.alloc(0), done = false;
  socket.on('data', chunk => {
    if (done) return;
    if (buffer.length + chunk.length > limit) { done = true; socket.destroy(); return; }
    buffer = Buffer.concat([buffer, chunk]);
    const end = buffer.indexOf(10);
    if (end < 0) return;
    done = true; socket.pause();
    if (end !== buffer.length - 1) { socket.destroy(); return; }
    try { callback(null, JSON.parse(buffer.subarray(0, end).toString('utf8'))); }
    catch { callback(Error('Invalid collaboration frame.')); }
  });
}
export function runtimeBlocker(versions = process.versions) {
  if (versions.electron && Number(versions.electron.split('.')[0]) < 45) return 'Remote networking requires Electron 45 or newer. Restart the updated desktop application.';
  if (Number(versions.node.split('.')[0]) < 22) return 'Remote networking requires a maintained Node.js runtime (22 or newer).';
  return null;
}
export function createRemoteTransport(store, contentHandler, intentionHandler, contractHandler, environmentHandler, pulseHandler, deviceHandler, dnaHandler, guardianHandler, inventoryHandler) {
  let server = null;
  const sockets = new Set();
  let lifecycle = Promise.resolve();
  const serialize = task => { const result = lifecycle.then(task); lifecycle = result.catch(() => {}); return result; };
  const state = () => ({ blockedReason: runtimeBlocker(), listening: Boolean(server?.listening), port: server?.listening ? server.address().port : null });
  async function stopNow() {
    const active = server; server = null;
    for (const socket of sockets) socket.destroy(); sockets.clear();
    if (active) await new Promise(resolve => active.close(resolve));
    return state();
  }
  return {
    state,
    stop: () => serialize(stopNow),
    start: () => serialize(async () => {
      if (runtimeBlocker()) throw Error(runtimeBlocker());
      if (server) return state();
      const identity = await store.remoteCredentials();
      if (!identity.peers.length) throw Error('Verify at least one peer certificate before listening.');
      const listener = tls.createServer({ key: identity.key, cert: identity.certificate, ca: identity.peers.map(peer => peer.certificate), requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', ALPNProtocols: [ALPN], handshakeTimeout: 5000 }, socket => {
        socket.pause();
        void (async () => {
          const fingerprint = pin(socket);
          await store.remotePeer(fingerprint); // exact leaf pin; a CA-signed sibling is never a participant
          if (socket.destroyed) return;
          frame(socket, LIMIT, (error, request) => {
            if (error) { socket.destroy(); return; }
            if(request?.action==='content-complete') socket.emit('large-file-verification');
            const operation = request?.action?.startsWith?.('inventory-') && inventoryHandler ? inventoryHandler(fingerprint,request) : request?.action?.startsWith?.('guardian-') && guardianHandler ? guardianHandler(fingerprint,request) : ['dna-read','dna-detail'].includes(request?.action) && dnaHandler ? dnaHandler(fingerprint,request) : request?.action?.startsWith?.('device-') && deviceHandler ? deviceHandler(fingerprint, request) : request?.action?.startsWith?.('pulse-') && pulseHandler ? pulseHandler(fingerprint, request) : request?.action?.startsWith?.('environment-') && environmentHandler ? environmentHandler(fingerprint, request) : request?.action?.startsWith?.('contract-') && contractHandler ? contractHandler(fingerprint, request) : request?.action?.startsWith?.('intent-') && intentionHandler ? intentionHandler(fingerprint, request) : request?.action?.startsWith?.('content-') && contentHandler ? contentHandler(fingerprint, request) : store.remoteRequest(fingerprint, request);
            void operation.then(result => {
              if (socket.destroyed) return;
              const response = JSON.stringify({ version: 1, ok: true, result }) + '\n';
              if (Buffer.byteLength(response) > LIMIT) socket.end(JSON.stringify({ version: 1, ok: false, error: 'Response limit reached.' }) + '\n');
              else socket.end(response);
            }).catch(error => { if (!socket.destroyed) socket.end(JSON.stringify({ version: 1, ok: false, error: error.status===507||error.code==='ENOSPC'?'Insufficient storage or transfer quota. Free space and retry.':error.status===413?'File exceeds the host configured transfer limit.':'Operation denied or invitation no longer available.' }) + '\n'); });
          });
          socket.resume();
        })().catch(() => socket.destroy());
      });
      listener.maxConnections = 16;
      listener.on('connection', socket => {
        sockets.add(socket); let deadline = setTimeout(() => socket.destroy(), 8000);
        socket.once('large-file-verification',()=>{clearTimeout(deadline);deadline=setTimeout(()=>socket.destroy(),30*60*1000);});
        socket.on('error', () => {}); socket.once('close', () => { sockets.delete(socket); clearTimeout(deadline); });
      });
      listener.on('tlsClientError', () => {});
      listener.on('error', () => {});
      // No session cache or supplied sessions; tickets are invalidated on each explicit start.
      await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '0.0.0.0', () => { listener.removeListener('error', reject); resolve(); }); });
      server = listener; return state();
    }),
    async query(fingerprint, host, port, request) {
      if (runtimeBlocker()) throw Error(runtimeBlocker());
      if (!isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw Error('Enter an explicit peer IP address and port.');
      const peer = await store.remotePeer(fingerprint), identity = await store.remoteCredentials();
      const wire = JSON.stringify(request) + '\n';
      if (Buffer.byteLength(wire) > (request?.action?.startsWith?.('content-') ? LIMIT : (request?.action?.startsWith?.('contract-') || request?.action?.startsWith?.('environment-') || request?.action?.startsWith?.('inventory-')) ? 256 * 1024 : 16384)) throw Error('Request limit exceeded.');
      return new Promise((resolve, reject) => {
        let settled = false, verifying = false;
        const socket = tls.connect({ host, port, key: identity.key, cert: identity.certificate, ca: [peer.certificate], rejectUnauthorized: true, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', ALPNProtocols: [ALPN], checkServerIdentity: (_host, cert) => cert.fingerprint256 === fingerprint ? undefined : Error('Peer fingerprint mismatch.') });
        sockets.add(socket);
        const deadline = setTimeout(() => finish(Error('Secure connection timed out.')), request?.action==='content-complete'?30*60*1000:8000);
        const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(deadline); socket.destroy(); sockets.delete(socket); error ? reject(error) : resolve(result); };
        socket.once('error', () => finish(Error('Secure connection failed. Check mutual certificate trust, validity and the peer address.')));
        socket.once('close', () => { if (!verifying) finish(Error('Secure connection closed before a verified reply.')); });
        socket.once('secureConnect', () => {
          void (async () => {
            if (pin(socket) !== fingerprint) throw Error('Peer fingerprint mismatch.');
            await store.remotePeer(fingerprint); // recheck revocation before sending application data
            frame(socket, LIMIT, (error, response) => {
              if (error || response?.version !== 1 || response?.ok !== true) { finish(Error(['Insufficient storage or transfer quota. Free space and retry.','File exceeds the host configured transfer limit.'].includes(response?.error)?response.error:'Operation denied or invitation no longer available.')); return; }
              verifying = true;
              void store.remotePeer(fingerprint).then(() => finish(null, response.result)).catch(() => finish(Error('Peer trust was revoked.')));
            });
            if (!socket.destroyed) socket.write(wire);
          })().catch(error => finish(error));
        });
      });
    },
  };
}
