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
import { createTestCredentials } from './test-credentials.mjs';

const credentials = {};
for (const name of ['host', 'peer', 'attacker']) credentials[name] = await createTestCredentials(`EchoDrop TEST ONLY ${name}`);
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
    const item = { file, projectId, otherId, store, projects, protection, transport: createRemoteTransport(store, createSecureContentStore(path.join(root, name + '-content'), store).handle, createIntentionStore(path.join(root,name+'-intentions.json'),store).handle, createContractStore(path.join(root,name+'-contracts.json'),store).handle), fingerprint: readCertificate(credentials[name].certificate).fingerprint };
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




const document=()=>({"openapi": "3.0.3", "info": {"title": "Users API", "version": "1.0.0"}, "paths": {"/users": {"post": {"parameters": [{"name": "X-Trace", "in": "header", "required": true, "schema": {"type": "string"}}], "requestBody": {"required": true, "content": {"application/json": {"schema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"], "additionalProperties": false}}}}, "responses": {"200": {"description": "User", "content": {"application/json": {"schema": {"type": "object", "properties": {"id": {"type": "integer"}, "name": {"type": "string"}}, "required": ["id", "name"], "additionalProperties": false}}}, "headers": {"X-Revision": {"required": true, "schema": {"type": "integer"}}}}}}}}});
const operation=(kind='create',recordId=randomUUID(),baseVersion=0,side='expected')=>({id:randomUUID(),recordId,kind,baseVersion,...(['create','revise'].includes(kind)?{fields:{side,document:document()}}:{text:'Reviewed integration'})});
async function ready(t,role='member'){
 const f=await fixture(t);await f.query('accept',await f.offer(undefined,role));
 f.ask=command=>f.peer.transport.query(f.host.fingerprint,'127.0.0.1',f.port,{version:1,projectId:f.host.projectId,...command});
 f.local=command=>createContractStore(path.join(f.root,'host-contracts.json'),f.host.store).handle(null,{version:1,projectId:f.host.projectId,...command});return f;
}
test('comparison detects removed endpoints, types, required fields, bodies, statuses and headers',()=>{
 const expected=document(),actual=document();actual.paths['/users'].post.requestBody.content['application/json'].schema.properties.name.type='integer';
 actual.paths['/users'].post.requestBody.content['application/json'].schema.properties.age={type:'integer'};actual.paths['/users'].post.requestBody.content['application/json'].schema.required.push('age');
 delete actual.paths['/users'].post.responses['200'].content['application/json'].schema.properties.name;actual.paths['/users'].post.responses['200'].content['application/json'].schema.required=['id'];
 actual.paths['/users'].post.responses['200'].headers['X-Revision'].required=false;actual.paths['/users'].post.responses['422']={description:'New error'};
 const report=compareContracts(expected,actual);assert.equal(report.status,'incompatible');assert(report.issues.some(i=>i.field==='request.name'));assert(report.issues.some(i=>i.field==='request.age'));assert(report.issues.some(i=>i.field==='response 200.name'));assert(report.issues.some(i=>i.field.includes('x-revision')));assert(report.issues.some(i=>i.field==='response 422'));assert(report.issues.every(i=>i.guidance&&i.endpoint));
 const removed=document();removed.paths={'/other':removed.paths['/users']};assert(compareContracts(expected,removed).issues.some(i=>i.field==='endpoint'&&i.severity==='breaking'));
});
test('comparison handles request contravariance, response covariance and non-breaking optional changes',()=>{
 const expected=document(),actual=document();expected.paths['/users'].post.responses['200'].content['application/json'].schema.properties.id.type='number';
 actual.paths['/users'].post.requestBody.required=false;actual.paths['/users'].post.requestBody.content['application/json'].schema.required=[];actual.paths['/users'].post.parameters[0].name='x-trace';
 assert.equal(compareContracts(expected,actual).status,'compatible-within-supported-subset');
 actual.paths['/users'].post.responses['200'].content['application/json'].schema.properties.id.type='string';assert.equal(compareContracts(expected,actual).status,'incompatible');
});
test('comparison reports removed required request parameters and optionalized response fields',()=>{
 const expected=document(),actual=document();
 expected.paths['/users'].post.parameters.push({name:'tenant',in:'query',required:true,schema:{type:'string'}});
 delete actual.paths['/users'].post.parameters[0];
 actual.paths['/users'].post.parameters=[{name:'X-Trace',in:'header',required:true,schema:{type:'string'}}];
 let report=compareContracts(expected,actual);
 assert.equal(report.status,'incompatible');
 assert(report.issues.some(issue=>issue.field.includes('tenant')&&issue.severity==='breaking'));
 actual.paths['/users'].post.parameters.push({name:'tenant',in:'query',required:true,schema:{type:'string'}});
 actual.paths['/users'].post.responses['200'].content['application/json'].schema.required=['id'];
 report=compareContracts(expected,actual);
 assert.equal(report.status,'incompatible');
 assert(report.issues.some(issue=>issue.field==='response 200.name'&&issue.severity==='breaking'));
});
test('malformed and unsupported schemas are rejected without fetching references or executing code',()=>{
 for(const mutate of [d=>d.paths['/users'].post.requestBody.content['application/json'].schema={$ref:'http://private/secret'},d=>d.paths['/users'].post.responses['200'].content['application/json'].schema.required=['missing'],d=>d.paths['/users'].post.parameters[0].schema={type:'string',pattern:'(a+)+$'},d=>d.openapi='3.1.0',d=>d.paths['/users'].post.responses['6XX']={description:'invalid range'}]){const value=document();mutate(value);assert.throws(()=>validateContractDocument(value));}
 const enumDoc=document();enumDoc.paths['/users'].post.parameters[0].schema={type:'integer',enum:['wrong']};assert.throws(()=>validateContractDocument(enumDoc));
});
test('real TLS publication, incremental exchange and approval are version-bound and durable',async t=>{
 const f=await ready(t),create=operation();const initial=await f.ask({action:'contract-sync',since:0});await f.local({action:'contract-mutate',operation:create});
 const delta=await f.ask({action:'contract-sync',since:initial.revision,epoch:initial.epoch});assert.equal(delta.records.length,1);
 await assert.rejects(f.local({action:'contract-mutate',operation:operation('approve',create.recordId,1)}));
 await f.ask({action:'contract-mutate',operation:operation('approve',create.recordId,1)});let state=await f.local({action:'contract-sync',since:0});assert.equal(state.records[0].status,'approved');
 const revise=operation('revise',create.recordId,2);revise.fields.document.info.version='2.0.0';await f.local({action:'contract-mutate',operation:revise});
 state=await f.ask({action:'contract-sync',since:0});assert.equal(state.records[0].status,'published');assert.equal(state.records[0].history.length,2);assert.equal(state.records[0].history[0].fields.document.info.version,'1.0.0');assert.equal(state.records[0].reviews[0].contentVersion,1);
 assert.equal((await f.local({action:'contract-sync',since:state.revision,epoch:state.epoch})).records.length,0);
});
test('simultaneous edits conflict, operation replay is idempotent and same version cannot be overwritten',async t=>{
 const f=await ready(t),create=operation();await f.ask({action:'contract-mutate',operation:create});
 const one=operation('revise',create.recordId,1),two=operation('revise',create.recordId,1);one.fields.document.info.version='2';two.fields.document.info.version='3';
 const replies=await Promise.all([f.ask({action:'contract-mutate',operation:one}),f.ask({action:'contract-mutate',operation:two})]);assert.equal(replies.filter(r=>r.accepted).length,1);assert.equal(replies.filter(r=>r.conflict).length,1);
 assert.equal((await f.ask({action:'contract-mutate',operation:create})).accepted,true);await assert.rejects(f.ask({action:'contract-mutate',operation:{...create,fields:{...create.fields,side:'implemented'}}}));
 const record=(await f.ask({action:'contract-sync',since:0})).records[0],same=operation('revise',create.recordId,record.version);same.fields.document=record.fields.document;await assert.rejects(f.ask({action:'contract-mutate',operation:same}));assert.equal(record.history.length,2);
});
test('permissions isolate projects/contexts; guests cannot publish and revoked approvals retire',async t=>{
 const f=await ready(t),create=operation();await f.local({action:'contract-mutate',operation:create});await f.ask({action:'contract-mutate',operation:operation('approve',create.recordId,1)});
 await assert.rejects(f.ask({action:'contract-sync',since:0,projectId:f.host.otherId}));await assert.rejects(f.ask({action:'contract-sync',since:0,contextId:randomUUID()}));await assert.rejects(f.ask({action:'contract-mutate',operation:operation('revise',create.recordId,2)}));
 await f.host.store.execute(f.host.projectId,{action:'change-project-member',principalId:f.recipientId,role:'guest'});const state=await f.local({action:'contract-sync',since:0});assert.equal(state.records[0].status,'published');assert.equal(state.records[0].reviews[0].active,false);await assert.rejects(f.ask({action:'contract-mutate',operation:operation()}));
 await f.host.store.execute(f.host.projectId,{action:'change-project-member',principalId:f.recipientId,remove:true});await assert.rejects(f.ask({action:'contract-sync',since:0}));
});
async function clientFixture(f){let time=Date.now(),offline=false,lost=false;const target={mode:'remote',projectId:f.host.projectId,fingerprint:f.host.fingerprint,host:'127.0.0.1',port:f.port};const config={model:contractClientModel,protection:f.peer.protection,authorize:id=>f.peer.store.snapshot(id),now:()=>time,execute:async(_id,_target,command)=>{if(offline)throw Error('Secure connection timed out.');const reply=await f.ask(command);if(lost&&command.action==='contract-mutate'){lost=false;throw Error('Secure connection closed before a verified reply.');}return reply;}};const file=path.join(f.root,'contract-cache.json'),make=()=>createIntentionClient(file,config),client=make();const binding=await client.local(f.peer.projectId,'attach',{target});await client.tick();return{file,make,client,binding,advance:()=>time+=400000,offline:value=>offline=value,lose:()=>lost=true};}
test('protected offline edits survive restart and reconcile lost TLS acknowledgements once',async t=>{
 const f=await ready(t),c=await clientFixture(f);c.offline(true);await c.client.local(f.peer.projectId,'submit',{id:c.binding.id,operation:operation()});await c.client.tick();assert(!(await fs.readFile(c.file,'utf8')).includes('Users API'));
 const restored=c.make();c.offline(false);c.lose();c.advance();await restored.tick();c.advance();await restored.tick();const view=await restored.local(f.peer.projectId,'view',{id:c.binding.id});assert.equal(view.pending.length,0);assert.equal(view.records.length,1);assert.equal(view.records[0].history.length,1);
});
test('reconnect retains conflicting contract edits for explicit reviewed rebase',async t=>{
 const f=await ready(t),create=operation();await f.ask({action:'contract-mutate',operation:create});const c=await clientFixture(f);
 const draft=operation('revise',create.recordId,1);draft.fields.document.info.version='3';await c.client.local(f.peer.projectId,'submit',{id:c.binding.id,operation:draft});const other=operation('revise',create.recordId,1);other.fields.document.info.version='2';await f.ask({action:'contract-mutate',operation:other});await c.client.tick();
 let view=await c.client.local(f.peer.projectId,'view',{id:c.binding.id});assert.equal(view.pending[0].state,'conflict');await c.client.local(f.peer.projectId,'rebase',{id:c.binding.id,operationId:view.pending[0].operation.id,version:2});await c.client.tick();view=await c.client.local(f.peer.projectId,'view',{id:c.binding.id});assert.equal(view.records[0].history.length,3);assert.equal(view.records[0].fields.document.info.version,'3');
});
test('malformed persisted history fails closed without rewriting original records',async t=>{
 const f=await ready(t);await f.local({action:'contract-mutate',operation:operation()});const file=path.join(f.root,'host-contracts.json'),data=JSON.parse(await fs.readFile(file,'utf8'));data.scopes[0].records[0].history=[];const bytes=JSON.stringify(data);await fs.writeFile(file,bytes);await assert.rejects(f.local({action:'contract-sync',since:0}),/preserved/);assert.equal(await fs.readFile(file,'utf8'),bytes);
});
test('enum/range compatibility avoids false breaking reports and rejects contradictory enum bounds',()=>{
 const expected=document(),actual=document();expected.paths['/users'].post.parameters[0].schema={type:'integer',enum:[5,6]};actual.paths['/users'].post.parameters[0].schema={type:'integer',minimum:0,maximum:10};assert.equal(compareContracts(expected,actual).status,'compatible-within-supported-subset');
 expected.paths['/users'].post.parameters[0].schema={type:'integer',nullable:true,enum:[5]};assert.equal(compareContracts(expected,actual).status,'compatible-within-supported-subset');
 expected.paths['/users'].post.parameters[0].schema={type:'integer',enum:[-1],minimum:0};assert.throws(()=>validateContractDocument(expected),/bounds/);
});
test('authorized context contracts remain separate and intention links require the exact scope',async t=>{
 const f=await ready(t),context=(await f.host.store.execute(f.host.projectId,{action:'create-context',name:'API work',purpose:''})).contexts[0];await f.query('accept',await f.offer(context.id));
 const intentStore=createIntentionStore(path.join(f.root,'host-intentions.json'),f.host.store),intentionId=randomUUID();
 await intentStore.handle(null,{version:1,projectId:f.host.projectId,contextId:context.id,action:'intent-mutate',operation:{id:randomUUID(),recordId:intentionId,kind:'create',baseVersion:0,fields:{description:'API scope',paths:['src/api'],modules:[],hours:24}}});
 const contracts=createContractStore(path.join(f.root,'host-contracts.json'),f.host.store,{validateLink:async(fp,projectId,contextId,id)=>{const state=await intentStore.handle(fp,{version:1,projectId,...(contextId?{contextId}:{}),action:'intent-sync',since:0});if(!state.records.some(r=>r.id===id))throw Error('Link scope denied');}});
 const op=operation();op.fields.intentionId=intentionId;
 await assert.rejects(contracts.handle(null,{version:1,projectId:f.host.projectId,action:'contract-mutate',operation:op}),/scope/);
 await contracts.handle(null,{version:1,projectId:f.host.projectId,contextId:context.id,action:'contract-mutate',operation:op});
 assert.equal((await f.ask({action:'contract-sync',contextId:context.id,since:0})).records[0].fields.intentionId,intentionId);assert.deepEqual((await f.ask({action:'contract-sync',since:0})).records,[]);
});
test('offline client hides contracts and retains pending edits after revocation',async t=>{
 const f=await ready(t),create=operation();await f.ask({action:'contract-mutate',operation:create});const c=await clientFixture(f),edit=operation('revise',create.recordId,1);edit.fields.document.info.version='2';await c.client.local(f.peer.projectId,'submit',{id:c.binding.id,operation:edit});
 await f.host.store.execute(f.host.projectId,{action:'change-project-member',principalId:f.recipientId,remove:true});await c.client.tick();const state=await c.client.local(f.peer.projectId,'view',{id:c.binding.id});assert.equal(state.blocked,true);assert.deepEqual(state.records,[]);assert.equal(state.pending.length,1);
});

test('advanced reference contracts preserve TLS publication, replay and independent approval',async t=>{const f=await ready(t),create=operation();const d=create.fields.document;d.components={schemas:{Name:{type:'string'}},securitySchemes:{Token:{type:'http',scheme:'bearer'}}};d.security=[{Token:[]}];d.paths['/users'].post.requestBody.content['application/json'].schema.properties.name={$ref:'#/components/schemas/Name'};d.paths['/users'].post.responses.default={description:'Other status'};await f.local({action:'contract-mutate',operation:create});assert.equal((await f.local({action:'contract-mutate',operation:create})).accepted,true);await f.ask({action:'contract-mutate',operation:operation('approve',create.recordId,1)});const state=await f.ask({action:'contract-sync',since:0});assert.equal(state.records[0].status,'approved');assert.equal(state.records[0].fields.document.paths['/users'].post.requestBody.content['application/json'].schema.properties.name.type,'string');assert.equal(state.records[0].contentVersion,1);assert.deepEqual(state.records[0].fields.document.security,[{Token:[]}]);});
