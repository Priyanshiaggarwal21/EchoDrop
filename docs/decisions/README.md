# Decision log

## ECHODROP-002 / 001 — Minimal npm-workspaces foundation

Date: 2026-10-18  
Status: accepted for repository scaffolding

Context: a solo-developed, Windows-first project needs clear boundaries without committing to untested networking or pairing designs.

Decision:

- Use npm workspaces with six explicit package paths and private manifests.
- Separate apps, shared packages, and experimental spikes.
- Adopt TypeScript as the intended source language; keep only shared compiler defaults until real source requires a compiler and workspace-specific configuration.
- Add no dependencies, runtime entry points, fake implementations, or empty test commands.
- Record evidence separately from intentions. Review each dependency before adoption.

Consequences: the workspace inventory can be validated with npm now. Builds, type checks, and runtime tests are not available yet. Dependency rules are a documented convention. The first dependency addition must include a root npm lockfile and license review.

Deferred: Electron/React versions, bundler, test framework, transports, discovery, acoustic approach, persistence, authentication, and packaging.

## ECHODROP-003 — Proprietary GitHub preparation

Date: 2026-10-19  
Status: accepted

Decision:

- Keep the repository private initially; public visibility remains a future owner decision.
- Treat EchoDrop as proprietary, with copyright © 2026 Priyanshi Aggarwal. All rights reserved.
- Do not add an open-source license.
- Preserve source code and Git history while preparing clean, dependency-aware local commits.
- Do not push or change repository visibility as part of preparation.

## Adding decisions

Add a numbered entry or separate Markdown file with date, status, context, decision, alternatives, consequences, and links to supporting test results. Preserve earlier decisions and mark superseded decisions explicitly.
