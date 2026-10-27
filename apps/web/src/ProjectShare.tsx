import React, { useEffect, useRef, useState } from 'react';
import { compatibility, EXCLUDED, importBrowserProject, packageProject, type Project, type ImportResult, type Report } from '../../../packages/transfer/project.mjs';
import { scanProject, type ScanResult } from '../../../packages/transfer/secret-scan.mjs';

type Received = { id: string; name: string; directory: string; report: Report };
export type ProjectBridge = {
  (action: 'select'): Promise<ImportResult | null>;
  (action: 'receive', route?: string): Promise<Received | null>;
  (action: 'open', id: string): Promise<null>;
};
function Compatibility({ report }: { report: Report }) {
  return <details open><summary>Compatibility and setup</summary>
    <h4>Declared in project files · not execution-tested</h4>{report.facts.length ? <ul>{report.facts.map(f => <li key={f}>{f}</li>)}</ul> : <p>No supported manifest facts found.</p>}
    <h4>Not verified</h4><ul>{report.unknowns.map(f => <li key={f}>{f}</li>)}</ul>
    <h4>Next steps</h4><ol>{report.guidance.map(f => <li key={f}>{f}</li>)}</ol>
  </details>;
}
export function ProjectShare({ disabled, onShare, receiveRequest, onInvalidate, mode = 'share' }: { mode?: 'share' | 'receive'; onInvalidate?: () => void; disabled: boolean; onShare: (file: File) => void; receiveRequest: { path: string } | null }) {
  const input = useRef<HTMLInputElement>(null);
  const working = useRef(false);
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<ImportResult | null>(null);
  const [findings, setFindings] = useState<{ path: string; result: ScanResult }[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [received, setReceived] = useState<Received | null>(null);
  const bridge = window.echoDesktop?.project;
  async function work(action: () => Promise<void>) {
    if (working.current || disabled) return;
    working.current = true; setBusy(true); setMessage('Inspecting project locally…');
    try { await action(); }
    catch (error) { setMessage((error instanceof Error ? error.message + ' ' : '') + 'Project could not be processed. Use regular files with portable paths, at most 1,000 files, 32 MiB total and 8 MiB per file. Check permissions and select again. Nothing was uploaded.'); }
    finally { working.current = false; setBusy(false); }
  }
  async function inspect(result: ImportResult | null) {
    if (!result) { setMessage('Selection cancelled.'); return; }
    onInvalidate?.(); setSelection(null); setRemoved(new Set());
    const risks = await scanProject(result.project);
    setFindings(risks); setSelection(result);
    setMessage('Snapshot ready. Review compatibility, included files and sensitive findings before sharing. Source files are unchanged.');
  }
  async function receive(route?: string) {
    if (!bridge) return;
    await work(async () => {
      setMessage('Choose a destination for a new project copy.');
      const result = await bridge('receive', route);
      if (result) { setReceived(result); setMessage('Project received into a new folder. No code has been run.'); }
      else setMessage('Receive cancelled.');
    });
  }
  useEffect(() => { if (receiveRequest) void receive(receiveRequest.path); }, [receiveRequest]);
  const included: Project | null = selection ? { ...selection.project, files: selection.project.files.filter(f => !removed.has(f.path)) } : null;
  return <section className="project-panel" aria-label="Developer project sharing">
    <div hidden={mode !== 'share'}><div className="send-row"><div><h3>Share a project</h3><p className="fine">Select → Inspect → Review → Share → Receive → Open</p></div>
      <div className="project-actions">
        <button className="button secondary" disabled={busy || disabled} onClick={() => bridge ? void work(async () => inspect(await bridge('select'))) : input.current?.click()}>Select project folder</button>

      </div>
    </div>
    <input className="file-input" type="file" multiple ref={element => { input.current = element; element?.setAttribute('webkitdirectory', ''); }} aria-label="Select project folder" disabled={busy || disabled} onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; if (files.length) void work(async () => inspect(await importBrowserProject(files))); }} />
    <p className="fine">Node.js / React / TypeScript first. Up to 1,000 files, 32 MiB total, 8 MiB per file. Generated directories are excluded; empty directories and file permissions are not preserved.</p>
    {!bridge && <p className="fine">Folder selection depends on browser support. Download received .echoproject files, then use Extract downloaded project in EchoDrop desktop to extract and open them. Android cannot run Node.js projects here.</p>}

    {selection && included && <>
      <h3>{selection.project.name} <small>· {included.files.length} files included</small></h3>
      <Compatibility report={compatibility(included)} />
      <details><summary>Default exclusions and skipped entries</summary><p>{EXCLUDED.join(', ')}. Symbolic links, hard links and special files are skipped by desktop import.</p><p>Up to 100 excluded paths shown.</p><ul>{selection.excluded.map((p, i) => <li key={i}>{p}</li>)}</ul></details>
      <details open={findings.length > 0}><summary>Review files and sensitive findings ({findings.length})</summary>
        <p className="fine">Checked means Included. Uncheck a file to exclude it from this snapshot. Findings show categories only. Checks are heuristic; sharing uses plain HTTP and approved workspace-wide access.</p>
        {findings.length > 0 && <button className="text-link" disabled={busy || disabled} onClick={() => { onInvalidate?.(); setRemoved(new Set([...removed, ...findings.map(f => f.path)])); }}>Exclude all files with warnings</button>}
        <div className="project-file-list">{selection.project.files.map(entry => {
          const finding = findings.find(f => f.path === entry.path);
          return <label key={entry.path}><input type="checkbox" checked={!removed.has(entry.path)} disabled={busy || disabled} onChange={e => { onInvalidate?.(); setRemoved(previous => { const next = new Set(previous); if (e.target.checked) next.delete(entry.path); else next.add(entry.path); return next; }); }} />
            <span className="project-path">{entry.path}{finding && <small>{[...finding.result.categories, ...finding.result.limitations].join(' · ')}</small>}</span><strong className="inclusion-state">{removed.has(entry.path) ? 'Excluded' : 'Included'}</strong>
          </label>;
        })}</div>
      </details>
      <div className="project-actions"><button className="button" disabled={busy || disabled || !included.files.length} onClick={() => {
        try { onShare(new File([packageProject(included)], included.name + '.echoproject', { type: 'application/vnd.echodrop.project+json' })); }
        catch { setMessage('Cannot package this selection. Check file limits and paths. Nothing was uploaded.'); }
      }}>Prepare package for review</button><button className="text-link" disabled={busy || disabled} onClick={() => { onInvalidate?.(); setSelection(null); setFindings([]); setMessage('Project snapshot removed.'); }}>Discard snapshot</button></div>
      <p className="fine">The exact snapshot is shared through OmniDrop. To resume after reloading, select the unchanged source folder and the same included files, then share again.</p>
    </>}
    </div>
    {mode === 'receive' && bridge && <button className="button secondary" disabled={busy || disabled} onClick={() => void receive()}>Extract downloaded project</button>}
    {message && <p role="status">{message}</p>}
    {mode === 'receive' && received && <div className="project-received"><h3>{received.name} · Extraction complete</h3><p>{received.directory}</p><Compatibility report={received.report} />
      <button className="button secondary" disabled={busy || disabled} onClick={() => void work(async () => { await bridge?.('open', received.id); setMessage('Project folder opened. Review setup guidance before running any code.'); })}>Open Folder</button>
    </div>}
  </section>;
}
