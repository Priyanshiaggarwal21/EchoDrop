import {guardianAuthority,guardianSourceRevision} from './guardian-authority.mjs';
import fs from 'node:fs/promises';
import { contentAuthority } from './content-authorization.mjs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isProjectId } from '../../packages/core/projects.mjs';
import { ROLES, isManager, cleanName, projectRole, teamRole, contextAccess, validateCollaboration } from '../../packages/core/collaboration.mjs';

import { validateRemote, openIdentity, activePeer } from './remote-identity.mjs';
import { reconcileRemote, remoteStatus, localRemoteOperation, remoteRequest } from './remote-collaboration.mjs';
import { bindLocalParticipant } from './participant-identity.mjs';
import { validateDrafts, expireDrafts, mutateDraft, canPrepare } from '../../packages/core/invitation-drafts.mjs';

const base = () => { const now = new Date().toISOString(); return { version: 1, id: randomUUID(), createdAt: now, updatedAt: now, metadata: {}, status: 'active' }; };
const touch = record => { record.updatedAt = new Date(Math.max(Date.now(), Date.parse(record.updatedAt))).toISOString(); };
function requireManager(role) { if (!isManager(role)) throw new Error('Owner or admin permission is required for this scope.'); }
function allowedRole(actorRole, role, previous) {
  if (!ROLES.includes(role)) throw new Error('Invalid membership role.');
  requireManager(actorRole);
  if (actorRole !== 'owner' && ([role, previous].some(value => value === 'owner' || value === 'admin'))) throw new Error('Only an owner can manage owner or admin roles.');
}
const commandFields = {
  'prepare-invitation-draft': ['recipientId', 'role', 'contextId', 'expiresAt'], 'revoke-invitation-draft': ['invitationId'],
  'create-team': ['displayName'], 'associate-team': ['teamId'], 'unlink-team': ['teamId'], 'rename-team': ['teamId', 'displayName'],
  'add-project-member': ['principalId', 'displayName', 'role'], 'change-project-member': ['principalId', 'role', 'remove'],
  'add-team-member': ['teamId', 'principalId', 'displayName', 'role'], 'change-team-member': ['teamId', 'principalId', 'role', 'remove'],
  'create-context': ['name', 'purpose'], 'edit-context': ['contextId', 'name', 'purpose'],
  'add-context-member': ['contextId', 'principalId', 'role'], 'change-context-member': ['contextId', 'principalId', 'role', 'remove'],
};
export function validateCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command) || !Object.hasOwn(commandFields, command.action) || Object.keys(command).some(key => key !== 'action' && !commandFields[command.action].includes(key))) throw new Error('Unsupported collaboration command.');
  for (const key of ['principalId', 'teamId', 'contextId', 'recipientId', 'invitationId']) if (key in command && !isProjectId(command[key])) throw new Error('Invalid scope or person ID.');
  if ('remove' in command && command.remove !== true) throw new Error('Invalid removal request.');
  if (command.remove && 'role' in command) throw new Error('Choose a role change or removal, not both.');
  return command;
}

export function createCollaborationStore(file, getProjects, io = fs, protection) {
  let queue = Promise.resolve();
  async function load() {
    let raw;
    try { if ((await io.stat(file)).size > 16 * 1024 * 1024) throw new Error('Registry is too large.'); raw = await io.readFile(file, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const actor = { ...base(), displayName: 'Local administrator', kind: 'local' };
      return { version: 1, localPrincipalId: actor.id, principals: [actor], scopes: [], teams: [], projectMembers: [], teamMembers: [], contexts: [], contextMembers: [], associations: [] };
    }
    try { const data = validateCollaboration(JSON.parse(raw)); validateDrafts(data); validateRemote(data); return data; }
    catch { throw new Error('Collaboration data is corrupt or uses an unsupported version. Access is blocked and the original file is preserved. Restore a valid copy before continuing.'); }
  }
  async function write(data) {
    validateCollaboration(data); validateDrafts(data); validateRemote(data);
    const serialized = JSON.stringify(data, null, 2);
    if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw new Error('Collaboration storage has reached its supported size.');
    await io.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await io.open(temp, 'wx', 0o600);
      try { await handle.writeFile(serialized, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      await io.rename(temp, file);
    } finally { await io.unlink(temp).catch(() => {}); }
  }
  function run(projectId, actorId, command) {
    const task = queue.then(async () => {
      if (!isProjectId(projectId)) throw new Error('Invalid project ID.');
      if (command) validateCommand(command);
      const registry = await getProjects();
      if (registry.readOnly) throw new Error('The project registry needs recovery before collaboration access can be changed.');
      if (!registry.projects.some(project => project.id === projectId)) throw new Error('Project not found.');
      const data = await load();
      const actor = actorId ?? data.localPrincipalId;
      let initialized = bindLocalParticipant(data, protection);
      initialized = expireDrafts(data) || initialized;
      initialized = reconcileRemote(data) || initialized;
      if (!data.scopes.some(scope => scope.projectId === projectId)) {
        if (actorId !== null) throw new Error('Project access denied.');
        // Additive enrollment of an existing local project, never re-grant removed members.
        data.scopes.push({ ...base(), projectId });
        data.projectMembers.push({ ...base(), projectId, principalId: actor, role: 'owner' }); initialized = true;
      }
      if (!projectRole(data, projectId, actor)) throw new Error('Project access denied. Device approval is not project membership.');
      if (command?.action === 'prepare-invitation-draft' || command?.action === 'revoke-invitation-draft') mutateDraft(data, projectId, actor, command, snapshot(data, projectId, actor).directory);
      else if (command) mutate(data, projectId, actor, command);
      initialized = expireDrafts(data) || initialized;
      initialized = reconcileRemote(data) || initialized;
      if (command || initialized) await write(data);
      return snapshot(data, projectId, actor);
    });
    queue = task.catch(() => {}); return task;
  }
  // Same serialization queue and atomic file as local membership. No remote operation can
  // select a local actor or invoke executeAs; TLS supplies the verified certificate pin.
  function secureTransaction(operation) {
    const task = queue.then(async () => {
      const registry = await getProjects();
      if (registry.readOnly) throw new Error('Project registry requires recovery.');
      const data = await load(); const before = JSON.stringify(data); bindLocalParticipant(data, protection);
      if (!data.localParticipant || !protection) throw new Error('Protected identity required.');
      expireDrafts(data); reconcileRemote(data);
      const result = await operation(data, registry.projects);
      expireDrafts(data); reconcileRemote(data);
      // Persist lifecycle reconciliation even on read; write is atomic with acceptance.
      if (JSON.stringify(data) !== before || operation.persist) await write(data);
      return result;
    });
    queue = task.catch(() => {}); return task;
  }
  return {
    withInventoryAuthority: (fingerprint, projectId, contextId, operation) => secureTransaction((data, projects) => {
      const a=guardianAuthority(data,projects,fingerprint,projectId,contextId);
      // Uses the existing accepted-invitation and current membership checks. Pairing alone grants nothing.
      const hostFingerprint=openIdentity(data,protection).fingerprint;
      const devices=(data.remotePeers??[]).filter(p=>data.projectMembers.some(m=>m.projectId===projectId&&m.principalId===p.principalId)&&(!contextId||data.contextMembers.some(m=>m.contextId===contextId&&m.principalId===p.principalId))).map(p=>{let eligible=false;try{eligible=contentAuthority(data,projects,p.fingerprint,projectId,contextId).canWrite;}catch{}return{fingerprint:p.fingerprint,principalId:p.principalId,eligible};}).sort((a,b)=>a.fingerprint.localeCompare(b.fingerprint));
      return operation({...a,authorityRevision:guardianSourceRevision(a),hostFingerprint,devices,role:contextId?contextAccess(data,projectId,contextId,a.principalId).contextRole:projectRole(data,projectId,a.principalId)});
    }),
    withGuardianAuthority: (fingerprint, projectId, contextId, operation) => secureTransaction((data, projects) => operation(guardianAuthority(data, projects, fingerprint, projectId, contextId))),
    withContentAuthority: (fingerprint, projectId, contextId, operation) => secureTransaction((data, projects) => operation(contentAuthority(data, projects, fingerprint, projectId, contextId))),
    remoteStatus: () => secureTransaction(data => remoteStatus(data)),
    remoteCredentials: () => secureTransaction(data => ({ ...openIdentity(data, protection), peers: (data.remotePeers ?? []).filter(peer => peer.status === 'active').map(peer => ({ certificate: peer.certificate, fingerprint: peer.fingerprint })) })),
    remotePeer: fingerprint => secureTransaction(data => ({ certificate: activePeer(data, fingerprint).certificate })),
    remoteLocal: (projectId, action, value) => secureTransaction((data, projects) => {
      if (!projects.some(project => project.id === projectId)) throw new Error('Project not found.');
      localRemoteOperation(data, projectId, action, value, protection, snapshot(data, projectId, data.localPrincipalId).directory, projects);
      return remoteStatus(data);
    }),
    remoteRequest: (fingerprint, request) => secureTransaction((data, projects) => remoteRequest(data, fingerprint, request, projects)),
    snapshot: projectId => run(projectId, null),
    execute: (projectId, command) => command ? run(projectId, null, command) : Promise.reject(new Error('A collaboration command is required.')),
    // Internal authorization entry points; deliberately absent from the preload/IPC API.
    snapshotAs: (projectId, actorId) => { if (!isProjectId(actorId)) return Promise.reject(new Error('Invalid actor.')); return run(projectId, actorId); },
    executeAs: (projectId, actorId, command) => { if (!isProjectId(actorId) || !command) return Promise.reject(new Error('Invalid actor or command.')); return run(projectId, actorId, command); },
  };
}

function snapshot(data, projectId, actor) {
  const memberView = member => { const person = data.principals.find(person => person.id === member.principalId); return { ...member, displayName: person.displayName, kind: person.kind }; };
  const members = data.projectMembers.filter(member => member.projectId === projectId).map(memberView);
  const associated = data.associations.filter(link => link.projectId === projectId && link.status === 'active');
  const teams = data.teams.filter(team => associated.some(link => link.teamId === team.id) && teamRole(data, team.id, actor)).map(team => ({ ...team, role: teamRole(data, team.id, actor), members: data.teamMembers.filter(member => member.teamId === team.id).map(memberView) }));
  const contexts = data.contexts.filter(context => context.projectId === projectId && contextAccess(data, projectId, context.id, actor).canRead).map(context => ({ ...context, access: contextAccess(data, projectId, context.id, actor), members: data.contextMembers.filter(member => member.contextId === context.id).map(memberView) }));
  const visiblePeople = new Set([actor, ...(data.remoteInvitees ?? []).filter(entry => entry.projectId === projectId).map(entry => entry.principalId), ...members.map(member => member.principalId), ...teams.flatMap(team => team.members.map(member => member.principalId)), ...contexts.flatMap(context => context.members.map(member => member.principalId))]);
  return { localParticipant: data.localParticipant ? { id: data.localParticipant.id, principalId: data.localParticipant.principalId, createdAt: data.localParticipant.createdAt } : null,
    invitationDrafts: (data.invitationDrafts ?? []).filter(draft => draft.projectId === projectId && canPrepare(data, projectId, actor, draft.role, draft.contextId)).map(draft => ({ ...draft, recipientName: data.principals.find(person => person.id === draft.recipientId).displayName })),
    actor: data.principals.find(person => person.id === actor), projectId, role: projectRole(data, projectId, actor), members, teams, contexts,
    availableTeams: isManager(projectRole(data, projectId, actor)) ? data.teams.filter(team => isManager(teamRole(data, team.id, actor)) && !associated.some(link => link.teamId === team.id)) : [],
    directory: data.principals.filter(person => visiblePeople.has(person.id)), restrictedTeams: associated.length - teams.length };
}
function mutate(data, projectId, actor, command) {
  const role = projectRole(data, projectId, actor);
  const requireTeam = () => {
    requireManager(role);
    if (!data.associations.some(link => link.projectId === projectId && link.teamId === command.teamId && link.status === 'active')) throw new Error('Team is not associated with this project.');
    const access = teamRole(data, command.teamId, actor); requireManager(access); return access;
  };
  const requireContext = () => {
    const access = contextAccess(data, projectId, command.contextId, actor);
    if (!access.canManage) throw new Error('Context access denied. Explicit context and project administration rights are required.');
    // The less privileged role wins across the two scopes.
    return role === 'owner' && access.contextRole === 'owner' ? 'owner' : 'admin';
  };
  const newPerson = () => {
    if (command.principalId) {
      if (command.displayName !== undefined) throw new Error('Choose an existing person or create a record.');
      const person = data.principals.find(person => person.id === command.principalId && person.status === 'active');
      const visible = snapshot(data, projectId, actor).directory.some(person => person.id === command.principalId);
      if (!person || !visible) throw new Error('Choose a person visible in this project or its associated teams.');
      return person.id;
    }
    const person = { ...base(), displayName: cleanName(command.displayName, 'Display name'), kind: 'record' };
    data.principals.push(person); return person.id;
  };
  function add(collection, scopeKey, scopeId, access, personId) {
    const previous = collection.find(member => member[scopeKey] === scopeId && member.principalId === personId);
    allowedRole(access, command.role, previous?.status === 'active' ? previous.role : undefined);
    if (previous?.status === 'active') throw new Error('This person already has active membership in this scope.');
    if (previous) { previous.role = command.role; previous.status = 'active'; touch(previous); }
    else collection.push({ ...base(), [scopeKey]: scopeId, principalId: personId, role: command.role });
  }
  function change(collection, scopeKey, scopeId, access) {
    const member = collection.find(member => member[scopeKey] === scopeId && member.principalId === command.principalId && member.status === 'active');
    if (!member) throw new Error('Active membership not found in this scope.');
    allowedRole(access, command.remove ? member.role : command.role, member.role);
    if (member.role === 'owner' && (command.remove || command.role !== 'owner') && collection.filter(item => item[scopeKey] === scopeId && item.status === 'active' && item.role === 'owner').length === 1) throw new Error('The final active owner cannot be removed or demoted.');
    if (member.principalId === data.localPrincipalId && (command.remove || command.role !== 'owner')) throw new Error('The local administrator must remain an owner until authenticated account recovery is available.');
    if (scopeKey === 'projectId' && (command.remove || !isManager(command.role))) {
      for (const grant of data.contextMembers.filter(item => item.principalId === member.principalId && item.status === 'active' && data.contexts.some(context => context.id === item.contextId && context.projectId === projectId))) {
        if (grant.role === 'owner' && data.contextMembers.filter(item => item.contextId === grant.contextId && item.status === 'active' && item.role === 'owner' && item.principalId !== member.principalId && isManager(projectRole(data, projectId, item.principalId))).length === 0) throw new Error('Assign another context owner before removing or demoting this project member.');
        if (command.remove) { grant.status = 'removed'; touch(grant); }
      }
    }
    if (command.remove) member.status = 'removed'; else member.role = command.role;
    touch(member);
  }
  switch (command.action) {
    case 'create-team': {
      requireManager(role);
      const team = { ...base(), displayName: cleanName(command.displayName, 'Team name') }; data.teams.push(team);
      data.teamMembers.push({ ...base(), teamId: team.id, principalId: actor, role: 'owner' });
      data.associations.push({ ...base(), projectId, teamId: team.id }); break;
    }
    case 'associate-team': {
      requireManager(role); requireManager(teamRole(data, command.teamId, actor));
      const link = data.associations.find(link => link.projectId === projectId && link.teamId === command.teamId);
      if (link) { if (link.status === 'active') throw new Error('Team is already associated.'); link.status = 'active'; touch(link); }
      else data.associations.push({ ...base(), projectId, teamId: command.teamId }); break;
    }
    case 'unlink-team': {
      requireManager(role);
      const link = data.associations.find(link => link.projectId === projectId && link.teamId === command.teamId && link.status === 'active');
      if (!link) throw new Error('Team association not found.'); link.status = 'removed'; touch(link); break;
    }
    case 'rename-team': { requireTeam(); const team = data.teams.find(team => team.id === command.teamId); team.displayName = cleanName(command.displayName, 'Team name'); touch(team); break; }
    case 'add-project-member': { requireManager(role); allowedRole(role, command.role); add(data.projectMembers, 'projectId', projectId, role, newPerson()); break; }
    case 'change-project-member': { change(data.projectMembers, 'projectId', projectId, role); break; }
    case 'add-team-member': { const access = requireTeam(); allowedRole(access, command.role); add(data.teamMembers, 'teamId', command.teamId, access, newPerson()); break; }
    case 'change-team-member': { change(data.teamMembers, 'teamId', command.teamId, requireTeam()); break; }
    case 'create-context': {
      requireManager(role);
      const context = { ...base(), projectId, name: cleanName(command.name, 'Context name'), purpose: cleanName(command.purpose, 'Purpose', 1000, false) }; data.contexts.push(context);
      data.contextMembers.push({ ...base(), contextId: context.id, principalId: actor, role: 'owner' }); break;
    }
    case 'edit-context': { requireContext(); const context = data.contexts.find(context => context.id === command.contextId); context.name = cleanName(command.name, 'Context name'); context.purpose = cleanName(command.purpose, 'Purpose', 1000, false); touch(context); break; }
    case 'add-context-member': {
      const access = requireContext();
      const target = projectRole(data, projectId, command.principalId);
      if (!target) throw new Error('Add this person to the project before granting context access.');
      if (isManager(command.role) && !isManager(target)) throw new Error('Context owners/admins also need project owner/admin permission.');
      add(data.contextMembers, 'contextId', command.contextId, access, command.principalId); break;
    }
    case 'change-context-member': {
      const access = requireContext();
      if (!command.remove && isManager(command.role) && !isManager(projectRole(data, projectId, command.principalId))) throw new Error('Context owners/admins also need project owner/admin permission.');
      change(data.contextMembers, 'contextId', command.contextId, access); break;
    }
  }
}
