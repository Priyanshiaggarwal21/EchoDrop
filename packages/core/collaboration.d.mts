export type Role = 'owner' | 'admin' | 'member' | 'guest';
export interface RecordBase { version: 1; id: string; createdAt: string; updatedAt: string; metadata: Record<string, import('./projects.mjs').JsonValue> }
export interface Principal extends RecordBase { displayName: string; kind: 'local' | 'record'; status: 'active' | 'archived' }
export interface Team extends RecordBase { displayName: string; status: 'active' | 'archived' }
export interface Context extends RecordBase { projectId: string; name: string; purpose: string; status: 'active' | 'archived' }
export interface Membership extends RecordBase { principalId: string; role: Role; status: 'active' | 'removed' }
export interface ProjectMembership extends Membership { projectId: string }
export interface TeamMembership extends Membership { teamId: string }
export interface ContextMembership extends Membership { contextId: string }
export interface Association extends RecordBase { projectId: string; teamId: string; status: 'active' | 'removed' }
export interface LocalParticipant { version: 1; id: string; principalId: string; createdAt: string; purpose: 'echodrop-local-participant'; seal: string }
export interface CollaborationData { localParticipant?: LocalParticipant; invitationDrafts?: Omit<InvitationDraft, 'recipientName'>[]; version: 1; localPrincipalId: string; principals: Principal[]; scopes: (RecordBase & { projectId: string; status: 'active' })[]; teams: Team[]; projectMembers: ProjectMembership[]; teamMembers: TeamMembership[]; contexts: Context[]; contextMembers: ContextMembership[]; associations: Association[] }
export interface Access { projectRole: Role | null; contextRole: Role | null; canRead: boolean; canContribute: boolean; canManage: boolean }
export interface MemberView extends Membership { displayName: string; kind: Principal['kind'] }
export interface TeamView extends Team { role: Role; members: MemberView[] }
export interface ContextView extends Context { access: Access; members: MemberView[] }
export interface InvitationDraft { version: 1; id: string; projectId: string; contextId?: string; recipientId: string; recipientName: string; issuerId: string; role: Role; status: 'prepared' | 'offered' | 'accepted' | 'declined' | 'expired' | 'revoked'; targetFingerprint?: string; projectLabel?: string; contextLabel?: string; createdAt: string; updatedAt: string; expiresAt: string | null }
export interface CollaborationSnapshot { localParticipant: { id: string; principalId: string; createdAt: string } | null; invitationDrafts: InvitationDraft[]; actor: Principal; projectId: string; role: Role; members: MemberView[]; teams: TeamView[]; availableTeams: Team[]; contexts: ContextView[]; directory: Principal[]; restrictedTeams: number }
export type CollaborationCommand =
  | { action: 'prepare-invitation-draft'; recipientId: string; role: Role; contextId?: string; expiresAt: string | null }
  | { action: 'revoke-invitation-draft'; invitationId: string }
  | { action: 'create-team'; displayName: string }
  | { action: 'associate-team' | 'unlink-team'; teamId: string }
  | { action: 'rename-team'; teamId: string; displayName: string }
  | { action: 'add-project-member'; principalId?: string; displayName?: string; role: Role }
  | { action: 'change-project-member'; principalId: string; role?: Role; remove?: boolean }
  | { action: 'add-team-member'; teamId: string; principalId?: string; displayName?: string; role: Role }
  | { action: 'change-team-member'; teamId: string; principalId: string; role?: Role; remove?: boolean }
  | { action: 'create-context'; name: string; purpose: string }
  | { action: 'edit-context'; contextId: string; name: string; purpose: string }
  | { action: 'add-context-member'; contextId: string; principalId: string; role: Role }
  | { action: 'change-context-member'; contextId: string; principalId: string; role?: Role; remove?: boolean };
export interface CollaborationBridge { snapshot(projectId: string): Promise<CollaborationSnapshot>; execute(projectId: string, command: CollaborationCommand): Promise<CollaborationSnapshot> }
export const ROLES: readonly Role[];
export function isManager(role: unknown): boolean;
export function cleanName(value: unknown, label?: string, max?: number, required?: boolean): string;
export function projectRole(data: CollaborationData, projectId: string, actorId: string): Role | null;
export function teamRole(data: CollaborationData, teamId: string, actorId: string): Role | null;
export function contextAccess(data: CollaborationData, projectId: string, contextId: string, actorId: string): Access;
export function validateCollaboration(data: unknown): CollaborationData;
