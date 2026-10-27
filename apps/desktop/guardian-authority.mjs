import {createHash} from 'node:crypto';
import {contentAuthority} from './content-authorization.mjs';
import {projectRole,contextAccess,isManager} from '../../packages/core/collaboration.mjs';
// Internal projection under the existing membership transaction. No names, keys or invitations leave it.
export function guardianAuthority(data,projects,fp,projectId,contextId){
 const access=contentAuthority(data,projects,fp,projectId,contextId),role=projectRole(data,projectId,access.principalId);
 const context=contextId?contextAccess(data,projectId,contextId,access.principalId):null;
 const canPlan=access.canWrite&&isManager(role)&&(!contextId||context.canManage);
 const members=(contextId?data.contextMembers.filter(m=>m.contextId===contextId):data.projectMembers.filter(m=>m.projectId===projectId)).map(m=>({id:m.principalId,role:m.role,status:m.status,updatedAt:m.updatedAt,projectRole:projectRole(data,projectId,m.principalId),usable:access.writers.includes(m.principalId)})).sort((a,b)=>a.id.localeCompare(b.id));
 const contexts=data.contexts.filter(c=>c.projectId===projectId&&c.status==='active'&&(!contextId||c.id===contextId));
 const visible=contexts.filter(c=>contextAccess(data,projectId,c.id,access.principalId).canRead);
 const projectMembers=data.projectMembers.filter(m=>m.projectId===projectId),ids=new Set(projectMembers.map(m=>m.principalId));
 const contextIds=new Set(data.contexts.filter(c=>c.projectId===projectId).map(c=>c.id));
 const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
 const identities=(data.remotePeers??[]).filter(p=>ids.has(p.principalId)).map(p=>{let usable=false;try{usable=contentAuthority(data,projects,p.fingerprint,projectId,contextId).canWrite;}catch{}return{principalId:p.principalId,fingerprint:p.fingerprint,status:p.status,usable};}).sort((a,b)=>a.fingerprint.localeCompare(b.fingerprint));
 for(const m of members){const peer=identities.find(p=>p.principalId===m.id&&p.status==='active'&&p.usable);m.currentIdentityBinding=m.id===data.localPrincipalId&&m.usable?digest(['local',data.localParticipant?.id,m.id]):peer?digest(['tls',peer.fingerprint,m.id]):null;}
 const authorityRevision=digest({projectMembers,contextMembers:data.contextMembers.filter(m=>contextIds.has(m.contextId)),contexts:data.contexts.filter(c=>contextIds.has(c.id)),principals:data.principals.filter(p=>ids.has(p.id)).map(p=>({id:p.id,status:p.status})),invitations:(data.invitationDrafts??[]).filter(i=>i.projectId===projectId).map(i=>({id:i.id,status:i.status,role:i.role,updatedAt:i.updatedAt})),identities,localIdentity:data.localParticipant?.id,associations:data.associations.filter(a=>a.projectId===projectId)});
 return {authorityRevision,projectRevision:digest(projects.find(p=>p.id===projectId)),identityBinding:digest(fp===null?['local',data.localParticipant?.id,access.principalId]:['tls',fp,access.principalId]),canContribute:access.canWrite,principalId:access.principalId,local:access.local,canPlan,role:contextId?(role==='owner'&&context.contextRole==='owner'?'owner':'admin'):role,localPrincipalId:data.localPrincipalId,members,contexts:visible.map(c=>({id:c.id,owners:data.contextMembers.filter(m=>m.contextId===c.id&&m.status==='active'&&m.role==='owner'&&isManager(projectRole(data,projectId,m.principalId))).map(m=>m.principalId).sort()})).sort((a,b)=>a.id.localeCompare(b.id)),hiddenContexts:visible.length!==contexts.length};
}

// Evidence freshness includes project lifecycle/metadata separately from membership authority.
// Recovery must still be able to restore older metadata under unchanged owner authority.
export function guardianSourceRevision(authority){
 return createHash('sha256').update(JSON.stringify([authority.authorityRevision,authority.projectRevision??null])).digest('hex');
}
