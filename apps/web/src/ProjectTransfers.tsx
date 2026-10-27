import {ContinuityGuardian} from './ContinuityGuardian';
import {ProjectDNA} from './ProjectDNA';
import { ProjectPulse } from './ProjectPulse';
import { EnvironmentRescue } from './EnvironmentRescue';
import { ContractHandshake } from './ContractHandshake';
import { IntentGuard } from './IntentGuard';
import { DeliveryQueue } from './DeliveryQueue';
import React, { useEffect, useRef, useState } from 'react';
import { bytes, newTransferId } from './transfer-api';
import { canResume, percentage, uploadContent, queueContentMany, receiveContent, type ContentRecord, type ContentProgress } from './project-transfer-flow.mjs';
import type { ScanResult } from '../../../packages/transfer/secret-scan.mjs';
import './project-transfers.css';

export interface SecureContentBridge { run(projectId: string, action: string, payload?: unknown): Promise<any> }
type Scope = { projectId: string; projectName: string; contextId?: string; contextName?: string; role: string };
type Setup = { scopes: Scope[]; peers: { fingerprint: string; displayName: string }[]; listening: boolean; port: number | null; blockedReason: string | null };
type Info = { principalId: string; role: string; recipients: { id: string; displayName: string }[] };
const key = (scope: Scope) => `${scope.projectId}:${scope.contextId ?? ''}`;
const errorText = (error: unknown) => error instanceof Error ? error.message : 'The operation could not finish. Refresh access and try again.';
export function ProjectTransfers({ projectId }: { projectId: string }) {
  const api = window.echoDesktop?.secureContent;
  const [setup, setSetup] = useState<Setup | null>(null), [mode, setMode] = useState<'local'|'remote'>('local');
  const [peer, setPeer] = useState(''), [host, setHost] = useState(''), [port, setPort] = useState('');
  const [scopes, setScopes] = useState<Scope[]>([]), [selected, setSelected] = useState(''), [connected, setConnected] = useState<{ fingerprint: string; host: string; port: number } | null>(null);
  const [info, setInfo] = useState<Info | null>(null), [records, setRecords] = useState<ContentRecord[]>([]);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [file, setFile] = useState<File | null>(null), [recipient, setRecipient] = useState(''), [resume, setResume] = useState<ContentRecord | null>(null);
  const [progress, setProgress] = useState<ContentProgress | null>(null), [dragging, setDragging] = useState(false), [confirmCancel, setConfirmCancel] = useState('');
  const [extraRecipients,setExtraRecipients]=useState<string[]>([]);
  const [queued, setQueued] = useState(true);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const stop = useRef(false), mounted = useRef(true), scanResolve = useRef<((value: boolean) => void) | null>(null), fileInput = useRef<HTMLInputElement>(null), reviewButton = useRef<HTMLButtonElement>(null);
  const scope = scopes.find(item => key(item) === selected);
  const target = scope ? { mode, projectId: scope.projectId, ...(scope.contextId ? { contextId: scope.contextId } : {}), ...(mode === 'remote' && connected ? connected : {}) } : null;
  const targetKey = JSON.stringify(target);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stop.current = true; scanResolve.current?.(false); }; }, []);
  useEffect(() => { let active = true; setLoading(true); api?.run(projectId, 'setup').then((value: Setup) => { if (active) { setSetup(value); setScopes(value.scopes); setSelected(value.scopes[0] ? key(value.scopes[0]) : ''); } }).catch((error: unknown) => { if (active) setError(errorText(error)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [api, projectId]);
  useEffect(() => { if (scan) reviewButton.current?.focus(); }, [scan]);
  useEffect(() => {
    let active = true; setInfo(null); setRecords([]); setFile(null); setResume(null); setRecipient(''); setExtraRecipients([]); setProgress(null); setError(''); setNotice('');
    if (!target || !api) return;
    setLoading(true);
    Promise.all([api.run(projectId, 'operate', { target, command: { action: 'content-info' } }), api.run(projectId, 'operate', { target, command: { action: 'content-list' } })]).then(([info, records]) => { if (active) { setInfo(info); setRecords(records); } }).catch(error => { if (active) setError(errorText(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [targetKey, api, projectId]);
  if (!api) return <section className="project-transfers"><h3>Project-linked sharing lives on your desktop.</h3><p>Open EchoDrop desktop to use verified participants and encrypted project transfers. Legacy LAN/manual transfers remain available separately.</p></section>;
  const operate = (command: Record<string, unknown>, chunk?: ArrayBuffer) => api.run(projectId, 'operate', { target, command, ...(chunk ? { bytes: chunk } : {}) });
  async function refresh() {
    if (!target) return;
    const [access, history] = await Promise.all([operate({ action: 'content-info' }), operate({ action: 'content-list' })]);
    if (mounted.current) { setInfo(access); setRecords(history); }
  }
  async function task(operation: () => Promise<void>) {
    if (busy) return;
    stop.current = false; setBusy(true); setError(''); setNotice('');
    try { await operation(); } catch (error) { if (mounted.current) { setError(errorText(error)); setProgress(value => value ? { ...value, phase: 'Interrupted' } : null); } }
    finally { if (mounted.current) setBusy(false); }
  }
  function choose(value: File | undefined) { if (!value || busy || info?.role === 'guest') return; setFile(value); setError(''); setNotice(''); setProgress(null); }
  async function send() {
    if (!file || !recipient || !info || info.role === 'guest') return;
    const selectedFile = file, id = resume?.id ?? newTransferId();
    if (queued && !resume) {
      const results = await queueContentMany({file:selectedFile,recipientIds:[recipient,...extraRecipients],target,call:(action,value)=>api!.run(projectId,action,value),progress:value=>{if(mounted.current)setProgress(value);},stopped:()=>stop.current,confirm:result=>new Promise(resolve=>{scanResolve.current=resolve;setScan(result);})});
      if(mounted.current){const count=results.filter(r=>r.queued).length;if(count)setFile(null);setNotice(`${count} recipient deliveries queued independently. EchoDrop must remain open to retry.`);const failures=results.filter(r=>r.error);if(failures.length)setError(failures.map(r=>`${info.recipients.find(p=>p.id===r.recipientId)?.displayName??r.recipientId}: ${r.error}`).join(' · '));}
      return;
    }
    const done = await uploadContent({ file: selectedFile, id, recipientId: recipient, operate, progress: value => { if (mounted.current) setProgress(value); }, stopped: () => stop.current, ...(resume ? { expected: resume } : {}), confirm: result => new Promise(resolve => { scanResolve.current = resolve; setScan(result); }) });
    if (mounted.current) {
      if (done) { setFile(null); setResume(null); setNotice('Verified and shared with the selected recipient. They can now retrieve it over authenticated TLS.'); }
      else { setProgress(value => value ? { ...value, phase: stop.current ? 'Paused' : 'Not shared' } : null); setNotice(stop.current ? 'Paused after the last acknowledged chunk. Refresh history and select the same file to resume.' : 'Secret-Safe review cancelled. No file was shared.'); }
      await refresh();
    }
  }
  function decide(value: boolean) { scanResolve.current?.(value); scanResolve.current = null; setScan(null); }
  const writable = Boolean(info && info.role !== 'guest' && info.recipients.length && !loading);
  return <section className="project-transfers" aria-label="OmniDrop project-linked secure sharing">
    <header className="pt-heading"><div><p className="pt-eyebrow">OMNIDROP / SHARED CONTENT</p><h3>The right files.<br/><span>The right people.</span></h3><p>Share within a project or a focused collaboration context. Explicit recipients, verified access, and a clear record of every transfer.</p></div><span className="pt-security"><span aria-hidden="true">â†—</span> Authenticated TLS 1.3</span></header>
    <div className="pt-mode" role="group" aria-label="Content host"><button disabled={busy} aria-pressed={mode === 'local'} onClick={() => { setMode('local'); setScopes(setup?.scopes ?? []); setSelected(setup?.scopes[0] ? key(setup.scopes[0]) : ''); }}>Hosted in this project</button><button disabled={busy} aria-pressed={mode === 'remote'} onClick={() => { setMode('remote'); setScopes([]); setSelected(''); }}>Connect to a verified host</button></div>
    <p className="pt-caption">{mode === 'local' ? `Files stay in this desktopâ€™s private secure-content store. ${setup?.listening ? `The secure listener was active on port ${setup.port} at the last status check.` : 'Start the secure listener in Teams & people when recipients are ready to connect.'}` : 'Your local project is the entry point. Select the actual remote project/context after connecting; accepting an invitation does not create a local project copy.'} Legacy LAN/manual sharing uses a separate service.</p>
    {setup?.blockedReason && <p className="pt-error" role="alert">{setup.blockedReason}</p>}
    {mode === 'remote' && <form className="pt-connection" onSubmit={event => { event.preventDefault(); void task(async () => { const endpoint = { fingerprint: peer, host: host.trim(), port: Number(port) }; const values: Scope[] = await api.run(projectId, 'scopes', { target: { mode: 'remote', ...endpoint } }); setConnected(endpoint); setScopes(values); setSelected(values[0] ? key(values[0]) : ''); if (!values.length) setNotice('No accepted scopes at this host. Accept a project invitation in Teams & people first.'); }); }}><fieldset disabled={busy}><legend>Verified peer connection</legend><label>Host<select required value={peer} onChange={event => setPeer(event.target.value)}><option value="">Choose a verified participant</option>{setup?.peers.map(item => <option key={item.fingerprint} value={item.fingerprint}>{item.displayName} Â· {item.fingerprint.slice(0, 14)}</option>)}</select></label><label>IP address<input required value={host} onChange={event => setHost(event.target.value)} placeholder="192.168.1.20" autoComplete="off"/></label><label>Secure port<input type="number" min={1} max={65535} required value={port} onChange={event => setPort(event.target.value)}/></label><button className="pt-button">Connect & check access</button></fieldset></form>}
    {scopes.length > 0 && <div className="pt-scope"><label>Sharing scope<select disabled={busy} value={selected} onChange={event => setSelected(event.target.value)}>{scopes.map(item => <option key={key(item)} value={key(item)}>{item.projectName}{item.contextName ? ` / ${item.contextName}` : ' / project files'}</option>)}</select></label><span className="pt-access">{info ? info.role === 'guest' ? 'Guest Â· receive only' : 'Member Â· share & receive' : 'Checking accessâ€¦'}</span><button className="pt-link" disabled={busy || loading} onClick={() => void task(refresh)}>Refresh access & history</button></div>}
    {error && <div className="pt-error" role="alert"><strong>We couldnâ€™t finish that operation.</strong><p>{error}</p><p>Check the host connection and current membership, then refresh. An interrupted transfer can resume using the original file; failed integrity checks require a new transfer.</p></div>}
    <p className="pt-status" role="status">{loading ? 'Loading authorized contentâ€¦' : notice}</p>
    {info?.role === 'guest' && <p className="pt-empty">You have read-only access in this scope. You can save verified files addressed to you. Uploading requires an accepted member invitation and current membership.</p>}
    {info && info.role !== 'guest' && <form className="pt-compose" onSubmit={event => { event.preventDefault(); void task(send); }}>
      <div className={`pt-drop${dragging ? ' is-dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (writable && !busy) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (event.dataTransfer.files.length !== 1) { setError('Choose one file at a time so its recipient and progress stay clear.'); return; } if (writable) choose(event.dataTransfer.files[0]); }}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M14 3H6v18h12V7zM14 3v5h4M9 14l3-3 3 3M12 11v7"/></svg><strong>{file ? file.name : resume ? `Select the original ${resume.name}` : 'Drop a file into your shared space'}</strong><p>{file ? `${bytes(file.size)} Â· ${resume ? 'resume existing transfer' : 'new transfer'}` : 'Large files use 1 MiB chunks. Default host limit: 8 GiB; configured limits and available storage apply. Secret-Safe review runs before sharing.'}</p><button type="button" className="pt-button secondary" disabled={busy || !writable} onClick={() => fileInput.current?.click()}>{file ? 'Choose another file' : 'Choose file'}</button><input ref={fileInput} className="pt-visually-hidden" tabIndex={-1} type="file" disabled={busy || !writable} onChange={event => { choose(event.target.files?.[0]); event.target.value = ''; }} aria-label="Select a file to share"/>
      </div>
      <div className="pt-send">{!resume && <label><input type="checkbox" checked={queued} disabled={busy} onChange={event=>setQueued(event.target.checked)}/> Retain an OS-protected copy for automatic retries</label>}<label>Recipient<select required disabled={busy || !writable || Boolean(resume)} value={recipient} onChange={event => setRecipient(event.target.value)}><option value="">Choose an authorized recipient</option>{info.recipients.map(person => <option key={person.id} value={person.id}>{person.displayName} Â· {person.id.slice(0, 8)}</option>)}</select></label>{queued&&!resume&&<details><summary>Additional recipients</summary>{info.recipients.filter(p=>p.id!==recipient).map(person=><label key={person.id}><input type="checkbox" disabled={busy} checked={extraRecipients.includes(person.id)} onChange={e=>setExtraRecipients(previous=>e.target.checked?[...previous,person.id]:previous.filter(id=>id!==person.id))}/>{person.displayName}</label>)}<p>Each recipient gets an independently authorized delivery and protected staging copy.</p></details>}<p>Only you, each selected recipient and the host administrator can access their delivery. Context access is checked independently.</p><button className="pt-button" disabled={busy || !file || !recipient || !writable}>{resume ? 'Review & resume' : queued ? 'Review & queue' : 'Review & share'} <span aria-hidden="true">â†’</span></button>{resume && <button type="button" className="pt-link" disabled={busy} onClick={() => { setResume(null); setFile(null); }}>Switch to a new transfer</button>}</div>
      {!info.recipients.length && <p className="pt-empty">No eligible recipients yet. Verify a participant and have them accept this project/context invitation in Teams & people.</p>}
    </form>}
    {scan && <section className="pt-review" role="region" aria-label="Secret-Safe review"><p className="pt-eyebrow">REVIEW BEFORE SHARING</p><h4>This file needs your attention.</h4><p>Recipients: {info?.recipients.filter(p=>[recipient,...(queued&&!resume?extraRecipients:[])].includes(p.id)).map(p=>p.displayName).join(', ')}</p><ul>{scan.categories.map(item => <li key={item}>{item}</li>)}{scan.limitations.map(item => <li key={item}>{item}</li>)}</ul><p>EchoDropâ€™s scan is a local heuristic, not a guarantee that the file contains no secrets. Share only if you intend this recipient and host to receive it.</p><button ref={reviewButton} className="pt-button secondary" onClick={() => decide(false)}>Keep file private</button><button className="pt-button" onClick={() => decide(true)}>I reviewed this file â€” continue</button></section>}
    {progress && <div className="pt-progress" aria-live="polite"><div><strong>{progress.name}</strong><span>{progress.phase}</span></div><progress aria-label={`${progress.phase}: ${progress.name}`} max={100} value={percentage(progress.retained, progress.size, ['Completed','Saved'].includes(progress.phase))}/><p>{bytes(progress.retained)} / {bytes(progress.size)} acknowledged{progress.phase === 'Verifying' || progress.phase === 'Verifying & saving' ? ' Â· checking integrity' : ''}</p>{busy && !scan && !['Verifying', 'Verifying & saving'].includes(progress.phase) && <button className="pt-link" onClick={() => { stop.current = true; setNotice('Pausing after the current chunk. Acknowledged progress is retained.'); }}>Pause after this chunk</button>}</div>}
    <div id="pulse-source-content"/>
    {info && <section className="pt-history" aria-label="Shared files and transfer history"><header><h4>Shared files & history</h4><span>{records.length} {records.length === 1 ? 'transfer' : 'transfers'}</span></header>{!records.length && !loading && <div className="pt-empty"><strong>A clear space for your next handoff.</strong><p>Files sent or addressed to you in this scope will appear here. Other projects and recipients stay separate.</p></div>}
      <ul>{[...records].reverse().map(record => <li className="pt-file" key={record.id}><div className="pt-file-details"><strong>{record.name}</strong><span>{bytes(record.size)} Â· {record.senderId === info.principalId ? 'Sent by you' : 'Shared with you'} Â· {new Date(record.createdAt).toLocaleString()}</span><small>{record.state === 'uploading' ? `${bytes(record.retainedBytes)} retained Â· resumable` : record.state === 'completed' ? 'SHA-256 verified' : record.state === 'failed' ? 'Integrity failed Â· unavailable' : 'Cancelled Â· unavailable'}</small></div>{record.delivery&&<small>{record.delivery}{record.archivedAt?' · archived; saved copies remain':''}</small>}<span className={`pt-state ${record.state}`}>{record.state}</span><div className="pt-file-actions">{!record.archivedAt&&(record.delivery==='Applied'||record.state==='cancelled')&&(mode==='local'||record.senderId===info.principalId)&&<button className="pt-link" disabled={busy} onClick={()=>void task(async()=>{await operate({action:'content-archive',id:record.id});await refresh();setNotice('Host payload archived. History and already saved copies remain.');})}>Archive host payload</button>}{record.state==='completed'&&record.delivery==='Applied'&&<button className="pt-link" disabled={busy} onClick={()=>void task(async()=>{await api.run(projectId,'receive-cleanup',{target,id:record.id});setNotice('Receive cache reclaimed after verifying your saved copy.');})}>Clean verified receive cache</button>}{record.state === 'completed' && <button className="pt-button secondary" disabled={busy} onClick={() => void task(async () => { const result = await receiveContent({ record, stopped: () => stop.current, progress: value => { if (mounted.current) setProgress(value); }, call: (action, value) => api.run(projectId, action, { target, ...value }) }); if (mounted.current) setNotice(result.saved ? `Saved ${result.name} in new folder ${result.folderName}. Existing files were not overwritten.` : 'Receive progress is retained. Choose Save verified copy again to resume or select a destination.'); })}>Save verified copy</button>}{canResume(record, info.principalId, info.role) && <button className="pt-link" disabled={busy} onClick={() => { setResume(record); setRecipient(record.recipientId); setFile(null); fileInput.current?.click(); }}>Resume with original file</button>}{record.state !== 'cancelled' && (mode === 'local' || record.senderId === info.principalId) && <button className="pt-link" disabled={busy} onClick={() => setConfirmCancel(record.id)}>{record.state === 'completed' ? 'Withdraw' : 'Cancel transfer'}</button>}</div>{confirmCancel === record.id && <div className="pt-confirm"><p>Make this file unavailable and remove its stored bytes? Copies already saved by a recipient cannot be revoked.</p><button className="pt-button secondary" disabled={busy} onClick={() => setConfirmCancel('')}>Keep transfer</button><button className="pt-button" disabled={busy} onClick={() => void task(async () => { await operate({ action: 'content-cancel', id: record.id }); setConfirmCancel(''); await refresh(); })}>Confirm cancellation</button></div>}</li>)}</ul>
    </section>}
    {target && <ContinuityGuardian key={"guardian:"+targetKey} projectId={projectId} target={target} api={api}/>}
    {target && <ProjectDNA key={"dna:"+targetKey} projectId={projectId} target={target} api={api}/>}
    {target && <ProjectPulse key={targetKey} projectId={projectId} target={target} api={api}/>}
    <div id="pulse-source-intent"/>
    {target && <IntentGuard key={targetKey} projectId={projectId} target={target} api={api}/>}
    <div id="pulse-source-contract"/>
    {target && <ContractHandshake key={targetKey} projectId={projectId} target={target} api={api}/>}
    <div id="pulse-source-environment"/>
    {target && <EnvironmentRescue key={targetKey} projectId={projectId} target={target} api={api}/>}
    <DeliveryQueue projectId={projectId} api={api}/>
    <footer className="pt-caption">Encrypted in transit between verified desktops; the host stores file bytes and can read them. Files are never served by the legacy HTTP service. Received files are not executed or automatically added to a project.</footer>
  </section>;
}
