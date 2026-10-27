import { BrowserEnrollment } from './BrowserEnrollment';
import { SecureDevicePairing } from './SecureDevicePairing';
import React, { useEffect, useState } from 'react';
import type { CollaborationSnapshot } from '../../../packages/core/collaboration.mjs';

export interface RemoteBridge { run(projectId: string, action: string, value?: unknown): Promise<unknown> }
type Status = { blockedReason: string | null; identity: { fingerprint: string; certificate: string; expiresAt: string } | null; peers: { principalId: string; fingerprint: string; displayName: string; status: 'active' | 'revoked'; expiresAt: string }[]; listening: boolean; port: number | null };
type Invite = { id: string; projectId: string; projectName: string; contextId?: string; contextName?: string; role: 'member' | 'guest'; status: string; expiresAt: string | null };
type Candidate = { token: string; fingerprint: string; expiresAt: string };
export function RemoteCollaboration({ projectId, data, refresh }: { projectId: string; data: CollaborationSnapshot; refresh: () => Promise<void> }) {
  const bridge = window.echoDesktop?.remoteCollaboration;
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [candidate, setCandidate] = useState<Candidate | null>(null), [expected, setExpected] = useState(''), [person, setPerson] = useState('');
  const [name, setName] = useState(''), [peer, setPeer] = useState(''), [host, setHost] = useState(''), [port, setPort] = useState('');
  const [inbox, setInbox] = useState<Invite[] | null>(null), [access, setAccess] = useState<Invite[] | null>(null), [revokePeer, setRevokePeer] = useState('');
  useEffect(() => { let active = true; setStatus(null); setInbox(null); setAccess(null); setCandidate(null); setError(''); bridge?.run(projectId, 'status').then(value => { if (active) setStatus(value as Status); }).catch(error => { if (active) setError(error.message); }); return () => { active = false; }; }, [projectId, bridge]);
  if (!bridge) return null;
  async function action(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await operation(); } catch (error) { setError(error instanceof Error ? error.message : 'Secure collaboration operation failed.'); } finally { setBusy(false); }
  }
  async function local(command: string, value?: unknown) {
    await bridge!.run(projectId, command, value);
    setStatus(await bridge!.run(projectId, 'status') as Status); await refresh();
    setNotice('Saved on this desktop. Refresh the peer to see its latest invitation state.');
  }
  async function query(command: string, invitationId?: string) {
    return bridge!.run(projectId, 'query', { fingerprint: peer, host: host.trim(), port: Number(port), request: { version: 1, action: command, ...(invitationId ? { invitationId } : {}) } });
  }
  async function fetchRemote() { setInbox(await query('inbox') as Invite[]); setAccess(await query('access') as Invite[]); }
  const clearRemote = () => { setInbox(null); setAccess(null); };
  return <details className="collab-disclosure remote-collaboration"><summary>Secure remote collaboration</summary>
    <p className="fine">Direct desktop-to-desktop TLS 1.3 with mutual certificate authentication. Verify full fingerprints through a trusted channel, such as an in-person comparison. A certificate proves key possession, not a person’s legal identity. No project access follows from device pairing or certificate trust alone.</p>
    {error && <p className="project-error" role="alert">{error}</p>}<p className="fine" role="status">{busy ? 'Working securely…' : notice}</p>
    <fieldset disabled={busy} className="remote-controls"><legend>Your participant certificate</legend>
      {status?.identity ? <><p className="collab-fingerprint">SHA-256: {status.identity.fingerprint}</p><p className="fine">Valid until {new Date(status.identity.expiresAt).toLocaleDateString()}. The private key is stored using OS protection and never returned to this page.</p><details><summary>Public certificate to exchange with your peer</summary><p className="fine">Share only this public certificate. Compare its full fingerprint over a separate trusted channel. Never share your private key.</p><textarea aria-label="Your public participant certificate" readOnly rows={7} value={status.identity.certificate}/></details></> : <><p className="fine">Import your own self-signed P-256 or RSA 3072+ certificate with serverAuth and clientAuth usage, followed by its matching unencrypted PEM private key. Certificate provisioning is an explicit prerequisite; no keys are fetched from LAN devices.</p><button className="button secondary" onClick={() => void action(() => local('import-identity'))}>Import my certificate & key</button></>}
      <button className="text-link" onClick={() => void action(async () => { setStatus(await bridge.run(projectId, 'status') as Status); })}>Refresh local status</button>
    </fieldset>
    {status?.blockedReason && <p className="project-error" role="status">{status.blockedReason}</p>}
    {status?.identity && !status.blockedReason && <>
      <details className="collab-disclosure"><summary>Verify and link a participant</summary>
        <form className="collab-inline-form" onSubmit={event => { event.preventDefault(); void action(async () => { await local('create-invitee', { displayName: name }); setName(''); }); }}><label>New invitee record<input disabled={busy} required maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="Creates no membership"/></label><button className="button secondary" disabled={busy}>Create invitee record</button></form>
        <button className="button secondary" disabled={busy} onClick={() => void action(async () => { setCandidate(await bridge.run(projectId, 'select-peer') as Candidate); setExpected(''); })}>Select peer’s public certificate</button>
        {candidate && <form className="project-fields" onSubmit={event => { event.preventDefault(); void action(async () => { await local('trust-peer', { token: candidate.token, principalId: person, fingerprint: expected.trim().toUpperCase() }); setCandidate(null); setExpected(''); }); }}>
          <p className="collab-fingerprint">Selected certificate: {candidate.fingerprint}</p><p className="fine">Confirm the same full fingerprint with the intended person through a trusted channel. Selecting a file or recognizing a name is not verification. Trust changes stop the listener; start it again when ready.</p>
          <label>Local roster record<select required disabled={busy} value={person} onChange={event => setPerson(event.target.value)}><option value="">Choose the person you verified</option>{data.directory.filter(person => person.kind === 'record' && person.status === 'active' && !status.peers.some(peer => peer.principalId === person.id)).map(person => <option key={person.id} value={person.id}>{person.displayName} · {person.id.slice(0, 8)}</option>)}</select></label>
          <label>Full SHA-256 fingerprint verified independently<input disabled={busy} required maxLength={95} value={expected} onChange={event => setExpected(event.target.value)} autoComplete="off" spellCheck={false}/></label><button className="button" disabled={busy}>Confirm verification & bind record</button>
        </form>}
      </details>
      <ul className="collab-members">{status.peers.map(item => <li className="collab-member" key={item.fingerprint}><div><strong>{item.displayName}</strong><span>{item.status} certificate trust · shared across this desktop, separate from project grants</span><small className="collab-fingerprint">{item.fingerprint}</small></div>{item.status === 'active' && <button className="text-link" disabled={busy} onClick={() => setRevokePeer(item.fingerprint)}>Revoke certificate trust</button>}{revokePeer === item.fingerprint && <div className="collab-confirm"><p>This blocks this participant across hosted projects, revokes their remote invitations and stops the listener. Downloaded copies and local roster records remain. Re-trusting this key requires a future recovery flow.</p><button className="button secondary" disabled={busy} onClick={() => setRevokePeer('')}>Keep trust</button><button className="button" disabled={busy} onClick={() => void action(async () => { await local('revoke-peer', { fingerprint: item.fingerprint }); setRevokePeer(''); clearRemote(); })}>Confirm revocation</button></div>}</li>)}</ul>
      <div className="collab-access"><p>{status.listening ? `Secure listener active on port ${status.port}. Share this computer’s reachable IP and this port directly with your verified peer.` : 'Secure listener is stopped. It never starts automatically after restart.'} This is separate from OmniDrop’s HTTP service.</p><button className="button secondary" disabled={busy} onClick={() => void action(() => local(status.listening ? 'stop' : 'start'))}>{status.listening ? 'Stop secure listener' : 'Start secure listener'}</button></div>
      <h4>Outgoing invitations for this project</h4><p className="fine">Prepare a draft above, then offer it to the verified recipient. Offering shares only the scope name, proposed role and expiry. The recipient retrieves it while this listener is active. Only member and guest roles are supported remotely.</p>
      <ul className="collab-members">{data.invitationDrafts.map(item => <li className="collab-member" key={item.id}><div><strong>{item.recipientName} · {item.role}</strong><span>{item.contextId ? data.contexts.find(context => context.id === item.contextId)?.name ?? 'Context' : 'Project'} · {item.status}</span></div>{item.status === 'prepared' && ['member', 'guest'].includes(item.role) && status.peers.some(peer => peer.principalId === item.recipientId && peer.status === 'active') && <button className="button secondary" disabled={busy} onClick={() => void action(() => local('offer', { invitationId: item.id }))}>Offer to verified participant</button>}{['offered', 'accepted'].includes(item.status) && <button className="text-link" disabled={busy} onClick={() => void action(() => local('revoke', { invitationId: item.id }))}>Revoke remote access</button>}</li>)}</ul>
      <details className="collab-disclosure"><summary>Connect to a verified host</summary><p className="fine">Both desktops must import and verify each other’s certificates. The host must be online and listening. Remote invitations are separate from this local project; accepting does not import files or create a local project copy.</p>
        <form className="collab-add" onSubmit={event => { event.preventDefault(); void action(fetchRemote); }}><fieldset disabled={busy}><legend>Peer connection</legend><label>Verified host<select required value={peer} onChange={event => { setPeer(event.target.value); clearRemote(); }}><option value="">Choose a host</option>{status.peers.filter(peer => peer.status === 'active').map(peer => <option value={peer.fingerprint} key={peer.fingerprint}>{peer.displayName} · {peer.fingerprint.slice(0, 14)}</option>)}</select></label><label>Host IP address<input required value={host} onChange={event => { setHost(event.target.value); clearRemote(); }} placeholder="192.168.1.20"/></label><label>Secure port<input required type="number" min={1} max={65535} value={port} onChange={event => { setPort(event.target.value); clearRemote(); }}/></label><button className="button">Fetch invitations & access</button></fieldset></form>
        {inbox && <><p className="fine">Verified host snapshot. Refresh to confirm current access; cached status is never authorization.</p>{!inbox.length && <p className="collab-empty">This host has no invitations addressed to your certificate.</p>}<ul className="collab-members">{inbox.map(item => <li className="collab-member" key={item.id}><div><strong>{item.projectName}{item.contextName ? ` / ${item.contextName}` : ''}</strong><span>{item.role} · {item.status} · {item.expiresAt ? `invitation expires ${new Date(item.expiresAt).toLocaleString()}` : 'no invitation expiry'}</span></div>{item.status === 'offered' && <><button className="button" disabled={busy} onClick={() => void action(async () => { await query('accept', item.id); await fetchRemote(); })}>Accept invitation</button><button className="text-link" disabled={busy} onClick={() => void action(async () => { await query('decline', item.id); await fetchRemote(); })}>Decline</button></>}</li>)}</ul></>}
        {access && <p className="fine">Accepted scopes currently authorized by this host: {access.length ? access.map(item => `${item.projectName}${item.contextName ? ` / ${item.contextName}` : ''} (${item.role})`).join('; ') : 'none'}. Shared files, messaging and remote administration are not enabled.</p>}
      </details>
    </>}
    <BrowserEnrollment projectId={projectId} bridge={bridge}/>
    <SecureDevicePairing projectId={projectId} bridge={bridge}/>
  </details>;
}
