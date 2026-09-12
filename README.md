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

**Current version**: **0.0.1-beta.2**

## Features

- Fast custom editing engine
- Syntax highlighting powered by [NSH](https://github.com/developper259/NSH)
- Multiple files and tabs
- File explorer
- Workspace search
- Find in file with selection prefill
- Quick Open (Mod+P)
- Go to Line (Mod+G)
- Command Palette (Mod+Shift+P)
- Configurable settings and keyboard shortcuts
- Undo & Redo
- Smart typing and automatic pairs
- Smart indentation
- Context menus (editor, tabs, output)
- Auto Save
- Cut, copy and paste
- File and folder operations
- Session restoration
- Integrated AI assistant
- Large and binary file protection
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

Current version: **0.0.1-beta.1**

## License

NCE is licensed under the **ISC License**.