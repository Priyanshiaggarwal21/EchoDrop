import {responseFor} from './openapi-contract.mjs';
// Value validation for the explicitly accepted OpenAPI subset, never code generation.
export function checkValue(schema,value){let nodes=0;const issues=[];
 function visit(s,v,field,depth=0){const out=[];const fail=message=>out.push({field,message});if(++nodes>10000||depth>24){fail('Validation budget exceeded.');return out;}
  for(const key of ['allOf','oneOf','anyOf'])if(s[key]){const branches=s[key].map(child=>visit(child,v,field,depth+1)),matches=branches.filter(r=>!r.length).length;if(key==='allOf')out.push(...branches.flat());else if(key==='oneOf'?matches!==1:matches===0)fail(key==='oneOf'?'Value must match exactly one alternative.':'Value does not match any alternative.');}
  if(!s.type)return out;if(v===null){if(!s.nullable)fail('Null is not allowed.');else if(s.enum&&!s.enum.includes(null))fail('Value is outside declared enum.');return out;}
  const type=s.type,valid=type==='object'?v!==null&&typeof v==='object'&&!Array.isArray(v):type==='array'?Array.isArray(v):type==='integer'?Number.isInteger(v):type==='number'?typeof v==='number'&&Number.isFinite(v):typeof v===type;if(!valid){fail(`Expected ${type}.`);return out;}
  if(s.enum&&!s.enum.includes(v))fail('Value is outside declared enum.');
  const size=type==='string'?[...v].length:type==='array'?v.length:v;
  for(const [lo,hi] of type==='string'?[['minLength','maxLength']]:type==='array'?[['minItems','maxItems']]:['integer','number'].includes(type)?[['minimum','maximum']]:[])if((s[lo]!==undefined&&size<s[lo])||(s[hi]!==undefined&&size>s[hi]))fail('Value violates declared bounds.');
  if(type==='object'){for(const k of s.required??[])if(!Object.hasOwn(v,k))out.push({field:field+'.'+k,message:'Required field missing.'});for(const [k,x] of Object.entries(v)){if(Object.hasOwn(s.properties??{},k))out.push(...visit(s.properties[k],x,field+'.'+k,depth+1));else if(s.additionalProperties===false)fail('Undeclared field present.');}}
  if(type==='array')for(const x of v){out.push(...visit(s.items,x,field+'[]',depth+1));if(out.length>=100)break;}
  if(s.format){const checks={uuid:x=>typeof x==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(x),'date-time':x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(x)&&Number.isFinite(Date.parse(x)),int32:x=>Number.isInteger(x)&&x>=-2147483648&&x<=2147483647,int64:Number.isSafeInteger,float:Number.isFinite,double:Number.isFinite,byte:x=>typeof x==='string'&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(x)};if(checks[s.format]){if(!checks[s.format](v))fail('Value violates declared format.');}else fail('Format not verified by this runtime subset.');}
  return out.slice(0,100);
 }
 function unsupported(s){if(s.format&&!['uuid','date-time','int32','int64','float','double','byte'].includes(s.format))return true;return [...Object.values(s.properties??{}),...(s.items?[s.items]:[]),...(s.allOf??[]),...(s.anyOf??[]),...(s.oneOf??[])].some(unsupported);}
 if(unsupported(schema))return [{field:'$',message:'Schema contains a format not verified by this runtime subset.'}];issues.push(...visit(schema,value,'$'));return issues.slice(0,100);
}
export function headerValue(schema,value){if(schema.type==='integer'||schema.type==='number')return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)?Number(value):value;if(schema.type==='boolean')return value==='true'?true:value==='false'?false:value;return value;}
export function verifyResponse(op,status,headers,bytes){const selected=responseFor(op.responses,status),issues=[];if(!selected)return[{field:'status',message:'Observed status is not declared.'}];const response=selected.value;
 for(const [name,h] of Object.entries(response.headers??{})){const value=headers[name];if(value===undefined){if(h.required)issues.push({field:'header.'+name,message:'Required response header missing.'});}else issues.push(...checkValue(h.schema,headerValue(h.schema,String(value))).map(i=>({...i,field:'header.'+name+i.field.slice(1)})));}
 if(response.content){const media=String(headers['content-type']??'').split(';')[0].trim().toLowerCase(),schema=response.content[media]?.schema;if(!schema)issues.push({field:'content-type',message:'Observed media type is missing or undeclared.'});else{try{issues.push(...checkValue(schema,JSON.parse(bytes.toString('utf8'))));}catch{issues.push({field:'body',message:'Response is not valid JSON.'});}}}else if(bytes.length)issues.push({field:'body',message:'Response body was not declared.'});return issues.slice(0,100);
}
