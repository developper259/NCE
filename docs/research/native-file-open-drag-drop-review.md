# Review: Native File Open / Drag & Drop

- Branch: `feat/native-file-open-drag-drop`
- Base: `e4b6d793473230d2c49ae397c17973e1fac681f6` (`test(terminal): isolate shell navigation input`)
- Head: `f32d97ca18466ecdf669371ab89b1995e615320a` (`fix(ci): use supported PowerShell path parameter`)
- Commits under review: 8 (`8b5f9df`, `c445383`, `2187ace`, `a2288c2`, `2ba71a0`, `9ed42e3`, `b32b726`, `f32d97c`)
- Review date: 2026-10-25
- Scope: opening files/folders from the OS (macOS `open-file`, `second-instance` argv, startup argv), in-app file/folder drop, renderer delivery/acknowledgement, session/startup routing, and the Windows/macOS/Linux packaging integration.
- Method: read all 8 commit diffs and the final source; ran typecheck, builds, focused tests, the full unit suite, and the packaged-runtime check; ran a read-only Node experiment to confirm one finding. `test:electron` and `test:nsis-install` were not run (see Test execution log). No fixes were made.

## Resolution (2026-10-25)

All five findings and the actionable test/packaging observations were fixed after this review. The evidence below is preserved as written; this table records the resulting behavior.

| Item | Status | Resolution | Commit |
| --- | --- | --- | --- |
| F1 | Fixed | A window that has not signalled `rendererReady` now closes/commits without the renderer handshake while preserving session and recovery state; quit-all still waits for renderer-owned cleanup once ready. | `0d13ed0` |
| F2 | Fixed | Renderer progress is reported per file and re-arms the acknowledgement timer, replacing the absolute delivery lifetime. A genuinely stalled delivery still expires. | `3705e8e` |
| F3 | Fixed | Startup queue overflow is reported once a window exists; drop overflows return to the renderer instead of raising a second notification. | `6c80d69` |
| F4 | Fixed | `openedFolders` counts new windows, `focusedFolders` counts reused workspaces, and the drop status describes mixed and reused results. | `121999c` |
| F5 | Fixed | Copied startup chains are removed when they settle or when the coordinator is disposed. | `d24ad1c` |
| Classification bottleneck | Fixed | `mapWithConcurrency` validates up to 8 paths at a time while preserving input order and deduplication. | `6ca4318` |
| Empty file drop | Fixed | A `Files` transfer with no files clears the overlay without consuming the event. | `bc71bc3` |
| Test quality 1–3 | Fixed | NSIS `oneClick` is explicit and strictly asserted, both generated macOS document types are checked, and the drop harness tracks every listener and resolves `contains` by node type. | `aa61fcc` |
| NSIS multi-selection | Fixed | Both verbs set `MultiSelectModel=Player`, and the Windows smoke test validates it; unrelated registry setup now uses `CreateSubKey`. | `aa61fcc` |
| Test quality 4–5, remaining bottlenecks | Accepted | Electron/NSIS smoke coverage stays layered because the OS shell layer is platform-only; serial renderer file opening and folder creation are deliberate to preserve tab order, workspace uniqueness and the window limit. | — |

Verification after the fixes: `npm run typecheck`, `npm run build:main`, and the full `npm test` suite (1181 tests, all passing). `test:electron` and `test:nsis-install` still require a display/native rebuild and Windows respectively, so they were not rerun here.

## Executive summary

No high or critical defect was found in the core routing design. Drop targets are captured from the real IPC sender before any async work, system opens are serialized per destination window, renderer reloads are handled with per-attempt ACK IDs, and paths are canonicalized and stat-checked before use. The packaging work correctly claims alternate handlers only (`CFBundleDocumentTypes` with `LSHandlerRank: Alternate`; NSIS HKCU verbs; Linux `MimeType=` without defaults).

| Severity | Count |
| --- | --- |
| High / Critical | 0 |
| Medium | 1 |
| Low | 4 |

The medium issue is a side effect of delaying `rendererReady` until editor state restoration completes: native window close and application quit are silently refused during that interval. The low issues are a batch-ACK timeout that can report false failures, silent loss of overflow system opens, minor status-message inaccuracies, and a small bounded queue-entry leak.

## Findings

### F1 (Medium) — Window close and app quit are refused while startup state restoration runs

**Evidence**
- `src/js/main/Editor.js:155` sends `App:rendererReady` only after `initLoadState()` resolves.
- `src/js/main/Editor.js:633-636, 647-655` resolves the restoration promise only after `statesManager.loadStates(...)`; that path loads the project and reopens workspace tabs (`src/js/manager/StatesManager.js:642-646, 732-812, 845+`).
- `src/ts/Window.ts:981-990` (`requestQuit`) and `src/ts/Window.ts:1034-1046` (`commitPreparedClose`) return `false` while `rendererReady` is `false`.
- `src/ts/App.ts:268-278` aborts the whole quit when any window cannot prepare.
- Commit `2187ace` changed `src/js/main/Editor.js` from calling `rendererReady` immediately to chaining it after restoration; the base version invoked `initLoadState()` without awaiting it.

**Explanation / impact**
The native `close` event is prevented and routed to `Window.requestQuit()` (`src/ts/Window.ts:364-371`). Before `rendererReady`, that call resolves `false` and the close is silently cancelled. The same state gates `before-quit` → `performQuitAll()`, so Cmd+Q / App Quit is also silently cancelled while any window is restoring. The blocking interval equals the full restoration (opening saved tabs/files), which can range from fractions of a second to several seconds on large workspaces and is unbounded if a restore operation stalls. No feedback is shown to the user.

**Verification**
Verified by code inspection (state transition and gating are deterministic). Real-world duration was not measured. `npm run test:electron` was not run.

### F2 (Low) — A large external-open batch can be reported as failed before the renderer finishes, and the late ACK is then discarded

**Evidence**
- `src/js/addon/ExternalFileDropController.js:200-224` opens delivered files strictly sequentially and acknowledges only after the whole loop.
- `src/ts/Window.ts:34-37` sets the acknowledgement budget to 120 s; it is armed after each send (`src/ts/Window.ts:548-559`).
- On expiry the delivery settles with a failure for every path (`src/ts/Window.ts:623-633`), and a later ACK is rejected because the delivery is gone and the attempt no longer matches (`src/ts/Window.ts:566-569`).
- The unit test explicitly asserts the late ACK is ignored: `tests/external-open.test.js:433-449`.

**Explanation / impact**
A single request may carry up to 64 paths (`ExternalOpenCoordinator.ts:7`). With large files or slow/network storage, the sequential renderer loop can exceed 120 s after delivery. The user sees “Could not open N item(s)” although tabs may appear later; the late ACK cannot correct the result. The same fixed ACK budget applies to system opens once the target window is ready.

**Verification**
Verified by code inspection and by the existing late-ACK test. The frequency of >120 s batches is unverified.

### F3 (Low) — Overflow of queued system opens is dropped without user-visible feedback

**Evidence**
- `src/ts/manager/ExternalOpenCoordinator.ts:146-150` rejects new requests with `QUEUE_FULL` at enqueue time when 64 batches are already pending.
- `src/ts/App.ts:157` (startup argv) and `src/ts/App.ts:165-171` (macOS `open-file`) discard the returned promise with `void`.
- `src/ts/App.ts:219-222` only writes a console warning for `second-instance` failures.
- Enqueue-time rejections never enter `processRequest`, so the failure-notification path at `ExternalOpenCoordinator.ts:245-252` is not reached and no window is available to notify.

**Explanation / impact**
When more than 64 external-open requests are queued before startup completes (for example, a large multi-file selection used to cold-start NCE on macOS or Windows), the excess requests are discarded silently; those files never open and no UI reports it. A single request with more than 64 paths is different: it fails with `TOO_MANY_PATHS` and is surfaced once a window exists.

**Verification**
Behaviour verified by inspection. The frequency of the >64-concurrent-requests trigger is unverified.

### F4 (Low) — Mixed file+folder drops show no success status; an already-open folder is described as newly opened

**Evidence**
- `src/js/addon/ExternalFileDropController.js:260-281` only shows status for files-only (`openedFiles > 0 && openedFolders === 0`) or folders-only (`openedFolders > 0 && openedFiles === 0`) success.
- `src/js/addon/ExternalFileDropController.js:268-273` reports “Folder opened in a new window.”
- `src/ts/manager/WindowManager.ts:167-171` returns `true` after merely focusing an existing workspace window.
- `src/ts/manager/ExternalOpenCoordinator.ts:235-238` counts that case as `openedFolders += 1`.

**Explanation / impact**
A drop containing both files and a folder produces no confirmation at all. Dropping a folder that is already open reports that a new window was opened even though the existing window was only focused. This misreports what happened.

**Verification**
Verified by code inspection.

### F5 (Low) — Resolved per-window queue entries are retained after cold-start routing

**Evidence**
- `src/ts/manager/ExternalOpenCoordinator.ts:328-333` copies the `system-startup` promise chain under `requestChains[window.id]`.
- The dispatcher’s cleanup only removes the key it registered (`src/ts/manager/ExternalOpenCoordinator.ts:177-179`); the copied window entry is never deleted.

**Explanation / impact**
Each window created by a pre-start request leaves one resolved promise entry in `requestChains` for the lifetime of the coordinator (bounded by the number of startup-created windows, at most 8). A later request to that window reuses and then clears the entry. No functional effect was observed; it is a small, bounded memory retention.

**Verification**
Reproduced against the compiled module at HEAD with a stub `WindowManager`:

```
requestChains keys after settle+tick: [ 'w1' ]
keys after second request: []
```

## Commit-by-commit summary

| Commit | Summary |
| --- | --- |
| `8b5f9df` feat(external-open) | Adds `ExternalOpenCoordinator`, App wiring for startup argv / `open-file` / `second-instance`, `Window` delivery+ACK plumbing, preload APIs, the renderer drop controller and overlay CSS, and the first tests. |
| `c445383` fix(external-open) | Scopes the overlay to the editor `mainSection`, switches the bounds calculation away from fixed positioning, and adjusts overlay copy. |
| `2187ace` fix(external-open) | Core hardening: per-target request chains instead of one global queue, startup-target adoption, renderer reload retry with ACK attempts, empty `WindowSessionStore` initialization, `rendererReady` delayed until state restore, and substantial tests. |
| `a2288c2` fix(drag-drop) | Removes the renderer-side “all paths required” short-circuit so partial path failures flow through the main-process validator; adds overlay state generations so stale results/timers cannot redraw a newer drag. |
| `2ba71a0` fix(platform) | Adds NSIS HKCU “Open with NCE” verbs plus a PowerShell install/upgrade/uninstall smoke test, macOS `CFBundleDocumentTypes`, Linux MIME types, CI steps, and package assertions. |
| `9ed42e3` fix(drag-drop) | Improves overlay bounds (editor area, sidebars, bottom panel), labels the dragged item kind during drag, and adds success/failure status messages. |
| `b32b726` fix(ci) | Test-only alignment of the drop-controller tests with the renderer lifecycle and ACK attempt semantics. |
| `f32d97c` fix(ci) | Replaces the unsupported `New-Item -LiteralPath` with `-Path` in the NSIS PowerShell smoke test. |

## Test execution log

| Command | Result |
| --- | --- |
| `npm run typecheck` | exit 0, pass |
| `npm run build:main` | exit 0, pass |
| `npm run build:renderer` | exit 0, pass (Vite 8.3.2) |
| `node --test tests/external-open.test.js tests/external-file-drop-controller.test.js tests/electron-builder.test.js tests/lifecycle.test.js tests/multi-window.test.js tests/settings.test.js` | 102 tests, 102 pass, 0 fail, exit 0 (~2.8 s) |
| `npm test` | 1166 tests, 1166 pass, 0 fail, 0 skipped, exit 0 (~68.2 s) |
| `npm run test:packaged` | exit 0; `release/mac/NCE.app` asar verified (1 CSS bundle, 3 font refs, node-pty unpacked) |
| `npm run test:electron` | not run — requires a display/native rebuild in this environment |
| `npm run test:nsis-install` | not run — PowerShell/Windows-only |

Additional packaging verification: the existing `release/mac/NCE.app` (built 2026-10-16 21:19, after the last app-code commit) contains both generated document types — `Editor: public.data, public.content` and `Viewer: public.folder`, both `LSHandlerRank: Alternate`.

## Bottlenecks

- Path classification performs three serial async filesystem operations per path (`realpath`, `stat`, `access`) at `src/ts/manager/ExternalOpenCoordinator.ts:290-299`; up to 192 calls for a 64-path request.
- Delivered files are opened one at a time in the renderer (`src/js/addon/ExternalFileDropController.js:204-218`), with a single ACK at the end (`219-224`).
- Dropped folders are opened sequentially through `WindowManager` (`src/ts/manager/ExternalOpenCoordinator.ts:235-242`), and an entire request waits on its file delivery before folders open (`205-242`).
- Startup external opens wait for settings initialization, the NSH server, session validation/creation (`src/ts/App.ts:180-189`), and then the target window’s full editor-state restoration (`src/js/main/Editor.js:155`). The ordering is deliberate but adds latency.
- Delivery uses fixed 90 s renderer-ready and 120 s ACK timers with a 210 s total lifetime (`src/ts/Window.ts:34-39, 495-502`).

## Test-quality observations

1. `tests/electron-builder.test.js:23` uses `assert.notEqual(nsis.oneClick, false)`, which also passes when `oneClick` is `undefined`; it does not actually prove the intended installer mode.
2. `scripts/check-package.js:146-151` inspects the generated `Info.plist` only for the folder document type (`public.folder`). The file document type (`public.data`) is asserted only against `package.json` (`tests/electron-builder.test.js:45-46`), not the built bundle. The current release does contain both (verified separately).
3. The drop-controller harness (`tests/external-file-drop-controller.test.js:47-52`) stores at most one listener per event type and removes by name only, so duplicate registration or wrong-callback cleanup cannot be detected. `documentElement.contains` always returns `false` (`:54`), which limits `dragleave` coverage.
4. End-to-end coverage of the OS integration surface is partial. `tests/electron/driver.cjs:417-471` invokes `window.api.openDroppedFiles()` directly instead of performing an OS drag/drop; `tests/external-open.test.js:451-579` exercises `open-file`/`second-instance` through fake Electron objects; `scripts/test-nsis-install.ps1` validates registry values but never invokes the registered verb to launch NCE. Each layer is covered, but the real shell → argv/event → window path is not.
5. The App test substitutes `FakeExternalOpenCoordinator` (`tests/external-open.test.js:481-492`), so App wiring is tested against a stub rather than the real queue implementation (the real implementation is covered separately).

## Open questions

- The NSIS verbs do not set `MultiSelectModel` (`build/installer.nsh:1-14`). Whether Windows hides or limits “Open with NCE” for large multi-selections (the shell default is `Document`, which caps multi-selection) was not verified on Windows.
- The controller ignores a drop when `dataTransfer.files` is empty (`src/js/addon/ExternalFileDropController.js:181`) after the overlay has been shown. Whether a real native folder drag can ever produce zero `files` entries (leaving the overlay visible) is unverified.
- Whether macOS can deliver the same document through both `open-file` and startup argv was not verified. De-duplication is per request only; cross-request repeats rely on `openFileWithPath` focusing an existing tab.
- `scripts/test-nsis-install.ps1:14` creates a registry key whose path contains a literal `*` using `New-Item -Path`. PowerShell 5.1 wildcard handling for that provider/path was not independently verified on this host.
- The uncommitted iCloud duplicate files (`" 2"` copies) are unrelated to this branch and were not touched.
