export type Area = 'Home' | 'Share' | 'Receive' | 'Workspace' | 'Connect' | 'Activity' | 'Settings' | 'Create Project' | 'Project';
export type ProjectSection = 'overview' | 'teams' | 'collaboration';
export interface Navigation { screen: Area | 'Welcome'; mode: 'files' | 'project'; depth: number; previous: string; projectId?: string; projectSection?: ProjectSection; contextId?: string }
export const PROJECT_SECTIONS: readonly ProjectSection[];
export const AREAS: readonly Area[];
export const ENTRY: Navigation;
export function readNavigation(state: unknown): Navigation;
export function planNavigation(current: Navigation, screen: Area, mode?: 'files' | 'project', projectId?: string, replace?: boolean, projectSection?: ProjectSection, contextId?: string): null | { delta: number } | { route: Navigation; replace: boolean };
