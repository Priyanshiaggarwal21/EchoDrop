import { isProjectId } from '../../../packages/core/projects.mjs';
export const AREAS = ['Home', 'Share', 'Receive', 'Workspace', 'Connect', 'Activity', 'Settings', 'Create Project', 'Project'];
export const ENTRY = Object.freeze({ screen: 'Welcome', mode: 'files', depth: 0, previous: '' });
export const PROJECT_SECTIONS = ['overview', 'teams', 'collaboration'];
export function readNavigation(state) {
  const value = state?.echoNavigation;
  return value && ['Welcome', ...AREAS].includes(value.screen) && ['files', 'project'].includes(value.mode)
    && Number.isSafeInteger(value.depth) && value.depth >= 0 && typeof value.previous === 'string'
    && (value.screen !== 'Project' || isProjectId(value.projectId))
    && (value.projectSection === undefined || (value.screen === 'Project' && PROJECT_SECTIONS.includes(value.projectSection)))
    && (value.contextId === undefined || (value.projectSection === 'collaboration' && isProjectId(value.contextId)))
    && (value.screen === 'Welcome' ? value.depth === 0 : value.depth > 0)
    ? value : ENTRY;
}
export function planNavigation(current, screen, mode = current.mode, projectId, replace = false, projectSection = 'overview', contextId) {
  if (!AREAS.includes(screen) || !['files', 'project'].includes(mode) || (screen === 'Project' && !isProjectId(projectId))) throw new Error('Invalid destination.');
  if (!PROJECT_SECTIONS.includes(projectSection) || (contextId !== undefined && (screen !== 'Project' || projectSection !== 'collaboration' || !isProjectId(contextId)))) throw new Error('Invalid project section.');
  if (current.screen === screen && current.mode === mode && current.projectId === projectId && (current.projectSection ?? 'overview') === projectSection && current.contextId === contextId) return null;
  if (screen === 'Home' && current.depth > 1) return { delta: 1 - current.depth };
  return { route: { screen, mode, depth: current.depth + (replace ? 0 : 1), previous: replace ? current.previous : current.screen, ...(screen === 'Project' ? { projectId, projectSection, ...(contextId ? { contextId } : {}) } : {}) }, replace };
}
