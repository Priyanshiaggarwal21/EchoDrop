import React, { useEffect, useRef, useState } from 'react';
import { bytes, fingerprint, newTransferId, LIMIT, request, sha256File, TransferError, type Transfer, type Transport } from './transfer-api';
import './omnidrop.css';
import { ProjectShare } from './ProjectShare';
import { withSharingCheck, type ScanResult } from '../../../packages/transfer/secret-scan.mjs';

type Phase = 'Checking' | 'Preparing' | 'Uploading' | 'Verifying' | 'Completed' | 'Interrupted' | 'Resumable' | 'Failed';
export type ActivityRecord = { updatedAt?: number | undefined; id: string; key: string; name: string; size: number; retained: number; phase: Phase; note: string; restart?: boolean; creating?: boolean };
type Device = { id: string; deviceName: string; expiresAt: number };
const journal = 'echodrop:omni:records:v1';
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function readRecords(): ActivityRecord[] {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(journal) || '[]');
    if (!Array.isArray(values)) return [];
    return values
      .filter((r): r is ActivityRecord =>
        r && idPattern.test(r.id) && typeof r.key === 'string' && r.key.startsWith('echodrop:transfer:') &&
        typeof r.name === 'string' && Number.isSafeInteger(r.size) && r.size >= 0 && r.size <= LIMIT)
      .slice(0, 100)
      .map(r => ({
        ...r,
        phase: 'Checking' as Phase,
        updatedAt: typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) && r.updatedAt > 0 && r.updatedAt < 8640000000000000 ? r.updatedAt : undefined,
        retained: Number.isSafeInteger(r.retained) && r.retained >= 0 && r.retained <= r.size ? r.retained : 0,
        note: 'Last acknowledged bytes shown; checking persisted transfer with the host.'
      }));
  } catch { return []; }
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="17 8 12 3 7 8"/>
      <line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19"/>
      <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  );
}

export function OmniDrop({
  api, view, devices, download, onComplete, onActiveChange, onSummary, mode = 'files'
}: {
  api: Transport;
  view: 'Share' | 'Receive' | 'Activity' | 'Home' | 'Workspace' | 'Connect' | 'Settings';
  mode?: 'files' | 'project';
  onSummary?: (records: ActivityRecord[], phase: string) => void;
  devices?: Device[];
  download?: (path: string) => Promise<void>;
  onComplete?: () => void;
  onActiveChange?: (active: boolean) => void
}) {
  const [records, setRecords] = useState<ActivityRecord[]>(readRecords);
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
  const resumeTarget = useRef<ActivityRecord | undefined>(undefined);
  const [files, setFiles] = useState<{ name: string; path: string }[]>([]);
  const [filesLoaded, setFilesLoaded] = useState(false);
  const [fileError, setFileError] = useState('');
  const [receiveRequest, setReceiveRequest] = useState<{ path: string } | null>(null);
  const [query, setQuery] = useState('');
  const [checking, setChecking] = useState(false);
  const alive = useRef(true);
  const reconciling = useRef(false);
  const [scanWarning, setScanWarning] = useState<{ file: File; result: ScanResult } | null>(null);
  const scanDecision = useRef<((allow: boolean) => void) | undefined>(undefined);
  useEffect(() => () => { scanDecision.current?.(false); }, []);
  function decideSharing(allow: boolean) {
    const resolve = scanDecision.current; scanDecision.current = undefined;
    setScanWarning(null);
    if (!allow) { setSelected(null); setPhase('Sharing cancelled. No new file bytes were uploaded.'); }
    resolve?.(allow);
  }
  useEffect(() => { onSummary?.(records, phase); }, [records, phase, onSummary]);
  const fileCache = useRef(new Map<string, File>());

  function persist(next: ActivityRecord[]) {
    recordsRef.current = next; setRecords(next);
    try { localStorage.setItem(journal, JSON.stringify(next)); }
    catch { setStorageWarning('Browser storage is unavailable. Keep this window open to retain resume references.'); }
  }
  function update(record: ActivityRecord) {
    const previous = recordsRef.current;
    persist(previous.some(r => r.id === record.id) ? previous.map(r => r.id === record.id ? record : r) : [record, ...previous]);
  }
  function remember(key: string, id: string) {
    try { localStorage.setItem(key, id); }
    catch { setStorageWarning('Resume is available in this window only; browser storage could not be saved.'); }
  }

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

  function fromServer(record: ActivityRecord, state: Transfer): ActivityRecord {
    return {
      ...record,
      creating: false,
      retained: state.retainedBytes,
      phase: state.state === 'completed' ? 'Completed' : state.state === 'failed' ? 'Failed' : 'Resumable',
      restart: state.state === 'failed',
      note: state.state === 'completed'
        ? 'SHA-256 verified by the host. Available to approved workspace members.'
        : state.state === 'failed'
          ? 'Host rejected this upload. Its chunks were discarded; a new upload is required.'
          : 'Host confirmed retained bytes. Select the same file to resume from its next chunk.'
    };
  }

  async function reconcile() {
    if (lock.current || reconciling.current) return;
    reconciling.current = true; setChecking(true);
    for (const record of recordsRef.current) {
      if (!alive.current || lock.current) break;
      try {
        const state = await request(api, { path: '/transfers/' + record.id });
        if (!lock.current) update(fromServer(record, state));
      } catch (e) {
        if (!lock.current) update({
          ...record, phase: e instanceof TransferError && [410, 422].includes(e.status) ? 'Failed' : 'Interrupted',
          restart: e instanceof TransferError && ([410, 422].includes(e.status) || (!record.creating && e.status === 404)),
          note: record.creating && !(e instanceof TransferError && [401, 403, 410, 422].includes(e.status)) ? 'Creation is not confirmed. Retry with the same file and transfer ID when the host is reachable.' : recovery(e)
        });
      }
    }
    reconciling.current = false; setChecking(false);
  }

  useEffect(() => {
    alive.current = true;
    void refreshFiles();
    void reconcile();
    const reconnect = () => { void refreshFiles(); void reconcile(); };
    const visible = () => { if (document.visibilityState === 'visible') reconnect(); };
    window.addEventListener('online', reconnect);
    document.addEventListener('visibilitychange', visible);
    return () => { alive.current = false; window.removeEventListener('online', reconnect); document.removeEventListener('visibilitychange', visible); };
  }, []);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (lock.current) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  function recovery(error: unknown) {
    if (error instanceof TransferError) {
      if ([401, 403].includes(error.status)) return 'Access expired or was revoked. Reopen the desktop app or rejoin with host approval, then resume the same file.';
      if ([410, 422].includes(error.status)) return 'Host rejected this upload after an integrity failure. Its chunks were discarded. Select the original file and explicitly start a new upload.';
      if (error.status === 404) return 'The host no longer has this transfer. Select the original file and explicitly start a new upload.';
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
    if (target && (target.name !== file.name || target.size !== file.size)) {
      setMessage(`Select the original ${target.name} (${bytes(target.size)}). The file hash will also be checked.`); return;
    }
    setSelected(file); setMessage(''); setPhase('');
    if (target) { resumeTarget.current = undefined; void send(file, target, target.restart); }
  }

  async function send(file: File, target?: ActivityRecord, startNew = false) {
    if (lock.current || reconciling.current) return;
    lock.current = true; setActive(true); onActiveChange?.(true); setMessage(''); setPhase('Checking file locally for sensitive content');
    let current: ActivityRecord | undefined = target;
    let state: Transfer | undefined;
    let key = '';
    try {
      await withSharingCheck(file, result => new Promise<boolean>(resolve => {
        setScanWarning({ file, result }); scanDecision.current = resolve;
        setPhase('Review required before sharing');
      }), async () => {
      if (!alive.current) return;
      setPhase('Preparing · calculating SHA-256');
      const hash = await sha256File(file); key = fingerprint(file, hash);
      if (target && target.key !== key) throw new Error('The selected file contents do not match this transfer. Select the original file.');
      current = target || recordsRef.current.find(r => r.key === key);
      let saved = current?.id;
      if (!saved) { try { saved = localStorage.getItem(key) || undefined; } catch { /* In-memory records still work. */ } }
      const headers = { 'X-File-Name': encodeURIComponent(file.name), 'X-File-Size': String(file.size), 'X-File-SHA256': hash };
      setPhase(saved && !startNew ? 'Checking retained chunks with the host' : 'Preparing upload on the host');
      if (saved && !startNew && !current?.creating) {
        current = current || { id: saved, key, name: file.name, size: file.size, retained: 0, phase: 'Checking', note: '' };
        state = await request(api, { path: '/transfers/' + saved + '/resume', method: 'POST', headers });
      } else {
        const id = !startNew && current?.creating ? current.id : newTransferId();
        const previous = target;
        current = { id, key, name: file.name, size: file.size, retained: 0, updatedAt: Date.now(), phase: 'Preparing', creating: true, note: 'Creation not yet confirmed. Retry will reuse this transfer ID.' };
        if (startNew && previous) persist(recordsRef.current.filter(r => r.id !== previous.id));
        remember(key, id); update(current); fileCache.current.set(id, file);
        state = await request(api, { path: '/transfers', method: 'POST', headers: { ...headers, 'X-Transfer-ID': id } });
      }
      current = { id: state.id, key, name: file.name, size: file.size, retained: state.retainedBytes, updatedAt: current?.updatedAt || Date.now(), phase: 'Uploading', note: 'Transferring to the host workspace. Progress counts acknowledged bytes.' };
      if (startNew && target) persist(recordsRef.current.filter(r => r.id !== target.id));
      remember(key, state.id); fileCache.current.set(state.id, file); update(current);
      while (state.state !== 'completed' && state.nextIndex * state.chunkSize < file.size) {
        setPhase('Uploading · host-confirmed bytes');
        const offset = state.nextIndex * state.chunkSize;
        state = await request(api, { path: `/transfers/${state.id}/chunks/${state.nextIndex}`, method: 'PUT', bytes: await file.slice(offset, offset + state.chunkSize).arrayBuffer() });
        current = { ...current, retained: state.retainedBytes }; update(current);
      }
      if (state.state !== 'completed') {
        current = { ...current, phase: 'Verifying', note: 'All chunks acknowledged. Waiting for the host\u2019s complete-file SHA-256 verification.' };
        update(current); setPhase('Verifying · waiting for the host');
        state = await request(api, { path: '/transfers/' + state.id + '/complete', method: 'POST' });
      }
      if (state.state !== 'completed') throw new Error('The host has not confirmed completion.');
      update(fromServer(current, state)); setPhase('Completed · SHA-256 verified by the host');
      setSelected(null); fileCache.current.delete(state.id);
      await refreshFiles(); onComplete?.();
      });
    } catch (error) {
      setPhase('Upload needs attention');
      if (current) {
        let record: ActivityRecord = { ...current, phase: error instanceof TransferError && [410, 422].includes(error.status) ? 'Failed' : 'Interrupted', note: recovery(error), restart: error instanceof TransferError && ([410, 422].includes(error.status) || (!current.creating && error.status === 404)) };
        try {
          const confirmed = await request(api, { path: '/transfers/' + current.id });
          record = fromServer(record, confirmed);
          if (confirmed.state === 'uploading') record.note = recovery(error);
          if (confirmed.state === 'completed') { setSelected(null); fileCache.current.delete(current.id); setPhase('Completed · confirmed by host status'); await refreshFiles(); onComplete?.(); }
        } catch { /* Do not replace the last acknowledged byte count with guesses. */ }
        if (record.creating && !record.restart && !(error instanceof TransferError && [401, 403].includes(error.status))) record.note = 'Creation is not confirmed. Retry with the same file and transfer ID when the host is reachable.';
        update(record);
      } else setMessage(recovery(error));
    } finally { lock.current = false; setActive(false); onActiveChange?.(false); }
  }

  function resume(record: ActivityRecord) {
    const cached = fileCache.current.get(record.id);
    if (cached) { void send(cached, record, record.restart); return; }
    resumeTarget.current = record;
    setMessage(`Select the same ${record.name} to ${record.restart ? 'start a new upload' : 'resume'}.`);
    input.current?.click();
  }

  async function getFile(path: string) {
    try { await download?.(path); setMessage('Download requested from the host. This is not a device-delivery confirmation.'); }
    catch (e) { setMessage((e as Error).message); }
  }

  const activeDevices = devices?.filter(d => d.expiresAt > Date.now()) ?? [];
  const filteredFiles = files.filter(f => f.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <section
      className={'omnidrop' + (dragging ? ' is-dragging' : '')}
      aria-label="OmniDrop file sharing"
      onDragEnter={event => { if (!event.dataTransfer.types.includes('Files')) return; event.preventDefault(); depth.current++; setDragging(true); }}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = active ? 'none' : 'copy'; } }}
      onDragLeave={event => { event.preventDefault(); if (--depth.current <= 0) { depth.current = 0; setDragging(false); } }}
      onDrop={event => {
        event.preventDefault(); depth.current = 0; setDragging(false); resumeTarget.current = undefined;
        if (Array.from(event.dataTransfer.items).some(item => item.webkitGetAsEntry?.()?.isDirectory) || !event.dataTransfer.files.length)
          setMessage('Choose a file, not a folder.');
        else choose(event.dataTransfer.files);
      }}
    >
      {/* Hidden file input */}
      <input
        className="file-input" ref={input} type="file"
        aria-label="Choose a file to share or resume"
        disabled={active}
        onChange={event => { if (event.target.files) choose(event.target.files); event.target.value = ''; }}
      />

      {/* Full-window drop overlay */}
      {dragging && (
        <div className="drop-overlay" role="status">
          <UploadIcon />
          <h2>{active ? 'An upload is in progress.' : 'Drop to share.'}</h2>
          <p>{active ? 'Keep this window open until it finishes.' : 'One file · up to 100 MB · shared through your host'}</p>
        </div>
      )}

      {/* Phase status */}
      {phase && <p className="omni-phase" role="status" aria-live="polite">{phase}</p>}

      {/* Storage / error notices */}
      {storageWarning && <p className="error omni-error" role="status">{storageWarning}</p>}
      {message && <p className="error omni-error" role="alert">{message}</p>}

      {scanWarning && (
        <section className="selected-panel" aria-label="Review sensitive file" aria-live="polite">
          <h3>Review before sharing</h3>
          <p>{scanWarning.file.name}</p>
          <ul>{[...scanWarning.result.categories, ...scanWarning.result.limitations].map(label => <li key={label}>{label}</li>)}</ul>
          <p className="fine">Local checks cannot find every secret. Sharing makes this file available to approved workspace members over plain HTTP.</p>
          <div className="send-row">
            <button className="button secondary" autoFocus onClick={() => decideSharing(false)}>Remove file / cancel</button>
            <button className="button" onClick={() => decideSharing(true)}>Share this file anyway</button>
          </div>
        </section>
      )}

      {/* ── Files view ── */}
      <div hidden={!((view === 'Share' && mode === 'project') || view === 'Receive')}><ProjectShare onInvalidate={() => { if (selected?.name.endsWith('.echoproject')) { setSelected(null); setPhase('Project changed. Prepare a new package before sending.'); } }} mode={view === 'Receive' ? 'receive' : 'share'} disabled={active || checking} receiveRequest={receiveRequest} onShare={file => { setSelected(file); resumeTarget.current = undefined; setPhase('Package prepared. Review the destination and select Send.'); }} /></div>

      {view === 'Share' && (mode === 'files' || selected) && (
        <>
          {/* Drop zone / selected file */}
          {!selected ? (
            <div className="drop-zone">
              <UploadIcon />
              <h2>{files.length ? 'Share another file.' : 'A space to begin.'}</h2>
              <p>Drop a file here, or choose one from your device.</p>
              <div className="drop-actions">
                <button className="button" disabled={active} onClick={() => { resumeTarget.current = undefined; input.current?.click(); }}>
                  <PlusIcon /> Add file
                </button>
              </div>
              <p className="fine">One file at a time · up to 100 MB · shared through your host</p>
            </div>
          ) : (
            <div className="selected-panel">
              <div className="selected-file-row">
                <FileIcon />
                <div className="selected-file-info">
                  <h3>{selected.name}</h3>
                  <p>{bytes(selected.size)} · {selected.size.toLocaleString()} bytes</p>
                </div>
                <button className="text-link" disabled={active} onClick={() => setSelected(null)}>Remove</button>
              </div>
              <label className="destination">
                Destination
                <select disabled={active} defaultValue="workspace">
                  <option value="workspace">Host workspace · all approved members</option>
                </select>
              </label>
              {devices !== undefined && (
                <div className="approved-audience">
                  <strong>Approved device sessions</strong>
                  {activeDevices.length
                    ? <ul>{activeDevices.map(d => <li key={d.id}><FileIcon />{d.deviceName}<small>Approved · presence unknown</small></li>)}</ul>
                    : <p className="fine">No other approved sessions. The file will stay in the host workspace.</p>
                  }
                </div>
              )}
              <div className="send-row">
                <p className="fine">Files are uploaded to the host. Approved members can download them.</p>
                <button className="button" disabled={active || checking} onClick={() => void send(selected)}>
                  {active ? 'Uploading…' : 'Send'} →
                </button>
              </div>
            </div>
          )}

        </>
      )}

      {view === 'Receive' && (
        <>
          <section className="incoming-panel"><h3>Incoming</h3><p>Files appear below after the host verifies completion. This service does not expose other devices’ in-progress uploads, sender details or per-file approvals.</p><p className="fine">Device approval is managed in Connect Device. Refresh to check for completed transfers.</p>{!window.echoDesktop && <p className="fine">On mobile, download .echoproject packages and extract them in EchoDrop desktop. Native extraction and Open Folder are unavailable here.</p>}</section>
          {/* Shared files table */}
          <div className="shared-heading">
            <h3>Received <span>{filesLoaded ? files.length : '…'}</span></h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div className="search-input">
                <SearchIcon />
                <input
                  type="search" value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search files…"
                  aria-label="Search shared files"
                />
              </div>
              <button
                className="text-link" style={{ fontSize: 12, color: 'var(--muted)' }}
                disabled={active || checking}
                onClick={() => { void refreshFiles(); void reconcile(); }}
              >Refresh</button>
            </div>
          </div>

          {fileError && <p role="alert" className="error omni-error">{fileError}</p>}
          {!filesLoaded && !fileError && <p style={{ padding: '0 28px', fontSize: 13, color: 'var(--muted)' }} role="status">Reading shared files…</p>}

          {filesLoaded && (
            files.length === 0 ? (
              <div style={{ padding: '0 28px 20px' }}>
                <p className="fine">No completed files in this workspace yet. Verified transfers appear here.</p>
              </div>
            ) : filteredFiles.length === 0 ? (
              <div style={{ padding: '0 28px 20px' }}>
                <p className="fine">No files match your search.</p>
              </div>
            ) : (
              <div className="file-table-wrap">
                <table className="file-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th className="col-muted">Type</th>
                      <th className="col-muted" style={{ textAlign: 'right' }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredFiles.map(f => {
                      const ext = f.name.includes('.') ? f.name.split('.').pop()?.toUpperCase() ?? '—' : '—';
                      return (
                        <tr key={f.path}>
                          <td>
                            <div className="col-name">
                              <FileIcon />
                              <span title={f.name}>{f.name}</span>
                            </div>
                          </td>
                          <td className="col-muted">{ext}</td>
                          <td className="col-action">
                            {f.name.toLowerCase().endsWith('.echoproject') && window.echoDesktop?.project && <button disabled={active || checking} onClick={() => setReceiveRequest({ path: f.path })}>Extract project</button>}

                            {download
                              ? <button onClick={() => void getFile(f.path)}>Download</button>
                              : <a href={f.path} download={f.name}>Download</a>
                            }
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          )}
        </>
      )}

      {/* ── Transfers view: empty state or upload prompt ── */}
      {view === 'Activity' && records.length === 0 && (
        <div className="activity-empty">
          <h2>Nothing in transit.</h2>
          <p>Real transfer activity appears here after the host accepts a file.</p>
          <p className="fine">Open Share to prepare your first transfer.</p>
        </div>
      )}

      {/* ── Transfer activity (shown in both views) ── */}
      {(view === 'Activity' ? records.length > 0 : view === 'Share' && records.some(r => r.phase !== 'Completed')) && (
        <section className="transfer-activity" aria-label="Transfer activity">
          <div className="shared-heading">
            <h3>{view === 'Activity' ? 'Recent Activity' : 'Transfer status'}</h3>
            <span className="fine">Started in this client · no delivery receipts</span>
          </div>
          {(view === 'Activity' ? records : records.filter(r => r.phase !== 'Completed')).map(record => (
            <article className="transfer-row" key={record.id}>
              <div className="transfer-title">
                <div>
                  <h3>{record.name}</h3>
                  <p>{record.updatedAt && <time dateTime={new Date(record.updatedAt).toISOString()}>{new Date(record.updatedAt).toLocaleString()} · </time>}{bytes(record.size)} → Host workspace · all approved members</p>
                </div>
                <strong className={'transfer-state state-' + record.phase.toLowerCase()}>{record.phase === 'Uploading' ? 'Transferring' : record.phase}</strong>
              </div>
              <progress
                value={record.retained} max={record.size || 1}
                aria-label={`${record.name}: host-confirmed bytes`}
                aria-valuetext={`${record.retained} of ${record.size} bytes acknowledged by host`}
              />
              <div className="transfer-detail">
                <span>{record.retained.toLocaleString()} / {record.size.toLocaleString()} bytes acknowledged</span>
                <span>{record.size ? Math.floor(record.retained / record.size * 100) + '%' : record.phase === 'Completed' ? 'Verified empty file' : 'Empty file · awaiting verification'}</span>
              </div>
              <p className="transfer-note">{record.note}</p>
              <div className="transfer-actions">
                {!['Completed', 'Uploading', 'Verifying', 'Preparing', 'Checking'].includes(record.phase) && (
                  <button className="button secondary" disabled={active || checking} onClick={() => resume(record)}>
                    {record.restart ? 'Select file & start new upload' : fileCache.current.has(record.id) ? 'Resume transfer' : 'Select same file & resume'}
                  </button>
                )}
                <details>
                  <summary>Transfer details</summary>
                  <p>ID: <code>{record.id}</code><br />File identity and SHA-256 are checked before resuming.<br />Uploads run only while this window stays open. No pause or cancellation API is available.</p>
                </details>
              </div>
            </article>
          ))}
        </section>
      )}
    </section>
  );
}
