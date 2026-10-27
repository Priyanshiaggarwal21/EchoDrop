import {intentId} from './intentions.mjs';
export const READINESS_LABELS={
 'consent-revision':'Consent matches the exact plan revision and proposed actions',
 'consent-lifecycle':'Consent is complete, current and unexpired',
 'scope-authority':'Plan and consent match current authority and dependencies',
 'administrator-eligibility':'Approver remains an eligible independent administrator',
 'successor-eligibility':'Successor retains authenticated contributor access',
 'successor-acceptance':'Intended successor explicitly accepted',
 'identity-bindings':'Recorded decisions match current trusted identities',
 'device-inventory':'Observed device dependencies; missing devices and global completeness remain unverified',
 'recovery-capability':'Verified recovery capability is not available'
};
export function validateReadiness(r,p,riskCodes){
 if(!r||Object.keys(r).some(k=>!['version','planId','projectId','contextId','planVersion','checkedAt','validUntil','status','ready','executionAvailable','checks','blockers'].includes(k))||r.version!==1||r.planId!==p.id||r.projectId!==p.projectId||r.contextId!==p.contextId||r.planVersion!==p.version||typeof r.checkedAt!=='string'||!Number.isFinite(Date.parse(r.checkedAt))||(r.validUntil!==null&&(typeof r.validUntil!=='string'||!Number.isFinite(Date.parse(r.validUntil))))||!Array.isArray(r.checks)||r.checks.length>520||r.executionAvailable!==false)throw Error('Invalid scoped readiness assessment.');
 const unique=new Set();for(const c of r.checks){if(!c||Object.keys(c).some(k=>!['code','status','evidence'].includes(k))||!(Object.hasOwn(READINESS_LABELS,c.code)||typeof c.code==='string'&&c.code.startsWith('risk:')&&Object.hasOwn(riskCodes,c.code.slice(5)))||!['PASS','BLOCKED','UNKNOWN'].includes(c.status)||!Array.isArray(c.evidence)||c.evidence.length!==1)throw Error('Invalid readiness check.');for(const e of c.evidence)if(!e||Object.keys(e).some(k=>!['source','id'].includes(k))||!['plan','authorization','membership','context','transfer','queue'].includes(e.source)||!intentId(e.id)||e.source==='plan'&&e.id!==p.id||e.source==='authorization'&&!p.authorizations?.some(a=>a.id===e.id))throw Error('Invalid readiness evidence.');const key=JSON.stringify(c);if(unique.has(key))throw Error('Duplicate readiness evidence.');unique.add(key);}
 for(const code of Object.keys(READINESS_LABELS))if(r.checks.filter(c=>c.code===code).length!==1)throw Error('Readiness check missing.');
 if(r.checks.find(c=>c.code==='recovery-capability').status!=='UNKNOWN')throw Error('Unsupported recovery claim.');
 if(r.checks.find(c=>c.code==='device-inventory').status==='PASS')throw Error('Device completeness is unsupported.');
 const status=r.checks.some(c=>c.status==='BLOCKED')?'BLOCKED':r.checks.some(c=>c.status==='UNKNOWN')?'UNKNOWN':'READY';if(r.status!==status||r.ready!==(status==='READY'))throw Error('Inconsistent readiness classification.');
 const blockers=[...new Set(r.checks.filter(c=>c.status!=='PASS').map(c=>c.code==='recovery-capability'?'verified-recovery-required':c.code.startsWith('risk:')?(c.status==='UNKNOWN'?'unknown:':'blocked:')+c.code.slice(5):c.code))];if(JSON.stringify(r.blockers)!==JSON.stringify(blockers))throw Error('Invalid readiness blockers.');return r;
}
