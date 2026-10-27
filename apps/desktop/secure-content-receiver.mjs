import {saveVerifiedCopy,inspectSaveReceipt} from './verified-save.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { CONTENT_CHUNK, validateContentView } from '../../packages/transfer/secure-content.mjs';
import { regularFile } from './secure-content-store.mjs';
const { createTransferStore } = createRequire(import.meta.url)('../../packages/transfer/index.cjs');

export function createContentReceiver(directory, protection) {
  const root = path.resolve(directory),stores=new Map();
  const {transferPolicy,requireSpace}=createRequire(import.meta.url)('../../packages/transfer/limits.cjs'),policy=transferPolicy();
  async function cache(target) {
    const key = target.mode === 'local' ? 'local' : target.fingerprint.replaceAll(':', '');
    if (!/^(?:local|[A-F0-9]{64})$/.test(key)) throw Error('Invalid source identity.');
    const folder = path.join(root, key); await fs.mkdir(folder, { recursive: true });
    for (const entry of [root, folder]) if ((await fs.lstat(entry)).isSymbolicLink()) throw Error('Unsafe receive cache.');
    if(!stores.has(folder)){if(stores.size>=100)throw Error('Receive peer cache capacity reached.');stores.set(folder,createTransferStore(folder,policy));}
    return { folder, store: stores.get(folder) };
  }
  async function prepare(target, request, execute) {
    const metadata = validateContentView(await execute({ ...request, action: 'content-status' }));
    if (metadata.state !== 'completed') throw Error('Only verified, completed content can be received.');
    const local = await cache(target);
    for (const folder of [path.join(local.folder, '.transfers'), path.join(local.folder, '.transfers', metadata.id)]) {
      const stat = await fs.lstat(folder).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw Error('Unsafe receive cache.');
    }
    for (const name of await fs.readdir(path.join(local.folder, '.transfers', metadata.id)).catch(error => { if (error.code !== 'ENOENT') throw error; return []; })) await regularFile(path.join(local.folder, '.transfers', metadata.id, name));
    for (const suffix of ['.bin', '.bin.json']) {
      const file = path.join(local.folder, metadata.id + suffix);
      await regularFile(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    // Same engine verifies retained chunks on restart and binds a stable ID to exact metadata.
    const status = await local.store.create(metadata.name, metadata.size, metadata.sha256, metadata.id);
    return { ...local, metadata, status };
  }
  const view = ({ metadata, status }) => validateContentView({ ...metadata, ...status, name: metadata.name });
  const operations = {
    async inventory(target,records,principalId){
      if(target.mode!=='remote'||!Array.isArray(records)||records.length>200)throw Error('Scoped receive inventory unavailable.');
      const seen=new Set();for(const record of records){validateContentView(record);if(record.projectId!==target.projectId||record.contextId!==target.contextId||![record.senderId,record.recipientId].includes(principalId)||seen.has(record.id))throw Error('Receive inventory scope mismatch.');seen.add(record.id);}
      const local=await cache(target),downloads=[],saves=[];let downloadKnown=true,saveKnown=true;
      for(const m of records){
        if(m.recipientId===principalId&&m.state!=='cancelled'&&m.delivery!=='Applied')downloads.push({id:m.id,state:'inbound-pending'});
        try{
          const dir=path.join(local.folder,'.transfers',m.id),st=await fs.lstat(dir).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
          if(st){if(!st.isDirectory()||st.isSymbolicLink())throw Error('Unsafe cache.');const file=path.join(dir,'state.json');if((await regularFile(file)).size>262144)throw Error('Inventory manifest limit.');const state=JSON.parse(await fs.readFile(file,'utf8'));
            if(state.version!==1||state.id!==m.id||state.expectedHash!==m.sha256||state.size!==m.size||!['uploading','completed','failed'].includes(state.state)||!Array.isArray(state.chunks)||state.chunks.length>Math.ceil(m.size/CONTENT_CHUNK)||state.chunks.some((c,i)=>!c||!/^[a-f0-9]{64}$/.test(c.sha256)||c.size!==Math.min(CONTENT_CHUNK,m.size-i*CONTENT_CHUNK)))throw Error('Invalid cache manifest.');
            if(state.state==='completed'&&(await regularFile(path.join(local.folder,m.id+'.bin'))).size!==m.size)throw Error('Completed cache missing.');
            downloads.push({id:m.id,state:state.state==='completed'?'download-complete':'download-incomplete'});
          }
        }catch{downloadKnown=false;}
        try{const state=await inspectSaveReceipt(path.join(local.folder,m.id+'.applied.json'),m,protection);if(state)saves.push({id:m.id,state});}catch{saveKnown=false;}
      }
      return {'inbound-deliveries':downloadKnown?downloads:null,'save-receipts':saveKnown?saves:null};
    },
    async start(target, request, execute) { return view(await prepare(target, request, execute)); },
    async chunk(target, request, execute) {
      const local = await prepare(target, { ...request, index: undefined }, command => { delete command.index; return execute(command); });
      if (local.status.state === 'completed') return view(local);
      if (request.index !== local.status.nextIndex) throw Error('Refresh download progress before resuming.');
      const chunk = await execute({ ...request, action: 'content-read' });
      const bytes = Buffer.from(chunk.data, 'base64');
      if (createHash('sha256').update(bytes).digest('hex') !== chunk.sha256 || bytes.length !== Math.min(CONTENT_CHUNK, local.metadata.size - request.index * CONTENT_CHUNK)) throw Error('Received chunk failed integrity validation.');
      local.status = await local.store.append(local.metadata.id, request.index, Readable.from([bytes])); return view(local);
    },
    async cleanup(target,request,execute){
      const metadata=validateContentView(await execute({...request,action:'content-status'})),local=await cache(target),receiptFile=path.join(local.folder,`${metadata.id}.applied.json`);
      await regularFile(receiptFile);
      await saveVerifiedCopy({metadata,source:path.join(local.folder,`${metadata.id}.bin`),receiptFile,protection,chooseDirectory:async()=>{throw Error('Only an already-saved copy can be cleaned.');},checkSpace:async()=>{throw Error('Interrupted saves must be recovered before cleanup.');},authorize:async()=>{await execute({...request,action:'content-status'});}});
      const folder=path.join(local.folder,'.transfers',metadata.id);const stat=await fs.lstat(folder).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      if(stat){if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Unsafe cache directory.');for(const name of await fs.readdir(folder)){if(!/^(state\.json(?:\.tmp)?|assembled\.part|\d+\.chunk(?:\.part)?)$/.test(name))throw Error('Unexpected cache file; preserved.');await regularFile(path.join(folder,name));}for(const name of await fs.readdir(folder))await fs.unlink(path.join(folder,name));await fs.rmdir(folder);}
      for(const suffix of ['.bin','.bin.json']){const file=path.join(local.folder,metadata.id+suffix);try{await regularFile(file);await fs.unlink(file);}catch(e){if(e.code!=='ENOENT')throw e;}}
      stores.delete(local.folder);return {cleaned:true,savedCopyPreserved:true};
    },
    async finish(target, request, execute, chooseDirectory) {
      const local = await prepare(target, request, execute);
      await local.store.complete(local.metadata.id);
      const access = await execute({ action: 'content-info' });
      const acknowledge = async delivery => {
        if (access.principalId === local.metadata.recipientId) await execute({ ...request, action: 'content-receipt', delivery, sha256: local.metadata.sha256 });
      };
      await acknowledge('Delivered');
      const receiptFile = path.join(local.folder, `${local.metadata.id}.applied.json`);
      const result=await saveVerifiedCopy({metadata:local.metadata,source:path.join(local.folder,`${local.metadata.id}.bin`),receiptFile,protection,chooseDirectory,checkSpace:(dir,size)=>requireSpace(fs,dir,size,policy.reserveBytes),authorize:async()=>{const current=validateContentView(await execute({...request,action:'content-status'}));if(current.state!=='completed'||current.sha256!==local.metadata.sha256||current.size!==local.metadata.size)throw Error('Content is no longer available.');}});
      if(result.saved)await acknowledge('Applied');return result;
    },
  };
  let pending = Promise.resolve();
  return Object.fromEntries(Object.entries(operations).map(([name, operation]) => [name, name==='inventory'?operation:(...args) => {
    const result = pending.then(() => operation(...args)); pending = result.catch(() => {}); return result;
  }]));
}
