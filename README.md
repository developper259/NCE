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

**Current version**: **0.0.1-beta.3**

## Beta 3 highlights

- Major AI Agent reliability and architecture improvements
- Safer and more reliable multi-file editing
- Improved file revision tracking and stale edit recovery
- Better large-file writing and automatic recovery
- Manual context support for files, folders and selections
- Integrated project test detection and test execution
- Improved tool calling, JSON recovery and model error handling
- Persistent Agent conversations and workspace state
- Improved Agent activity timeline and change review
- Compact reasoning viewer with reasoning history and copy support
- Improved Agent permissions and approval flows
- Better context management and response budgeting
- New light theme and system theme support
- Improved Settings, Search, Sidebars and context menus
- Numerous editor, keybinding, rendering and workspace-state fixes

## Features

- Fast custom editing engine
- Virtualized vertical and horizontal rendering for large documents
- Syntax highlighting powered by [NSH](https://github.com/developper259/NSH)
- Multiple file tabs and a dedicated Settings tab
- File Explorer with create, rename, copy, move, duplicate and delete operations
- Recursive workspace search with include/exclude filters
- Persistent recent workspaces with Open Recent
- Find in file with selection prefill
- Quick Open (Mod+P)
- Go to Line (Mod+G)
- Command Palette (Mod+Shift+P)
- Searchable settings and configurable keyboard shortcuts
- Undo & Redo
- Smart typing and automatic pairs
- Smart indentation
- Context menus for the editor, tabs and File Explorer
- Native macOS menu and integrated Windows/Linux title bar menu
- Auto Save
- Cut, copy and paste
- Session restoration for workspaces, tabs, cursor, selection and scroll position
- Safe dirty-file flows for close, quit, reload and workspace switching
- Atomic file saves with large, binary and invalid UTF-8 file protection
- Integrated AI assistant
- Local NSH failure fallback so the editor remains usable without highlighting
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

Create an unpacked build:

```bash
npm run dist
```

Build artifacts are generated in `release/`.

## Status

NCE is currently in beta and under active development.

Current version: **0.0.1-beta.3**

## License

NCE is licensed under the **ISC License**.
