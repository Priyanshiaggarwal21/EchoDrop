import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { CONTENT_CHUNK, CONTENT_QUOTA, contentId, validateContentMeta, validateContentView } from '../../packages/transfer/secure-content.mjs';
const { createTransferStore } = createRequire(import.meta.url)('../../packages/transfer/index.cjs');
const fields = { 'content-archive': ['id'], 'content-receipt': ['id','delivery','sha256'], 'content-info': [], 'content-list': [], 'content-create': ['id','name','size','sha256','recipientId'], 'content-status': ['id'], 'content-chunk': ['id','index','data'], 'content-complete': ['id'], 'content-read': ['id','index'], 'content-cancel': ['id'] };
const absent = error => { if (error.code !== 'ENOENT') throw error; return null; };
export async function regularFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('Unsafe content storage entry.');
  return stat;
}
export async function writeAtomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(temp, file); } finally { await fs.unlink(temp).catch(absent); }
}
export function createSecureContentStore(directory, collaboration, options = {}) {
  const {transferPolicy}=createRequire(import.meta.url)('../../packages/transfer/limits.cjs'),policy=transferPolicy(options);
  const root = path.resolve(directory), objects = path.join(root, 'objects'), indexFile = path.join(root, 'index.json');
  const engine = createTransferStore(objects,policy);
  async function guard(id) {
    for (const folder of [root, objects, path.join(objects, '.transfers'), ...(id ? [path.join(objects, '.transfers', id)] : [])]) {
      const stat = await fs.lstat(folder).catch(absent);
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw Error('Unsafe content storage directory.');
    }
    if (id) {
      for (const file of [path.join(objects, `${id}.bin`), path.join(objects, `${id}.bin.json`)]) if (await fs.lstat(file).catch(absent)) await regularFile(file);
      const folder = path.join(objects, '.transfers', id);
      for (const name of await fs.readdir(folder).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) await regularFile(path.join(folder, name));
    }
  }
  async function load() {
    await guard();
    const stat = await fs.lstat(indexFile).catch(absent);
    if (!stat) return { version: 1, records: [] };
    await regularFile(indexFile);
    if (stat.size > 2 * 1024 * 1024) throw Error('Content history is too large.');
    try {
      const data = JSON.parse(await fs.readFile(indexFile, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.records) || data.records.length > 2000) throw Error();
      const ids = new Set();
      for (const item of data.records) {
        validateContentMeta(item);
        if ((item.archivedAt!==undefined&&(!Number.isFinite(Date.parse(item.archivedAt))||item.status!=='cancelled')) || item.version !== 1 || (item.delivery !== undefined && !['Delivered','Applied'].includes(item.delivery)) || ids.has(item.id) || !contentId(item.senderId) || !['active','cancelled'].includes(item.status) || typeof item.purged !== 'boolean' || (item.purged && item.status !== 'cancelled') || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) throw Error();
        ids.add(item.id);
      }
      return data;
    } catch { throw Error('Content history is corrupt. Access is blocked; original data is preserved.'); }
  }
  async function save(data) { await fs.mkdir(objects, { recursive: true }); await writeAtomic(indexFile, data); }
  const visible = (record, auth) => auth.local || record.senderId === auth.principalId || record.recipientId === auth.principalId;
  const sameScope = (record, request) => record.projectId === request.projectId && record.contextId === request.contextId;
  async function view(record) {
    await guard(record.id);
    let state;
    if (record.status === 'cancelled') state = { state: 'cancelled', retainedBytes: 0, nextIndex: 0 };
    else {
      try { state = await engine.status(record.id); }
      catch (error) { if (error.status !== 404) throw error; state = { state: 'uploading', retainedBytes: 0, nextIndex: 0 }; }
    }
    return validateContentView({ ...record, ...state, chunkSize: CONTENT_CHUNK, name: record.name });
  }
  async function purge(record) {
    await guard(record.id);
    const folder = path.join(objects, '.transfers', record.id);
    for (const name of await fs.readdir(folder).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
      if (!/^(?:state\.json(?:\.tmp)?|assembled\.part|\d+\.chunk(?:\.part)?)$/.test(name)) throw Error('Unexpected content file; cleanup stopped.');
      await fs.unlink(path.join(folder, name));
    }
    await fs.rmdir(folder).catch(absent);
    await fs.unlink(path.join(objects, `${record.id}.bin`)).catch(absent);
    await fs.unlink(path.join(objects, `${record.id}.bin.json`)).catch(absent);
  }
  async function handle(fingerprint, request) {
    if (!request || request.version !== 1 || !Object.hasOwn(fields, request.action) || Object.keys(request).some(key => !['version','action','projectId','contextId', ...fields[request.action]].includes(key))) throw Error('Unsupported content operation.');
    if ('id' in request && !contentId(request.id)) throw Error('Invalid content ID.');
    return collaboration.withContentAuthority(fingerprint, request.projectId, request.contextId, async auth => {
      if (request.action === 'content-info') return { principalId: auth.principalId, role: auth.role, recipients: auth.recipients };
      const data = await load();
      if (request.action === 'content-list') return Promise.all(data.records.filter(item => sameScope(item, request) && visible(item, auth)).map(view));
      let record = data.records.find(item => item.id === request.id);
      if (request.action === 'content-create') {
        if (!auth.canWrite || !auth.recipients.some(person => person.id === request.recipientId)) throw Error('Upload permission or recipient access denied.');
        validateContentMeta(request);
        if(request.size>policy.maxFileBytes)throw Object.assign(Error(`File exceeds this host's configured ${policy.maxFileBytes}-byte limit.`),{status:413});
        if (record && (!sameScope(record, request) || record.senderId !== auth.principalId || record.recipientId !== request.recipientId || record.name !== request.name || record.sha256 !== request.sha256 || record.size !== request.size)) throw Error('Transfer ID is already bound to different content.');
        if (!record) {
          if (data.records.length >= 2000) throw Error('Secure content history limit reached (2,000 records). Payload archival preserves replay-protection history; contact support before creating more transfers.');
          if (data.records.filter(item => !item.purged).reduce((sum, item) => sum + item.size, 0) + request.size > policy.quotaBytes) throw Error('Secure content capacity reached. Cancel or withdraw old transfers to free storage.');
          record = { version: 1, id: request.id, projectId: request.projectId, ...(request.contextId ? { contextId: request.contextId } : {}), senderId: auth.principalId, recipientId: request.recipientId, name: request.name, size: request.size, sha256: request.sha256, status: 'active', purged: false, createdAt: new Date().toISOString() };
          data.records.push(record); await save(data); // Durable ACL before any file bytes.
        }
        if (record.status === 'cancelled') throw Error('This transfer was cancelled. Start a new transfer.');
        await guard(record.id); await engine.create(record.name, record.size, record.sha256, record.id);
        return view(record);
      }
      if (!record || !sameScope(record, request) || !visible(record, auth)) throw Error('Content access denied.');
      if (request.action === 'content-status') return view(record);
      if(request.action==='content-archive'){
        if(!auth.local&&record.senderId!==auth.principalId)throw Error('Only the sender or host may archive.');
        if(record.status!=='cancelled'&&record.delivery!=='Applied')throw Error('Only cancelled or explicitly saved deliveries may be archived.');
        record.archivedAt??=new Date().toISOString();record.status='cancelled';await save(data);await purge(record);record.purged=true;await save(data);return view(record);
      }
      if (request.action === 'content-cancel') {
        if (!auth.local && record.senderId !== auth.principalId) throw Error('Only the sender or host can cancel content.');
        record.status = 'cancelled'; await save(data); // Tombstone first: interrupted cleanup never restores access.
        await purge(record); record.purged = true; await save(data); return view(record);
      }
      if (record.status !== 'active') throw Error('This content is no longer available.');
      await guard(record.id);
      if (request.action === 'content-receipt') {
        if (auth.principalId !== record.recipientId || !['Delivered','Applied'].includes(request.delivery) || request.sha256 !== record.sha256 || (await view(record)).state !== 'completed') throw Error('Recipient acknowledgement denied.');
        if (record.delivery !== 'Applied') record.delivery = request.delivery;
        await save(data); return view(record);
      }
      if (request.action === 'content-read') {
        const state = await view(record);
        if (state.state !== 'completed' || !Number.isInteger(request.index) || request.index < 0 || request.index >= Math.ceil(record.size / CONTENT_CHUNK)) throw Error('Verified content chunk unavailable.');
        const file = await fs.open(path.join(objects, `${record.id}.bin`), 'r');
        try {
          const stat = await file.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size !== record.size) throw Error('Content file changed.');
          const length = Math.min(CONTENT_CHUNK, record.size - request.index * CONTENT_CHUNK), buffer = Buffer.alloc(length);
          const { bytesRead } = await file.read(buffer, 0, length, request.index * CONTENT_CHUNK);
          if (bytesRead !== length) throw Error('Content file is incomplete.');
          return { id: record.id, index: request.index, data: buffer.toString('base64'), sha256: createHash('sha256').update(buffer).digest('hex') };
        } finally { await file.close(); }
      }
      if (!auth.canWrite || record.senderId !== auth.principalId) throw Error('Only the authorized sender can upload this content.');
      if (!auth.recipients.some(person => person.id === record.recipientId)) throw Error('Recipient no longer has scope access.');
      if (request.action === 'content-chunk') {
        if (typeof request.data !== 'string' || request.data.length > Math.ceil(CONTENT_CHUNK / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.data)) throw Error('Invalid content chunk.');
        const buffer = Buffer.from(request.data, 'base64');
        await engine.append(record.id, request.index, Readable.from([buffer]));
      } else if (request.action === 'content-complete') await engine.complete(record.id);
      else throw Error('Unsupported content operation.');
      return view(record);
    });
  }
  return { handle };
}
