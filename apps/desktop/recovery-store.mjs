import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {regularFile,writeAtomic} from './secure-content-store.mjs';
import {createRecoveryPackage,recoveryState,RESTORE_FIELDS,digest,validateManifest,readRecoveryJson} from './recovery-package.mjs';
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),uuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v);
function validPreview(p){return p&&Object.keys(p).sort().join(',')==='authorityRevision,createdAt,expiresAt,id,identityBinding,liveDigest,principalId'&&uuid(p.id)&&uuid(p.principalId)&&['authorityRevision','identityBinding','liveDigest'].every(k=>hex(p[k]))&&['createdAt','expiresAt'].every(k=>Number.isFinite(Date.parse(p[k])))&&Date.parse(p.expiresAt)-Date.parse(p.createdAt)===600000;}
const exec=promisify(execFile),inside=(a,b)=>{const r=path.relative(a,b);return !r||!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r);};
export async function independentPreview(snapshot,key,projectId,principalId){const {stdout}=await exec(process.execPath,[fileURLToPath(new URL('./recovery-preview-cli.mjs',import.meta.url)),snapshot,key,projectId,principalId],{shell:false,windowsHide:true,timeout:10000,maxBuffer:65536,env:{SystemRoot:process.env.SystemRoot??'',ELECTRON_RUN_AS_NODE:'1'}});return JSON.parse(stdout);}
export function createRecoveryStore(file,{protection,authorize,source,privateRoot,commit,now=Date.now}){
 let pending=Promise.resolve();const serial=fn=>{const p=pending.then(fn);pending=p.catch(()=>{});return p;};
 async function load(){try{if((await regularFile(file)).size>1024*1024)throw Error();const envelope=JSON.parse(await fs.readFile(file,'utf8'));if(envelope.version!==1)throw Error();const d=JSON.parse(protection.open(envelope.sealed));if(d.version!==1||!Array.isArray(d.records)||d.records.length>20)throw Error();const ids=new Set();for(const r of d.records){validateManifest(r.manifest);if(Object.keys(r).some(k=>!['manifest','snapshotFile','keyFile','envelopeDigest','keyDigest','verifiedAt','proofId','preview','metadataRestoredAt'].includes(k))||ids.has(r.manifest.snapshotId)||!path.isAbsolute(r.snapshotFile)||!path.isAbsolute(r.keyFile)||!['envelopeDigest','keyDigest'].every(k=>/^[a-f0-9]{64}$/.test(r[k]))||(r.verifiedAt!==undefined&&(!Number.isFinite(Date.parse(r.verifiedAt))||!/^[a-f0-9-]{36}$/.test(r.proofId))))throw Error();if(r.preview!==undefined&&!validPreview(r.preview)||r.metadataRestoredAt!==undefined&&!Number.isFinite(Date.parse(r.metadataRestoredAt)))throw Error();ids.add(r.manifest.snapshotId);}return d;}catch(e){if(e.code==='ENOENT')return{version:1,records:[]};throw Error('Recovery evidence is corrupt or unavailable; original preserved.');}}
 async function save(d){await fs.mkdir(path.dirname(file),{recursive:true});if((await fs.lstat(path.dirname(file))).isSymbolicLink())throw Error('Unsafe recovery evidence storage.');await writeAtomic(file,{version:1,sealed:protection.seal(JSON.stringify(d))});}
 const permit=async(projectId,fp=null,write=false)=>{const a=await authorize(fp,projectId);if(!a.canPlan||write&&(!a.local||a.role!=='owner'))throw Error('Current local owner approval required.');return a;};
 const current=async id=>structuredClone(await source(id));
 const scope=(r,id)=>r.manifest.projectId===id;
 async function view(r,a,state){let status='UNVERIFIED';try{const e=await readRecoveryJson(r.snapshotFile,32768),k=await readRecoveryJson(r.keyFile,4096);if(digest(e)!==r.envelopeDigest||digest(k)!==r.keyDigest)status='DAMAGED';else if(now()>=Date.parse(r.manifest.expiresAt))status='EXPIRED';else if(r.manifest.sourceVersion!==digest(recoveryState(state,r.manifest.version))||r.manifest.authorityRevision!==a.authorityRevision||r.manifest.identityBinding!==a.members.find(m=>m.id===r.manifest.principalId)?.currentIdentityBinding)status='STALE';else if(r.verifiedAt&&now()-Date.parse(r.verifiedAt)<86400000)status='VERIFIED';}catch(e){status=e.code==='ENOENT'?'MISSING':'DAMAGED';}return{snapshotId:r.manifest.snapshotId,projectId:r.manifest.projectId,policy:r.manifest.policy,sourceVersion:r.manifest.sourceVersion,principalId:r.manifest.principalId,createdAt:r.manifest.createdAt,expiresAt:r.manifest.expiresAt,verifiedAt:r.verifiedAt??null,status,proof:r.verifiedAt?'independent-process-decryption':'not-verified',completeRecovery:false,...(r.metadataRestoredAt?{metadataRestoredAt:r.metadataRestoredAt}:{})};}
 async function fresh(id,a,state){const after=await permit(id,null,true);if(after.identityBinding!==a.identityBinding||after.authorityRevision!==a.authorityRevision||digest(await current(id))!==digest(state))throw Error('Recovery authority or source changed; retry.');}
 async function exclusive(file,value){const h=await fs.open(file,'wx',0o600);try{await h.writeFile(JSON.stringify(value));await h.sync();}finally{await h.close();}}
 return{
 evidence:(projectId,fp=null)=>serial(async()=>{const a=await permit(projectId,fp),state=await current(projectId),d=await load(),result=await Promise.all(d.records.filter(r=>scope(r,projectId)).map(r=>view(r,a,state)));const after=await permit(projectId,fp);if(a.authorityRevision!==after.authorityRevision)throw Error('Recovery authority changed.');return result;}),
 create:(projectId,snapshotDirectory,keyDirectory,approvedSourceDigest)=>serial(async()=>{
  const a=await permit(projectId,null,true),state=await current(projectId),d=await load();if(approvedSourceDigest!==undefined&&approvedSourceDigest!==digest(state))throw Error('Project changed since export approval; review again.');if(d.records.length>=20)throw Error('Recovery evidence capacity reached; forget an obsolete record without deleting its files.');
  const destinations=await Promise.all([snapshotDirectory,keyDirectory].map(async p=>{const real=await fs.realpath(p);if(!(await fs.stat(real)).isDirectory())throw Error('Choose existing directories.');return real;})),[snapDir,keyDir]=destinations,privateDir=await fs.realpath(privateRoot);
  if(destinations.some(p=>inside(privateDir,p))||inside(snapDir,keyDir)||inside(keyDir,snapDir))throw Error('Use separate, non-nested destinations outside application storage. Physical independence remains unverified.');
  const {envelope,secret}=createRecoveryPackage(state,a,now()),id=envelope.manifest.snapshotId,snapshotFile=path.join(snapDir,id+'.edrecovery'),keyFile=path.join(keyDir,id+'.edkey');
  await fresh(projectId,a,state);await exclusive(keyFile,secret);await exclusive(snapshotFile,envelope);await fresh(projectId,a,state);
  const r={manifest:envelope.manifest,snapshotFile,keyFile,envelopeDigest:digest(envelope),keyDigest:digest(secret)};d.records.push(r);await save(d);return view(r,a,state);
 }),
 verify:(projectId,id,snapshotFile,keyFile)=>serial(async()=>{
  const a=await permit(projectId,null,true),state=await current(projectId),d=await load(),r=d.records.find(r=>scope(r,projectId)&&r.manifest.snapshotId===id);if(!r||r.manifest.principalId!==a.principalId||r.manifest.identityBinding!==a.identityBinding)throw Error('Recovery enrollment identity or scope unavailable.');
  const snapDir=await fs.realpath(path.dirname(snapshotFile)),keyDir=await fs.realpath(path.dirname(keyFile)),privateDir=await fs.realpath(privateRoot);if([snapDir,keyDir].some(p=>inside(privateDir,p))||inside(snapDir,keyDir)||inside(keyDir,snapDir))throw Error('Keep recovery material in separate destinations outside application storage.');
  const proofId=randomUUID();let proof;try{proof=await independentPreview(snapshotFile,keyFile,projectId,a.principalId);}catch{throw Error('Independent decryption failed. Check the selected key, snapshot, scope, expiry and integrity.');}
  if(digest(proof.manifest)!==digest(r.manifest)||digest(proof.state)!==r.manifest.sourceVersion)throw Error('Recovery snapshot does not match enrollment.');
  const e=await readRecoveryJson(snapshotFile,32768),k=await readRecoveryJson(keyFile,4096);if(digest(e)!==r.envelopeDigest||digest(k)!==r.keyDigest)throw Error('Recovery material changed during verification.');
  await fresh(projectId,a,state);r.snapshotFile=await fs.realpath(snapshotFile);r.keyFile=await fs.realpath(keyFile);r.verifiedAt=new Date(now()).toISOString();r.proofId=proofId;
  const fields=recoveryState(proof.state,r.manifest.version),live=recoveryState(state,r.manifest.version),blockers=[];
  if(r.manifest.version!==2)blockers.push('LEGACY_PREVIEW_ONLY');
  if(r.manifest.authorityRevision!==a.authorityRevision)blockers.push('AUTHORITY_CHANGED_SINCE_SNAPSHOT');
  if(['id','type','origin','createdAt'].some(k=>fields[k]!==live[k]))blockers.push('IMMUTABLE_PROJECT_CONFLICT');
  if(!commit)blockers.push('RESTORE_WRITER_UNAVAILABLE');
  r.preview={id:randomUUID(),principalId:a.principalId,identityBinding:a.identityBinding,authorityRevision:a.authorityRevision,liveDigest:digest(state),createdAt:new Date(now()).toISOString(),expiresAt:new Date(now()+600000).toISOString()};await save(d);
  return{evidence:await view(r,a,state),state:fields,differences:Object.keys(live).filter(k=>live[k]!==fields[k]).map(field=>({field,current:live[field],snapshot:fields[field]})),previewId:r.preview.id,expiresAt:r.preview.expiresAt,restoreFields:RESTORE_FIELDS.filter(k=>k in fields&&fields[k]!==live[k]),blockers,canApply:!blockers.length,completeRecovery:false};
 }),
 restore:(projectId,id,previewId,selectedFields,confirm)=>serial(async()=>{
  const a=await permit(projectId,null,true),d=await load(),r=d.records.find(r=>scope(r,projectId)&&r.manifest.snapshotId===id),p=r?.preview;
  if(!commit||!p||p.id!==previewId||!validPreview(p)||r.manifest.version!==2||p.principalId!==a.principalId||r.manifest.principalId!==a.principalId||p.identityBinding!==a.identityBinding||r.manifest.identityBinding!==a.identityBinding||p.authorityRevision!==a.authorityRevision||r.manifest.authorityRevision!==a.authorityRevision)throw Error('Restore preview or protected authority unavailable; verify again.');
  if(now()<Date.parse(p.createdAt)||now()>=Date.parse(p.expiresAt))throw Error('Restore preview expired; verify again.');
  if(!Array.isArray(selectedFields)||!selectedFields.length||new Set(selectedFields).size!==selectedFields.length||selectedFields.some(k=>!RESTORE_FIELDS.includes(k)))throw Error('Select supported metadata fields explicitly.');
  let proof;try{proof=await independentPreview(r.snapshotFile,r.keyFile,projectId,a.principalId);}catch{throw Error('Recovery material unavailable or invalid; nothing restored.');}
  if(digest(proof.manifest)!==digest(r.manifest)||digest(proof.state)!==r.manifest.sourceVersion||digest(await readRecoveryJson(r.snapshotFile,32768))!==r.envelopeDigest||digest(await readRecoveryJson(r.keyFile,4096))!==r.keyDigest)throw Error('Recovery enrollment integrity mismatch.');
  const state=await current(projectId);if(['id','type','origin','createdAt'].some(k=>state[k]!==proof.state[k]))throw Error('Immutable project conflict; nothing restored.');
  const patch=Object.fromEntries([...selectedFields].sort().map(k=>[k,proof.state[k]]));
  // Only native-main code supplies confirmation; no renderer success/authority flags are accepted.
  if(typeof confirm!=='function'||await confirm({differences:Object.keys(patch).map(field=>({field,current:state[field],snapshot:patch[field]}))})!==true)throw Error('Metadata restore cancelled.');
  if(now()>=Date.parse(p.expiresAt)||now()>=Date.parse(r.manifest.expiresAt))throw Error('Recovery authorization expired; verify again.');
  const result=await commit({id:p.id,projectId,snapshotId:id,principalId:p.principalId,identityBinding:p.identityBinding,authorityRevision:p.authorityRevision,expectedDigest:p.liveDigest,expiresAt:new Date(Math.min(Date.parse(p.expiresAt),Date.parse(r.manifest.expiresAt))).toISOString(),patch});
  r.metadataRestoredAt=result.appliedAt;await save(d);
  return {operationId:result.id,fields:result.fields,appliedAt:result.appliedAt,replayed:result.replayed,currentMatches:result.currentMatches,completeRecovery:false};
 }),
 forget:(projectId,id)=>serial(async()=>{await permit(projectId,null,true);const d=await load();if(!d.records.some(r=>scope(r,projectId)&&r.manifest.snapshotId===id))throw Error('Recovery record unavailable.');d.records=d.records.filter(r=>!(scope(r,projectId)&&r.manifest.snapshotId===id));await permit(projectId,null,true);await save(d);return{forgotten:true,filesDeleted:false};})
 };
}
