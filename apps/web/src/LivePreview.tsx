import React, { useEffect, useRef, useState } from 'react';
import { pairingAPI } from './pairing-api';
import './preview.css';
export type Project = { name: string; directory: string; entry: string };
type Grant = { url: string; expiresAt: number };
type PreviewState = { running: boolean; port?: number; project?: Project | null; lanUrls?: string[]; grant?: Grant | null };
export type PreviewBridge = (action: 'status' | 'select' | 'start' | 'refresh' | 'open' | 'grant' | 'stop', kind?: 'folder' | 'html') => Promise<PreviewState | Project | null>;
export function LivePreview({ native, host = false, visible }: { native?: PreviewBridge; host?: boolean; visible: boolean }) {
  const [state, setState] = useState<PreviewState | null>(null);
  const [selected, setSelected] = useState<Project | null>(null);
  const [directory, setDirectory] = useState('');
  const [entry, setEntry] = useState('index.html');
  const [grant, setGrant] = useState<Grant | null>(null);
  const [shareHost, setShareHost] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(Date.now());
  const loaded = useRef(false);
  const activePort = useRef<number | undefined>(undefined);
  const browserProject = useRef<Project | null>(null);
  const hostControl = Boolean(native) || host;
  async function refreshState() {
    if (lock.current || !hostControl) return;
    try {
      const value = native ? await native('status') as PreviewState | null : await pairingAPI<{ preview: PreviewState; lanUrls: string[] }>('/host/state').then(data => ({ ...data.preview, lanUrls: data.lanUrls }));
      if (!value) return;
      if (!value.running || activePort.current !== value.port) { setGrant(null); browserProject.current = null; }
      activePort.current = value.port;
      setState(native ? value : { ...value, project: browserProject.current });
    } catch (e) { setState(null); setGrant(null); setError((e as Error).message); }
  }
  useEffect(() => { if (visible) { loaded.current = true; void refreshState(); } }, [visible, hostControl]);
  useEffect(() => { const timer = setInterval(() => { setNow(Date.now()); if (loaded.current && !lock.current) void refreshState(); }, 5000); return () => clearInterval(timer); }, [hostControl]);
  function accept(value: PreviewState) { setState(value); activePort.current = value.port; if (value.grant) setGrant(value.grant); }
  async function choose(kind: 'folder' | 'html') {
    if (!native || lock.current) return; lock.current = true; setBusy(true); setError('');
    try { const result = await native('select', kind) as Project | null; if (result) { setSelected(result); setEntry(result.entry); setNotice('Project selected. Nothing has started yet.'); } }
    catch (e) { setError((e as Error).message); } finally { lock.current = false; setBusy(false); }
  }
  async function issueBrowserGrant() {
    if (!/^[^/\\\x00-\x1f<>:"|?*]+\.html?$/i.test(entry) || entry.startsWith('.')) throw new Error('Use a plain HTML entry filename, such as index.html.');
    const value = await pairingAPI<Grant>('/preview/grant', {});
    const url = new URL(value.url);
    if (url.protocol !== 'http:' || url.hostname !== location.hostname || !/^\/p\/[a-f0-9]{64}\/$/.test(url.pathname)) throw new Error('Unexpected preview address.');
    url.pathname += encodeURIComponent(entry);
    const access = { ...value, url: url.href }; setGrant(access); return access;
  }
  async function operate(action: 'start' | 'refresh' | 'grant' | 'open' | 'stop') {
    if (lock.current) return; lock.current = true; setBusy(true); setError(''); setNotice(action === 'start' ? 'Starting the selected static project…' : action === 'stop' ? 'Stopping preview and invalidating access…' : 'Checking preview access…');
    try {
      if (native) {
        const value = await native(action) as PreviewState;
        if (action !== 'open') accept(value);
        if (action === 'stop') { setGrant(null); setNotice('Preview stopped. Its port is closed and all access links are invalid.'); }
        else setNotice(action === 'grant' ? 'A new session-bound access link is ready.' : 'Preview opened in its isolated window. Use Refresh to load saved changes.');
      } else if (action === 'stop') {
        await pairingAPI('/host/preview/stop', {}); setState({ running: false }); setGrant(null); browserProject.current = null; activePort.current = undefined; setNotice('Preview stopped. All previous access links are invalid.');
      } else {
        if (action === 'start') {
          const value = await pairingAPI<PreviewState>('/host/preview/start', { directory });
          browserProject.current = { name: directory.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || directory, directory, entry };
          accept({ ...value, project: browserProject.current });
        }
        await issueBrowserGrant();
        setNotice('Access link ready. Open it in a separate tab to view the actual project. Browser isolation prevents this workspace from inspecting its content.');
      }
    } catch (e) {
      setError((e as Error).message); setNotice(''); setGrant(null);
      if (native || host) { lock.current = false; await refreshState(); lock.current = true; }
    } finally { lock.current = false; setBusy(false); setNow(Date.now()); }
  }
  const valid = grant && grant.expiresAt > now;
  let shareURL = grant?.url || '';
  if (shareURL && shareHost && state?.lanUrls?.includes(shareHost)) { const url = new URL(shareURL); url.hostname = new URL(shareHost).hostname; shareURL = url.href; }
  return <section className="preview-panel" aria-label="LivePreview controls"><div className="preview-intro"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M4 8h40v32H4zM4 16h40M19 23l-6 5 6 5m10-10 6 5-6 5M26 21l-4 14"/></svg><div><p className="eyebrow">LIVEPREVIEW / ONLY WHEN YOU NEED IT</p><h2>See your work.<br/>In its own space.</h2><p>Preview a local static HTML, CSS and JavaScript project. Start it deliberately, refresh saved changes, stop when you’re done.</p></div></div>
    <div className="preview-status" role="status"><span className={'preview-indicator ' + (state?.running ? 'running' : '')}/>{busy ? 'Working…' : hostControl ? state ? state.running ? 'Preview service running' : 'Preview stopped' : 'Preview status unavailable' : 'Guest access · request a link from this workspace'}</div>
    {error && <p className="error" role="alert">{error}</p>}<p className="preview-notice" role="status" aria-live="polite">{notice}</p>
    {hostControl && <div className="preview-project"><div className="pair-section-title"><h3>{state?.running ? 'Choose the next project' : 'Choose a project'}</h3><span className="fine">Host only</span></div>
      {native ? <><div className="actions"><button className="button secondary" disabled={busy} onClick={() => void choose('folder')}>Choose project folder</button><button className="text-link" disabled={busy} onClick={() => void choose('html')}>Choose HTML entry file</button></div>{selected && <dl className="preview-facts"><div><dt>Selected project</dt><dd>{selected.name}</dd></div><div><dt>Entry</dt><dd>{selected.entry}</dd></div><div><dt>Folder</dt><dd>{selected.directory}</dd></div></dl>}</> : <div className="preview-paths"><label>Local project directory on the host<input value={directory} onChange={e => setDirectory(e.target.value)} placeholder="Absolute path to your static project" disabled={busy}/></label><label>HTML entry filename<input value={entry} onChange={e => { setEntry(e.target.value); setGrant(null); }} disabled={busy}/></label><p className="fine">A browser cannot choose folders on the host. Use the Windows app’s picker or enter a local host directory. Entry-file availability is checked when you open the isolated preview tab.</p></div>}
      <p className="fine">The selected folder’s permitted static files become previewable. Select a project intended for sharing, not a parent folder containing unrelated work. Folder selection uses index.html.</p><button className="button" disabled={busy || (native ? !selected : !directory.trim())} onClick={() => void operate('start')}>{state?.running ? 'Start selected project & replace preview' : 'Start preview'}</button>
    </div>}
    {!hostControl && <div className="preview-paths"><p>Your host must start a project first. Each member requests their own short-lived access grant.</p><label>HTML entry filename supplied by the host<input value={entry} onChange={e => { setEntry(e.target.value); setGrant(null); }}/></label></div>}
    {(state?.running || !hostControl) && <div className="preview-session"><div className="pair-section-title"><h3>{state?.project ? state.project.name : 'Preview access'}</h3><span className="fine">Separate LAN origin</span></div>{state?.project && <dl className="preview-facts"><div><dt>{native ? 'Verified entry' : 'Requested entry'}</dt><dd>{state.project.entry}</dd></div><div><dt>Project folder</dt><dd>{state.project.directory}</dd></div></dl>}
      {state?.running && !state.project && <p className="fine">A preview is running, but this client has no verified project metadata. The backend reports only the port and running state.</p>}
      <div className="actions"><button className="button" disabled={busy} onClick={() => void operate('refresh')}>{native ? 'Refresh preview' : 'Refresh access link'}</button>{native && valid && <button className="button secondary" disabled={busy} onClick={() => void operate('open')}>Open preview window</button>}{hostControl && <button className="text-link" disabled={busy} onClick={() => void operate('stop')}>Stop preview</button>}</div>
      {grant && <div className={'preview-reveal ' + (valid ? 'ready' : 'expired')}><p className="eyebrow">{valid ? 'ACCESS READY' : 'ACCESS EXPIRED'}</p><p>{valid ? `Access expires at ${new Date(grant.expiresAt).toLocaleTimeString()}.` : 'This five-minute access grant has expired. Refresh to request a new one.'}</p>{!native && valid && <a className="button" href={grant.url} target="_blank" rel="noopener noreferrer">Open isolated preview ↗</a>}<p className="fine">{native ? 'The native preview window closes when this grant expires.' : 'Refresh this access link, then reopen the tab to load saved changes. Missing files, stopped services and expired sessions are reported by the preview tab.'}</p>{valid && <><label>Preview address<input readOnly value={grant.url} onFocus={e => e.target.select()}/></label>{Boolean(state?.lanUrls?.length) && <label>Share using this LAN address<select value={shareHost} onChange={e => setShareHost(e.target.value)}><option value="">This computer’s address</option>{state?.lanUrls?.map(url => <option key={url}>{url}</option>)}</select></label>}{shareHost && state?.lanUrls?.includes(shareHost) && <label>Short-lived shared link<input readOnly value={shareURL} onFocus={e => e.target.select()}/></label>}<p className="fine">Treat a preview link as temporary access. It is tied to the issuing session and stops working when that session expires or is revoked. Prefer inviting a device so it can request its own grant. Localhost links work only on this computer.</p></>}</div>}
    </div>}
    <details className="preview-boundaries"><summary>What this preview supports</summary><p>Static HTML/CSS/JavaScript and permitted local assets, up to 100 MB per file. No build server, directory listings, filesystem links, private files, automatic reload or client-presence reporting.</p><p>Pages open separately because framing is blocked. The existing sandbox blocks network requests, forms, workers, nested frames and browser storage. LAN transport is plain HTTP, not encrypted HTTPS.</p><p>If the host disconnects or a port closes, loaded content may remain visible until the next request. Refresh checks access again; this interface never assumes that a remote client is still connected.</p></details>
  </section>;
}
