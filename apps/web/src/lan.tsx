import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OmniDrop } from './OmniDrop';
import { browserTransport } from './transfer-api';
import './styles.css';
import { PairingPage } from './Pairing';
function LanWorkspace() {
  const [view, setView] = useState<'Files' | 'Transfers'>('Files');
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('echodrop-theme') || 'system'; } catch { return 'system'; } });
  const [devices, setDevices] = useState<{ id: string; deviceName: string; expiresAt: number }[] | undefined>();
  const [preview, setPreview] = useState('');
  const [notice, setNotice] = useState('');
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
  async function previewLink() {
    setPreview(''); setNotice('Requesting a preview link…');
    try { const response = await fetch('/preview/grant', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EchoDrop-Request': '1' }, body: '{}' });
      if (!response.ok) throw new Error(await response.text());
      const grant = await response.json(); setPreview(grant.url); setNotice('Preview link expires ' + new Date(grant.expiresAt).toLocaleTimeString());
    } catch (e) { setNotice((e as Error).message); }
  }
  return <><header className="topbar"><a className="wordmark" href="/">echodrop.</a><span className="workspace-label">LOCAL WORKSPACE</span><div className="header-end"><label className="theme-control"><span>Appearance</span><select aria-label="Appearance" value={theme} onChange={e => setTheme(e.target.value)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label><a className="text-link" href="/join">Join / renew access</a></div></header><div className="workspace"><aside><div className="workspace-name">Shared workspace<small>Hosted on your local network</small></div><nav aria-label="Workspace">{(['Files','Transfers'] as const).map(item => <button key={item} className={view === item ? 'active' : ''} aria-current={view === item ? 'page' : undefined} onClick={() => setView(item)}>{item}</button>)}{devices !== undefined && <a href="/host/pairing">Devices & invitations</a>}</nav></aside><main className="workspace-main"><div className="section-heading"><div><p className="eyebrow">MY WORKSPACE / {view.toUpperCase()}</p><h1>{view}</h1></div></div><OmniDrop api={browserTransport} view={view} {...(devices ? { devices } : {})}/><details className="lan-preview"><summary>LivePreview · optional</summary><p className="fine">The host must start a static project preview before a link is available.</p><button className="button secondary" onClick={() => void previewLink()}>Get preview link</button><p role="status">{notice}</p>{preview && <a href={preview} target="_blank" rel="noopener noreferrer">Open LivePreview ↗</a>}</details><p className="fine">Plain HTTP LAN: traffic is not encrypted. Use only a trusted network. Sessions expire after eight hours or a service restart.</p></main></div></>;
}
const root = document.getElementById('omni-root')!;
createRoot(root).render(root.dataset.page === 'join' || root.dataset.page === 'host' ? <PairingPage host={root.dataset.page === 'host'}/> : <LanWorkspace/>);
