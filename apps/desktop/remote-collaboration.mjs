import { randomUUID } from 'node:crypto';
import { isProjectId } from '../../packages/core/projects.mjs';
import { projectRole, contextAccess, isManager, cleanName } from '../../packages/core/collaboration.mjs';
import { canPrepare } from '../../packages/core/invitation-drafts.mjs';
import { activePeer, readCertificate, checkKey, openIdentity } from './remote-identity.mjs';

function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw Error('Unsupported remote operation.');
}
const currentProject = (data, id, principal) => (data.invitationDrafts ?? []).find(item => item.projectId === id && !item.contextId && item.recipientId === principal && item.status === 'accepted');
export function reconcileRemote(data) {
  let changed = false;
  for (const draft of data.invitationDrafts ?? []) {
    if (!['offered', 'accepted'].includes(draft.status)) continue;
    const peer = data.remotePeers?.find(peer => peer.fingerprint === draft.targetFingerprint && peer.principalId === draft.recipientId && peer.status === 'active');
    let valid = Boolean(peer && data.principals.some(person => person.id === peer.principalId && person.status === 'active'));
    if (valid) { try { readCertificate(peer.certificate); } catch { valid = false; } }
    if (draft.status === 'offered') valid &&= canPrepare(data, draft.projectId, draft.issuerId, draft.role, draft.contextId);
    if (draft.status === 'accepted') valid &&= Boolean(projectRole(data, draft.projectId, draft.recipientId)) && (!draft.contextId || contextAccess(data, draft.projectId, draft.contextId, draft.recipientId).canRead);
    if (draft.contextId) valid &&= Boolean(currentProject(data, draft.projectId, draft.recipientId));
    if (!valid) { draft.status = 'revoked'; draft.updatedAt = new Date().toISOString(); changed = true; }
  }
  return changed;
}
export function remoteStatus(data) {
  const identity = data.remoteIdentity;
  return { identity: identity ? { fingerprint: identity.fingerprint, certificate: identity.certificate, expiresAt: readCertificate(identity.certificate, false).expiresAt } : null,
    peers: (data.remotePeers ?? []).map(peer => ({ principalId: peer.principalId, fingerprint: peer.fingerprint, status: peer.status, displayName: data.principals.find(person => person.id === peer.principalId).displayName, expiresAt: readCertificate(peer.certificate, false).expiresAt })) };
}
export function localRemoteOperation(data, projectId, action, value, protection, visiblePeople, projects) {
  if (!isManager(projectRole(data, projectId, data.localPrincipalId))) throw Error('Project administration required.');
  if (!data.localParticipant || !protection) throw Error('OS-protected participant identity is required.');
  const now = new Date().toISOString();
  if (action === 'create-invitee') {
    exact(value, ['displayName']);
    const person = { version: 1, id: randomUUID(), displayName: cleanName(value.displayName), kind: 'record', status: 'active', createdAt: now, updatedAt: now, metadata: {} };
    data.principals.push(person); data.remoteInvitees ??= []; data.remoteInvitees.push({ projectId, principalId: person.id });
  } else if (action === 'import-identity') {
    exact(value, ['certificate', 'key']);
    if (data.remoteIdentity) throw Error('Identity replacement is disabled. Key rotation requires a separate recovery flow.');
    const cert = readCertificate(value.certificate), key = checkKey(cert.certificate, value.key);
    if (data.remotePeers?.some(peer => peer.fingerprint === cert.fingerprint)) throw Error('This certificate is already a peer identity.');
    data.remoteIdentity = { version: 1, participantId: data.localParticipant.id, certificate: cert.certificate, fingerprint: cert.fingerprint, sealedKey: protection.seal(JSON.stringify({ participantId: data.localParticipant.id, fingerprint: cert.fingerprint, key })) };
  } else if (action === 'trust-peer') {
    exact(value, ['certificate', 'fingerprint', 'principalId']); openIdentity(data, protection);
    const cert = readCertificate(value.certificate);
    if (value.fingerprint !== cert.fingerprint) throw Error('The independently verified fingerprint does not match.');
    if (!visiblePeople.some(person => person.id === value.principalId && person.kind === 'record' && person.status === 'active')) throw Error('Choose a visible local roster record.');
    data.remotePeers ??= [];
    if (data.remotePeers.length >= 100 || data.remotePeers.some(peer => peer.fingerprint === cert.fingerprint || peer.principalId === value.principalId) || cert.fingerprint === data.remoteIdentity.fingerprint) throw Error('Identity already bound, revoked, or peer limit reached. Automatic relinking is disabled.');
    data.remotePeers.push({ version: 1, certificate: cert.certificate, fingerprint: cert.fingerprint, principalId: value.principalId, status: 'active', createdAt: now, updatedAt: now });
  } else if (action === 'revoke-peer') {
    exact(value, ['fingerprint']);
    const peer = data.remotePeers?.find(item => item.fingerprint === value.fingerprint && item.status === 'active');
    if (!peer) throw Error('Active peer not found.');
    peer.status = 'revoked'; peer.updatedAt = now;
  } else if (action === 'offer' || action === 'revoke') {
    exact(value, ['invitationId']);
    const draft = data.invitationDrafts?.find(item => item.id === value.invitationId && item.projectId === projectId);
    if (!draft || !canPrepare(data, projectId, data.localPrincipalId, draft.role, draft.contextId)) throw Error('Invitation access denied.');
    if (action === 'revoke') {
      if (!['offered', 'accepted'].includes(draft.status)) throw Error('Invitation is already terminal.');
      draft.status = 'revoked'; draft.updatedAt = now; return;
    }
    openIdentity(data, protection);
    if (draft.status !== 'prepared' || !['member', 'guest'].includes(draft.role)) throw Error('Only prepared member/guest invitations can be delivered. Remote administration is not enabled.');
    const peer = data.remotePeers?.find(peer => peer.principalId === draft.recipientId && peer.status === 'active');
    if (!peer) throw Error('Verify and bind the recipient certificate first.'); activePeer(data, peer.fingerprint);
    if (isManager(projectRole(data, projectId, draft.recipientId))) throw Error('Use a member/guest roster record for remote invitations; existing owners/admins are protected.');
    if (draft.contextId && !currentProject(data, projectId, draft.recipientId)) throw Error('Recipient must accept a project invitation before a context invitation.');
    if (data.invitationDrafts.some(item => item.id !== draft.id && item.projectId === projectId && item.contextId === draft.contextId && item.recipientId === draft.recipientId && ['offered', 'accepted'].includes(item.status))) throw Error('An active remote invitation already exists for this scope.');
    draft.projectLabel = projects.find(project => project.id === projectId).name;
    if (draft.contextId) draft.contextLabel = data.contexts.find(context => context.id === draft.contextId).name;
    draft.status = 'offered'; draft.targetFingerprint = peer.fingerprint; draft.updatedAt = now;
  } else throw Error('Unsupported remote operation.');
}
export function remoteRequest(data, fingerprint, request, projects) {
  exact(request, ['version', 'action', 'invitationId']);
  if (request.version !== 1 || !['inbox', 'accept', 'decline', 'access'].includes(request.action)) throw Error('Unsupported remote operation.');
  const peer = activePeer(data, fingerprint);
  const own = (data.invitationDrafts ?? []).filter(item => item.targetFingerprint === fingerprint && item.recipientId === peer.principalId && projects.some(project => project.id === item.projectId));
  const publicView = item => ({ id: item.id, projectId: item.projectId, projectName: item.projectLabel, ...(item.contextId ? { contextId: item.contextId, contextName: item.contextLabel } : {}), role: item.role, status: item.status, expiresAt: item.expiresAt });
  if (request.action === 'inbox' || request.action === 'access') {
    if (request.invitationId !== undefined) throw Error('Unsupported remote operation.');
    return own.filter(item => request.action === 'inbox' || (item.status === 'accepted' && projectRole(data, item.projectId, peer.principalId) && (!item.contextId || contextAccess(data, item.projectId, item.contextId, peer.principalId).canRead))).map(item => {
      const view = publicView(item);
      if (request.action === 'access') view.role = item.role === 'guest' || currentProject(data, item.projectId, peer.principalId)?.role === 'guest' || projectRole(data, item.projectId, peer.principalId) === 'guest' || (item.contextId && contextAccess(data, item.projectId, item.contextId, peer.principalId).contextRole === 'guest') ? 'guest' : 'member';
      return view;
    });
  }
  if (!isProjectId(request.invitationId)) throw Error('Invitation access denied.');
  const draft = own.find(item => item.id === request.invitationId);
  if (!draft) throw Error('Invitation access denied.');
  // Lost replies are safe to retry, but can never restore a revoked or removed grant.
  const terminal = request.action === 'accept' ? 'accepted' : 'declined';
  if (draft.status === terminal) return publicView(draft);
  if (draft.status !== 'offered' || !canPrepare(data, draft.projectId, draft.issuerId, draft.role, draft.contextId)) throw Error('Invitation is no longer available.');
  if (request.action === 'accept') {
    if (draft.contextId && !currentProject(data, draft.projectId, peer.principalId)) throw Error('Accept the project invitation first.');
    const collection = draft.contextId ? data.contextMembers : data.projectMembers;
    const scopeKey = draft.contextId ? 'contextId' : 'projectId', scopeId = draft.contextId ?? draft.projectId;
    let member = collection.find(item => item[scopeKey] === scopeId && item.principalId === peer.principalId);
    if (member?.status === 'active' && isManager(member.role)) throw Error('Existing ownership/administration cannot be changed by remote acceptance.');
    const now = new Date().toISOString();
    if (member) { member.role = draft.role; member.status = 'active'; member.updatedAt = now; }
    else { member = { version: 1, id: randomUUID(), [scopeKey]: scopeId, principalId: peer.principalId, role: draft.role, status: 'active', createdAt: now, updatedAt: now, metadata: {} }; collection.push(member); }
  }
  draft.status = terminal; draft.updatedAt = new Date().toISOString();
  return publicView(draft);
}
