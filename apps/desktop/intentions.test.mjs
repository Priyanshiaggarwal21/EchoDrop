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
    const item = { file, projectId, otherId, store, projects, protection, transport: createRemoteTransport(store, createSecureContentStore(path.join(root, name + '-content'), store).handle, createIntentionStore(path.join(root,name+'-intentions.json'),store).handle), fingerprint: readCertificate(credentials[name].certificate).fingerprint };
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



const fields={description:'Update authentication',paths:['src/auth'],modules:['authentication'],hours:24};
const operation=(kind='create',recordId=randomUUID(),baseVersion=0)=>({id:randomUUID(),recordId,baseVersion,kind,...(['create','revise'].includes(kind)?{fields}:{})});
async function ready(t,role='member'){
 const f=await fixture(t);await f.query('accept',await f.offer(undefined,role));
 f.ask=command=>f.peer.transport.query(f.host.fingerprint,'127.0.0.1',f.port,{version:1,projectId:f.host.projectId,...command});
 f.local=command=>createIntentionStore(path.join(f.root,'host-intentions.json'),f.host.store).handle(null,{version:1,projectId:f.host.projectId,...command});
 return f;
}
test('Windows normalized exact, nested and module claims collide without prefix false positives',()=>{
 assert.equal(intentPath('SRC\\Auth/./Login.ts'),'src/auth/login.ts');
 for(const bad of ['../private','C:\\secret','/absolute','src/CON','src/name.'])assert.throws(()=>intentPath(bad));
 const normalized=intentFields({...fields,paths:['SRC/AUTH','src/auth'],modules:[' Authentication ']});assert.deepEqual(normalized.paths,['src/auth']);
 const record={id:'other',participantId:'peer',status:'active',expiresAt:new Date(Date.now()+60000).toISOString(),paths:['src/auth/login.ts'],modules:['authentication']};
 assert.equal(intentCollisions(normalized,[record],'me').length,1);
 assert.equal(intentCollisions({...normalized,paths:['src/author'],modules:[]},[record],'me').length,0);
 assert.equal(intentCollisions(normalized,[record],'peer').length,0);
 assert.equal(intentCollisions(normalized,[{...record,status:'resolved'}],'me').length,0);
});
test('real TLS initial exchange, incremental updates and authored coordination notes',async t=>{
 const f=await ready(t);const first=await f.ask({action:'intent-sync',since:0});assert.equal(first.reset,true);assert.deepEqual(first.records,[]);
 const op=operation();await f.local({action:'intent-mutate',operation:op});
 const delta=await f.ask({action:'intent-sync',since:first.revision,epoch:first.epoch});assert.equal(delta.reset,false);assert.equal(delta.records.length,1);assert.notEqual(delta.records[0].participantId,delta.principalId);
 const note={...operation('coordinate',op.recordId,1),text:'I can take the tests while you edit auth.'};await f.ask({action:'intent-mutate',operation:note});
 const updated=await f.local({action:'intent-sync',since:delta.revision,epoch:delta.epoch});assert.equal(updated.records[0].notes[0].participantId,f.recipientId);
 const unchanged=await f.ask({action:'intent-sync',since:updated.revision,epoch:updated.epoch});assert.deepEqual(unchanged.records,[]);
});
test('simultaneous edits conflict, replay is idempotent and operation IDs cannot be rebound',async t=>{
 const f=await ready(t),create=operation();await f.ask({action:'intent-mutate',operation:create});
 const a=operation('revise',create.recordId,1),b=operation('resolve',create.recordId,1);
 const results=await Promise.all([f.ask({action:'intent-mutate',operation:a}),f.ask({action:'intent-mutate',operation:b})]);assert.equal(results.filter(r=>r.accepted).length,1);assert.equal(results.filter(r=>r.conflict).length,1);
 assert.equal((await f.ask({action:'intent-mutate',operation:create})).accepted,true);
 await assert.rejects(f.ask({action:'intent-mutate',operation:{...create,fields:{...fields,description:'rebound'}}}));
 const snapshot=await f.ask({action:'intent-sync',since:0});assert.equal(snapshot.records.length,1);assert.equal(snapshot.records[0].version,2);
});
test('project/context isolation, untrusted certificates, guest mutation and author boundaries',async t=>{
 const f=await ready(t,'guest');await assert.rejects(f.ask({action:'intent-mutate',operation:operation()}));
 await assert.rejects(f.ask({action:'intent-sync',since:0,projectId:f.host.otherId}));
 const context=(await f.host.store.execute(f.host.projectId,{action:'create-context',name:'Private context',purpose:''})).contexts[0];
 await assert.rejects(f.ask({action:'intent-sync',since:0,contextId:context.id}));
 await f.query('accept',await f.offer(context.id,'guest'));
 await f.local({action:'intent-mutate',contextId:context.id,operation:operation()});
 assert.equal((await f.ask({action:'intent-sync',since:0,contextId:context.id})).records.length,1);
 assert.deepEqual((await f.ask({action:'intent-sync',since:0})).records,[]);
 await assert.rejects(f.attacker.transport.query(f.host.fingerprint,'127.0.0.1',f.port,{version:1,projectId:f.host.projectId,action:'intent-sync',since:0}));
});
test('member removal blocks sync and retires active work; stale work stops collision warnings',async t=>{
 const f=await ready(t),op=operation();await f.ask({action:'intent-mutate',operation:op});
 await assert.rejects(f.local({action:'intent-mutate',operation:operation('resolve',op.recordId,1)}));
 await f.host.store.execute(f.host.projectId,{action:'change-project-member',principalId:f.recipientId,remove:true});
 await assert.rejects(f.ask({action:'intent-sync',since:0}));assert.equal((await f.local({action:'intent-sync',since:0})).records[0].status,'revoked');
 const next=operation();await f.local({action:'intent-mutate',operation:next});
 const later=createIntentionStore(path.join(f.root,'host-intentions.json'),f.host.store,()=>Date.now()+25*3600000);
 const state=await later.handle(null,{version:1,projectId:f.host.projectId,action:'intent-sync',since:0});assert.equal(state.records.find(r=>r.id===next.recordId).status,'stale');
});
async function clientFixture(f){
 let time=Date.now(),offline=false,loseReply=false;
 const target={mode:'remote',projectId:f.host.projectId,fingerprint:f.host.fingerprint,host:'127.0.0.1',port:f.port};
 const config={protection:f.peer.protection,authorize:id=>f.peer.store.snapshot(id),now:()=>time,execute:async(_id,_target,command)=>{if(offline)throw Error('Secure connection timed out.');const result=await f.ask(command);if(loseReply&&command.action==='intent-mutate'){loseReply=false;throw Error('Secure connection closed before a verified reply.');}return result;}};
 const file=path.join(f.root,'client-cache.json'),make=()=>createIntentionClient(file,config);const client=make();const binding=await client.local(f.peer.projectId,'attach',{target});await client.tick();
 return{client,binding,file,make,advance:()=>time+=400000,offline:value=>offline=value,loseReply:()=>loseReply=true};
}
test('offline edits survive restart; lost mutation reply reconciles without duplicate work',async t=>{
 const f=await ready(t),c=await clientFixture(f);c.offline(true);const op=operation();await c.client.local(f.peer.projectId,'submit',{id:c.binding.id,operation:op});await c.client.tick();assert.equal((await c.client.local(f.peer.projectId,'view',{id:c.binding.id})).pending.length,1);
 assert(!(await fs.readFile(c.file,'utf8')).includes(fields.description));
 const restarted=c.make();c.offline(false);c.loseReply();c.advance();await restarted.tick();c.advance();await restarted.tick();
 const state=await restarted.local(f.peer.projectId,'view',{id:c.binding.id});assert.equal(state.pending.length,0);assert.equal(state.records.length,1);assert.equal(state.records[0].version,1);
});
test('reconnect preserves conflicting draft until explicit reviewed rebase',async t=>{
 const f=await ready(t),op=operation();await f.ask({action:'intent-mutate',operation:op});const c=await clientFixture(f);
 await c.client.local(f.peer.projectId,'submit',{id:c.binding.id,operation:operation('revise',op.recordId,1)});
 await f.ask({action:'intent-mutate',operation:operation('resolve',op.recordId,1)});await c.client.tick();
 let state=await c.client.local(f.peer.projectId,'view',{id:c.binding.id});assert.equal(state.pending[0].state,'conflict');assert.equal(state.records[0].status,'resolved');
 await c.client.local(f.peer.projectId,'rebase',{id:c.binding.id,operationId:state.pending[0].operation.id,version:2});await c.client.tick();state=await c.client.local(f.peer.projectId,'view',{id:c.binding.id});assert.equal(state.pending.length,0);assert.equal(state.records[0].version,3);assert.equal(state.records[0].status,'active');
});
test('revocation hides cached activity, blocks pending publication and preserves corruption',async t=>{
 const f=await ready(t),c=await clientFixture(f);await c.client.local(f.peer.projectId,'submit',{id:c.binding.id,operation:operation()});
 await f.host.store.execute(f.host.projectId,{action:'change-project-member',principalId:f.recipientId,remove:true});await c.client.tick();const state=await c.client.local(f.peer.projectId,'view',{id:c.binding.id});assert.equal(state.blocked,true);assert.deepEqual(state.records,[]);assert.equal(state.pending.length,1);
 await assert.rejects(c.client.local(f.peer.otherId,'view',{id:c.binding.id}));
 await fs.writeFile(c.file,'broken');await assert.rejects(c.make().tick(),/preserved/);assert.equal(await fs.readFile(c.file,'utf8'),'broken');
 const serverFile=path.join(f.root,'host-intentions.json');await fs.writeFile(serverFile,'broken');await assert.rejects(f.local({action:'intent-sync',since:0}),/preserved/);assert.equal(await fs.readFile(serverFile,'utf8'),'broken');
});
test('bounded initial pages reconcile before enabling edits',async t=>{
 const f=await ready(t);await f.local({action:'intent-mutate',operation:operation()});
 const file=path.join(f.root,'host-intentions.json'),data=JSON.parse(await fs.readFile(file,'utf8')),scope=data.scopes[0],sample=scope.records[0];
 scope.records=Array.from({length:40},(_,i)=>({...sample,id:randomUUID(),revision:i+1,description:'x'.repeat(1000),paths:Array.from({length:20},(_,j)=>`src/${j}/`+'x'.repeat(140))}));scope.operations=[];scope.revision=40;await fs.writeFile(file,JSON.stringify(data));
 const c=await clientFixture(f);let view=await c.client.local(f.peer.projectId,'view',{id:c.binding.id});assert(view.records.length<40);assert.equal(view.canWrite,false);
 for(let i=0;i<5&&view.records.length<40;i++){c.advance();await c.client.tick();view=await c.client.local(f.peer.projectId,'view',{id:c.binding.id});}
 assert.equal(view.records.length,40);assert.equal(new Set(view.records.map(r=>r.id)).size,40);assert.equal(view.canWrite,true);
});
test('host history replacement never silently rebases persisted offline edits',async t=>{
 const f=await ready(t),op=operation();await f.ask({action:'intent-mutate',operation:op});const c=await clientFixture(f);
 await c.client.local(f.peer.projectId,'submit',{id:c.binding.id,operation:operation('revise',op.recordId,1)});
 const file=path.join(f.root,'host-intentions.json'),data=JSON.parse(await fs.readFile(file,'utf8'));data.epoch=randomUUID();await fs.writeFile(file,JSON.stringify(data));await c.client.tick();
 const view=await c.client.local(f.peer.projectId,'view',{id:c.binding.id});assert.equal(view.pending[0].state,'conflict');assert.match(view.pending[0].error,/history changed/);assert.equal(view.records[0].version,1);
});

test('persisted non-canonical scopes collide after host and protected client reload without changing history',async t=>{
 const f=await ready(t);await f.local({action:'intent-mutate',operation:operation()});
 const file=path.join(f.root,'host-intentions.json'),data=JSON.parse(await fs.readFile(file,'utf8'));
 const original=data.scopes[0].records[0];original.paths=['SRC/AUTH'];original.modules=['Authentication'];
 const persisted=JSON.stringify(data);await fs.writeFile(file,persisted);
 const assertCanonical=record=>{
  assert.deepEqual(record,{...original,paths:['src/auth'],modules:['authentication']});
  const hits=candidate=>intentCollisions(candidate,[record],f.recipientId);
  assert.deepEqual(hits({paths:['src/auth'],modules:[]})[0].paths,['src/auth']);
  assert.equal(hits({paths:['src/auth/login.ts'],modules:[]}).length,1);
  assert.deepEqual(hits({paths:[],modules:['authentication']})[0].modules,['authentication']);
  assert.equal(hits({paths:['src/author'],modules:['authorization']}).length,0);
 };
 const restored=createIntentionStore(file,f.host.store);
 const snapshot=await restored.handle(null,{version:1,projectId:f.host.projectId,action:'intent-sync',since:0});
 assertCanonical(snapshot.records[0]);assert.equal(snapshot.revision,data.scopes[0].revision);
 assert.equal(await fs.readFile(file,'utf8'),persisted);
 const c=await clientFixture(f),envelope=JSON.parse(await fs.readFile(c.file,'utf8'));
 const cache=JSON.parse(f.peer.protection.open(envelope.sealed));
 cache.bindings[0].records[0].paths=['SRC/AUTH'];cache.bindings[0].records[0].modules=['Authentication'];
 envelope.sealed=f.peer.protection.seal(JSON.stringify(cache));const protectedBytes=JSON.stringify(envelope);await fs.writeFile(c.file,protectedBytes);
 const view=await c.make().local(f.peer.projectId,'view',{id:c.binding.id});assertCanonical(view.records[0]);
 assert.equal(await fs.readFile(c.file,'utf8'),protectedBytes);
});

test('invalid persisted paths and modules still fail closed without repairing the registry',async t=>{
 const f=await ready(t);await f.local({action:'intent-mutate',operation:operation()});
 const file=path.join(f.root,'host-intentions.json'),original=JSON.parse(await fs.readFile(file,'utf8'));
 for(const invalid of [{paths:['../private']},{modules:['auth/private']}]){
  const data=structuredClone(original);Object.assign(data.scopes[0].records[0],invalid);
  const bytes=JSON.stringify(data);await fs.writeFile(file,bytes);
  await assert.rejects(createIntentionStore(file,f.host.store).handle(null,{version:1,projectId:f.host.projectId,action:'intent-sync',since:0}),/corrupt|unsupported/);
  assert.equal(await fs.readFile(file,'utf8'),bytes);
 }
});
