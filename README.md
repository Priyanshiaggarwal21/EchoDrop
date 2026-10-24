# EchoDrop

## A collaboration platform for developer work

EchoDrop is an evolving developer collaboration platform for moving not only files, but the context required to continue technical work across devices.

Developers routinely switch between a workstation, a test device, a second computer, and a collaborator’s environment. The handoff is usually fragmented: a file is sent without its project structure, a reproduction is separated from its notes, a transfer fails when the network changes, and the recipient has no safe way to inspect what arrived. Existing synchronization tools are optimized for storage or messaging; they rarely model the developer’s actual workflow of preparing, transferring, inspecting, testing, and resuming a project.

EchoDrop is being built to make that workflow explicit:

1. connect or verify a device;
2. select a file, reproduction, or project workspace;
3. review exactly what will be shared;
4. transfer it with integrity and recovery;
5. inspect the received project safely;
6. continue the task from the new device.

The near-term implementation is Windows-first with a browser client for Android-class devices. The longer-term goal is a trusted continuity layer for development work: a project can move between people and devices without losing its identity, state, or safety boundaries.

## What EchoDrop is today

The repository contains a working set of desktop, browser, transfer, collaboration, and validation components—not a finished distribution package.

### Working product surfaces

- **OmniDrop** — the primary share flow for individual files and structured project packages. It supports preparation, inclusion review, project exclusions, sensitive-content checks, and explicit send confirmation.
- **Project workspaces** — projects are represented as validated, versioned envelopes rather than opaque executable archives. Common generated directories are excluded, paths are checked, and size/file-count limits are enforced.
- **Cross-device LAN collaboration** — a Windows host can serve a browser client over a local network. QR and manual joining, expiring sessions, host approval, device removal, and authenticated workspace access are implemented.
- **Resumable transfers** — uploads are chunked, associated with file identity and size, hashed with SHA-256, and verified on completion. Existing transfer state can be resumed when the same file is selected again.
- **LivePreview** — an authorization-aware, sandboxed project inspection path for viewing project contents and approved preview surfaces without presenting arbitrary project execution as a feature.
- **Receiving and extraction** — recipients can download files, inspect project packages, and extract them into separate destinations without modifying the source package.
- **Secure remote collaboration foundation** — the desktop path includes an opt-in mutual-TLS collaboration channel with pinned participant certificates, explicit peer approval, scoped invitations, and revocation checks.
- **Developer-focused validation** — the repository includes focused checks for onboarding, transfer integrity and recovery, workspace authorization, LivePreview, project handling, and sensitive-content scanning.

The latest recorded milestone verified a Windows host and Android browser on a real local network, including QR joining, approval/removal, and normal file transfer. Automated checks cover additional behavior. Acoustic reliability, interrupted recovery on physical devices, packaging, and broad device compatibility remain separate validation work.

## The intended developer experience

EchoDrop should feel less like uploading an attachment and more like handing a colleague a well-defined working context.

An engineer preparing a bug reproduction should be able to select the relevant project, see excluded generated content, review potential sensitive material, and understand what the recipient will receive. The recipient should be able to inspect the project structure, preview permitted content, extract it safely, and continue from a known state. If a connection is interrupted, the system should recover from a verified checkpoint rather than restart blindly.

This model supports practical workflows:

- sending a minimal reproduction to a nearby test device;
- sharing a project with a collaborator without first placing it in a third-party cloud;
- moving a debugging session from a workstation to a mobile browser;
- reviewing project compatibility before attempting to run it elsewhere;
- transferring selected source and configuration while excluding generated output;
- preserving enough context for a task to continue after a device or network change.

## Product vision

EchoDrop is intended to grow from a reliable local handoff into a developer collaboration fabric with four connected ideas:

### Cross-device collaboration

Devices should be participants in a workspace, not anonymous upload and download endpoints. Pairing, approval, revocation, project scope, and transfer history should be visible and understandable. A developer should be able to move between a Windows workstation, browser client, and future desktop peers without rebuilding context at every step.

### Secure, recoverable transfer

The current LAN browser path uses authenticated sessions and resumable, hash-verified transfers. The product direction is to extend this foundation toward authenticated and encrypted transports, durable checkpoints, explicit trust changes, and recovery that can survive a change of connection without weakening authorization.

### Developer testing workflows

Transfer is often only the first step. EchoDrop is intended to support the complete loop: prepare a reproduction, send it to a test device or collaborator, inspect the result, run bounded checks, record what happened, and return useful evidence to the original workspace.

### Project continuity

The central unit of collaboration should become a project context containing selected files, exclusions, transfer state, preview permissions, test evidence, and handoff notes. This is the foundation for intelligent collaboration without pretending that an automated system understands a project before it has inspected it.

## Planned capabilities and research

The following names describe roadmap concepts and experiments. They are not claims that these capabilities are already implemented.

### Live Test Room — planned product capability

Live Test Room is the proposed shared environment for a developer and one or more test devices. It would coordinate a project handoff, preview state, test instructions, observed results, and return evidence in one room. The first implementation should remain narrow: explicit participants, bounded project access, auditable actions, and no assumption that remote execution is safe by default.

### Adaptive Test Mission Engine — planned research direction

The Adaptive Test Mission Engine would turn a developer’s objective—such as reproducing a mobile layout issue or validating a transfer after reconnection—into a sequence of measurable checks. It could adapt the next check based on device capabilities, transport conditions, project shape, and prior failures. This requires a transparent mission model, reliable evidence capture, and clear human approval; it is not an autonomous testing system today.

### Project Continuity & Trust Layer — product architecture direction

The Project Continuity & Trust Layer is the proposed foundation for identity, project scope, device relationships, handoff history, resumable state, and revocation. It should make trust portable across transports without making authorization implicit. The current repository contains pieces of this direction—project validation, host/member sessions, certificate-pinned remote peers, and transfer identity—but not the complete layer.

### Intelligent handoffs — future capability

An intelligent handoff could summarize what changed, identify likely missing files, explain compatibility unknowns, suggest a focused test mission, and ask for confirmation before sharing sensitive material. Such assistance must be grounded in observable project facts and user-approved scope, not generic generated summaries.

### ChirpPair — experimental pairing research

ChirpPair investigates short-range acoustic pairing for situations where QR scanning is inconvenient. The experiment explores browser microphone constraints, secure contexts, device and speaker variability, noise tolerance, replay resistance, and whether acoustic data should only bootstrap an authenticated flow. The current digital-PCM experiment is not a reliable pairing claim and is kept separate from the working QR/manual paths.

### Offline collaboration — future research

Offline collaboration would allow a device to retain project state and queue approved handoff actions while disconnected, then reconcile them when connectivity returns. The hard problems are conflict semantics, revocation while offline, durable local protection, and communicating stale trust. Offline operation is a product objective, not a current general capability.

## Technical architecture

EchoDrop is an npm-workspaces monorepo with deliberately separated application, shared-package, and experiment boundaries.

| Area | Current responsibility |
| --- | --- |
| `apps/desktop` | Electron host, Windows integration, local project access, pairing, project registry, collaboration IPC, and remote collaboration |
| `apps/web` | React application for welcome, workspace, OmniDrop, ProjectHub, receiving, devices, pairing, LivePreview, and collaboration views |
| `packages/core` | Shared platform-neutral types and protocol contracts |
| `packages/transfer` | Project envelopes, path safety, extraction, sensitive-content scanning, browser hashing, and transfer storage |
| `experiments/lan-connectivity` | LAN server and focused connectivity, onboarding, transfer, workspace, and preview checks |
| `experiments/acoustic-pairing` | Isolated acoustic pairing investigation |
| `docs/architecture` | Dependency direction and trust boundaries |
| `docs/decisions` | Recorded technical decisions and consequences |
| `docs/security` | Security design and review material |
| `docs/test-results` | Validation evidence and known gaps |

The browser application does not import Electron or Node-only APIs. Privileged local operations remain behind desktop IPC. Project data uses a versioned, uncompressed format with normalized paths, bounded sizes, generated-directory exclusions, and duplicate-safe extraction. Transfer identity and SHA-256 verification are kept separate from transport security so that a valid hash is not mistaken for encryption or peer authentication.

Two transport models currently coexist:

- **LAN workspace:** browser-compatible, session-authenticated local sharing over the current plain-HTTP implementation.
- **Remote collaboration:** an opt-in desktop path using TLS 1.3, mutual certificate authentication, certificate pinning, explicit peer records, scoped authorization, and revocation checks.

Keeping these models distinct is intentional. A device join is not automatically a secure identity, and the current LAN implementation should not be treated as production-secure networking.

## Engineering challenges

The project’s difficult work is at the boundary between developer convenience and explicit trust:

- local networks change shape because of firewall rules, isolation, address changes, and browser security policies;
- a resumable transfer must identify the same content rather than trusting a filename;
- a project package must handle path traversal, generated noise, oversized input, and accidental secrets;
- preview must provide useful inspection without becoming an unrestricted code execution service;
- pairing, approval, certificate expiry, revocation, and session expiry must remain understandable;
- offline state and cross-transport recovery require protocol versioning and durable, auditable state;
- proposed intelligent features must be evidence-driven and permission-aware.

These constraints are recorded in the architecture notes, decision log, security documentation, and test-result records rather than hidden behind product language.

## Roadmap

### Foundation — current

- Establish the desktop and browser workspace shell.
- Make file and project handoffs explicit and reviewable.
- Validate LAN onboarding, authorization, project handling, LivePreview, and resumable transfer behavior.
- Separate experimental pairing and future collaboration ideas from production paths.

### Trust and continuity — next

- Define protocol versioning and durable transfer checkpoints.
- Extend authenticated transport beyond the current trusted-network LAN boundary.
- Formalize project identity, handoff history, revocation, and recovery semantics.
- Validate interrupted transfers and device behavior on physical hardware.

### Developer collaboration — later

- Prototype Live Test Room workflows around bounded test missions.
- Explore Adaptive Test Mission Engine evidence models.
- Investigate cross-transport recovery and offline reconciliation.
- Evaluate ChirpPair only against explicit reliability and security acceptance criteria.

## Setup

Requirements: Node.js and npm. From the repository root:

```powershell
npm install
npm run build
```

The build runs TypeScript validation and both Vite production builds. To start the Electron desktop path after building:

```powershell
npm run desktop
```

Useful development commands:

```powershell
npm run dev
node --test experiments/lan-connectivity/chunk-upload.test.cjs experiments/lan-connectivity/lan-connectivity.test.cjs experiments/lan-connectivity/live-preview.test.cjs experiments/lan-connectivity/workspace-auth.test.cjs experiments/lan-connectivity/onboarding.test.cjs experiments/lan-connectivity/project-workspace.test.mjs packages/transfer/secret-scan.test.mjs
```

The browser client can be built independently with `npm run build -w @echodrop/web`. The desktop entry point is `apps/desktop/main.cjs`; the primary browser entry points are `apps/web/src/main.tsx` and `apps/web/src/lan.tsx`.

## Technical limitations and security

- The current LAN browser flow uses plain HTTP on a trusted local network. It does not provide encryption or protection against a hostile local network.
- The mutual-TLS collaboration path is separate, opt-in, and desktop-only; it does not make the LAN path secure.
- Acoustic pairing is experimental and must not be used as proof of identity or a secure channel.
- Offline operation, production packaging, broad Android compatibility, discovery, firewall behavior, and physical-device interrupted-transfer recovery are not established by the current milestone.
- Project limits, path validation, sensitive-content scanning, and sandboxed preview reduce risk but do not guarantee that a project contains no secrets or unsafe code.
- The repository includes public test-only certificate fixtures for automated checks. They are not production credentials and must never be reused.

## Technical documentation

- [Architecture boundaries](docs/architecture/overview.md)
- [Decision log](docs/decisions/README.md)
- [Remote collaboration security design](docs/security/task-04-remote-collaboration.md)
- [Progress and acceptance checklist](docs/progress-checklist.md)
- [EchoDrop implementation checklist](docs/echodrop-2-checklist.md)
- [Verification handoff](docs/test-results/ECHODROP-2-UI.md)
- [Foundation validation record](docs/test-results/ECHODROP-002.md)
- [ChirpPair audio research notes](docs/audio-auditions/README.md)

## Ownership

Copyright © 2026 Priyanshi Aggarwal. All rights reserved.

EchoDrop is proprietary software. This repository is not released under an open-source license.
