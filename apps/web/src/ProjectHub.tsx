import React, { useEffect, useState } from 'react';
import { PROJECT_TYPES, PROJECT_STATUSES, validateProjectInput, type Project, type ProjectType, type ProjectInput, type ProjectPatch, type ProjectRegistryBridge, type RegistrySnapshot, type FolderSelection } from '../../../packages/core/projects.mjs';
import type { Area, ProjectSection } from './navigation.mjs';
import { CollaborationPanel } from './CollaborationPanel';
import { ProjectTransfers } from './ProjectTransfers';
import type { ActivityRecord } from './OmniDrop';
import { bytes } from './transfer-api';

type Go = (area: Area, mode?: 'files' | 'project', projectId?: string, replace?: boolean, projectSection?: ProjectSection, contextId?: string) => void;
const typeDescriptions = ['A space for your own work.', 'Coursework, research and submissions.', 'A shared purpose, a focused workspace.', 'Keep an idea ready for its next chapter.', 'Shape a product or a client engagement.', 'Make room for a focused sprint.', 'Define a space on your own terms.'];
const date = (value: string) => new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
const folderName = (value: string) => value.split(/[\\/]/).filter(Boolean).pop() || value;
const projectIdentity = (project: Project) => `${project.name} · ${project.type} · ${project.id.slice(0, 8)}`;

function CreateProject({ bridge, onCreated, back }: { bridge: ProjectRegistryBridge; onCreated: (project: Project) => void; back: () => void }) {
  const [type, setType] = useState<ProjectType>('Personal Project');
  const [origin, setOrigin] = useState<'new' | 'import'>('new');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [folder, setFolder] = useState<FolderSelection | null>(null);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function chooseFolder() {
    setBusy(true); setError('');
    try { const selected = await bridge.selectFolder(); if (selected) setFolder(selected); }
    catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy) return;
    setError('');
    try {
      const input: ProjectInput = validateProjectInput({ name, description, type, origin });
      if (origin === 'import' && !folder) throw new Error('Choose the existing project folder before continuing.');
      if (!review) { setReview(true); return; }
      setBusy(true);
      onCreated(await bridge.create(input, folder?.token));
    } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  return <form className="project-create" onSubmit={submit} aria-label="Create project" aria-busy={busy}>
    <div className="project-intro"><p className="eyebrow">{review ? 'ONE LAST LOOK' : 'A PLACE TO BEGIN'}</p><h2>{review ? 'Ready for your next chapter.' : 'Make room for your next idea.'}</h2><p>{review ? 'Confirm the details below. Your project opens as soon as it is saved.' : 'Start with a name and a purpose. Add a local folder only when you need one.'}</p></div>
    {error && <p role="alert" className="project-error">{error}</p>}
    {review ? <dl className="project-review"><dt>Name</dt><dd>{name.trim()}</dd><dt>Type</dt><dd>{type}</dd><dt>Starting status</dt><dd>Planned</dd><dt>Starting point</dt><dd>{origin === 'import' ? 'Import Existing' : 'Create New'}</dd><dt>Local folder</dt><dd>{folder?.label || 'No folder associated'}</dd><dt>Description</dt><dd>{description.trim() || 'No description yet.'}</dd></dl> : <>
      <fieldset disabled={busy}><legend>01 / Choose your starting point</legend><div className="project-origin"><label><input type="radio" name="origin" checked={origin === 'new'} onChange={() => setOrigin('new')}/><strong>Create New</strong><span>Start a project record. A folder is optional.</span></label><label><input type="radio" name="origin" checked={origin === 'import'} onChange={() => setOrigin('import')}/><strong>Import Existing</strong><span>Register a folder already on this computer.</span></label></div></fieldset>
      <fieldset disabled={busy}><legend>02 / What kind of project?</legend><div className="project-types">{PROJECT_TYPES.map((item, index) => <label key={item} className={type === item ? 'selected' : ''}><input type="radio" name="project-type" value={item} checked={type === item} onChange={() => setType(item)}/><span><strong>{item}</strong><small>{typeDescriptions[index]}</small></span></label>)}</div><p className="fine">Types help you organize. Every type starts with the same tools; no templates or team access are provisioned.</p></fieldset>
      <fieldset className="project-fields" disabled={busy}><legend>03 / Give it an identity</legend><label>Project name <span aria-hidden="true">*</span><input autoFocus required maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="A name you’ll recognize"/></label><label>Description <span className="fine">Optional</span><textarea rows={3} maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} placeholder="What would you like to build or explore?"/></label><div className="project-folder"><div><strong>{origin === 'import' ? 'Existing project folder (required)' : 'Local folder (optional)'}</strong><p>{folder ? folder.label : 'Choose a folder using the native picker.'}</p></div><button type="button" className="button secondary" onClick={() => void chooseFolder()}>{folder ? 'Change folder' : 'Choose folder'}</button>{folder && origin === 'new' && <button type="button" className="text-link" onClick={() => setFolder(null)}>Remove association</button>}</div><p className="fine">This saves a reference to the folder. EchoDrop won’t copy or modify its files, install dependencies, run scripts, or share the registry.</p></fieldset>
    </>}
    <div className="project-form-actions"><button type="button" className="text-link" disabled={busy} onClick={review ? () => setReview(false) : back}>{review ? '← Edit details' : 'Cancel'}</button><button className="button" disabled={busy} type="submit">{busy ? 'Saving…' : review ? 'Create & open project →' : 'Review project →'}</button></div>
  </form>;
}

function ProjectDetails({ project, projects, bridge, readOnly, onUpdate, go, section, contextId }: { project: Project; projects: Project[]; bridge: ProjectRegistryBridge; readOnly: boolean; onUpdate: (project: Project) => void; go: Go; section: ProjectSection; contextId: string | undefined }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [showFullPath, setShowFullPath] = useState(false);
  async function update(patch: ProjectPatch) {
    setBusy(true); setError(''); setSaved('');
    try { onUpdate(await bridge.update(project.id, patch)); setSaved('Project saved.'); }
    catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  async function openFolder() {
    setBusy(true); setError('');
    try { await bridge.openFolder(project.id); } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  return <section className="project-detail" aria-label={project.name}>
    <div className="project-detail-toolbar"><span className="project-badge">{project.type}</span><label>Switch project <select value={project.id} onChange={event => go('Project', 'files', event.target.value)}>{projects.map(item => <option key={item.id} value={item.id}>{projectIdentity(item)}</option>)}</select></label></div>
    <div className="project-intro"><p className="eyebrow">YOUR PROJECT WORKSPACE</p><h2>{project.name}</h2><p className="project-description">{project.description || 'A little room for something great. Add a description when you’re ready.'}</p></div>
    <nav className="project-sections" aria-label="Project areas">{(['overview', 'teams', 'collaboration'] as ProjectSection[]).map(item => <button key={item} aria-current={section === item ? 'page' : undefined} onClick={() => go('Project', 'files', project.id, false, item)}>{item === 'overview' ? 'Overview' : item === 'teams' ? 'Teams & people' : 'Collaboration'}</button>)}</nav>
    {section === 'overview' ? <>
    {error && <p className="project-error" role="alert">{error}</p>}<p role="status" className="fine">{saved}</p>
    <div className="project-facts"><label>Status <select disabled={busy || readOnly} value={project.status} onChange={event => void update({ status: event.target.value as Project['status'] })}>{PROJECT_STATUSES.map(status => <option key={status}>{status}</option>)}</select></label><button className="button secondary" disabled={busy || readOnly} aria-pressed={project.pinned} onClick={() => void update({ pinned: !project.pinned })}>{project.pinned ? 'Unpin project' : 'Pin project'}</button><span>Created {date(project.createdAt)}<br/>Updated {date(project.updatedAt)}</span></div>
    <div className="project-tool-list"><div><h3>Local folder</h3><p className="project-path">{project.localRoot ? showFullPath ? project.localRoot : folderName(project.localRoot) : 'This project is organized in EchoDrop without a local folder association.'}</p>{project.localRoot && <button className="text-link project-path-toggle" aria-expanded={showFullPath} onClick={() => setShowFullPath(value => !value)}>{showFullPath ? 'Hide full path' : 'Show full path'}</button>}</div>{project.localRoot && <button className="button secondary" disabled={busy} onClick={() => void openFolder()}>Open folder ↗</button>}</div>
    <div className="project-tool-list"><div><h3>Share a project snapshot</h3><p>Open the existing inspection and Secret-Safe review flow. Choose the folder to package; this record is never sent.</p></div><button className="text-link" onClick={() => go('Share', 'project')}>Inspect & share →</button></div>
    <div className="project-tool-list"><div><h3>Static LivePreview</h3><p>Open the existing preview workspace and select a supported static project. Preview selection is independent of this registry record.</p></div><button className="text-link" onClick={() => go('Workspace')}>Open preview tools →</button></div>
    <ProjectTransfers key={project.id} projectId={project.id}/>
    <details className="project-edit"><summary>Edit project details</summary><form className="project-fields" onSubmit={event => { event.preventDefault(); void update({ name, description }); }}><label>Name<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} disabled={busy || readOnly}/></label><label>Description<textarea maxLength={2000} rows={3} value={description} onChange={event => setDescription(event.target.value)} disabled={busy || readOnly}/></label><button className="button" disabled={busy || readOnly}>Save details</button></form></details>
    <p className="fine project-boundary">Project identity, teams and collaboration access records stay on this computer. Use Teams &amp; people or Collaboration to administer them. Remote collaboration, tasks, version history, development environments and testing tools are not available yet.</p>
    </> : <CollaborationPanel projectId={project.id} section={section} contextId={contextId} onContext={id => go('Project', 'files', project.id, false, 'collaboration', id)}/>}
  </section>;
}

export function ProjectHub({ screen, projectId, projectSection, contextId, go, back, records, active, phase, sessions }: { screen: Area; projectId: string | undefined; projectSection: ProjectSection; contextId: string | undefined; go: Go; back: () => void; records: ActivityRecord[]; active: boolean; phase: string; sessions: number }) {
  const bridge = window.echoDesktop?.registry;
  const [registry, setRegistry] = useState<RegistrySnapshot>({ projects: [], readOnly: false, warning: '' });
  const [loading, setLoading] = useState(Boolean(bridge));
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  async function load() {
    if (!bridge) return;
    setLoading(true); setError('');
    try { setRegistry(await bridge.list()); } catch (error) { setError(message(error)); } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [bridge]);
  const update = (project: Project) => setRegistry(current => ({ ...current, projects: current.projects.map(item => item.id === project.id ? project : item) }));
  const projects = [...registry.projects].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const shown = projects.filter(project => (filter !== 'pinned' || project.pinned) && (typeFilter === 'all' || project.type === typeFilter) && `${project.name} ${project.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const project = projects.find(item => item.id === projectId);
  return <div className="project-hub">
    {confirmation && <p className="project-confirmation" role="status">{confirmation}</p>}
    {registry.warning && <p className="project-error" role="alert">{registry.warning}</p>}
    {error && <div className="project-error" role="alert"><p>Couldn’t load your projects: {error}</p><button className="button secondary" disabled={loading} onClick={() => void load()}>Try again</button></div>}
    {screen === 'Home' && <>
      <div className="project-home-heading"><div className="project-intro"><p className="eyebrow">ROOM FOR WHAT’S NEXT</p><h2>Your projects.<br/><em>Your momentum.</em></h2><p>{projects.length ? 'Pick up where you left off, or make room for a new beginning.' : 'Every great project starts somewhere. Let this be your place.'}</p></div>{bridge && <button className="button project-create-button" disabled={loading || Boolean(error) || registry.readOnly} onClick={() => { setConfirmation(''); go('Create Project'); }}>Create Project <span aria-hidden="true">＋</span></button>}</div>
      <nav className="project-quick-tools" aria-label="Quick tools">{(['Connect', 'Share', 'Receive', 'Activity', 'Workspace'] as Area[]).map(tool => <button key={tool} onClick={() => go(tool)}>{tool === 'Workspace' ? 'Static LivePreview' : tool}<span aria-hidden="true">↗</span></button>)}</nav>
      {!bridge ? <section className="project-empty"><p className="eyebrow">CONNECTED TOOLS, LOCAL PROJECTS</p><h3>Your project library lives in the desktop app.</h3><p>This browser session can use the tools above. It does not store a project registry or receive the host’s project names and local folders. Create and manage projects in the EchoDrop desktop application.</p></section> : <section className="project-library" aria-label="Project library" aria-busy={loading}>
        <div className="project-library-heading"><h3>Your library <span>{projects.length}</span></h3><button className="text-link" disabled={loading} onClick={() => void load()}>Refresh</button></div>
        {loading ? <p role="status">Opening your project library…</p> : !error && projects.length === 0 ? <div className="project-empty"><span className="project-empty-mark" aria-hidden="true">01</span><h3>A fresh page. A world of possibilities.</h3><p>Create your first project or register an existing folder. Nothing is shared until you explicitly choose a transfer workflow.</p><button className="text-link" disabled={registry.readOnly} onClick={() => go('Create Project')}>Start your first project →</button></div> : <>
          <div className="project-filters"><label><span className="fine">Search projects</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a name or description…"/></label><label><span className="fine">Show</span><select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All projects</option><option value="pinned">Pinned projects</option></select></label><label><span className="fine">Project type</span><select value={typeFilter} onChange={event => setTypeFilter(event.target.value)}><option value="all">All types</option>{PROJECT_TYPES.map(type => <option key={type}>{type}</option>)}</select></label></div>
          <ul className="project-rows">{shown.map(project => <li key={project.id}><button aria-label={`Open ${projectIdentity(project)}`} onClick={() => { setConfirmation(''); go('Project', 'files', project.id); }}><span className="project-initial" aria-hidden="true">{project.name.slice(0, 1).toLocaleUpperCase()}</span><span className="project-row-name"><strong>{project.name}</strong><small>{project.pinned ? 'Pinned · ' : ''}{project.type} · {project.origin === 'import' ? 'Imported' : 'Created here'} · ID {project.id.slice(0, 8)}</small></span><span className="project-badge">{project.status}</span><time dateTime={project.updatedAt}>{date(project.updatedAt)}</time><span aria-hidden="true">→</span></button></li>)}</ul>
          {!shown.length && <p className="project-empty">No projects match these filters. <button className="text-link" onClick={() => { setQuery(''); setFilter('all'); setTypeFilter('all'); }}>Clear filters</button></p>}
        </>}
      </section>}
      <section className="project-activity"><div className="project-library-heading"><h3>Workspace activity</h3><button className="text-link" onClick={() => go('Activity')}>View activity →</button></div>{active && <button className="project-live-status" onClick={() => go('Share')}>{phase || 'Transfer in progress'} — view transfer →</button>}<p className="fine">{sessions ? `${sessions} approved session${sessions === 1 ? '' : 's'}. Approval does not indicate live presence.` : 'Connect a device when you’re ready to share.'}</p>{records.length ? records.slice(0, 3).map(record => <div className="recent-row" key={record.id}><span>{record.name}</span><span>{record.phase} · {bytes(record.size)}</span></div>) : <p className="fine">Transfer activity will appear here as you work.</p>}</section>
    </>}
    {screen === 'Create Project' && (bridge && !registry.readOnly && !error && !loading ? <CreateProject bridge={bridge} back={back} onCreated={project => { setRegistry(current => ({ ...current, projects: [...current.projects, project] })); setConfirmation(`“${project.name}” was created and saved on this computer.`); go('Project', 'files', project.id, true); }}/> : <p>{loading ? 'Loading project registry…' : 'Project creation requires a writable desktop registry.'}</p>)}
    {screen === 'Project' && (loading ? <p role="status">Opening project…</p> : project && bridge ? <ProjectDetails key={project.id} project={project} projects={projects} section={projectSection} contextId={contextId} bridge={bridge} readOnly={registry.readOnly} onUpdate={update} go={go}/> : <div className="project-empty"><h3>This project isn’t available here.</h3><p>The project may belong to another desktop profile or its registry may need recovery.</p><button className="button secondary" onClick={() => go('Home')}>Return to Home</button></div>)}
  </div>;
}
