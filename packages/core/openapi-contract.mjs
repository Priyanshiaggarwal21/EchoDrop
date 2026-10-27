// Bounded, local-only OpenAPI helpers. No network access or executable schemas.
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export function resolveLocalReferences(input){
 let nodes=0;
 function walk(value,stack=[],depth=0){
  if(++nodes>4000||depth>24)throw Error('Reference traversal complexity limit exceeded (4,000 nodes / depth 24).');
  if(!value||typeof value!=='object')return value;
  if(object(value)&&Object.hasOwn(value,'$ref')){
   if(Object.keys(value).length!==1)throw Error('Reference siblings are unsupported in OpenAPI 3.0.3; move constraints into allOf.');
   const ref=value.$ref;if(typeof ref!=='string'||!ref.startsWith('#/'))throw Error('Only local JSON Pointer $ref values are allowed; external references are never fetched.');
   let pointer;try{pointer=decodeURIComponent(ref.slice(1));}catch{throw Error('Malformed reference encoding.');}
   if(stack.includes(pointer))throw Error(`Cyclic reference: ${[...stack,pointer].join(' Ã¢â€ â€™ ')}`);
   let target=input;for(const token of pointer.slice(1).split('/')){if(/~(?:[^01]|$)/.test(token))throw Error('Malformed JSON Pointer escape.');const key=token.replaceAll('~1','/').replaceAll('~0','~');if(!target||typeof target!=='object'||!Object.hasOwn(target,key))throw Error(`Unresolved reference: ${ref}`);target=target[key];}
   if(!object(target))throw Error(`Reference must resolve to an object: ${ref}`);
   return walk(target,[...stack,pointer],depth+1);
  }
  if(Array.isArray(value))return value.map(v=>walk(v,stack,depth+1));
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,walk(v,stack,depth+1)]));
 }
 const result=walk(input);if(new TextEncoder().encode(JSON.stringify(result)).length>32768)throw Error('Expanded contract exceeds 32 KiB; reduce reference fan-out.');return result;
}
export function canonical(value){if(Array.isArray(value))return value.map(canonical);if(object(value))return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
export function validateSecurity(doc){
 const schemes=doc.components?.securitySchemes??{};
 const fields=(v,allowed,label)=>{if(!object(v)||Object.keys(v).some(k=>!allowed.includes(k)))throw Error(`${label}: unsupported fields.`);};
 const str=v=>typeof v==='string'&&v.length>0&&v.length<=1000;
 const url=v=>{try{const u=new URL(v);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}};
 for(const [name,s] of Object.entries(schemes)){
  if(!/^[A-Za-z0-9._-]{1,100}$/.test(name))throw Error('Invalid security scheme name.');
  const common=['type','description'];if(s.description!==undefined&&!str(s.description))throw Error('Invalid security description.');
  if(s.type==='apiKey'){fields(s,[...common,'name','in'],'API key');if(!str(s.name)||!['query','header','cookie'].includes(s.in))throw Error('Invalid API key scheme.');if(s.in==='header')s.name=s.name.toLowerCase();}
  else if(s.type==='http'){fields(s,[...common,'scheme','bearerFormat'],'HTTP security');if(!str(s.scheme)||!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(s.scheme)||(s.bearerFormat!==undefined&&!str(s.bearerFormat)))throw Error('Invalid HTTP security scheme.');s.scheme=s.scheme.toLowerCase();if(s.bearerFormat!==undefined&&s.scheme!=='bearer')throw Error('bearerFormat requires bearer security.');}
  else if(s.type==='openIdConnect'){fields(s,[...common,'openIdConnectUrl'],'OpenID');if(!url(s.openIdConnectUrl))throw Error('Invalid OpenID URL.');}
  else if(s.type==='oauth2'){
   fields(s,[...common,'flows'],'OAuth2');fields(s.flows,['implicit','password','clientCredentials','authorizationCode'],'OAuth flows');if(!Object.keys(s.flows).length)throw Error('OAuth2 requires a flow.');
   for(const [kind,flow] of Object.entries(s.flows)){const auth=['implicit','authorizationCode'].includes(kind),token=kind!=='implicit';fields(flow,[...(auth?['authorizationUrl']:[]),...(token?['tokenUrl']:[]),'refreshUrl','scopes'],'OAuth flow');if((auth&&!url(flow.authorizationUrl))||(token&&!url(flow.tokenUrl))||(flow.refreshUrl!==undefined&&!url(flow.refreshUrl))||!object(flow.scopes)||Object.keys(flow.scopes).length>50||Object.entries(flow.scopes).some(([k,v])=>!str(k)||typeof v!=='string'||v.length>1000))throw Error('Invalid OAuth flow/scopes.');}
  }else throw Error('Unsupported OpenAPI 3.0.3 security scheme type.');
 }
 function requirements(list){if(list===undefined)return;if(!Array.isArray(list)||list.length>20)throw Error('Invalid security alternatives.');for(const r of list){if(!object(r)||Object.keys(r).length>20)throw Error('Invalid security requirement.');for(const [name,scopes] of Object.entries(r)){if(!Object.hasOwn(schemes,name)||!Array.isArray(scopes)||scopes.length>50||new Set(scopes).size!==scopes.length||scopes.some(v=>!str(v)))throw Error('Unknown security scheme or invalid scopes.');const scheme=schemes[name];if(!['oauth2','openIdConnect'].includes(scheme.type)&&scopes.length)throw Error('Only OAuth2/OpenID requirements may contain scopes.');if(scheme.type==='oauth2'&&scopes.some(scope=>!Object.values(scheme.flows).some(f=>Object.hasOwn(f.scopes,scope))))throw Error('Undeclared OAuth scope.');}}}
 requirements(doc.security);for(const item of Object.values(doc.paths??{}))for(const method of ['get','post','put','patch','delete','head','options'])if(item[method])requirements(item[method].security);
}

const primitives=['type','nullable','format','enum','minimum','maximum','minLength','maxLength','minItems','maxItems','properties','required','additionalProperties','items'];
export function disjoint(a,b){
 if(a.nullable&&b.nullable)return false;
 if(a.type!==b.type&&!['integer:number','number:integer'].includes(`${a.type}:${b.type}`))return true;
 if(a.enum&&b.enum)return !a.enum.some(v=>b.enum.includes(v));
 if(a.type==='object'&&b.type==='object')return (a.required??[]).some(k=>(b.required??[]).includes(k)&&a.properties?.[k]?.enum&&b.properties?.[k]?.enum&&!a.properties[k].enum.some(v=>b.properties[k].enum.includes(v)));
 if(['integer','number'].includes(a.type))return (a.maximum!==undefined&&b.minimum!==undefined&&a.maximum<b.minimum)||(b.maximum!==undefined&&a.minimum!==undefined&&b.maximum<a.minimum);
 return false;
}
function intersect(a,b){
 if(!a)return b;if(!b)return a;
 if(disjoint(a,b))throw Error('Unsatisfiable or disjoint allOf constraints; revise the contract.');
 const result={...a};if(a.type!==b.type){if(['integer:number','number:integer'].includes(`${a.type}:${b.type}`))result.type='integer';else throw Error('Ambiguous allOf types.');}
 result.nullable=a.nullable===true&&b.nullable===true;
 if(a.format&&b.format&&a.format!==b.format)throw Error('Ambiguous allOf formats.');result.format=a.format??b.format;if(result.format===undefined)delete result.format;
 if(a.enum||b.enum){result.enum=(a.enum??b.enum).filter(v=>(!b.enum||b.enum.includes(v))&&(!a.enum||a.enum.includes(v))&&(v!==null||result.nullable));if(!result.enum.length)throw Error('Unsatisfiable allOf enum.');}
 for(const [min,max] of [['minimum','maximum'],['minLength','maxLength'],['minItems','maxItems']]){if(a[min]!==undefined||b[min]!==undefined)result[min]=Math.max(a[min]??-Infinity,b[min]??-Infinity);if(a[max]!==undefined||b[max]!==undefined)result[max]=Math.min(a[max]??Infinity,b[max]??Infinity);if(result[min]>result[max])throw Error('Unsatisfiable allOf bounds.');}
 if(result.type==='array')result.items={allOf:[a.items,b.items]};
 if(result.type==='object'){
  const ap=a.properties??{},bp=b.properties??{};
  if((a.additionalProperties===false&&Object.keys(bp).some(k=>!Object.hasOwn(ap,k)))||(b.additionalProperties===false&&Object.keys(ap).some(k=>!Object.hasOwn(bp,k))))throw Error('Closed allOf object branches cannot be flattened safely; align declared fields.');
  result.properties=Object.fromEntries([...new Set([...Object.keys(ap),...Object.keys(bp)])].sort().map(k=>[k,ap[k]&&bp[k]?{allOf:[ap[k],bp[k]]}:ap[k]??bp[k]]));result.required=[...new Set([...(a.required??[]),...(b.required??[])])].sort();result.additionalProperties=a.additionalProperties!==false&&b.additionalProperties!==false;
 }
 return result;
}
// Finite alternatives only; overlapping oneOf is never incorrectly treated as anyOf.
export function schemaAlternatives(schema){
 let visits=0;
 function visit(s,depth=0){if(++visits>500||depth>16)throw Error('Composition analysis budget exceeded.');let variants=s.type?[Object.fromEntries(primitives.filter(k=>s[k]!==undefined).map(k=>[k,s[k]]))]:[null];
  for(const key of ['allOf','anyOf','oneOf'])if(s[key]){
   const groups=s[key].map(v=>visit(v,depth+1));
   if(key==='oneOf')for(let i=0;i<groups.length;i++)for(let j=i+1;j<groups.length;j++)if(groups[i].some(a=>groups[j].some(b=>!disjoint(a,b))))throw Error('Overlapping oneOf branches: exclusivity cannot be proven; use disjoint types or required enum discriminators.');
   for(const group of key==='allOf'?groups:[groups.flat()]){if(variants.length*group.length>32)throw Error('Composition exceeds 32 alternatives.');variants=variants.flatMap(a=>group.map(b=>intersect(a,b)));}
  }
  return variants;
 }
 return visit(schema);
}
export function effectiveSecurity(doc,op){const list=op.security??doc.security??[];return list.length?list:[{}];}
function schemeSignature(s){const {description,bearerFormat,...wire}=s;if(wire.flows)wire.flows=Object.fromEntries(Object.entries(wire.flows).map(([name,flow])=>{const {scopes,...endpoints}=flow;return [name,endpoints];}));return JSON.stringify(canonical(wire));}
export function securityAccepts(offered,required,offeredDoc,requiredDoc){return Object.entries(required).every(([name,scopes])=>Object.entries(offered).some(([source,available])=>schemeSignature(offeredDoc.components.securitySchemes[source])===schemeSignature(requiredDoc.components.securitySchemes[name])&&scopes.every(scope=>available.includes(scope))));}
export function responseFor(responses,code){const key=Object.hasOwn(responses,String(code))?String(code):Object.hasOwn(responses,`${String(code)[0]}XX`)?`${String(code)[0]}XX`:Object.hasOwn(responses,'default')?'default':null;return key?{key,value:responses[key]}:null;}
