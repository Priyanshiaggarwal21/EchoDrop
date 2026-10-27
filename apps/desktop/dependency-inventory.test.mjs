import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createCollaborationStore} from './collaboration-store.mjs';
import {createRemoteTransport} from './remote-transport.mjs';
import {readCertificate} from './remote-identity.mjs';
import {createSecureContentStore} from './secure-content-store.mjs';
import {createContentReceiver} from './secure-content-receiver.mjs';
import {createDeliveryQueue} from './delivery-queue.mjs';
import {saveVerifiedCopy} from './verified-save.mjs';
import {createDependencyInventory,publishDependencyInventory} from './dependency-inventory.mjs';
import {validateInventoryReport,validateInventoryView,INVENTORY_TTL} from '../../packages/core/dependency-inventory.mjs';
import {createGuardianStore} from './guardian-store.mjs';
import {validateGuardianReply} from '../../packages/core/guardian.mjs';

async function fixture(t,{grant=true}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'echodrop-inventory-')),endpoints=[],seals=new Map();let offset=0;
 t.after(async()=>{for(const e of endpoints)await e.transport.stop();assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('echodrop-inventory-'));await fs.rm(root,{recursive:true,force:true});});
 const protection={seal(value){const id=randomUUID();seals.set(id,value);return id;},open(id){if(!seals.has(id))throw Error('Protected state unavailable');return seals.get(id);}};
 async function endpoint(name){const projectId=randomUUID(),otherId=randomUUID(),store=createCollaborationStore(path.join(root,name+'.json'),async()=>({projects:[{id:projectId,name:'PRIVATE'},{id:otherId,name:'OTHER'}]}),undefined,protection);await store.snapshot(projectId);await store.snapshot(otherId);
  const certificate=await fs.readFile(new URL(`./test-fixtures/remote-tls/${name}-cert.pem`,import.meta.url),'utf8'),key=await fs.readFile(new URL(`./test-fixtures/remote-tls/${name}-key.pem`,import.meta.url),'utf8');await store.remoteLocal(projectId,'import-identity',{certificate,key});
  const content=createSecureContentStore(path.join(root,name+'-content'),store),item={store,projectId,otherId,certificate,fingerprint:readCertificate(certificate).fingerprint,content,transport:null};endpoints.push(item);return item;
 }
 const host=await endpoint('host'),peer=await endpoint('peer');
 async function trust(a,b){await a.store.remoteLocal(a.projectId,'create-invitee',{displayName:'PRIVATE DEVICE'});const person=(await a.store.snapshot(a.projectId)).directory.filter(p=>p.kind==='record').at(-1);await a.store.remoteLocal(a.projectId,'trust-peer',{certificate:b.certificate,fingerprint:b.fingerprint,principalId:person.id});return person.id;}
 const principalId=await trust(host,peer);await trust(peer,host);
 const file=path.join(root,'inventory.json'),make=()=>createDependencyInventory(file,host.store,{protection,now:()=>Date.now()+offset});let inventory=make();
 host.transport=createRemoteTransport(host.store,host.content.handle,undefined,undefined,undefined,undefined,undefined,undefined,undefined,(fp,q)=>inventory.handle(fp,q));peer.transport=createRemoteTransport(peer.store);
 const {port}=await host.transport.start(),target={mode:'remote',fingerprint:host.fingerprint,host:'127.0.0.1',port,projectId:host.projectId};
 const query=(t,q)=>peer.transport.query(t.fingerprint,t.host,t.port,q);
 async function offer(contextId){const r=await host.store.execute(host.projectId,{action:'prepare-invitation-draft',recipientId:principalId,role:'member',expiresAt:null,...(contextId?{contextId}:{})}),draft=r.invitationDrafts.at(-1);await host.store.remoteLocal(host.projectId,'offer',{invitationId:draft.id});await query(target,{version:1,action:'accept',invitationId:draft.id});}
 if(grant)await offer();
 const queueDir=path.join(root,'queue'),receiveDir=path.join(root,'received');const queue=createDeliveryQueue(queueDir,{protection,authorize:id=>peer.store.snapshot(id),execute:async()=>{throw Error('Offline');}}),receiver=createContentReceiver(receiveDir,protection);
 const publish=(scope=target,overrides={})=>publishDependencyInventory({localProjectId:peer.projectId,target:scope,collaboration:peer.store,query,queue,receiver,...overrides});
 const list=(scope=target)=>inventory.list(null,scope);
 const begin=(scope=target)=>query(scope,{version:1,action:'inventory-begin',projectId:scope.projectId,...(scope.contextId?{contextId:scope.contextId}:{})});
 const submit=r=>query(target,{version:1,action:'inventory-submit',projectId:r.projectId,...(r.contextId?{contextId:r.contextId}:{}),report:r});
 const pending=async(scope=target)=>{const id=randomUUID(),bytes=Buffer.from('private bytes');await queue.create(peer.projectId,scope,{id,projectId:scope.projectId,...(scope.contextId?{contextId:scope.contextId}:{}),recipientId:randomUUID(),name:'PRIVATE-FILE.txt',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});return id;};
 return{root,host,peer,principalId,protection,target,file,queue,queueDir,receiver,receiveDir,query,offer,publish,list,begin,submit,pending,endpoint,trust,get inventory(){return inventory;},restart(){inventory=make();},advance(ms){offset=ms;}};
}

test('real pinned TLS exchanges source-bound queue evidence across independent project registries',async t=>{
 const f=await fixture(t),id=await f.pending(),other=await f.pending({...f.target,projectId:f.host.otherId});
 const result=await f.publish();assert.equal(result.accepted,true);assert.equal(result.report.sourcePrincipalId,f.principalId);assert.equal(result.report.sourceFingerprint,f.peer.fingerprint);assert.equal(result.report.hostFingerprint,f.host.fingerprint);assert(result.report.facts.some(x=>x.id===id&&x.state==='pending'));assert(!result.report.facts.some(x=>x.id===other));
 const view=validateInventoryView(await f.list(),f.target);assert.equal(view.devices[0].status,'BLOCKED');assert.equal(view.complete,false);assert(view.unsupported.includes('device-enumeration'));
 assert(!/PRIVATE|private bytes|127\.0\.0\.1|\.txt|credential|localRoot/.test(JSON.stringify(view)));assert(!(await fs.readFile(f.file,'utf8')).includes(id));
});

test('actual receive manifest and interrupted verified save become scoped blockers without destination disclosure',async t=>{
 const f=await fixture(t),id=randomUUID(),bytes=Buffer.from('payload'),meta={id,name:'PRIVATE.bin',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),recipientId:f.principalId};
 const call=q=>f.host.content.handle(null,{version:1,projectId:f.host.projectId,...q});
 await call({action:'content-create',...meta});await call({action:'content-chunk',id,index:0,data:bytes.toString('base64')});await call({action:'content-complete',id});
 const beforeReceive=(await f.publish()).report;assert(beforeReceive.facts.some(x=>x.id===id&&x.state==='inbound-pending'));
 const execute=q=>f.query(f.target,{version:1,projectId:f.host.projectId,...q});await f.receiver.start(f.target,{id},execute);
 const metadata=await execute({action:'content-status',id}),receiptFile=path.join(f.receiveDir,f.host.fingerprint.replaceAll(':',''),id+'.applied.json');let calls=0;
 await assert.rejects(saveVerifiedCopy({metadata,source:path.join(f.root,'unused-source'),receiptFile,protection:f.protection,chooseDirectory:async()=>f.root,checkSpace:async()=>{},authorize:async()=>{if(++calls>1)throw Error('Interrupted save');}}),/Interrupted/);
 const result=await f.publish();assert(result.report.facts.some(x=>x.id===id&&x.state==='download-incomplete'));assert(result.report.facts.some(x=>x.id===id&&x.state==='save-incomplete'));assert(!JSON.stringify(result).includes(f.root));
 const filesBefore=await fs.readdir(f.root);await f.publish();assert.deepEqual(await fs.readdir(f.root),filesBefore);
 await fs.writeFile(receiptFile,'corrupt');const partial=(await f.publish()).report;assert.equal(partial.categories.find(c=>c.category==='save-receipts').status,'UNKNOWN');assert(!partial.facts.some(x=>x.category==='save-receipts'));
});

test('trusted certificates alone do not authorize inventory; member inspection and cross-scope publication denied',async t=>{
 const f=await fixture(t,{grant:false});await assert.rejects(f.publish());await f.offer();
 await assert.rejects(f.query(f.target,{version:1,action:'inventory-list',projectId:f.host.projectId}));await assert.rejects(f.begin({...f.target,projectId:f.host.otherId}));await assert.rejects(f.begin({...f.target,contextId:randomUUID()}));
 const context=(await f.host.store.execute(f.host.projectId,{action:'create-context',name:'Protected',purpose:''})).contexts[0].id;await assert.rejects(f.begin({...f.target,contextId:context}));await f.offer(context);
 const projectId=await f.pending(),contextId=await f.pending({...f.target,contextId:context});const scoped=await f.publish({...f.target,contextId:context});assert(scoped.report.facts.some(x=>x.id===contextId));assert(!scoped.report.facts.some(x=>x.id===projectId));assert.equal((await f.list()).devices[0].status,'MISSING');
});

test('single-use nonce, malformed data, identity/scope mismatch and forged completeness are rejected',async t=>{
 const f=await fixture(t),r=(await f.publish()).report;await assert.rejects(f.submit(r));const c=await f.begin(),base={...r,nonce:c.nonce,authorityRevision:c.authorityRevision,generatedAt:new Date().toISOString()};
 for(const change of [{complete:true},{sourcePrincipalId:randomUUID()},{sourceFingerprint:f.host.fingerprint},{projectId:f.host.otherId},{authorityRevision:'0'.repeat(64)},{facts:[{category:'outbound-queue',id:randomUUID(),state:'all-clear'}]},{counts:{pending:0}},{facts:Array(201).fill({category:'outbound-queue',id:randomUUID(),state:'pending'})}])await assert.rejects(f.submit({...base,...change}));
 await f.submit(base);await assert.rejects(f.submit(base));assert.throws(()=>validateInventoryReport({...base,facts:[{category:'outbound-queue',id:randomUUID(),state:'pending',path:'SECRET'}]}));
});

test('membership and certificate revocation invalidate pending challenges and withhold old reports',async t=>{
 const f=await fixture(t),r=(await f.publish()).report,c=await f.begin();await f.host.store.execute(f.host.projectId,{action:'change-project-member',principalId:f.principalId,role:'admin'});
 await assert.rejects(f.submit({...r,nonce:c.nonce}));assert.equal((await f.list()).devices[0].status,'STALE');await f.publish();
 await f.host.store.remoteLocal(f.host.projectId,'revoke-peer',{fingerprint:f.peer.fingerprint});const d=(await f.list()).devices[0];assert.equal(d.status,'REVOKED');assert(!d.report);await assert.rejects(f.publish());
});

test('freshness and missing reports stay unknown; expired challenges and old generation times rejected',async t=>{
 const f=await fixture(t);assert.equal((await f.list()).devices[0].status,'MISSING');const r=(await f.publish()).report;f.advance(INVENTORY_TTL+1);assert.equal((await f.list()).devices[0].status,'STALE');f.advance(0);
 let c=await f.begin();await assert.rejects(f.submit({...r,nonce:c.nonce,generatedAt:new Date(Date.now()-60000).toISOString()}));await assert.rejects(f.submit({...r,nonce:c.nonce,generatedAt:new Date(Date.now()+60000).toISOString()}));f.advance(120001);await assert.rejects(f.submit({...r,nonce:c.nonce}));
});

test('restart restores evidence and consumed nonces; corruption is preserved and fails closed',async t=>{
 const f=await fixture(t),r=(await f.publish()).report;f.restart();assert.equal((await f.list()).devices[0].report.nonce,r.nonce);await assert.rejects(f.submit(r));
 const c=await f.begin();f.restart();await f.submit({...r,nonce:c.nonce,generatedAt:new Date().toISOString()});await fs.writeFile(f.file,'partial write');await assert.rejects(f.list(),/corrupt/);assert.equal(await fs.readFile(f.file,'utf8'),'partial write');await assert.rejects(f.publish());
});

test('corrupt queue and missing source categories publish UNKNOWN without invented empty clearance',async t=>{
 const f=await fixture(t);await f.pending();await fs.writeFile(path.join(f.queueDir,'queue.json'),'corrupt');const r=(await f.publish()).report;assert.equal(r.categories.find(c=>c.category==='outbound-queue').status,'UNKNOWN');assert(!r.facts.some(x=>x.category==='outbound-queue'));assert.equal(r.complete,false);
 const partial=(await f.publish(f.target,{receiver:{inventory:async()=>{throw Error('Unavailable source');}}})).report;assert(partial.categories.every(c=>c.status==='UNKNOWN'));assert.equal((await f.list()).devices[0].status,'PARTIAL');
});

test('Guardian consumes authenticated evidence, keeps recovery/completeness UNKNOWN and invalidates stale consent guards',async t=>{
 const f=await fixture(t);await f.pending();await f.publish();const owner=(await f.host.store.snapshot(f.host.projectId)).actor.id;
 const guardian=createGuardianStore(path.join(f.root,'guardian.json'),f.host.store,{protection:f.protection,collect:async()=>({transfers:[],queue:[],queueKnown:true,inventory:await f.list()})});
 const request={version:1,projectId:f.host.projectId,action:'guardian-create',operation:{id:randomUUID(),planId:randomUUID(),baseVersion:0,departingId:f.principalId,successorId:owner,proposal:'remove-membership',actions:['settle-pending-deliveries']}};
 const reply=validateGuardianReply(await guardian.handle(null,request),f.target);assert.equal(reply.readiness[0].checks.find(c=>c.code==='device-inventory').status,'BLOCKED');assert.equal(reply.readiness[0].checks.find(c=>c.code==='recovery-capability').status,'UNKNOWN');assert.equal(reply.readiness[0].ready,false);
 const first=reply.records[0];const same=await guardian.handle(null,{version:1,action:'guardian-list',projectId:f.host.projectId});assert.equal(same.records[0].version,first.version);
 f.advance(INVENTORY_TTL+1);const stale=await guardian.handle(null,{version:1,action:'guardian-list',projectId:f.host.projectId});assert.equal(stale.records[0].status,'stale');assert.equal(stale.readiness[0].checks.find(c=>c.code==='device-inventory').status,'UNKNOWN');
});

test('IPC permits only collection/inspection controls and rejects renderer evidence and untrusted callers',async t=>{
 const f=await fixture(t),{installSecureContent}=await import('./secure-content-ipc.cjs');t.mock.method(globalThis,'setInterval',()=>({unref(){}}));let handle;
 installSecureContent({ipcMain:{handle:(_n,h)=>handle=h},trusted:e=>{if(!e.trusted)throw Error('Untrusted');},getStore:async()=>f.host.store,inventoryStore:async()=>f.inventory});
 const target={mode:'local',projectId:f.host.projectId};const view=await handle({trusted:true},f.host.projectId,'inventory-list',{target});assert.equal(view.devices[0].status,'MISSING');await assert.rejects(handle({},f.host.projectId,'inventory-list',{target}),/Untrusted/);await assert.rejects(handle({trusted:true},f.host.projectId,'inventory-list',{target,report:{complete:true}}),/client-supplied/);
 const ui=await fs.readFile(new URL('../web/src/DependencyInventory.tsx',import.meta.url),'utf8');for(const text of ['inventory-','Collect this device','UNKNOWN','scope admins'])assert(ui.includes(text));
});

test('one empty report cannot clear a second authenticated device with no report',async t=>{
 const f=await fixture(t),second=await f.endpoint('attacker');second.transport=createRemoteTransport(second.store);const recipientId=await f.trust(f.host,second);await f.trust(second,f.host);
 await f.host.transport.stop();f.target.port=(await f.host.transport.start()).port;
 const offered=await f.host.store.execute(f.host.projectId,{action:'prepare-invitation-draft',recipientId,role:'member',expiresAt:null}),id=offered.invitationDrafts.at(-1).id;await f.host.store.remoteLocal(f.host.projectId,'offer',{invitationId:id});await second.transport.query(f.host.fingerprint,'127.0.0.1',f.target.port,{version:1,action:'accept',invitationId:id});
 await f.publish();const view=await f.list();assert.equal(view.devices.length,2);assert.equal(view.devices.find(d=>d.principalId===recipientId).status,'MISSING');assert.equal(view.devices.find(d=>d.principalId===f.principalId).status,'OBSERVED');assert.equal(view.complete,false);
});

test('duplicate facts, oversized reports and category/state ambiguity fail validation',async t=>{
 const f=await fixture(t),r=(await f.publish()).report,fact={category:'outbound-queue',id:randomUUID(),state:'pending'};
 assert.throws(()=>validateInventoryReport({...r,facts:[fact,fact]}),/fact/);
 assert.throws(()=>validateInventoryReport({...r,facts:[{...fact,category:'save-receipts'}]}),/category/);
 assert.throws(()=>validateInventoryReport({...r,extra:'x'.repeat(65537)}),/limit/);
 const categories=structuredClone(r.categories);categories[0].status='UNKNOWN';assert.throws(()=>validateInventoryReport({...r,categories,facts:[fact]}),/fact/);
});
