import { randomUUID } from 'node:crypto';
import { isProjectId } from '../../packages/core/projects.mjs';

// OS-account protection, not a remote login, signature scheme or proof of human identity.
export function osIdentityProtection(safeStorage, platform = process.platform) {
  function available() {
    if (!safeStorage?.isEncryptionAvailable() || (platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')) throw new Error('OS-protected identity storage is unavailable. Collaboration access is blocked; no plaintext fallback is used.');
  }
  return {
    seal(value) { available(); return safeStorage.encryptString(value).toString('base64'); },
    open(value) { available(); return safeStorage.decryptString(Buffer.from(value, 'base64')); },
  };
}
export function bindLocalParticipant(data, protection) {
  if (!protection) { if (data.localParticipant) throw new Error('Protected identity provider is required.'); return false; }
  if (data.localParticipant === undefined) {
    const identity = { version: 1, id: randomUUID(), principalId: data.localPrincipalId, createdAt: new Date().toISOString(), purpose: 'echodrop-local-participant' };
    data.localParticipant = { ...identity, seal: protection.seal(JSON.stringify(identity)) };
    return true;
  }
  const identity = data.localParticipant;
  try {
    if (identity.version !== 1 || !isProjectId(identity.id) || identity.principalId !== data.localPrincipalId || identity.purpose !== 'echodrop-local-participant' || new Date(identity.createdAt).toISOString() !== identity.createdAt || typeof identity.seal !== 'string' || identity.seal.length > 32768) throw new Error();
    const opened = JSON.parse(protection.open(identity.seal));
    for (const key of ['version', 'id', 'principalId', 'createdAt', 'purpose']) if (opened[key] !== identity[key]) throw new Error();
  } catch { throw new Error('The local participant identity could not be verified for this OS account. The registry is unchanged. Restore its original protected binding; automatic relinking is disabled.'); }
  return false;
}
