# Bottom Panel and Terminal

`BottomPanelManager` owns the panel registry, visibility, active view, height, resize separator, focus restoration, and UI state. Views are registered by ID and create their DOM only when opened. Each view can implement `onOpen`, `onClose`, `onActivate`, `onDeactivate`, `onResize`, `onThemeChanged`, `focus`, and `destroy` as needed. New views should not depend on xterm or terminal IPC.

The Terminal view owns xterm instances and tabs. `TerminalManager` and `TerminalSession` in Electron Main own PTY processes, session IDs, output flow control, and IPC ownership. The renderer can request dimensions and input, but cannot choose a shell or initial working directory. Main resolves the configured executable and validates the active workspace directory; without a valid workspace it uses the user's home directory.

## Lifecycle

- Hiding the Bottom Panel preserves all PTY processes and xterm instances.
- Closing one terminal stops only its PTY. A shell that exits remains visible as an exited tab until closed.
- Switching workspaces leaves existing shells in their original working directory; new terminals use the current workspace.
- Renderer reload, renderer crash, or window close disposes all PTYs owned by that WebContents.
- Global editor state stores only visibility, preferred height, maximized state, and active view. Processes, commands, output, environment, and terminal history are not restored.

PTY output is split at UTF-8 boundaries into 32 KiB-or-smaller chunks. Only one chunk per session waits for an xterm write acknowledgement at a time. The main process pauses PTY reads above a 1 MiB backlog and stops a session with an explicit error if the 8 MiB buffer limit is exceeded.

## Lazy loading and packaging

The Terminal view is requested through `FeatureLoader`. Vite builds its ESM entry at `dist/renderer/js/terminal/entry.js`; xterm and its addons are absent from the classic startup bundle. The entry and all code run from local packaged assets and work offline. `node-pty` is a production dependency. Development and Electron smoke runs rebuild it for the installed Electron version with `npm run rebuild:native`. Packaging leaves electron-builder's native rebuild enabled so each requested target architecture receives a compatible PTY module, including the x64 and arm64 macOS release targets. Only the rebuilt native output is included, and its modules and PTY helper executables are unpacked from ASAR.

## Shell preference and shortcut

Settings → Terminal → Shell accepts an executable name or path for new sessions. An empty value selects the user's shell on macOS/Linux or PowerShell with a `cmd.exe` fallback on Windows. The default Toggle Terminal shortcut is `Mod+J` and can be changed in Settings → Shortcuts.

## Adding another Bottom Panel view

Register a unique ID, title, and asynchronous `createView` factory with `editor.bottomPanelManager.registerPanel`. Return a view object with an `element` and only the lifecycle methods the view needs. Use `DOMManager.scheduleLayout` through the panel manager when changing panel geometry; do not create a separate layout scheduler. The new view should own and dispose its resources and should not start work just because its bundle was loaded.
