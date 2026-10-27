import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {intentId} from '../../packages/core/intentions.mjs';
import {environmentFields,validEnvironment} from '../../packages/core/environments.mjs';
import {regularFile,writeAtomic} from './secure-content-store.mjs';
export function createEnvironmentStore(file,collaboration,{now=Date.now,protection}={}){
 async function load(){try{
  if((await regularFile(file)).size>32*1024*1024)throw Error();const envelope=JSON.parse(await fs.readFile(file,'utf8'));if(envelope.version!==1||!protection)throw Error();const data=JSON.parse(protection.open(envelope.sealed));
  if(data.version!==1||!intentId(data.epoch)||!Array.isArray(data.scopes)||data.scopes.length>1000)throw Error();const scopes=new Set();let count=0,ops=0;
  for(const s of data.scopes){const key=s.projectId+':'+(s.contextId??'');if(!intentId(s.projectId)||(s.contextId!==undefined&&!intentId(s.contextId))||scopes.has(key)||!Number.isInteger(s.revision)||s.revision<0||!Array.isArray(s.records)||s.records.length>100||!Array.isArray(s.operations))throw Error();scopes.add(key);const ids=new Set(),opIds=new Set();for(const r of s.records){validEnvironment(r);if(ids.has(r.id)||r.projectId!==s.projectId||r.contextId!==s.contextId||r.revision>s.revision)throw Error();ids.add(r.id);}for(const o of s.operations){if(!intentId(o.id)||opIds.has(o.id)||!ids.has(o.recordId)||!intentId(o.actor)||!/^[a-f0-9]{64}$/.test(o.hash))throw Error();opIds.add(o.id);}count+=s.records.length;ops+=s.operations.length;}
  if(count>1000||ops>5000)throw Error();return data;
 }catch(e){if(e.code==='ENOENT')return{version:1,epoch:randomUUID(),scopes:[]};throw Error('Protected environment registry is corrupt or unavailable. Original data preserved.');}}
 async function save(data){if(!protection)throw Error('OS-protected storage is required.');const dir=path.dirname(file);await fs.mkdir(dir,{recursive:true});if((await fs.lstat(dir)).isSymbolicLink())throw Error('Unsafe environment storage.');const text=JSON.stringify(data);if(Buffer.byteLength(text)>8*1024*1024)throw Error('Environment storage capacity reached.');await writeAtomic(file,{version:1,sealed:protection.seal(text)});}
 return{handle:async(fingerprint,request)=>{
  if(!request||request.version!==1||!['environment-sync','environment-mutate'].includes(request.action)||Object.keys(request).some(k=>!['version','action','projectId','contextId','epoch','since','operation'].includes(k)))throw Error('Unsupported environment request.');
  const op=request.operation;let fields;
  if(request.action==='environment-mutate'){
   if(!op||!intentId(op.id)||!intentId(op.recordId)||!['create','revise','resolve','retest'].includes(op.kind)||!Number.isInteger(op.baseVersion)||op.baseVersion<0||Object.keys(op).some(k=>!['id','recordId','kind','baseVersion','fields'].includes(k)))throw Error('Invalid environment operation.');
   if(['create','revise'].includes(op.kind))fields=environmentFields(op.fields);else if(op.fields!==undefined)throw Error('Unexpected snapshot fields.');
  }
  return collaboration.withContentAuthority(fingerprint,request.projectId,request.contextId,async auth=>{
   const data=await load();let scope=data.scopes.find(s=>s.projectId===request.projectId&&s.contextId===request.contextId),dirty=false;
   if(!scope){scope={projectId:request.projectId,...(request.contextId?{contextId:request.contextId}:{}),revision:0,records:[],operations:[]};data.scopes.push(scope);dirty=true;}
   const stamp=()=>new Date(now()).toISOString(),advance=r=>{r.version++;r.revision=++scope.revision;r.updatedAt=stamp();dirty=true;};
   const eligible=new Set([auth.principalId,...auth.recipients.map(p=>p.id)]);for(const r of scope.records)if(r.authorActive&&!eligible.has(r.participantId)){r.authorActive=false;advance(r);}
   if(dirty)await save(data);
   if(request.action==='environment-sync'){
    if(!Number.isInteger(request.since)||request.since<0||(request.epoch!==undefined&&!intentId(request.epoch)))throw Error('Invalid environment cursor.');const reset=request.epoch!==data.epoch||request.since>scope.revision,records=[];let size=0;const candidates=scope.records.filter(r=>reset||r.revision>request.since).sort((a,b)=>a.revision-b.revision);
    for(const r of candidates){const bytes=Buffer.byteLength(JSON.stringify(r));if(records.length&&size+bytes>128*1024)break;records.push(r);size+=bytes;}const more=records.length<candidates.length;return{version:1,epoch:data.epoch,revision:more?records.at(-1).revision:scope.revision,reset,more,principalId:auth.principalId,canWrite:auth.canWrite,records};
   }
   if(!auth.canWrite)throw Error('Current contributor permission required.');
   const hash=createHash('sha256').update(JSON.stringify({id:op.id,recordId:op.recordId,kind:op.kind,baseVersion:op.baseVersion,...(fields?{fields}:{})})).digest('hex'),prior=scope.operations.find(o=>o.id===op.id);
   if(prior){if(prior.actor!==auth.principalId||prior.hash!==hash)throw Error('Operation already bound.');return{accepted:true,id:op.recordId};}
   let r=scope.records.find(r=>r.id===op.recordId);if(r&&r.participantId!==auth.principalId)throw Error('Only the snapshot author may revise or record resolution.');
   if((!r&&op.kind!=='create')||(r&&op.kind==='create')||(r&&r.version!==op.baseVersion)||(!r&&op.baseVersion!==0))return{conflict:true,current:null};
   if(data.scopes.reduce((n,s)=>n+s.operations.length,0)>=5000)throw Error('Operation capacity reached.');
   if(!r){if(scope.records.length>=100||data.scopes.reduce((n,s)=>n+s.records.length,0)>=1000)throw Error('Snapshot capacity reached.');r={schemaVersion:1,id:op.recordId,projectId:scope.projectId,...(scope.contextId?{contextId:scope.contextId}:{}),participantId:auth.principalId,displayName:auth.displayName,createdAt:stamp(),updatedAt:stamp(),version:0,revision:0,contentVersion:0,authorActive:true,fields,history:[],reviews:[],status:'open'};scope.records.push(r);}
   if(fields){if(r.history.length>=20)throw Error('Maximum 20 versions; publish a new snapshot.');r.contentVersion++;r.fields=fields;r.authorActive=true;r.status='open';r.history.push({contentVersion:r.contentVersion,actorId:auth.principalId,at:stamp(),fields:structuredClone(fields)});}
   else{if(r.reviews.length>=40)throw Error('Resolution history capacity reached.');r.reviews.push({kind:op.kind,participantId:auth.principalId,contentVersion:r.contentVersion,at:stamp()});r.status=op.kind==='resolve'?'resolved':'retest-needed';}
   advance(r);scope.operations.push({id:op.id,actor:auth.principalId,recordId:r.id,hash});validEnvironment(r);await save(data);return{accepted:true,id:r.id};
  });
 }};
}
