import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { CONTENT_CHUNK, CONTENT_QUOTA, contentId, validateContentMeta } from '../../packages/transfer/secure-content.mjs';
import { regularFile, writeAtomic } from './secure-content-store.mjs';
const states = ['Queued','Uploaded','Delivered','Applied','Failed','Cancelled'];
export const retryDelay = attempt => Math.min(300000, 2000 * 2 ** Math.min(attempt, 8));
export function validateTarget(target, localProjectId) {
  if (!target || !['local','remote'].includes(target.mode) || !contentId(target.projectId) || (target.contextId !== undefined && !contentId(target.contextId)) || Object.keys(target).some(key => !['mode','projectId','contextId','fingerprint','host','port'].includes(key))) throw Error('Invalid queue scope.');
  if (target.mode === 'local' ? target.projectId !== localProjectId || ['fingerprint','host','port'].some(key=>target[key]!==undefined) : !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(target.fingerprint) || !isIP(target.host) || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw Error('Invalid queue host.');
}
export function createDeliveryQueue(directory, { protection, authorize, execute, now = Date.now, limits = {} }) {
  const {transferPolicy,requireSpace}=createRequire(import.meta.url)('../../packages/transfer/limits.cjs'),policy=transferPolicy(limits);
  const root=path.resolve(directory), index=path.join(root,'queue.json'); let pending=Promise.resolve();
  const serial=operation=>{const result=pending.then(operation);pending=result.catch(()=>{});return result;};
  async function guard(){await fs.mkdir(root,{recursive:true});if((await fs.lstat(root)).isSymbolicLink())throw Error('Unsafe queue directory.');}
  async function read(file,limit){await guard();const stat=await regularFile(file);if(stat.size>limit)throw Error('Queue storage limit exceeded.');const envelope=JSON.parse(await fs.readFile(file,'utf8'));if(envelope.version!==1||typeof envelope.sealed!=='string')throw Error('Unsupported protected queue version.');return JSON.parse(protection.open(envelope.sealed));}
  async function write(file,value){await guard();await writeAtomic(file,{version:1,sealed:protection.seal(JSON.stringify(value))});}
  async function load(){
    let data;try{data=await read(index,8*1024*1024);}catch(error){if(error.code==='ENOENT')return {version:1,jobs:[],retentionDays:{}};throw Error('Queue cannot be opened. Protected state is corrupt or unavailable; original data is preserved.');}
    try{
      if(data.version!==1||!Array.isArray(data.jobs)||data.jobs.length>500)throw Error();if(data.retentionDays!==undefined&&(typeof data.retentionDays!=='object'||Array.isArray(data.retentionDays)||Object.entries(data.retentionDays).some(([id,days])=>!contentId(id)||!Number.isInteger(days)||days<1||days>365)))throw Error();const ids=new Set();
      for(const job of data.jobs){validateContentMeta(job.meta);validateTarget(job.target,job.localProjectId);if(!contentId(job.localProjectId)||ids.has(job.meta.id)||job.meta.projectId!==job.target.projectId||job.meta.contextId!==job.target.contextId||!states.includes(job.state)||typeof job.paused!=='boolean'||typeof job.ready!=='boolean'||typeof job.cancelPending!=='boolean'||!Number.isInteger(job.staged)||job.staged<0||job.staged>Math.ceil(job.meta.size/CONTENT_CHUNK)||(job.ready&&job.staged!==Math.ceil(job.meta.size/CONTENT_CHUNK))||!Number.isInteger(job.attempts)||job.attempts<0||!Number.isFinite(job.nextAt)||!Number.isSafeInteger(job.retained)||job.retained<0||job.retained>job.meta.size)throw Error();if((job.terminalAt!==undefined&&!Number.isFinite(job.terminalAt))||(job.archivedAt!==undefined&&(!Number.isFinite(job.archivedAt)||!['Applied','Cancelled'].includes(job.state)||job.cancelPending)))throw Error();ids.add(job.meta.id);}
    }catch{throw Error('Queue validation failed. Original data is preserved.');}return data;
  }
  const chunkPath=(job,index)=>path.join(root,`${job.meta.id}.${index}.sealed`);
  async function chunk(job,index){const item=await read(chunkPath(job,index),4*CONTENT_CHUNK);if(item.id!==job.meta.id||item.index!==index||typeof item.data!=='string')throw Error('Queued payload binding failed.');const bytes=Buffer.from(item.data,'base64');if(bytes.length!==Math.min(CONTENT_CHUNK,job.meta.size-index*CONTENT_CHUNK)||createHash('sha256').update(bytes).digest('hex')!==item.hash)throw Error('Queued payload integrity failed.');return bytes;}
  async function verify(job){const hash=createHash('sha256');for(let i=0;i<Math.ceil(job.meta.size/CONTENT_CHUNK);i++)hash.update(await chunk(job,i));if(hash.digest('hex')!==job.meta.sha256)throw Error('Queued file integrity failed. Cancel and select the original file again.');}
  async function purge(job){for(let i=0;i<Math.ceil(job.meta.size/CONTENT_CHUNK);i++)await fs.unlink(chunkPath(job,i)).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  const view=job=>({createdAt:job.createdAt??null,terminalAt:job.terminalAt??null,archivedAt:job.archivedAt??null,id:job.meta.id,name:job.meta.name,size:job.meta.size,projectId:job.meta.projectId,contextId:job.meta.contextId,recipientId:job.meta.recipientId,state:job.state,paused:job.paused,ready:job.ready,retained:job.retained,nextAt:job.nextAt,error:job.error,cancelPending:job.cancelPending,host:job.target.mode==='local'?'This desktop':job.target.host});
  const find=(data,projectId,id)=>{const job=data.jobs.find(j=>j.localProjectId===projectId&&j.meta.id===id);if(!job)throw Error('Queue job access denied.');return job;};
  return {
    // Explicitly scoped by the authenticated remote host, not the local project alias.
    inventory:async target=>{
      const data=await load(),rows=[];
      for(const j of data.jobs.filter(j=>j.target.mode==='remote'&&j.target.fingerprint===target.fingerprint&&j.target.projectId===target.projectId&&j.target.contextId===target.contextId)){
        await authorize(j.localProjectId);
        if(j.cancelPending)rows.push({id:j.meta.id,state:'withdrawal-pending'});
        else if(!['Applied','Cancelled'].includes(j.state))rows.push({id:j.meta.id,state:'pending'});
        else if(j.retained>0&&!j.archivedAt)rows.push({id:j.meta.id,state:'retained-record'});
      }
      return rows;
    },
    // Read the atomic index without joining the upload lock: upload hooks may collect this evidence.
    continuity:async(projectId,contextId)=>{const snapshot=await authorize(projectId);return (await load()).jobs.filter(j=>j.localProjectId===projectId&&j.target.mode==='local'&&j.meta.projectId===projectId&&j.meta.contextId===contextId).map(j=>({id:j.meta.id,senderId:snapshot.actor.id,recipientId:j.meta.recipientId,state:j.state,cancelPending:j.cancelPending}));},
    list:projectId=>serial(async()=>{await authorize(projectId);return (await load()).jobs.filter(j=>j.localProjectId===projectId).map(view);}),
    retention:(projectId,days)=>serial(async()=>{await authorize(projectId);const data=await load();data.retentionDays??={};if(days!==undefined){if(!Number.isInteger(days)||days<1||days>365)throw Error('Choose retention from 1 to 365 days.');data.retentionDays[projectId]=days;await write(index,data);}return {days:data.retentionDays[projectId]??30};}),
    cleanup:projectId=>serial(async()=>{await authorize(projectId);const data=await load(),days=data.retentionDays?.[projectId]??30;let archived=0;for(const job of data.jobs)if(job.localProjectId===projectId&&job.archivedAt===undefined&&['Applied','Cancelled'].includes(job.state)&&!job.cancelPending&&job.terminalAt!==undefined&&job.terminalAt<=now()-days*86400000){await purge(job);job.archivedAt=now();archived++;}await write(index,data);return {archived,days};}),
    create:(projectId,target,meta)=>serial(async()=>{
      await authorize(projectId);validateTarget(target,projectId);validateContentMeta(meta);
      meta = Object.fromEntries(['id','projectId','contextId','recipientId','name','size','sha256'].filter(key=>meta[key]!==undefined).map(key=>[key,meta[key]]));
      if(meta.size>policy.maxFileBytes)throw Error(`File exceeds local configured ${policy.maxFileBytes}-byte limit.`);
      if(meta.projectId!==target.projectId||meta.contextId!==target.contextId)throw Error('Queue scope mismatch.');
      const data=await load(),existing=data.jobs.find(j=>j.meta.id===meta.id);
      if(existing){if(existing.localProjectId!==projectId||JSON.stringify(existing.target)!==JSON.stringify(target)||JSON.stringify(existing.meta)!==JSON.stringify(meta))throw Error('Queue ID already bound.');return view(existing);}
      if(data.jobs.length>=500||data.jobs.filter(j=>!['Applied','Cancelled'].includes(j.state)).reduce((n,j)=>n+j.meta.size*3,0)+meta.size*3>policy.quotaBytes)throw Error('Queue capacity reached. Cancel unused jobs.');
      await requireSpace(fs,root,meta.size*3,policy.reserveBytes);
      const job={createdAt:now(),localProjectId:projectId,target,meta,state:'Queued',paused:true,ready:false,staged:0,retained:0,attempts:0,nextAt:0,cancelPending:false,error:'Preparing protected payload. Incomplete staging must be cancelled and selected again.'};data.jobs.push(job);await write(index,data);return view(job);
    }),
    stage:(projectId,id,position,bytes)=>serial(async()=>{
      await authorize(projectId);const data=await load(),job=find(data,projectId,id);
      if(job.ready||job.state!=='Queued'||!Number.isInteger(position)||position!==job.staged||!Buffer.isBuffer(bytes)||bytes.length!==Math.min(CONTENT_CHUNK,job.meta.size-position*CONTENT_CHUNK)||bytes.length<=0)throw Error('Invalid queue staging chunk.');
      await requireSpace(fs,root,bytes.length*3,policy.reserveBytes);
      await write(chunkPath(job,position),{id,index:position,data:bytes.toString('base64'),hash:createHash('sha256').update(bytes).digest('hex')});job.staged++;await write(index,data);return view(job);
    }),
    control:(projectId,id,action)=>serial(async()=>{
      await authorize(projectId);const data=await load(),job=find(data,projectId,id);
      if(action==='archive'){if(!['Applied','Cancelled'].includes(job.state)||job.cancelPending)throw Error('Only terminal deliveries with confirmed withdrawal may be archived.');await purge(job);job.archivedAt=now();await write(index,data);return view(job);}
      if(action==='cancel'){if(job.state==='Cancelled'&&!job.cancelPending)return view(job);if(job.state==='Applied')throw Error('Saved copies cannot be cancelled.');job.terminalAt=now();job.state='Cancelled';job.paused=false;job.cancelPending=job.ready;job.nextAt=0;job.attempts=0;job.error=job.ready?'Local delivery stopped. Host withdrawal pending; saved copies cannot be revoked.':'';await write(index,data);await purge(job);return view(job);}
      if(['Applied','Cancelled'].includes(job.state))throw Error('This job is terminal.');
      if(action==='commit'){await verify(job);job.ready=true;}
      else if(!['pause','resume'].includes(action))throw Error('Unsupported queue control.');
      if(action!=='pause'&&!job.ready)throw Error('Staging incomplete. Cancel and select the file again.');
      job.paused=action==='pause';if(!job.paused){job.state=job.state==='Failed'?'Queued':job.state;job.attempts=0;job.nextAt=0;job.error='';}await write(index,data);return view(job);
    }),
    tick:()=>serial(async()=>{
      const data=await load();const job=data.jobs.find(j=>!j.paused&&j.nextAt<=now()&&((j.ready&&!['Failed','Applied','Cancelled'].includes(j.state))||j.cancelPending));if(!job)return;
      try{
        await authorize(job.localProjectId);
        const call=command=>execute(job.localProjectId,job.target,command);
        if(job.cancelPending){await call({action:'content-cancel',id:job.meta.id});job.cancelPending=false;job.error='Host withdrawal confirmed. Previously saved copies remain.';}
        else {
          const access=await call({action:'content-info'});if(access.role==='guest'||!access.recipients.some(p=>p.id===job.meta.recipientId))throw Error('Recipient or upload authorization revoked.');
          const {id,name,size,sha256,recipientId}=job.meta;
          let state=await call(['Uploaded','Delivered'].includes(job.state)?{action:'content-status',id}:{action:'content-create',id,name,size,sha256,recipientId});
          if(state.state==='cancelled'&&state.delivery==='Applied')state={...state,state:'completed',retainedBytes:size};
          if(state.state==='cancelled'||state.state==='failed')throw Error('Host content is cancelled or failed.');
          if(state.state!=='completed'){
            if(state.nextIndex*CONTENT_CHUNK<size){const bytes=await chunk(job,state.nextIndex);state=await call({action:'content-chunk',id,index:state.nextIndex,data:bytes.toString('base64')});}
            else state=await call({action:'content-complete',id});
          }
          job.retained=state.retainedBytes;job.state=state.state==='completed'?(state.delivery??'Uploaded'):'Queued';job.error=job.state==='Uploaded'?'Waiting for recipient to receive and acknowledge.':job.state==='Delivered'?'Recipient verified the file; waiting for explicit save.':'';
          if(job.state==='Applied'){job.terminalAt??=now();await write(index,data);try{await purge(job);}catch{job.error='Recipient saved the file. Local cache cleanup failed; retry Archive queue payload.';}}
        }
        job.attempts=0;job.nextAt=now()+(['Uploaded','Delivered'].includes(job.state)?30000:0);
      }catch(error){
        const transient=/Secure connection (?:failed|timed out|closed)/.test(error.message);job.attempts++;job.error=error.code==='ENOENT'?'Protected queued payload is missing. Cancel and select the original file again.':String(error.message).slice(0,400);
        if(transient&&job.attempts<8){job.nextAt=now()+retryDelay(job.attempts);job.error+=' Waiting for host; retry scheduled.';}
        else {if(job.state!=='Cancelled')job.state='Failed';job.paused=true;job.error+=' Automatic retry stopped. Check access/storage, then resume or cancel.';}
      }
      await write(index,data);
    }),
  };
}
