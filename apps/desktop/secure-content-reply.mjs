import { CONTENT_CHUNK, contentId, contentHash, validateContentView } from '../../packages/transfer/secure-content.mjs';
export function contentReply(request, value) {
  const scoped = item => {
    const view = validateContentView(item);
    if (view.projectId !== request.projectId || view.contextId !== request.contextId || (request.id && view.id !== request.id)) throw Error('Peer returned content for another scope.');
    return view;
  };
  if (request.action === 'content-info') {
    if (!value || !contentId(value.principalId) || !['member','guest'].includes(value.role) || !Array.isArray(value.recipients) || value.recipients.length > 101 || value.recipients.some(person => !contentId(person.id) || typeof person.displayName !== 'string' || person.displayName.length > 120)) throw Error('Invalid recipient directory.');
    return { principalId: value.principalId, role: value.role, recipients: value.recipients.map(person => ({ id: person.id, displayName: person.displayName })) };
  }
  if (request.action === 'content-list') { if (!Array.isArray(value) || value.length > 2000) throw Error('Invalid content history.'); return value.map(scoped); }
  if (request.action === 'content-read') {
    if (!value || value.id !== request.id || value.index !== request.index || !contentHash(value.sha256) || typeof value.data !== 'string' || value.data.length > Math.ceil(CONTENT_CHUNK / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) throw Error('Invalid received chunk.');
    return { id: value.id, index: value.index, sha256: value.sha256, data: value.data };
  }
  return scoped(value);
}
