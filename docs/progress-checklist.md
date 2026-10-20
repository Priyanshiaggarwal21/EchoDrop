# Seven-day progress checklist

Relative planning days, not completed work or delivery promises. Only checked items have evidence. Later implementation work requires its own task scope.

## Day 1 — Repository foundation
- [x] Inspect existing files and Git state before changes.
- [x] Define six private npm workspaces and intended TypeScript defaults.
- [x] Document architecture boundaries and initial decisions.
- [ ] Review validation evidence and approve the foundation.

## Day 2 — Scope and acceptance criteria
- [ ] Define a minimal collaboration use case and explicit non-goals.
- [ ] Inventory available Windows and Android devices and browser versions.
- [ ] Write measurable connectivity and offline acceptance criteria.

## Day 3 — LAN spike planning
- [ ] Define an isolated LAN test matrix, including firewall and network isolation cases.
- [ ] Record candidate approaches and free-tool license considerations.
- [ ] Specify evidence to collect before authorizing spike implementation.

## Day 4 — LAN feasibility evidence
- [ ] Run the separately scoped connectivity spike on real devices.
- [ ] Record exact setup, commands, successes, failures, and limitations.
- [ ] Record a transport decision or unresolved blockers.

## Day 5 — Acoustic feasibility
- [ ] Define microphone permission, browser-context, and noise test cases.
- [ ] Run a separately scoped acoustic pairing spike if justified.
- [ ] Record evidence and decide whether to proceed or defer.

## Day 6 — Contract and transfer design
- [ ] Draft protocol versioning and transfer lifecycle requirements.
- [ ] Define interruption, resumption, persistence, and integrity acceptance criteria.
- [ ] Document trust assumptions and unresolved security questions without claiming guarantees.

## Day 7 — Review and next milestone
- [ ] Review evidence against the original constraints.
- [ ] Select the next small implementation task and its validation plan.
- [ ] Review tooling licenses and Windows compatibility before adding dependencies.
- [ ] Seek owner approval before committing or pushing.

## Verified LAN milestone checkpoint — 2026-10-20

The owner verified the current implementation on real devices: a Windows host connected to an Android client over the local network, QR joining, approved-device removal, and normal file transfer all worked. These are owner-reported real-device results, not simulated browser or loopback results.

Included in this checkpoint:

- The existing website and workspace UI, including the LAN diagnostics/help surface.
- LAN interface discovery, current-port URLs, QR/manual joining, host approval, device removal, and normal authenticated file transfer.
- Focused automated coverage for LAN socket reachability, QR/manual onboarding, transfer integrity/resume/restart behavior, LivePreview, and workspace authorization.

Not verified by this checkpoint:

- Resume behavior on a real Windows-to-Android interruption/reconnect.
- Acoustic pairing, including microphone/hardware capture and the bundled ggwave digital PCM experiment.
- Electron/Android packaging or distribution.
- Secure transport beyond the documented trusted-network, plain-HTTP boundary.

Validation run from the repository root:

- `npm run build` — passed TypeScript validation and both Vite production builds.
- `node --test experiments/lan-connectivity/chunk-upload.test.cjs experiments/lan-connectivity/lan-connectivity.test.cjs experiments/lan-connectivity/live-preview.test.cjs experiments/lan-connectivity/workspace-auth.test.cjs` — passed.
- `node --test experiments/lan-connectivity/onboarding.test.cjs` — 5 non-acoustic onboarding checks passed; the separate bundled ggwave digital-PCM check was observed to fail and remains outside the passing milestone gate.
