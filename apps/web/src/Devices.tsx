import React, { useEffect, useState } from 'react';
import { LanDiagnostics } from './LanDiagnostics';
import { type HostState, type PairAPI } from './pairing-api';
import './pairing.css';
export function Devices({ api, invite }: { api: PairAPI; invite: () => void }) {
  const [state, setState] = useState<HostState | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  async function refresh() { try { setState(await api<HostState>('/host/state')); setError(''); } catch (e) { setState(null); setError((e as Error).message); } }
  useEffect(() => { void refresh(); const timer = setInterval(refresh, 5000); return () => clearInterval(timer); }, []);
  async function act(id: string, action: 'approve' | 'reject' | 'revoke') {
    setBusy(true); setNotice('');
    try { await api(`/host/${action === 'revoke' ? 'sessions' : 'joins'}/${id}/${action}`, {}); setConfirmed(null); setNotice(action === 'approve' ? 'Request approved. The joining device must claim its session before it appears below.' : action === 'reject' ? 'Request rejected. The person can ask for a new invitation.' : 'Session access revoked by the host.'); await refresh(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="device-panel"><div className="section-intro"><p>People you approve.<br/>A space you share.</p><button className="button" onClick={invite}>Invite a device <span aria-hidden="true">↗</span></button></div>
    <LanDiagnostics/>
    <p className="fine">Device labels are self-reported. Compare the full request ID with the person before approval. An approved session does not confirm that a device is online.</p>
    {error && <p className="error" role="alert">{error} <button className="text-link" disabled={busy} onClick={() => void refresh()}>Retry</button></p>}<p role="status">{notice}</p>
    {!state && !error && <p role="status">Checking host sessions…</p>}
    {state && <><div className="pair-section-title"><h3>Waiting for you <span>{state.requests.length}</span></h3><button className="text-link" disabled={busy} onClick={() => void refresh()}>Refresh</button></div>
    {!state.requests.length && <p className="fine">No pending requests. Share an invitation to begin.</p>}
    {state.requests.map(device => <article className="device-row" key={device.id}><div><h3>{device.deviceName}</h3><span className="pair-label">{device.expiresAt <= Date.now() ? 'Request expired' : 'Awaiting host approval'}</span><p className="request-id">Request ID <code>{device.id}</code></p><p className="fine">Expires {new Date(device.expiresAt).toLocaleTimeString()}</p><label className="identity-check"><input type="checkbox" checked={confirmed === device.id} onChange={e => setConfirmed(e.target.checked ? device.id : null)}/>I confirmed this request ID with the person.</label></div><div className="actions"><button className="button" disabled={busy || confirmed !== device.id || device.expiresAt <= Date.now()} onClick={() => void act(device.id, 'approve')}>Approve</button><button className="button secondary" disabled={busy || device.expiresAt <= Date.now()} onClick={() => void act(device.id, 'reject')}>Reject</button></div></article>)}
    <div className="pair-section-title"><h3>Approved sessions <span>{state.devices.length}</span></h3></div>
    {!state.devices.length && <div className="device-empty"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" aria-hidden="true"><path d="M5 8h27v22H5zM12 37h13m-6-7v7m17-17h8v20H33V20h3"/></svg><h2>Make room for someone.</h2><p>No approved device sessions.<br/>Invite a nearby device, then confirm its request.</p></div>}
    {state.devices.map(device => <article className="device-row" key={device.id}><div><h3>{device.deviceName}</h3><span className="pair-label">{device.expiresAt <= Date.now() ? 'Session expired' : 'Approved · presence unknown'}</span><p className="request-id">Session ID <code>{device.id}</code></p><p className="fine">Access expires {new Date(device.expiresAt).toLocaleTimeString()}</p></div><button className="text-link" disabled={busy || device.expiresAt <= Date.now()} onClick={() => void act(device.id, 'revoke')}>Revoke access</button></article>)}
    <p className="fine">The host exposes pending requests and active authorization sessions. Rejected, revoked and expired entries are not retained as a connection history.</p></>}
  </section>;
}
