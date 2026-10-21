export const SCAN_LIMIT: number;
export type ScanResult = { categories: string[]; limitations: string[]; needsConfirmation: boolean };
export function scanFile(file: File): Promise<ScanResult>;
export function withSharingCheck(file: File, confirm: (result: ScanResult) => Promise<boolean>, proceed: () => Promise<void>): Promise<boolean>;

export function scanProject(project: import('./project.mjs').Project): Promise<{ path: string; result: ScanResult }[]>;
