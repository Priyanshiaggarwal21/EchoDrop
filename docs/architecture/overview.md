# Architecture boundaries

Status: implemented boundaries for the current milestone; packaging and production security remain out of scope.

## Responsibilities and dependency direction

- `packages/core`: platform-neutral shared types and protocol contracts. Must not depend on apps, experiments, Electron, or platform APIs.
- `packages/transfer`: resumable, integrity-checked transfer storage and browser hashing.
- `apps/desktop`: Windows Electron host and authenticated local workspace bridge.
- `apps/web`: React introduction, workspace, OmniDrop transfer UI, and browser-compatible LAN client; must not import desktop code or Node/Electron-only APIs.
- `experiments/*`: disposable feasibility work, separate from production packages. Experiments may consume shared contracts if useful; apps and shared packages must not import experiments. Promoting a finding requires a recorded decision and appropriate validation.

These rules are documented, not enforced by dependency tooling yet. Runtime dependencies are declared in the workspace manifests and locked in the root package-lock.json.

## Constraints and questions to resolve

Windows is the initial desktop target. Android browsers are the initial mobile target. Development must fit a solo developer and zero-budget tooling constraints.

Local-network operation without internet is an objective requiring device tests. Discovery, transport, browser access, firewall behavior, network isolation, permissions, and packaging remain undecided. Do not infer offline operation from repository structure.

Acoustic pairing is an isolated hypothesis. Browser microphone access, secure-context requirements, device variability, and noise need investigation before selecting a design. Pairing alone does not establish authentication or a secure channel.

The current implementation provides expiring host/member sessions, host approval, resumable chunks, SHA-256 integrity checks, and sandboxed LivePreview. Plain HTTP, trusted-network operation, protocol evolution, threat modeling, and production packaging remain limitations requiring further decisions and validation.
