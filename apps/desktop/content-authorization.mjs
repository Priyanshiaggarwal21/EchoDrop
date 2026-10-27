import { isProjectId } from '../../packages/core/projects.mjs';
import { contextAccess, projectRole } from '../../packages/core/collaboration.mjs';
import { activePeer } from './remote-identity.mjs';

// Called under the collaboration transaction lock for every content operation.
export function contentAuthority(data, projects, fingerprint, projectId, contextId) {
  if (!isProjectId(projectId) || (contextId !== undefined && !isProjectId(contextId)) || !projects.some(project => project.id === projectId)) throw Error('Content scope access denied.');
  const local = fingerprint === null;
  const principalId = local ? data.localPrincipalId : activePeer(data, fingerprint).principalId;
  const project = projectRole(data, projectId, principalId);
  const context = contextId ? contextAccess(data, projectId, contextId, principalId) : null;
  if (!project || (context && !context.canRead)) throw Error('Content scope access denied.');
  let role = project === 'guest' || context?.contextRole === 'guest' ? 'guest' : 'member';
  if (!local) {
    const accepted = id => data.invitationDrafts?.find(item => item.projectId === projectId && item.contextId === id && item.recipientId === principalId && item.targetFingerprint === fingerprint && item.status === 'accepted');
    const projectGrant = accepted(undefined), contextGrant = contextId ? accepted(contextId) : null;
    if (!projectGrant || (contextId && !contextGrant)) throw Error('Accepted scope invitation required.');
    if (projectGrant.role === 'guest' || contextGrant?.role === 'guest') role = 'guest';
  }
  const recipients = [{ id: data.localPrincipalId, displayName: 'Host administrator' }];
  // The directory intentionally discloses only eligible recipients within this scope.
  for (const peer of data.remotePeers ?? []) {
    if (peer.status !== 'active' || peer.principalId === principalId) continue;
    try {
      activePeer(data, peer.fingerprint);
      const grants = data.invitationDrafts ?? [];
      if (!grants.some(item => item.projectId === projectId && !item.contextId && item.recipientId === peer.principalId && item.targetFingerprint === peer.fingerprint && item.status === 'accepted')) continue;
      if (!projectRole(data, projectId, peer.principalId)) continue;
      if (contextId && (!contextAccess(data, projectId, contextId, peer.principalId).canRead || !grants.some(item => item.projectId === projectId && item.contextId === contextId && item.recipientId === peer.principalId && item.targetFingerprint === peer.fingerprint && item.status === 'accepted'))) continue;
      recipients.push({ id: peer.principalId, displayName: data.principals.find(person => person.id === peer.principalId).displayName });
    } catch { /* Revoked/expired identities never appear as eligible recipients. */ }
  }
  // Approval validity follows current write permission, not device approval or roster presence.
  const writers = [principalId, ...recipients.map(person => person.id)].filter(id => {
    if (id === principalId) return role !== 'guest';
    if (!projectRole(data, projectId, id) || projectRole(data, projectId, id) === 'guest' || (contextId && !contextAccess(data, projectId, contextId, id).canContribute)) return false;
    if (id === data.localPrincipalId) return true;
    const peer = data.remotePeers.find(item => item.principalId === id && item.status === 'active');
    const grants = data.invitationDrafts ?? [];
    return peer && grants.some(g => g.projectId === projectId && !g.contextId && g.recipientId === id && g.targetFingerprint === peer.fingerprint && g.status === 'accepted' && g.role !== 'guest') && (!contextId || grants.some(g => g.projectId === projectId && g.contextId === contextId && g.recipientId === id && g.targetFingerprint === peer.fingerprint && g.status === 'accepted' && g.role !== 'guest'));
  });
  return { principalId, writers, displayName: data.principals.find(person => person.id === principalId)?.displayName ?? 'Participant', local, canWrite: role !== 'guest', role, recipients: recipients.filter(person => person.id !== principalId) };
}
