import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {intentId} from '../../packages/core/intentions.mjs';
import {contractFields,validContract} from '../../packages/core/contracts.mjs';
import {regularFile,writeAtomic} from './secure-content-store.mjs';
export function createContractStore(file,collaboration,{now=Date.now,validateLink}={}){
 async function load(){try{
  if((await regularFile(file)).size>32*1024*1024)throw Error();const data=JSON.parse(await fs.readFile(file,'utf8'));
  if(data.version!==1||!intentId(data.epoch)||!Array.isArray(data.scopes)||data.scopes.length>1000)throw Error();let records=0,operations=0;const scopes=new Set();
  for(const scope of data.scopes){const key=scope.projectId+':'+(scope.contextId??'');if(!intentId(scope.projectId)||(scope.contextId!==undefined&&!intentId(scope.contextId))||scopes.has(key)||!Number.isInteger(scope.revision)||scope.revision<0||!Array.isArray(scope.records)||scope.records.length>100||!Array.isArray(scope.operations))throw Error();scopes.add(key);const ids=new Set(),ops=new Set();for(const record of scope.records){validContract(record);if(ids.has(record.id)||record.projectId!==scope.projectId||record.contextId!==scope.contextId||record.revision>scope.revision)throw Error();ids.add(record.id);}for(const op of scope.operations){if(!intentId(op.id)||ops.has(op.id)||!intentId(op.actor)||!ids.has(op.recordId)||!/^[a-f0-9]{64}$/.test(op.hash))throw Error();ops.add(op.id);}records+=scope.records.length;operations+=scope.operations.length;}
  if(records>1000||operations>5000)throw Error();return data;
 }catch(error){if(error.code==='ENOENT')return{version:1,epoch:randomUUID(),scopes:[]};throw Error('Contract registry is corrupt or unsupported. Original data preserved.');}}
 async function save(data){const parent=path.dirname(file);await fs.mkdir(parent,{recursive:true});if((await fs.lstat(parent)).isSymbolicLink()||Buffer.byteLength(JSON.stringify(data))>32*1024*1024)throw Error('Contract storage unavailable or capacity reached.');await writeAtomic(file,data);}
 return{handle:async(fingerprint,request)=>{
  if(!request||request.version!==1||!['contract-sync','contract-mutate'].includes(request.action)||Object.keys(request).some(k=>!['version','action','projectId','contextId','epoch','since','operation'].includes(k)))throw Error('Unsupported contract operation.');
  const op=request.operation;let fields;
  if(request.action==='contract-mutate'){
   if(!op||!intentId(op.id)||!intentId(op.recordId)||!['create','revise','review','approve','withdraw-approval'].includes(op.kind)||!Number.isInteger(op.baseVersion)||op.baseVersion<0||Object.keys(op).some(k=>!['id','recordId','kind','baseVersion','fields','text'].includes(k)))throw Error('Invalid contract mutation.');
   if(['create','revise'].includes(op.kind)){fields=contractFields(op.fields);if(fields.intentionId){if(!validateLink)throw Error('Intention linking unavailable.');await validateLink(fingerprint,request.projectId,request.contextId,fields.intentionId);}}
   else if(typeof op.text!=='string'||op.text.length>1000||(op.kind==='review'&&!op.text.trim()))throw Error('Review text must be at most 1000 characters.');
  }
  return collaboration.withContentAuthority(fingerprint,request.projectId,request.contextId,async auth=>{
   const data=await load();let scope=data.scopes.find(s=>s.projectId===request.projectId&&s.contextId===request.contextId),dirty=false;
   if(!scope){scope={projectId:request.projectId,...(request.contextId?{contextId:request.contextId}:{}),revision:0,records:[],operations:[]};data.scopes.push(scope);dirty=true;}
   const eligible=new Set([auth.principalId,...auth.recipients.map(p=>p.id)]),writers=new Set(auth.writers),stamp=()=>new Date(now()).toISOString();
   const advance=record=>{record.revision=++scope.revision;record.version++;record.updatedAt=stamp();dirty=true;};
   const approval=record=>record.authorActive&&record.reviews.some(r=>r.kind==='approve'&&r.active&&r.contentVersion===record.contentVersion)?'approved':'published';
   for(const record of scope.records){let changed=false;if(record.authorActive&&!eligible.has(record.participantId)){record.authorActive=false;changed=true;}for(const review of record.reviews)if(review.active&&!writers.has(review.participantId)){review.active=false;changed=true;}const status=approval(record);if(record.status!==status){record.status=status;changed=true;}if(changed)advance(record);}
   if(dirty)await save(data);
   if(request.action==='contract-sync'){
    if(!Number.isInteger(request.since)||request.since<0||(request.epoch!==undefined&&!intentId(request.epoch)))throw Error('Invalid contract cursor.');const reset=request.epoch!==data.epoch||request.since>scope.revision,records=[];let bytes=0;const candidates=scope.records.filter(r=>reset||r.revision>request.since).sort((a,b)=>a.revision-b.revision);
    for(const record of candidates){const size=Buffer.byteLength(JSON.stringify(record));if(records.length&&size+bytes>128*1024)break;records.push(record);bytes+=size;}
    const more=records.length<candidates.length;return{version:1,epoch:data.epoch,revision:more?records.at(-1).revision:scope.revision,reset,more,principalId:auth.principalId,canWrite:auth.canWrite,records};
   }
   if(!auth.canWrite)throw Error('Contract publication/review requires current member permission.');
   const normalized={id:op.id,recordId:op.recordId,kind:op.kind,baseVersion:op.baseVersion,...(fields?{fields}:{text:op.text.trim()})},hash=createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),prior=scope.operations.find(p=>p.id===op.id);
   if(prior){if(prior.actor!==auth.principalId||prior.hash!==hash)throw Error('Operation ID already bound.');return{accepted:true,id:op.recordId};}
   let record=scope.records.find(r=>r.id===op.recordId);
   if(record&&fields&&record.participantId!==auth.principalId)throw Error('Only the publisher may edit a contract.');
   if((!record&&op.kind!=='create')||(record&&op.kind==='create')||(record&&record.version!==op.baseVersion)||(!record&&op.baseVersion!==0))return{conflict:true,current:null};
   if(data.scopes.reduce((n,s)=>n+s.operations.length,0)>=5000)throw Error('Contract operation capacity reached; archival required.');
   if(!record){if(scope.records.length>=100||data.scopes.reduce((n,s)=>n+s.records.length,0)>=1000)throw Error('Contract capacity reached.');record={schemaVersion:1,id:op.recordId,projectId:scope.projectId,...(scope.contextId?{contextId:scope.contextId}:{}),participantId:auth.principalId,displayName:auth.displayName,createdAt:stamp(),updatedAt:stamp(),version:0,revision:0,contentVersion:0,status:'published',authorActive:true,history:[],reviews:[],fields};scope.records.push(record);}
   if(fields){if(record.history.length>=20)throw Error('Maximum 20 content versions; publish a successor contract.');if(record.contentVersion&&fields.side!==record.fields.side)throw Error('Expected/implemented role cannot change; publish a separate contract.');if(record.history.some(h=>h.fields.document.info.version===fields.document.info.version))throw Error('Use a new OpenAPI info.version for each content revision.');record.contentVersion++;record.fields=fields;record.authorActive=true;record.history.push({contentVersion:record.contentVersion,actorId:auth.principalId,at:stamp(),fields:structuredClone(fields)});}
   else{
    if(record.reviews.length>=40)throw Error('Review history capacity reached.');
    if(op.kind==='approve'&&record.participantId===auth.principalId)throw Error('Approval requires a different authorized participant.');
    if(op.kind==='approve'&&!record.authorActive)throw Error('The publisher no longer has scope access.');
    if(op.kind==='withdraw-approval'||op.kind==='approve')for(const review of record.reviews)if(review.kind==='approve'&&review.participantId===auth.principalId&&review.contentVersion===record.contentVersion)review.active=false;
    record.reviews.push({kind:op.kind,participantId:auth.principalId,displayName:auth.displayName,text:op.text.trim(),contentVersion:record.contentVersion,at:stamp(),active:true});
   }
   record.status=approval(record);advance(record);scope.operations.push({id:op.id,actor:auth.principalId,recordId:record.id,hash});await save(data);return{accepted:true,id:record.id};
  });
 }};
}
