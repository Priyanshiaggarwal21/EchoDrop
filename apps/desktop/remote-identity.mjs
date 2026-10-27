import { X509Certificate, createPrivateKey } from 'node:crypto';

export const fingerprintPattern = /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/;
export function readCertificate(pem, checkTime = true) {
  if (typeof pem !== 'string' || pem.length > 16384 || (pem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1 || pem.includes('PRIVATE KEY')) throw Error('Choose one public PEM certificate.');
  const cert = new X509Certificate(pem);
  // Explicitly pinned, self-signed identity certificates; no public CA or name-based identity fallback.
  if (cert.subject !== cert.issuer || !cert.verify(cert.publicKey)) throw Error('A self-signed participant certificate is required.');
  const key = cert.publicKey;
  if (!(key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1') && !(key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails?.modulusLength >= 3072)) throw Error('Use P-256 or RSA 3072-bit or stronger certificates.');
  if (!cert.keyUsage?.includes('1.3.6.1.5.5.7.3.1') || !cert.keyUsage?.includes('1.3.6.1.5.5.7.3.2')) throw Error('Certificate must allow TLS server and client authentication.');
  if (checkTime && (Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now())) throw Error('Certificate is not currently valid.');
  return { certificate: cert.toString(), fingerprint: cert.fingerprint256, expiresAt: new Date(cert.validTo).toISOString(), cert };
}
export function checkKey(certificate, privateKey) {
  if (typeof privateKey !== 'string' || privateKey.length > 32768) throw Error('Invalid private key file.');
  const parsed = createPrivateKey(privateKey);
  if (!new X509Certificate(certificate).checkPrivateKey(parsed)) throw Error('The private key does not match this certificate.');
  return parsed.export({ type: 'pkcs8', format: 'pem' }).toString();
}
export function validateRemote(data) {
  if (data.remoteInvitees !== undefined) {
    if (!Array.isArray(data.remoteInvitees)) throw Error('Invalid invitee directory.');
    const entries = new Set();
    for (const entry of data.remoteInvitees) {
      const pair = `${entry?.projectId}:${entry?.principalId}`;
      if (!entry || entries.has(pair) || !data.scopes.some(scope => scope.projectId === entry.projectId) || !data.principals.some(person => person.id === entry.principalId && person.kind === 'record')) throw Error('Invalid scoped invitee.');
      entries.add(pair);
    }
  }
  if (data.remoteIdentity !== undefined) {
    const id = data.remoteIdentity;
    if (!id || id.version !== 1 || id.participantId !== data.localParticipant?.id || typeof id.sealedKey !== 'string' || id.sealedKey.length > 65536 || readCertificate(id.certificate, false).fingerprint !== id.fingerprint) throw Error('Invalid remote identity binding.');
  }
  if (data.remotePeers === undefined) return;
  if (!Array.isArray(data.remotePeers) || data.remotePeers.length > 100) throw Error('Invalid peer registry.');
  const pins = new Set(), people = new Set();
  for (const peer of data.remotePeers) {
    if (!peer || peer.version !== 1 || !['active', 'revoked'].includes(peer.status) || !data.principals.some(person => person.id === peer.principalId && person.kind === 'record') || pins.has(peer.fingerprint) || people.has(peer.principalId) || readCertificate(peer.certificate, false).fingerprint !== peer.fingerprint || peer.fingerprint === data.remoteIdentity?.fingerprint) throw Error('Invalid or duplicate peer binding.');
    for (const key of ['createdAt', 'updatedAt']) if (typeof peer[key] !== 'string' || new Date(peer[key]).toISOString() !== peer[key]) throw Error('Invalid peer timestamp.');
    pins.add(peer.fingerprint); people.add(peer.principalId);
  }
}
export function activePeer(data, fingerprint) {
  const peer = data.remotePeers?.find(peer => peer.fingerprint === fingerprint && peer.status === 'active');
  if (!peer || !data.principals.some(person => person.id === peer.principalId && person.status === 'active')) throw Error('Peer access denied.');
  readCertificate(peer.certificate);
  return peer;
}
export function openIdentity(data, protection) {
  const id = data.remoteIdentity;
  if (!id || !protection) throw Error('Import your TLS identity first.');
  const cert = readCertificate(id.certificate);
  const secret = JSON.parse(protection.open(id.sealedKey));
  if (secret.participantId !== data.localParticipant.id || secret.fingerprint !== cert.fingerprint) throw Error('Remote identity binding could not be verified.');
  return { ...cert, key: checkKey(cert.certificate, secret.key) };
}
