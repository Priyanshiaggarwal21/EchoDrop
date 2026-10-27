# Task 16D Stage 1: authenticated device observations

This stage implements real TLS publication and durable host inspection of a collaborator's scoped dependency observations. It does not establish complete device enumeration or make recovery/handover READY.

## Working workflow

1. Use existing explicit certificate trust, accepted project/context invitations and the host's existing TLS listener. Device pairing alone grants no scope access. Browser/HTTPS enrollment is not an mTLS inventory participant in this stage.
2. On the collaborator desktop, choose the authenticated remote project/context in the existing workspace and select **Collect this device & publish to host** in Guardian. The local project administrator must still have a valid protected identity. No renderer-supplied report, count, actor or filesystem path is accepted.
3. The host issues a protected, single-use, two-minute challenge over existing TLS 1.3 with mutual certificates and exact fingerprint pins. It binds nonce, host/source fingerprints, host-bound participant ID, project/context, current authority revision and role. Accepted contributor access is required; guests, device approval alone and unaccepted invitations cannot publish.
4. The source desktop main process reads matching local queue records. It obtains scoped transfer metadata from the host over TLS and uses that binding to inspect local receive manifests and protected save receipts. It publishes redacted facts and explicit UNKNOWN categories over the same transport.
5. The host checks the challenge, current authority, scope, source identity, generation time and strict report schema. Consuming the challenge and saving the report share an atomic protected write. Duplicate submission is rejected; an interrupted acknowledgement requires a fresh collection/challenge.
6. Scope administrators select **Refresh received reports** to inspect each enumerable participant/device. This reads durable reports; it does not remotely wake devices or force their owners to scan private storage. Publication is explicitly initiated on the source desktop. Offline sources become missing/stale, never implicitly clear.

The project authority remains on its hosting desktop. Remote queues can reference that project's ID from a different local project registry. The publisher therefore uses the existing accepted remote grant and host challenge, rather than inventing local membership for the hosted project. Source participant IDs are the host's existing certificate-bound roster IDs, not arbitrary source assertions.

## Observed coverage

| Category | Authoritative evidence | Interpretation |
|---|---|---|
| Outbound queue | Protected queue index; exact remote host fingerprint/project/context; each local project association reauthorized | Pending jobs, withdrawal pending, terminal retention records |
| Inbound deliveries/cache | Host-authorized content listing plus matching local receive manifests | Pending inbound delivery, incomplete download, completed cache record and matching size |
| Save receipts | Existing protected receipt bound to host-scoped content ID/hash | Claimed/incomplete save or recorded save; no destination read/disclosure |
| Participation | Host's current accepted invitation, membership and role, bound to its authority revision | Exact participation in this project or context; current role changes invalidate reports |

Inventory reads do not run transfer-engine recovery/cleanup or inspect destination contents. A completed cache or save record is historical lifecycle evidence, not a new full-file integrity check or proof that a saved file still exists. Missing/corrupt/legacy source records and overflow produce UNKNOWN coverage. A missing cache for an outstanding incoming host delivery remains a pending inbound fact. Incomplete save claims remain conservative blockers even if publication completed before its acknowledgement.

Queue metadata spans local project aliases only where the target fingerprint and exact remote project/context match. Records for other hosts/projects/contexts are excluded. Report facts contain only validated IDs, category and enumerated lifecycle state. Paths, filenames, descriptions, raw payloads, keys, credentials and IP addresses are not part of reports.

Always unsupported: external services/access dependencies, comprehensive device enumeration, unmapped or legacy receive caches, unrecorded saved copies and other contexts. The list of scoped certificate-bound roster participants is a useful partial directory, not proof that every actual device is known. Pairing registries, browser sessions and offline/unregistered installations do not establish a complete hardware inventory.

## Freshness, persistence and limitations

- Evidence schema/version 1; at most 100 facts per report, strict 64 KiB report limit, at most 100 durable reports and 256 pending challenges. One latest report per source fingerprint/project/context is retained. Capacity failure preserves existing evidence; no silent dropping of active obligations or automatic remote cleanup.
- The protected host index uses the existing atomic writer. Restart validates every challenge/report. Corrupt or inaccessible indexes fail closed and are preserved. No evidence is placed on legacy HTTP routes.
- Generation time allows at most 30 seconds of clock skew. Report age and host receipt age must both remain below five minutes. Replays, expired challenges, wrong scope/identity and authority changes are rejected. A new challenge supersedes an interrupted challenge for that same device/scope.
- Collection is a bounded observation across stores, not an atomic distributed snapshot. Work can change after collection. Device status is evaluated when inspected; there is no background freshness or live-presence claim.
- `OBSERVED` means covered categories were read, `PARTIAL` means some categories are UNKNOWN, `BLOCKED` means observed pending work, and `MISSING`/`STALE`/`REVOKED` withhold usable report contents. None means globally clear.
- TLS authenticates the submitting trusted desktop and protects the exchange. It does not remotely attest an uncompromised OS or prove the honesty/completeness of a modified peer application. The normal desktop collection path derives facts from stores and accepts no renderer declarations. Host validation never treats a peer's empty report as global clearance.

Guardian incorporates report identity/content/status into its source guard. New or stale reports invalidate affected plan/consent bindings on refresh. Pending work on the departing participant's device adds a BLOCKED execution-readiness check; other cases remain UNKNOWN. Recovery remains UNKNOWN and existing other-device/external dependency blockers remain in force. No ownership, membership, credential, filesystem cleanup or handover execution operation is added.

## Validation and Stage 2 boundaries

Focused tests use independent real TLS identities, authoritative queues/content caches, interrupted verified saves, explicit accepted invitations and protected-storage test doubles. They cover partial inventories, missing devices, freshness, replay, role/certificate changes, restart, corruption, scope isolation, redaction, native IPC wiring and Guardian source guards. Adjacent Guardian and TLS/transfer regressions are run separately.

Stage 2 still needs an authorized complete-device inventory model (including multiple installations/browser devices and decommissioning), source-initiated versus host-requested refresh policy, bounded coverage of unmapped legacy caches and all protected contexts, and independently verifiable remote dependency completeness. Full recovery remains a separate prerequisite. Physical two-device/offline behavior, certificate onboarding, packaged Electron and independent Windows DPAPI verification remain release gates. No cross-device completeness or handover execution is implemented by this stage.
