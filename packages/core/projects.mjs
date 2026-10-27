export const PROJECT_TYPES = Object.freeze(['Personal Project', 'College Project', 'Team Project', 'Future Idea', 'Startup / Client', 'Hackathon', 'Custom Space']);
export const PROJECT_STATUSES = Object.freeze(['Planned', 'Active', 'Paused', 'Completed']);
export const PROJECT_VERSION = 1;
export const isProjectId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function text(value, label, max, required = false) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || (required && !value.trim())) throw new Error(`${label} must be ${required ? '1–' : 'at most '}${max} characters.`);
  return value.trim();
}
export function validateProjectInput(value) {
  if (!object(value) || Object.keys(value).some(key => !['name', 'description', 'type', 'origin'].includes(key))) throw new Error('Invalid project details.');
  if (!PROJECT_TYPES.includes(value.type)) throw new Error('Choose one of the seven project types.');
  if (!['new', 'import'].includes(value.origin)) throw new Error('Choose Create New or Import Existing.');
  return { name: text(value.name, 'Name', 120, true), description: text(value.description ?? '', 'Description', 2000), type: value.type, origin: value.origin };
}
export function validateProject(value) {
  if (!object(value) || value.version !== PROJECT_VERSION || !isProjectId(value.id)) throw new Error('Unsupported or invalid project record.');
  validateProjectInput({ name: value.name, description: value.description, type: value.type, origin: value.origin });
  if (!PROJECT_STATUSES.includes(value.status) || typeof value.pinned !== 'boolean') throw new Error('Invalid project state.');
  for (const key of ['createdAt', 'updatedAt']) if (typeof value[key] !== 'string' || !Number.isFinite(Date.parse(value[key])) || new Date(value[key]).toISOString() !== value[key]) throw new Error('Invalid project timestamp.');
  if (value.updatedAt < value.createdAt) throw new Error('Invalid project chronology.');
  if (value.localRoot !== undefined && (typeof value.localRoot !== 'string' || !value.localRoot || value.localRoot.length > 32768 || value.localRoot.includes('\0'))) throw new Error('Invalid local folder.');
  if (value.origin === 'import' && !value.localRoot) throw new Error('Imported projects require a local folder.');
  if (!object(value.metadata) || JSON.stringify(value.metadata).length > 16384) throw new Error('Invalid project metadata.');
  return value;
}
export function validateProjectPatch(value) {
  if (!object(value) || !Object.keys(value).length || Object.keys(value).some(key => !['name', 'description', 'status', 'pinned'].includes(key))) throw new Error('Unsupported project change.');
  const patch = {};
  if ('name' in value) patch.name = text(value.name, 'Name', 120, true);
  if ('description' in value) patch.description = text(value.description, 'Description', 2000);
  if ('status' in value) { if (!PROJECT_STATUSES.includes(value.status)) throw new Error('Invalid project status.'); patch.status = value.status; }
  if ('pinned' in value) { if (typeof value.pinned !== 'boolean') throw new Error('Invalid pin state.'); patch.pinned = value.pinned; }
  return patch;
}
