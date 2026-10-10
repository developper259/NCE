# Multi-window architecture

NCE runs one Electron main process and creates an independent renderer and
window-scoped services for each open window. `App` owns application-wide
services; `WindowManager` owns window creation, workspace reservations, focus,
and removal from the live registry.

## Ownership and lifetime

`App` owns the shared `SettingsManager`, `RecentFoldersManager`,
`AgentConversationStore`, NSH server, `IpcRouter`, `WindowSessionStore`, and
`WindowManager`. Each `Window` owns its BrowserWindow, FileManager, Watcher,
WorkspaceSearch/Index, ContextMenu, Agent approval/process services,
TerminalManager, and menu callbacks. Closing one window disposes only those
resources and PTYs attached to that window.

The application allows up to eight simultaneous windows. A workspace has one
owner at a time. Workspace paths are validated and canonicalized before a
window is created or reserved; requests for an already-open workspace focus its
owner instead of opening a duplicate.

## IPC routing

Window-scoped services register handlers through `IpcRouter`. Electron installs
one `ipcMain.handle` callback per channel; the router identifies the owner from
`event.sender` and dispatches to that window's service. Renderer-provided window
IDs are not used for identity. Unknown and destroyed senders are ignored.

Settings and recent-folder mutations use shared application services. Changes
are broadcast to currently live windows, and broadcasts skip destroyed
WebContents. New window-scoped services should receive the window's registrar
and must release listeners, pending work, and owned processes when that window
closes.

## State and restoration

Window session metadata and renderer state are stored centrally in the
versioned, size-limited `userData/window-sessions.json` file. Writes are
serialized and committed through a temporary file and rename. Legacy
`userData/state.json` is migrated once without removing the source file.

Project UI state remains in each project's `.nce/workspace.json`. Global
preferences and recent folders remain in their existing shared stores. These
three scopes must remain separate: workspace state belongs to a project,
session state belongs to a window, and preferences belong to the application.
Restoration is bounded to eight windows, staggered, and does not restart old
terminal commands or PTY processes.

## Menus, close, and quit

Native application menus are global on macOS, so `WindowManager` activates the
menu associated with the focused window and falls back to an application menu
when no windows remain. Window-specific commands use that window's callbacks.
The macOS `hiddenInset` title bar and traffic lights remain configured by
`Window`.

Closing one window prepares and closes only that renderer after its dirty files
are resolved. Application Quit prepares every window first; a cancellation
leaves all prepared windows open. Only after all windows approve does NCE commit
their closes, flush session state, stop the shared NSH server, and quit.
macOS activation creates an empty window when the app remains open without any
windows.

## Invariants

- An IPC request resolves its owner from `event.sender`.
- Closing a window cannot dispose resources owned by another window.
- A workspace is reserved by at most one live window.
- Workspace state and window session state remain separate.
- NSH and application-wide stores are created once per main process.
- A new window does not create a PTY until its terminal view is used.
