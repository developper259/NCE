# Bottom Panel and Terminal

`BottomPanelManager` owns the extensible view registry, visibility, active view, preferred height, resize separator, focus restoration, and per-workspace panel snapshots. Views are registered by ID and create their DOM only when opened. A view may implement `activateWorkspace`, `onOpen`, `onClose`, `onActivate`, `onDeactivate`, `onResize`, `onThemeChanged`, `focus`, `getPersistedState`, and `destroy` as needed.

## Session ownership and workspace isolation

The Terminal view keeps a runtime registry per canonical workspace key. Main derives the key from the active project root, resolves symlinks, normalizes separators and path segments, and applies case folding on Windows. The explicit `no-workspace` key uses the user's home directory and is isolated from every project. Main captures the project root before asynchronous shell resolution and binds each PTY to that immutable workspace key. Renderer input, resize, acknowledgement, and close requests must present the matching key; Main checks it against the PTY owner.

Each workspace retains its live PTY sessions and xterm instances while NCE remains open. Switching projects hides the previous workspace's terminal DOM, activates the destination's tabs and selected session, and leaves its processes running. Returning to a workspace reconnects the same xterm instances and process output. New sessions are created in the current project root, or the home directory in `no-workspace`.

Runtime state includes PTYs, xterm instances, streams, listeners, and internal session IDs. It is never serialized. Workspace version 2 stores only Bottom Panel visibility, preferred height, active view ID, terminal tab order, base labels, custom labels, duplicate-name indexes, and active tab index. It does not store commands, terminal output, environment variables, or old PTY IDs. The global editor file keeps a separate panel snapshot for `no-workspace`; project panel state is saved in that project's `.nce/workspace.json`. Legacy workspace version 1 and older global panel settings are sanitized and migrated. Obsolete `maximized` values are ignored.

## Switch and restart lifecycle

On a project switch, NCE saves the outgoing workspace state while its explorer, tabs, and sidebar still describe that project. It then suspends the outgoing panel view and restores the destination state after the workspace loads. If loading fails, NCE reloads the previous workspace and panel snapshot. Workspace state writes are serialized by root, and panel metadata writes are debounced while preserving the other workspace fields.

After an application restart, the persisted tab metadata is used to create new shells when the user opens the Terminal view. Old process IDs are never reused, old commands are never replayed, and a hidden terminal panel does not spawn restored shells during cold startup. Restored shells are created sequentially to avoid a burst of PTY processes. If a shell cannot start, the panel presents an error with an explicit retry action.

Opening the Terminal view with no live sessions creates one shell; overlapping open requests share the same creation. Closing a terminal stops only its PTY and removes its tab. A naturally exited shell remains as an exited tab until closed. Closing the last tab closes the Bottom Panel. Hiding the panel only hides the view and leaves every session alive. The per-window PTY limit is eight sessions across all workspaces.

## Bottom Panel controls and resizing

The first row is the Bottom Panel view navigation. Terminal is registered as a view, so future views can join the same tab registry. The compact actions provide New Terminal, Kill Terminal (the current workspace's selected tab), and Close Bottom Panel (hide only). Maximize/restore and double-click maximize handling have been removed. Select All, Copy Selection, Paste, and Clear Terminal are available from the terminal overflow menu; terminal keyboard shortcuts remain available.

The second row contains only terminal session tabs and their close buttons. Double-click a tab name to rename it. A custom name is persisted with its workspace. Otherwise, the label is derived from shell and initial workspace folder. The first matching tab keeps the unsuffixed label; later duplicates get the first available positive suffix, such as `(1)` and `(2)`. Adding a duplicate never renames existing tabs. Suffix allocation lives on each workspace's session records, and a lone remaining duplicate returns to its base label. Internal session IDs are never displayed.

The terminal surface, xterm viewport, and xterm screen use the same `--terminal-surface` token, which follows `--bg-secondary` in dark and light themes. This overrides xterm's default black viewport while retaining its themed canvas rendering for ANSI colors and selection. The xterm padding stays inside that same surface.

Sidebar and Bottom Panel resize handles share the `.nce-panel-resizer` visual rules: a transparent 4px band at rest, the same accent hover color across the hit area, and a shared 200ms transition. Their hit areas match the visible band. Pointer capture keeps Bottom Panel dragging continuous; Arrow Up/Down and Home/End resize it from the keyboard. Min/max bounds preserve an editor viewport. Layout work is scheduled through `DOMManager`.

## Lazy loading and packaging

The Terminal view is requested through `FeatureLoader`. Vite builds its ESM entry at `dist/renderer/js/terminal/entry.js`; xterm and its addons are absent from the classic startup bundle. The entry and all code run from local packaged assets and work offline. `node-pty` is a production dependency. Development and Electron smoke runs rebuild it for the installed Electron version with `npm run rebuild:native`. Packaging leaves electron-builder's native rebuild enabled so each requested target architecture receives a compatible PTY module, including the x64 and arm64 macOS release targets. Only the rebuilt native output is included, and its modules and PTY helper executables are unpacked from ASAR.

## Shell preference and shortcut

Settings → Terminal → Shell accepts an executable name or path for new sessions. An empty value selects the user's shell on macOS/Linux or PowerShell with a `cmd.exe` fallback on Windows. An empty shell preference does not change the user's normal shell permissions or directory access. The default Toggle Terminal shortcut is `Mod+J` and can be changed in Settings → Shortcuts.

## Adding another Bottom Panel view

Register a unique ID, title, and asynchronous `createView` factory with `editor.bottomPanelManager.registerPanel`. Return a view object with an `element` and only the lifecycle methods and persistence hooks the view needs. Use `DOMManager.scheduleLayout` through the panel manager when changing panel geometry; do not create a separate layout scheduler. Views should not depend on xterm or terminal IPC, and should not start work just because their bundle was loaded.
