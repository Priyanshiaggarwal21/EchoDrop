import { isProjectId } from './projects.mjs';

export const ROLES = Object.freeze(['owner', 'admin', 'member', 'guest']);
export const isManager = role => role === 'owner' || role === 'admin';
export function cleanName(value, label = 'Name', max = 120, required = true) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || (required && !value.trim())) throw new Error(`${label} must be ${required ? '1–' : 'at most '}${max} characters.`);
  return value.trim();
}
export function projectRole(data, projectId, actorId) {
  return data.projectMembers.find(member => member.projectId === projectId && member.principalId === actorId && member.status === 'active')?.role ?? null;
}
export function teamRole(data, teamId, actorId) {
  if (!data.teams.some(team => team.id === teamId && team.status === 'active')) return null;
  return data.teamMembers.find(member => member.teamId === teamId && member.principalId === actorId && member.status === 'active')?.role ?? null;
}
export function contextAccess(data, projectId, contextId, actorId) {
  const project = projectRole(data, projectId, actorId);
  const context = data.contexts.find(item => item.id === contextId && item.projectId === projectId && item.status === 'active');
  const role = context && data.contextMembers.find(member => member.contextId === contextId && member.principalId === actorId && member.status === 'active')?.role;
  return { projectRole: project, contextRole: role ?? null, canRead: Boolean(project && role), canContribute: Boolean(project && role && project !== 'guest' && role !== 'guest'), canManage: Boolean(isManager(project) && isManager(role)) };
}

// A corrupt authorization graph fails closed as a whole; never salvage grants in isolation.
export function validateCollaboration(data) {
  if (!data || data.version !== 1 || !isProjectId(data.localPrincipalId)) throw new Error('Unsupported collaboration registry.');
  const collections = ['principals', 'scopes', 'teams', 'projectMembers', 'teamMembers', 'contexts', 'contextMembers', 'associations'];
  for (const key of collections) {
    if (!Array.isArray(data[key])) throw new Error('Invalid collaboration collection.');
    const ids = new Set();
    for (const record of data[key]) {
      if (!record || record.version !== 1 || !isProjectId(record.id) || ids.has(record.id)) throw new Error('Invalid or duplicate collaboration record.');
      ids.add(record.id);
      for (const field of ['createdAt', 'updatedAt']) if (typeof record[field] !== 'string' || !Number.isFinite(Date.parse(record[field])) || new Date(record[field]).toISOString() !== record[field]) throw new Error('Invalid collaboration timestamp.');
      if (record.updatedAt < record.createdAt || !record.metadata || typeof record.metadata !== 'object' || Array.isArray(record.metadata) || JSON.stringify(record.metadata).length > 16384) throw new Error('Invalid collaboration metadata.');
      const membership = key.endsWith('Members') || key === 'associations';
      if (!(membership ? ['active', 'removed'] : ['active', 'archived']).includes(record.status)) throw new Error('Invalid lifecycle status.');
    }
  }
  const principals = new Map(data.principals.map(person => [person.id, person]));
  const local = principals.get(data.localPrincipalId);
  if (!local || local.kind !== 'local' || local.status !== 'active' || data.principals.filter(person => person.kind === 'local').length !== 1) throw new Error('Invalid local identity.');
  for (const person of data.principals) { cleanName(person.displayName); if (!['local', 'record'].includes(person.kind)) throw new Error('Invalid identity kind.'); }
  const projects = new Set();
  for (const scope of data.scopes) { if (!isProjectId(scope.projectId) || projects.has(scope.projectId) || scope.status !== 'active') throw new Error('Invalid project scope.'); projects.add(scope.projectId); }
  const teams = new Set(data.teams.map(team => team.id));
  for (const team of data.teams) cleanName(team.displayName);
  const contexts = new Map(data.contexts.map(context => [context.id, context]));
  for (const context of data.contexts) { if (!projects.has(context.projectId)) throw new Error('Orphaned context.'); cleanName(context.name); cleanName(context.purpose, 'Purpose', 1000, false); }
  for (const [key, scopeKey, validScopes] of [['projectMembers', 'projectId', projects], ['teamMembers', 'teamId', teams], ['contextMembers', 'contextId', contexts]]) {
    const pairs = new Set();
    for (const member of data[key]) {
      const pair = `${member[scopeKey]}:${member.principalId}`;
      if (!validScopes.has(member[scopeKey]) || !principals.has(member.principalId) || !ROLES.includes(member.role) || pairs.has(pair)) throw new Error('Invalid membership scope.');
      pairs.add(pair);
      if (member.status === 'active' && principals.get(member.principalId).status !== 'active') throw new Error('Inactive principal has a grant.');
      if (key === 'contextMembers' && member.status === 'active' && !projectRole(data, contexts.get(member.contextId).projectId, member.principalId)) throw new Error('Context grant requires active project membership.');
    }
  }
  const associations = new Set();
  for (const link of data.associations) {
    const pair = `${link.projectId}:${link.teamId}`;
    if (!projects.has(link.projectId) || !teams.has(link.teamId) || associations.has(pair)) throw new Error('Invalid team association.');
    associations.add(pair);
  }
  for (const projectId of projects) {
    if (projectRole(data, projectId, data.localPrincipalId) !== 'owner') throw new Error('Local administrator ownership is missing.');
  }
  for (const [entities, members, scopeKey] of [[data.scopes.map(scope => ({ id: scope.projectId, status: scope.status })), data.projectMembers, 'projectId'], [data.teams, data.teamMembers, 'teamId'], [data.contexts, data.contextMembers, 'contextId']]) {
    for (const entity of entities) if (entity.status === 'active' && !members.some(member => member[scopeKey] === entity.id && member.status === 'active' && member.role === 'owner')) throw new Error('An active scope must retain an owner.');
  }
  for (const context of data.contexts) if (context.status === 'active' && !data.contextMembers.some(member => member.contextId === context.id && member.status === 'active' && member.role === 'owner' && isManager(projectRole(data, context.projectId, member.principalId)))) throw new Error('An active context must retain an authorized owner.');
  return data;
}
