import React,{useEffect,useRef,useState} from 'react';
import type {SecureContentBridge} from './ProjectTransfers';
export function DependencyInventory({projectId,target,api}:{projectId:string;target:any;api:SecureContentBridge}){
 const [view,setView]=useState<any>(null),[receipt,setReceipt]=useState<any>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');const generation=useRef(0);
 useEffect(()=>{generation.current++;setView(null);setReceipt(null);setError('');setBusy(false);},[projectId,JSON.stringify(target)]);
 async function run(action:'list'|'publish'){
  const id=++generation.current;setBusy(true);setError('');
  try{const reply=await api.run(projectId,'inventory-'+action,{target});if(id!==generation.current)return;if(action==='list')setView(reply);else setReceipt(reply);}
  catch{if(id===generation.current)setError('Inventory unavailable. Check current scope permissions, trusted peer connection and protected storage. An interrupted publish can be retried with a new challenge. Missing evidence remains UNKNOWN.');}
  finally{if(id===generation.current)setBusy(false);}
 }
 const details=(r:any)=><><p>Observed {new Date(r.generatedAt).toLocaleString()} · evidence version {r.evidenceVersion} · participation: {r.role}<br/>Scope {r.projectId}{r.contextId?` / ${r.contextId}`:' (project only)'}</p><ul>{r.categories.map((c:any)=><li key={c.category}>{c.category}: {c.status}</li>)}</ul>{r.facts.length?<ul>{r.facts.map((f:any)=><li key={f.category+f.id+f.state}>{f.category} · {f.state} · record {f.id}</li>)}</ul>:<p>No obligations observed in the covered categories at collection time. Unsupported categories and other devices remain UNKNOWN.</p>}</>;
 return <section aria-label="Device dependency inventory" aria-busy={busy}><h5>Device dependency inventory</h5>
  <p>Each collaborator publishes this device’s scoped observations over its existing trusted TLS connection. Host refresh reads received reports; it does not wake or scan other devices. Reports expire after five minutes or an authority change. Device presence and global completeness are not proven.</p>
  {target?.mode==='remote'&&<button disabled={busy} onClick={()=>void run('publish')}>Collect this device &amp; publish to host</button>}
  <button disabled={busy} onClick={()=>void run('list')}>Refresh received reports (scope admins)</button>
  {busy&&<p role="status">Checking authenticated dependency evidence…</p>}{error&&<p role="alert">{error}</p>}
  {receipt&&<section><p role="status">Host accepted this device’s scoped report. This is a time-limited observation, not a completeness guarantee.</p><details><summary>Inspect published evidence</summary>{details(receipt.report)}</details></section>}
  {view&&<><p>Checked {new Date(view.checkedAt).toLocaleString()}. Overall dependency completeness: UNKNOWN.</p>{!view.devices.length&&<p>No certificate-bound participants are enumerable in this scope. Unpaired, unenumerated and offline devices may still exist.</p>}{view.devices.map((d:any)=><article key={d.fingerprint}><strong>{d.status} · participant {d.principalId}</strong><p style={{overflowWrap:'anywhere'}}>Device fingerprint: {d.fingerprint}</p>{d.report?<details><summary>Inspect observed obligations and coverage</summary>{details(d.report)}</details>:<p>{d.status==='REVOKED'?'Current scope access or device trust is unavailable; the old report is withheld.':'A fresh authorized report is required. Missing or stale reports do not establish that a device is clear.'}</p>}</article>)}</>}
  <p>Always UNKNOWN: external services, complete device enumeration, unmapped/legacy receive caches, unrecorded saved copies and other contexts. File paths, names, payloads and credentials are excluded. No cleanup or handover is performed.</p>
 </section>;
}
