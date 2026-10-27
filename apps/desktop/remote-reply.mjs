import { isProjectId } from '../../packages/core/projects.mjs';
// A pinned peer is still an untrusted input source. Never return arbitrary shapes to the UI.
export function validateRemoteReply(result) {
  const validate = item => {
    if (!item || !isProjectId(item.id) || !isProjectId(item.projectId) || !['member', 'guest'].includes(item.role) || !['offered', 'accepted', 'declined', 'expired', 'revoked'].includes(item.status) || typeof item.projectName !== 'string' || item.projectName.length > 120 || (item.contextId !== undefined && (!isProjectId(item.contextId) || typeof item.contextName !== 'string' || item.contextName.length > 120)) || (item.expiresAt !== null && (typeof item.expiresAt !== 'string' || !Number.isFinite(Date.parse(item.expiresAt))))) throw Error('Peer returned an unsupported invitation record.');
    return { id: item.id, projectId: item.projectId, projectName: item.projectName, role: item.role, status: item.status, expiresAt: item.expiresAt, ...(item.contextId ? { contextId: item.contextId, contextName: item.contextName } : {}) };
  };
  if (Array.isArray(result)) { if (result.length > 1000) throw Error('Peer response limit exceeded.'); return result.map(validate); }
  return validate(result);
}
