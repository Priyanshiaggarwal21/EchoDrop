# EchoDrop UI engineering handoff — Task 16E

Scope: focused backend integration, not an application-wide audit. Preserve existing uncommitted work. Antigravity owns visual design, navigation UX, responsive layouts, animations and styling. Codex owns backend behavior, security, permissions, state, progress and readiness; the backend remains authoritative.

## Confirmed and fixed in this slice

1. Metadata restore left Guardian plans and authenticated inventory evidence current because their freshness bindings covered membership but omitted project state. A separate project revision now joins the evidence revision used by Guardian and Inventory. Metadata/lifecycle changes, including restore, invalidate dependent evidence on the next authorized read; changes to another project do not. Recovery retains its independent source digest and unchanged membership-authority binding, so restoring older metadata remains possible under the same protected owner.
2. DNA checked access before and after collection but did not compare authority revisions. A change during collection could therefore return source visibility captured under earlier authority. DNA now compares project, authority and identity bindings before persisting or returning history/details. A mismatch fails closed and requests refresh. Existing event IDs, history, relationships and scope ACLs remain intact.

Existing Guardian plans/consents and inventory reports may become stale once after upgrading to the stronger evidence revision. Refresh/review or republish explicitly. Do not visually override stale status or carry approval into a changed revision. No ownership or security authority migration occurs.

## Entry points and component boundaries

All paths below are relative to the repository. Desktop APIs are exposed by `apps/desktop/preload.cjs` as `window.echoDesktop`. The main process validates the trusted renderer and current scope; no renderer-provided permission or verification flag is authoritative.

| Area / component in `apps/web/src` | Existing entry point | Functional boundary |
|---|---|---|
| `WorkspaceApp.tsx`, `navigation.mjs` | Existing Welcome/Home/Project history | Preserve Welcome → Home → Back and project/context navigation. Window X remains normal close. Do not add another router. |
| `ProjectHub.tsx` | `registry.list/create/update/selectFolder/openFolder` → `workspace:registry` | Persisted seven-type projects, create/import distinction, selected native folder, project switching. |
| `CollaborationPanel.tsx` | `collaboration.snapshot/execute` → `workspace:collaboration` | Teams, membership and contexts use existing role authority. Device trust does not confer membership. |
| `RemoteCollaboration.tsx`, `SecureDevicePairing.tsx`, `BrowserEnrollment.tsx` | `remoteCollaboration.run` → `workspace:remote-collaboration` and existing enrollment controllers | Explicit certificate trust, invitations and device enrollment/confirmation. Keep device pairing distinct from project invitations. |
| `OmniDrop.tsx`, `ProjectTransfers.tsx`, `DeliveryQueue.tsx` | Legacy transfer API; scoped `secureContent.run(projectId, action, payload)` → `workspace:secure-content` | Preserve legacy LAN/manual transfer separately from authenticated project TLS. Scoped content/receive operations and `queue-*` controls provide real progress, retention, save, cancellation and recovery states. |
| `IntentGuard.tsx` | `intent-*` actions through `secureContent.run` | Scoped intentions, collision warnings and existing synchronization. Warnings remain advisory. |
| `ContractHandshake.tsx`, `RuntimeHandshake.tsx` | `contract-*`, `runtime-*` | Static OpenAPI comparison is distinct from explicitly authorized local runtime requests. Runtime targets/credentials/confirmation remain backend controlled. |
| `EnvironmentRescue.tsx` | `environment-capture`, `environment-*` | Real capture, review/redaction and approved sharing. Do not imply automatic repair or installation. |
| `ProjectPulse.tsx` | `pulse-*` | Actual source-backed findings and decisions; no arbitrary health scores. |
| `ProjectDNA.tsx` | `dna-read`, `dna-detail` | Bounded durable history, source-backed relationships, pagination and currently authorized detail traversal. Refresh/capture is not exhaustive activity logging. |
| `ContinuityGuardian.tsx`, `HandoverConsent.tsx` | `guardian-list/create/update/review/cancel`, approval/acceptance actions | Planning, authenticated consent and server-derived readiness. Ready-for-review is not consent or execution authorization. |
| `RecoveryFoundation.tsx` | `recovery-list/create/preview/restore/forget` | Current hosted-project owner only. V2 encrypted metadata snapshot, independent preview, explicit field selection and native restore confirmation. V1 remains preview-only. |
| `DependencyInventory.tsx` | `inventory-publish`, `inventory-list` | Collaborator main process collects and publishes over pinned TLS. Scope admins inspect received reports. Host refresh does not wake or scan another device. |

`ProjectTransfers.tsx` currently composes Guardian, DNA, Pulse, Intent Guard, Handshake, Environment Rescue and Delivery Queue around the selected local/remote target. `ContinuityGuardian.tsx` contains Recovery and Dependency Inventory. Preserve the distinction between the local project association and the remote target's project/context IDs, fingerprint and endpoint. Never reuse a previous scope's results while switching targets.

## Ready for UI polish

- Project Home/create/import/switching and real empty states.
- Teams/People/context selection with role-aware controls and explicit invitation status.
- Transfer selection, Secret-Safe review, queue progress, saves, history and retry/error states.
- Intentions/collisions, contract comparison/review, runtime results, environment inspection, Pulse and DNA navigation.
- Guardian planning and consent review, selected metadata recovery, and per-device inventory inspection.

These components already have functional backend paths. Improve hierarchy, accessibility, responsive composition and progressive disclosure without replacing working flows with mock data or decorative actions. Preserve native confirmation for restores and unsafe runtime methods. Respect reduced motion. Frontend polish must not bypass backend rejection or erase actionable errors.

## Mandatory honest messaging

| Situation | Required meaning |
|---|---|
| Guardian recovery | Full recovery remains UNKNOWN. Metadata restore does not recover identity, ownership, memberships, files, contracts or queues. |
| Handover | Execution is disabled. No transfer/removal/revocation/credential-rotation action exists. Consent alone is insufficient. |
| Metadata restore | Select name/description/status/pin only; show exact differences and native confirmation. Recheck after stale preview. An interrupted acknowledgement can follow a committed write; retry uses its receipt. Other metadata and authority remain unchanged. |
| Inventory | OBSERVED is limited coverage; PARTIAL includes UNKNOWN categories. Missing/stale/revoked reports cannot clear responsibilities. Overall device completeness remains UNKNOWN even when one report is empty. |
| Device status | Five-minute inventory freshness is checked on refresh, not live presence. Offline/unregistered/browser devices are not a complete enumerated set. |
| Retained/saved files | Recorded cache/save lifecycle is not new physical-file verification. Previously downloaded copies cannot be remotely revoked. |
| Runtime API tests | Only actual observed responses are runtime evidence. Static schemas do not prove server behavior. |
| DNA | Source-backed history and deterministic links only. Missing sources may be withheld; capture can saturate or miss intermediate states. No invented causal/AI narrative. |
| Release gates | Physical devices, independent native DPAPI, certificate onboarding and packaged Electron behavior must not be labelled verified from Node fixtures. |

## Frozen Welcome Page

**Both approved Welcome Page light and dark designs are frozen.** Preserve `apps/web/src/WelcomePage.tsx` and `apps/web/src/welcome.css`, including existing layout, typography, copy, background geometry, theme palettes, animations and interaction behavior. Preserve the current approved Pearl Aurora light / Aurora Blend dark direction. This handoff does not authorize another Welcome design exploration, gradient replacement, or shared-theme change that alters it.

## Task 16E validation and remaining work

The Task 16E reproductions were independently rerun from the repository root:

| Validation | Command | Result |
|---|---|---|
| Engineering integration, restore, inventory and DNA | `node --test apps/desktop/engineering-integration.test.mjs apps/desktop/recovery-restore.test.mjs apps/desktop/dependency-inventory.test.mjs apps/desktop/project-dna.test.mjs` | **PASS — 53/53** |
| Adjacent security regression | `node --test apps/desktop/secure-collaboration.test.mjs` | **PASS — 11/11** |
| Production web build and LAN bundle | `npm run build` | **PASS — TypeScript check and both Vite builds** |

The integration coverage confirms that metadata restore invalidates Guardian plans, recovery evidence and dependency-inventory evidence; the invalidation survives registry restart; another project's metadata change does not invalidate the target project; and the persisted receipt does not expose private metadata. It also confirms that DNA rejects authority/project changes during collection without persisting or returning stale history, preserves the prior index, and maintains project/context scope isolation. Recovery still permits a selected metadata restore when the current protected owner authority is unchanged, while membership, identity, expiry, stale-preview and non-owner changes fail closed. Readiness remains false/UNKNOWN where evidence is stale or recovery is incomplete; no ownership transfer or handover execution endpoint was added or invoked.

The focused validation is **PASS**. Physical devices, independent native DPAPI, certificate onboarding outside the Node fixtures, packaged Electron behavior, complete device enumeration, full recovery, host-requested remote inventory refresh and exhaustive intermediate-event capture remain **UNVERIFIED** or **UNKNOWN** and must not be presented as release-ready. This slice introduces no visual, layout, animation or design-system changes.
