import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
const bundle = await build({entryPoints:[new URL('./project-transfer-flow.mjs',import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1')].map(decodeURIComponent),bundle:true,write:false,format:'esm',platform:'browser',plugins:[{name:'existing-transfer-hash-export',setup(build){build.onLoad({filter:/browser-sha256\.js$/},async args=>({contents:await readFile(args.path,'utf8')+'\nexport { sha256File };',loader:'js'}));}}]});
const { uploadContent, receiveContent, percentage, canResume, queueContent, queueContentMany } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

test('UI keeps acknowledged bytes below 100 percent until verification succeeds', () => {
  assert.equal(percentage(100,100),99);
  assert.equal(percentage(0,0,true),100);
  assert.equal(canResume({state:'uploading',senderId:'sender'},'sender','guest'),false);
});
test('Secret-Safe refusal never creates or sends a transfer', async () => {
  let calls=0, reviews=0;
  const result=await uploadContent({file:new File(['private'],'credentials.zip'),id:'id',recipientId:'peer',operate:async()=>{calls++;},confirm:async()=>{reviews++;return false;},progress:()=>{},stopped:()=>false});
  assert.equal(result,false);assert.equal(calls,0);assert.equal(reviews,1);
});
test('upload UI pauses at an acknowledged boundary and does not claim completion',async()=>{
  let paused=false;const phases=[],calls=[];
  const result=await uploadContent({file:new File(['hello'],'hello.txt'),id:'id',recipientId:'peer',confirm:async()=>true,stopped:()=>paused,progress:value=>phases.push(value.phase),operate:async command=>{
    calls.push(command.action);
    if(command.action==='content-create')return {state:'uploading',nextIndex:0,retainedBytes:0};
    paused=true;return {state:'uploading',nextIndex:1,retainedBytes:5};
  }});
  assert.equal(result,false);assert.deepEqual(calls,['content-create','content-chunk']);assert.equal(phases.at(-1),'Paused');
});
test('receive UI preserves cancelled destination as ready to save, not success',async()=>{
  const phases=[];
  const result=await receiveContent({record:{id:'id',name:'a',size:5},stopped:()=>false,progress:value=>phases.push(value.phase),call:async action=>action==='receive-start'?{state:'completed',retainedBytes:5,nextIndex:1}:{saved:false}});
  assert.equal(result.saved,false);assert.equal(phases.at(-1),'Ready to save');
});
test('resume rejects a different file before any backend operation',async()=>{
  await assert.rejects(uploadContent({file:new File(['hello'],'hello.txt'),id:'id',recipientId:'peer',expected:{sha256:'wrong'},confirm:async()=>true,stopped:()=>false,progress:()=>{},operate:async()=>assert.fail('must not send')}),/original file/);
});

test('queue UI completes protected staging before enabling background delivery',async()=>{
  const calls=[];
  const result=await queueContent({file:new File(['hello'],'hello.txt'),id:'id',recipientId:'peer',target:{projectId:'project'},confirm:async()=>true,stopped:()=>false,progress:()=>{},call:async(action)=>{calls.push(action);}});
  assert.equal(result,true);assert.deepEqual(calls,['queue-create','queue-stage','queue-commit']);
});
test('queue UI cancels incomplete staging on disk failure and never commits it',async()=>{
  const calls=[];
  await assert.rejects(queueContent({file:new File(['hello'],'hello.txt'),id:'id',recipientId:'peer',target:{projectId:'project'},confirm:async()=>true,stopped:()=>false,progress:()=>{},call:async(action)=>{calls.push(action);if(action==='queue-stage')throw Error('disk full');}}),/disk full/);
  assert.deepEqual(calls,['queue-create','queue-stage','queue-cancel']);
});

test('multi-recipient queue isolates failure and stable per-recipient jobs',async()=>{
 const creates=[],commits=[];let reviews=0;const results=await queueContentMany({file:new File(['hello'],'private.zip'),recipientIds:['one','two','three','three'],target:{projectId:'project'},confirm:async()=>{reviews++;return true;},stopped:()=>false,progress:()=>{},call:async(action,value)=>{if(action==='queue-create'){creates.push(value.meta);if(value.meta.recipientId==='two')throw Error('revoked');}if(action==='queue-commit')commits.push(value.id);}});
 assert.deepEqual(results.map(r=>r.queued),[true,false,true]);assert.equal(new Set(creates.map(m=>m.id)).size,3);assert.equal(commits.length,2);assert.equal(reviews,1);assert.match(results[1].error,/revoked/);
});
test('multi-recipient Secret-Safe refusal prevents every recipient upload',async()=>{const results=await queueContentMany({file:new File(['hello'],'private.zip'),recipientIds:['one','two'],target:{},confirm:async()=>false,stopped:()=>false,progress:()=>{},call:async()=>assert.fail('no transmission')});assert.equal(results.length,1);assert.equal(results[0].queued,false);});
