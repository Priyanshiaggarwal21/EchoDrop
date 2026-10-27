const id=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const fp=v=>typeof v==='string'&&/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(v);
export function parseDeviceInvitation(text){
 if(typeof text!=='string'||text.length>1800||!text.startsWith('echodrop-pair:'))throw Error('Use an EchoDrop secure device invitation, not a legacy LAN link.');
 let v;try{v=JSON.parse(decodeURIComponent(text.slice(14)));}catch{throw Error('Malformed secure device invitation.');}
 if(!v||Object.keys(v).some(k=>!['v','id','projectId','contextId','host','port','fingerprint','recipient','expiresAt'].includes(k))||v.v!==1||!id(v.id)||!id(v.projectId)||(v.contextId!==undefined&&!id(v.contextId))||!fp(v.fingerprint)||!fp(v.recipient)||typeof v.host!=='string'||v.host.length>64||! /^[0-9a-fA-F:.]+$/.test(v.host)||!Number.isInteger(v.port)||v.port<1||v.port>65535||!Number.isSafeInteger(v.expiresAt))throw Error('Invalid secure device invitation.');return v;
}
export function deviceInvitation(value){const text='echodrop-pair:'+encodeURIComponent(JSON.stringify(value));parseDeviceInvitation(text);return text;}
