import { randomUUID } from 'node:crypto';
import { isProjectId } from './projects.mjs';
import { projectRole, contextAccess, isManager } from './collaboration.mjs';

export function canPrepare(data, projectId, actor, role, contextId) {
  const project = projectRole(data, projectId, actor);
  if (!isManager(project)) return false;
  if (role === 'owner' || role === 'admin') { if (project !== 'owner') return false; }
  if (contextId) {
    const access = contextAccess(data, projectId, contextId, actor);
    if (!access.canManage || ((role === 'owner' || role === 'admin') && access.contextRole !== 'owner')) return false;
  }
  return true;
}
export function validateDrafts(data) {
  if (data.invitationDrafts === undefined) return;
  if (!data.localParticipant || !Array.isArray(data.invitationDrafts)) throw new Error('Invalid invitation draft registry.');
  const ids = new Set(), pending = new Set();
  for (const draft of data.invitationDrafts) {
    if (!draft || draft.version !== 1 || !isProjectId(draft.id) || ids.has(draft.id) || !['prepared', 'offered', 'accepted', 'declined', 'expired', 'revoked'].includes(draft.status) || !['owner', 'admin', 'member', 'guest'].includes(draft.role)) throw new Error('Invalid invitation draft.');
    ids.add(draft.id);
    if (['offered', 'accepted', 'declined'].includes(draft.status) || draft.targetFingerprint !== undefined) {
      if (!data.remotePeers?.some(peer => peer.fingerprint === draft.targetFingerprint && peer.principalId === draft.recipientId) || !['member', 'guest'].includes(draft.role) || typeof draft.projectLabel !== 'string' || draft.projectLabel.length > 120 || (draft.contextId && (typeof draft.contextLabel !== 'string' || draft.contextLabel.length > 120))) throw new Error('Invalid remote invitation binding.');
    }
    const scope = `${draft.projectId}:${draft.contextId ?? ''}:${draft.recipientId}`;
    if (['prepared', 'offered'].includes(draft.status)) { if (pending.has(scope)) throw new Error('Duplicate pending invitation.'); pending.add(scope); }
    if (!data.scopes.some(scope => scope.projectId === draft.projectId) || !data.principals.some(person => person.id === draft.issuerId) || !data.principals.some(person => person.id === draft.recipientId) || draft.issuerId === draft.recipientId) throw new Error('Invalid invitation identities.');
    if (draft.contextId !== undefined && !data.contexts.some(context => context.id === draft.contextId && context.projectId === draft.projectId)) throw new Error('Invalid invitation scope.');
    for (const key of ['createdAt', 'updatedAt', ...(draft.expiresAt === null ? [] : ['expiresAt'])]) if (typeof draft[key] !== 'string' || !Number.isFinite(Date.parse(draft[key])) || new Date(draft[key]).toISOString() !== draft[key]) throw new Error('Invalid invitation timestamp.');
    if (draft.updatedAt < draft.createdAt || (draft.expiresAt !== null && draft.expiresAt <= draft.createdAt)) throw new Error('Invalid invitation expiry.');
  }
}
export function expireDrafts(data, now = Date.now()) {
  let changed = false;
  for (const draft of data.invitationDrafts ?? []) if (['prepared', 'offered'].includes(draft.status)) {
    if (draft.expiresAt && Date.parse(draft.expiresAt) <= now) { draft.status = 'expired'; changed = true; }
    else if (!canPrepare(data, draft.projectId, draft.issuerId, draft.role, draft.contextId) || (draft.contextId && (!projectRole(data, draft.projectId, draft.recipientId) || (isManager(draft.role) && !isManager(projectRole(data, draft.projectId, draft.recipientId)))))) { draft.status = 'revoked'; changed = true; }
    if (!['prepared', 'offered'].includes(draft.status)) draft.updatedAt = new Date(Math.max(now, Date.parse(draft.updatedAt))).toISOString();
  }
  return changed;
}
export function mutateDraft(data, projectId, actor, command, visiblePeople, now = Date.now()) {
  if (!data.localParticipant) throw new Error('An OS-protected local identity is required before preparing invitations.');
  data.invitationDrafts ??= [];
  if (command.action === 'revoke-invitation-draft') {
    const draft = data.invitationDrafts.find(item => item.id === command.invitationId && item.projectId === projectId);
    if (!draft || !canPrepare(data, projectId, actor, draft.role, draft.contextId)) throw new Error('Invitation access denied.');
    if (draft.status !== 'prepared') throw new Error('This invitation draft is already terminal. Create a new draft if needed.');
    draft.status = 'revoked'; draft.updatedAt = new Date(now).toISOString(); return;
  }
  if (!['owner', 'admin', 'member', 'guest'].includes(command.role) || !canPrepare(data, projectId, actor, command.role, command.contextId)) throw new Error('Invitation permission denied.');
  if (!isProjectId(command.recipientId) || command.recipientId === actor || !visiblePeople.some(person => person.id === command.recipientId && person.status === 'active' && person.kind === 'record')) throw new Error('Choose another visible roster record. Names and device sessions cannot establish participant identity.');
  if (command.contextId && !projectRole(data, projectId, command.recipientId)) throw new Error('Context drafts require existing project membership.');
  if (command.contextId && isManager(command.role) && !isManager(projectRole(data, projectId, command.recipientId))) throw new Error('Context administration requires project owner/admin permission.');
  if (command.expiresAt !== null && (typeof command.expiresAt !== 'string' || !Number.isFinite(Date.parse(command.expiresAt)) || new Date(command.expiresAt).toISOString() !== command.expiresAt || Date.parse(command.expiresAt) <= now)) throw new Error('Choose a future expiry or no expiry.');
  if (data.invitationDrafts.some(draft => draft.projectId === projectId && draft.contextId === command.contextId && draft.recipientId === command.recipientId && ['prepared', 'offered'].includes(draft.status))) throw new Error('A pending draft already exists for this person and scope. Revoke it before preparing another.');
  const timestamp = new Date(now).toISOString();
  data.invitationDrafts.push({ version: 1, id: randomUUID(), projectId, issuerId: actor, recipientId: command.recipientId, role: command.role, ...(command.contextId ? { contextId: command.contextId } : {}), status: 'prepared', createdAt: timestamp, updatedAt: timestamp, expiresAt: command.expiresAt });
}
