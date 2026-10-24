# Task 04: direct secure collaboration

## Implemented boundary

The desktop uses a separate, opt-in TLS 1.3 listener with mutual certificate authentication. It does not reuse OmniDrop's HTTP listener, approved device sessions, cookies, QR invitations or LAN credentials. The remote protocol has only four operations: fetch addressed invitations, accept, decline and read your own accepted access status. It exposes no registry enumeration, roster, local paths, files, arbitrary commands or remote administration.

Electron 45.0.0 is pinned for this milestone. Older Electron processes are refused by the transport. Keep this dependency on a supported, patched release when distributing the application; a minimum-version check is not an automatic security-update service.

## Explicit trust setup (two desktops)

1. Create/import a local project on each desktop. The recipient's local project is only an entry point for connection controls; remote acceptance does not create or import a local copy of the host project.
2. Provision a unique self-signed participant certificate and matching private key on each desktop. Supported keys: P-256 or RSA >=3072; both TLS serverAuth and clientAuth extended usages are required. Certificates must be currently valid. An example using an installed, maintained OpenSSL is:

   ```powershell
   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -sha256 -nodes -days 365 -subj "/CN=EchoDrop participant" -addext "extendedKeyUsage=serverAuth,clientAuth" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,digitalSignature,keyCertSign" -keyout participant-key.pem -out participant-cert.pem
   ```

   Run this in a private directory, not the repository or a shared project folder. The key file is unencrypted for native import; protect that source file using OS permissions or your established key-management procedure. EchoDrop does not run OpenSSL or scripts on the user's behalf.
3. In Teams & People → Secure remote collaboration, import your public certificate and then your matching private key through native dialogs. The main process verifies the pair and seals the private key with Electron safeStorage (Windows DPAPI). The renderer receives only the public certificate/fingerprint. Import binds to the existing protected local participant. Replacement/relinking is not automatic.
4. Exchange **public certificates only**. Compare the complete SHA-256 fingerprints through an independently trusted channel, preferably in person. A matching name is not proof of identity. On each desktop, select the other person's certificate, select/create their local roster record, and enter the independently verified fingerprint. Both sides must complete this step. Certificate trust grants no project access, even where a local membership record already exists.
5. The host prepares a member/guest project invitation draft, offers it to the verified participant, and explicitly starts the secure listener. Share the host's reachable IP and displayed secure port. No discovery, relay, UPnP, firewall changes or NAT traversal is provisioned.
6. The recipient chooses that verified host, enters its IP/secure port and fetches invitations. Accept or decline explicitly. The host must remain online. Context invitations require accepted project access first and remain independently scoped.
7. Refresh host/recipient status to observe decisions and revocations. Revoke a remote invitation to block its remote scope without deleting local roster records. Revoking a project invitation also revokes dependent remote context access. Removing local membership invalidates its remote grants. Revoking certificate trust blocks all projects for that participant and stops connections. Previously downloaded copies cannot be revoked.

Trust changes stop the listener; restart it explicitly to update its TLS trust roots. Listeners never resume automatically after application restart. Endpoints are entered manually each session; invitation decisions and memberships persist on the authoritative host. The client fetches fresh state after restart rather than treating a cached UI snapshot as authorization.

## Security properties and limits

- Node/OpenSSL performs TLS certificate validation and proof of private-key possession. Both ends additionally require the exact explicitly trusted certificate fingerprint; certificates signed by a trusted peer are not automatically trusted identities. Client endpoint identity is the selected certificate, not a hostname or display name.
- A certificate identifies a key holder. Out-of-band verification is necessary to associate that holder with a person. There is no online account provider, recovery, transparent key rotation or multi-device identity sync.
- Invitations contain no bearer credential. A stable invitation ID cannot authorize a different certificate. Repeated acceptance returns the existing decision without duplicating/reinstating grants; declined, expired and revoked offers cannot be accepted.
- Acceptance, the target certificate binding and membership creation use the existing serialized atomic collaboration store. Authorization is rechecked at operation time, including issuer authority, current project/context grants and role caps. Remote roles are limited to member/guest. Local admin/owner membership cannot be replaced through remote acceptance.
- Offered names/roles/expiry are an explicit disclosure to the addressed participant. Terminal invitation history uses the offered scope labels rather than leaking later private changes. No private registry is served. The host remains authoritative, and can inspect data handled by its own process. This milestone makes no general E2EE claim for EchoDrop or its existing transfers.
- DPAPI protects stored key material for the Windows account; it is not protection against a compromised same-user process, a compromised endpoint, or an administrator. Registry files are not a tamper-proof audit log; restoring an old backup can restore old local state. Cross-account recovery must not silently rebind identity.
- Network frames, connections and deadlines are bounded. No automatic retries of mutations, redirects, HTTP fallback or arbitrary remote execution occur.
- Messaging, file collaboration, remote administration, offline delivery and public internet hosting hardening remain pending. The existing OmniDrop/LivePreview behavior has not been redefined as part of this transport.

## Native smoke and manual UI check

`apps/desktop/dpapi-smoke.cjs` runs against an isolated `echodrop-dpapi-*` directory directly in the OS temporary directory. Launch the Electron binary with this script and `--smoke-root=<absolute temporary directory>` twice. Expected output: `ok: true`, first `phase: create`, second `phase: restore`; stable participant/principal IDs, decrypted matching key in the main process and no plaintext key in registry/renderer status. It never opens the real EchoDrop registry.

Manual end-to-end UI check: run two desktops, follow the setup above, compare fingerprints, offer/accept/decline invitations, revoke an accepted project and verify its contexts lose remote access. Restart both applications, verify restored decisions and stopped listeners, then use Welcome/Home Back and the OS close button. Test Light/Dark themes, keyboard controls and narrow screens. Do not use the checked-in `test-fixtures/remote-tls` keys for real participants: they are public test credentials only.

Protocol references: [Node TLS](https://nodejs.org/api/tls.html), [Node X509Certificate](https://nodejs.org/api/crypto.html#class-x509certificate), [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage), [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

## Task 04 file changes

Modified existing integration files:
- `apps/desktop/package.json` and `package-lock.json` (Electron 45)
- `apps/desktop/collaboration-store.mjs`
- `apps/desktop/collaboration-ipc.cjs`
- `apps/desktop/registry-ipc.cjs`
- `apps/desktop/preload.cjs`
- `packages/core/invitation-drafts.mjs`
- `packages/core/collaboration.d.mts`
- `apps/web/src/main.tsx`
- `apps/web/src/CollaborationPanel.tsx`
- `apps/web/src/collaboration.css`

Added:
- `apps/desktop/remote-identity.mjs`
- `apps/desktop/remote-collaboration.mjs`
- `apps/desktop/remote-transport.mjs`
- `apps/desktop/remote-ipc.cjs`
- `apps/desktop/remote-reply.mjs`
- `apps/desktop/remote-collaboration.test.mjs`
- `apps/desktop/dpapi-smoke.cjs`
- `apps/web/src/RemoteCollaboration.tsx`
- `docs/security/task-04-remote-collaboration.md`
- `apps/desktop/test-fixtures/remote-tls/host-cert.pem`, `host-key.pem`, `peer-cert.pem`, `peer-key.pem`, `attacker-cert.pem`, `attacker-key.pem`, `signed-child-cert.pem`, `expired-cert.pem`, `extensions.cnf` (public test-only credentials/configuration)

Native DPAPI create/restore smoke passed on Windows with Electron 45.0.0 / Node 24.22.0. The synchronous safeStorage APIs still work in this pinned release but are deprecated; migration to their asynchronous replacements is required before upgrading to Electron 46. Full two-device UI/physical-network testing remains a manual release check.
