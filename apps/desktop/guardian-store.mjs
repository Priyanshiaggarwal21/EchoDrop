import {guardianSourceRevision} from './guardian-authority.mjs';
import {validateInventoryView} from '../../packages/core/dependency-inventory.mjs';
import {assessExecutionReadiness} from './guardian-readiness.mjs';
import {CONSENT_ACTIONS} from '../../packages/core/guardian-approvals.mjs';
import {approvalDigest,reconcileApprovals,mutateApproval} from './guardian-approvals.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {regularFile,writeAtomic} from './secure-content-store.mjs';
import {intentId} from '../../packages/core/intentions.mjs';
import {assessHandover,validPlan,APPROVALS,PROPOSED_ACTIONS} from '../../packages/core/guardian.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const authorityKey=a=>a.authorityRevision?guardianSourceRevision(a):hash({members:a.members,contexts:a.contexts,hiddenContexts:a.hiddenContexts,localPrincipalId:a.localPrincipalId});
const evidence=s=>({transfers:s.transfers.map(t=>({id:t.id,senderId:t.senderId,recipientId:t.recipientId,state:t.state,delivery:t.delivery??null,archivedAt:t.archivedAt??null})).sort((a,b)=>a.id.localeCompare(b.id)),queue:s.queue.map(j=>({id:j.id,senderId:j.senderId,recipientId:j.recipientId,state:j.state,cancelPending:j.cancelPending})).sort((a,b)=>a.id.localeCompare(b.id)),queueKnown:s.queueKnown,...(s.inventory?{inventory:{complete:false,devices:s.inventory.devices}}:{})});
export function createGuardianStore(file,collaboration,{protection,collect,now=Date.now}){
 let pending=Promise.resolve();const serial=fn=>{const p=pending.then(fn);pending=p.catch(()=>{});return p;};
 async function load(){try{if((await regularFile(file)).size>16*1024*1024)throw Error();const e=JSON.parse(await fs.readFile(file,'utf8'));if(e.version!==1)throw Error();const d=JSON.parse(protection.open(e.sealed));if(d.version!==1||!Array.isArray(d.plans)||d.plans.length>500||!Array.isArray(d.operations)||d.operations.length>2000)throw Error();const ids=new Set(),ops=new Set();for(const p of d.plans){validPlan(p);for(const a of p.authorizations??[]){if(a.digest!==approvalDigest(a.snapshot))throw Error();if(a.snapshot.planVersion===p.version&&(['departingId','successorId','initiatorId','proposal','guard'].some(k=>a.snapshot[k]!==p[k])||JSON.stringify(a.snapshot.actions)!==JSON.stringify(p.actions)))throw Error();}if(ids.has(p.id))throw Error();ids.add(p.id);}for(const o of d.operations){if(Object.keys(o).some(k=>!['id','actorId','planId','hash'].includes(k))||!intentId(o.id)||!intentId(o.actorId)||!ids.has(o.planId)||!/^[a-f0-9]{64}$/.test(o.hash)||ops.has(o.id))throw Error();ops.add(o.id);}return d;}catch(e){if(e.code==='ENOENT')return{version:1,plans:[],operations:[]};throw Error('Guardian storage corrupt or unavailable. Original plans preserved.');}}
 async function save(d){const text=JSON.stringify(d);if(Buffer.byteLength(text)>8*1024*1024)throw Error('Guardian capacity reached. Existing plans preserved.');await fs.mkdir(path.dirname(file),{recursive:true});if((await fs.lstat(path.dirname(file))).isSymbolicLink())throw Error('Unsafe Guardian storage.');await writeAtomic(file,{version:1,sealed:protection.seal(text)});}
 const run=(fp,q,observation=false)=>serial(async()=>{
  if(q?.version!==1||!['guardian-list','guardian-create','guardian-review','guardian-update','guardian-cancel',...CONSENT_ACTIONS].includes(q.action)||!intentId(q.projectId)||(q.contextId!==undefined&&!intentId(q.contextId))||Object.keys(q).some(k=>!['version','action','projectId','contextId','since','operation'].includes(k)))throw Error('Invalid Guardian request.');
  if(q.since!==undefined&&(!Number.isSafeInteger(q.since)||q.since<0))throw Error('Invalid Guardian cursor.');if(q.action==='guardian-list'&&q.operation!==undefined)throw Error('Read cannot contain an operation.');
  const initial=await collaboration.withGuardianAuthority(fp,q.projectId,q.contextId,a=>a);
  if(!initial.canPlan){if(observation)return [];const existing=await load();if(!initial.canContribute||!['guardian-list','guardian-accept','guardian-decline'].includes(q.action)||!existing.plans.some(p=>p.projectId===q.projectId&&p.contextId===q.contextId&&p.successorId===initial.principalId&&p.authorizations?.length))throw Error('Guardian planning requires current owner/admin authority or an authenticated successor request.');}
  const collected=await collect(fp,q,initial);if(collected.inventory)validateInventoryView(collected.inventory,q);if(collected.bindingSources?.inventory)validateInventoryView(collected.bindingSources.inventory,q);const sources=evidence(collected),bindingSources=evidence(collected.bindingSources??collected);
  return collaboration.withGuardianAuthority(fp,q.projectId,q.contextId,async auth=>{
   if(auth.canPlan!==initial.canPlan||auth.principalId!==initial.principalId||authorityKey(auth)!==authorityKey(initial))throw Error('Guardian authority changed during collection. Refresh before planning.');
   const d=await load(),guard=hash([authorityKey(auth),bindingSources]);let dirty=false;
   const visible=new Set([...auth.members.map(m=>'membership:'+m.id),...auth.contexts.map(c=>'context:'+c.id),...sources.transfers.map(t=>'transfer:'+t.id),...sources.queue.map(t=>'queue:'+t.id)]);
   const scoped=p=>p.projectId===q.projectId&&p.contextId===q.contextId;
   const readable=p=>scoped(p)&&(auth.canPlan||p.successorId===auth.principalId&&p.authorizations?.length)&&p.assessment.risks.every(r=>r.refs.every(ref=>visible.has(ref.source+':'+ref.id)));
   const stamp=p=>{if(p.history.length>=50)throw Error('Plan history capacity reached. Create a new plan; original history preserved.');p.updatedAt=new Date(Math.max(now(),Date.parse(p.updatedAt))).toISOString();p.version++;p.history.push({version:p.version,at:p.updatedAt,actorId:auth.principalId,status:p.status,blocked:p.assessment.risks.filter(r=>r.state==='BLOCKED').length,unknown:p.assessment.risks.filter(r=>r.state==='UNKNOWN').length});validPlan(p);dirty=true;};
   // Inaccessible evidence never gets replaced by an empty, apparently safe assessment.
   for(const p of d.plans.filter(readable))if(p.status!=='cancelled'&&p.observedGuard!==guard){p.status='stale';p.assessment=assessHandover(auth,sources,p);p.observedGuard=guard;stamp(p);}
   for(const p of d.plans.filter(p=>scoped(p)&&(auth.canPlan||p.successorId===auth.principalId))){const relevant=auth.local||p.authorizations?.some(a=>[a.requesterId,a.snapshot.successorId,...a.decisions.map(d=>d.actorId)].includes(auth.principalId));if(reconcileApprovals(p,guard,auth,!relevant||readable(p),now()))dirty=true;}
   if(CONSENT_ACTIONS.includes(q.action)){
    if(dirty)await save(d); // Persist expiry/invalidation even when the attempted consent is rejected.
    const o=q.operation,p=d.plans.find(p=>p.id===o?.planId);if(!p||!readable(p)||!intentId(o?.id))throw Error('Authorization plan or evidence unavailable.');
    if(d.operations.some(x=>x.id===o.id))throw Error('Authorization operation replay rejected.');
    if(d.operations.length>=2000)throw Error('Guardian operation capacity reached.');
    mutateApproval(p,q,auth,guard,now());validPlan(p);d.operations.push({id:o.id,actorId:auth.principalId,planId:p.id,hash:hash([q.projectId,q.contextId??null,q.action,o])});dirty=true;
   }else if(q.action!=='guardian-list'){
    if(!auth.canPlan)throw Error('Administrator planning authority required.');
    const o=q.operation;if(!o||Object.keys(o).some(k=>!['id','planId','baseVersion','departingId','successorId','proposal','actions'].includes(k))||!intentId(o.id)||!intentId(o.planId)||!Number.isInteger(o.baseVersion)||o.baseVersion<0)throw Error('Invalid Guardian operation.');
    if(['guardian-review','guardian-cancel'].includes(q.action)&&Object.keys(o).some(k=>!['id','planId','baseVersion'].includes(k)))throw Error('Invalid review or cancel fields.');
    const digest=hash([q.projectId,q.contextId??null,q.action,o]),prior=d.operations.find(x=>x.id===o.id);let p=d.plans.find(x=>x.id===o.planId);
    if(prior){if(prior.actorId!==auth.principalId||prior.hash!==digest||!p||!readable(p))throw Error('Guardian replay binding or source access denied.');}
    else{
     if(d.operations.length>=2000)throw Error('Guardian operation capacity reached.');
     if(q.action==='guardian-create'){
      if(p||o.baseVersion!==0||d.plans.length>=500||d.plans.filter(scoped).length>=100)throw Error('Plan ID already bound or plan capacity reached.');
      const at=new Date(now()).toISOString();p={schemaVersion:1,id:o.planId,projectId:q.projectId,...(q.contextId?{contextId:q.contextId}:{}),initiatorId:auth.principalId,createdAt:at,updatedAt:at,version:0,history:[]};
     }else if(!p||!readable(p))throw Error('Plan or its evidence is not accessible.');
     // A stale transition itself increments the version; return it for explicit review, never rebase implicitly.
     if(q.action!=='guardian-create'&&p.version!==o.baseVersion){if(dirty)await save(d);throw Error('Plan changed or became stale. Refresh, inspect current evidence and update the plan.');}
     if(p.status==='cancelled')throw Error('Cancelled plans cannot be updated.');
     if(['guardian-create','guardian-update'].includes(q.action)){
      if(!intentId(o.departingId)||(o.successorId!==undefined&&!intentId(o.successorId))||!['remove-membership','revoke-access','step-down'].includes(o.proposal)||!Array.isArray(o.actions)||!o.actions.length||o.actions.some(a=>!PROPOSED_ACTIONS.includes(a))||new Set(o.actions).size!==o.actions.length)throw Error('Invalid proposed handover.');
      if(auth.role!=='owner'&&auth.members.some(m=>[o.departingId,o.successorId].includes(m.id)&&['owner','admin'].includes(m.role)))throw Error('Only a current owner can plan changes involving administrative roles.');
      Object.assign(p,{departingId:o.departingId,proposal:o.proposal,actions:[...o.actions],approvals:[...APPROVALS],guard,observedGuard:guard,status:'draft'});delete p.successorId;if(o.successorId)p.successorId=o.successorId;
     }else if(auth.role!=='owner'&&auth.members.some(m=>[p.departingId,p.successorId].includes(m.id)&&['owner','admin'].includes(m.role)))throw Error('Owner review required for administrative responsibilities.');
     p.assessment=assessHandover(auth,sources,p);
     if(q.action==='guardian-review')p.status=p.guard!==guard?'stale':p.assessment.state==='BLOCKED'?'blocked':'ready-for-review';
     if(q.action==='guardian-cancel')p.status='cancelled';
     stamp(p);if(q.action==='guardian-create')d.plans.push(p);d.operations.push({id:o.id,actorId:auth.principalId,planId:p.id,hash:digest});dirty=true;
    }
   }
   for(const p of d.plans.filter(p=>scoped(p)&&(auth.canPlan||p.successorId===auth.principalId))){const relevant=auth.local||p.authorizations?.some(a=>[a.requesterId,a.snapshot.successorId,...a.decisions.map(d=>d.actorId)].includes(auth.principalId));if(reconcileApprovals(p,guard,auth,!relevant||readable(p),now()))dirty=true;}
   if(dirty)await save(d);
   const records=d.plans.filter(readable).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
   if(observation)return records;
   const since=q.since??0;if(!Number.isSafeInteger(since)||since<0)throw Error('Invalid Guardian cursor.');
   return{version:1,...(collected.inventory?{inventory:collected.inventory}:{}),recoveryEvidence:collected.recoveryEvidence??[],principalId:auth.principalId,canPlan:auth.canPlan,members:auth.members.filter(m=>auth.canPlan||m.id===auth.principalId).map(({id,role,status,usable})=>({id,role,status,usable})),records:records.slice(since,since+25),readiness:records.slice(since,since+25).map(p=>assessExecutionReadiness(p,auth,sources,guard,now())),next:Math.min(since+25,records.length),more:records.length>since+25};
  });
 });
 return{handle:(fp,q)=>run(fp,q),observations:(fp,q)=>run(fp,{version:1,action:'guardian-list',projectId:q.projectId,...(q.contextId?{contextId:q.contextId}:{})},true)};
}
