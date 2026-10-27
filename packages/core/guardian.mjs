import {validateInventoryView} from './dependency-inventory.mjs';
import {validateRecoveryEvidence} from './recovery-evidence.mjs';
import {validateReadiness} from './guardian-readiness.mjs';
import {validAuthorization} from './guardian-approvals.mjs';
import {intentId} from './intentions.mjs';
export const PLAN_STATUSES=['draft','ready-for-review','blocked','cancelled','stale'];
export const PROPOSED_ACTIONS=['establish-successor-authority','obtain-successor-acceptance','settle-pending-deliveries','review-protected-contexts','review-access-dependencies'];
export const APPROVALS=['current-owner-review','successor-acceptance','fresh-authority-check'];
export const RISK_TEXT={
 'last-owner':'Departure would remove the final active owner in this scope.',
 'last-administrator':'Departure would leave no other effective administrator in this scope.',
 'protected-context':'Departure would orphan an accessible protected context.',
 'local-owner-invariant':'Current registry requires the local administrator to remain project owner. Task 16A cannot change this invariant.',
 'departing-unavailable':'Departing participant is no longer an active member of this scope.',
 'successor-missing':'Choose a different active successor in this scope.',
 'successor-ineligible':'Successor is absent, removed, a guest, or lacks current authenticated contributor access.',
 'successor-role':'Successor does not currently hold the proposed administrative responsibility.',
 'pending-transfer':'A pending transfer or incomplete save still involves the departing participant.',
 'pending-queue':'A private local delivery job still involves the departing participant.',
 'saved-copy':'A recorded delivery/save exists. Later access withdrawal cannot revoke already downloaded copies.',
 'restricted-contexts':'Some protected context dependencies cannot be inspected in this view.',
 'other-device-queues':'Other devices’ private queues and offline responsibilities cannot be verified.',
 'private-queue-unknown':'This view cannot inspect the host’s private delivery queue.',
 'access-dependencies':'External access dependencies and recovery capabilities are not verified by this milestone.'
};
export function assessHandover(authority,sources,proposal){
 const risks=[],add=(code,state,refs=[])=>risks.push({code,state,refs});
 const active=authority.members.filter(m=>m.status==='active'),departing=active.find(m=>m.id===proposal.departingId),successor=active.find(m=>m.id===proposal.successorId);
 if(!departing)add('departing-unavailable','BLOCKED');
 if(departing?.role==='owner'&&!active.some(m=>m.id!==departing.id&&m.role==='owner'))add('last-owner','BLOCKED',[{source:'membership',id:departing.id}]);
 if(departing&&['owner','admin'].includes(departing.role)&&!active.some(m=>m.id!==departing.id&&['owner','admin'].includes(m.role)&&['owner','admin'].includes(m.projectRole)&&m.usable))add('last-administrator','BLOCKED',[{source:'membership',id:departing.id}]);
 if(!proposal.contextId&&departing?.id===authority.localPrincipalId)add('local-owner-invariant','BLOCKED',[{source:'membership',id:departing.id}]);
 for(const c of authority.contexts)if(c.owners.includes(proposal.departingId)&&c.owners.every(id=>id===proposal.departingId))add('protected-context','BLOCKED',[{source:'context',id:c.id}]);
 if(!proposal.successorId||proposal.successorId===proposal.departingId)add('successor-missing','BLOCKED');
 else if(!successor||successor.role==='guest'||!successor.usable)add('successor-ineligible','BLOCKED');
 else if(departing&&['owner','admin'].includes(departing.role)&&!(departing.role==='owner'?successor.role==='owner':['owner','admin'].includes(successor.role)))add('successor-role','BLOCKED');
 for(const t of sources.transfers){if(![t.senderId,t.recipientId].includes(proposal.departingId))continue;
  if(t.delivery==='Applied'||t.delivery==='Delivered')add('saved-copy','UNKNOWN',[{source:'transfer',id:t.id}]);
  if(t.state!=='cancelled'&&t.delivery!=='Applied')add('pending-transfer','BLOCKED',[{source:'transfer',id:t.id}]);
 }
 for(const j of sources.queue)if([j.senderId,j.recipientId].includes(proposal.departingId)&&(!['Applied','Cancelled'].includes(j.state)||j.cancelPending))add('pending-queue','BLOCKED',[{source:'queue',id:j.id}]);
 if(authority.hiddenContexts)add('restricted-contexts','UNKNOWN');
 if(!sources.queueKnown)add('private-queue-unknown','UNKNOWN');
 add('other-device-queues','UNKNOWN');add('access-dependencies','UNKNOWN');
 if(risks.length>500)throw Error('Guardian evidence capacity exceeded.');
 return {state:risks.some(r=>r.state==='BLOCKED')?'BLOCKED':risks.some(r=>r.state==='UNKNOWN')?'UNKNOWN':'SAFE',risks};
}
const keys=(x,allowed)=>{if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!allowed.includes(k)))throw Error('Invalid Guardian fields.');};
const date=x=>typeof x==='string'&&Number.isFinite(Date.parse(x));
export function validPlan(p){
 keys(p,['schemaVersion','id','projectId','contextId','initiatorId','departingId','successorId','proposal','actions','approvals','guard','observedGuard','version','status','assessment','createdAt','updatedAt','history','authorizations']);
 if(p.schemaVersion!==1||!['id','projectId','initiatorId','departingId'].every(k=>intentId(p[k]))||(p.contextId!==undefined&&!intentId(p.contextId))||(p.successorId!==undefined&&!intentId(p.successorId))||!['remove-membership','revoke-access','step-down'].includes(p.proposal)||!Array.isArray(p.actions)||!p.actions.length||p.actions.some(x=>!PROPOSED_ACTIONS.includes(x))||new Set(p.actions).size!==p.actions.length||JSON.stringify(p.approvals)!==JSON.stringify(APPROVALS)||!['guard','observedGuard'].every(k=>/^[a-f0-9]{64}$/.test(p[k]))||!Number.isSafeInteger(p.version)||p.version<1||!PLAN_STATUSES.includes(p.status)||!date(p.createdAt)||!date(p.updatedAt)||p.createdAt>p.updatedAt)throw Error('Invalid Guardian plan.');
 keys(p.assessment,['state','risks']);if(!['SAFE','UNKNOWN','BLOCKED'].includes(p.assessment.state)||!Array.isArray(p.assessment.risks)||p.assessment.risks.length>500)throw Error('Invalid Guardian assessment.');
 for(const r of p.assessment.risks){keys(r,['code','state','refs']);if(!Object.hasOwn(RISK_TEXT,r.code)||!['UNKNOWN','BLOCKED'].includes(r.state)||!Array.isArray(r.refs)||r.refs.length>1)throw Error('Invalid Guardian evidence.');for(const ref of r.refs){keys(ref,['source','id']);if(!['transfer','queue','membership','context'].includes(ref.source)||!intentId(ref.id))throw Error('Invalid Guardian reference.');}}
 const state=p.assessment.risks.some(r=>r.state==='BLOCKED')?'BLOCKED':p.assessment.risks.length?'UNKNOWN':'SAFE';if(state!==p.assessment.state)throw Error('Invalid Guardian classification.');
 if(!Array.isArray(p.history)||!p.history.length||p.history.length>50||p.history.length!==p.version)throw Error('Invalid Guardian history.');
 for(const [i,h] of p.history.entries()){keys(h,['version','at','actorId','status','blocked','unknown']);if(h.version!==i+1||!date(h.at)||!intentId(h.actorId)||!PLAN_STATUSES.includes(h.status)||!['blocked','unknown'].every(k=>Number.isInteger(h[k])&&h[k]>=0&&h[k]<=500))throw Error('Invalid Guardian audit metadata.');}
 if(p.authorizations!==undefined){if(!Array.isArray(p.authorizations)||p.authorizations.length>10||new Set(p.authorizations.map(a=>a.id)).size!==p.authorizations.length)throw Error('Invalid authorization collection.');for(const a of p.authorizations){validAuthorization(a,PROPOSED_ACTIONS);if(a.snapshot.planId!==p.id||a.snapshot.projectId!==p.projectId||a.snapshot.contextId!==p.contextId||a.snapshot.planVersion>p.version||a.snapshot.riskCodes.some(code=>!Object.hasOwn(RISK_TEXT,code)))throw Error('Authorization scope mismatch.');}}
 if(p.history.at(-1).status!==p.status)throw Error('Invalid Guardian history state.');return p;
}
export function validateGuardianReply(r,scope){
 keys(r,['version','principalId','canPlan','members','records','next','more','readiness','recoveryEvidence','inventory']);if(r.version!==1||!intentId(r.principalId)||typeof r.canPlan!=='boolean'||!Array.isArray(r.members)||r.members.length>1000||!Array.isArray(r.records)||r.records.length>25||!Number.isInteger(r.next)||r.next<0||typeof r.more!=='boolean')throw Error('Invalid Guardian reply.');
 for(const m of r.members){keys(m,['id','role','status','usable']);if(!intentId(m.id)||!['owner','admin','member','guest'].includes(m.role)||!['active','removed'].includes(m.status)||typeof m.usable!=='boolean')throw Error('Invalid Guardian member.');}
 for(const p of r.records){validPlan(p);if(p.projectId!==scope.projectId||p.contextId!==scope.contextId)throw Error('Guardian response scope mismatch.');}if(!Array.isArray(r.readiness)||r.readiness.length!==r.records.length)throw Error('Server readiness evidence missing.');return {...r,...(r.inventory?{inventory:validateInventoryView(r.inventory,scope)}:{}),recoveryEvidence:validateRecoveryEvidence(r.recoveryEvidence??[],scope),readiness:r.readiness.map((item,i)=>validateReadiness(item,r.records[i],RISK_TEXT))};
}
