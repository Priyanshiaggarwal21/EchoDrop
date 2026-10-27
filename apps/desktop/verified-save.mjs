import fs from 'node:fs/promises';
import path from 'node:path';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {regularFile,writeAtomic} from './secure-content-store.mjs';
async function digest(file,end){const hash=createHash('sha256');if(end!==0)for await(const b of createReadStream(file,end===undefined?{}:{start:0,end:end-1}))hash.update(b);return hash.digest('hex');}
export async function saveVerifiedCopy({metadata,source,receiptFile,protection,chooseDirectory,authorize,checkSpace}){
 const save=claim=>writeAtomic(receiptFile,protection?{sealed:protection.seal(JSON.stringify(claim))}:claim);let claim;
 try{if((await regularFile(receiptFile)).size>32768)throw Error('Invalid save receipt.');const stored=JSON.parse(await fs.readFile(receiptFile,'utf8'));claim=protection?JSON.parse(protection.open(stored.sealed)):stored;if(![1,2].includes(claim.version)||claim.id!==metadata.id||claim.sha256!==metadata.sha256||(claim.version===2&&!['claimed','applied'].includes(claim.phase))||!path.isAbsolute(claim.parent)||!/^EchoDrop-[a-f0-9-]+$/.test(claim.folderName))throw Error('Invalid save receipt.');}catch(e){if(e.code!=='ENOENT')throw e;}
 if(!claim){const selected=await chooseDirectory();if(!selected)return{saved:false};await authorize();const parent=await fs.realpath(selected);if(!(await fs.stat(parent)).isDirectory())throw Error('Choose a directory.');await checkSpace(parent,metadata.size);claim={version:2,id:metadata.id,sha256:metadata.sha256,parent,folderName:`EchoDrop-${metadata.id.slice(0,8)}-${randomUUID()}`,phase:'claimed'};await save(claim);}
 const destination=path.join(claim.parent,claim.folderName),file=path.join(destination,metadata.name),part=path.join(destination,'.echodrop-save.part');
 if(await fs.realpath(claim.parent)!==claim.parent)throw Error('Destination parent changed; preserve files for review.');
 let directory;try{directory=await fs.lstat(destination);}catch(e){if(e.code!=='ENOENT')throw e;if(claim.version===1)throw Error('Previous save directory is missing; manual recovery required.');await fs.mkdir(destination);directory=await fs.lstat(destination);}
 if(!directory.isDirectory()||directory.isSymbolicLink())throw Error('Unsafe save destination.');
 let existing;try{existing=await fs.lstat(file);}catch(e){if(e.code!=='ENOENT')throw e;}
 if(existing){if(!existing.isFile()||existing.isSymbolicLink()||existing.size!==metadata.size||await digest(file)!==metadata.sha256)throw Error('Destination conflict: existing file differs. It has been preserved.');if(existing.nlink!==1){const p=await fs.lstat(part).catch(()=>null);if(existing.nlink!==2||!p||p.ino!==existing.ino||p.dev!==existing.dev)throw Error('Unexpected destination hard link.');await fs.unlink(part);}await authorize();return{saved:true,alreadyApplied:true,folderName:claim.folderName,name:metadata.name};}
 if(claim.version===1||claim.phase==='applied')throw Error('Previously saved file is missing. No duplicate or overwrite was created.');
 const names=await fs.readdir(destination);if(names.some(n=>n!=='.echodrop-save.part'))throw Error('Save directory contains unexpected files; preserved for review.');
 let offset=0,hasPart=false;try{const st=await regularFile(part);hasPart=true;offset=st.size;if(offset>metadata.size||await digest(part)!==await digest(source,offset))throw Error('Partial save changed. Preserve it for manual recovery.');}catch(e){if(e.code!=='ENOENT')throw e;}
 await authorize();await checkSpace(claim.parent,metadata.size-offset);const handle=await fs.open(part,hasPart?'a':'wx',0o600);
 try{if(offset<metadata.size)for await(const b of createReadStream(source,{start:offset})){offset+=b.length;if(offset>metadata.size)throw Error('Receive cache changed.');await handle.writeFile(b);}await handle.sync();}finally{await handle.close();}
 if(offset!==metadata.size||await digest(part)!==metadata.sha256)throw Error('Saved staging file failed integrity verification; not published.');await authorize();await fs.link(part,file);await fs.unlink(part);claim.phase='applied';await save(claim);return{saved:true,folderName:claim.folderName,name:metadata.name};
}

// Read-only inventory of the recorded save lifecycle. Never inspects or discloses destination paths.
export async function inspectSaveReceipt(receiptFile,metadata,protection){
 let stored;try{if((await regularFile(receiptFile)).size>32768)throw Error('Save receipt limit.');stored=JSON.parse(await fs.readFile(receiptFile,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}
 const c=JSON.parse(protection.open(stored.sealed));
 if(![1,2].includes(c.version)||c.id!==metadata.id||c.sha256!==metadata.sha256||!path.isAbsolute(c.parent)||!/^EchoDrop-[a-f0-9-]+$/.test(c.folderName)||c.version===2&&!['claimed','applied'].includes(c.phase))throw Error('Invalid scoped save receipt.');
 if(c.version===1)throw Error('Legacy save completion cannot be proven from this receipt.');
 return c.phase==='claimed'?'save-incomplete':'save-recorded';
}
