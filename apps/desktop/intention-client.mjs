import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {intentId,intentFields,validIntent} from '../../packages/core/intentions.mjs';
import {regularFile,writeAtomic} from './secure-content-store.mjs';
import {validateTarget,retryDelay} from './delivery-queue.mjs';
const bindingKey=(project,target)=>JSON.stringify([project,target.mode,target.fingerprint??null,target.projectId,target.contextId??null]);
const intentionModel={validateRecord:validIntent,validateFields:intentFields,kinds:['create','revise','resolve','cancel','acknowledge','coordinate'],fieldKinds:['create','revise'],sharedKinds:['coordinate','acknowledge'],textKinds:['coordinate','acknowledge'],requiredTextKinds:['coordinate'],textLimit:400,prefix:'intent'};
export function createIntentionClient(file,{protection,authorize,execute,now=Date.now,model=intentionModel}){
 let pending=Promise.resolve(),backgroundError='';const serial=fn=>{const result=pending.then(fn).catch(error=>{if(model.prefix!=='intent'&&error instanceof Error)error.message=error.message.replace(/intention/gi,model.prefix);throw error;});pending=result.catch(()=>{});return result;};
 async function load(){try{if((await regularFile(file)).size>32*1024*1024)throw Error();const envelope=JSON.parse(await fs.readFile(file,'utf8'));if(envelope.version!==1)throw Error();const data=JSON.parse(protection.open(envelope.sealed));if(data.version!==1||!Array.isArray(data.bindings)||data.bindings.length>30)throw Error();const keys=new Set();for(const item of data.bindings){validateTarget(item.target,item.localProjectId);if(!intentId(item.localProjectId)||!intentId(item.id)||keys.has(bindingKey(item.localProjectId,item.target))||!Number.isInteger(item.revision)||item.revision<0||!Array.isArray(item.records)||item.records.length>100||!Array.isArray(item.pending)||item.pending.length>100||!Number.isFinite(item.nextAt)||!Number.isInteger(item.attempts)||item.attempts<0||typeof item.blocked!=='boolean'||typeof item.canWrite!=='boolean'||(item.epoch!==undefined&&!intentId(item.epoch))||(item.principalId!==undefined&&!intentId(item.principalId)))throw Error();keys.add(bindingKey(item.localProjectId,item.target));for(const record of item.records){model.validateRecord(record);if(record.projectId!==item.target.projectId||record.contextId!==item.target.contextId)throw Error();}for(const change of item.pending)if(!intentId(change.epoch)||!intentId(change.operation?.id)||!intentId(change.operation?.recordId)||!['pending','conflict','failed'].includes(change.state))throw Error();}return data;}catch(error){if(error.code==='ENOENT')return{version:1,bindings:[]};throw Error('Protected intention cache is corrupt or unavailable. Original changes are preserved.');}}
 async function save(data){const folder=path.dirname(file);await fs.mkdir(folder,{recursive:true});if((await fs.lstat(folder)).isSymbolicLink())throw Error('Unsafe intention cache.');const text=JSON.stringify(data);if(Buffer.byteLength(text)>8*1024*1024)throw Error('Intention offline cache capacity reached.');await writeAtomic(file,{version:1,sealed:protection.seal(text)});}
 const find=(data,projectId,id)=>{const item=data.bindings.find(b=>b.localProjectId===projectId&&b.id===id);if(!item)throw Error('Intention scope access denied.');return item;};
 const view=item=>({id:item.id,records:item.blocked?[]:item.records,pending:item.pending,principalId:item.principalId,canWrite:item.canWrite&&!item.blocked&&!item.more,lastSync:item.lastSync,error:backgroundError||item.error,blocked:item.blocked,revision:item.revision,nextAt:item.nextAt});
 function apply(item,reply){
  if(!reply||reply.version!==1||!intentId(reply.epoch)||!intentId(reply.principalId)||typeof reply.canWrite!=='boolean'||typeof reply.reset!=='boolean'||typeof reply.more!=='boolean'||!Number.isInteger(reply.revision)||reply.revision<0||!Array.isArray(reply.records)||reply.records.length>100||(!reply.reset&&(reply.epoch!==item.epoch||reply.revision<item.revision)))throw Error('Invalid intention state exchange.');
  const merged=new Map(reply.reset?[]:item.records.map(r=>[r.id,r])),ids=new Set();
  for(const record of reply.records){model.validateRecord(record);if(record.projectId!==item.target.projectId||record.contextId!==item.target.contextId||record.revision>reply.revision||ids.has(record.id)||(!reply.reset&&record.revision<=item.revision))throw Error('Intention response crosses scope or revision boundary.');ids.add(record.id);merged.set(record.id,record);}
  if(merged.size>100)throw Error('Intention scope capacity exceeded.');
  item.more=reply.more;item.records=[...merged.values()];item.epoch=reply.epoch;item.revision=reply.revision;item.principalId=reply.principalId;item.canWrite=reply.canWrite;item.lastSync=now();item.blocked=false;
 }
 return {
  local:(projectId,action,payload)=>serial(async()=>{
   await authorize(projectId);const data=await load();
   if(action==='attach'){
    validateTarget(payload.target,projectId);await authorize(projectId,payload.target);let item=data.bindings.find(b=>bindingKey(b.localProjectId,b.target)===bindingKey(projectId,payload.target));
    if(!item){if(data.bindings.length>=30)throw Error('Intention connection limit reached.');item={id:randomUUID(),localProjectId:projectId,target:payload.target,revision:0,records:[],pending:[],nextAt:0,attempts:0,blocked:false,canWrite:false,lastSync:null,error:'Waiting for initial authenticated state exchange.'};data.bindings.push(item);}
    else {item.target=payload.target;item.nextAt=0;item.attempts=0;}
    await save(data);return view(item);
   }
   const item=find(data,projectId,payload.id);await authorize(projectId,item.target);
   if(action==='view')return view(item);
   if(action==='refresh'){item.nextAt=0;item.attempts=0;item.error='Checking current access…';}
   else if(action==='submit'){
    if(!item.principalId||!item.canWrite||item.blocked||item.more)throw Error('An initial authorized member exchange is required before editing intentions.');
    const op=payload.operation;if(!op||!intentId(op.recordId)||!model.kinds.includes(op.kind))throw Error('Invalid intention action.');
    if(item.pending.some(p=>p.operation.recordId===op.recordId))throw Error('Review or discard the pending edit for this intention first.');
    if(item.pending.length>=100)throw Error('Pending intention limit reached.');
    const current=item.records.find(r=>r.id===op.recordId);if(op.kind==='create'?Boolean(current):!current)throw Error('Intention does not match the selected scope.');
    if(current&&!model.sharedKinds.includes(op.kind)&&current.participantId!==item.principalId)throw Error('Only the author may change this intention.');
    // Version comes from the form, not an implicit rebase to a newer cached revision.
    if(!Number.isInteger(op.baseVersion)||op.baseVersion!==(current?.version??0))throw Error('Intention changed while editing. Review its current version before submitting.');
    model.validateChange?.(current,op,item.principalId);
    const operation={id:randomUUID(),recordId:op.recordId,kind:op.kind,baseVersion:op.baseVersion};
    if(model.fieldKinds.includes(op.kind))operation.fields=model.validateFields(op.fields);
    if(model.textKinds.includes(op.kind)){if(typeof op.text!=='string'||op.text.length>model.textLimit||(model.requiredTextKinds.includes(op.kind)&&!op.text.trim()))throw Error(`Add a message up to ${model.textLimit} characters.`);operation.text=op.text.trim();}
    item.pending.push({operation,epoch:item.epoch,state:'pending',error:''});item.nextAt=0;
   }else if(action==='discard'){
    // Discard is local only. An unacknowledged network submission may already have been accepted.
    item.pending=item.pending.filter(p=>p.operation.id!==payload.operationId);item.nextAt=0;
   }else if(action==='rebase'){
    if(!item.canWrite||item.blocked||item.more||now()-item.lastSync>30000)throw Error('Refresh authorized state before rebasing a conflict.');
    const change=item.pending.find(p=>p.operation.id===payload.operationId),current=change&&item.records.find(r=>r.id===change.operation.recordId);
    if(!change||change.state!=='conflict'||!current||payload.version!==current.version||change.operation.kind==='create')throw Error('Review the latest intention before rebasing.');
    model.validateChange?.(current,change.operation,item.principalId);
    change.operation={...change.operation,id:randomUUID(),baseVersion:current.version};change.epoch=item.epoch;change.state='pending';change.error='';item.nextAt=0;
   }else throw Error('Unsupported intention client operation.');
   await save(data);return view(item);
  }),
  tick:(bindingId)=>serial(async()=>{
   const data=await load(),item=data.bindings.filter(b=>b.nextAt<=now()&&(!bindingId||b.id===bindingId)).sort((a,b)=>a.nextAt-b.nextAt)[0];if(!item)return;
   try{
    await authorize(item.localProjectId,item.target);const call=command=>execute(item.localProjectId,item.target,command);
    apply(item,await call({action:model.prefix+'-sync',since:item.revision,...(item.epoch?{epoch:item.epoch}:{})}));
    const change=!item.more&&item.pending.find(p=>p.state==='pending');
    if(change){
     if(change.epoch!==item.epoch){change.state='conflict';change.error='Host history changed. Review the restored state before explicitly rebasing or creating a new intention.';}
     else if(!item.canWrite){change.state='failed';change.error='Member permission is no longer available. Draft preserved; discard or review after reauthorization.';}
     else {
      const result=await call({action:model.prefix+'-mutate',operation:change.operation});
      if(result?.accepted===true&&result.id===change.operation.recordId)item.pending=item.pending.filter(p=>p!==change);
      else if(result?.conflict===true){change.state='conflict';change.error='A newer revision exists. Review and explicitly rebase, or discard this edit.';}
      else throw Error('Invalid intention mutation receipt.');
      apply(item,await call({action:model.prefix+'-sync',since:item.revision,epoch:item.epoch}));
     }
    }
    item.error=item.more?'Receiving remaining authorized activity; collision checks are incomplete.':'';item.attempts=0;item.nextAt=now()+(item.more||item.pending.some(p=>p.state==='pending')?1000:15000);
   }catch(error){
    item.attempts++;const transient=/Secure connection (?:failed|timed out|closed)/.test(error.message);item.error=String(error.message).slice(0,400);
    if(transient){item.error+=' Offline changes are retained; cached activity is not live.';item.nextAt=now()+retryDelay(item.attempts);}
    else {item.blocked=true;item.canWrite=false;item.records=[];item.revision=0;delete item.epoch;item.error+=' Access/state blocked. Drafts retained; check permissions and refresh.';item.nextAt=Number.MAX_SAFE_INTEGER;}
   }
   try{await save(data);backgroundError='';}catch(error){backgroundError='Unable to persist intention synchronization. '+error.message;throw error;}
  }),
 };
}
