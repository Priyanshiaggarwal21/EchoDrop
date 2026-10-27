export interface ContentRecord { id: string; projectId: string; contextId?: string; senderId: string; recipientId: string; name: string; size: number; sha256: string; state: 'uploading'|'completed'|'failed'|'cancelled'; retainedBytes: number; nextIndex: number; chunkSize: number; createdAt: string; delivery?: 'Uploaded'|'Delivered'|'Applied'; archivedAt?: string }
export interface ContentProgress { phase: string; retained: number; size: number; name: string }
export function percentage(retained: number, size: number, complete?: boolean): number;
export function canResume(record: ContentRecord, principalId: string, role: string): boolean;
export function uploadContent(options: { file: File; id: string; recipientId: string; operate: (command: Record<string, unknown>, bytes?: ArrayBuffer) => Promise<ContentRecord>; confirm: (result: import('../../../packages/transfer/secret-scan.mjs').ScanResult) => Promise<boolean>; progress: (value: ContentProgress) => void; stopped: () => boolean; expected?: ContentRecord }): Promise<boolean>;
export function receiveContent(options: { record: ContentRecord; call: (action: string, value: Record<string, unknown>) => Promise<any>; stopped: () => boolean; progress: (value: ContentProgress) => void }): Promise<{ saved: boolean; folderName?: string; name?: string }>;

export function queueContent(options: {file: File; id: string; recipientId: string; target: any; call: (action:string,value:any)=>Promise<any>; confirm: (result: import('../../../packages/transfer/secret-scan.mjs').ScanResult)=>Promise<boolean>; progress: (value:ContentProgress)=>void; stopped:()=>boolean}):Promise<boolean>;

export function queueContentMany(options: Omit<Parameters<typeof queueContent>[0], 'id'|'recipientId'> & {recipientIds:string[]}):Promise<{id:string;recipientId:string;queued:boolean;error?:string}[]>;
