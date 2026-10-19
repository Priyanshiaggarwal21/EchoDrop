# EchoDrop

EchoDrop is a solo-developed, zero-budget project for collaboration over a local network, with a Windows desktop client and an Android-compatible browser client. Offline operation remains a design goal and is not fully verified.

The current implementation includes an Electron desktop host, React introduction and workspace UI, authenticated LAN access, resumable SHA-256-verified transfers, QR/manual/acoustic invitation experiments, and sandboxed LivePreview. The LAN service uses plain HTTP and requires a trusted network; this project does not claim a secure channel or production packaging.

## Repository layout

| Path | Intended responsibility |
| --- | --- |
| `apps/desktop` | Future Electron + React Windows client |
| `apps/web` | Future Android-compatible browser client |
| `packages/core` | Shared types and protocol contracts |
| `packages/transfer` | Future resumable transfer engine |
| `experiments/lan-connectivity` | Isolated connectivity feasibility spike |
| `experiments/acoustic-pairing` | Isolated acoustic pairing feasibility spike |
| `docs/architecture` | Boundaries and open design questions |
| `docs/decisions` | Recorded decisions and rationale |
| `docs/test-results` | Executed checks and their limitations |

## Inspect the foundation

Use PowerShell from the directory containing this README and `package.json`:

```powershell
node --version
npm --version
npm pkg get name private workspaces
npm pkg get name private --workspaces
git diff --check
```

npm 7 or newer supports workspaces. See the validation record for the versions actually used; no broader runtime compatibility is established. No dependency installation is required for these checks. Workspaces are declared directly in the root `package.json`; npm needs no separate workspace configuration file.

`tsconfig.base.json` supplies shared compiler defaults. The web workspace provides the production build; the desktop workspace launches Electron after the web build. Targeted Node tests live under `experiments/lan-connectivity`.

Install dependencies with `npm install`, build with `npm run build`, and launch the desktop app with `npm run desktop`. Review dependency licenses and Windows compatibility before distribution.

## Planning and evidence

- [Architecture](docs/architecture/overview.md)
- [Decision log](docs/decisions/README.md)
- [Seven-day checklist](docs/progress-checklist.md)
- [Foundation validation](docs/test-results/ECHODROP-002.md)

## Ownership and GitHub preparation

EchoDrop is proprietary software. Copyright © 2026 Priyanshi Aggarwal. All rights reserved. This repository is private initially and may become public later; public visibility does not grant permission to copy, modify, distribute, or otherwise reuse the software.

Prepare clean, logically grouped local commits without changing existing source code or Git history. Do not push or change repository visibility until publication review is complete. No MIT, Apache, GPL, or other open-source license applies.
