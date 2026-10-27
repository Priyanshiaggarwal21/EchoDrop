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
    const item = { file, projectId, otherId, store, projects, protection, transport: createRemoteTransport(store, createSecureContentStore(path.join(root, name + '-content'), store).handle), fingerprint: readCertificate(credentials[name].certificate).fingerprint };
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


async function ready(t, role = 'member') {
  const f = await fixture(t); const invitation = await f.offer(undefined, role); await f.query('accept', invitation);
  const info = await f.peer.transport.query(f.host.fingerprint, '127.0.0.1', f.port, {version:1, action:'content-info', projectId:f.host.projectId});
  f.send = command => f.peer.transport.query(f.host.fingerprint, '127.0.0.1', f.port, {version:1, projectId:f.host.projectId, ...command});
  f.bytes = Buffer.alloc(1024 * 1024 + 17, 42);
  f.meta = {id:randomUUID(),name:'shared.txt',size:f.bytes.length,sha256:createHash('sha256').update(f.bytes).digest('hex'),recipientId:info.recipients[0].id};
  return f;
}
async function upload(f) {
  await f.send({action:'content-create',...f.meta});
  for(let index=0;index<2;index++) await f.send({action:'content-chunk',id:f.meta.id,index,data:f.bytes.subarray(index*1048576,(index+1)*1048576).toString('base64')});
  return f.send({action:'content-complete',id:f.meta.id});
}
test('TLS shared content resumes across restart, verifies integrity and saves without overwrite', async t => {
  const f=await ready(t);
  await f.send({action:'content-create',...f.meta});
  const chunk={action:'content-chunk',id:f.meta.id,index:0,data:f.bytes.subarray(0,1048576).toString('base64')};
  await f.send(chunk); await f.send(chunk);
  const restored=createSecureContentStore(path.join(f.root,'host-content'),f.host.store);
  assert.equal((await restored.handle(f.peer.fingerprint,{version:1,projectId:f.host.projectId,action:'content-status',id:f.meta.id})).retainedBytes,1048576);
  assert.equal((await upload(f)).state,'completed');
  const cache=createContentReceiver(path.join(f.root,'cache')), target={mode:'remote',fingerprint:f.host.fingerprint}, request={id:f.meta.id};
  await cache.start(target,request,f.send);
  await cache.chunk(target,{...request,index:0},f.send); await cache.chunk(target,{...request,index:1},f.send);
  const first=await cache.finish(target,request,f.send,async()=>f.root);
  const second=await cache.finish(target,request,f.send,async()=>f.root);
  assert.equal(first.folderName,second.folderName);
  assert.equal(second.alreadyApplied,true);
  assert.deepEqual(await fs.readFile(path.join(f.root,first.folderName,f.meta.name)),f.bytes);
});
test('guest uploads, cross-project IDs, unaccepted contexts and actor injection are denied',async t=>{
  const f=await ready(t,'guest');
  await assert.rejects(f.send({action:'content-create',...f.meta}));
  await assert.rejects(f.send({action:'content-list',projectId:f.host.otherId}));
  await assert.rejects(f.send({action:'content-list',contextId:randomUUID()}));
  await assert.rejects(f.send({action:'content-info',actorId:f.recipientId}));
});
test('withdrawal survives restart, blocks replay and rechecks after destination dialog',async t=>{
  const f=await ready(t); await upload(f);
  const cache=createContentReceiver(path.join(f.root,'cache')),target={mode:'local'},request={id:f.meta.id};
  await cache.chunk(target,{...request,index:0},f.send);await cache.chunk(target,{...request,index:1},f.send);
  await assert.rejects(cache.finish(target,request,f.send,async()=>{await f.send({action:'content-cancel',id:f.meta.id});return f.root;}),/no longer/);
  const restored=createSecureContentStore(path.join(f.root,'host-content'),f.host.store);
  assert.equal((await restored.handle(f.peer.fingerprint,{version:1,projectId:f.host.projectId,action:'content-status',...request})).state,'cancelled');
  await assert.rejects(f.send({action:'content-create',...f.meta}));
  await assert.rejects(f.send({action:'content-read',...request,index:0}));
});
test('bad full digest cannot publish; corrupt history fails closed without replacement',async t=>{
  const f=await ready(t); f.meta.sha256='0'.repeat(64);
  await assert.rejects(upload(f)); await assert.rejects(f.send({action:'content-read',id:f.meta.id,index:0}));
  const index=path.join(f.root,'host-content','index.json');await fs.writeFile(index,'broken');
  await assert.rejects(f.send({action:'content-list'})); assert.equal(await fs.readFile(index,'utf8'),'broken');
});
test('membership revocation immediately blocks retained content and unsafe names are rejected',async t=>{
  const f=await ready(t);
  for(const name of ['../escape','CON','file:stream','trailing.']) await assert.rejects(f.send({action:'content-create',...f.meta,name}));
  await upload(f);await f.host.store.execute(f.host.projectId,{action:'change-project-member',principalId:f.recipientId,remove:true});
  await assert.rejects(f.send({action:'content-list'}));await assert.rejects(f.send({action:'content-read',id:f.meta.id,index:0}));
});
test('accepted context content stays separate from project-level content',async t=>{
  const f=await ready(t);
  const context=(await f.host.store.execute(f.host.projectId,{action:'create-context',name:'Private handoff',purpose:''})).contexts[0];
  await assert.rejects(f.send({action:'content-list',contextId:context.id}));
  await f.query('accept',await f.offer(context.id));
  const original=f.send; f.send=command=>original({...command,contextId:context.id});
  await upload(f);
  assert.equal((await f.send({action:'content-list'})).length,1);
  assert.deepEqual(await original({action:'content-list'}),[]);
  await assert.rejects(original({action:'content-read',id:f.meta.id,index:0}));
});
test('another accepted project member cannot list or read an addressed file',async t=>{
  const f=await ready(t);await upload(f);
  const principalId=await f.trust(f.host,f.attacker);
  const snapshot=await f.host.store.execute(f.host.projectId,{action:'prepare-invitation-draft',recipientId:principalId,role:'member',expiresAt:null});
  const id=snapshot.invitationDrafts.at(-1).id;await f.host.store.remoteLocal(f.host.projectId,'offer',{invitationId:id});
  await f.host.transport.stop();const {port}=await f.host.transport.start();
  const ask=command=>f.attacker.transport.query(f.host.fingerprint,'127.0.0.1',port,{version:1,...command});
  await ask({action:'accept',invitationId:id});
  assert.deepEqual(await ask({action:'content-list',projectId:f.host.projectId}),[]);
  await assert.rejects(ask({action:'content-read',projectId:f.host.projectId,id:f.meta.id,index:0}));
});
test('secure-content IPC rejects untrusted renderers before storage or native dialogs',async()=>{
  const {installSecureContent}=await import('./secure-content-ipc.cjs');let handler;
  installSecureContent({ipcMain:{handle(_name,callback){handler=callback;}},trusted(){throw Error('untrusted');},getStore(){assert.fail('storage accessed');},dialog:{showOpenDialog(){assert.fail('dialog opened');}}});
  await assert.rejects(handler({},randomUUID(),'receive-finish',{}),/untrusted/);
});
test('recipient acknowledgements require the bound participant and apply retry after lost reply creates no duplicate',async t=>{
  const f=await ready(t);await upload(f);
  await assert.rejects(f.send({action:'content-receipt',id:f.meta.id,delivery:'Applied',sha256:f.meta.sha256}));
  const hostStore=createSecureContentStore(path.join(f.root,'host-content'),f.host.store);
  const hostCall=command=>hostStore.handle(null,{version:1,projectId:f.host.projectId,...command});
  const target={mode:'local'},request={id:f.meta.id},cachePath=path.join(f.root,'recipient-cache');
  const cache=createContentReceiver(cachePath);
  await cache.chunk(target,{...request,index:0},hostCall);await cache.chunk(target,{...request,index:1},hostCall);
  const lostReply=async command=>{const result=await hostCall(command);if(command.delivery==='Applied')throw Error('reply lost');return result;};
  await assert.rejects(cache.finish(target,request,lostReply,async()=>f.root),/reply lost/);
  const retry=await createContentReceiver(cachePath).finish(target,request,hostCall,async()=>assert.fail('must reuse original apply'));
  assert.equal(retry.alreadyApplied,true);
  assert.equal((await f.send({action:'content-status',id:f.meta.id})).delivery,'Applied');
  assert.equal((await fs.readdir(f.root)).filter(name=>name.startsWith('EchoDrop-')).length,1);
  await f.send({action:'content-cancel',id:f.meta.id});
  await assert.rejects(createContentReceiver(cachePath).finish(target,request,hostCall,async()=>f.root));
});
test('real TLS queue restarts after a chunk and revalidates membership before resuming',async t=>{
  const {createDeliveryQueue}=await import('./delivery-queue.mjs');
  const f=await ready(t);const seals=new Map();
  const protection={seal(value){const token=randomUUID();seals.set(token,value);return token;},open(token){if(!seals.has(token))throw Error('invalid binding');return seals.get(token);}};
  const target={mode:'remote',projectId:f.host.projectId,fingerprint:f.host.fingerprint,host:'127.0.0.1',port:f.port};
  const config={protection,authorize:id=>f.peer.store.snapshot(id),execute:(_id,_target,command)=>f.send(command)};
  const directory=path.join(f.root,'tls-queue'),queue=createDeliveryQueue(directory,config);
  await queue.create(f.peer.projectId,target,{...f.meta,projectId:f.host.projectId});
  await queue.stage(f.peer.projectId,f.meta.id,0,f.bytes.subarray(0,1048576));await queue.stage(f.peer.projectId,f.meta.id,1,f.bytes.subarray(1048576));
  await queue.control(f.peer.projectId,f.meta.id,'commit');await queue.tick();
  assert.equal((await queue.list(f.peer.projectId))[0].retained,1048576);
  await f.host.store.execute(f.host.projectId,{action:'change-project-member',principalId:f.recipientId,remove:true});
  const restarted=createDeliveryQueue(directory,config);await restarted.tick();
  assert.equal((await restarted.list(f.peer.projectId))[0].state,'Failed');
});

test('TLS archival requires terminal delivery and keeps tombstone across restart',async t=>{
 const f=await ready(t);await upload(f);await assert.rejects(f.send({action:'content-archive',id:f.meta.id}));await f.send({action:'content-cancel',id:f.meta.id});const archived=await f.send({action:'content-archive',id:f.meta.id});assert.equal(archived.state,'cancelled');assert(archived.archivedAt);await assert.rejects(f.send({action:'content-read',id:f.meta.id,index:0}),/no longer available|unavailable|denied/);const restored=createSecureContentStore(path.join(f.root,'host-content'),f.host.store);const status=await restored.handle(f.peer.fingerprint,{version:1,projectId:f.host.projectId,action:'content-status',id:f.meta.id});assert.equal(status.archivedAt,archived.archivedAt);await assert.rejects(f.send({action:'content-create',...f.meta}));await assert.rejects(f.send({action:'content-archive',id:f.meta.id,projectId:f.host.otherId}));
});
test('receive cache cleanup verifies saved copy and never deletes destination',async t=>{
 const f=await ready(t);await upload(f);const cache=createContentReceiver(path.join(f.root,'cache')),target={mode:'local'},request={id:f.meta.id};await assert.rejects(cache.cleanup(target,request,f.send));await cache.chunk(target,{...request,index:0},f.send);await cache.chunk(target,{...request,index:1},f.send);const saved=await cache.finish(target,request,f.send,async()=>f.root);const result=await cache.cleanup(target,request,f.send);assert.equal(result.cleaned,true);assert.deepEqual(await fs.readFile(path.join(f.root,saved.folderName,f.meta.name)),f.bytes);await assert.rejects(fs.stat(path.join(f.root,'cache','local',f.meta.id+'.bin')),{code:'ENOENT'});assert.equal((await cache.cleanup(target,request,f.send)).cleaned,true);
});

test('archival preserves authenticated Applied receipt and cannot revoke saved bytes',async t=>{const f=await ready(t);await upload(f);const hostStore=createSecureContentStore(path.join(f.root,'host-content'),f.host.store);await hostStore.handle(null,{version:1,projectId:f.host.projectId,action:'content-receipt',id:f.meta.id,sha256:f.meta.sha256,delivery:'Applied'});const archived=await f.send({action:'content-archive',id:f.meta.id});assert.equal(archived.delivery,'Applied');assert.equal(archived.state,'cancelled');await assert.rejects(f.send({action:'content-read',id:f.meta.id,index:0}));assert.equal((await f.send({action:'content-status',id:f.meta.id})).delivery,'Applied');});
