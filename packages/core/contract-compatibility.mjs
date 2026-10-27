import {schemaAlternatives,disjoint,effectiveSecurity,securityAccepts,responseFor} from './openapi-contract.mjs';
import {normalizeContractDocument as validateContractDocument} from './contracts.mjs';
const has=(value,key)=>Object.hasOwn(value,key);
export function compareContracts(expectedInput,actualInput){
 const expected=validateContractDocument(expectedInput),actual=validateContractDocument(actualInput),issues=[];let truncated=false;
 const add=(severity,endpoint,field,expected,actual,guidance)=>{if(issues.length>=300){truncated=true;return;}issues.push({severity,endpoint,field,expected,actual,guidance});};
 let comparisons=0;
 function subset(producer,consumer,endpoint,field,direction){
  if(++comparisons>4000){add('review',endpoint,field,'bounded comparison','analysis limit reached','Split this contract into smaller documents.');return;}
  if(['allOf','anyOf','oneOf'].some(k=>producer[k]||consumer[k])){
   let ps,cs;try{ps=schemaAlternatives(producer);cs=schemaAlternatives(consumer);}catch(error){add('review',endpoint,field,producer,consumer,error.message);return;}
   for(const p of ps){let matched=false;const failures=[];for(const c of cs){const start=issues.length;subset(p,c,endpoint,field,direction);const found=issues.splice(start);if(!found.length){matched=true;break;}failures.push(found);}
    if(!matched){if(cs.length===1){for(const issue of failures[0])add(issue.severity,issue.endpoint,issue.field,issue.expected,issue.actual,issue.guidance);}else add(cs.every(c=>disjoint(p,c))?'breaking':'review',endpoint,field,direction==='request'?p:cs,direction==='request'?cs:p,'No single alternative proves coverage. Align alternatives; overlapping unions may need manual analysis.');}
   }return;
  }
  const report=(severity,p,c,guide)=>add(severity,endpoint,field,direction==='request'?p:c,direction==='request'?c:p,guide);
  if(producer.enum?.every(value=>value===null)){if(consumer.nullable!==true||(consumer.enum&&!consumer.enum.includes(null)))report('breaking','null-only','null excluded','Align nullable/enum constraints.');return;}
  if(producer.type!==consumer.type&&!(producer.type==='integer'&&consumer.type==='number')){report('breaking',producer.type,consumer.type,'Agree on a field type or add an explicit adapter before integration.');return;}
  if(producer.nullable===true&&(!producer.enum||producer.enum.includes(null))&&consumer.nullable!==true)report('breaking','nullable','non-null','Align null handling or make the producer guarantee a non-null value.');
  if(consumer.enum&&(!producer.enum||producer.enum.some(v=>!consumer.enum.some(c=>JSON.stringify(c)===JSON.stringify(v)))))report('breaking',producer.enum??'unrestricted values',consumer.enum,'Coordinate enum additions/removals and accepted values.');
  const enumValues=producer.enum?.filter(v=>v!==null);
  for(const [min,max] of [['minimum','maximum'],['minLength','maxLength'],['minItems','maxItems']]){
   const measures=enumValues?.length?enumValues.map(value=>min==='minimum'?Number(value):min==='minLength'&&typeof value==='string'?[...value].length:NaN):undefined;
   const finite=measures?.every(Number.isFinite),lower=finite?Math.min(...measures):producer[min],upper=finite?Math.max(...measures):producer[max];
   if(consumer[min]!==undefined&&(lower===undefined||lower<consumer[min]))report('breaking',`${min}: ${producer[min]??'unbounded'}`,`${min}: ${consumer[min]}`,'Align allowed ranges or validate/transform values before sending.');
   if(consumer[max]!==undefined&&(upper===undefined||upper>consumer[max]))report('breaking',`${max}: ${producer[max]??'unbounded'}`,`${max}: ${consumer[max]}`,'Align allowed ranges or validate/transform values before sending.');
  }
  if(producer.format!==consumer.format)report([producer.format,consumer.format].some(f=>['binary','byte'].includes(f))?'breaking':'review',producer.format??'no format',consumer.format??'no format','Review format handling; format differences are not proven compatible by this comparator.');
  if(producer.type==='array')subset(producer.items,consumer.items,endpoint,field+'[]',direction);
  if(producer.type==='object'){
   const pp=producer.properties??{},cp=consumer.properties??{},pr=producer.required??[],cr=consumer.required??[];
   for(const name of cr)if(!pr.includes(name))add('breaking',endpoint,`${field}.${name}`,direction==='request'?'optional or absent':'required response field',direction==='request'?'required':'optional or absent','Restore the required field guarantee or revise the consumer.');
   for(const [name,schema] of Object.entries(pp)){
    if(has(cp,name))subset(schema,cp[name],endpoint,`${field}.${name}`,direction);
    else if(consumer.additionalProperties===false)add('breaking',endpoint,`${field}.${name}`,direction==='request'?'declared field':'undeclared fields forbidden',direction==='request'?'undeclared fields forbidden':'declared field','Restore the field declaration or agree on removal before integration.');
    else if(direction==='request')add('review',endpoint,`${field}.${name}`,'declared input','not explicitly implemented; additional properties allowed','Confirm the backend uses this field rather than silently ignoring it.');
   }
   for(const name of Object.keys(cp))if(!has(pp,name)&&!cr.includes(name)&&direction==='response')add('review',endpoint,`${field}.${name}`,'optional response field','field no longer declared','Review consumers of this removed optional field.');
   if(producer.additionalProperties!==false&&consumer.additionalProperties===false)report('breaking','additional fields allowed','additional fields forbidden','Align additionalProperties policies; undeclared fields may be rejected.');
   else if(producer.additionalProperties!==false)for(const name of Object.keys(cp))if(!has(pp,name))add('review',endpoint,`${field}.${name}`,direction==='request'?'unconstrained extra field':'typed response field',direction==='request'?'typed input field':'unconstrained extra field','An undeclared extra field has no proven type guarantee. Declare it explicitly.');
   if(direction==='response')for(const name of Object.keys(cp))if(!has(pp,name))add(cr.includes(name)?'breaking':'review',endpoint,`${field}.${name}`,cr.includes(name)?'required response field':'optional response field','removed from response','Restore the response field or revise the frontend expectation.');
  }
 }
 function compareMedia(producer,consumer,endpoint,field,direction){
  const pc=producer.content??{},cc=consumer.content??{};
  if(direction==='response'&&Object.keys(cc).length&&!Object.keys(pc).length){add('breaking',endpoint,field+'.body','declared response body','no declared body','Restore the response body guarantee.');return;}
  for(const [media,entry] of Object.entries(pc)){
   const accepted=cc[media];if(!accepted){add(direction==='response'&&!Object.keys(cc).length?'review':'breaking',endpoint,field+'.contentType',direction==='request'?media:Object.keys(cc),direction==='request'?Object.keys(cc):media,'Align supported request/response media types.');continue;}
   subset(entry.schema,accepted.schema,endpoint,field,direction);
   if(media==='multipart/form-data'){
    const defaultType=s=>s?.type==='array'?defaultType(s.items):s?.type==='object'?'application/json':s?.type==='string'&&s.format==='binary'?'application/octet-stream':'text/plain';
    for(const name of Object.keys(entry.schema.properties??{})){if(!has(accepted.schema.properties??{},name))continue;const pe=entry.encoding?.[name]??{},ce=accepted.encoding?.[name]??{};const pt=(pe.contentType??defaultType(entry.schema.properties[name])).split(',').map(v=>v.trim()),ct=(ce.contentType??defaultType(accepted.schema.properties[name])).split(',').map(v=>v.trim());if(pt.some(p=>!ct.some(c=>c===p||c.endsWith('/*')&&p.startsWith(c.slice(0,-1)))))add('breaking',endpoint,`${field}.${name}.contentType`,pt,ct,'Align multipart part content types.');if((pe.style??'form')!==(ce.style??'form')||(pe.explode??((pe.style??'form')==='form'))!==(ce.explode??((ce.style??'form')==='form'))||(pe.allowReserved??false)!==(ce.allowReserved??false))add('breaking',endpoint,`${field}.${name}.encoding`,pe,ce,'Align multipart field serialization.');}
   }
  }
 }
 function endpoints(doc){const result=new Map();for(const [route,item] of Object.entries(doc.paths))for(const method of ['get','post','put','patch','delete','head','options'])if(item[method])result.set(method.toUpperCase()+' '+route.replace(/\{[^}]+\}/g,'{}'),{route,method,op:item[method],common:item.parameters??[]});return result;}
 function params(endpoint){const templates=[...endpoint.route.matchAll(/\{([^}]+)\}/g)].map(m=>m[1]),result=new Map();for(const p of [...endpoint.common,...(endpoint.op.parameters??[])])result.set(p.in+':'+(p.in==='path'?templates.indexOf(p.name):p.name),p);return result;}
 const a=endpoints(actual),e=endpoints(expected);
 for(const [key,wanted] of e){const got=a.get(key),label=wanted.method.toUpperCase()+' '+wanted.route;
  if(!got){add('breaking',label,'endpoint','endpoint present','missing endpoint/method','Implement the endpoint or revise the frontend expectation.');continue;}
  if(wanted.route!==got.route)add('review',label,'path template',wanted.route,got.route,'Wire paths match, but align template parameter names used by generated clients.');
  const ep=params(wanted),ap=params(got);
  for(const [name,p] of ap){const source=ep.get(name);if(p.required&&!source?.required)add('breaking',label,name,source?'optional':'absent','required','Supply this parameter/header or make the backend requirement optional.');if(source)subset(source.schema,p.schema,label,name,'request');}
  for(const [name,p] of ep)if(!ap.has(name))add(p.required?'breaking':'review',label,name,p.required?'required parameter':'optional parameter','not declared by backend',p.required?'Restore the required parameter/header or revise the frontend expectation.':'Confirm parameter/header support; its absence from a schema does not prove runtime rejection.');
  const eb=wanted.op.requestBody,ab=got.op.requestBody;
  if(ab?.required&&!eb?.required)add('breaking',label,'request body',eb?'optional':'absent','required','Align request body requirements.');
  if(eb&&!ab)add('breaking',label,'request body','declared body','no declared body','Implement the request body or revise the consumer.');
  if(eb&&ab)compareMedia(eb,ab,label,'request','request');
  const wantedSecurity=effectiveSecurity(expected,wanted.op),actualSecurity=effectiveSecurity(actual,got.op);
  for(const option of wantedSecurity)if(!actualSecurity.some(requirement=>securityAccepts(option,requirement,expected,actual)))add('breaking',label,'security',option,actualSecurity,'The expected credential option no longer satisfies backend authentication/scopes. Coordinate credentials before integration.');
  if(actualSecurity.some(option=>!wantedSecurity.some(requirement=>securityAccepts(option,requirement,actual,expected))))add('review',label,'security',wantedSecurity,actualSecurity,'Backend accepts an additional or weaker authentication alternative. Review intended access policy; declarations do not verify enforcement.');
  const pairs=new Map();
  for(let status=100;status<=599;status++){const er=responseFor(wanted.op.responses,status),ar=responseFor(got.op.responses,status);const pair=`${er?.key??'-'}:${ar?.key??'-'}`;if(!pairs.has(pair))pairs.set(pair,{er,ar,statuses:[]});pairs.get(pair).statuses.push(status);}
  for(const {er,ar,statuses} of pairs.values()){
   if(!er&&!ar)continue;const code=ar?.key??er.key,where=`response ${code}`,coverage=statuses.length>1?`${statuses[0]}–${statuses.at(-1)} (${statuses.length} statuses)`:`${statuses[0]}`;
   if(!er){add('breaking',label,where,'status not declared',`new status ${coverage}`,'Add handling for this response or change backend status coverage.');continue;}
   if(!ar){add('breaking',label,where,'declared status',`status removed: ${coverage}`,'Restore response coverage or coordinate frontend handling.');continue;}
   const response=ar.value,expectedResponse=er.value;
   compareMedia(response,expectedResponse,label,where,'response');
   for(const [name,header] of Object.entries(expectedResponse.headers??{})){const gotHeader=has(response.headers??{},name)?response.headers[name]:undefined;if(header.required&&!gotHeader?.required)add('breaking',label,`${where}.header.${name}`,'required',gotHeader?'optional':'removed','Guarantee the response header or remove the frontend dependency.');if(gotHeader)subset(gotHeader.schema,header.schema,label,`${where}.header.${name}`,'response');else if(!header.required)add('review',label,`${where}.header.${name}`,'optional header','not declared','Review removed response-header usage.');}
  }
 }
 for(const [key,endpoint] of a)if(!e.has(key))add('info',endpoint.method.toUpperCase()+' '+endpoint.route,'endpoint','not requested','additional endpoint','No existing consumer endpoint is removed.');
 return{status:issues.some(i=>i.severity==='breaking')?'incompatible':truncated||issues.some(i=>i.severity==='review')?'review-required':'compatible-within-supported-subset',issues,truncated,notice:'Static schema comparison only. No server requests, generated code, or runtime validation were executed.'};
}
