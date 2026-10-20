import React, { useEffect, useRef, useState } from 'react';
import { LanDiagnostics } from './LanDiagnostics';
import { Devices } from './Devices';
import { pairingAPI as api, type HostState } from './pairing-api';
import './pairing.css';
type Method = 'QR code' | 'Manual' | 'ChirpPair';
const methods: Method[] = ['QR code', 'Manual', 'ChirpPair'];
const boot = () => window.EchoDropBootstrap;
const runtime = () => window.EchoDropOnboarding;
function Tabs({ value, change }: { value: Method; change: (method: Method) => void }) {
  return <nav className="pair-tabs" aria-label="Connection method">{methods.map(method => <button key={method} aria-current={value === method ? 'page' : undefined} className={value === method ? 'active' : ''} onClick={() => change(method)}>{method}</button>)}</nav>;
}
function AcousticMark({ state }: { state: string }) {
  const transmitting = state === 'Transmitting', listening = state === 'Listening';
  return <div className="acoustic-mark" data-active={transmitting || listening}><svg viewBox="0 0 160 76" fill="none" aria-hidden="true"><path d="M10 38h32m76 0h32M80 26v24M65 20v36m30-36v36M50 28v20m60-20v20" stroke="currentColor" strokeWidth="1.4"/><circle cx="80" cy="38" r="33" stroke="currentColor" strokeWidth=".7"/></svg><span>{state}</span></div>;
}
function Chirp({ host, payload, expiresAt, received, fallback }: { host: boolean; payload?: string; expiresAt?: number; received?: (payload: string) => void; fallback: () => void }) {
  const [state, setState] = useState('Ready');
  const [notice, setNotice] = useState('');
  const [consent, setConsent] = useState(false);
  const [active, setActive] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  function cancel() { generation.current++; controller.current?.abort(); controller.current = null; setActive(false); }
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  useEffect(() => { cancel(); setState('Ready'); setConsent(false); }, [payload]);
  useEffect(() => { if (!expiresAt) return; const timer = setTimeout(() => { cancel(); setState('Invitation expired'); setNotice('Create a fresh invitation before transmitting.'); }, Math.max(0, expiresAt - Date.now())); return () => clearTimeout(timer); }, [expiresAt]);
  async function begin() {
    cancel(); const run = generation.current; controller.current = new AbortController(); setConsent(false); setActive(true); setState('Preparing'); setNotice(host ? 'Preparing the invitation codec. Lower your speaker volume; do not use headphones.' : 'Requesting microphone permission and preparing the decoder.');
    const status = (text: string) => { if (run !== generation.current) return; setNotice(text); };
    const event = (value: string) => { if (run !== generation.current) return; setState(value); if (['Sent · reception unconfirmed', 'Timed out', 'Failed', 'Signal decoded · confirm invitation'].includes(value)) setActive(false); };
    try {
      if (host) { if (!payload || !expiresAt || expiresAt - Date.now() < 15000) throw new Error('Create a fresh invitation before playing a chirp.'); await runtime().transmit(payload, status, controller.current.signal, event); }
      else await runtime().listen(value => { if (run === generation.current) { setActive(false); setState('Signal decoded · confirm invitation'); received?.(value); } }, status, controller.current.signal, event);
    } catch (e) { if (run === generation.current) { setActive(false); setState('Unable to continue'); setNotice((e as Error).message); } }
  }
  const capture = host || runtime().mediaAvailable();
  return <div className="chirp-panel"><p className="eyebrow">CHIRPPAIR / AN INVITATION THROUGH SOUND</p><AcousticMark state={state}/><h2>{host ? 'A small signal. An open door.' : 'Bring your devices closer.'}</h2><p>Sound carries only a short-lived invitation and the host address. No files or persistent credentials.</p><p className="fine">Silent-first pairing is unavailable: this runtime has no verified ultrasonic hardware path. Browser feature detection cannot verify speakers or microphones. Even 18–20 kHz can be audible, especially to younger people.</p>
    {!capture ? <p className="error">Microphone capture is unavailable on this HTTP page. On Android, use a QR image, your phone camera app, or manual entry.</p> : <><p className="fine">One experimental audible mode is available: ggwave Audible Fast, encoded at 10% amplitude with a 0.5 playback gain. Digital codec tests do not verify acoustic reliability or physical loudness.</p>{consent ? <div className="chirp-consent"><p>{host ? 'Silent pairing is unavailable on this setup. Would you like to try a soft audible chirp?' : 'Listen for an audible invitation? Microphone access lasts up to 30 seconds; audio is not recorded or uploaded.'}</p><div className="actions"><button className="button" onClick={() => void begin()}>Yes</button><button className="button secondary" onClick={() => { cancel(); fallback(); }}>No · use QR/manual</button></div></div> : <div className="actions"><button className="button" disabled={active || (host && (!payload || !expiresAt || expiresAt <= Date.now()))} onClick={() => setConsent(true)}>{host ? 'Try a soft audible chirp' : 'Enable microphone'}</button>{active && <button className="button secondary" onClick={() => { cancel(); setState('Cancelled'); setNotice('Capture/playback stopped. No connection was confirmed.'); }}>Stop</button>}</div>}</>}
    <p role="status" aria-live="polite">{notice}</p><button className="text-link" onClick={() => { cancel(); fallback(); }}>Use QR or manual entry instead →</button>
  </div>;
}
function Invite() {
  const [method, setMethod] = useState<Method>('QR code');
  const [hosts, setHosts] = useState<string[]>([]);
  const [host, setHost] = useState('');
  const hostRef = useRef('');
  const [interfaces, setInterfaces] = useState<NonNullable<HostState['lanInterfaces']>>([]);
  function selectHost(value: string) { hostRef.current = value; setHost(value); setInvitation(null); }
  const [invitation, setInvitation] = useState<{ token: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const valid = invitation && invitation.expiresAt > now;
  const payload = valid && host ? boot().create(host, invitation.token) : '';
  async function refreshAddresses() {
    try {
      const state = await api<HostState>('/host/state');
      setHosts(state.lanUrls); setInterfaces(state.lanInterfaces || []);
      if (!state.lanUrls.includes(hostRef.current)) {
        const changed = Boolean(hostRef.current);
        selectHost(state.lanUrls.length === 1 && !state.lanInterfaces?.[0]?.linkLocal ? state.lanUrls[0]! : '');
        if (changed) setNotice('The selected address is no longer available. Confirm the current Wi-Fi adapter and create a fresh invitation.');
      }
      return state;
    } catch (e) { setHosts([]); setInterfaces([]); selectHost(''); setNotice((e as Error).message); return null; }
  }
  useEffect(() => { void refreshAddresses(); const timer = setInterval(() => setNow(Date.now()), 1000); const network = setInterval(() => void refreshAddresses(), 10000); return () => { clearInterval(timer); clearInterval(network); }; }, []);
  useEffect(() => { if (canvas.current && payload && method === 'QR code') { try { runtime().drawQR(canvas.current, payload); } catch (e) { setNotice((e as Error).message); } } }, [payload, method]);
  async function create() { setBusy(true); setInvitation(null); try { const selected = hostRef.current; const network = await refreshAddresses(); if (!network || !selected || !network.lanUrls.includes(selected)) throw new Error('Select a current host Wi-Fi address before creating an invitation.'); const fresh = await api<{ token: string; expiresAt: number }>('/host/invitations', {}); if (hostRef.current !== selected) throw new Error('The network address changed while creating the invitation. Confirm the current address and try again.'); setInvitation(fresh); setNow(Date.now()); setNotice('Invitation created. Single use, valid for two minutes; host approval is still required.'); } catch (e) { setNotice((e as Error).message); } finally { setBusy(false); } }
  return <section className="invite-panel" id="invite"><p className="eyebrow">BRING ANOTHER DEVICE INTO YOUR SPACE</p><h2>A welcome, on your terms.</h2><label>Host LAN address<select disabled={busy} value={host} onChange={e => selectHost(e.target.value)}><option value="">Select the adapter on your phone’s network</option>{hosts.map(url => <option key={url} value={url}>{interfaces.find(item => item.origin === url)?.name || 'LAN'} · {url}{interfaces.find(item => item.origin === url)?.linkLocal ? ' · link-local, check Wi-Fi addressing' : ''}</option>)}</select></label><button className="text-link" disabled={busy} onClick={() => void refreshAddresses()}>Refresh host addresses</button><LanDiagnostics origin={host || undefined}/>{!hosts.length && <p className="error">No private IPv4 LAN address is available. Connect the host to the same trusted network as your other device, then refresh host addresses.</p>}<Tabs value={method} change={setMethod}/>
    <div className="invitation-meta"><button className="button" disabled={busy || !host} onClick={() => void create()}>{busy ? 'Creating invitation…' : invitation ? 'Create a fresh invitation' : 'Create invitation'}</button><span role="status">{invitation ? valid ? `${Math.ceil((invitation.expiresAt - now) / 1000)}s until expiry · single use` : 'Invitation expired' : 'No active invitation'}</span></div>
    {method === 'QR code' && <div className="qr-panel">{payload ? <canvas ref={canvas} aria-label="Single-use workspace invitation QR code"/> : <p>Create an invitation to show its QR code.</p>}<p>Scan with your phone camera, then confirm the host and request access.</p></div>}
    {method === 'Manual' && <div className="manual-invite"><p>On the other device, open the address below and enter the invitation token.</p><label>Join address<input readOnly value={host ? host + '/join' : ''} onFocus={e => e.target.select()}/></label><label>Invitation token<textarea readOnly value={payload && invitation ? invitation.token : ''} onFocus={e => e.target.select()} rows={3}/></label><p className="fine">Share only with the person you intend to invite. Creating a fresh invitation does not revoke earlier ones; each expires independently.</p></div>}
    {method === 'ChirpPair' && <Chirp host payload={payload} {...(invitation ? { expiresAt: invitation.expiresAt } : {})} fallback={() => setMethod('QR code')}/>}
    <p role="status">{notice}</p><p className="fine">A displayed invitation may already have been used; the server enforces single-use validation. Plain HTTP LAN traffic is not encrypted or MITM-safe.</p>
  </section>;
}
export function PairingPage({ host }: { host: boolean }) {
  const [theme, setTheme] = useState(() => { try { const value = localStorage.getItem('echodrop-theme'); return value === 'light' || value === 'dark' ? value : 'system'; } catch { return 'system'; } });
  useEffect(() => { const media = matchMedia('(prefers-color-scheme: dark)'); const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; }; apply(); media.addEventListener('change', apply); try { localStorage.setItem('echodrop-theme', theme); } catch {} return () => media.removeEventListener('change', apply); }, [theme]);
  return <><header className="topbar"><a className="wordmark" href="/">echodrop.</a><span className="workspace-label">{host ? 'DEVICES & INVITATIONS' : 'JOIN A LOCAL WORKSPACE'}</span><div className="header-end"><label className="theme-control"><span>Appearance</span><select aria-label="Appearance" value={theme} onChange={e => setTheme(e.target.value)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label></div></header><main className="pair-page">{host ? <><div className="section-heading"><h1>Make a connection.</h1><a className="text-link" href="/host">Advanced host / LivePreview controls</a></div><Devices api={api} invite={() => { document.getElementById('invite')?.scrollIntoView(); document.querySelector<HTMLSelectElement>('#invite select')?.focus(); }}/><Invite/></> : <><Join/><LanDiagnostics origin={location.origin}/></>}<p className="fine">Same local network. Host approval required. Plain HTTP is not encrypted; use a trusted network.</p><a className="text-link" href="/onboarding/licenses.txt">Third-party notices</a></main></>;
}
function Join() {
  const [method, setMethod] = useState<Method>('QR code');
  const [host, setHost] = useState(location.origin);
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [destination, setDestination] = useState('');
  const [notice, setNotice] = useState('');
  const [state, setState] = useState('Ready');
  const [pending, setPending] = useState<{ id: string; state: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const capture = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const checking = useRef(false);
  const mounted = useRef(true);
  function stopCamera() { sequence.current++; capture.current?.abort(); setCameraActive(false); }
  function received(value: string) {
    try { const invitation = boot().parse(value); stopCamera(); setHost(invitation.host); setToken(invitation.token); setState('Invitation decoded · confirm host'); setNotice('Confirm this host address with the person inviting you. No request has been sent.'); setDestination(invitation.host !== location.origin ? value : ''); }
    catch (e) { setNotice((e as Error).message); }
  }
  async function check(quiet = false) {
    if (checking.current) return; checking.current = true;
    try {
      const result = await api<{ id: string; state: string; expiresAt: number }>('/auth/join-status');
      if (!mounted.current) return; setPending(result);
      if (result.state === 'approved') {
        setState('Host approved · confirming session');
        await api('/auth/claim', {});
        const response = await fetch('/', { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('Session could not be confirmed. Rejoin with a fresh invitation.');
        if (mounted.current) { setPending(null); setToken(''); setDestination(''); setState('Connected'); setNotice('Host authorization and workspace access confirmed.'); }
      } else if (result.state === 'rejected') { setState('Request rejected'); setPending(null); setNotice('The host rejected this request. Ask for a fresh invitation to try again.'); }
      else { setState('Awaiting host approval'); setNotice('Compare the request ID below with your host.'); }
    } catch (e) {
      // A claim response can be lost after the session cookie was accepted.
      // Confirm actual workspace access instead of replaying or inventing approval.
      let authorized = false;
      try { authorized = (await fetch('/', { signal: AbortSignal.timeout(10000) })).ok; } catch { /* Keep the recovery message. */ }
      if (mounted.current && authorized) { setPending(null); setToken(''); setDestination(''); setState('Connected'); setNotice('Your existing authorized session can access this workspace.'); }
      else if (mounted.current && !quiet) { setNotice((e as Error).message); setState('Approval check needs attention'); }
    }
    finally { checking.current = false; }
  }
  useEffect(() => { mounted.current = true; const fragment = location.hash; if (fragment) { history.replaceState(null, '', '/join'); received(location.origin + '/join' + fragment); } else void check(true); return () => { mounted.current = false; sequence.current++; capture.current?.abort(); }; }, []);
  useEffect(() => { if (!pending || pending.state !== 'pending') return; const timer = setInterval(() => { if (Date.now() >= pending.expiresAt) { setState('Request expired'); setNotice('Ask the host for a fresh invitation.'); setPending(null); } else void check(); }, 3000); return () => clearInterval(timer); }, [pending?.id, pending?.state]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); stopCamera();
    try {
      let invitationToken = token.trim(); let origin = host;
      if (invitationToken.startsWith('http:')) { const parsed = boot().parse(invitationToken); origin = parsed.host; invitationToken = parsed.token; }
      else invitationToken = boot().token(invitationToken);
      if (origin !== location.origin) { received(boot().create(origin, invitationToken)); return; }
      const result = await api<{ id: string; state: string; expiresAt: number }>('/auth/join', { invitationToken, deviceName: name.trim() });
      setToken(''); setDestination(''); setPending(result); setState('Awaiting host approval'); setNotice('Your request was received. Confirm its ID with the host.');
    } catch (e) { setState('Unable to request access'); setNotice((e as Error).message); } finally { setBusy(false); }
  }
  async function camera() {
    stopCamera(); const run = sequence.current; capture.current = new AbortController(); setCameraActive(true); setState('Requesting camera permission');
    try { await runtime().camera(video.current!, value => { if (run === sequence.current) received(value); }, message => { if (run === sequence.current) { setNotice(message); if (message.startsWith('Camera stopped')) { setCameraActive(false); setState('Camera timed out'); } } }, capture.current.signal); if (run === sequence.current) setState('Camera scanning'); }
    catch (e) { if (run === sequence.current) { setCameraActive(false); setState('Camera unavailable'); setNotice((e as Error).message); } }
  }
  const canCapture = runtime().mediaAvailable();
  return <section className="join-panel"><p className="eyebrow">YOUR DEVICE. THE SAME SPACE.</p><h1>Come on in.</h1><p>Get an invitation from the host. Choose how to bring it here.</p><p className="join-state" role="status">{state}</p><p role="status" aria-live="polite">{notice}</p>
    {state === 'Connected' ? <a className="button" href="/">Enter workspace →</a> : pending ? <div className="waiting-panel"><h2>Your host has the next step.</h2><p className="request-id">Compare this request ID:<code>{pending.id}</code></p><p className="fine">Expires {new Date(pending.expiresAt).toLocaleTimeString()}. Approval is required; receiving a signal is not a connection.</p><button className="button secondary" onClick={() => void check()}>Check approval</button><p className="fine">You can close this page to stop checking. The pending request remains on the host until it expires or is decided.</p></div> : <><Tabs value={method} change={value => { stopCamera(); setMethod(value); }}/>
    {method === 'QR code' && <div className="qr-panel"><h2>A scan away.</h2><label className="qr-file-label">Choose a QR image<input type="file" accept="image/png,image/jpeg,image/webp" capture="environment" onChange={async event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; try { received(await runtime().scanFile(file)); } catch (e) { setNotice((e as Error).message); } }}/></label><p className="fine">PNG, JPEG or WebP · up to 8 MiB. Your phone’s camera app can also open the QR invitation directly.</p><video ref={video} autoPlay muted playsInline hidden={!cameraActive}/>{canCapture ? <div className="actions"><button className="button secondary" disabled={cameraActive} onClick={() => void camera()}>Use live camera</button>{cameraActive && <button className="text-link" onClick={() => { stopCamera(); setState('Camera stopped'); }}>Stop camera</button>}</div> : <p className="fine">Live camera/microphone access is unavailable on this HTTP page. QR image upload and manual entry work without it.</p>}</div>}
    {method === 'ChirpPair' && <Chirp host={false} received={received} fallback={() => setMethod('Manual')}/>}
    <form className="join-form" onSubmit={submit}><h3>{token ? 'Confirm your invitation.' : 'Enter your invitation.'}</h3><label>Host LAN address<input type="url" required value={host} onChange={e => { setHost(e.target.value); setDestination(''); }}/></label><label>Invitation token or QR invitation URL<input type="password" required autoComplete="off" value={token} onChange={e => { setToken(e.target.value); setDestination(''); }}/></label><label>Your device label<input required maxLength={64} autoComplete="off" value={name} onChange={e => setName(e.target.value)} placeholder="A name your host will recognize"/></label><p className="fine">Your label does not verify your identity. Confirm the request ID with the host before approval.</p><button className="button" disabled={busy}>{busy ? 'Requesting access…' : 'Confirm host & request access'}</button></form>{destination && <div className="error"><p>This invitation belongs to {host}. Confirm the address with the host before continuing. No token has been submitted to another server.</p><a className="text-link" href={destination} rel="noreferrer">Open this host’s join page →</a></div>}</>}
  </section>;
}
