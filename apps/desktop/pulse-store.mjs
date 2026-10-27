import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {derivePulse,validPulse} from '../../packages/core/pulse.mjs';
import {intentId} from '../../packages/core/intentions.mjs';
import {regularFile,writeAtomic} from './secure-content-store.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const stable=x=>{const h=hash(x);return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-8'+h.slice(17,20)+'-'+h.slice(20,32);};
export function createPulseStore(file,collaboration,{protection,collect,now=Date.now}){
 let lock=Promise.resolve();const serial=fn=>{const p=lock.then(fn);lock=p.catch(()=>{});return p;};
 async function load(){try{if((await regularFile(file)).size>32*1024*1024)throw Error();const envelope=JSON.parse(await fs.readFile(file,'utf8'));if(envelope.version!==1)throw Error();const d=JSON.parse(protection.open(envelope.sealed));if(d.version!==1||!intentId(d.epoch)||!Array.isArray(d.scopes)||d.scopes.length>100)throw Error();const scopes=new Set();for(const s of d.scopes){const key=s.projectId+':'+(s.contextId??'');if(!intentId(s.projectId)||(s.contextId&&!intentId(s.contextId))||scopes.has(key)||!Number.isInteger(s.revision)||!Array.isArray(s.records)||s.records.length>100||!Array.isArray(s.operations)||s.operations.length>2000)throw Error();scopes.add(key);const ids=new Set(),operationIds=new Set();for(const r of s.records){validPulse(r);if(!intentId(r.id)||ids.has(r.id)||r.projectId!==s.projectId||r.contextId!==s.contextId||r.revision>s.revision)throw Error();ids.add(r.id);}for(const o of s.operations)if(!intentId(o.id)||operationIds.has(o.id)||!intentId(o.actor)||(o.recordId!==undefined&&(!intentId(o.recordId)||!ids.has(o.recordId)))||!/^[a-f0-9]{64}$/.test(o.hash))throw Error();else operationIds.add(o.id);}return d;}catch(e){if(e.code==='ENOENT')return{version:1,epoch:randomUUID(),scopes:[]};throw Error('Protected Pulse history is corrupt or unavailable. Original preserved.');}}
 async function save(d){const dir=path.dirname(file);await fs.mkdir(dir,{recursive:true});if((await fs.lstat(dir)).isSymbolicLink())throw Error('Unsafe Pulse storage.');const text=JSON.stringify(d);if(Buffer.byteLength(text)>8*1024*1024)throw Error('Pulse storage capacity reached.');await writeAtomic(file,{version:1,sealed:protection.seal(text)});}
 return {handle:(fp,q)=>serial(async()=>{
  if(q?.version!==1||!['pulse-sync','pulse-mutate'].includes(q.action)||!intentId(q.projectId)||(q.contextId!==undefined&&!intentId(q.contextId))||Object.keys(q).some(k=>!['version','action','projectId','contextId','since','epoch','operation'].includes(k)))throw Error('Invalid Pulse request.');
  await collaboration.withContentAuthority(fp,q.projectId,q.contextId,()=>{});
  // Source stores independently enforce ACLs; never merge transfer visibility between recipients.
  const sources=await collect(fp,q);const visible=new Set([...sources.intentions,...sources.contracts,...sources.environments,...sources.transfers,...(sources.guardian??[])].map(r=>r.id));const derived=derivePulse(sources,now());
  return collaboration.withContentAuthority(fp,q.projectId,q.contextId,async auth=>{
   const d=await load();let s=d.scopes.find(s=>s.projectId===q.projectId&&s.contextId===q.contextId);if(!s){if(d.scopes.length>=100)throw Error('Pulse scope capacity reached.');s={projectId:q.projectId,...(q.contextId?{contextId:q.contextId}:{}),revision:0,records:[],operations:[]};d.scopes.push(s);}
   let dirty=false;const stamp=()=>new Date(now()).toISOString();const event=(r,kind,actor)=>{r.version++;r.revision=++s.revision;r.updatedAt=stamp();r.events.push({revision:r.revision,at:r.updatedAt,kind,...(actor?{actor}:{})});r.events=r.events.slice(-20);dirty=true;};
   for(const item of derived){const id=stable([q.projectId,q.contextId??null,item.key]);let r=s.records.find(r=>r.id===id);const evidenceHash=hash(item);if(!r){if(s.records.length>=100){const removable=s.records.filter(r=>r.refs.every(id=>visible.has(id))&&!derived.some(i=>i.key===r.key)).sort((a,b)=>a.revision-b.revision)[0];if(!removable)continue;s.records=s.records.filter(r=>r!==removable);}r={...item,schemaVersion:1,id,projectId:q.projectId,...(q.contextId?{contextId:q.contextId}:{}),participantId:item.owners[0]??auth.principalId,version:0,revision:0,status:'open',events:[],evidenceHash};s.records.push(r);event(r,'observed');}else if(r.evidenceHash!==evidenceHash){Object.assign(r,item,{evidenceHash,status:'open'});event(r,'evidence-changed');}}
   for(const r of s.records)if(r.refs.every(id=>visible.has(id))&&!derived.some(i=>i.key===r.key)&&r.status!=='cleared'){r.status='cleared';event(r,'no-longer-in-current-findings');}
   const allowed=s.records.filter(r=>r.refs.every(id=>visible.has(id)));
   if(q.action==='pulse-mutate'){
    const o=q.operation;if(!auth.canWrite||!o||!intentId(o.id)||!intentId(o.recordId)||!['acknowledge','resolve','reopen'].includes(o.kind)||!Number.isInteger(o.baseVersion)||Object.keys(o).some(k=>!['id','recordId','kind','baseVersion'].includes(k)))throw Error('Pulse contributor permission and a valid operation are required.');const digest=hash(o),prior=s.operations.find(p=>p.id===o.id),r=allowed.find(r=>r.id===o.recordId);if(!r)throw Error('Pulse evidence is no longer accessible.');if(prior){if(prior.actor!==auth.principalId||prior.hash!==digest)throw Error('Replay binding mismatch.');if(dirty)await save(d);return{accepted:true,id:r.id};}if(r.version!==o.baseVersion){if(dirty)await save(d);return{conflict:true};}if(s.operations.length>=2000)throw Error('Pulse action capacity reached.');r.status={acknowledge:'acknowledged',resolve:'resolved',reopen:'open'}[o.kind];event(r,o.kind,auth.principalId);s.operations.push({id:o.id,actor:auth.principalId,recordId:r.id,hash:digest});await save(d);return{accepted:true,id:r.id};
   }
   if(!Number.isInteger(q.since)||q.since<0)throw Error('Invalid Pulse cursor.');if(dirty)await save(d);
   // Full bounded reset deliberately removes evidence whose source ACL has changed.
   return {version:1,epoch:d.epoch,revision:s.revision,reset:true,more:false,principalId:auth.principalId,canWrite:auth.canWrite,records:allowed};
  });
 })};
}
