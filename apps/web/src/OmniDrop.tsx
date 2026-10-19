import React, { useEffect, useRef, useState } from 'react';
import { bytes, fingerprint, LIMIT, request, sha256File, TransferError, type Transfer, type Transport } from './transfer-api';
import './omnidrop.css';

type Phase = 'Checking' | 'Preparing' | 'Uploading' | 'Verifying' | 'Completed' | 'Interrupted' | 'Resumable' | 'Failed';
type Record = { id: string; key: string; name: string; size: number; retained: number; phase: Phase; note: string; restart?: boolean };
type Device = { id: string; deviceName: string; expiresAt: number };
const journal = 'echodrop:omni:records:v1';
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function readRecords(): Record[] {
  try { const values: unknown = JSON.parse(localStorage.getItem(journal) || '[]');
    if (!Array.isArray(values)) return [];
    return values.filter((r): r is Record => r && idPattern.test(r.id) && typeof r.key === 'string' && r.key.startsWith('echodrop:transfer:') && typeof r.name === 'string' && Number.isSafeInteger(r.size) && r.size >= 0 && r.size <= LIMIT).slice(0, 100).map(r => ({ ...r, phase: 'Checking', retained: Number.isSafeInteger(r.retained) && r.retained >= 0 && r.retained <= r.size ? r.retained : 0, note: 'Last acknowledged bytes shown; checking persisted transfer with the host.' }));
  } catch { return []; }
}
function Folder() { return <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M5 14V9h14l5 5h19v26H5V14Zm0 5h38M24 34V24m-5 5 5-5 5 5"/></svg>; }
export function OmniDrop({ api, view, devices, download, onComplete, onActiveChange }: { api: Transport; view: 'Files' | 'Transfers'; devices?: Device[]; download?: (path: string) => Promise<void>; onComplete?: () => void; onActiveChange?: (active: boolean) => void }) {
  const [records, setRecords] = useState<Record[]>(readRecords);
  const recordsRef = useRef(records);
  const [selected, setSelected] = useState<File | null>(null);
  const [active, setActive] = useState(false);
  const lock = useRef(false);
  const [phase, setPhase] = useState('');
  const [message, setMessage] = useState('');
  const [storageWarning, setStorageWarning] = useState('');
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const resumeTarget = useRef<Record | undefined>(undefined);
  const [files, setFiles] = useState<{ name: string; path: string }[]>([]);
  const [filesLoaded, setFilesLoaded] = useState(false);
  const [fileError, setFileError] = useState('');
  const [query, setQuery] = useState('');
  const [checking, setChecking] = useState(false);
  const alive = useRef(true);
  const fileCache = useRef(new Map<string, File>());
  function persist(next: Record[]) {
    recordsRef.current = next; setRecords(next);
    try { localStorage.setItem(journal, JSON.stringify(next)); } catch { setStorageWarning('Browser storage is unavailable. Keep this window open to retain resume references.'); }
  }
  function update(record: Record) { persist([record, ...recordsRef.current.filter(r => r.id !== record.id)]); }
  function remember(key: string, id: string) { try { localStorage.setItem(key, id); } catch { setStorageWarning('Resume is available in this window only; browser storage could not be saved.'); } }
  async function refreshFiles() {
    try {
      const response = await api({ path: '/' });
      if (response.status !== 200) throw new Error('Files unavailable. Your session may have expired; reopen the desktop app or rejoin the host.');
      const document = new DOMParser().parseFromString(response.text, 'text/html');
      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('#files a[download]'));
      setFiles(links.map(a => ({ name: a.textContent || 'File', path: a.getAttribute('href') || '' })).filter(f => /^\/files\/[0-9a-f-]{36}\.bin$/.test(f.path)));
      setFilesLoaded(true); setFileError('');
    } catch (e) { setFileError((e as Error).message); }
  }
  function fromServer(record: Record, state: Transfer): Record {
    return { ...record, retained: state.retainedBytes, phase: state.state === 'completed' ? 'Completed' : state.state === 'failed' ? 'Failed' : 'Resumable', restart: state.state === 'failed',
      note: state.state === 'completed' ? 'SHA-256 verified by the host. Available to approved workspace members.' : state.state === 'failed' ? 'Host rejected this upload. Its chunks were discarded; a new upload is required.' : 'Host confirmed retained bytes. Select the same file to resume from its next chunk.' };
  }
  async function reconcile() {
    if (lock.current) return;
    setChecking(true);
    for (const record of recordsRef.current) {
      if (!alive.current || lock.current) break;
      try { const state = await request(api, { path: '/transfers/' + record.id }); if (!lock.current) update(fromServer(record, state)); }
      catch (e) { if (!lock.current) update({ ...record, phase: 'Interrupted', restart: e instanceof TransferError && [404, 410].includes(e.status), note: recovery(e) }); }
    }
    setChecking(false);
  }
  useEffect(() => { alive.current = true; void refreshFiles(); void reconcile(); return () => { alive.current = false; }; }, []);
  useEffect(() => { const warn = (event: BeforeUnloadEvent) => { if (lock.current) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, []);
  function recovery(error: unknown) {
    if (error instanceof TransferError) {
      if ([401, 403].includes(error.status)) return 'Access expired or was revoked. Reopen the desktop app or rejoin with host approval, then resume the same file.';
      if ([404, 410].includes(error.status)) return 'The host no longer has this transfer. Select the original file and explicitly start a new upload.';
      if (error.status === 409) return error.message + ' Select the matching file, or retry after the other transfer operation finishes.';
    }
    return (error as Error).message + ' Check your network and host, then resume with the same file. Acknowledged chunks stay on the host.';
  }
  function choose(list: FileList | File[]) {
    if (lock.current) { setMessage('Finish or recover the current upload before selecting another file.'); return; }
    const file = list[0]; if (!file) return;
    if (list.length !== 1) { setMessage('Choose one file at a time. No files were added.'); return; }
    if (file.size > LIMIT) { setMessage('This file exceeds the 100 MB (100,000,000 bytes) limit. Choose a smaller file.'); return; }
    const target = resumeTarget.current;
    if (target && (target.name !== file.name || target.size !== file.size)) { setMessage(`Select the original ${target.name} (${bytes(target.size)}). The file hash will also be checked.`); return; }
    setSelected(file); setMessage(''); setPhase('');
    if (target) { resumeTarget.current = undefined; void send(file, target, target.restart); }
  }
  async function send(file: File, target?: Record, startNew = false) {
    if (lock.current) return;
    lock.current = true; setActive(true); onActiveChange?.(true); setMessage(''); setPhase('Preparing · calculating SHA-256');
    let current: Record | undefined = target;
    let state: Transfer | undefined;
    let key = '';
    try {
      const hash = await sha256File(file); key = fingerprint(file, hash);
      if (target && target.key !== key) throw new Error('The selected file contents do not match this transfer. Select the original file.');
      let saved = target?.id || recordsRef.current.find(r => r.key === key)?.id;
      if (!saved) { try { saved = localStorage.getItem(key) || undefined; } catch { /* In-memory records still work. */ } }
      const headers = { 'X-File-Name': encodeURIComponent(file.name), 'X-File-Size': String(file.size), 'X-File-SHA256': hash };
      setPhase(saved && !startNew ? 'Checking retained chunks with the host' : 'Preparing upload on the host');
      if (saved && !startNew) {
        current = current || { id: saved, key, name: file.name, size: file.size, retained: 0, phase: 'Checking', note: '' };
        state = await request(api, { path: '/transfers/' + saved + '/resume', method: 'POST', headers });
      } else state = await request(api, { path: '/transfers', method: 'POST', headers });
      current = { id: state.id, key, name: file.name, size: file.size, retained: state.retainedBytes, phase: 'Uploading', note: 'Transferring to the host workspace. Progress counts acknowledged bytes.' };
      if (startNew && target) persist(recordsRef.current.filter(r => r.id !== target.id));
      remember(key, state.id); fileCache.current.set(state.id, file); update(current);
      while (state.state !== 'completed' && state.nextIndex * state.chunkSize < file.size) {
        setPhase('Uploading · host-confirmed bytes');
        const offset = state.nextIndex * state.chunkSize;
        state = await request(api, { path: `/transfers/${state.id}/chunks/${state.nextIndex}`, method: 'PUT', bytes: await file.slice(offset, offset + state.chunkSize).arrayBuffer() });
        current = { ...current, retained: state.retainedBytes }; update(current);
      }
      if (state.state !== 'completed') {
        current = { ...current, phase: 'Verifying', note: 'All chunks acknowledged. Waiting for the host’s complete-file SHA-256 verification.' }; update(current); setPhase('Verifying · waiting for the host');
        state = await request(api, { path: '/transfers/' + state.id + '/complete', method: 'POST' });
      }
      if (state.state !== 'completed') throw new Error('The host has not confirmed completion.');
      update(fromServer(current, state)); setPhase('Completed · SHA-256 verified by the host');
      setSelected(null); fileCache.current.delete(state.id);
      await refreshFiles(); onComplete?.();
    } catch (error) {
      setPhase('Upload needs attention');
      if (current) {
        let record: Record = { ...current, phase: 'Interrupted', note: recovery(error), restart: error instanceof TransferError && [404, 410].includes(error.status) };
        try {
          const confirmed = await request(api, { path: '/transfers/' + current.id });
          record = fromServer(record, confirmed);
          if (confirmed.state === 'uploading') record.note = recovery(error);
          if (confirmed.state === 'completed') { setPhase('Completed · confirmed by host status'); await refreshFiles(); onComplete?.(); }
        } catch { /* Do not replace the last acknowledged byte count with guesses. */ }
        update(record);
      } else setMessage(recovery(error) + (key ? ' If the initial create response was lost, the server cannot identify that unacknowledged transfer; retrying may create a new record.' : ''));
    } finally { lock.current = false; setActive(false); onActiveChange?.(false); }
  }
  function resume(record: Record) {
    const cached = fileCache.current.get(record.id);
    if (cached) { void send(cached, record, record.restart); return; }
    resumeTarget.current = record;
    setMessage(`Select the same ${record.name} to ${record.restart ? 'start a new upload' : 'resume'}.`);
    input.current?.click();
  }
  async function getFile(path: string) { try { await download?.(path); setMessage('Download requested from the host. This is not a device-delivery confirmation.'); } catch (e) { setMessage((e as Error).message); } }
  return <section className={'omnidrop' + (dragging ? ' is-dragging' : '')} aria-label="OmniDrop file sharing"
    onDragEnter={event => { if (!event.dataTransfer.types.includes('Files')) return; event.preventDefault(); depth.current++; setDragging(true); }}
    onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = active ? 'none' : 'copy'; } }}
    onDragLeave={event => { event.preventDefault(); if (--depth.current <= 0) { depth.current = 0; setDragging(false); } }}
    onDrop={event => { event.preventDefault(); depth.current = 0; setDragging(false); resumeTarget.current = undefined; if (Array.from(event.dataTransfer.items).some(item => item.webkitGetAsEntry?.()?.isDirectory) || !event.dataTransfer.files.length) setMessage('Choose a file, not a folder.'); else choose(event.dataTransfer.files); }}>
    <input className="file-input" ref={input} type="file" aria-label="Choose a file to share or resume" disabled={active} onChange={event => { if (event.target.files) choose(event.target.files); event.target.value = ''; }}/>
    {dragging && <div className="drop-overlay" role="status"><Folder/><h2>{active ? 'An upload is in progress.' : 'A little closer. Drop it here.'}</h2><p>{active ? 'Keep this window open until it finishes.' : 'One file · up to 100 MB · shared through your host'}</p></div>}
    <div className="omni-heading"><p className="eyebrow">OMNIDROP / HOST-MEDIATED SHARING</p><button className="text-link" disabled={active || checking} onClick={() => { void refreshFiles(); void reconcile(); }}>Refresh files & activity</button></div>
    {storageWarning && <p className="error" role="status">{storageWarning}</p>}
    {message && <p className="error" role="alert">{message}</p>}
    <div className="omni-announcement" role="status" aria-live="polite">{phase}</div>
    {(view === 'Files' || selected) && <>
      {!selected ? <div className="drop-zone"><Folder/><h2>{files.length ? 'Make space for the next idea.' : 'A space to begin.'}</h2><p>Drop a file here. Keep the work close.</p><button className="button" disabled={active} onClick={() => { resumeTarget.current = undefined; input.current?.click(); }}>Choose a file <span aria-hidden="true">↗</span></button><p className="fine">One file at a time · up to 100 MB (100,000,000 bytes)</p></div> : <div className="selection"><div className="selected-file"><Folder/><div><h3>{selected.name}</h3><p>{bytes(selected.size)} · {selected.size.toLocaleString()} bytes · within the 100 MB limit</p></div><button className="text-link" disabled={active} onClick={() => { setSelected(null); }}>Remove selection</button></div><label className="destination">Destination<select disabled={active} defaultValue="workspace"><option value="workspace">Host workspace · all approved members</option></select></label><p className="fine">Files are uploaded to the host. Approved members can download them; selecting a private recipient or confirming device delivery is not supported.</p><div className="approved-audience"><span>Approved device sessions</span>{devices === undefined ? <p>Device details are available only to the host.</p> : devices.filter(d => d.expiresAt > Date.now()).length ? <ul>{devices.filter(d => d.expiresAt > Date.now()).map(d => <li key={d.id}>{d.deviceName}<small>Approved · presence unknown</small></li>)}</ul> : <p>No other approved sessions. The file will stay in the host workspace.</p>}</div><button className="button" disabled={active || checking} onClick={() => void send(selected)}>{active ? 'Transfer in progress…' : 'Send to workspace'} <span aria-hidden="true">→</span></button></div>}
    </>}
    {view === 'Files' && <>
      <div className="shared-heading"><h3>Shared files <span>{filesLoaded ? files.length : '—'}</span></h3><label>Find a file<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search files…"/></label></div>
      {fileError && <p role="alert" className="error">{fileError}</p>}
      {!filesLoaded && !fileError && <p role="status">Reading shared files…</p>}
      {filesLoaded && !files.length && <p className="fine">No shared files on the host yet.</p>}
      <div className="shared-files">{files.filter(f => f.name.toLowerCase().includes(query.toLowerCase())).map(f => <div key={f.path}><Folder/><span>{f.name}</span>{download ? <button className="text-link" onClick={() => void getFile(f.path)}>Download</button> : <a className="text-link" href={f.path} download={f.name}>Download</a>}</div>)}</div>
      {files.length > 0 && !files.some(f => f.name.toLowerCase().includes(query.toLowerCase())) && <p>No files match your search.</p>}
    </>}
    <section className="transfer-activity" aria-label="Transfer activity"><div className="shared-heading"><h3>{view === 'Transfers' ? 'Transfers' : 'Your activity'}</h3><span className="fine">Transfers started in this client · no delivery receipts</span></div>
      {!records.length && <div className="activity-empty"><h2>Nothing in transit.</h2><p>Real transfer activity appears here after the host accepts a file.</p>{view === 'Transfers' && <button className="button" disabled={active} onClick={() => { resumeTarget.current = undefined; input.current?.click(); }}>Choose a file</button>}</div>}
      {records.map(record => <article className="transfer-row" key={record.id}><div className="transfer-title"><div><h3>{record.name}</h3><p>{bytes(record.size)} <span aria-hidden="true">→</span> Host workspace · all approved members</p></div><strong className={'transfer-state state-' + record.phase.toLowerCase()}>{record.phase}</strong></div><progress value={record.retained} max={record.size || 1} aria-label={`${record.name}: host-confirmed bytes`} aria-valuetext={`${record.retained} of ${record.size} bytes acknowledged by host`}/><div className="transfer-detail"><span>{record.retained.toLocaleString()} / {record.size.toLocaleString()} bytes acknowledged</span><span>{record.size ? Math.floor(record.retained / record.size * 100) + '%' : record.phase === 'Completed' ? 'Verified empty file' : 'Empty file · awaiting verification'}</span></div><p className="transfer-note">{record.note}</p><div className="transfer-actions">{!['Completed','Uploading','Verifying','Preparing','Checking'].includes(record.phase) && <button className="button secondary" disabled={active || checking} onClick={() => resume(record)}>{record.restart ? 'Select file & start new upload' : fileCache.current.has(record.id) ? 'Resume transfer' : 'Select same file & resume'}</button>}<details><summary>Transfer details</summary><p>ID: <code>{record.id}</code><br/>File identity and SHA-256 are checked before resuming.<br/>Uploads run only while this window stays open. No pause or cancellation API is available.</p></details></div></article>)}
    </section>
  </section>;
}
