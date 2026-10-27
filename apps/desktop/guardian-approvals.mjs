import {createHash,randomUUID} from 'node:crypto';
import {intentId} from '../../packages/core/intentions.mjs';
export const approvalDigest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function event(a,kind,status,actorId,now){if(a.history.length>=10)throw Error('Authorization audit capacity reached.');const at=new Date(Math.max(now,Date.parse(a.updatedAt))).toISOString();a.status=status;a.updatedAt=at;a.version++;a.history.push({version:a.version,kind,status,actorId,at});}
export function reconcileApprovals(p,guard,auth,visible,now){let changed=false;for(const a of p.authorizations??[]){if(!['pending','consent-complete'].includes(a.status))continue;let state,kind;
 if(p.status==='cancelled'){state='cancelled';kind='cancel';}
 else if(!visible||a.snapshot.guard!==guard||a.snapshot.planVersion!==p.version||['stale','draft'].includes(p.status)){state='stale';kind='invalidate';}
 else if(now>=Date.parse(a.expiresAt)){state='expired';kind='expire';}
 if(state){event(a,kind,state,auth.principalId,now);changed=true;}
 }return changed;}
export function mutateApproval(p,q,auth,guard,now){
 const o=q.operation;if(!o||Object.keys(o).some(k=>!['id','planId','baseVersion','authorizationId','authorizationVersion','digest','expiresInMinutes'].includes(k))||!intentId(o.id)||o.planId!==p.id||o.baseVersion!==p.version)throw Error('Invalid or stale authorization operation.');
 if(p.guard!==guard||!['ready-for-review','blocked'].includes(p.status))throw Error('Review a current plan before requesting or recording consent.');
 const successor=auth.members.find(m=>m.id===p.successorId&&m.status==='active'&&m.usable&&m.role!=='guest');if(!successor||p.successorId===p.departingId)throw Error('Intended successor lacks current authenticated scope access.');
 if(q.action==='guardian-request-approval'){
  if(!auth.canPlan||Object.keys(o).some(k=>!['id','planId','baseVersion','expiresInMinutes'].includes(k)))throw Error('Administrator authority required to request approval.');
  if(auth.role!=='owner'&&auth.members.some(m=>[p.departingId,p.successorId].includes(m.id)&&['owner','admin'].includes(m.role)))throw Error('An owner must request administrative-role changes.');
  p.authorizations??=[];if(p.authorizations.length>=10||p.authorizations.some(a=>['pending','consent-complete'].includes(a.status)))throw Error('An authorization already exists or the plan reached its authorization limit.');
  const minutes=o.expiresInMinutes??60;if(!Number.isInteger(minutes)||minutes<5||minutes>1440)throw Error('Authorization expiry must be 5–1440 minutes.');
  const snapshot={planId:p.id,projectId:p.projectId,...(p.contextId?{contextId:p.contextId}:{}),planVersion:p.version,initiatorId:p.initiatorId,departingId:p.departingId,successorId:p.successorId,proposal:p.proposal,actions:[...p.actions],guard,riskCodes:p.assessment.risks.map(r=>r.code)};
  const at=new Date(now).toISOString(),a={schemaVersion:1,id:randomUUID(),snapshot,digest:approvalDigest(snapshot),requesterId:auth.principalId,requesterBinding:auth.identityBinding,createdAt:at,expiresAt:new Date(now+minutes*60000).toISOString(),updatedAt:at,version:0,status:'pending',decisions:[],history:[]};event(a,'request','pending',auth.principalId,now);p.authorizations.push(a);return;
 }
 if(Object.keys(o).some(k=>!['id','planId','baseVersion','authorizationId','authorizationVersion','digest'].includes(k)))throw Error('Unexpected decision fields.');
 const a=p.authorizations?.at(-1);if(!a||a.id!==o.authorizationId||a.version!==o.authorizationVersion||a.digest!==o.digest||a.status!=='pending'||now>=Date.parse(a.expiresAt))throw Error('Authorization is stale, expired, already decided or unavailable.');
 const kind=q.action.slice(9),admin=['approve','reject'].includes(kind);if(!['approve','reject','accept','decline'].includes(kind))throw Error('Unsupported consent action.');
 if(admin){if(!auth.canPlan||[a.requesterId,p.initiatorId,p.departingId,p.successorId].includes(auth.principalId))throw Error('An independent current administrator must decide.');if(auth.role!=='owner'&&auth.members.some(m=>[p.departingId,p.successorId].includes(m.id)&&['owner','admin'].includes(m.role)))throw Error('Independent owner approval required for administrative-role changes.');}
 else if(!auth.canContribute||auth.principalId!==a.snapshot.successorId)throw Error('Only the authenticated intended successor may accept or decline.');
 if(a.decisions.some(d=>d.actorId===auth.principalId||(['approve','reject'].includes(d.kind)===admin)))throw Error('Duplicate principal or decision.');
 const at=new Date(now).toISOString();a.decisions.push({id:o.id,actorId:auth.principalId,identityBinding:auth.identityBinding,kind,at});
 const status=kind==='reject'?'rejected':kind==='decline'?'declined':a.decisions.some(d=>d.kind==='approve')&&a.decisions.some(d=>d.kind==='accept')?'consent-complete':'pending';event(a,kind,status,auth.principalId,now);
}
