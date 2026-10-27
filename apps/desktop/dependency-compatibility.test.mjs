import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {captureEnvironment} from './environment-capture.mjs';
import {environmentFields,compareEnvironments} from '../../packages/core/environments.mjs';

let root;
test.before(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'echodrop-dependencies-'));});
test.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());await fs.rm(root,{recursive:true,force:true});});
async function fixture(name,files){const dir=path.join(root,name);await fs.mkdir(dir,{recursive:true});for(const [file,value] of Object.entries(files)){const target=path.join(dir,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,value);}return dir;}
const options={consent:true,config:[],ports:[]};

test('confirms compatible and missing npm packages without running scripts',async()=>{
 const dir=await fixture('missing',{ 'package.json':JSON.stringify({dependencies:{present:'^1.2.0',missing:'2.0.0'}}), 'node_modules/present/package.json':JSON.stringify({version:'1.4.0'}) });
 const result=await captureEnvironment(dir,options);
 assert.deepEqual(result.dependencies.map(x=>[x.name,x.state]),[['missing','missing'],['present','compatible']]);
});
test('reports incompatible installed versions and package-lock declaration drift',async()=>{
 const dir=await fixture('drift',{ 'package.json':JSON.stringify({dependencies:{widget:'^2.0.0'}}), 'node_modules/widget/package.json':JSON.stringify({version:'1.0.0'}), 'package-lock.json':JSON.stringify({lockfileVersion:3,packages:{'':{dependencies:{widget:'^1.0.0'}},'node_modules/widget':{version:'1.0.0'}}}) });
 const result=await captureEnvironment(dir,options);const dependency=result.dependencies.find(x=>x.name==='widget');
 assert.equal(dependency.state,'mismatch');assert.match(dependency.reason,/package-lock/);
 const actual=structuredClone(result);actual.dependencies[0].installed='3.0.0';actual.dependencies[0].state='mismatch';const comparison=compareEnvironments(result,actual);assert(comparison.issues.some(x=>x.field==='widget'&&x.severity==='blocker'));
});
test('applies semver caret bounds for zero-major dependencies',async()=>{
 const dir=await fixture('caret-zero',{'package.json':JSON.stringify({dependencies:{widget:'^0.2.0'}}),'node_modules/widget/package.json':JSON.stringify({version:'0.3.0'})});
 const result=await captureEnvironment(dir,options);assert.equal(result.dependencies[0].state,'mismatch');
});
test('distinguishes malformed and unsupported Python declarations',async()=>{
 const malformed=await fixture('python-malformed',{'requirements.txt':'requests==not a version\n'});
 const unknown=await captureEnvironment(malformed,options);assert.equal(unknown.dependencies.length,0);assert(unknown.limitations.some(x=>/unsupported or malformed/.test(x)));
 const supported=await fixture('python-supported',{'pyproject.toml':'[project]\ndependencies = ["requests>=2.0"]\n',' .keep':''});
 const result=await captureEnvironment(supported,options);assert.equal(result.dependencies[0].ecosystem,'python');assert.equal(result.dependencies[0].state,'unknown');
});
test('treats linked package metadata and secret-bearing declarations as unknown or redacted',async()=>{
 const outside=await fixture('outside',{'package.json':JSON.stringify({version:'9.9.9'})});
 const dir=await fixture('escape',{'package.json':JSON.stringify({dependencies:{safe:'******private/source'}})});
 await fs.mkdir(path.join(dir,'node_modules'),{recursive:true});await fs.symlink(outside,path.join(dir,'node_modules','safe'),'junction');
 const result=await captureEnvironment(dir,options);const dependency=result.dependencies[0];assert.equal(dependency.required,'redacted');assert.equal(dependency.installed,'unknown');assert(!JSON.stringify(result).includes('private/source'));
});
test('shared evidence rejects credentials and private keys before persistence',()=>{
 const base={title:'safe',capturedAt:new Date().toISOString(),system:{platform:'win32',release:'10.0',arch:'x64'},runtime:{node:'22.0.0'},tools:[],dependencies:[],locks:[],config:{},ports:[],limitations:[]};
 for(const title of ['Authorization: Bearer abc','-----BEGIN PRIVATE KEY-----','api_key=abc','session=abc'])assert.throws(()=>environmentFields({...base,title}));
});
