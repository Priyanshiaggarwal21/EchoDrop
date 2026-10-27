import {inventoryBlocked} from '../../packages/core/dependency-inventory.mjs';
import {assessHandover,validPlan} from '../../packages/core/guardian.mjs';
import {approvalDigest} from './guardian-approvals.mjs';
// Read-only, under the existing Guardian authority transaction. Never accepts a recovery assertion.
export function assessExecutionReadiness(p,auth,sources,guard,now=Date.now()){
 validPlan(p);if(!auth||!Array.isArray(auth.members)||!Array.isArray(auth.contexts)||!sources||!Array.isArray(sources.transfers)||!Array.isArray(sources.queue)||typeof sources.queueKnown!=='boolean'||!Number.isFinite(now))throw Error('Readiness evidence unavailable.');
 const checks=[],ref=(source,id)=>({source,id}),planRef=[ref('plan',p.id)],a=p.authorizations?.at(-1),consentRef=a?[ref('authorization',a.id)]:planRef;
 const add=(code,status,evidence=planRef)=>checks.push({code,status,evidence});
 const member=id=>auth.members.find(m=>m.id===id&&m.status==='active');
 const eligible=m=>Boolean(m&&m.usable&&m.role!=='guest'&&m.projectRole&&m.projectRole!=='guest');
 const approval=a?.decisions.find(d=>d.kind==='approve'),acceptance=a?.decisions.find(d=>d.kind==='accept'),admin=member(approval?.actorId),successor=member(p.successorId);
 const exact=Boolean(a&&a.digest===approvalDigest(a.snapshot)&&a.snapshot.planId===p.id&&a.snapshot.projectId===p.projectId&&a.snapshot.contextId===p.contextId&&a.snapshot.planVersion===p.version&&['initiatorId','departingId','successorId','proposal'].every(k=>a.snapshot[k]===p[k])&&JSON.stringify(a.snapshot.actions)===JSON.stringify(p.actions));
 add('consent-revision',exact?'PASS':'BLOCKED',consentRef);
 add('consent-lifecycle',a?.status==='consent-complete'&&now>=Date.parse(a.createdAt)&&now<Date.parse(a.expiresAt)?'PASS':'BLOCKED',consentRef);
 add('scope-authority',p.guard===guard&&p.observedGuard===guard&&a?.snapshot.guard===guard&&['ready-for-review','blocked'].includes(p.status)?'PASS':'BLOCKED');
 const privileged=auth.members.some(m=>[p.departingId,p.successorId].includes(m.id)&&['owner','admin'].includes(m.role));
 const independent=approval&&![a.requesterId,p.initiatorId,p.departingId,p.successorId].includes(approval.actorId);
 add('administrator-eligibility',eligible(admin)&&independent&&['owner','admin'].includes(admin.role)&&['owner','admin'].includes(admin.projectRole)&&(!privileged||admin.role==='owner'&&admin.projectRole==='owner')?'PASS':'BLOCKED',admin?[ref('membership',admin.id)]:consentRef);
 add('successor-eligibility',eligible(successor)&&p.successorId!==p.departingId?'PASS':'BLOCKED',successor?[ref('membership',successor.id)]:planRef);
 add('successor-acceptance',acceptance&&acceptance.actorId===p.successorId&&acceptance.actorId!==approval?.actorId?'PASS':'BLOCKED',consentRef);
 const bindings=a?[{actorId:a.requesterId,identityBinding:a.requesterBinding},...a.decisions]:[];
 add('identity-bindings',bindings.length===3&&bindings.every(d=>member(d.actorId)?.currentIdentityBinding===d.identityBinding)?'PASS':'BLOCKED',consentRef);
 // No supported recovery-verification source exists. Absence is UNKNOWN, not a fabricated guarantee.
 add('recovery-capability','UNKNOWN');
 const remotePending=sources.inventory?.devices.some(d=>d.principalId===p.departingId&&d.status==='BLOCKED'&&d.report&&inventoryBlocked(d.report));
 add('device-inventory',remotePending?'BLOCKED':'UNKNOWN',member(p.departingId)?[ref('membership',p.departingId)]:planRef);
 for(const r of assessHandover(auth,sources,p).risks)add('risk:'+r.code,r.state,r.refs.length?r.refs:planRef);
 const unique=[...new Map(checks.map(c=>[JSON.stringify(c),c])).values()].sort((x,y)=>x.code.localeCompare(y.code)||JSON.stringify(x.evidence).localeCompare(JSON.stringify(y.evidence)));
 const status=unique.some(c=>c.status==='BLOCKED')?'BLOCKED':unique.some(c=>c.status==='UNKNOWN')?'UNKNOWN':'READY';
 // Stable compatibility codes for existing consumers; checks carry the precise status and provenance.
 const blockers=unique.filter(c=>c.status!=='PASS').map(c=>c.code==='recovery-capability'?'verified-recovery-required':c.code.startsWith('risk:')?(c.status==='UNKNOWN'?'unknown:':'blocked:')+c.code.slice(5):c.code);
 return{version:1,planId:p.id,projectId:p.projectId,...(p.contextId?{contextId:p.contextId}:{}),planVersion:p.version,checkedAt:new Date(now).toISOString(),validUntil:a?.expiresAt??null,status,ready:status==='READY',executionAvailable:false,checks:unique,blockers:[...new Set(blockers)]};
}
