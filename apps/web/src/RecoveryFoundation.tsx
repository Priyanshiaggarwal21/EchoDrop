import React,{useEffect,useState} from 'react';
import type {SecureContentBridge} from './ProjectTransfers';

export function RecoveryFoundation({projectId,target,api,evidence}:{projectId:string;target:any;api:SecureContentBridge;evidence:any[]}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[preview,setPreview]=useState<any>(null),[records,setRecords]=useState(evidence),[selected,setSelected]=useState<string[]>([]),[result,setResult]=useState<any>(null);
 useEffect(()=>{setRecords(evidence);setPreview(null);setSelected([]);setResult(null);setError('');},[evidence,projectId,target?.contextId,target?.mode]);
 async function run(action:string,snapshotId?:string){
  setBusy(true);setError('');
  if(action!=='restore'){setPreview(null);setSelected([]);setResult(null);}
  try{
   const r=await api.run(projectId,'recovery-'+action,{target,...(snapshotId?{snapshotId}:{}),...(action==='restore'?{operation:'restore-selected-metadata',previewId:preview.previewId,fields:selected}:{})});
   if(action==='preview')setPreview(r);
   if(action==='restore')setResult(r);
   setRecords(await api.run(projectId,'recovery-list',{target}));
  }catch{
   setError(action==='restore'?'Restore was cancelled or could not be confirmed. A stale preview, changed owner access, expired or missing material, or storage failure blocks changes. Retry the same selection to recover an interrupted acknowledgement; if it remains blocked, verify and review a new preview. Do not assume the write failed solely because its acknowledgement was interrupted.':'Recovery failed or was cancelled. Check current owner access, separate destinations, selected key/snapshot, expiry and storage integrity. Existing exported files are preserved.');
  }finally{setBusy(false);}
 }
 const supported=target?.mode==='local'&&!target.contextId;
 return <section aria-label="Recovery foundation" aria-busy={busy}>
  <h5>Project metadata recovery</h5>
  <p>New snapshots include name, description, ID, type, lifecycle status, origin, pin and timestamps. You can restore selected name, description, status and pin fields to this existing project after native owner confirmation. ID, type, origin and timestamps are comparison evidence; the update timestamp advances on restore.</p>
  <p>Not covered: opaque metadata, folders, files, contracts, queues, memberships, credentials or identity recovery. Review name and description for sensitive text in the export dialog. This cannot recreate a lost host, account or complete project.</p>
  <p>Keep the portable key in a separate secure destination, preferably independently held media. It is outside OS-account protection. Folder separation does not prove separate hardware.</p>
  {supported?<><button disabled={busy} onClick={()=>void run('create')}>Review export &amp; create snapshot</button><button disabled={busy} onClick={()=>void run('list')}>Refresh evidence</button></>:<p>Export, preview and restore require the hosting desktop’s current protected owner and project scope. Context recovery is unsupported.</p>}
  {busy&&<p role="status">Working with authorized recovery material…</p>}{error&&<p role="alert">{error}</p>}
  {!records.length&&<p>No recovery snapshots enrolled. Export one to independently held destinations, then select the files again to verify it.</p>}
  {records.map(r=><article key={r.snapshotId}><strong>{r.status} — limited snapshot coverage</strong><p>Snapshot {r.snapshotId} · {r.policy}<br/>Created {new Date(r.createdAt).toLocaleString()} · expires {new Date(r.expiresAt).toLocaleString()}<br/>Last independent decryption: {r.verifiedAt?new Date(r.verifiedAt).toLocaleString():'not verified'}</p>{r.metadataRestoredAt&&<p>Metadata restore recorded {new Date(r.metadataRestoredAt).toLocaleString()}. Later edits may differ.</p>}{supported&&<><button disabled={busy} onClick={()=>void run('preview',r.snapshotId)}>Select material, verify &amp; preview</button><button disabled={busy} onClick={()=>void run('forget',r.snapshotId)}>Forget evidence (keep files)</button></>}</article>)}
  {preview&&<section aria-label="Metadata restore preview"><h6>Review exact differences</h6><p>{preview.evidence.status}. Unsupported state will remain unchanged. A stale snapshot can supply older metadata; any change after this preview requires a new review. Preview expires {new Date(preview.expiresAt).toLocaleTimeString()}.</p>
   <details><summary>Inspect supported snapshot fields</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(preview.state,null,2)}</pre></details>
   {preview.blockers.length>0&&<p role="status">Restore blocked: {preview.blockers.join(', ')}. Legacy v1 snapshots remain preview-only.</p>}
   {preview.differences.length?<fieldset disabled={busy||!preview.canApply||!!result}><legend>Explicitly select fields to replace</legend>{preview.differences.map((d:any)=><div key={d.field} style={{overflowWrap:'anywhere'}}>{preview.restoreFields.includes(d.field)?<label><input type="checkbox" checked={selected.includes(d.field)} onChange={e=>setSelected(s=>e.target.checked?[...s,d.field]:s.filter(k=>k!==d.field))}/>{d.field}</label>:<strong>{d.field} (comparison only)</strong>}<p>Current: {JSON.stringify(d.current)}<br/>Snapshot: {JSON.stringify(d.snapshot)}</p></div>)}</fieldset>:<p>Covered fields match. There is no metadata to restore.</p>}
   {preview.canApply&&preview.restoreFields.length>0&&<button disabled={busy||!selected.length||!!result} onClick={()=>void run('restore',preview.evidence.snapshotId)}>Restore selected metadata…</button>}
  </section>}
  {result&&<p role="status">{result.replayed?'Previously completed operation confirmed':'Metadata restored'}: {result.fields.join(', ')} at {new Date(result.appliedAt).toLocaleString()}. {result.currentMatches?'The registry matches this operation’s committed result.':'The project has changed since that operation; no repeat write was applied.'} Refresh the project view to see its current details. Other state was preserved.</p>}
  <p>Guardian full disaster-recovery readiness remains UNKNOWN. Metadata restore does not authorize ownership handover.</p>
 </section>;
}
