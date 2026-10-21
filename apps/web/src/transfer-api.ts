import { sha256File } from '../../../packages/transfer/browser-sha256.js';
export { sha256File };
export const LIMIT = 100_000_000;
export type Request = { path: string; method?: 'GET' | 'POST' | 'PUT'; headers?: Record<string, string>; bytes?: ArrayBuffer };
export type Reply = { status: number; text: string };
export type Transport = (request: Request) => Promise<Reply>;
export type Transfer = { id: string; state: 'uploading' | 'completed' | 'failed'; originalName: string; size: number; sha256: string; chunkSize: number; retainedBytes: number; nextIndex: number; download?: string };
export class TransferError extends Error { constructor(public status: number, message: string) { super(message); } }
export const browserTransport: Transport = async ({ path, method = 'GET', headers, bytes }) => {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: { ...headers, ...(method !== 'GET' ? { 'X-EchoDrop-Request': '1' } : {}) }, ...(bytes ? { body: bytes } : {}), signal: AbortSignal.timeout(120000) });
  return { status: response.status, text: await response.text() };
};
export async function request(api: Transport, value: Request): Promise<Transfer> {
  const response = await api(value);
  if (response.status < 200 || response.status >= 300) throw new TransferError(response.status, response.text || `Request failed (${response.status}).`);
  return JSON.parse(response.text);
}
export function fingerprint(file: File, hash: string) { return 'echodrop:transfer:' + hash + ':' + file.size + ':' + encodeURIComponent(file.name); }
export function bytes(value: number) { return value < 1000 ? `${value} B` : value < 1000000 ? `${(value / 1000).toFixed(1)} KB` : `${(value / 1000000).toFixed(2)} MB`; }

// getRandomValues works on HTTP LAN pages where randomUUID is unavailable.
export function newTransferId() {
  const value = crypto.getRandomValues(new Uint8Array(16));
  value[6] = (value[6]! & 15) | 64;
  value[8] = (value[8]! & 63) | 128;
  const hex = Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
