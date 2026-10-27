import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createProjectRegistry} from './project-registry.mjs';
import {createCollaborationStore} from './collaboration-store.mjs';
import {createRecoveryStore,independentPreview} from './recovery-store.mjs';
import {createRecoveryPackage,digest} from './recovery-package.mjs';
import {validateRecoveryEvidence} from '../../packages/core/recovery-evidence.mjs';

async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'echodrop-restore-'));
 t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('echodrop-restore-'));await fs.rm(root,{recursive:true,force:true});});
 const app=path.join(root,'app'),snap=path.join(root,'snap'),key=path.join(root,'key');await Promise.all([app,snap,key].map(p=>fs.mkdir(p)));
 const file=path.join(app,'projects.json'),evidenceFile=path.join(app,'recovery.json'),authorityFile=path.join(app,'authority.json');let registry=createProjectRegistry(file),failSeal=false,afterCommit=()=>{},offset=0;
 const original=await registry.create({name:'Apollo',description:'Build a useful local project.',type:'Team Project',origin:'new'},app);
 const other=await registry.create({name:'Other',description:'Keep this.',type:'Personal Project',origin:'new'});
 const raw=JSON.parse(await fs.readFile(file,'utf8'));raw.extension={keep:true};raw.projects[0].metadata={token:'DO-NOT-EXPORT',future:{keep:true}};await fs.writeFile(file,JSON.stringify(raw));
 const seals=new Map(),protection={seal(value){if(failSeal)throw Error('Simulated evidence acknowledgement failure');const id=randomUUID();seals.set(id,value);return id;},open(id){if(!seals.has(id))throw Error('Wrong OS identity');return seals.get(id);}};
 const projects=()=>registry.list(),collaboration=createCollaborationStore(authorityFile,projects,undefined,protection);await collaboration.snapshot(original.id);await collaboration.snapshot(other.id);
 const authority=(id=original.id)=>collaboration.withGuardianAuthority(null,id,undefined,a=>a);
 const source=async id=>{const r=await registry.list();if(r.readOnly)throw Error(r.warning);const p=r.projects.find(p=>p.id===id);if(!p)throw Error('Project unavailable');return p;};
 const commit=request=>collaboration.withGuardianAuthority(null,request.projectId,undefined,async a=>{const result=await registry.restoreMetadata(request,a);afterCommit();return result;});
 const make=()=>createRecoveryStore(evidenceFile,{privateRoot:app,protection,source,authorize:(fp,id)=>collaboration.withGuardianAuthority(fp,id,undefined,a=>a),commit,now:()=>Date.now()+offset});
 let store=make();
 const create=async()=>{const r=await store.create(original.id,snap,key);return {id:r.snapshotId,snapshot:path.join(snap,r.snapshotId+'.edrecovery'),keyFile:path.join(key,r.snapshotId+'.edkey')};};
 const preview=x=>store.verify(original.id,x.id,x.snapshot,x.keyFile);
 const apply=(x,p,fields=['name'],confirm=async()=>true)=>store.restore(original.id,x.id,p.previewId,fields,confirm);
 return {root,app,snap,key,file,evidenceFile,authorityFile,original,other,collaboration,authority,source,protection,create,preview,apply,make,get store(){return store;},get registry(){return registry;},restart(){registry=createProjectRegistry(file);store=make();},failWrites(){registry=createProjectRegistry(file,{...fs,rename:async()=>{throw Error('Simulated atomic rename failure');}});},setSealFailure(v){failSeal=v;},afterCommit(fn){afterCommit=fn;},advance(ms){offset=ms;}};
}
async function changed(f){const x=await f.create();await f.registry.update(f.original.id,{name:'Edited name',description:'Edited description',status:'Paused',pinned:true});return {x,p:await f.preview(x)};}

test('v2 portable package covers recognizable fields, excludes opaque state and authenticates version binding',async t=>{
 const f=await fixture(t),x=await f.create(),a=await f.authority();
 const proof=await independentPreview(x.snapshot,x.keyFile,f.original.id,a.principalId);
 assert.equal(proof.manifest.version,2);assert.equal(proof.state.name,f.original.name);assert.equal(proof.state.description,f.original.description);
 assert.equal(Object.keys(proof.state).length,9);assert(!('metadata' in proof.state));assert(!('localRoot' in proof.state));
 const bytes=await fs.readFile(x.snapshot,'utf8');assert(!bytes.includes(f.original.name));assert(!bytes.includes('DO-NOT-EXPORT'));
 const damaged=JSON.parse(bytes);damaged.manifest.version=1;damaged.manifest.policy='project-structure-preview/v1';await fs.writeFile(x.snapshot,JSON.stringify(damaged));
 await assert.rejects(f.preview(x));
});

test('v1 packages and persisted enrollments still verify after upgrade but remain preview-only',async t=>{
 const f=await fixture(t),a=await f.authority(),{envelope,secret}=createRecoveryPackage(await f.source(f.original.id),a,Date.now(),1);
 const id=envelope.manifest.snapshotId,x={id,snapshot:path.join(f.snap,id+'.edrecovery'),keyFile:path.join(f.key,id+'.edkey')};
 await fs.writeFile(x.snapshot,JSON.stringify(envelope));await fs.writeFile(x.keyFile,JSON.stringify(secret));
 await fs.writeFile(f.evidenceFile,JSON.stringify({version:1,sealed:f.protection.seal(JSON.stringify({version:1,records:[{manifest:envelope.manifest,snapshotFile:x.snapshot,keyFile:x.keyFile,envelopeDigest:digest(envelope),keyDigest:digest(secret)}]}))}));
 f.restart();const p=await f.preview(x);assert.equal(p.evidence.status,'VERIFIED');assert.equal(p.canApply,false);assert(p.blockers.includes('LEGACY_PREVIEW_ONLY'));assert(!('name' in p.state));
 validateRecoveryEvidence(await f.store.evidence(f.original.id),{projectId:f.original.id});await assert.rejects(f.apply(x,p));
});

test('selected metadata restores atomically while unrelated fields, projects and authority remain unchanged',async t=>{
 const f=await fixture(t),{x,p}=await changed(f),before=await f.source(f.original.id),authority=await fs.readFile(f.authorityFile,'utf8');
 assert.equal(p.canApply,true);assert.equal(p.evidence.status,'STALE');assert.deepEqual(p.restoreFields,['name','description','status','pinned']);
 let confirmed;const result=await f.apply(x,p,['name','description'],async details=>{confirmed=details;return true;});
 assert.equal(confirmed.differences[0].field,'description');assert.equal(result.currentMatches,true);assert.equal(result.completeRecovery,false);
 const after=await f.source(f.original.id);assert.equal(after.name,f.original.name);assert.equal(after.description,f.original.description);assert.equal(after.status,before.status);assert.equal(after.pinned,before.pinned);assert(after.updatedAt>before.updatedAt);
 for(const key of ['id','version','type','origin','createdAt','metadata','localRoot'])assert.deepEqual(after[key],before[key]);
 assert.deepEqual(await f.source(f.other.id),f.other);assert.equal(await fs.readFile(f.authorityFile,'utf8'),authority);
 const raw=JSON.parse(await fs.readFile(f.file,'utf8'));assert.deepEqual(raw.extension,{keep:true});assert.equal(raw.recoveryReceipts.length,1);assert(!JSON.stringify(raw.recoveryReceipts).includes('Apollo'));
 const evidence=await f.store.evidence(f.original.id);validateRecoveryEvidence(evidence,{projectId:f.original.id});assert(evidence[0].metadataRestoredAt);assert.equal(evidence[0].completeRecovery,false);
});

test('restart preserves preview and idempotency, including later edits without reapplying old metadata',async t=>{
 const f=await fixture(t),{x,p}=await changed(f);f.restart();const result=await f.apply(x,p);f.restart();
 const replay=await f.apply(x,p);assert.equal(replay.replayed,true);assert.equal(replay.appliedAt,result.appliedAt);assert.equal(replay.currentMatches,true);
 await f.registry.update(f.original.id,{name:'Newer intentional edit'});const later=await f.apply(x,p);assert.equal(later.replayed,true);assert.equal(later.currentMatches,false);assert.equal((await f.source(f.original.id)).name,'Newer intentional edit');
 await assert.rejects(f.apply(x,p,['description']),/replay conflict/);assert.equal(JSON.parse(await fs.readFile(f.file)).recoveryReceipts.length,1);
});

test('native cancellation and unsupported or unselected restore operations never write',async t=>{
 const f=await fixture(t),{x,p}=await changed(f),before=await fs.readFile(f.file,'utf8');
 await assert.rejects(f.apply(x,p,['name'],async()=>false),/cancelled/);
 for(const fields of [[],['localRoot'],['metadata'],['name','name'],['principalId']])await assert.rejects(f.apply(x,p,fields),/Select supported/);
 assert.equal(await fs.readFile(f.file,'utf8'),before);
});

test('concurrent edits before or during confirmation invalidate preview without losing either project',async t=>{
 const f=await fixture(t),{x,p}=await changed(f);
 await assert.rejects(f.apply(x,p,['name'],async()=>{await f.registry.update(f.original.id,{description:'Concurrent edit'});return true;}),/stale/);
 assert.equal((await f.source(f.original.id)).description,'Concurrent edit');assert.equal((await f.source(f.original.id)).name,'Edited name');assert.deepEqual(await f.source(f.other.id),f.other);
});

test('membership change during native confirmation fails current authority recheck',async t=>{
 const f=await fixture(t),{x,p}=await changed(f);
 await assert.rejects(f.apply(x,p,['name'],async()=>{await f.collaboration.execute(f.original.id,{action:'add-project-member',displayName:'New member',role:'member'});return true;}),/authority required/);
 assert.equal((await f.source(f.original.id)).name,'Edited name');const next=await f.preview(x);assert(next.blockers.includes('AUTHORITY_CHANGED_SINCE_SNAPSHOT'));assert.equal(next.canApply,false);
});

test('wrong project, lost protected identity, expired preview and lost key fail closed',async t=>{
 const f=await fixture(t),{x,p}=await changed(f);
 await assert.rejects(f.store.restore(f.other.id,x.id,p.previewId,['name'],async()=>true),/unavailable/);
 await assert.rejects(f.store.evidence(f.original.id,'unapproved-device'));
 f.advance(600001);await assert.rejects(f.apply(x,p),/expired/);f.advance(0);
 await fs.rename(x.keyFile,x.keyFile+'.lost');await assert.rejects(f.apply(x,p),/material/);await fs.rename(x.keyFile+'.lost',x.keyFile);
 const raw=JSON.parse(await fs.readFile(f.authorityFile,'utf8'));raw.localParticipant.seal='wrong-account';await fs.writeFile(f.authorityFile,JSON.stringify(raw));await assert.rejects(f.apply(x,p));
 assert.equal((await f.source(f.original.id)).name,'Edited name');
});

test('atomic replacement failure preserves old registry and permits safe retry',async t=>{
 const f=await fixture(t),{x,p}=await changed(f),before=await fs.readFile(f.file,'utf8');f.failWrites();
 await assert.rejects(f.apply(x,p),/atomic rename/);assert.equal(await fs.readFile(f.file,'utf8'),before);assert(!(await fs.readdir(f.app)).some(n=>n.endsWith('.tmp')));
 f.restart();assert.equal((await f.apply(x,p)).replayed,false);assert.equal((await f.source(f.original.id)).name,'Apollo');
});

test('crash between registry commit and evidence acknowledgement recovers using the atomic receipt',async t=>{
 const f=await fixture(t),{x,p}=await changed(f);f.afterCommit(()=>f.setSealFailure(true));
 await assert.rejects(f.apply(x,p),/acknowledgement/);assert.equal((await f.source(f.original.id)).name,'Apollo');
 f.setSealFailure(false);f.afterCommit(()=>{});f.restart();const replay=await f.apply(x,p);assert.equal(replay.replayed,true);assert.equal(JSON.parse(await fs.readFile(f.file)).recoveryReceipts.length,1);
});

test('corrupt receipt or protected preview is preserved and blocks restore',async t=>{
 const f=await fixture(t),{x,p}=await changed(f),raw=JSON.parse(await fs.readFile(f.file,'utf8'));raw.recoveryReceipts=[{id:'corrupt'}];const corrupt=JSON.stringify(raw);await fs.writeFile(f.file,corrupt);
 await assert.rejects(f.apply(x,p),/recovery|corrupt/i);assert.equal(await fs.readFile(f.file,'utf8'),corrupt);
 delete raw.recoveryReceipts;await fs.writeFile(f.file,JSON.stringify(raw));const envelope=JSON.parse(await fs.readFile(f.evidenceFile)),d=JSON.parse(f.protection.open(envelope.sealed));d.records[0].preview.liveDigest='invalid';await fs.writeFile(f.evidenceFile,JSON.stringify({version:1,sealed:f.protection.seal(JSON.stringify(d))}));
 await assert.rejects(f.apply(x,p),/corrupt/);
});

test('immutable identity conflicts block restore; export approval is bound to the reviewed source',async t=>{
 const f=await fixture(t),before=await f.source(f.original.id),{x}=await changed(f);
 await assert.rejects(f.store.create(f.original.id,f.snap,f.key,digest(before)),/export approval/);
 const data=JSON.parse(await fs.readFile(f.file));data.projects[0].type='College Project';await fs.writeFile(f.file,JSON.stringify(data));
 const p=await f.preview(x);assert(p.blockers.includes('IMMUTABLE_PROJECT_CONFLICT'));await assert.rejects(f.apply(x,p),/Immutable/);
});

test('native IPC reviews export and selected differences, requires explicit operation and cancel defaults',async t=>{
 const f=await fixture(t),{createRecoveryController}=await import('./recovery-ipc.cjs'),directory=path.join(f.app,'content');
 const safeStorage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(f.protection.seal(s)),decryptString:b=>f.protection.open(b.toString())};
 let picks=[f.snap,f.key],response=1;const dialogs=[];
 const controller=createRecoveryController({getStore:async()=>f.collaboration,getProjects:()=>f.registry.list(),restoreProjectMetadata:(r,a)=>f.registry.restoreMetadata(r,a),directory:()=>directory,safeStorage,parent:()=>null,dialog:{showMessageBox:async(_parent,options)=>{dialogs.push(options);return{response};},showOpenDialog:async()=>({canceled:false,filePaths:[picks.shift()]})}});
 const target={mode:'local',projectId:f.original.id},run=(action,payload={})=>controller.run(f.original.id,'recovery-'+action,{target,...payload});
 const record=await run('create');assert(JSON.parse(dialogs[0].detail).name==='Apollo');assert(!dialogs[0].detail.includes('DO-NOT-EXPORT'));
 await f.registry.update(f.original.id,{name:'Current title'});picks=[path.join(f.snap,record.snapshotId+'.edrecovery'),path.join(f.key,record.snapshotId+'.edkey')];
 const p=await run('preview',{snapshotId:record.snapshotId}),payload={snapshotId:record.snapshotId,previewId:p.previewId,fields:['name'],operation:'restore-selected-metadata'};
 await assert.rejects(run('restore',{...payload,operation:'restore-authority'}),/explicitly/);
 await assert.rejects(run('restore',{...payload,path:'C:/injected'}));
 await assert.rejects(controller.run(f.original.id,'recovery-restore',{...payload,target:{...target,contextId:randomUUID()}}));
 response=0;await assert.rejects(run('restore',payload),/cancelled/);assert.equal((await f.source(f.original.id)).name,'Current title');
 assert.equal(dialogs.at(-1).defaultId,0);assert.deepEqual(JSON.parse(dialogs.at(-1).detail),[{field:'name',current:'Current title',snapshot:'Apollo'}]);
 response=1;const result=await run('restore',payload);assert.equal(result.currentMatches,true);assert.equal((await f.source(f.original.id)).name,'Apollo');
});

test('last-mile material tampering and non-owner write authority cannot restore metadata',async t=>{
 const f=await fixture(t),{x,p}=await changed(f),before=await fs.readFile(f.file,'utf8'),a=await f.authority();
 const request={id:randomUUID(),projectId:f.original.id,snapshotId:x.id,principalId:a.principalId,identityBinding:a.identityBinding,authorityRevision:a.authorityRevision,expectedDigest:digest(await f.source(f.original.id)),expiresAt:new Date(Date.now()+600000).toISOString(),patch:{name:'Not authorized'}};
 for(const bad of [{role:'admin'},{local:false},{canPlan:false},{localPrincipalId:randomUUID()},{identityBinding:'f'.repeat(64)}])await assert.rejects(f.registry.restoreMetadata(request,{...a,...bad}),/authority required/);
 const envelope=JSON.parse(await fs.readFile(x.snapshot));envelope.tag='0'.repeat(32);await fs.writeFile(x.snapshot,JSON.stringify(envelope));await assert.rejects(f.apply(x,p),/material/);
 assert.equal(await fs.readFile(f.file,'utf8'),before);
});

test('existing registry and secure-content IPC chain reaches the same authorized atomic writer',async t=>{
 const f=await fixture(t),{installProjectRegistry}=await import('./registry-ipc.cjs');
 // Avoid starting the unrelated delivery scheduler while exercising real IPC registrations.
 t.mock.method(globalThis,'setInterval',()=>({unref(){}}));
 const privateDir=path.join(f.app,'ipc');await fs.mkdir(privateDir);const handlers=new Map();let picks=[f.snap,f.key];
 const safeStorage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(f.protection.seal(s)),decryptString:b=>f.protection.open(b.toString())};
 installProjectRegistry({ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},trusted:event=>{if(!event.trusted)throw Error('Untrusted renderer');},parent:()=>null,registryFile:()=>path.join(privateDir,'registry.json'),collaborationFile:()=>path.join(privateDir,'collaboration.json'),safeStorage,ui:{dialog:{showMessageBox:async()=>({response:1}),showOpenDialog:async()=>({canceled:false,filePaths:[picks.shift()]})},shell:{}}});
 const event={trusted:true},registry=(action,payload)=>handlers.get('workspace:registry')(event,action,payload);
 const project=await registry('create',{input:{name:'IPC original',description:'Restore status and pin too.',type:'Personal Project',origin:'new'}}),target={mode:'local',projectId:project.id};
 const secure=(action,payload={})=>handlers.get('workspace:secure-content')(event,project.id,'recovery-'+action,{target,...payload});
 const record=await secure('create');await registry('update',{id:project.id,patch:{name:'IPC modified',status:'Paused',pinned:true}});
 picks=[path.join(f.snap,record.snapshotId+'.edrecovery'),path.join(f.key,record.snapshotId+'.edkey')];const preview=await secure('preview',{snapshotId:record.snapshotId});
 const result=await secure('restore',{snapshotId:record.snapshotId,previewId:preview.previewId,fields:['name','status','pinned'],operation:'restore-selected-metadata'});assert.equal(result.currentMatches,true);
 const current=(await registry('list')).projects[0];assert.equal(current.name,'IPC original');assert.equal(current.status,'Planned');assert.equal(current.pinned,false);
 await assert.rejects(handlers.get('workspace:secure-content')({},project.id,'recovery-list',{target}),/Untrusted/);
 await assert.rejects(registry('restore-metadata',{}),/Unsupported/);
});
