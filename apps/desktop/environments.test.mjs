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
    const item = { file, projectId, otherId, store, projects, protection, transport: createRemoteTransport(store, createSecureContentStore(path.join(root, name + '-content'), store).handle, createIntentionStore(path.join(root,name+'-intentions.json'),store).handle, undefined, createEnvironmentStore(path.join(root,name+'-environments.json'),store,{protection}).handle), fingerprint: readCertificate(credentials[name].certificate).fingerprint };
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




const sample=()=>({title:'Review evidence',capturedAt:new Date().toISOString(),system:{platform:'win32',release:'10.0',arch:'x64'},runtime:{node:'22.0.0'},tools:[{name:'node',available:'detected'}],dependencies:[{name:'example',required:'1.0.0',installed:'1.0.0'}],locks:[{name:'package-lock.json',sha256:'a'.repeat(64)}],config:{NODE_ENV:'development'},ports:[],limitations:[]});
const mutation=(fields=sample(),recordId=randomUUID(),baseVersion=0)=>({id:randomUUID(),recordId,baseVersion,kind:baseVersion?'revise':'create',fields});
async function ready(t,role='member') {const f=await fixture(t);f.invitation=await f.offer(undefined,role);await f.query('accept',f.invitation);f.ask=command=>f.peer.transport.query(f.host.fingerprint,'127.0.0.1',f.port,{version:1,projectId:f.host.projectId,...command});return f;}
test('capture reads real manifests and fingerprints, excludes URLs and requires consent',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.root,'package.json'),JSON.stringify({dependencies:{example:'https://user:password@private/source'},engines:{node:'22.0.0'},packageManager:'npm@10.0.0'}));await fs.writeFile(path.join(f.root,'package-lock.json'),'lock evidence');await fs.writeFile(path.join(f.root,'.env'),'TOKEN=neverread');
 await assert.rejects(captureEnvironment(f.root,{consent:false,config:[],ports:[]}));const x=await captureEnvironment(f.root,{consent:true,config:[],ports:[]});assert.equal(x.system.arch,os.arch());assert.equal(x.runtime.node,process.versions.node);assert.equal(x.dependencies[0].required,'redacted');assert.equal(x.dependencies[0].installed,'missing');assert.equal(x.locks[0].sha256,createHash('sha256').update('lock evidence').digest('hex'));assert(!JSON.stringify(x).includes(f.root));assert(!JSON.stringify(x).includes('neverread'));assert(!JSON.stringify(x).includes('password'));
});
test('capture rejects relative and linked project roots before reading project data',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.root,'package.json'),JSON.stringify({name:'private-project'}));
 await assert.rejects(captureEnvironment(path.relative(process.cwd(),f.root),{consent:true,config:[],ports:[]}),/absolute path/);
 const link=path.join(path.dirname(f.root),`echodrop-link-${randomUUID()}`);await fs.symlink(f.root,link,'junction');t.after(()=>fs.rm(link,{recursive:true,force:true}));
 await assert.rejects(captureEnvironment(link,{consent:true,config:[],ports:[]}),/linked/);
});
test('comparison distinguishes missing dependencies, drift, configuration and unknown evidence',()=>{
 const a=sample(),b=sample();b.dependencies[0].installed='missing';b.system.arch='arm64';b.locks[0].sha256='b'.repeat(64);b.config.NODE_ENV='production';const r=compareEnvironments(a,b);assert(r.issues.some(x=>x.severity==='blocker'));assert(r.issues.some(x=>x.field==='arch'));assert(r.issues.some(x=>x.field==='package-lock.json'));assert(r.issues.some(x=>x.field==='NODE_ENV'));assert.equal(compareEnvironments(a,a).issues.length,0);b.dependencies=[];assert(!compareEnvironments(a,b).issues.some(x=>x.field==='example'&&x.severity==='blocker'));
});
test('malformed and secret-bearing snapshot fields fail closed',()=>{
 for(const title of ['Bearer supersecret','password=hidden','ghp_123456789','C:\\Users\\private','/home/private/key'])assert.throws(()=>environmentFields({...sample(),title}));assert.throws(()=>environmentFields({...sample(),env:{TOKEN:'secret'}}));assert.throws(()=>environmentFields({...sample(),ports:[{port:-1,state:'accepting'}]}));assert.throws(()=>environmentFields({...sample(),capturedAt:'2026-10-25 secret'}));assert.throws(()=>environmentFields({...sample(),dependencies:[{name:'../secret',required:'1',installed:'1'}]}));
});
test('authenticated TLS snapshots persist, reject replay alteration and preserve history',async t=>{
 const f=await ready(t),operation=mutation();assert.equal((await f.ask({action:'environment-mutate',operation})).accepted,true);assert.equal((await f.ask({action:'environment-mutate',operation})).accepted,true);await assert.rejects(f.ask({action:'environment-mutate',operation:{...operation,fields:{...operation.fields,title:'Changed'}}}));
 const restarted=createEnvironmentStore(path.join(f.root,'host-environments.json'),f.host.store,{protection:f.host.protection});let state=await restarted.handle(null,{version:1,projectId:f.host.projectId,action:'environment-sync',since:0});assert.equal(state.records.length,1);assert.equal(state.records[0].history.length,1);assert(!(await fs.readFile(path.join(f.root,'host-environments.json'),'utf8')).includes('Review evidence'));
 const revised=mutation({...sample(),title:'Retest evidence'},operation.recordId,1);await f.ask({action:'environment-mutate',operation:revised});state=await f.ask({action:'environment-sync',since:0});assert.equal(state.records[0].history.length,2);assert.equal((await f.ask({action:'environment-mutate',operation:{...revised,id:randomUUID()}})).conflict,true);
 await f.ask({action:'environment-mutate',operation:{id:randomUUID(),recordId:operation.recordId,baseVersion:2,kind:'resolve'}});state=await f.ask({action:'environment-sync',since:0});assert.equal(state.records[0].status,'resolved');await fs.writeFile(path.join(f.root,'host-environments.json'),'corrupt');await assert.rejects(restarted.handle(null,{version:1,projectId:f.host.projectId,action:'environment-sync',since:0}),/corrupt/);assert.equal(await fs.readFile(path.join(f.root,'host-environments.json'),'utf8'),'corrupt');
});
test('TLS denies guests, unrelated projects, contexts and revoked invitations',async t=>{
 const f=await ready(t,'guest');await assert.rejects(f.ask({action:'environment-mutate',operation:mutation()}));await assert.rejects(f.ask({action:'environment-sync',since:0,projectId:f.host.otherId}));await assert.rejects(f.ask({action:'environment-sync',since:0,contextId:randomUUID()}));await assert.rejects(f.attacker.transport.query(f.host.fingerprint,'127.0.0.1',f.port,{version:1,projectId:f.host.projectId,action:'environment-sync',since:0}));await f.host.store.remoteLocal(f.host.projectId,'revoke',{invitationId:f.invitation});await assert.rejects(f.ask({action:'environment-sync',since:0}));
});
test('protected offline outbox restores and reconciles a lost TLS reply without duplicate publication',async t=>{
 const f=await ready(t);let clock=Date.now(),offline=false,lost=false;const file=path.join(f.root,'cache.json');const options={model:environmentClientModel,protection:f.peer.protection,now:()=>clock,authorize:async()=>{},execute:async(_id,_target,command)=>{if(offline)throw Error('Secure connection failed.');const result=await f.ask(command);if(lost&&command.action==='environment-mutate'){lost=false;throw Error('Secure connection closed before a verified reply.');}return result;}};
 let client=createIntentionClient(file,options);const target={mode:'remote',projectId:f.host.projectId,fingerprint:f.host.fingerprint,host:'127.0.0.1',port:f.port};const binding=await client.local(f.peer.projectId,'attach',{target});await client.tick();const op=mutation();offline=true;await client.local(f.peer.projectId,'submit',{id:binding.id,operation:op});clock+=20000;await client.tick();client=createIntentionClient(file,options);assert.equal((await client.local(f.peer.projectId,'view',{id:binding.id})).pending.length,1);offline=false;lost=true;clock+=400000;await client.tick();clock+=400000;await client.tick();const state=await client.local(f.peer.projectId,'view',{id:binding.id});assert.equal(state.pending.length,0);assert.equal(state.records.length,1);assert.equal(state.records[0].history.length,1);
});
test('author-only changes and stale revisions cannot overwrite a collaborator snapshot',async t=>{
 const f=await ready(t),op=mutation();await f.ask({action:'environment-mutate',operation:op});const store=createEnvironmentStore(path.join(f.root,'host-environments.json'),f.host.store,{protection:f.host.protection});await assert.rejects(store.handle(null,{version:1,projectId:f.host.projectId,action:'environment-mutate',operation:mutation(sample(),op.recordId,1)}),/author/);const first=mutation({...sample(),title:'First revision'},op.recordId,1),second=mutation({...sample(),title:'Concurrent revision'},op.recordId,1);const replies=await Promise.all([f.ask({action:'environment-mutate',operation:first}),f.ask({action:'environment-mutate',operation:second})]);assert.equal(replies.filter(x=>x.accepted).length,1);assert.equal(replies.filter(x=>x.conflict).length,1);const state=await f.ask({action:'environment-sync',since:0});assert.equal(state.records[0].history.length,2);
});
