import React, { useCallback, useEffect, useRef, useState } from 'react';
import { OmniDrop, type ActivityRecord } from './OmniDrop';
import { Devices } from './Devices';
import { LivePreview } from './LivePreview';
import { WelcomePage } from './WelcomePage';
import { ProjectHub } from './ProjectHub';
import { readNavigation, planNavigation, type Area, type Navigation, type ProjectSection } from './navigation.mjs';
import { browserTransport, bytes } from './transfer-api';
import { pairingAPI, type HostState } from './pairing-api';
import './styles.css';
import './workspace.css';
import './projects.css';

const toolAreas: Area[] = ['Home', 'Connect', 'Share', 'Receive', 'Activity', 'Workspace', 'Settings'];

function currentNavigation(): Navigation { return readNavigation(window.history.state); }
function saved(key: string, fallback: string) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function save(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* Session preferences still apply. */ } }
export function WorkspaceApp({ lan = false }: { lan?: boolean }) {
  const desktop = window.echoDesktop;
  const [navigation, setNavigation] = useState(currentNavigation);
  const welcome = navigation.screen === 'Welcome';
  const area: Area = welcome ? 'Home' : navigation.screen as Area;
  const mode = navigation.mode;
  const [theme, setTheme] = useState(() => saved('echodrop-theme', 'system'));
  const [motion, setMotion] = useState(() => saved('echodrop-motion', 'system'));
  const [muted, setMuted] = useState(() => saved('echodrop-muted', 'yes') === 'yes');
  const [ready, setReady] = useState(lan);
  const [busy, setBusy] = useState(Boolean(desktop));
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [state, setState] = useState<HostState | null>(null);
  const [online, setOnline] = useState(false);
  const [active, setActive] = useState(false);
  const [records, setRecords] = useState<ActivityRecord[]>([]);
  const [phase, setPhase] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const summary = useCallback((items: ActivityRecord[], value: string) => { setRecords(items); setPhase(value); }, []);
  const api = desktop?.transfer || browserTransport;
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; };
    apply(); media.addEventListener('change', apply); save('echodrop-theme', theme);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => { document.documentElement.dataset.motion = motion; save('echodrop-motion', motion); }, [motion]);
  useEffect(() => { save('echodrop-muted', muted ? 'yes' : 'no'); }, [muted]);
  async function start() {
    if (!desktop) return;
    setBusy(true); setError('');
    try { setReady((await desktop.start()).ready); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  useEffect(() => { if (desktop) void desktop.restore().then(async r => { setReady(r.ready || (await desktop.start()).ready); }).catch(e => setError(e.message)).finally(() => setBusy(false)); }, []);
  async function refresh() {
    if (!ready) return;
    try {
      if (desktop) setState((await desktop.state()).state);
      else { const reply = await api({ path: '/host/state' }); setState(reply.status === 200 ? JSON.parse(reply.text) : null); }
      setOnline(true); setError('');
    } catch (e) { setOnline(false); setError((e as Error).message); }
  }
  useEffect(() => { void refresh(); const timer = setInterval(refresh, 5000); return () => clearInterval(timer); }, [ready]);
  function show(next: Navigation) {
    setNavigation(next);
    requestAnimationFrame(() => {
      const target = next.screen === 'Welcome' ? document.getElementById('welcome-main') : heading.current;
      target?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
  }
  function back() {
    // Never ask Electron to navigate beyond this document's Welcome entry.
    if (currentNavigation().depth > 0) window.history.back();
  }
  useEffect(() => {
    window.history.replaceState({ ...window.history.state, echoNavigation: currentNavigation() }, '');
    const restore = () => show(currentNavigation());
    window.addEventListener('popstate', restore);
    const unsubscribe = desktop?.onNavigation(direction => {
      if (direction === 'back') back();
      else window.history.forward();
    });
    return () => { window.removeEventListener('popstate', restore); unsubscribe?.(); };
  }, []);
  function go(next: Area, nextMode = mode, projectId?: string, replace = false, projectSection: ProjectSection = 'overview', contextId?: string) {
    const plan = planNavigation(currentNavigation(), next, nextMode, projectId, replace, projectSection, contextId);
    if (!plan) return;
    if ('delta' in plan) { window.history.go(plan.delta); return; }
    window.history[plan.replace ? 'replaceState' : 'pushState']({ ...window.history.state, echoNavigation: plan.route }, '');
    show(plan.route);
  }
  function connect() { go('Connect'); }
  function enter() { go('Home'); }
  async function invite() {
    try { if (desktop) await desktop.open('devices'); else window.open('/host/pairing', '_blank', 'noopener,noreferrer'); }
    catch (e) { setError((e as Error).message); }
  }
  const sessions = state?.devices.filter(d => d.expiresAt > Date.now()) || [];
  const attention = records.some(r => ['Interrupted', 'Resumable', 'Failed'].includes(r.phase));
  const current = records.find(r => ['Uploading', 'Verifying', 'Preparing'].includes(r.phase));
  const status = !ready ? busy ? 'Preparing local service' : 'Local service unavailable' : !online ? 'Checking connection' : state ? sessions.length ? `${sessions.length} approved session${sessions.length === 1 ? '' : 's'}` : 'No devices connected' : 'Browser workspace';
  const [sysDark, setSysDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSysDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  const effectiveDark = theme === 'dark' || (theme === 'system' && sysDark);
  function toggleTheme() { const next = effectiveDark ? 'light' : 'dark'; setTheme(next); setNotice('Appearance saved.'); }
  const themeToggle = (
    <button
      className="theme-toggle-btn"
      aria-label={effectiveDark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-pressed={effectiveDark}
      onClick={toggleTheme}
    >
      {effectiveDark ? '☀' : '☽'}
    </button>
  );
  const appearance = <select aria-label="Theme" value={theme} onChange={e => { setTheme(e.target.value); setNotice('Appearance saved.'); }}><option value="light">Light</option><option value="dark">Dark</option><option value="system">System</option></select>;
  return <>
    <a className="skip-link" href={welcome ? '#welcome-main' : '#main-content'} onClick={event => { event.preventDefault(); const target = document.getElementById(welcome ? 'welcome-main' : 'main-content'); target?.focus(); target?.scrollIntoView(); }}>Skip to content</a>
    <header hidden={welcome} className="topbar"><button className="wordmark text-link" onClick={() => go('Home')}>EchoDrop</button><details className="workspace-menu"><summary>Navigate</summary><nav aria-label="Workspace">{toolAreas.map(item => <button key={item} aria-current={area === item ? 'page' : undefined} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); go(item); }}>{item}</button>)}</nav></details><div className="header-end"><button className="connection-chip" onClick={connect}>{status}</button>{<button className="transfer-chip" onClick={() => go(active ? 'Share' : 'Activity')}>{active ? current ? `${bytes(current.retained)} / ${bytes(current.size)}` : phase || 'Preparing' : attention ? 'Transfer needs attention' : 'Transfers'} →</button>}{themeToggle}<button className="text-link" onClick={() => go('Settings')}>Settings</button></div></header>
    {welcome && <WelcomePage onEnter={enter} theme={theme} onThemeChange={setTheme} motion={motion} />}
    <div hidden={welcome} className="workspace app-shell project-app-shell">
    <main id="main-content" className="workspace-main" tabIndex={-1}><div className="section-heading"><div><p className="eyebrow">YOUR SPACE / {area.toUpperCase()}</p><h1 tabIndex={-1} ref={heading}>{area === 'Connect' ? 'Connect Device' : area === 'Activity' ? 'Activity' : area}</h1></div><button className="text-link" onClick={back}>← Back to {navigation.previous || 'Welcome'}</button></div>
      {error && <p role="alert" className="error shell-notice">{error}</p>}
      {!ready && <div className="shell-notice"><p>{busy ? 'Preparing your local workspace… You can explore while it starts.' : desktop ? 'Start the local service to use native project tools and transfers. No pairing is required.' : 'Explore EchoDrop here. For transfers, open the Windows app or join through a host invitation.'}</p>{desktop && !busy && <button className="button" onClick={() => void start()}>Retry local service</button>}</div>}
      <div hidden={!['Home', 'Create Project', 'Project'].includes(area)}>
        <ProjectHub screen={area} projectId={navigation.projectId} projectSection={navigation.projectSection ?? 'overview'} contextId={navigation.contextId} go={go} back={back} records={records} active={active} phase={phase} sessions={sessions.length} />
      </div>
      {area === 'Share' && <div className="share-toolbar"><nav className="pair-tabs" aria-label="Share type"><button aria-pressed={mode === 'files'} className={mode === 'files' ? 'active' : ''} onClick={() => go('Share', 'files')}>Files</button><button aria-pressed={mode === 'project'} className={mode === 'project' ? 'active' : ''} onClick={() => go('Share', 'project')}>Project</button></nav><button className="text-link" onClick={connect}>Connect Device ↗</button><p className="fine">{mode === 'files' ? 'Select → Review → Send' : 'Select → Inspect → Review → Send'} · Selections stay here when you connect.</p></div>}
      <div hidden={!['Share', 'Receive', 'Activity'].includes(area)}>{(ready || !desktop) && <OmniDrop api={api} view={area === 'Project' || area === 'Create Project' ? 'Home' : area} mode={mode} {...(state ? { devices: state.devices } : {})} {...(desktop ? { download: desktop.download } : {})} onActiveChange={setActive} onSummary={summary} onComplete={() => void refresh()}/>}</div>
      <div hidden={area !== 'Connect'}>{ready && (desktop || state) ? <><p className="shell-notice">Use QR Connect, Manual Connect or ChirpPair in the invitation window. Return here to approve requests. Your prepared selections stay in Share.</p><Devices api={desktop?.pairing || pairingAPI} invite={() => void invite()}/></> : <section className="shell-notice"><h2>Join a nearby workspace.</h2><p>Open the host’s invitation or scan their QR code. The host approves access.</p>{lan && <a className="button" href="/join" target="_blank" rel="noopener noreferrer">QR / Manual / ChirpPair</a>}</section>}</div>
      <div hidden={area !== 'Workspace'} className="workspace-project"><p className="fine">A focused space for your static project. Select locally, inspect its details, then open a supported preview. No code is installed or executed by EchoDrop.</p><LivePreview {...(desktop ? { native: desktop.preview } : {})} host={Boolean(desktop || state)} visible={area === 'Workspace' && ready}/><button className="text-link" onClick={() => go('Share', 'project')}>Inspect a developer project for sharing →</button><button className="text-link" onClick={() => go('Receive')}>Open an extracted project in Receive →</button></div>
      {area === 'Settings' && <div className="settings"><section><div><h3>Appearance</h3><p>Toggle light and dark mode, or choose system default below.</p></div><div className="settings-appearance-group">{themeToggle}{appearance}</div></section><section><div><h3>Motion</h3><p>System follows your device’s reduced-motion preference.</p></div><select aria-label="Motion preference" value={motion} onChange={e => { setMotion(e.target.value); setNotice('Motion preference saved.'); }}><option value="system">System</option><option value="reduce">Reduced</option></select></section><section><div><h3>Decorative sounds</h3><p>No decorative sound is enabled yet. Audition candidates await approval. Functional ChirpPair playback always requires its own consent.</p></div><label><input type="checkbox" checked={muted} onChange={e => { setMuted(e.target.checked); setNotice('Sound preference saved.'); }}/> Mute decorative sounds</label></section><section><div><h3>Connection and access</h3><p>{status}. Approved sessions do not establish live presence.</p><p className="fine">Trusted LAN · Plain HTTP · Sessions expire after eight hours or host restart.</p></div><button className="button secondary" onClick={connect}>Manage devices</button></section><p role="status">{notice}</p></div>}
    </main></div>
  </>;
}
