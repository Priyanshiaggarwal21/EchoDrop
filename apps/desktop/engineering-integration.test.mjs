import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {createProjectRegistry} from './project-registry.mjs';
import {createCollaborationStore} from './collaboration-store.mjs';
import {createGuardianStore} from './guardian-store.mjs';
import {createRecoveryStore} from './recovery-store.mjs';
import {createDependencyInventory} from './dependency-inventory.mjs';
import {createDnaStore} from './project-dna-store.mjs';
import {INVENTORY_CATEGORIES,INVENTORY_UNKNOWN} from '../../packages/core/dependency-inventory.mjs';
import {readCertificate} from './remote-identity.mjs';

async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'echodrop-integration-'));t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('echodrop-integration-'));await fs.rm(root,{recursive:true,force:true});});
 const app=path.join(root,'app'),snap=path.join(root,'snap'),keys=path.join(root,'keys');await Promise.all([app,snap,keys].map(p=>fs.mkdir(p)));
 const seals=new Map(),protection={seal(s){const id=randomUUID();seals.set(id,s);return id;},open(id){if(!seals.has(id))throw Error('Unavailable protected identity');return seals.get(id);}};
 const registryFile=path.join(app,'projects.json');let registry=createProjectRegistry(registryFile);
 const project=await registry.create({name:'PRIVATE original',description:'PRIVATE description',type:'Team Project',origin:'new'}),other=await registry.create({name:'Other',type:'Personal Project',origin:'new'});
 const collaboration=createCollaborationStore(path.join(app,'collaboration.json'),()=>registry.list(),undefined,protection);const owner=(await collaboration.snapshot(project.id)).actor.id;await collaboration.snapshot(other.id);
 const source=async id=>(await registry.list()).projects.find(p=>p.id===id);
 const recovery=()=>createRecoveryStore(path.join(app,'recovery.json'),{protection,privateRoot:app,source,authorize:(fp,id)=>collaboration.withGuardianAuthority(fp,id,undefined,a=>a),commit:r=>collaboration.withGuardianAuthority(null,r.projectId,undefined,a=>registry.restoreMetadata(r,a))});
 const inventory=()=>createDependencyInventory(path.join(app,'inventory.json'),collaboration,{protection});
 const guardian=(collect=async()=>({transfers:[],queue:[],queueKnown:true}))=>createGuardianStore(path.join(app,'guardian.json'),collaboration,{protection,collect});
 return {root,app,snap,keys,project,other,owner,collaboration,source,recovery,inventory,guardian,protection,get registry(){return registry;},restart(){registry=createProjectRegistry(registryFile);}};
}
const read=(store,id)=>store.handle(null,{version:1,action:'guardian-list',projectId:id});
const plan=(f,store)=>store.handle(null,{version:1,action:'guardian-create',projectId:f.project.id,operation:{id:randomUUID(),planId:randomUUID(),baseVersion:0,departingId:f.owner,proposal:'step-down',actions:['review-access-dependencies']}});

test('metadata restore invalidates Guardian, recovery and inventory across restart without invalidating another project',async t=>{
 const f=await fixture(t),credentials=async name=>({certificate:await fs.readFile(new URL(`./test-fixtures/remote-tls/${name}-cert.pem`,import.meta.url),'utf8'),key:await fs.readFile(new URL(`./test-fixtures/remote-tls/${name}-key.pem`,import.meta.url),'utf8')});
 await f.collaboration.remoteLocal(f.project.id,'import-identity',await credentials('host'));const peer=await credentials('peer'),fingerprint=readCertificate(peer.certificate).fingerprint;
 await f.collaboration.remoteLocal(f.project.id,'create-invitee',{displayName:'Peer'});const person=(await f.collaboration.snapshot(f.project.id)).directory.filter(p=>p.kind==='record').at(-1);
 await f.collaboration.remoteLocal(f.project.id,'trust-peer',{certificate:peer.certificate,fingerprint,principalId:person.id});const draft=(await f.collaboration.execute(f.project.id,{action:'prepare-invitation-draft',recipientId:person.id,role:'member',expiresAt:null})).invitationDrafts.at(-1);await f.collaboration.remoteLocal(f.project.id,'offer',{invitationId:draft.id});await f.collaboration.remoteRequest(fingerprint,{version:1,action:'accept',invitationId:draft.id});
 const recovery=f.recovery(),snapshot=await recovery.create(f.project.id,f.snap,f.keys);await f.registry.update(f.project.id,{name:'PRIVATE changed'});
 const inventory=f.inventory(),challenge=await inventory.handle(fingerprint,{version:1,action:'inventory-begin',projectId:f.project.id});const {issuedAt,expiresAt,...binding}=challenge;
 await inventory.handle(fingerprint,{version:1,action:'inventory-submit',projectId:f.project.id,report:{...binding,evidenceVersion:1,generatedAt:new Date().toISOString(),categories:INVENTORY_CATEGORIES.map(category=>({category,status:'OBSERVED'})),facts:[],unsupported:INVENTORY_UNKNOWN,complete:false}});
 const guardian=f.guardian();const before=await plan(f,guardian);await f.registry.update(f.other.id,{description:'Unrelated change'});assert.equal((await read(guardian,f.project.id)).records[0].guard,before.records[0].guard);assert.equal((await inventory.list(null,{projectId:f.project.id})).devices[0].status,'OBSERVED');
 const preview=await recovery.verify(f.project.id,snapshot.snapshotId,path.join(f.snap,snapshot.snapshotId+'.edrecovery'),path.join(f.keys,snapshot.snapshotId+'.edkey'));await recovery.restore(f.project.id,snapshot.snapshotId,preview.previewId,['name'],async()=>true);
 assert.equal((await read(guardian,f.project.id)).records[0].status,'stale');assert.equal((await inventory.list(null,{projectId:f.project.id})).devices[0].status,'STALE');assert.equal((await recovery.evidence(f.project.id))[0].status,'STALE');
 f.restart();const restored=await read(f.guardian(),f.project.id);assert.equal(restored.records[0].status,'stale');assert.equal(restored.readiness[0].ready,false);assert.equal(restored.readiness[0].executionAvailable,false);assert.equal(restored.readiness[0].checks.find(c=>c.code==='recovery-capability').status,'UNKNOWN');assert.equal((await f.inventory().list(null,{projectId:f.project.id})).devices[0].status,'STALE');assert.equal((await f.source(f.project.id)).name,'PRIVATE original');
 assert(!JSON.stringify(restored).includes('PRIVATE'));
});

test('DNA rejects authority changes during collection before persisting or returning stale visible evidence',async t=>{
 const f=await fixture(t),file=path.join(f.app,'dna.json');let race=false;
 const dna=createDnaStore(file,f.collaboration,{protection:f.protection,collect:async()=>{const project=await f.source(f.project.id);if(race)await f.collaboration.execute(f.project.id,{action:'add-project-member',displayName:'Changed during collection',role:'member'});return {project};}});
 const query={version:1,action:'dna-read',projectId:f.project.id,since:0},initial=await dna.handle(null,query),bytes=await fs.readFile(file,'utf8');race=true;
 await assert.rejects(dna.handle(null,{...query,action:'dna-detail',id:initial.events[0].id}),/authority.*changed/i);assert.equal(await fs.readFile(file,'utf8'),bytes);
 race=false;const next=await dna.handle(null,query);assert.deepEqual(next.events,initial.events);await assert.rejects(dna.handle(null,{...query,contextId:randomUUID()}));
});

test('Guardian rejects metadata changes during collection and DNA observes restored metadata history without private text',async t=>{
 const f=await fixture(t);const guardian=f.guardian(async()=>{await f.registry.update(f.project.id,{status:'Paused'});return {transfers:[],queue:[],queueKnown:true};});await assert.rejects(plan(f,guardian),/authority.*changed/i);
 const file=path.join(f.app,'dna.json'),make=()=>createDnaStore(file,f.collaboration,{protection:f.protection,collect:async()=>({project:await f.source(f.project.id)})}),query={version:1,action:'dna-read',projectId:f.project.id,since:0};const first=await make().handle(null,query);await f.registry.update(f.project.id,{status:'Active'});f.restart();const second=await make().handle(null,query);assert(second.events.length>first.events.length);assert(second.events.some(e=>e.facts.status==='Paused'));assert(second.events.some(e=>e.facts.status==='Active'));assert(!JSON.stringify(second).includes('PRIVATE'));
});
