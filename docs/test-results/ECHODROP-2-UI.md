# EchoDrop 2.0 verification handoff

Run from the repository root:

- `npm run build` (TypeScript and desktop/LAN production assets)
- `node --test experiments/lan-connectivity/chunk-upload.test.cjs experiments/lan-connectivity/lan-connectivity.test.cjs experiments/lan-connectivity/live-preview.test.cjs experiments/lan-connectivity/workspace-auth.test.cjs experiments/lan-connectivity/onboarding.test.cjs experiments/lan-connectivity/project-workspace.test.mjs packages/transfer/secret-scan.test.mjs`
- `npm run desktop` (actual Electron app)

Latest full test run: 47 passed, 1 failed (existing ggwave digital PCM decoder). Baseline: 48 passed. Loopback and link tests need permission outside the execution sandbox. No backend code was changed to conceal the acoustic failure.

## Manual acceptance journeys

1. Fresh app storage: welcome appears; Enter opens Home. Reload: Home. Settings: Show welcome returns to exact approved headline.
2. No approved devices: open Share, select a file or project, visit Connect and return. File object, inspection and exclusion choices must remain. No pairing needed for preparation or preview.
3. Project review: filenames readable beside their checkbox. Checked = Included. Bulk exclusion removes all warning files. Prepare package; alter an inclusion: the prepared package must disappear until prepared again. Send requires explicit secret consent when flagged.
4. Connect: existing invitation window offers QR, Manual and ChirpPair. Confirm request IDs before approval. Revoke access and verify retained transfer can resume only after reapproval. Acoustic signal and mark remain original.
5. Send: confirm acknowledged byte progress, SHA-256 completion and activity entry. Interrupt network, restore, resume from cached file; after reload reselect unchanged file. No unsupported pause/cancel controls.
6. Receive: refresh completed files, download a normal file. Extract an .echoproject twice into one parent. Confirm distinct folders, structure, success notice and Open Folder. Source files must remain untouched.
7. Workspace: choose static project, inspect path/entry, start, refresh, open, stop. Verify blocked private paths and expiry remain intact.
8. Settings: Light/Dark/System, reduced motion and mute persist. Tab through navigation and controls; use visible focus and skip link.
9. Android browser: join, inspect responsive navigation, download files/projects. .echoproject download must not offer native extraction or Open Folder.
10. Audio: open ../audio-auditions/index.html. Audition deliberately at low speaker volume. No choice is enabled until approved; samples cannot replace pairing data.

These are acceptance steps, not claims of completed physical-device testing. See ../echodrop-2-checklist.md for executed evidence and ownership boundaries.
