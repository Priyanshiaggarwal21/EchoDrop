# EchoDrop Task 16B — Recovery and Dependency Evidence Handoff

Status: groundwork only. This document does not make Guardian recovery or
dependency checks verified, and it does not authorize or implement handover.

## 1. Existing verified capabilities

The current implementation has useful evidence providers, but they prove
different properties:

| Capability | Reusable source | What it proves | What it does not prove |
|---|---|---|---|
| Local participant binding | [`participant-identity.mjs`](../../apps/desktop/participant-identity.mjs) | The persisted local participant record decrypts under the current OS-protected storage provider and matches the current local principal. Missing protection, changed principal, malformed identity, and failed decryption fail closed. | Recovery under another OS account, recovery after key loss, human identity, or an independently verified backup. |
| Collaboration persistence and authority | [`collaboration-store.mjs`](../../apps/desktop/collaboration-store.mjs) and [`guardian-authority.mjs`](../../apps/desktop/guardian-authority.mjs) | Atomic persistence, current project/context membership, local participant binding, peer certificate bindings, current roles, and authority revisions. Reads reconcile expired/revoked remote state. | That a restored copy is current, complete, or safe to use as a recovery source. |
| Device pairing | [`device-pairing.mjs`](../../apps/desktop/device-pairing.mjs) | Pairing invitations are protected, scoped to project/context and certificate fingerprint, expire, survive restart, and revoke when the peer is no longer active. | Cross-device state completeness, backup availability, or recovery authority. |
| Resumable local delivery queue | [`delivery-queue.mjs`](../../apps/desktop/delivery-queue.mjs) | Protected queue records and staged chunks are bound to project/context/content IDs, integrity checked, resumable after restart, and stopped by authorization loss. | Private queues on another device, queued work not represented by this desktop, or completeness across devices. |
| Verified recipient save | [`verified-save.mjs`](../../apps/desktop/verified-save.mjs) | A local partial save can resume only when the claim, destination, partial digest, final digest, and current authorization match. Conflicts and corrupt receipts/partials are preserved and fail closed. | That a saved copy can be revoked, that another device has no copy, or that recovery can recreate the original authority. |
| Secure content history | [`secure-content-store.mjs`](../../apps/desktop/secure-content-store.mjs) | Transfer metadata and content operations are current-authority and project/context scoped; cancellation and digest failures prevent publication; restart restores durable transfer state. | Complete external access history or revocation of already downloaded copies. |
| Guardian source assessment | [`guardian-store.mjs`](../../apps/desktop/guardian-store.mjs), [`guardian.mjs`](../../packages/core/guardian.mjs) | Current server-side transfer/queue observations, authority changes, protected contexts, pending transfers, saved copies, and inaccessible evidence are represented as deterministic risks. | Verified recovery or complete external/other-device dependency knowledge. |

These are persistence, integrity, authorization, and local-observation
capabilities. They are not a recovery protocol.

## 2. Confirmed gaps

### Verified recovery does not exist

There is no backup manifest, signed recovery package, independent recovery
device challenge, key escrow, cross-account identity rebind protocol, or
restoration freshness/rollback detector. The existing OS protection is
explicitly account-bound. The security record also states that restoring an
old registry can restore old local state and must not silently rebind identity:
[`task-04-remote-collaboration.md`](../security/task-04-remote-collaboration.md).

`guardian-readiness.mjs` therefore correctly emits
`recovery-capability: UNKNOWN`, and
[`packages/core/guardian-readiness.mjs`](../../packages/core/guardian-readiness.mjs)
rejects any externally supplied recovery claim that attempts to turn it into
`PASS`.

### Cross-device dependency completeness does not exist

The Guardian collector in
[`remote-ipc.cjs`](../../apps/desktop/remote-ipc.cjs) can observe the hosted
desktop's content records and, when the local delivery queue is available, its
local queue. It deliberately reports `queueKnown: false` for remote
participants and does not query private queues on other devices. The core
assessment consequently retains:

- `other-device-queues: UNKNOWN`
- `access-dependencies: UNKNOWN`
- `private-queue-unknown: UNKNOWN` where the local queue is inaccessible

The local queue's `continuity()` API in
[`delivery-queue.mjs`](../../apps/desktop/delivery-queue.mjs) is an observable
local source only. Pairing and remote collaboration authenticate peers and
scope access, but do not provide a dependency inventory or completeness
attestation.

### Observable versus inaccessible versus unsupported

| Evidence | Current classification |
|---|---|
| Current hosted transfer records in the authorized project/context | Observable when the content store is available; missing/corrupt history fails closed. |
| Current local delivery queue and staged chunks | Observable only on the desktop hosting that queue and only with current authority. |
| Local verified-save claim, partial, and final file | Observable to the local save provider; it proves local integrity, not global absence. |
| Protected project/context membership and peer status | Observable through the authoritative collaboration transaction. |
| Queue or pending save on another desktop/device | Unsupported; remains `UNKNOWN`. |
| Copies already downloaded by another participant/device | Unsupported and not revocable; saved-copy risk remains `UNKNOWN`. |
| Backup freshness, provenance, rollback detection, and cross-account restore | Unsupported; recovery remains `UNKNOWN`. |
| Physical-device state or native DPAPI behavior in this QA environment | Not verified here. |

## 3. Coverage and fixes

No production defect was reproducibly identified and no files were changed.
Existing focused tests already cover the requested evidence-provider
boundaries:

- `node --test apps\desktop\device-pairing.test.mjs`
  - pairing expiry, corruption preservation, identity binding, context
    isolation, revocation, restart, and single-use acceptance.
- `node --test apps\desktop\delivery-queue.test.mjs`
  - restart/resume, integrity, incomplete staging, project/context and
    recipient binding, authorization loss, corruption preservation, and
    retention.
- `node --test apps\desktop\transfer-lifecycle.test.mjs`
  - partial-save restart, digest validation, destination conflicts, corrupt
    receipts, disk failures, and authorization loss before publication.
- `node --test apps\desktop\secure-content.test.mjs`
  - TLS transfer restart, cancellation, digest/history corruption,
    project/context isolation, membership revocation, and saved-copy behavior.
- `node --test apps\desktop\collaboration.test.mjs apps\desktop\remote-collaboration.test.mjs`
  - persistence, authority, project/context isolation, peer trust/revocation,
    invitation lifecycle, and remote access invalidation.
- `node --test apps\desktop\guardian.test.mjs apps\desktop\guardian-approvals.test.mjs`
  - Guardian source freshness, inaccessible evidence, deterministic blockers,
    consent binding, stale/revoked identity, and UNKNOWN recovery/remote
    dependencies.

The existing test fixtures use protected test doubles. They do not claim
physical-device or native Windows DPAPI verification.

## 4. Codex-ready implementation sequence

1. **Define a recovery evidence contract before implementation.**
   Specify a versioned, authenticated recovery manifest containing the exact
   project/context scope, participant identity binding, authority revision,
   source generation/freshness, backup object digests, and an explicit
   restore/revocation status. Reject stale, partial, replayed, cross-scope, or
   cross-account manifests.
2. **Add an independently verifiable recovery provider.**
   Use a separate recovery device/key or user-confirmed out-of-band binding;
   never treat a restart, decryptable local registry, or client assertion as
   recovery proof. Keep OS-protected local identity binding and prevent
   automatic relinking.
3. **Add a server-authoritative dependency inventory protocol.**
   Define authenticated, project/context-scoped reports for each participating
   desktop/device: queue jobs, staged chunks, incomplete saves, retained
   content, and last-observed authority/source revision. Reports must be
   identity-bound, freshness-bounded, redacted, and fail closed when a device
   is offline, revoked, stale, or incomplete.
4. **Integrate providers as Guardian evidence only.**
   Preserve `UNKNOWN` for missing, inaccessible, unsupported, or stale reports.
   Do not add a readiness shortcut and do not accept renderer/client-supplied
   status.
5. **Add focused tests before any execution work.**
   Cover valid current evidence, expiry, replay, identity mismatch, scope
   mismatch, revoked device, missing report, corrupt report, stale authority
   revision, partial inventory, restart persistence, deterministic redaction,
   and `UNKNOWN` precedence.
6. **Run native release gates separately.**
   Validate the real Windows DPAPI binding and a physical second-device
   workflow only after the protocol tests pass. Execution remains out of scope
   until both recovery and dependency evidence are independently verifiable.

## 5. Security invariants to preserve

- Guardian readiness is derived only inside the authenticated authority
  transaction from authoritative server-side evidence.
- Project and context scope, current membership, peer certificate binding, and
  authority revision are checked on every read and mutation.
- Consent remains bound to the exact plan revision, actions, identities, guard,
  expiry, and current dependency state.
- Missing, corrupt, stale, revoked, inaccessible, or incomplete evidence fails
  closed; unsupported evidence is `UNKNOWN`, never `READY`.
- Local-owner and last-owner invariants remain enforced.
- Recovery must not silently rebind a participant to a different OS account,
  certificate, principal, project, or context.
- Previously downloaded copies cannot be made retroactively revocable.
- No ownership transfer, member removal, credential rotation, recovery
  authority change, or execution endpoint is introduced by this groundwork.

## 6. Remaining physical-device and DPAPI release gates

- Run [`dpapi-smoke.cjs`](../../apps/desktop/dpapi-smoke.cjs) against the
  Windows Electron binary twice and verify stable participant/principal IDs,
  successful protected decryption, and no plaintext private key in persisted
  state or renderer-visible status.
- Exercise the future recovery protocol on a real second device/account,
  including loss of the original device, revoked/stale identity, corrupted
  recovery material, rollback, and scope mismatch.
- Exercise dependency reports with a real second desktop/device offline,
  revoked, stale, partially reporting, and carrying pending queue/save work.
- Confirm authenticated TLS peer identity and current authority are rechecked
  after restart and membership/context revocation.

Until these gates pass, Guardian recovery and cross-device dependency checks
must remain `UNKNOWN`, and execution readiness must not become `READY`.
