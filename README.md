<p align="center">
  <img src="./assets/logo/NCE/dark-logo.png" alt="NCE" width="96">
</p>

<h1 align="center">NCE</h1>

<p align="center">
  <strong>A lightweight and fast desktop code editor built from scratch.</strong>
</p>

<p align="center">
  Built with Electron · macOS · Windows · Linux
</p>

---

## About

**NCE (NDL Code Editor)** is a lightweight desktop code editor built from the ground up with a strong focus on:

- **Performance**
- **Simplicity**
- **Full control over the editor architecture**

The editor core was designed and implemented from scratch, without relying on prebuilt editor engines such as **Monaco Editor** or **CodeMirror**.

Text rendering, cursor handling, selections, history, scrolling, file management and editing behaviour are handled by NCE's own architecture.

NCE also includes a deeply integrated AI coding agent designed to work directly with the editor, workspace, files and project tooling.

**Current version**: **0.0.1-beta.4**

## Beta 4 highlights

- Integrated multi-session terminal with workspace-scoped sessions and a new extensible bottom panel
- Multi-cursor editing with atomic edits, dedicated commands and optimized rendering
- Isolated multi-window support with per-window state, including fullscreen
- Image and Markdown preview tabs with a view type selector
- Large file mode replacing the previous file size limit, plus automatic large workspace mode
- Persistent workspace file index powering Quick Open, search and the File Explorer
- Major startup, rendering and scrolling performance work, with lazy-loaded features and virtualized lists
- Built-in runtime performance dashboard
- Crash recovery with automatic restoration of unsaved buffers
- Safer file handling: external changes merged with local edits and removals sent to the system Trash
- Progressive workspace search with current-file options and a safe, complete Replace All
- Native file and folder opening, including drag and drop onto the editor
- Horizontal tab scrolling and tab cycling
- New reusable checkbox and anchored dropdown components in Settings
- Smaller Electron package with trimmed assets
- Numerous Agent, keybinding, editor and cross-platform packaging fixes

## Features

### Editor

- Fast custom editing engine
- Multi-cursor editing with multiple selections
- Virtualized vertical and horizontal rendering for large documents
- Syntax highlighting powered by [NSH](https://github.com/developper259/NSH)
- Undo & Redo
- Smart typing and automatic pairs
- Smart indentation
- Cut, copy and paste
- Large file mode for opening very large files
- Local NSH failure fallback so the editor remains usable without highlighting

### Tabs and Views

- Multiple file tabs with horizontal scrolling and tab cycling
- Dedicated Settings tab
- Image preview tab for png, jpeg and other image files
- Markdown preview tab
- Tab type picker and "change view type" action for switching between views

### Workspace and Files

- File Explorer with create, rename, copy, move, duplicate and delete operations
- Virtualized File Explorer with a persistent tree
- Removals sent to the system Trash by default, with optional permanent delete
- Configurable confirmations for file and non-empty folder removal
- Persistent workspace file index, kept up to date by the file watcher
- Automatic large workspace mode for very large projects
- Persistent recent workspaces with Open Recent
- Multi-window support with isolated windows and per-window state
- Native opening of files and folders from the system
- Drag and drop files and folders onto the editor to open them
- Session restoration for workspaces, tabs, cursor, selection and scroll position
- Crash recovery that restores unsaved buffers automatically
- Merge of external file changes with local edits
- Auto Save with coalesced writes
- Safe dirty-file flows for close, quit, reload and workspace switching
- Atomic file saves with large, binary and invalid UTF-8 file protection

### Search and Navigation

- Recursive workspace search with include/exclude filters
- Progressive, streamed and virtualized search results
- Complete and safe workspace Replace All, including empty replacements
- Find in file with selection prefill and current-file search options
- Quick Open (Mod+P) served from the workspace index
- Go to Line (Mod+G)
- Command Palette (Mod+Shift+P)
- Recently used items in the quick panel

### Terminal

- Integrated terminal built on xterm and a native PTY
- Multiple terminal sessions with stable names and session management
- Sessions and panel state persisted per workspace
- Extensible bottom panel manager
- Clipboard shortcuts and Shift+Arrow text selection in the terminal

### AI Agent

- Integrated AI coding agent with project-aware tools, testing and multi-file editing
- Persistent Agent conversations with windowed rendering for long histories
- Manual context for files, folders and selections
- Safe handling of concurrent Agent runs
- Per-model visibility controls and provider API key management

### Customization and Settings

- Searchable settings with persistent category and scroll position
- Configurable keyboard shortcuts
- Configurable Open Recent window behavior
- Customizable sidebar panels
- Light, dark and system themes
- Native macOS menu and integrated Windows/Linux title bar menu

### Performance and Reliability

- Lazy initialization of heavy features and a split renderer bundle for faster startup
- Centralized scroller management and per-frame layout batching
- Built-in runtime performance dashboard
- Cross-platform desktop support

## Getting Started

### Requirements

- Node.js 20+
- npm
- Git

### Installation

```bash
git clone https://github.com/developper259/NCE.git
cd NCE
npm ci
```

### Run

```bash
npm start
```

## Development

Run the test suite:

```bash
npm test
```

Run type checking:

```bash
npm run typecheck
```

## Build

Create a production build:

```bash
npm run build
```

Build both macOS architectures (Intel and Apple Silicon):

```bash
npm run build:mac
```

Create an unpacked build:

```bash
npm run dist
```

Build artifacts are generated in `release/`.

### Release signing

Tagged releases require signing credentials:

- macOS: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`.
- Windows: `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`.

The workflow fails before building when the platform certificate is missing, verifies the produced signature, and runs an automated PTY smoke test against the packaged `app.asar`. Unsigned artifacts are never published.

## Status

NCE is currently in beta and under active development.

Current version: **0.0.1-beta.4**

## License

NCE is licensed under the **ISC License**.
