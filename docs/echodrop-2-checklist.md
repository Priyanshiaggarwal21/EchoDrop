# EchoDrop 2.0 implementation checklist

Reviewed against all 14 sections of the approved request before source edits (2026-10-22).

| Phase / requirements | Existing files / change | Verification |
|---|---|---|
| 1 Architecture, preservation, references | main/lan shells; OmniDrop; ProjectShare; Devices/Pairing; LivePreview; desktop IPC; core auth/preview; transfer engine; LAN server and tests inspected. Clean main, existing stash untouched. No image references found. | Baseline production builds and all existing Node suites |
| 1 Review layout, labels, extraction feedback | ProjectShare.tsx, omnidrop.css: inclusion rows, explicit labels, persistent extraction success/Open Folder, contextual errors | Build; review inclusion and extraction flows |
| 2 Palette, typography, motion | styles.css and new shared shell styles; exact light/dark tokens; preserve current serif direction and acoustic SVG | Both builds; keyboard/mobile inspection |
| 2 Welcome/Home/navigation | shared WorkspaceApp.tsx used by main.tsx and lan.tsx; first-launch welcome, revisit, adaptive home; Home/Share/Receive/Workspace; Activity secondary | First/return launch; navigation; selections stay mounted |
| 2 Connect | Devices.tsx with clear QR/Manual/ChirpPair entry via existing authenticated pairing window; Pairing.tsx preserved | Existing onboarding/auth tests; physical pairing remains manual |
| 3 Share | OmniDrop/ProjectShare: Files/Project modes, local preparation, explicit review/send, actual sizes and workspace recipient scope | File/project selection and Secret-Safe tests |
| 3 Transfer | Existing transfer state, persistent summary, detailed progress and recovery; no unsupported pause/cancel | Existing chunk/resume/hash tests; UI regression |
| 3 Receive | Incoming and Received sections, genuine API limits, extraction action distinct from download; mobile limits explicit | Project extraction tests; manual native Open Folder |
| 3 Workspace | Retain LivePreview selection/details/start/open/stop and sandbox; retain project inspection and received projects | Preview tests; no invented collaboration |
| 4 Activity/settings | Genuine journal; timestamp new events only; theme/mute/reduced-motion preferences; connection settings | Build, navigation, preference persistence |
| 4 Responsive/accessibility | Focus, reduced motion, readable wrapped filenames, mobile controls | Browser QA if available; production build |
| 5 Audio auditions | Separate low-gain playable samples for five named identities; no default sound or codec change | WAV metadata/sample checks; user approval still required |

## Completeness and regression review
- Keep OmniDrop mounted across navigation, including Connect, to retain selected File objects and project exclusion choices. Do not duplicate transfer instances.
- Desktop service startup is required by native project authorization, but pairing is not. Start service independently of device connection.
- Desktop pairing bridge does not expose invitation generation or acoustic runtime. Keep existing authenticated pairing window rather than widen IPC trust boundaries.
- Recipient routing, incoming transfer enumeration/sender metadata, pause and cancel are absent. Label actual workspace audience and incoming visibility limits; never fabricate controls/data.
- Project extraction and native opening already exist; UI must display success in Receive without hiding it inside Share.
- No screenshots supplied/found; locked textual design plus existing serif typography/acoustic mark are the available direction.
- Existing acoustic digital PCM test is documented as failing; record baseline outcome without changing protocol.
- Preserve browser guest/host distinctions, explicit consent, verification, duplicate-safe extraction, and all preview restrictions.
- Remaining validation scope: environment-file scanning, binary classification, pause/resume/cancel engine/protocol, extraction security/filesystem changes, and new backend tests.
- Roadmap capabilities and TinyFish excluded. No fabricated metrics/presence/execution results.
- Real Windows/Android, acoustic hardware, native dialogs and two-device journeys require real-device QA; automated checks cannot establish them.

## Execution evidence
Pending baseline and incremental phase checks.

## Phase results (2026-10-22)
- Phase 1: audit/checklist complete; baseline build passed; all 48 existing tests passed after sandbox socket/link restrictions were removed. Inclusion rows and labels corrected; native extraction feedback integrated.
- Phase 2: shared desktop/LAN shell, exact theme tokens, welcome/revisit, Home, primary navigation and Connect implemented. Existing authenticated pairing window retained, including original acoustic SVG and codec.
- Phase 3: mounted Share state, Files/Project switch, package-review-send separation, invalidation after inclusion edits, honest workspace audience, detailed unfinished transfers, persistent indicator, Receive extraction/download separation and existing LivePreview integrated. No engine/IPC changes.
- Phase 4: Activity from actual journal, timestamps for new transfers (no invented historical dates), journal order preserved on refresh, settings, focus/skip link, responsive rules and reduced motion implemented. Native visual inspection covered Home, Settings, welcome re-entry, Share Project without paired devices and opening native folder picker. Full keyboard, mobile and two-device journeys remain unverified.
- Phase 5: five separate playable WAV auditions and HTML player in docs/audio-auditions. PCM duration/peak metadata verified; no audio selected, shipped in application bundles or substituted for pairing.

## Validation outcome and remaining acceptance work
- Baseline: TypeScript + both Vite builds passed; 48/48 tests passed.
- Phase 1 build passed. Shared-shell TypeScript mismatches were fixed; subsequent builds passed.
- Regression: 47/48 existing tests passed. Bundled ggwave digital-PCM invitation decode returned an empty string in onboarding.test.cjs:198. The same test passed at baseline and previous repository evidence already records failures. Codec, signal and worker files are untouched. Acoustic reliability is unresolved, not claimed fixed.
- In-app browser failed to connect/attach to local preview. Windows Computer Use successfully inspected the actual Electron UI, but native dialog automation did not complete a project selection. No complete E2E or Android verification is claimed.
- Still requires real-device acceptance: QR/manual/chirp pairing, interrupted transfer/reconnect, file selection preservation, consent cancel/approve in UI, double extraction and Open Folder, mobile receive, keyboard and reduced-motion verification.
- API limitations remain explicit: no targeted recipients, inbound progress/sender feed, per-file approvals, pause/cancel endpoints, measured speed/ETA or arbitrary project execution. UI does not imply those exist.
- Source ownership boundaries and backend behavior unchanged. No Git history, branches, stashes, visibility or remote changes.
