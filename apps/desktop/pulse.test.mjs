import {createPulseStore} from './pulse-store.mjs';
import {derivePulse,pulseClientModel} from '../../packages/core/pulse.mjs';
import {captureEnvironment} from './environment-capture.mjs';
import {createEnvironmentStore} from './environment-store.mjs';
import {environmentFields,environmentClientModel,compareEnvironments} from '../../packages/core/environments.mjs';
import {createContractStore} from './contract-store.mjs';
import {contractClientModel,validateContractDocument} from '../../packages/core/contracts.mjs';
import {compareContracts} from '../../packages/core/contract-compatibility.mjs';
import {createIntentionStore} from './intention-store.mjs';
import {createIntentionClient} from './intention-client.mjs';
import {intentPath,intentFields,intentCollisions} from '../../packages/core/intentions.mjs';
import { createSecureContentStore } from './secure-content-store.mjs';
import { createContentReceiver } from './secure-content-receiver.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import tls from 'node:tls';
import net from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { createCollaborationStore } from './collaboration-store.mjs';
import { createRemoteTransport } from './remote-transport.mjs';
import { readCertificate, checkKey } from './remote-identity.mjs';
import { validateRemoteReply } from './remote-reply.mjs';

const credentials = {};
for (const name of ['host', 'peer', 'attacker']) credentials[name] = { certificate: await fs.readFile(new URL(`./test-fixtures/remote-tls/${name}-cert.pem`, import.meta.url), 'utf8'), key: await fs.readFile(new URL(`./test-fixtures/remote-tls/${name}-key.pem`, import.meta.url), 'utf8') };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echodrop-remote-'));
  const sealed = new Map();
  // Unit test OS-protection double; native DPAPI is exercised separately in Electron.
  const protection = { seal(value) { const token = randomUUID(); sealed.set(token, value); return token; }, open(token) { if (!sealed.has(token)) throw Error('Cannot decrypt'); return sealed.get(token); } };
  const endpoints = [];
  t.after(async () => {
    for (const endpoint of endpoints) await endpoint.transport.stop();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('echodrop-remote-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  async function endpoint(name) {
    const file = path.join(root, `${name}.json`), projectId = randomUUID(), otherId = randomUUID();
    const projects = async () => ({ projects: [{ id: projectId, name: `${name} project`, description: 'PRIVATE DESCRIPTION', localRoot: 'C:/PRIVATE' }, { id: otherId, name: 'OTHER PRIVATE PROJECT' }] });
    const store = createCollaborationStore(file, projects, undefined, protection); await store.snapshot(projectId);
    await store.remoteLocal(projectId, 'import-identity', credentials[name]);
    const item = { file, projectId, otherId, store, projects, protection, transport: createRemoteTransport(store, createSecureContentStore(path.join(root, name + '-content'), store).handle, createIntentionStore(path.join(root,name+'-intentions.json'),store).handle, undefined, undefined, createPulseStore(path.join(root,name+'-pulse.json'),store,{protection,collect:async(fp,q)=>({intentions:(await createIntentionStore(path.join(root,name+'-intentions.json'),store).handle(fp,{...q,action:'intent-sync',since:0,operation:undefined})).records,contracts:[],environments:[],transfers:[]})}).handle), fingerprint: readCertificate(credentials[name].certificate).fingerprint };
    endpoints.push(item); return item;
  }
  async function trust(from, to) {
    await from.store.remoteLocal(from.projectId, 'create-invitee', { displayName: 'Verified person' });
    const snapshot = await from.store.snapshot(from.projectId);
    const principalId = snapshot.directory.filter(person => person.kind === 'record').at(-1).id;
    await from.store.remoteLocal(from.projectId, 'trust-peer', { certificate: credentials[to === host ? 'host' : to === peer ? 'peer' : 'attacker'].certificate, fingerprint: to.fingerprint, principalId });
    return principalId;
  }
  const host = await endpoint('host'), peer = await endpoint('peer'), attacker = await endpoint('attacker');
  const recipientId = await trust(host, peer); await trust(peer, host); await trust(attacker, host);
  const { port } = await host.transport.start();
  const query = (action, invitationId, from = peer) => from.transport.query(host.fingerprint, '127.0.0.1', port, { version: 1, action, ...(invitationId ? { invitationId } : {}) });
  async function offer(contextId, role = 'member') {
    const snapshot = await host.store.execute(host.projectId, { action: 'prepare-invitation-draft', recipientId, role, expiresAt: null, ...(contextId ? { contextId } : {}) });
    const id = snapshot.invitationDrafts.at(-1).id;
    await host.store.remoteLocal(host.projectId, 'offer', { invitationId: id }); return id;
  }
  return { root, host, peer, attacker, recipientId, query, offer, trust, port };
}




const intent=(extra={})=>({id:randomUUID(),participantId:randomUUID(),description:'Actual work',status:'active',paths:['src/auth'],modules:[],expiresAt:new Date(Date.now()+3600000).toISOString(),updatedAt:new Date().toISOString(),...extra});
const empty=()=>({intentions:[],contracts:[],environments:[],transfers:[]});
test('Pulse prioritizes collisions and labels stale handoff inference with no arbitrary health score',()=>{const a=intent(),b=intent({paths:['src/auth/login']});const result=derivePulse({...empty(),intentions:[a,b],transfers:[{id:randomUUID(),senderId:a.participantId,recipientId:b.participantId,name:'Build',state:'uploading',createdAt:new Date(Date.now()-90000000).toISOString()}]});assert.equal(result[0].severity,'high');assert(result.some(r=>r.key.startsWith('handoff:')&&r.inferred));assert(!derivePulse({...empty(),intentions:[a,intent({paths:['src/billing']})]}).some(r=>r.key.startsWith('collision:')));});
async function localFixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'echodrop-pulse-'));t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('echodrop-pulse-'));await fs.rm(root,{recursive:true,force:true});});const principalId=randomUUID(),projectId=randomUUID(),sealed=new Map();const protection={seal(x){const id=randomUUID();sealed.set(id,x);return id;},open(id){if(!sealed.has(id))throw Error();return sealed.get(id);}};let denied=false;const collaboration={withContentAuthority:async(fp,p,c,fn)=>{if(denied||p!==projectId||c)throw Error('denied');return fn({principalId,canWrite:fp!=='guest'});}};const sources={...empty(),intentions:[intent({participantId:principalId})]};const file=path.join(root,'pulse.json');const options={protection,collect:async()=>sources};const store=createPulseStore(file,collaboration,options);const call=q=>store.handle(null,{version:1,projectId,...q});return{root,file,call,sources,principalId,projectId,protection,collaboration,options,store,revoke:()=>{denied=true;}};}
test('Pulse history deduplicates observations, persists and records version-safe decisions',async t=>{const f=await localFixture(t);let r=await f.call({action:'pulse-sync',since:0});const first=r.records[0];r=await f.call({action:'pulse-sync',since:0});assert.equal(r.records[0].events.length,1);const operation={id:randomUUID(),recordId:first.id,kind:'acknowledge',baseVersion:first.version};await f.call({action:'pulse-mutate',operation});await f.call({action:'pulse-mutate',operation});const restored=createPulseStore(f.file,f.collaboration,f.options);r=await restored.handle(null,{version:1,projectId:f.projectId,action:'pulse-sync',since:0});assert.equal(r.records[0].status,'acknowledged');assert.equal(r.records[0].events.length,2);assert.equal((await f.call({action:'pulse-mutate',operation:{...operation,id:randomUUID(),kind:'resolve'}})).conflict,true);f.sources.intentions[0].description='New evidence';r=await f.call({action:'pulse-sync',since:0});assert.equal(r.records[0].status,'open');assert.equal(r.records[0].events.at(-1).kind,'evidence-changed');});
test('Pulse rejects history operations that are not bound to a stored record',async t=>{const f=await localFixture(t);await f.call({action:'pulse-sync',since:0});const envelope=JSON.parse(await fs.readFile(f.file,'utf8'));const data=JSON.parse(f.protection.open(envelope.sealed));data.scopes[0].operations.push({id:randomUUID(),actor:f.principalId,recordId:randomUUID(),hash:'a'.repeat(64)});await fs.writeFile(f.file,JSON.stringify({version:1,sealed:f.protection.seal(JSON.stringify(data))}));await assert.rejects(f.call({action:'pulse-sync',since:0}),/corrupt/);});
test('Pulse denies scope access, guest mutations and revocation; hidden sources never leak from history',async t=>{const f=await localFixture(t);const r=await f.call({action:'pulse-sync',since:0});await assert.rejects(f.store.handle('guest',{version:1,projectId:f.projectId,action:'pulse-mutate',operation:{id:randomUUID(),recordId:r.records[0].id,kind:'resolve',baseVersion:1}}));await assert.rejects(f.call({action:'pulse-sync',since:0,projectId:randomUUID()}));await assert.rejects(f.call({action:'pulse-sync',since:0,contextId:randomUUID()}));f.sources.intentions=[];assert.equal((await f.call({action:'pulse-sync',since:0})).records.length,0);f.revoke();await assert.rejects(f.call({action:'pulse-sync',since:0}));});
test('Pulse corruption preserves original storage and blocks reads',async t=>{const f=await localFixture(t);await f.call({action:'pulse-sync',since:0});await fs.writeFile(f.file,'bad storage');await assert.rejects(f.call({action:'pulse-sync',since:0}),/corrupt/);assert.equal(await fs.readFile(f.file,'utf8'),'bad storage');});
test('Pulse decisions survive offline restart and replay without duplicate events',async t=>{const f=await localFixture(t);let offline=false,clock=Date.now();const options={model:pulseClientModel,protection:f.protection,authorize:async()=>{},now:()=>clock,execute:async(_p,_t,q)=>{if(offline)throw Error('Secure connection failed.');return f.call(q);}};const file=path.join(f.root,'client.json');let c=createIntentionClient(file,options);const b=await c.local(f.projectId,'attach',{target:{mode:'local',projectId:f.projectId}});await c.tick();const state=await c.local(f.projectId,'view',{id:b.id});offline=true;await c.local(f.projectId,'submit',{id:b.id,operation:{recordId:state.records[0].id,kind:'acknowledge',baseVersion:1}});await c.tick();c=createIntentionClient(file,options);assert.equal((await c.local(f.projectId,'view',{id:b.id})).pending.length,1);offline=false;clock+=400000;await c.tick();assert.equal((await c.local(f.projectId,'view',{id:b.id})).pending.length,0);assert.equal((await f.call({action:'pulse-sync',since:0})).records[0].events.length,2);});
test('real mutually authenticated TLS exchanges Pulse and persists shared acknowledgement',async t=>{const f=await fixture(t);await f.query('accept',await f.offer());const intentions=createIntentionStore(path.join(f.root,'host-intentions.json'),f.host.store);await intentions.handle(null,{version:1,projectId:f.host.projectId,action:'intent-mutate',operation:{id:randomUUID(),recordId:randomUUID(),kind:'create',baseVersion:0,fields:{description:'TLS work',paths:['src/auth'],modules:[],hours:24}}});const ask=q=>f.peer.transport.query(f.host.fingerprint,'127.0.0.1',f.port,{version:1,projectId:f.host.projectId,...q});const r=await ask({action:'pulse-sync',since:0});assert.equal(r.records.length,1);await ask({action:'pulse-mutate',operation:{id:randomUUID(),recordId:r.records[0].id,baseVersion:r.records[0].version,kind:'acknowledge'}});assert.equal((await ask({action:'pulse-sync',since:0})).records[0].status,'acknowledged');await assert.rejects(ask({action:'pulse-sync',since:0,contextId:randomUUID()}));});
test('API and environment evidence produce explainable findings without pairing unrelated labels',()=>{
 const doc=(type)=>({openapi:'3.0.3',info:{title:'Shared API',version:'1'},paths:{'/item':{get:{responses:{'200':{description:'Result',content:{'application/json':{schema:{type}}}}}}}}});
 const a={id:randomUUID(),participantId:randomUUID(),updatedAt:new Date().toISOString(),status:'published',authorActive:true,contentVersion:1,fields:{side:'expected',document:doc('string')}},b={...a,id:randomUUID(),participantId:randomUUID(),fields:{side:'implemented',document:doc('integer')}};
 assert(derivePulse({...empty(),contracts:[a,b]}).some(r=>r.key.startsWith('api:')&&r.severity==='high'));b.fields.document.info.title='Different API';assert(!derivePulse({...empty(),contracts:[a,b]}).some(r=>r.key.startsWith('api:')));
});
test('targeted reconnect advances only the requested persisted Pulse binding',async t=>{const f=await localFixture(t);let calls=0;const client=createIntentionClient(path.join(f.root,'targeted.json'),{model:pulseClientModel,protection:f.protection,authorize:async()=>{},execute:async(_p,_t,q)=>{calls++;return f.call(q);}});const b=await client.local(f.projectId,'attach',{target:{mode:'local',projectId:f.projectId}});await client.tick(randomUUID());assert.equal(calls,0);await client.tick(b.id);assert.equal(calls,1);});
