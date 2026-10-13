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
versioned, size-limited `userData/window-sessions.json` file. Focus and other
metadata changes are coalesced; renderer state saves and shutdown flushes are
awaited. Writes are ordered and committed through a unique temporary file,
file sync, and atomic rename. Each window session keeps its last normal bounds,
maximized state, and full screen state so those window properties are restored
independently. A failed flush is reported and blocks normal application Quit.

Legacy `userData/state.json` is migrated without moving API keys into renderer
state. Legacy Agent credentials are validated, encrypted through Electron
`safeStorage`, written and verified in `agent-secrets.json`, then removed from
the legacy JSON with an atomic replacement. An existing encrypted key wins a
provider conflict; conflicting or invalid legacy entries are kept for retry.
If encryption or persistence is unavailable, the original recoverable copy is
left unchanged and data returned to renderers remains sanitized. Existing
plaintext session files are not rewritten until migration can preserve their
credentials securely. Rewriting a file does not promise physical erasure of old
disk blocks.

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

Closing one window saves renderer state and resolves dirty buffers before the
main process accepts the close. Application Quit prepares every window first,
then flushes session and Agent persistence, and waits for a commit acknowledgment
from every renderer before destroying any window. Request IDs reject late
acknowledgments; timeout or failed persistence aborts the close. If a later
commit fails, already-prepared renderers restore recovery snapshots before NCE
returns to the running state. A renderer crash preserves its last session and
recovery data while native resources are disposed. macOS activation creates an
empty window when the app remains open without any windows.

Workspace paths are canonicalized with `realpath`, Unicode NFC normalization,
and case folding on Windows. A switch reserves the destination while retaining
the current path, starts its watcher, then commits the window/session path and
releases the old reservation. Failed watcher startup removes only its own
reservation and restores the previous watcher; if restoration also fails, the
window moves to an explicit unowned empty-workspace state. Watcher start/stop
requests are serialized per window, while other windows remain independent.
Path-specific release only releases that path, and transition tokens reject
stale completion callbacks.

Restored bounds are kept when enough of the title area remains reachable across
the available work areas. Windows with only a narrow visible strip, detached
monitor coordinates, or dimensions larger than every display are clamped to an
available work area. Small displays lower the native minimum size to the
restored bounds; a window that remains meaningfully reachable across multiple
displays keeps its position.

Renderer visual work is reduced while a window is unfocused or hidden. Electron
background throttling is enabled, Agent duration/working animations pause while
unfocused, and the Agent display ticker stops. PTYs, file watchers, searches,
saves, and shared main-process services continue independently. PTY output uses
a bounded one-chunk acknowledgment queue, so a throttled renderer applies
backpressure instead of accumulating unbounded output; its configured overflow
limit stops and reports the affected terminal rather than silently growing the
queue. GUI CPU and memory measurements remain environment-specific and are not
asserted by unit tests.

### Manual background-load check

For comparable measurements, use the same machine, power mode, display setup,
workspace, and NCE build for each run. Repeat with 1, 2, 4, then 8 windows;
record the OS/build, window count, and workspace for each run. After opening the
windows, wait 60 seconds, then sample NCE's main and renderer processes every 5
seconds for 2 minutes in Activity Monitor (macOS), Task Manager (Windows), or
the platform process monitor (Linux). Record CPU and memory for both all-idle
windows and one active window with the rest idle; repeat each configuration
three times and compare medians.

For behavior under background load, run a numbered PTY stream such as
`node -e 'let n=0; setInterval(() => console.log(n++), 250)'` in an inactive
window for 60 seconds, then reactivate it and verify the sequence and exit state.
While another workspace is focused, edit a watched file in the inactive
workspace and verify its explorer/editor update after refocus. If an Agent
provider is configured, start a response in an inactive window and verify that
it completes and its final state is visible on refocus. Finally, switch focus
50 times and minimize/restore each window, noting visible stalls or missed
updates. Record measurements and any terminal overflow warning; do not compare
runs made with different workspaces or display arrangements.

## Invariants

- An IPC request resolves its owner from `event.sender`.
- Closing a window cannot dispose resources owned by another window.
- A workspace is reserved by at most one live window.
- Workspace state and window session state remain separate.
- NSH and application-wide stores are created once per main process.
- A new window does not create a PTY until its terminal view is used.
