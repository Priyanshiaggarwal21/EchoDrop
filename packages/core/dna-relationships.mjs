import {intentId} from './intentions.mjs';
import {validDnaEvent} from './project-dna.mjs';
export const DNA_RELATIONS={
 'revision-of':'Revises the preceding content version',
 'reviews-version':'Reviews this exact contract version',
 'resolves-version':'Records resolution for this snapshot version',
 'retests-version':'Requests retest of this snapshot version',
 'record-history':'Another observation of the same source record',
 'pulse-source':'Pulse explicitly references this source record (version unspecified)',
 'participant-match':'Recorded actor matches this membership identity',
 'transfer-recipient':'Transfer explicitly names this recipient identity',
 'project-scope':'Belongs to this registered project',
 'shared-intention':'Declarations explicitly reference the same work intention'
};
export function dnaRelationships(events,sources){
 const groups=new Map(),links=new Map();for(const e of events){const key=e.type+':'+e.sourceId;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(e);}
 const group=(type,id)=>groups.get(type+':'+id)??[],anchor=(type,id)=>group(type,id)[0];
 const add=(kind,from,to,sourceId)=>{if(!from||!to||from.id===to.id||!intentId(sourceId))return;if(from.projectId!==to.projectId||from.contextId!==to.contextId)throw Error('Cross-scope DNA relationship rejected.');const key=[kind,from.id,to.id,sourceId].join(':');links.set(key,{kind,from:from.id,to:to.id,sourceId,provenance:'authoritative-reference'});};
 for(const list of groups.values())for(const [i,e] of list.entries()){
  if(['contract','environment'].includes(e.type)){
   const content=v=>list.find(x=>x.sourceVersion==='content:'+v);
   if(e.sourceVersion.startsWith('content:'))add('revision-of',e,content(e.facts.contentVersion-1),e.sourceId);
   else add(e.type==='contract'?'reviews-version':e.facts.action==='resolve'?'resolves-version':'retests-version',e,content(e.facts.contentVersion),e.sourceId);
  }else if(i)add('record-history',e,list[i-1],e.sourceId);
  if(e.actorId)add('participant-match',e,anchor('membership',e.actorId),e.actorId);
  if(e.type!=='project'&&sources.project)add('project-scope',e,anchor('project',sources.project.id),sources.project.id);
 }
 for(const p of sources.pulse??[]){const type={contract:'contract',environment:'environment',content:'transfer',guardian:'continuity'}[p.source];if(!type)continue;for(const ref of p.refs??[])add('pulse-source',anchor('decision',p.id),anchor(type,ref),p.id);}
 for(const t of sources.transfers??[])add('transfer-recipient',anchor('transfer',t.id),anchor('membership',t.recipientId),t.id);
 const intentions=new Map();for(const c of sources.contracts??[])for(const h of c.history){const id=h.fields?.intentionId,e=group('contract',c.id).find(e=>e.sourceVersion==='content:'+h.contentVersion);if(!intentId(id)||!e)continue;if(!intentions.has(id))intentions.set(id,[]);intentions.get(id).push(e);}
 for(const [id,list] of intentions){list.sort((a,b)=>a.sequence-b.sequence);for(const e of list.slice(1))if(e.sourceId!==list[0].sourceId)add('shared-intention',e,list[0],id);}
 return [...links.values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
export function validDnaRelationship(r,events){if(!r||Object.keys(r).some(k=>!['id','schemaVersion','sequence','kind','from','to','sourceId','provenance','observedAt'].includes(k))||r.schemaVersion!==1||!intentId(r.id)||!Number.isSafeInteger(r.sequence)||r.sequence<1||!Object.hasOwn(DNA_RELATIONS,r.kind)||!intentId(r.from)||!intentId(r.to)||r.from===r.to||!intentId(r.sourceId)||r.provenance!=='authoritative-reference'||typeof r.observedAt!=='string'||!Number.isFinite(Date.parse(r.observedAt)))throw Error('Invalid DNA relationship.');const from=events.get(r.from),to=events.get(r.to);if(!from||!to||from.projectId!==to.projectId||from.contextId!==to.contextId)throw Error('DNA relationship endpoints unavailable or cross-scope.');
 const same=from.type===to.type&&from.sourceId===to.sourceId;
 const valid={
 'revision-of':same&&['contract','environment'].includes(from.type)&&from.sourceVersion==='content:'+from.facts.contentVersion&&to.sourceVersion==='content:'+(from.facts.contentVersion-1)&&r.sourceId===from.sourceId,
 'reviews-version':same&&from.type==='contract'&&from.sourceVersion.startsWith('review:')&&to.sourceVersion==='content:'+from.facts.contentVersion&&r.sourceId===from.sourceId,
 'resolves-version':same&&from.type==='environment'&&from.facts.action==='resolve'&&to.sourceVersion==='content:'+from.facts.contentVersion&&r.sourceId===from.sourceId,
 'retests-version':same&&from.type==='environment'&&from.facts.action==='retest'&&to.sourceVersion==='content:'+from.facts.contentVersion&&r.sourceId===from.sourceId,
 'record-history':same&&from.sequence>to.sequence&&r.sourceId===from.sourceId,
 'pulse-source':from.type==='decision'&&['contract','environment','transfer','continuity'].includes(to.type)&&r.sourceId===from.sourceId,
 'participant-match':to.type==='membership'&&from.actorId===to.sourceId&&r.sourceId===to.sourceId,
 'transfer-recipient':from.type==='transfer'&&to.type==='membership'&&r.sourceId===from.sourceId,
 'project-scope':to.type==='project'&&to.sourceId===from.projectId&&r.sourceId===to.sourceId,
 'shared-intention':from.type==='contract'&&to.type==='contract'&&from.sourceId!==to.sourceId
 };if(!valid[r.kind])throw Error('Relationship provenance does not match its endpoints.');return r;}
export function dnaChanges(event,previous){if(!previous||previous.type!==event.type||previous.sourceId!==event.sourceId)return [];return [...new Set([...Object.keys(previous.facts),...Object.keys(event.facts)])].sort().filter(k=>previous.facts[k]!==event.facts[k]).map(field=>({field,before:previous.facts[field]??null,after:event.facts[field]??null}));}
export function validateDnaDetail(value,scope,id){
 if(!value||value.version!==1||!Array.isArray(value.related)||value.related.length>50||!Number.isSafeInteger(value.next)||value.next<0||typeof value.more!=='boolean'||typeof value.saturated!=='boolean')throw Error('Invalid DNA detail.');const event=validDnaEvent(value.event);if(event.id!==id||event.projectId!==scope.projectId||event.contextId!==scope.contextId)throw Error('DNA detail scope mismatch.');
 let last=0;const related=value.related.map(entry=>{const other=validDnaEvent(entry.event);if(other.projectId!==scope.projectId||other.contextId!==scope.contextId)throw Error('DNA related scope mismatch.');const relation=validDnaRelationship(entry.relation,new Map([[event.id,event],[other.id,other]]));if(![relation.from,relation.to].includes(id)||relation.sequence<=last||relation.sequence>value.next)throw Error('Unrelated or unordered DNA link.');last=relation.sequence;return{event:other,relation};});
 let previous;if(value.previous){previous=validDnaEvent(value.previous);if(previous.projectId!==scope.projectId||previous.contextId!==scope.contextId||previous.type!==event.type||previous.sourceId!==event.sourceId||(event.sourceVersion.startsWith('content:')?previous.sourceVersion!=='content:'+(event.facts.contentVersion-1):previous.sequence>=event.sequence))throw Error('Invalid previous source observation.');}
 const counts=value.contractChanges;if(counts!==undefined&&(!counts||Object.keys(counts).some(k=>!['breaking','review','info'].includes(k))||['breaking','review','info'].some(k=>!Number.isInteger(counts[k])||counts[k]<0||counts[k]>300)))throw Error('Invalid contract change counts.');
 return{captureIncomplete:value.captureIncomplete===true,version:1,event,related,next:value.next,more:value.more,saturated:value.saturated,...(previous?{previous}:{}),changes:dnaChanges(event,previous),...(counts?{contractChanges:counts}:{})};
}
