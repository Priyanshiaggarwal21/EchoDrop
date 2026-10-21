import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { OmniDrop } from './OmniDrop';
import type { Transport } from './transfer-api';
import { Devices } from './Devices';
import type { PairAPI } from './pairing-api';
import { LivePreview, type PreviewBridge } from './LivePreview';

type Area = 'Files' | 'Devices' | 'Transfers' | 'LivePreview' | 'Settings';
type Theme = 'light' | 'dark' | 'system';
type Snapshot = {
  health: { timestamp: string };
  state: {
    devices: { id: string; deviceName: string; expiresAt: number }[];
    requests: { id: string; deviceName: string }[];
    lanUrls: string[];
    preview: { running: boolean };
  };
  files: string;
};
declare global {
  interface Window {
    echoDesktop?: {
      restore(): Promise<{ ready: boolean }>;
      start(): Promise<{ ready: boolean }>;
      state(): Promise<Snapshot>;
      open(area: 'files' | 'devices' | 'preview'): Promise<void>;
      transfer: Transport;
      download(path: string): Promise<void>;
      pairing: PairAPI;
      preview: PreviewBridge;
      project: import('./ProjectShare').ProjectBridge;
    };
  }
}
const desktop = window.echoDesktop;

/* ─── Icons ──────────────────────────────────────────── */
type IconName = Area | 'arrow' | 'plus';
const iconPaths: Record<IconName, string> = {
  Files:       'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8m8 4H8m2-8H8',
  Devices:     'M3 4h14v11H3V4Zm4 15h6m-3-4v4m10-9h3v11h-7v-4',
  Transfers:   'M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4',
  LivePreview: 'M3 4h18v16H3zM3 8h18M9 11l-3 3 3 3m6-6 3 3-3 3',
  Settings:    'M12 3v3m0 12v3M3 12h3m12 0h3M6 6l2 2m8 8 2 2M6 18l2-2m8-8 2-2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  arrow:       'M4 12h15m-5-5 5 5-5 5',
  plus:        'M12 5v14M5 12h14',
};
function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={iconPaths[name]} />
    </svg>
  );
}

/* ─── App ────────────────────────────────────────────── */
function App() {
  const [theme, setTheme] = useState<Theme>(() => {
    try { const t = localStorage.getItem('echodrop-theme'); return t === 'light' || t === 'dark' ? t : 'system'; }
    catch { return 'system'; }
  });
  const [page, setPage] = useState(location.hash === '#workspace' || desktop ? 'workspace' : 'home');
  const [area, setArea] = useState<Area>('Files');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(Boolean(desktop));
  const [error, setError] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [online, setOnline] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
    };
    apply(); media.addEventListener('change', apply);
    try { localStorage.setItem('echodrop-theme', theme); } catch { /* session only */ }
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    const change = () => {
      if (uploading) { history.replaceState(null, '', '#workspace'); setError('Keep the workspace open until this upload finishes.'); return; }
      setPage(location.hash === '#workspace' ? 'workspace' : 'home');
    };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, [uploading]);

  useEffect(() => {
    if (desktop) desktop.restore().then(r => setReady(r.ready)).catch(e => setError(e.message)).finally(() => setBusy(false));
  }, []);

  async function refresh() {
    if (!desktop) return;
    try { const data = await desktop.state(); setSnapshot(data); setOnline(true); setError(''); }
    catch (e) { setOnline(false); setError((e as Error).message); }
  }

  useEffect(() => {
    if (!ready) return;
    void refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [ready]);

  async function start() {
    if (!desktop) return;
    setBusy(true); setError('');
    try { setReady((await desktop.start()).ready); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function open(area: 'files' | 'devices' | 'preview') {
    setBusy(true); setError('');
    try { await desktop?.open(area); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const themeControl = (
    <label className="theme-control">
      <span>Appearance</span>
      <select aria-label="Appearance" value={theme} onChange={e => setTheme(e.target.value as Theme)}>
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );

  /* Navigation items shown in sidebar */
  const navAreas: Area[] = desktop
    ? ['Files', 'Devices', 'Transfers', 'LivePreview', 'Settings']
    : ['Files', 'Transfers', 'Settings'];

  return (
    <>
      {/* ── Topbar ── */}
      <header className="topbar">
        <a className="wordmark" href="#home">echodrop<span>.</span></a>
        {page === 'home'
          ? <nav aria-label="Product">
              <a href="#product">Product</a>
              <a href="#approach">How it works</a>
              <a href="#principles">Our approach</a>
            </nav>
          : <span className="workspace-label">LOCAL WORKSPACE</span>
        }
        <div className="header-end">
          {page === 'workspace' && ready && (
            <span className="service" role="status">
              <i className={online ? 'online' : ''} />
              {online ? 'Local service ready' : 'Checking local service'}
            </span>
          )}
          {themeControl}
          {page === 'home' && (
            <a className="button compact" href="#workspace">Open workspace <Icon name="arrow" /></a>
          )}
        </div>
      </header>

      {/* ── Home / marketing ── */}
      {page === 'home' ? (
        <main>
          <section className="hero" id="product">
            <div className="architecture" aria-hidden="true">
              {[0,1,2,3,4,5,6].map(n => <i key={n} style={{ width: `${48+n*11}%`, height: `${62+n*13}%` }} />)}
            </div>
            <div className="hero-copy">
              <p className="eyebrow">A little closer. A lot more possible.</p>
              <h1>Your team.<br/><em>Your space.</em><br/>No distance between ideas.</h1>
              <p className="lede">A shared place for the work in front of you.<br/>Connect your devices. Move your files.<br/>Keep it on your local network.</p>
              <div className="actions">
                <a className="button" href="#workspace">Open workspace <Icon name="arrow" /></a>
                <a className="text-link" href="#approach">See how it works <span>↘</span></a>
              </div>
            </div>
            <div className="hero-foot">
              <span>01 / BUILT FOR THE SAME ROOM</span>
              <span>Windows host · Browser guests · Your LAN</span>
            </div>
          </section>
          <section className="story" id="approach">
            <div>
              <p className="eyebrow">Less between you and the work</p>
              <h2>Good ideas travel.<br/>Your files can stay close.</h2>
            </div>
            <div className="steps">
              <article><span>01</span><div><h3>Make a space.</h3><p>Open EchoDrop on your Windows computer. Your local service and workspace begin there.</p></div></article>
              <article><span>02</span><div><h3>Bring your devices.</h3><p>Use an invitation on the same network. QR, manual entry and experimental acoustic pairing are available through host controls. You approve who joins.</p></div></article>
              <article><span>03</span><div><h3>Let the work move.</h3><p>Share files with verified, resumable transfers. When a static project needs a second screen, start LivePreview on demand.</p></div></article>
            </div>
          </section>
          <section className="principles" id="principles">
            <p className="eyebrow">Local by design</p>
            <h2>A workspace that<br/>stays yours.</h2>
            <div>
              <p>Your computer hosts the workspace. Nearby devices join through a browser. There is no EchoDrop cloud account or public cloud workspace.</p>
              <p className="fine">The current LAN service uses plain HTTP. Use a trusted network; traffic is not encrypted. Invitations require host approval, and sessions expire after eight hours or a service restart.</p>
              <a className="text-link" href="#workspace">Find your way in <Icon name="arrow" /></a>
            </div>
          </section>
          <footer>
            <a className="wordmark" href="#home">echodrop.</a>
            <span>Small distances. Shared possibilities.</span>
            <a href="#product">Back to top ↑</a>
          </footer>
        </main>

      ) : !ready ? (
        /* ── Entry / not-started ── */
        <main className="entry">
          <p className="eyebrow">Your next shared idea starts here</p>
          <span className="entry-icon"><Icon name="Files" /></span>
          <h1>A space to begin.</h1>
          <p>{desktop ? 'One computer. One local workspace. Ready when you are.' : 'Your workspace lives on your computer.'}</p>
          {desktop ? (
            <>
              <button className="button" onClick={start} disabled={busy}>
                {busy ? 'Preparing your workspace…' : 'Create local workspace'}<Icon name="arrow" />
              </button>
              <p className="fine">
                Files stay in EchoDrop's local app data. Returning users enter automatically.<br/>
                Use a trusted LAN: the current service uses unencrypted HTTP.
              </p>
            </>
          ) : (
            <div className="browser-entry">
              <h3>Open the Windows app</h3>
              <p>Launch EchoDrop on your host computer to create or return to your workspace.</p>
              <details>
                <summary>Running from this repository?</summary>
                <p>From the repository root, run <code>npm install</code>, then <code>npm run desktop</code>.</p>
              </details>
              <div className="entry-divider" />
              <h3>Joining someone's workspace?</h3>
              <p>Open the invitation URL provided by the host, or scan their QR code. Your host must approve access.</p>
              <p className="fine">Already running the standalone LAN experiment on this computer?</p>
              <a className="text-link" href="http://localhost:3000/host">Open local host controls <Icon name="arrow" /></a>
            </div>
          )}
          {error && <p role="alert" className="error">{error}</p>}
        </main>

      ) : (
        /* ── Workspace ── */
        <div className="workspace">
          {/* Sidebar */}
          <aside>
            <span className="workspace-wordmark">echodrop<span>.</span></span>
            <nav aria-label="Workspace">
              {navAreas.filter(item => item !== 'Settings').map(item => (
                <button
                  key={item}
                  aria-current={area === item ? 'page' : undefined}
                  className={area === item ? 'active' : ''}
                  onClick={() => setArea(item)}
                >
                  <Icon name={item} />{item}
                </button>
              ))}
            </nav>
            <div className="sidebar-settings">
              <button
                aria-current={area === 'Settings' ? 'page' : undefined}
                className={area === 'Settings' ? 'active' : ''}
                onClick={() => setArea('Settings')}
              >
                <Icon name="Settings" />Settings
              </button>
            </div>
          </aside>

          {/* Main content */}
          <main className="workspace-main">
            {/* Section heading */}
            <div className="section-heading">
              <h1>{area === 'LivePreview' ? 'Live Preview' : area}</h1>
              <div className="heading-actions">
                {(area === 'Files' || area === 'Transfers') && desktop && (
                  <button
                    className="button compact"
                    disabled={busy}
                    onClick={() => {
                      /* clicking Add in header triggers file pick via OmniDrop's hidden input –
                         we dispatch a custom event the OmniDrop component can listen to, or
                         simply rely on the drop-zone button for now */
                    }}
                    style={{ display: 'none' }} /* kept for future wiring */
                  >
                    <Icon name="plus" /> Add
                  </button>
                )}
                <button className="text-link" onClick={() => void refresh()} disabled={busy} style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Refresh
                </button>
              </div>
            </div>

            {error && <p className="error" role="alert" style={{ margin: '0 28px 0' }}>{error}</p>}

            {/* Files / Transfers */}
            {desktop && (
              <div hidden={area !== 'Files' && area !== 'Transfers'} style={{ display: (area === 'Files' || area === 'Transfers') ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                <OmniDrop
                  api={desktop.transfer}
                  view={area === 'Transfers' ? 'Transfers' : 'Files'}
                  {...(snapshot ? { devices: snapshot.state.devices } : {})}
                  download={desktop.download}
                  onActiveChange={setUploading}
                  onComplete={() => void refresh()}
                />
              </div>
            )}

            {/* Devices */}
            {desktop && (
              <div hidden={area !== 'Devices'}>
                <Devices api={desktop.pairing} invite={() => void open('devices')} />
              </div>
            )}

            {/* LivePreview */}
            {desktop && (
              <div hidden={area !== 'LivePreview'}>
                <LivePreview native={desktop.preview} host visible={area === 'LivePreview'} />
              </div>
            )}

            {/* Settings */}
            {area === 'Settings' && (
              <div className="settings">
                <section>
                  <div>
                    <h3>Appearance</h3>
                    <p>Theme follows you across the introduction and workspace.</p>
                  </div>
                  {themeControl}
                </section>
                <section>
                  <div>
                    <h3>Local service</h3>
                    <p>{online ? 'Responding on this computer.' : 'Service readiness could not be confirmed.'}</p>
                    {snapshot && <p className="fine">Last response: {new Date(snapshot.health.timestamp).toLocaleTimeString()}</p>}
                    <p className="fine">Plain HTTP · Trusted networks only · No cloud service</p>
                  </div>
                </section>
                <section>
                  <div>
                    <h3>LivePreview</h3>
                    <p>Share a local static project through the existing sandboxed preview.</p>
                    <p className="fine">
                      {snapshot
                        ? (snapshot.state.preview.running ? 'A preview service is running.' : 'Preview is stopped.')
                        : 'Preview status unavailable.'
                      } Preview links expire after five minutes.
                    </p>
                  </div>
                  <button className="button secondary" disabled={!online || busy} onClick={() => setArea('LivePreview')}>
                    Open LivePreview
                  </button>
                </section>
              </div>
            )}
          </main>
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
