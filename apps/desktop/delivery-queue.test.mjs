import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { createDeliveryQueue, retryDelay } from './delivery-queue.mjs';
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'echodrop-queue-'));t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('echodrop-queue-'));await fs.rm(root,{recursive:true,force:true});});
 const secrets=new Map();const protection={seal(value){const key=randomUUID();secrets.set(key,value);return key;},open(key){if(!secrets.has(key))throw Error('protected binding invalid');return secrets.get(key);}};
 const projectId=randomUUID(),recipientId=randomUUID(),id=randomUUID(),bytes=Buffer.from('sensitive queued payload');const target={mode:'local',projectId};
 const meta={id,projectId,recipientId,name:'private.txt',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 let time=0,deny=false,offline=false,delivery='Uploaded',status={state:'uploading',retainedBytes:0,nextIndex:0},chunks=0;
 const execute=async(_project,target,command)=>{if(deny)throw Error('authorization revoked');if(offline)throw Error('Secure connection timed out.');assert.equal(target.projectId,projectId);if(command.action==='content-info')return{role:'member',recipients:[{id:recipientId}]};if(command.action==='content-cancel'){status.state='cancelled';return status;}if(command.action==='content-create'||command.action==='content-status')return{...status,delivery};if(command.action==='content-chunk'){assert.equal(command.id,id);assert.deepEqual(Buffer.from(command.data,'base64'),bytes);chunks++;status={state:'uploading',retainedBytes:bytes.length,nextIndex:1};return status;}if(command.action==='content-complete'){status.state='completed';return{...status,delivery};}assert.fail(command.action);};
 const config={protection,authorize:async scope=>{if(scope!==projectId)throw Error('project denied');},execute,now:()=>time};
 const create=()=>createDeliveryQueue(root,config);let queue=create();
 const stage=async()=>{await queue.create(projectId,target,meta);await queue.stage(projectId,id,0,bytes);await queue.control(projectId,id,'commit');};
 return{root,projectId,id,target,meta,bytes,queue,create,stage,setOffline:value=>offline=value,revoke:()=>deny=true,advance:()=>time+=400000,setDelivery:value=>delivery=value,chunks:()=>chunks,setArchived:()=>{status.state='cancelled';delivery='Applied';}};
}
test('protected queue restarts, resumes stable IDs, and only advances on recipient acknowledgements',async t=>{
 const f=await fixture(t);await f.stage();await f.queue.tick();assert.equal(f.chunks(),1);
 const queue=f.create();await queue.tick();assert.equal((await queue.list(f.projectId))[0].state,'Uploaded');assert.equal(f.chunks(),1);
 f.setDelivery('Delivered');f.advance();await queue.tick();assert.equal((await queue.list(f.projectId))[0].state,'Delivered');
 f.setDelivery('Applied');f.advance();await queue.tick();assert.equal((await queue.list(f.projectId))[0].state,'Applied');await queue.tick();assert.equal(f.chunks(),1);
 assert(!(await fs.readFile(path.join(f.root,'queue.json'),'utf8')).includes('private.txt'));
 assert(!(await fs.readdir(f.root)).some(name=>name.endsWith('.sealed')));
});
test('offline retries back off, stop at budget, and explicit resume recovers',async t=>{
 const f=await fixture(t);await f.stage();f.setOffline(true);await f.queue.tick();let job=(await f.queue.list(f.projectId))[0];assert.equal(job.state,'Queued');assert.equal(job.nextAt,4000);assert.match(job.error,/Waiting for host/);
 assert.equal(retryDelay(50),300000);
 for(let i=0;i<7;i++){f.advance();await f.queue.tick();}assert.equal((await f.queue.list(f.projectId))[0].state,'Failed');
 f.setOffline(false);await f.queue.control(f.projectId,f.id,'resume');await f.queue.tick();assert.equal(f.chunks(),1);
});
test('pause survives restart and cancellation never sends retained payload',async t=>{
 const f=await fixture(t);await f.stage();await f.queue.control(f.projectId,f.id,'pause');await f.create().tick();assert.equal(f.chunks(),0);
 await f.queue.control(f.projectId,f.id,'cancel');await f.create().tick();assert.equal(f.chunks(),0);assert.equal((await f.queue.list(f.projectId))[0].state,'Cancelled');
 await assert.rejects(f.queue.control(f.projectId,f.id,'resume'),/terminal/);
});
test('revoked access stops sending rather than retrying authorization failures',async t=>{
 const f=await fixture(t);await f.stage();f.revoke();await f.queue.tick();const job=(await f.queue.list(f.projectId))[0];assert.equal(job.state,'Failed');assert.equal(job.paused,true);assert.equal(f.chunks(),0);
});
test('project isolation, immutable recipient binding and incomplete staging fail safely',async t=>{
 const f=await fixture(t);await f.queue.create(f.projectId,f.target,f.meta);
 await assert.rejects(f.queue.control(randomUUID(),f.id,'cancel'),/denied/);
 await assert.rejects(f.queue.create(f.projectId,f.target,{...f.meta,recipientId:randomUUID()}),/bound/);
 await assert.rejects(f.queue.control(f.projectId,f.id,'commit'));
 await f.create().tick();assert.equal(f.chunks(),0);
});
test('missing or corrupt protected payload fails without publication; corrupt index is preserved',async t=>{
 const f=await fixture(t);await f.stage();const chunk=path.join(f.root,`${f.id}.0.sealed`);await fs.writeFile(chunk,'broken');await f.queue.tick();assert.equal((await f.queue.list(f.projectId))[0].state,'Failed');assert.equal(f.chunks(),0);
 await fs.writeFile(path.join(f.root,'queue.json'),'broken');await assert.rejects(f.create().tick(),/preserved/);assert.equal(await fs.readFile(path.join(f.root,'queue.json'),'utf8'),'broken');
});
test('staging full-file integrity is mandatory before worker eligibility',async t=>{
 const f=await fixture(t);await f.queue.create(f.projectId,f.target,{...f.meta,sha256:'0'.repeat(64)});await f.queue.stage(f.projectId,f.id,0,f.bytes);await assert.rejects(f.queue.control(f.projectId,f.id,'commit'),/integrity/);await f.queue.tick();assert.equal(f.chunks(),0);
});
test('missing staged file is actionable after restart, and mismatched context cannot rebind a job',async t=>{
 const f=await fixture(t);await f.stage();await fs.unlink(path.join(f.root,`${f.id}.0.sealed`));await f.create().tick();
 assert.match((await f.queue.list(f.projectId))[0].error,/payload is missing/);assert.equal(f.chunks(),0);
 await assert.rejects(f.queue.create(f.projectId,{...f.target,contextId:randomUUID()},f.meta),/scope mismatch/);
});

test('retention preserves paused and revoked jobs; terminal archival survives restart',async t=>{
 const f=await fixture(t);await f.stage();await f.queue.retention(f.projectId,1);for(let i=0;i<300;i++)f.advance();await f.queue.control(f.projectId,f.id,'pause');assert.equal((await f.queue.cleanup(f.projectId)).archived,0);await assert.rejects(f.queue.control(f.projectId,f.id,'archive'),/terminal/);await f.queue.control(f.projectId,f.id,'resume');f.revoke();await f.queue.tick();assert.equal((await f.queue.cleanup(f.projectId)).archived,0);assert.equal((await f.create().list(f.projectId))[0].state,'Failed');
});
test('pending withdrawal cannot archive; confirmed withdrawal ages out with history intact',async t=>{
 const f=await fixture(t);await f.stage();await f.queue.control(f.projectId,f.id,'cancel');await assert.rejects(f.queue.control(f.projectId,f.id,'archive'),/terminal/);await f.queue.tick();await f.queue.retention(f.projectId,1);for(let i=0;i<300;i++)f.advance();assert.equal((await f.queue.cleanup(f.projectId)).archived,1);assert.equal((await f.create().list(f.projectId))[0].state,'Cancelled');assert.notEqual((await f.create().list(f.projectId))[0].archivedAt,null);assert.equal((await f.queue.cleanup(f.projectId)).archived,0);assert.equal((await f.create().retention(f.projectId)).days,1);await assert.rejects(f.queue.retention(f.projectId,0),/retention/);
});

test('sender recognizes saved acknowledgement after host archival and restart',async t=>{const f=await fixture(t);await f.stage();await f.queue.tick();await f.queue.tick();assert.equal((await f.queue.list(f.projectId))[0].state,'Uploaded');f.setArchived();f.advance();const queue=f.create();await queue.tick();assert.equal((await queue.list(f.projectId))[0].state,'Applied');await queue.control(f.projectId,f.id,'archive');assert.equal((await f.create().list(f.projectId))[0].state,'Applied');});
