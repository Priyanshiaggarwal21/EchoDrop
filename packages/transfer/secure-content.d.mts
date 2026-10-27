export const CONTENT_CHUNK: number;
export const CONTENT_LIMIT: number;
export const CONTENT_QUOTA: number;
export function contentId(value: unknown): boolean;
export function contentHash(value: unknown): boolean;
export function safeContentName(value: unknown): string;
export function validateContentMeta(meta: unknown): any;
export function validateContentView(item: unknown): any;
