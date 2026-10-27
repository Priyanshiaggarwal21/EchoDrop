import {guardianSourceRevision} from './guardian-authority.mjs';
import {dnaRelationships,validDnaRelationship,dnaChanges} from '../../packages/core/dna-relationships.mjs';
import {compareContracts} from '../../packages/core/contract-compatibility.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {intentId} from '../../packages/core/intentions.mjs';
import {DNA_TYPES,dnaCandidates,validDnaEvent} from '../../packages/core/project-dna.mjs';
import {regularFile,writeAtomic} from './secure-content-store.mjs';
const eventId=(p,c,e)=>{const h=createHash('sha256').update(JSON.stringify([p,c??null,e.type,e.sourceId,e.sourceVersion])).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-8'+h.slice(17,20)+'-'+h.slice(20,32);};
const linkId=(r)=>eventId(r.from,r.to,{type:r.kind,sourceId:r.sourceId,sourceVersion:'relationship-v1'});
export function createDnaStore(file,collaboration,{protection,collect,now=Date.now,capacity=1000}){
 if(!Number.isInteger(capacity)||capacity<1||capacity>1000)throw Error('Invalid DNA capacity.');let lock=Promise.resolve();const serial=fn=>{const p=lock.then(fn);lock=p.catch(()=>{});return p;};
 async function load(){try{if((await regularFile(file)).size>16*1024*1024)throw Error();const envelope=JSON.parse(await fs.readFile(file,'utf8')),d=JSON.parse(protection.open(envelope.sealed));if(envelope.version!==1||d.version!==1||!intentId(d.epoch)||!Array.isArray(d.scopes)||d.scopes.length>100)throw Error();const scopes=new Set();for(const s of d.scopes){const key=s.projectId+':'+(s.contextId??'');if(!intentId(s.projectId)||(s.contextId!==undefined&&!intentId(s.contextId))||scopes.has(key)||!Array.isArray(s.events)||s.events.length>1000||!Number.isSafeInteger(s.sequence)||s.sequence!==s.events.length)throw Error();scopes.add(key);const ids=new Set();for(const [i,e] of s.events.entries()){validDnaEvent(e);if(ids.has(e.id)||e.id!==eventId(s.projectId,s.contextId,e)||e.sequence!==i+1||e.projectId!==s.projectId||e.contextId!==s.contextId)throw Error();ids.add(e.id);}if(s.relationships!==undefined){if(!Array.isArray(s.relationships)||s.relationships.length>5000)throw Error();const byId=new Map(s.events.map(e=>[e.id,e])),links=new Set();for(const [i,r] of s.relationships.entries()){validDnaRelationship(r,byId);if(r.sequence!==i+1||r.id!==linkId(r)||links.has(r.id))throw Error();links.add(r.id);}}}return d;}catch(e){if(e.code==='ENOENT')return{version:1,epoch:randomUUID(),scopes:[]};throw Error('DNA index is corrupt or unavailable. Existing history preserved; restore the protected index before refresh.');}}
 async function save(d){const text=JSON.stringify(d);if(Buffer.byteLength(text)>8*1024*1024)throw Error('DNA storage capacity reached; existing history preserved.');await fs.mkdir(path.dirname(file),{recursive:true});if((await fs.lstat(path.dirname(file))).isSymbolicLink())throw Error('Unsafe DNA storage.');await writeAtomic(file,{version:1,sealed:protection.seal(text)});}
 return{handle:(fp,q)=>serial(async()=>{
  if(!q||q.version!==1||!['dna-read','dna-detail'].includes(q.action)||!intentId(q.projectId)||(q.contextId!==undefined&&!intentId(q.contextId))||Object.keys(q).some(k=>!['version','action','projectId','contextId','since','limit','type','epoch','id'].includes(k))||!Number.isSafeInteger(q.since)||q.since<0||(q.limit!==undefined&&(!Number.isInteger(q.limit)||q.limit<1||q.limit>50))||(q.type!==undefined&&!DNA_TYPES.includes(q.type))||(q.epoch!==undefined&&!intentId(q.epoch)))throw Error('Invalid DNA request.');if(q.action==='dna-detail'?!intentId(q.id):q.id!==undefined)throw Error('Invalid DNA event selection.');
  const revision=a=>JSON.stringify([guardianSourceRevision(a),a.principalId,a.identityBinding]);
  const initial=await collaboration.withGuardianAuthority(fp,q.projectId,q.contextId,revision);
  // Read-only clients may refresh a derived index, but cannot submit or invent events.
  const sources=await collect(fp,q),observedAt=new Date(now()).toISOString(),{events,visible}=dnaCandidates(sources,observedAt);
  return collaboration.withGuardianAuthority(fp,q.projectId,q.contextId,async authority=>{
   if(revision(authority)!==initial)throw Error('DNA authority or project source changed during collection. Refresh before reading history.');
   const d=await load();let created=false;let scope=d.scopes.find(s=>s.projectId===q.projectId&&s.contextId===q.contextId);if(!scope){if(d.scopes.length>=100)throw Error('DNA scope capacity reached.');scope={projectId:q.projectId,...(q.contextId?{contextId:q.contextId}:{}),sequence:0,events:[]};d.scopes.push(scope);created=true;}
   const ids=new Set(scope.events.map(e=>e.id));let changed=false,saturated=false;
   const candidates=events.map(e=>({...e,id:eventId(q.projectId,q.contextId,e)})).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.id.localeCompare(b.id));
   for(const candidate of candidates){if(ids.has(candidate.id))continue;if(scope.events.length>=capacity){saturated=true;continue;}const e=validDnaEvent({...candidate,schemaVersion:1,projectId:q.projectId,...(q.contextId?{contextId:q.contextId}:{}),observedAt,sequence:++scope.sequence});scope.events.push(e);ids.add(e.id);changed=true;}
   scope.relationships??=[];const knownLinks=new Set(scope.relationships.map(r=>r.id)),byId=new Map(scope.events.map(e=>[e.id,e]));
   // Only relate currently authorized endpoints; historical links are retained but filtered on every read.
   const current=scope.events.filter(e=>visible.has(e.type+':'+e.sourceId));
   for(const candidate of dnaRelationships(current,sources)){const id=linkId(candidate);if(knownLinks.has(id))continue;if(scope.relationships.length>=5000){saturated=true;continue;}const r=validDnaRelationship({...candidate,id,schemaVersion:1,sequence:scope.relationships.length+1,observedAt},byId);scope.relationships.push(r);knownLinks.add(id);changed=true;}
   if(changed||created)await save(d);
   if(q.action==='dna-detail'){
    const event=current.find(e=>e.id===q.id);if(!event)throw Error('DNA event or source is not currently accessible.');
    const readable=new Set(current.map(e=>e.id)),links=scope.relationships.filter(r=>r.sequence>q.since&&(r.from===event.id||r.to===event.id)&&readable.has(r.from)&&readable.has(r.to)),page=links.slice(0,q.limit??25),more=links.length>page.length;
    const previous=event.sourceVersion.startsWith('content:')?current.find(e=>e.type===event.type&&e.sourceId===event.sourceId&&e.sourceVersion==='content:'+(event.facts.contentVersion-1)):current.filter(e=>e.type===event.type&&e.sourceId===event.sourceId&&e.sequence<event.sequence).at(-1);
    let contractChanges;if(event.type==='contract'&&event.sourceVersion.startsWith('content:')){const source=sources.contracts?.find(c=>c.id===event.sourceId),a=source?.history.find(h=>h.contentVersion===event.facts.contentVersion-1),b=source?.history.find(h=>h.contentVersion===event.facts.contentVersion);if(a&&b){const comparison=compareContracts(a.fields.document,b.fields.document);contractChanges={breaking:0,review:0,info:0};for(const i of comparison.issues)contractChanges[i.severity]++;}}
    return{version:1,event,related:page.map(relation=>({relation,event:byId.get(relation.from===event.id?relation.to:relation.from)})),next:more?page.at(-1).sequence:scope.relationships.length,more,saturated,...(previous?{previous}:{}),changes:dnaChanges(event,previous),...(contractChanges?{contractChanges}:{})};
   }
   const since=q.epoch&&q.epoch!==d.epoch?0:q.since;if(since>scope.sequence)throw Error('DNA cursor is ahead of history; refresh from the beginning.');
   const accessible=scope.events.filter(e=>e.sequence>since&&visible.has(e.type+':'+e.sourceId)&&(!q.type||q.type===e.type)),page=accessible.slice(0,q.limit??25),more=accessible.length>page.length;
   return{version:1,epoch:d.epoch,events:page,next:more?page.at(-1).sequence:scope.sequence,watermark:scope.sequence,more,saturated};
  });
 })};
}
