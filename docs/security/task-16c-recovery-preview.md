# Task 16C: portable snapshot and selected project metadata restore

Stage 2 extends the verified Stage 1 slice. It does **not** prove full disaster recovery, restore authority, or make Guardian recovery PASS/READY.

## Exact supported policies

| Policy | Authenticated snapshot fields | Live restore |
|---|---|---|
| `project-structure-preview/v1` | ID, type, status, origin, pin, created/updated timestamps | Preview only; existing files/enrollments remain readable |
| `project-metadata-restore/v2` | All v1 fields plus name and description | Explicitly selected name, description, status and pin only |

ID, type, origin and creation time must match the existing project. They cannot be restored. The registry update timestamp advances rather than rolling history backward. A snapshot may contain older supported metadata; this is shown as STALE evidence and exact field differences, not silently treated as current. An authority change since snapshot enrollment blocks restore.

Opaque `metadata` has no supported non-sensitive schema, so it is deliberately excluded and preserved in live data. Local folder paths/associations, files, contracts, environment findings, transfers/queues, memberships/roles, invitations, certificates, credentials, identity rebind and unrelated scopes are excluded. Context snapshots and restoration of a missing/corrupt project registry are unsupported. This is recovery of selected metadata in an existing authorized project, not reconstruction of a complete project or account.

## Export and independent verification

The current hosting desktop owner reviews the exact supported text in a native confirmation dialog before export. Names/descriptions are user-authored and are not automatically classified as secret-free; cancel and edit sensitive text before exporting. The reviewed source digest is rechecked after destination selection. Two separate, non-nested directories outside application storage hold a new random 256-bit `.edkey` and an AES-256-GCM `.edrecovery` package. No identity key or credential is exported. The portable key is outside DPAPI: protect it separately, preferably on independently held media. Directory separation does not establish separate disks/accounts/devices.

A fresh, bounded Node/Electron-as-Node process decrypts selected material without receiving the application store. AES-GCM authenticates the exact versioned manifest and ciphertext; SHA-256 verifies plaintext and source integrity. The host checks approved enrollment, project/principal binding, current protected identity and authority, package digest and source freshness. No renderer verification claim is accepted. Packages expire after seven days and verification evidence after 24 hours.

Standalone possession-based inspection (both versions):

`node apps/desktop/recovery-preview-cli.mjs <snapshot-file> <key-file> <project-id> <owner-principal-id>`

This verifies authenticated decryption and scope, not identity recovery or authorization on a new account. Keyholders can copy keys; expiry is enforced by the tool, not cryptographic destruction. Names/descriptions are confidential ciphertext at rest in packages and never appear in Guardian evidence or restore receipts. They appear only in the authorized local preview/export/confirmation views.

## Explicit restore workflow and authority

1. Select enrolled snapshot/key files and verify. Inspect exact current-versus-snapshot differences, coverage and blockers.
2. Explicitly select mutable fields. Nothing is preselected. The persisted preview expires after ten minutes and binds the project, principal, protected identity, authority revision and digest of the entire live project (including excluded fields).
3. Choose `restore-selected-metadata` and confirm the exact selected differences in a native dialog, whose default is Cancel.
4. Decrypt and verify material again. Hold the existing collaboration authority transaction through the registry write, verifying the current protected local principal is still the project owner and the identity/authority bindings still match. Under the existing single registry writer, compare the complete project digest again before committing. Concurrent edits cause a stale-preview error.
5. Atomically commit only the selected fields, a fresh update timestamp, and a redacted idempotency receipt. Other project fields, other projects and registry extensions remain unchanged. No second registry writer or generic restore IPC is introduced. HTTP/TLS peers cannot invoke the local restore operation; existing authenticated Guardian reads expose only bounded redacted evidence.

Planning status, pairing, possession of a package/key, and renderer-supplied actor IDs cannot authorize restore. Existing `data.localPrincipalId` ownership invariants remain unchanged. No membership, ownership, credentials or TLS trust are modified.

## Persistence and failure boundaries

The OS-protected recovery index holds at most 20 enrollments, with one latest preview per snapshot. It contains file references, digests and safe proof metadata, never raw keys or restored text. External exports use exclusive creation and fsync; incomplete/orphan files are preserved for owner inspection.

Registry metadata and receipt share the existing fsynced temporary-file + atomic rename commit. Failed replacement leaves the old registry intact. Preview expiry, corrupt receipt/index, changed source/authority, missing key, integrity failure and immutable conflicts fail closed. The single Electron main-process writer serializes updates; this is not a multi-process database or a defense against a privileged process replacing application files.

There are at most 100 durable restore receipts; capacity blocks further restores rather than silently discarding replay protection. A retry of the same preview and field selection returns the existing receipt without reapplying metadata; a different selection with that operation ID is rejected. If a later intentional edit exists, the receipt reports `currentMatches: false`. Receipts and unsupported live data never contain copies of restored text.

The evidence acknowledgement is a separate protected write after the atomic registry commit. If interrupted there, do not infer that metadata was not applied: retry the same still-valid selection to recover the receipt. After preview/package expiry, current state can be inspected and a new explicit preview made, but the expired operation cannot be executed. There is no automatic rollback after a successful commit. No hardware power-loss durability beyond the existing filesystem atomic-write guarantees is claimed.

Forget removes only the evidence enrollment/preview, not exported material or registry receipts. No automatic cleanup deletes recoverable files. Redacted `metadataRestoredAt` is historical evidence, not proof the live metadata has remained unchanged. Guardian continues to report overall recovery UNKNOWN regardless of package verification or successful selected metadata restoration.

## Verification and remaining gates

Focused tests exercise v1/v2 compatibility, real detached-process decryption, exact field coverage, tamper/scope rejection, native approval/cancellation, actual existing IPC wiring, authorization changes, stale previews, selected-field preservation, restart replay, corrupt receipts/index, failed atomic replacement and interruption between commit and acknowledgement. Protected storage/native dialogs are test doubles; the cryptographic package and standalone child process are real.

Physical destination independence, another device/account, packaged Electron child-process behavior and independent native DPAPI verification remain release gates. Full authority/data recovery, externally anchored provenance, rollback/freshness after total state loss, cross-device dependency completeness, ownership handover and irreversible/full restore remain separate work. Task 16C Stage 2 does not start those tasks.
