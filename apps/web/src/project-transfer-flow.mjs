import { withSharingCheck } from '../../../packages/transfer/secret-scan.mjs';
import { sha256File } from '../../../packages/transfer/browser-sha256.js';
import { CONTENT_CHUNK, CONTENT_LIMIT, safeContentName } from '../../../packages/transfer/secure-content.mjs';
export function percentage(retained, size, complete = false) { return complete ? 100 : size > 0 ? Math.min(99, Math.max(0, Math.floor(retained / size * 100))) : 0; }
export function canResume(record, principalId, role) { return record.state === 'uploading' && record.senderId === principalId && role !== 'guest'; }
export async function uploadContent({ file, id, recipientId, operate, confirm, progress, stopped, expected }) {
  safeContentName(file.name);
  if (file.size > CONTENT_LIMIT) throw Error('File exceeds the supported 64 GiB ceiling. The host may enforce a lower configured limit.');
  progress({ phase: 'Checking', retained: 0, size: file.size, name: file.name });
  const allowed = await withSharingCheck(file, confirm, async () => {
    if (stopped()) return;
    const sha256 = await sha256File(file,{stopped,onProgress:retained=>progress({phase:'Hashing',retained,size:file.size,name:file.name})});
    if (expected && (expected.sha256 !== sha256 || expected.name !== file.name || expected.size !== file.size || expected.recipientId !== recipientId)) throw Error('Choose the original file and recipient to resume this transfer.');
    if (stopped()) return;
    let state = await operate({ action: 'content-create', id, name: file.name, size: file.size, sha256, recipientId });
    progress({ phase: state.state === 'completed' ? 'Completed' : 'Uploading', retained: state.retainedBytes, size: file.size, name: file.name });
    while (state.state !== 'completed' && state.nextIndex * CONTENT_CHUNK < file.size && !stopped()) {
      const index = state.nextIndex, bytes = await file.slice(index * CONTENT_CHUNK, (index + 1) * CONTENT_CHUNK).arrayBuffer();
      if (stopped()) break;
      state = await operate({ action: 'content-chunk', id, index }, bytes);
      progress({ phase: 'Uploading', retained: state.retainedBytes, size: file.size, name: file.name });
    }
    if (stopped()) { progress({ phase: 'Paused', retained: state.retainedBytes, size: file.size, name: file.name }); return; }
    progress({ phase: 'Verifying', retained: state.retainedBytes, size: file.size, name: file.name });
    state = await operate({ action: 'content-complete', id });
    progress({ phase: 'Completed', retained: state.retainedBytes, size: file.size, name: file.name });
  });
  if (!allowed || stopped()) return false;
  return true;
}
export async function receiveContent({ record, call, stopped, progress }) {
  let state = await call('receive-start', { id: record.id });
  progress({ phase: 'Receiving', retained: state.retainedBytes, size: record.size, name: record.name });
  while (state.state !== 'completed' && state.nextIndex * CONTENT_CHUNK < record.size && !stopped()) {
    state = await call('receive-chunk', { id: record.id, index: state.nextIndex });
    progress({ phase: 'Receiving', retained: state.retainedBytes, size: record.size, name: record.name });
  }
  if (stopped()) { progress({ phase: 'Paused', retained: state.retainedBytes, size: record.size, name: record.name }); return { saved: false }; }
  progress({ phase: 'Verifying & saving', retained: state.retainedBytes, size: record.size, name: record.name });
  const saved = await call('receive-finish', { id: record.id });
  progress({ phase: saved.saved ? 'Saved' : 'Ready to save', retained: state.retainedBytes, size: record.size, name: record.name });
  return saved;
}

// Stage only after the same fresh Secret-Safe consent used by immediate transfers.
export async function queueContent({file,id,recipientId,target,call,confirm,progress,stopped}) {
  safeContentName(file.name); if(file.size>CONTENT_LIMIT) throw Error('File exceeds the supported 64 GiB ceiling. The host may enforce a lower configured limit.');
  return withSharingCheck(file,confirm,async()=>{
    if(stopped())throw Error('Queue preparation stopped.');
    const sha256=await sha256File(file,{stopped,onProgress:retained=>progress({phase:'Hashing',retained,size:file.size,name:file.name})});
    await call('queue-create',{target,meta:{id,name:file.name,size:file.size,sha256,recipientId,projectId:target.projectId,...(target.contextId?{contextId:target.contextId}:{})}});
    try {
      for(let index=0;index*CONTENT_CHUNK<file.size;index++) {
        if(stopped())throw Error('Queue preparation stopped.');
        const bytes=await file.slice(index*CONTENT_CHUNK,(index+1)*CONTENT_CHUNK).arrayBuffer();
        await call('queue-stage',{id,index,bytes});
        progress({phase:'Protecting local copy',retained:Math.min(file.size,(index+1)*CONTENT_CHUNK),size:file.size,name:file.name});
      }
      if(stopped())throw Error('Queue preparation stopped.');
      await call('queue-commit',{id});
      progress({phase:'Queued',retained:0,size:file.size,name:file.name});
    }catch(error){await call('queue-cancel',{id}).catch(()=>{});throw error;}
  });
}
// Fan-out retains one independently authorized job/ID per recipient; no shared ACL or receipt.
export async function queueContentMany(options){
 const recipients=[...new Set(options.recipientIds)];if(!recipients.length||recipients.length>20)throw Error('Choose 1–20 recipients.');let approved=false;const results=[];
 for(const recipientId of recipients){if(options.stopped())break;const id=crypto.randomUUID();try{const queued=await queueContent({...options,id,recipientId,confirm:async scan=>{if(approved)return true;approved=await options.confirm(scan);return approved;}});results.push({id,recipientId,queued:Boolean(queued)});if(!queued)break;}catch(error){results.push({id,recipientId,queued:false,error:String(error.message??error)});}}
 return results;
}
