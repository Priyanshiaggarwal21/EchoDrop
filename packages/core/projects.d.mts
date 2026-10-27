export type ProjectType = 'Personal Project' | 'College Project' | 'Team Project' | 'Future Idea' | 'Startup / Client' | 'Hackathon' | 'Custom Space';
export type ProjectStatus = 'Planned' | 'Active' | 'Paused' | 'Completed';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface ProjectInput { name: string; description: string; type: ProjectType; origin: 'new' | 'import' }
export interface Project extends ProjectInput { version: 1; id: string; status: ProjectStatus; createdAt: string; updatedAt: string; localRoot?: string; pinned: boolean; metadata: Record<string, JsonValue> }
export type ProjectPatch = Partial<Pick<Project, 'name' | 'description' | 'status' | 'pinned'>>;
export interface RegistrySnapshot { projects: Project[]; readOnly: boolean; warning: string }
export interface FolderSelection { token: string; label: string }
export interface ProjectRegistryBridge {
  list(): Promise<RegistrySnapshot>;
  selectFolder(): Promise<FolderSelection | null>;
  create(input: ProjectInput, folderToken?: string): Promise<Project>;
  update(id: string, patch: ProjectPatch): Promise<Project>;
  openFolder(id: string): Promise<void>;
}
export const PROJECT_TYPES: readonly ProjectType[];
export const PROJECT_STATUSES: readonly ProjectStatus[];
export const PROJECT_VERSION: 1;
export function isProjectId(value: unknown): value is string;
export function validateProjectInput(value: unknown): ProjectInput;
export function validateProject(value: unknown): Project;
export function validateProjectPatch(value: unknown): ProjectPatch;
