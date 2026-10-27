import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {intentId} from '../../packages/core/intentions.mjs';
import {fingerprintPattern} from './remote-identity.mjs';
import {regularFile,writeAtomic} from './secure-content-store.mjs';
const states=['offered','pending','approved','accepted','declined','expired','revoked'];
const name=value=>{if(typeof value!=='string'||!value.trim()||value.length>80||/[\x00-\x1f]/.test(value))throw Error('Enter a device name up to 80 characters.');return value.trim();};
export function createDevicePairing(file,store,{protection,now=Date.now}){
 let queue=Promise.resolve();const serial=fn=>{const p=queue.then(fn);queue=p.catch(()=>{});return p;};
 async function load(){try{if((await regularFile(file)).size>4*1024*1024)throw Error();const e=JSON.parse(await fs.readFile(file,'utf8'));if(e.version!==1)throw Error();const d=JSON.parse(protection.open(e.sealed));if(d.version!==1||!Array.isArray(d.invitations)||d.invitations.length>1000)throw Error();const ids=new Set();for(const i of d.invitations){if(!intentId(i.id)||ids.has(i.id)||!intentId(i.projectId)||(i.contextId!==undefined&&!intentId(i.contextId))||!fingerprintPattern.test(i.fingerprint)||!states.includes(i.status)||!Number.isSafeInteger(i.expiresAt)||!Number.isSafeInteger(i.createdAt)||!Number.isSafeInteger(i.updatedAt)||!(i.lastSeen===null||Number.isSafeInteger(i.lastSeen)))throw Error();name(i.deviceName);ids.add(i.id);}return d;}catch(e){if(e.code==='ENOENT')return{version:1,invitations:[]};throw Error('Protected device registry is corrupt or unavailable. Original preserved.');}}
 async function save(d){await fs.mkdir(path.dirname(file),{recursive:true});if((await fs.lstat(path.dirname(file))).isSymbolicLink())throw Error('Unsafe device registry directory.');await writeAtomic(file,{version:1,sealed:protection.seal(JSON.stringify(d))});}
 async function reconcile(d){const peers=(await store.remoteStatus()).peers;for(const i of d.invitations){if(!peers.some(p=>p.fingerprint===i.fingerprint&&p.status==='active')&&!['revoked','expired','declined'].includes(i.status)){i.status='revoked';i.updatedAt=now();}else if(['offered','pending','approved'].includes(i.status)&&i.expiresAt<=now()){i.status='expired';i.updatedAt=now();}}}
 return{
 local:(projectId,action,value={})=>serial(async()=>{
  const snapshot=await store.snapshot(projectId);if(!['owner','admin'].includes(snapshot.role))throw Error('Project administrator permission required.');const d=await load();await reconcile(d);
  if(action==='create'){
   if(Object.keys(value).some(k=>!['fingerprint','deviceName','contextId'].includes(k))||!fingerprintPattern.test(value.fingerprint)||(value.contextId!==undefined&&!snapshot.contexts.some(c=>c.id===value.contextId)))throw Error('Invalid pairing scope.');await store.remotePeer(value.fingerprint);await store.remoteCredentials();if(d.invitations.length>=1000)throw Error('Device invitation capacity reached.');if(d.invitations.some(i=>i.fingerprint===value.fingerprint&&i.projectId===projectId&&['offered','pending','approved','accepted'].includes(i.status)))throw Error('An active pairing already exists for this device and project.');const i={id:randomUUID(),projectId,...(value.contextId?{contextId:value.contextId}:{}),fingerprint:value.fingerprint,deviceName:name(value.deviceName),status:'offered',createdAt:now(),updatedAt:now(),expiresAt:now()+300000,lastSeen:null};d.invitations.push(i);await save(d);return i;
  }
  if(action!=='list'){
   if(Object.keys(value).some(k=>!['id','fingerprint','deviceName'].includes(k)))throw Error('Invalid device operation.');const i=d.invitations.find(i=>i.projectId===projectId&&i.id===value.id);if(!i)throw Error('Device pairing not found.');
   if(action==='approve'){if(i.status!=='pending'||value.fingerprint!==i.fingerprint)throw Error('Verify the pending device fingerprint before approval.');await store.remotePeer(i.fingerprint);i.status='approved';}
   else if(action==='revoke'){if(i.status!=='revoked'){await store.remoteLocal(projectId,'revoke-peer',{fingerprint:i.fingerprint});i.status='revoked';}}
   else if(action==='rename')i.deviceName=name(value.deviceName);
   else throw Error('Unsupported device operation.');i.updatedAt=now();
  }
  await save(d);return d.invitations.filter(i=>i.projectId===projectId);
 }),
 handle:(fingerprint,q)=>serial(async()=>{
  await store.remotePeer(fingerprint);if(q?.version!==1||!['device-request','device-accept','device-decline','device-status','device-reconnect'].includes(q.action)||!intentId(q.id)||Object.keys(q).some(k=>!['version','action','id','deviceName'].includes(k)))throw Error('Invalid device invitation operation.');const d=await load();await reconcile(d);const i=d.invitations.find(i=>i.id===q.id&&i.fingerprint===fingerprint);if(!i)throw Error('Pairing invitation unavailable.');const authority=await store.snapshot(i.projectId);if(!['owner','admin'].includes(authority.role)||(i.contextId&&!authority.contexts.some(c=>c.id===i.contextId)))throw Error('Pairing scope administration is no longer available.');
  // Pairing grants no project membership or content rights, and never changes the certificate pin.
  if(q.action==='device-request'){if(i.status!=='offered')throw Error('Pairing invitation already claimed or expired.');i.deviceName=name(q.deviceName);i.status='pending';}
  else if(q.action==='device-accept'){if(i.status!=='approved')throw Error('Explicit host approval is required.');i.status='accepted';i.lastSeen=now();}
  else if(q.action==='device-decline'){if(!['offered','pending','approved'].includes(i.status))throw Error('Pairing invitation is terminal.');i.status='declined';}
  else if(q.action==='device-reconnect'){if(i.status!=='accepted')throw Error('Device is not paired or has been revoked.');i.lastSeen=now();}
  i.updatedAt=now();await store.remotePeer(fingerprint);await save(d);return{version:1,id:i.id,projectId:i.projectId,...(i.contextId?{contextId:i.contextId}:{}),fingerprint:i.fingerprint,deviceName:i.deviceName,status:i.status,expiresAt:i.expiresAt,lastSeen:i.lastSeen};
 })};
}
