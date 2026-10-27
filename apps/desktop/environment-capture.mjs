import {detectInstalledRuntimes} from './installed-runtimes.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {environmentFields} from '../../packages/core/environments.mjs';
import {inspectProjectDependencies} from './dependency-compatibility.mjs';
// Never evaluate manifests, resolve modules, run scripts, read .env, or serialize process.env.
async function bounded(root,relative,max=262144){
 const parts=relative.split('/');let current=root;
 for(const part of parts){if(!part||part==='.'||part==='..'||part.includes('\\'))throw Error('Unsafe collection path.');current=path.join(current,part);const st=await fs.lstat(current);if(st.isSymbolicLink())throw Error('Linked files are not collected.');}
 const handle=await fs.open(current,'r');try{const st=await handle.stat();if(!st.isFile()||st.nlink>1||st.size>max)throw Error('File cannot be collected safely.');const buffer=Buffer.alloc(max+1);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);if(bytesRead>max)throw Error('File size limit reached.');return buffer.subarray(0,bytesRead);}finally{await handle.close();}
}
const cleanVersion=v=>typeof v==='string'&&/^[v0-9~^<>=*][0-9A-Za-z.+ _<>=~^|*-]{0,79}$/.test(v)?v:undefined;
async function probe(port){return new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});let done=false;const finish=state=>{if(done)return;done=true;socket.destroy();resolve({port,state});};socket.setTimeout(400,()=>finish('unknown'));socket.once('connect',()=>finish('accepting'));socket.once('error',error=>finish(error.code==='ECONNREFUSED'?'not-accepting':'unknown'));});}
export async function captureEnvironment(root,options){
 if(!options||options.consent!==true||Object.keys(options).some(k=>!['consent','config','ports'].includes(k))||!Array.isArray(options.config)||options.config.some(k=>!['NODE_ENV','CI'].includes(k))||!Array.isArray(options.ports)||options.ports.length>8||new Set(options.ports).size!==options.ports.length||options.ports.some(p=>!Number.isInteger(p)||p<1||p>65535))throw Error('Explicit consent and valid collection choices are required.');
 const result={title:'Environment snapshot',capturedAt:new Date().toISOString(),system:{platform:os.platform(),release:os.release(),arch:os.arch()},runtime:{node:process.versions.node,...(process.versions.electron?{electron:process.versions.electron}:{})},tools:[],dependencies:[],locks:[],config:{},ports:[],limitations:['Windows tools report versions through bounded probes; this does not prove project compatibility.','Bundled Node is EchoDrop runtime, not the project runtime.','No environment files, private paths, hostnames or raw environment values are included.']};
 for(const key of options.config){const value=process.env[key];result.config[key]=value===undefined?'unset':(key==='NODE_ENV'?['development','production','test']:['true','false']).includes(value)?value:'redacted';}
 if(root){if(!path.isAbsolute(root))throw Error('Registered folder must be an absolute path.');const st=await fs.lstat(root);if(st.isSymbolicLink()||!st.isDirectory())throw Error('Registered folder is unavailable or linked.');}
 result.tools=await detectInstalledRuntimes(root?await fs.realpath(root):undefined);
 if(root){
  if(!path.isAbsolute(root))throw Error('Registered folder must be an absolute path.');
  const rootStat=await fs.lstat(root);if(rootStat.isSymbolicLink()||!rootStat.isDirectory())throw Error('Registered folder is unavailable or linked.');
  let manifest;try{manifest=JSON.parse(await bounded(root,'package.json'));}catch{result.limitations.push('Project package manifest missing, linked, malformed or exceeds collection bounds.');}
  if(manifest&&typeof manifest==='object'){if(cleanVersion(manifest.engines?.node))result.config.nodeRequirement=manifest.engines.node;if(typeof manifest.packageManager==='string'&&/^(npm|pnpm|yarn|bun)@[0-9][0-9A-Za-z.+-]{0,79}$/.test(manifest.packageManager))result.config.packageManager=manifest.packageManager;}
  const inspected=await inspectProjectDependencies(root);result.dependencies=inspected.dependencies;result.limitations.push(...inspected.limitations);
  for(const name of ['package-lock.json','pnpm-lock.yaml','yarn.lock','bun.lock','bun.lockb'])try{const bytes=await bounded(root,name,8*1024*1024);result.locks.push({name,sha256:createHash('sha256').update(bytes).digest('hex')});}catch(error){if(error.code!=='ENOENT')result.limitations.push(name+' was unavailable or exceeded safe collection bounds.');}
 }else result.limitations.push('No registered local folder; project dependency and lockfile evidence is unavailable.');
 result.ports=await Promise.all(options.ports.map(probe));return environmentFields(result);
}
