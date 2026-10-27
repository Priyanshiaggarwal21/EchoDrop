import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {regularFile,writeAtomic} from './secure-content-store.mjs';
import {INVENTORY_TTL,CHALLENGE_TTL,INVENTORY_LIMIT,INVENTORY_UNKNOWN,INVENTORY_CATEGORIES,inventoryBlocked,inventoryKeys,inventoryScope,sameInventoryScope,inventoryDate,validateInventoryChallenge,validateInventoryReport,validateInventoryView} from '../../packages/core/dependency-inventory.mjs';

// Host-authoritative challenge/receipt store. No renderer-supplied report reaches this API via IPC.
export function createDependencyInventory(file,collaboration,{protection,now=Date.now}){
 let pending=Promise.resolve();const serial=fn=>{const p=pending.then(fn);pending=p.catch(()=>{});return p;};
 async function load(){try{if((await regularFile(file)).size>16*1024*1024)throw Error();const e=JSON.parse(await fs.readFile(file,'utf8'));if(e.version!==1)throw Error();const d=JSON.parse(protection.open(e.sealed));inventoryKeys(d,['version','challenges','reports']);if(d.version!==1||!Array.isArray(d.challenges)||d.challenges.length>256||!Array.isArray(d.reports)||d.reports.length>100)throw Error();const ids=new Set(),scopes=new Set();for(const c of d.challenges){validateInventoryChallenge(c);if(ids.has(c.nonce))throw Error();ids.add(c.nonce);}for(const item of d.reports){inventoryKeys(item,['report','receivedAt']);validateInventoryReport(item.report);if(!inventoryDate(item.receivedAt))throw Error();const r=item.report,key=JSON.stringify([r.projectId,r.contextId,r.sourceFingerprint]);if(scopes.has(key))throw Error();scopes.add(key);}return d;}catch(e){if(e.code==='ENOENT')return {version:1,challenges:[],reports:[]};throw Error('Inventory storage corrupt or unavailable; original evidence preserved.');}}
 async function save(d){await fs.mkdir(path.dirname(file),{recursive:true});if((await fs.lstat(path.dirname(file))).isSymbolicLink())throw Error('Unsafe inventory storage.');await writeAtomic(file,{version:1,sealed:protection.seal(JSON.stringify(d))});}
 const run=(fp,q)=>serial(async()=>{
  inventoryKeys(q,['version','action','projectId','contextId','report']);inventoryScope(q);
  if(q.version!==1||!['inventory-begin','inventory-submit','inventory-list'].includes(q.action)||(q.action==='inventory-submit')!==(q.report!==undefined)||Buffer.byteLength(JSON.stringify(q))>INVENTORY_LIMIT+1024)throw Error('Invalid inventory request.');
  return collaboration.withInventoryAuthority(fp,q.projectId,q.contextId,async a=>{
   const d=await load();
   if(q.action==='inventory-list'){
    if(!a.canPlan)throw Error('Inventory inspection requires scope administrator authority.');
    const devices=a.devices.map(device=>{const entry=d.reports.find(e=>sameInventoryScope(e.report,q)&&e.report.sourceFingerprint===device.fingerprint),r=entry?.report;let status=!device.eligible?'REVOKED':!r?'MISSING':'STALE';
     if(device.eligible&&r&&r.sourcePrincipalId===device.principalId&&r.hostFingerprint===a.hostFingerprint&&r.authorityRevision===a.authorityRevision&&now()>=Date.parse(entry.receivedAt)&&now()-Date.parse(entry.receivedAt)<INVENTORY_TTL&&now()>=Date.parse(r.generatedAt)-30000&&now()-Date.parse(r.generatedAt)<INVENTORY_TTL)status=inventoryBlocked(r)?'BLOCKED':r.categories.some(c=>c.status==='UNKNOWN')?'PARTIAL':'OBSERVED';
     return {principalId:device.principalId,fingerprint:device.fingerprint,status,...(['BLOCKED','PARTIAL','OBSERVED'].includes(status)?{report:r}:{})};});
    return validateInventoryView({version:1,projectId:q.projectId,...(q.contextId?{contextId:q.contextId}:{}),checkedAt:new Date(now()).toISOString(),complete:false,unsupported:[...INVENTORY_UNKNOWN],devices},q);
   }
   if(!fp||!a.canContribute)throw Error('Accepted contributor scope and pinned device required.');
   if(q.action==='inventory-begin'){
    d.challenges=d.challenges.filter(c=>Date.parse(c.expiresAt)>now());
    // One pending nonce per device/scope; a new attempt invalidates an interrupted attempt.
    d.challenges=d.challenges.filter(c=>!(sameInventoryScope(c,q)&&c.sourceFingerprint===fp));if(d.challenges.length>=256)throw Error('Inventory challenge capacity reached.');
    const c=validateInventoryChallenge({version:1,projectId:q.projectId,...(q.contextId?{contextId:q.contextId}:{}),nonce:randomUUID(),sourceFingerprint:fp,sourcePrincipalId:a.principalId,hostFingerprint:a.hostFingerprint,authorityRevision:a.authorityRevision,role:a.role,issuedAt:new Date(now()).toISOString(),expiresAt:new Date(now()+CHALLENGE_TTL).toISOString()});d.challenges.push(c);await save(d);return c;
   }
   const c=d.challenges.find(c=>c.nonce===q.report?.nonce&&c.sourceFingerprint===fp&&sameInventoryScope(c,q));if(!c||now()<Date.parse(c.issuedAt)||now()>=Date.parse(c.expiresAt)||c.authorityRevision!==a.authorityRevision||c.sourcePrincipalId!==a.principalId||c.hostFingerprint!==a.hostFingerprint)throw Error('Inventory challenge expired, replayed or authority changed.');
   const r=validateInventoryReport(q.report,c);if(Date.parse(r.generatedAt)<Date.parse(c.issuedAt)-30000||Date.parse(r.generatedAt)>now()+30000||now()-Date.parse(r.generatedAt)>=INVENTORY_TTL)throw Error('Inventory timestamp is stale or invalid.');
   d.challenges=d.challenges.filter(item=>item.nonce!==c.nonce);d.reports=d.reports.filter(item=>!(sameInventoryScope(item.report,q)&&item.report.sourceFingerprint===fp));if(d.reports.length>=100)throw Error('Inventory evidence capacity reached.');d.reports.push({report:r,receivedAt:new Date(now()).toISOString()});await save(d);
   return {version:1,nonce:r.nonce,accepted:true,complete:false};
  });
 });
 return {handle:run,list:(fp,q)=>run(fp,{version:1,action:'inventory-list',projectId:q.projectId,...(q.contextId?{contextId:q.contextId}:{})})};
}

// Called only in the trusted desktop process. query uses the existing pinned TLS transport.
export async function publishDependencyInventory({localProjectId,target,collaboration,query,queue,receiver,now=Date.now}){
 const {validateTarget}=await import('./delivery-queue.mjs');validateTarget(target,localProjectId);if(target.mode!=='remote')throw Error('Choose an authenticated remote project scope.');
 await collaboration.withGuardianAuthority(null,localProjectId,undefined,a=>{if(!a.canPlan)throw Error('Local project administration required to publish device evidence.');});
 const identity=await collaboration.remoteStatus(),c=validateInventoryChallenge(await query(target,{version:1,action:'inventory-begin',projectId:target.projectId,...(target.contextId?{contextId:target.contextId}:{})}));
 if(!sameInventoryScope(c,target)||c.hostFingerprint!==target.fingerprint||c.sourceFingerprint!==identity.identity?.fingerprint||now()<Date.parse(c.issuedAt)-30000||now()>=Date.parse(c.expiresAt))throw Error('Inventory host, identity or challenge mismatch.');
 const facts=[],categories=INVENTORY_CATEGORIES.map(category=>({category,status:'UNKNOWN'}));
 const add=(category,rows)=>{if(!Array.isArray(rows)||rows.length>100||facts.length+rows.length>100)throw Error('Inventory capacity exceeded.');facts.push(...rows.map(row=>({category,...row})));categories.find(c=>c.category===category).status='OBSERVED';};
 try{add('outbound-queue',await queue.inventory(target));}catch{/* Inaccessible queues are UNKNOWN, never an empty clear report. */}
 try{const records=await query(target,{version:1,action:'content-list',projectId:target.projectId,...(target.contextId?{contextId:target.contextId}:{})});const received=await receiver.inventory(target,records,c.sourcePrincipalId);for(const category of ['inbound-deliveries','save-receipts'])if(received[category]!==null)add(category,received[category]);}catch{/* Missing/legacy/failed content inspection remains UNKNOWN. */}
 await collaboration.withGuardianAuthority(null,localProjectId,undefined,a=>{if(!a.canPlan)throw Error('Local publishing authority changed.');});
 const report=validateInventoryReport({version:1,evidenceVersion:1,projectId:c.projectId,...(c.contextId?{contextId:c.contextId}:{}),nonce:c.nonce,sourceFingerprint:c.sourceFingerprint,sourcePrincipalId:c.sourcePrincipalId,hostFingerprint:c.hostFingerprint,authorityRevision:c.authorityRevision,generatedAt:new Date(now()).toISOString(),role:c.role,categories,facts:facts.sort((a,b)=>a.category.localeCompare(b.category)||a.id.localeCompare(b.id)||a.state.localeCompare(b.state)),unsupported:[...INVENTORY_UNKNOWN],complete:false},c);
 const ack=await query(target,{version:1,action:'inventory-submit',projectId:c.projectId,...(c.contextId?{contextId:c.contextId}:{}),report});
 inventoryKeys(ack,['version','nonce','accepted','complete']);if(ack.version!==1||ack.nonce!==c.nonce||ack.accepted!==true||ack.complete!==false)throw Error('Inventory acknowledgement invalid.');return {report,accepted:true,complete:false};
}
