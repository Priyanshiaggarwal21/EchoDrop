import fs from 'node:fs/promises';
import path from 'node:path';
import {digest,RESTORE_FIELDS} from './recovery-package.mjs';
import { randomUUID } from 'node:crypto';
import { validateProject, validateProjectInput, validateProjectPatch, isProjectId } from '../../packages/core/projects.mjs';

// One instance in the single-instance Electron main process owns all writes.
export function createProjectRegistry(file, io = fs) {
  let queue = Promise.resolve();
  async function load() {
    let raw;
    try {
      if ((await io.stat(file)).size > 16 * 1024 * 1024) throw new Error('Registry exceeds the supported size.');
      raw = await io.readFile(file, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, projects: [], readOnly: false, warning: '' }; throw error; }
    let data;
    try { data = JSON.parse(raw); } catch { return { projects: [], readOnly: true, warning: 'The project registry could not be read. Its original file has been preserved; repair or restore it before adding projects.' }; }
    if (!data || data.version !== 1 || !Array.isArray(data.projects)) return { projects: [], readOnly: true, warning: 'This registry format is unsupported. The original file has been preserved; use a compatible EchoDrop version.' };
    const receipts=data.recoveryReceipts??[];
    const receiptIds=new Set();
    if(!Array.isArray(receipts)||receipts.length>100||receipts.some(r=>!r||Object.keys(r).sort().join(',')!=='appliedAt,fields,id,principalId,projectId,requestDigest,resultDigest,snapshotId'||!['id','projectId','principalId','snapshotId'].every(k=>isProjectId(r[k]))||receiptIds.has(r.id)||!['requestDigest','resultDigest'].every(k=>/^[a-f0-9]{64}$/.test(r[k]))||!Array.isArray(r.fields)||!r.fields.length||new Set(r.fields).size!==r.fields.length||r.fields.some(k=>!RESTORE_FIELDS.includes(k))||!Number.isFinite(Date.parse(r.appliedAt))||!receiptIds.add(r.id)))return {...data,projects:[],readOnly:true,warning:'Recovery receipts are corrupt; original registry preserved.'};
    const ids = new Set(), projects = []; let invalid = 0;
    for (const record of data.projects) {
      try { validateProject(record); if (record.localRoot && !path.isAbsolute(record.localRoot)) throw new Error('Invalid folder'); if (ids.has(record.id)) throw new Error('Duplicate project'); ids.add(record.id); projects.push(record); }
      catch { invalid++; }
    }
    return { ...data, projects, readOnly: invalid > 0, warning: invalid ? `${invalid} invalid project record(s) were skipped. The registry is read-only and the original file is preserved for recovery.` : '' };
  }
  async function write(data) {
    const serialized = JSON.stringify(data, null, 2);
    if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw new Error('The registry has reached its supported size.');
    await io.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await io.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(serialized, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      await io.rename(temporary, file);
    } finally { await io.unlink(temporary).catch(() => {}); }
  }
  function mutate(change) {
    const task = queue.then(async () => {
      const { readOnly, warning, ...data } = await load();
      if (readOnly) throw new Error(warning);
      const result = await change(data);
      await write(data); return structuredClone(result);
    });
    queue = task.catch(() => {}); return task;
  }
  return {
    async list() { await queue; const { projects, readOnly, warning } = await load(); return { projects, readOnly, warning }; },
    create(input, localRoot) {
      return mutate(async data => {
        const details = validateProjectInput(input);
        if (localRoot !== undefined && (!path.isAbsolute(localRoot) || !(await io.stat(localRoot)).isDirectory())) throw new Error('Choose an existing local folder.');
        if (details.origin === 'import' && !localRoot) throw new Error('Choose the folder to import.');
        const now = new Date().toISOString();
        const project = validateProject({ ...details, version: 1, id: randomUUID(), status: 'Planned', createdAt: now, updatedAt: now, pinned: false, metadata: {}, ...(localRoot ? { localRoot } : {}) });
        data.projects.push(project); return project;
      });
    },
    // Caller holds the existing collaboration authority transaction throughout this write.
    // Receipt + metadata are committed together; no recovery mutation is exposed on registry IPC.
    restoreMetadata(request, authority) {
      return mutate(data=>{
        if(!authority?.local||!authority.canPlan||authority.role!=='owner'||authority.principalId!==authority.localPrincipalId||authority.principalId!==request.principalId||authority.identityBinding!==request.identityBinding||authority.authorityRevision!==request.authorityRevision)throw Error('Current protected owner authority required.');
        if(Object.keys(request).sort().join(',')!=='authorityRevision,expectedDigest,expiresAt,id,identityBinding,patch,principalId,projectId,snapshotId'||!['id','projectId','principalId','snapshotId'].every(k=>isProjectId(request[k]))||!['identityBinding','authorityRevision','expectedDigest'].every(k=>/^[a-f0-9]{64}$/.test(request[k])))throw Error('Invalid metadata restore request.');
        if(!Number.isFinite(Date.parse(request.expiresAt))||Date.now()>=Date.parse(request.expiresAt))throw Error('Restore authorization expired; verify again.');
        validateProjectPatch(request.patch);const patch=structuredClone(request.patch),project=data.projects.find(p=>p.id===request.projectId);
        if(!project)throw Error('Project unavailable.');
        const requestDigest=digest(request),receipts=data.recoveryReceipts??=[],prior=receipts.find(r=>r.id===request.id);
        if(prior){if(prior.requestDigest!==requestDigest)throw Error('Restore operation replay conflict.');return {...prior,replayed:true,currentMatches:digest(project)===prior.resultDigest};}
        if(receipts.length>=100)throw Error('Metadata restore receipt capacity reached; preserve receipts for recovery.');
        if(digest(project)!==request.expectedDigest)throw Error('Preview is stale; inspect a new preview before restoring.');
        Object.assign(project,patch,{updatedAt:new Date(Math.max(Date.now(),Date.parse(project.updatedAt)+1)).toISOString()});validateProject(project);
        const receipt={id:request.id,projectId:request.projectId,principalId:request.principalId,snapshotId:request.snapshotId,requestDigest,resultDigest:digest(project),fields:Object.keys(patch).sort(),appliedAt:new Date().toISOString()};
        data.recoveryReceipts=[...receipts,receipt];return {...receipt,replayed:false,currentMatches:true};
      });
    },
    update(id, patch) {
      return mutate(data => {
        if (!isProjectId(id)) throw new Error('Invalid project ID.');
        const project = data.projects.find(item => item.id === id);
        if (!project) throw new Error('Project not found. Reload your projects.');
        Object.assign(project, validateProjectPatch(patch), { updatedAt: new Date(Math.max(Date.now(), Date.parse(project.updatedAt))).toISOString() });
        validateProject(project); return project;
      });
    },
  };
}
