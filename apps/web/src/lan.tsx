import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OmniDrop } from './OmniDrop';
import { browserTransport } from './transfer-api';
import './styles.css';
import { PairingPage } from './Pairing';
import { LivePreview } from './LivePreview';
import { Devices } from './Devices';
import { pairingAPI } from './pairing-api';
function LanWorkspace() {
  const [view, setView] = useState<'Files' | 'Devices' | 'Transfers' | 'LivePreview' | 'Settings'>('Files');
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('echodrop-theme') || 'system'; } catch { return 'system'; } });
  const [devices, setDevices] = useState<{ id: string; deviceName: string; expiresAt: number }[] | undefined>();
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; };
    apply(); media.addEventListener('change', apply); try { localStorage.setItem('echodrop-theme', theme); } catch { /* Session-only preference. */ }
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => {
    const refresh = () => browserTransport({ path: '/host/state' }).then(r => { if (r.status === 200) setDevices(JSON.parse(r.text).devices); else setDevices(undefined); }).catch(() => setDevices(undefined));
    void refresh(); const timer = setInterval(refresh, 15000); return () => clearInterval(timer);
  }, []);
  return <><header className="topbar"><a className="wordmark" href="/">echodrop.</a><span className="workspace-label">LOCAL WORKSPACE</span><div className="header-end"><label className="theme-control"><span>Appearance</span><select aria-label="Appearance" value={theme} onChange={e => setTheme(e.target.value)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label><a className="text-link" href="/join">Join / renew access</a></div></header><div className="workspace"><aside><div className="workspace-name">Shared workspace<small>Hosted on your local network</small></div><nav aria-label="Workspace">{(['Files','Devices','Transfers','LivePreview','Settings'] as const).map(item => <button key={item} className={view === item ? 'active' : ''} aria-current={view === item ? 'page' : undefined} onClick={() => setView(item)}>{item}</button>)}</nav></aside><main className="workspace-main"><div className="section-heading"><div><p className="eyebrow">MY WORKSPACE / {view.toUpperCase()}</p><h1>{view}</h1></div></div><div hidden={view !== 'Files' && view !== 'Transfers'}><OmniDrop api={browserTransport} view={view === 'Transfers' ? 'Transfers' : 'Files'} {...(devices ? { devices } : {})}/></div>
    <div hidden={view !== 'Devices'}>{devices !== undefined ? <Devices api={pairingAPI} invite={() => { window.open('/host/pairing', '_blank', 'noopener,noreferrer'); }}/> : <div className="empty"><h2>Your host manages access.</h2><p>Device lists, requests and approval controls are available only on the host computer. This service does not expose live device presence to guests.</p><a className="button secondary" href="/join" target="_blank" rel="noopener noreferrer">Join or renew access</a></div>}</div>
    <div hidden={view !== 'LivePreview'}><LivePreview host={devices !== undefined} visible={view === 'LivePreview'}/></div>
    {view === 'Settings' && <div className="settings"><section><div><h3>Your appearance</h3><p>Light, dark or system. Your preference is saved in this browser.</p></div><select aria-label="Workspace appearance" value={theme} onChange={e => setTheme(e.target.value)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></section><section><div><h3>Local by design</h3><p>Sessions expire after eight hours or a host restart. Files are shared through the host; there are no cloud accounts or device-delivery receipts.</p></div></section><section><div><h3>LivePreview is optional.</h3><p>Start a project only when you need it. Preview links expire after five minutes.</p></div><button className="button secondary" onClick={() => setView('LivePreview')}>Open LivePreview</button></section></div>}
    <p className="fine">Plain HTTP LAN: traffic is not encrypted. Use only a trusted network. Sessions expire after eight hours or a service restart.</p></main></div></>;
}
const root = document.getElementById('omni-root')!;
createRoot(root).render(root.dataset.page === 'join' || root.dataset.page === 'host' ? <PairingPage host={root.dataset.page === 'host'}/> : <LanWorkspace/>);
