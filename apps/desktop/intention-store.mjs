import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {intentId,intentFields,validIntent} from '../../packages/core/intentions.mjs';
import {regularFile,writeAtomic} from './secure-content-store.mjs';
const scopeKey=(p,c)=>`${p}:${c??''}`;
export function createIntentionStore(file,collaboration,now=Date.now){
 async function load(){
  try{const stat=await regularFile(file);if(stat.size>32*1024*1024)throw Error();const data=JSON.parse(await fs.readFile(file,'utf8'));if(data.version!==1||!intentId(data.epoch)||!Array.isArray(data.scopes)||data.scopes.length>1000)throw Error();const keys=new Set();let operations=0,records=0;
   for(const scope of data.scopes){if(!intentId(scope.projectId)||(scope.contextId!==undefined&&!intentId(scope.contextId))||!Number.isInteger(scope.revision)||scope.revision<0||!Array.isArray(scope.records)||scope.records.length>100||!Array.isArray(scope.operations)||keys.has(scopeKey(scope.projectId,scope.contextId)))throw Error();keys.add(scopeKey(scope.projectId,scope.contextId));const ids=new Set();for(const record of scope.records){validIntent(record);if(record.projectId!==scope.projectId||record.contextId!==scope.contextId||record.revision>scope.revision||ids.has(record.id))throw Error();ids.add(record.id);}const ops=new Set();for(const op of scope.operations){if(!intentId(op.id)||!intentId(op.actor)||!intentId(op.recordId)||!ids.has(op.recordId)||typeof op.hash!=='string'||!/^[a-f0-9]{64}$/.test(op.hash)||ops.has(op.id))throw Error();ops.add(op.id);}operations+=scope.operations.length;records+=scope.records.length;}
   if(operations>5000||records>1000)throw Error();return data;
  }catch(error){if(error.code==='ENOENT')return{version:1,epoch:randomUUID(),scopes:[]};throw Error('Intention registry is corrupt or unsupported. Original data preserved.');}
 }
 async function save(data){const folder=path.dirname(file);await fs.mkdir(folder,{recursive:true});if((await fs.lstat(folder)).isSymbolicLink())throw Error('Unsafe intention storage.');if(Buffer.byteLength(JSON.stringify(data))>32*1024*1024)throw Error('Intention registry capacity reached.');await writeAtomic(file,data);}
 return{handle:(fingerprint,request)=>{
  if(!request||request.version!==1||!['intent-sync','intent-mutate'].includes(request.action)||Object.keys(request).some(key=>!['version','action','projectId','contextId','epoch','since','operation'].includes(key)))throw Error('Unsupported intention operation.');
  return collaboration.withContentAuthority(fingerprint,request.projectId,request.contextId,async auth=>{
   const data=await load();let scope=data.scopes.find(s=>s.projectId===request.projectId&&s.contextId===request.contextId),dirty=false;
   if(!scope){scope={projectId:request.projectId,...(request.contextId?{contextId:request.contextId}:{}),revision:0,records:[],operations:[]};data.scopes.push(scope);dirty=true;}
   const eligible=new Set([auth.principalId,...auth.recipients.map(p=>p.id)]),stamp=()=>new Date(now()).toISOString();
   const advance=record=>{record.revision=++scope.revision;record.version++;record.updatedAt=stamp();dirty=true;};
   for(const record of scope.records)if(record.status==='active'&&(!eligible.has(record.participantId)||Date.parse(record.expiresAt)<=now())){record.status=eligible.has(record.participantId)?'stale':'revoked';advance(record);}
   if(dirty)await save(data);
   if(request.action==='intent-sync'){
    if(!Number.isInteger(request.since)||request.since<0||(request.epoch!==undefined&&!intentId(request.epoch)))throw Error('Invalid intention cursor.');
    const reset=request.epoch!==data.epoch||request.since>scope.revision;
    const candidates=scope.records.filter(record=>reset||record.revision>request.since).sort((a,b)=>a.revision-b.revision),records=[];let bytes=0;
    for(const record of candidates){const size=Buffer.byteLength(JSON.stringify(record));if(records.length&&bytes+size>128*1024)break;records.push(record);bytes+=size;}
    const more=records.length<candidates.length;
    return{version:1,epoch:data.epoch,revision:more?records.at(-1).revision:scope.revision,reset,more,principalId:auth.principalId,canWrite:auth.canWrite,records};
   }
   if(!auth.canWrite)throw Error('Intention editing requires member access.');
   const op=request.operation;
   if(!op||!intentId(op.id)||!intentId(op.recordId)||!['create','revise','resolve','cancel','acknowledge','coordinate'].includes(op.kind)||!Number.isInteger(op.baseVersion)||op.baseVersion<0||Object.keys(op).some(k=>!['id','recordId','kind','baseVersion','fields','text'].includes(k)))throw Error('Invalid intention mutation.');
   const fields=['create','revise'].includes(op.kind)?intentFields(op.fields):undefined;
   if(['acknowledge','coordinate'].includes(op.kind)&&(typeof op.text!=='string'||op.text.length>400||(op.kind==='coordinate'&&!op.text.trim())))throw Error('Add a coordination message, up to 400 characters.');
   const normalized={id:op.id,recordId:op.recordId,kind:op.kind,baseVersion:op.baseVersion,...(fields?{fields}:{}),...(['acknowledge','coordinate'].includes(op.kind)?{text:op.text.trim()}:{})};
   const hash=createHash('sha256').update(JSON.stringify(normalized)).digest('hex');const prior=scope.operations.find(item=>item.id===op.id);
   if(prior){if(prior.actor!==auth.principalId||prior.hash!==hash)throw Error('Operation ID is already bound.');return{accepted:true,id:op.recordId};}
   let record=scope.records.find(item=>item.id===op.recordId);
   if(record&&!['acknowledge','coordinate'].includes(op.kind)&&record.participantId!==auth.principalId)throw Error('Only the intention author can change its work scope or lifecycle.');
   if((!record&&op.kind!=='create')||(record&&op.kind==='create')||(record&&record.version!==op.baseVersion)||(!record&&op.baseVersion!==0))return{conflict:true,current:record??null};
   if(data.scopes.reduce((n,s)=>n+s.operations.length,0)>=5000)throw Error('Intention operation capacity reached; archival is required.');
   if(!record){if(scope.records.length>=100||data.scopes.reduce((n,s)=>n+s.records.length,0)>=1000)throw Error('Intention capacity reached; archival is required.');record={schemaVersion:1,id:op.recordId,projectId:scope.projectId,...(scope.contextId?{contextId:scope.contextId}:{}),participantId:auth.principalId,displayName:auth.displayName,createdAt:stamp(),updatedAt:stamp(),expiresAt:stamp(),version:0,revision:0,status:'active',notes:[],...fields};scope.records.push(record);}
   if(fields){Object.assign(record,fields);record.status='active';record.expiresAt=new Date(now()+fields.hours*3600000).toISOString();}
   if(op.kind==='resolve')record.status='resolved';if(op.kind==='cancel')record.status='cancelled';
   if(['acknowledge','coordinate'].includes(op.kind)){if(record.status!=='active')throw Error('This intention is no longer active.');if(record.notes.length>=12)throw Error('Coordination note limit reached. Revise or resolve the intention.');record.notes.push({kind:op.kind,text:op.text.trim(),participantId:auth.principalId,displayName:auth.displayName,at:stamp()});}
   advance(record);scope.operations.push({id:op.id,recordId:record.id,actor:auth.principalId,hash});await save(data);return{accepted:true,id:record.id};
  });
 }};
}
