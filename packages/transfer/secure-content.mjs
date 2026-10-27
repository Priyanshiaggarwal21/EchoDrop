export const CONTENT_CHUNK = 1024 * 1024;
export const CONTENT_LIMIT = 64 * 1024 ** 3;
export const CONTENT_QUOTA = 32 * 1024 ** 3;
export const contentId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const contentHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export function safeContentName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\x00-\x1f\x7f<>:"/\\|?*]/.test(value) || /[. ]$/.test(value) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) || value === '.' || value === '..') throw Error('Use a filename without paths, reserved names or special characters.');
  return value;
}
export function validateContentMeta(meta) {
  if (!meta || !contentId(meta.id) || !contentId(meta.projectId) || (meta.contextId !== undefined && !contentId(meta.contextId)) || !contentId(meta.recipientId) || !contentHash(meta.sha256) || !Number.isSafeInteger(meta.size) || meta.size < 0 || meta.size > CONTENT_LIMIT) throw Error('Invalid shared content metadata.');
  safeContentName(meta.name); return meta;
}
export function validateContentView(item) {
  validateContentMeta(item);
  if (!contentId(item.senderId) || !['uploading','completed','failed','cancelled'].includes(item.state) || !Number.isSafeInteger(item.retainedBytes) || item.retainedBytes < 0 || item.retainedBytes > item.size || !Number.isInteger(item.nextIndex) || item.nextIndex < 0 || item.nextIndex > Math.ceil(item.size / CONTENT_CHUNK) || item.chunkSize !== CONTENT_CHUNK || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) throw Error('Invalid shared content status.');
  if (item.delivery !== undefined && !['Uploaded','Delivered','Applied'].includes(item.delivery)) throw Error('Invalid delivery acknowledgement.');
  if (item.archivedAt !== undefined && (typeof item.archivedAt !== 'string' || !Number.isFinite(Date.parse(item.archivedAt)) || item.state !== 'cancelled')) throw Error('Invalid archive status.');
  return { ...(item.archivedAt?{archivedAt:item.archivedAt}:{}), ...(item.delivery?{delivery:item.delivery}:item.state === 'completed'?{delivery:'Uploaded'}:{}), id: item.id, projectId: item.projectId, ...(item.contextId ? { contextId: item.contextId } : {}), senderId: item.senderId, recipientId: item.recipientId, name: item.name, size: item.size, sha256: item.sha256, state: item.state, retainedBytes: item.retainedBytes, nextIndex: item.nextIndex, chunkSize: CONTENT_CHUNK, createdAt: item.createdAt };
}
