export const intentId=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export function intentPath(value){
 if(typeof value!=='string'||value.length>180||/^[\\/]|^[a-z]:/i.test(value)||/[\x00-\x1f<>:"|?*]/.test(value))throw Error('Use project-relative paths without drive letters or traversal.');
 const parts=value.normalize('NFC').replaceAll('\\','/').toLowerCase().split('/').filter(p=>p&&p!=='.');
 if(!parts.length||parts.some(p=>p==='..'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw Error('Invalid Windows project path.');
 return parts.join('/');
}
export function intentFields(value){
 if(!value||typeof value.description!=='string'||!value.description.trim()||value.description.length>1000||!Array.isArray(value.paths)||!Array.isArray(value.modules)||value.paths.length>20||value.modules.length>20||!Number.isInteger(value.hours)||value.hours<1||value.hours>720)throw Error('Describe the work, choose up to 20 paths/modules, and an expiry between 1 and 720 hours.');
 const paths=[...new Set(value.paths.map(intentPath))],modules=[...new Set(value.modules.map(label=>{if(typeof label!=='string'||!label.trim()||label.length>80||/[\x00-\x1f\\/]/.test(label))throw Error('Invalid module name.');return label.normalize('NFC').trim().toLowerCase();}))];
 if(!paths.length&&!modules.length)throw Error('Select at least one file, folder or module.');
 return {description:value.description.trim(),paths,modules,hours:value.hours};
}
export function overlaps(left,right){
 const paths=[];for(const a of left.paths)for(const b of right.paths)if(a===b||a.startsWith(b+'/')||b.startsWith(a+'/'))paths.push(a===b?a:`${a} ↔ ${b}`);
 return {paths:[...new Set(paths)],modules:left.modules.filter(name=>right.modules.includes(name))};
}
export function intentCollisions(candidate,records,principalId,now=Date.now()){
 return records.filter(item=>item.id!==candidate.id&&item.participantId!==principalId&&item.status==='active'&&Date.parse(item.expiresAt)>now).map(item=>({item,...overlaps(candidate,item)})).filter(item=>item.paths.length||item.modules.length);
}
export function validIntent(record){
 if(!record||record.schemaVersion!==1||!intentId(record.id)||!intentId(record.projectId)||(record.contextId!==undefined&&!intentId(record.contextId))||!intentId(record.participantId)||typeof record.displayName!=='string'||record.displayName.length>120||!['active','resolved','cancelled','stale','revoked'].includes(record.status)||!Number.isInteger(record.version)||record.version<1||!Number.isInteger(record.revision)||record.revision<1||!Array.isArray(record.notes)||record.notes.length>12)throw Error('Invalid intention record.');
 const canonical=intentFields(record);for(const field of ['createdAt','updatedAt','expiresAt'])if(!Number.isFinite(Date.parse(record[field])))throw Error('Invalid intention timestamp.');
 for(const note of record.notes)if(!intentId(note.participantId)||!['acknowledge','coordinate'].includes(note.kind)||typeof note.text!=='string'||note.text.length>400||typeof note.displayName!=='string'||note.displayName.length>120||!Number.isFinite(Date.parse(note.at)))throw Error('Invalid coordination note.');
 // Loaders retain this object: normalize matching fields only after all validation succeeds.
 record.paths=canonical.paths;record.modules=canonical.modules;
 return record;
}
