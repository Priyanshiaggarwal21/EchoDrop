import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_MANIFEST = 256 * 1024;
const MAX_LOCK = 8 * 1024 * 1024;
const NAME = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const cleanVersion = value => typeof value === 'string' && VERSION.test(value.trim()) ? value.trim() : undefined;
const cleanRequirement = value => typeof value === 'string' && value.length <= 160 && !/[\\\r\n]|https?:\/\//i.test(value) ? value.trim() : undefined;
const unsupported = reason => ({state:'unknown',reason});

async function readFile(root, relative, limit) {
 const parts=relative.split('/');let current=root;
 for(const part of parts){if(!part||part==='.'||part==='..'||part.includes('\\'))throw Error('Unsafe dependency path.');current=path.join(current,part);const st=await fs.lstat(current);if(st.isSymbolicLink())throw Error('Linked dependency files are not inspected.');}
 const handle=await fs.open(current,'r');try{const st=await handle.stat();if(!st.isFile()||st.nlink>1||st.size>limit)throw Error('Dependency file exceeds safe bounds.');const buffer=Buffer.alloc(limit+1);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);if(bytesRead>limit)throw Error('Dependency file exceeds safe bounds.');return buffer.subarray(0,bytesRead).toString('utf8');}finally{await handle.close();}
}
async function optional(root, relative, limit) {try{return await readFile(root,relative,limit);}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return undefined;throw error;}}
function parseNodeRequirement(required, installed) {
 const value=cleanVersion(installed);if(!value)return unsupported('Installed package metadata is missing or has an unsupported version.');
 const clauses=String(required).trim().split(/\s*\|\|\s*/);if(!clauses.length||clauses.some(clause=>!cleanRequirement(clause)))return unsupported('Node version range is unsupported.');
 const ok=clauses.some(clause=>clause.trim().split(/\s+/).every(part=>{
  if(part==='*'||part==='latest')return true;
  const match=/^(\^|~|>=|<=|>|<|=)?\s*(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(part);if(!match)return false;
  const actual=value.split('.').map(Number), base=[Number(match[2]),match[3]==null||match[3]==='x'||match[3]==='*'?0:Number(match[3]),match[4]==null||match[4]==='x'||match[4]==='*'?0:Number(match[4])],op=match[1]??'=';
  const compare=(left,right)=>left[0]-right[0]||left[1]-right[1]||left[2]-right[2];
  if(op==='^'){const upper=match[3]==null||base[0]!==0?[base[0]+1,0,0]:match[4]==null||match[4]==='x'||match[4]==='*'?[0,base[1]+1,0]:[0,0,base[2]+1];return compare(actual,base)>=0&&compare(actual,upper)<0;}
  if(op==='~')return actual[0]===base[0]&&actual[1]===base[1]&&actual[2]>=base[2];
  if(op==='>=')return compare(actual,base)>=0;
  if(op==='<=')return compare(actual,base)<=0;
  if(op==='>')return compare(actual,base)>0;
  if(op==='<')return compare(actual,base)<0;
  return actual[0]===base[0]&&(match[3]==null||match[3]==='x'||actual[1]===base[1])&&(match[4]==null||match[4]==='x'||actual[2]===base[2]);
 }));return {state:ok?'compatible':'mismatch',reason:ok?'Installed version satisfies the declared range.':'Installed version does not satisfy the declared range.'};
}
function parsePythonRequirement(line) {
 const match=/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s*(==|~=|>=|<=|>|<)\s*([0-9][0-9A-Za-z.+-]*))?(?:\s*;.*)?$/.exec(line.trim());
 return match&&{name:match[1].toLowerCase(),required:match[2]&&match[3]?match[2]+match[3]:'*'};
}
function parseRequirements(text) {
 const dependencies=[];for(const raw of text.split(/\r?\n/)){const line=raw.trim();if(!line||line.startsWith('#')||line.startsWith('-'))continue;const item=parsePythonRequirement(line);if(!item)return undefined;dependencies.push(item);}return dependencies;
}
function parsePyproject(text) {
 const match=/^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(text);if(!match)return undefined;
 const dependencies=[];for(const value of match[1].matchAll(/["']([^"']+)["']/g)){const item=parsePythonRequirement(value[1]);if(!item)return undefined;dependencies.push(item);}return dependencies;
}
function nodeState(required, installed, lockVersion) {
 if(installed==='missing')return {state:'missing',reason:'Declared package is not present in the project-local node_modules tree.'};
 if(installed==='unknown')return unsupported('Project-local package metadata could not be safely inspected.');
 const result=parseNodeRequirement(required,installed);if(result.state==='compatible'&&lockVersion&&lockVersion!==installed)return {state:'mismatch',reason:'Installed package version differs from the package-lock declaration.'};return result;
}
async function inspectNode(root, manifest, result) {
 let lockText;try{lockText=await optional(root,'package-lock.json',MAX_LOCK);}catch{result.limitations.push('package-lock.json is linked or outside safe collection bounds; lock compatibility is unknown.');}
 let lock;
 if(lockText!==undefined)try{lock=JSON.parse(lockText);}catch{result.limitations.push('package-lock.json is malformed; lock compatibility is unknown.');}
 for(const [name,required] of Object.entries({...manifest.dependencies,...manifest.devDependencies}).sort(([a],[b])=>a.localeCompare(b)).slice(0,100)){
  if(!NAME.test(name)||name.length>100)continue;const safeRequired=cleanRequirement(required);let installed='unknown',lockVersion;
  try{const packageText=await readFile(root,`node_modules/${name}/package.json`,MAX_MANIFEST);const pkg=JSON.parse(packageText);installed=cleanVersion(pkg.version)??'unknown';}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')installed='missing';}
  if(lock?.packages&&typeof lock.packages==='object'){const entry=lock.packages[`node_modules/${name}`];if(entry&&typeof entry.version==='string')lockVersion=cleanVersion(entry.version);}
  const declared=safeRequired&&/^[v0-9~^<>=*|. +()-]+$/.test(safeRequired)?safeRequired:'redacted';
  const lockRequired=lock?.packages?.['']?.dependencies?.[name];
  const check=declared==='redacted'?unsupported('Declared Node version range is malformed or unsupported.'):lockRequired!==undefined&&lockRequired!==required?{state:'mismatch',reason:'Manifest declaration differs from package-lock.json.'}:nodeState(declared,installed,lockVersion);
  result.dependencies.push({name,required:declared,installed,ecosystem:'npm',...check});
 }
 if(lockText!==undefined&&lock!==undefined){if(!lock.packages||typeof lock.packages!=='object')result.limitations.push('This package-lock.json format is unsupported; lock compatibility is unknown.');const rootDeps=lock.packages?.['']?.dependencies??{};for(const [name,required] of Object.entries(manifest.dependencies??{}))if(rootDeps[name]!==undefined&&rootDeps[name]!==required)result.limitations.push(`package-lock.json declaration drift detected for ${name}.`);}
}
async function inspectPython(root, result) {
 let text=await optional(root,'requirements.txt',MAX_MANIFEST),format='requirements.txt';if(text===undefined){text=await optional(root,'pyproject.toml',MAX_MANIFEST);format='pyproject.toml';}
 if(text===undefined)return;
 const dependencies=format==='requirements.txt'?parseRequirements(text):parsePyproject(text);
 if(!dependencies){result.limitations.push(`${format} is unsupported or malformed; Python dependency compatibility is unknown.`);return;}
 for(const item of dependencies.slice(0,100)){let installed='unknown';const candidates=[`.venv/Lib/site-packages/${item.name}.dist-info/METADATA`,`venv/Lib/site-packages/${item.name}.dist-info/METADATA`];for(const candidate of candidates){try{const metadata=await readFile(root,candidate,MAX_MANIFEST);const version=/^Version:\s*(\S+)/mi.exec(metadata)?.[1];if(version)installed=cleanVersion(version)??'unknown';break;}catch(error){if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')break;}}const check=installed==='missing'?{state:'missing',reason:'Declared Python package metadata is not present in the project-local virtual environment.'}:installed==='unknown'?unsupported('Project-local Python package metadata was not found or is unsupported.'):nodeState(item.required,installed);result.dependencies.push({name:item.name,required:item.required,installed,ecosystem:'python',...check});}
}
export async function inspectProjectDependencies(root) {
 const result={dependencies:[],locks:[],limitations:[]};
 let manifest;try{manifest=JSON.parse(await readFile(root,'package.json',MAX_MANIFEST));}catch(error){result.limitations.push(error.code==='ENOENT'?'package.json is missing.':'package.json is malformed or unavailable.');}
 if(manifest&&typeof manifest==='object'&&!Array.isArray(manifest))await inspectNode(root,manifest,result);
 await inspectPython(root,result);
 return result;
}
