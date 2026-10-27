import {isProjectId} from './projects.mjs';
export const INVENTORY_TTL=300000, CHALLENGE_TTL=120000, INVENTORY_LIMIT=65536;
export const INVENTORY_CATEGORIES=['outbound-queue','inbound-deliveries','save-receipts'];
export const INVENTORY_UNKNOWN=['external-dependencies','device-enumeration','unmapped-receive-cache','unrecorded-copies','other-contexts'];
export const INVENTORY_STATES=['pending','withdrawal-pending','retained-record','inbound-pending','download-incomplete','download-complete','save-incomplete','save-recorded'];
export const inventoryBlocked=r=>r.facts.some(f=>['pending','withdrawal-pending','inbound-pending','download-incomplete','save-incomplete'].includes(f.state));
export const inventoryPin=v=>typeof v==='string'&&/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(v);
export const inventoryHash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const inventoryDate=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
export function inventoryKeys(x,keys){if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!keys.includes(k)))throw Error('Invalid inventory fields.');}
export function inventoryScope(q){if(!isProjectId(q.projectId)||(q.contextId!==undefined&&!isProjectId(q.contextId)))throw Error('Invalid inventory scope.');}
export const sameInventoryScope=(a,b)=>a.projectId===b.projectId&&a.contextId===b.contextId;
export function validateInventoryChallenge(c){
 inventoryKeys(c,['version','projectId','contextId','nonce','sourceFingerprint','sourcePrincipalId','hostFingerprint','authorityRevision','issuedAt','expiresAt','role']);inventoryScope(c);
 if(c.version!==1||!isProjectId(c.nonce)||!isProjectId(c.sourcePrincipalId)||!inventoryPin(c.sourceFingerprint)||!inventoryPin(c.hostFingerprint)||c.sourceFingerprint===c.hostFingerprint||!inventoryHash(c.authorityRevision)||!inventoryDate(c.issuedAt)||!inventoryDate(c.expiresAt)||Date.parse(c.expiresAt)-Date.parse(c.issuedAt)!==CHALLENGE_TTL||!['owner','admin','member'].includes(c.role))throw Error('Invalid inventory challenge.');return c;
}
export function validateInventoryReport(r,c){
 if(JSON.stringify(r).length>INVENTORY_LIMIT)throw Error('Inventory limit exceeded.');
 inventoryKeys(r,['version','evidenceVersion','projectId','contextId','nonce','sourceFingerprint','sourcePrincipalId','hostFingerprint','authorityRevision','generatedAt','role','categories','facts','unsupported','complete']);inventoryScope(r);
 if(r.version!==1||r.evidenceVersion!==1||!isProjectId(r.nonce)||!isProjectId(r.sourcePrincipalId)||!inventoryPin(r.sourceFingerprint)||!inventoryPin(r.hostFingerprint)||!inventoryHash(r.authorityRevision)||!inventoryDate(r.generatedAt)||r.complete!==false||!['owner','admin','member'].includes(r.role)||!Array.isArray(r.facts)||r.facts.length>100||JSON.stringify(r.unsupported)!==JSON.stringify(INVENTORY_UNKNOWN))throw Error('Invalid inventory report.');
 if(c&&(!sameInventoryScope(r,c)||['nonce','sourceFingerprint','sourcePrincipalId','hostFingerprint','authorityRevision','role'].some(k=>r[k]!==c[k])))throw Error('Inventory challenge binding mismatch.');
 if(!Array.isArray(r.categories)||r.categories.length!==INVENTORY_CATEGORIES.length)throw Error('Inventory coverage missing.');
 r.categories.forEach((v,i)=>{inventoryKeys(v,['category','status']);if(v.category!==INVENTORY_CATEGORIES[i]||!['OBSERVED','UNKNOWN'].includes(v.status))throw Error('Invalid inventory coverage.');});
 const ids=new Set();for(const f of r.facts){inventoryKeys(f,['category','id','state']);const key=f.category+':'+f.id+':'+f.state;if(!isProjectId(f.id)||!INVENTORY_STATES.includes(f.state)||ids.has(key)||!r.categories.some(c=>c.category===f.category&&c.status==='OBSERVED'))throw Error('Invalid inventory fact.');const allowed={'outbound-queue':['pending','withdrawal-pending','retained-record'],'inbound-deliveries':['inbound-pending','download-incomplete','download-complete'],'save-receipts':['save-incomplete','save-recorded']};if(!allowed[f.category]?.includes(f.state))throw Error('Inventory fact category mismatch.');ids.add(key);}
 return r;
}
export function validateInventoryView(v,scope){
 inventoryKeys(v,['version','projectId','contextId','checkedAt','complete','unsupported','devices']);inventoryScope(v);
 if(v.version!==1||!sameInventoryScope(v,scope)||!inventoryDate(v.checkedAt)||v.complete!==false||JSON.stringify(v.unsupported)!==JSON.stringify(INVENTORY_UNKNOWN)||!Array.isArray(v.devices)||v.devices.length>100)throw Error('Invalid inventory view.');
 const ids=new Set();for(const d of v.devices){inventoryKeys(d,['principalId','fingerprint','status','report']);if(!isProjectId(d.principalId)||!inventoryPin(d.fingerprint)||ids.has(d.fingerprint)||!['MISSING','STALE','REVOKED','OBSERVED','PARTIAL','BLOCKED'].includes(d.status))throw Error('Invalid inventory device.');ids.add(d.fingerprint);if(d.report){validateInventoryReport(d.report);if(!sameInventoryScope(d.report,scope)||d.report.sourceFingerprint!==d.fingerprint||d.report.sourcePrincipalId!==d.principalId||!['OBSERVED','PARTIAL','BLOCKED'].includes(d.status)||d.status!==(inventoryBlocked(d.report)?'BLOCKED':d.report.categories.some(c=>c.status==='UNKNOWN')?'PARTIAL':'OBSERVED'))throw Error('Inventory report visibility mismatch.');}else if(['OBSERVED','PARTIAL','BLOCKED'].includes(d.status))throw Error('Missing inventory report.');}
 return v;
}
