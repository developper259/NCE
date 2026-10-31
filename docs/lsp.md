# Language Server Protocol (LSP)

NCE embeds a multi-server Language Server Protocol client. It is optional: editing, NSH syntax highlighting, the terminal and the Agent keep working when no language server is installed.

## Architecture

| Layer | Location | Responsibility |
| --- | --- | --- |
| Registry | `src/ts/lsp/LspServerRegistry.ts` | Declarative server definitions, languages, extensions, commands, root markers, priorities, default enablement |
| Executable resolution | `src/ts/lsp/LspExecutableResolver.ts` | Trusted absolute paths or PATH discovery, `shell: false`, no installation |
| JSON-RPC transport | `src/ts/lsp/JsonRpcConnection.ts` | `Content-Length` framing in UTF-8 bytes, partial/batched messages, correlation, timeouts, cancellation, size limits |
| Session | `src/ts/lsp/LspSession.ts` | Process lifecycle, initialize/initialized/shutdown/exit, capabilities, diagnostics, stderr logs, server-to-client requests |
| Documents | `src/ts/lsp/LspDocumentStore.ts` | Canonical URI, language, live buffer text, monotonic versions, full/incremental changes |
| Diagnostics | `src/ts/lsp/LspDiagnosticsStore.ts` | Per-document/per-server isolation, stale version rejection, empty publication clearing |
| Routing | `src/ts/lsp/LspFeatureRouter.ts` | Capability checks, aggregation and exclusive-provider policies |
| Window service | `src/ts/lsp/LspManager.ts` | Lazy sessions, `serverId + project root` keys, IPC, events, workspace cleanup |
| Renderer | `src/js/lsp/LspController.js`, `ProblemsPanel.js`, `LspCompletionWidget.js`, `LspPopover.js` | Buffer synchronization, diagnostics overlay, Problems panel, completion, hover, navigation, rename, code actions, formatting, symbols |

Servers are started exclusively in the Electron main process. The renderer only uses the explicit `window.api.lsp` surface exposed by `Preload.js`.

## Session lifecycle

A session is created lazily when an open document matches an enabled server and language. Its key is `serverId::effectiveProjectRoot`, so several documents share one process while different roots or servers stay isolated.

```
starting → initializing → ready → stopping → stopped
                     ↘ failed (reported, no restart loop)
```

`initialize` advertises only supported client capabilities (UTF-16 positions, incremental sync, no snippets, no server-initiated applyEdit). `shutdown` is requested with a short timeout, then `exit` is sent and the process tree is terminated. Crashes reject pending requests and clear that server's diagnostics; the other servers remain unaffected.

## Document synchronization

- The live editor buffer is the source of truth, including unsaved edits.
- A single edit sends one incremental change derived from the replaced range. Multi-cursor batches send the current full text.
- Versions are owned by the main process and are monotonic.
- Servers declaring full sync receive the current text; servers declaring no sync are not spammed.
- Large-file mode, load errors, diff views and `.nce` workspace state never reach a server.
- Renames, deletions and workspace changes close or rebind documents.

## Diagnostics

Diagnostics are stored per `(document, server)` and aggregated for the renderer. A server publishing an empty list clears only its own results. Publishes carrying an older version than the server's previous publish are ignored. The editor renders range highlights in a dedicated layer, and the Problems bottom panel lists messages with severity, source server, file and position, with click-to-navigate.

## Server registry

| Languages | Servers |
| --- | --- |
| JavaScript / TypeScript | `typescript-language-server` (default), `eslint-language-server` (optional) |
| Python | `basedpyright` (default), `ruff` (optional) |
| C / C++ | `clangd` (`clangd`) |
| HTML / CSS / JSON / YAML | `vscode-html-language-server`, `vscode-css-language-server`, `vscode-json-language-server`, `yaml-language-server` |
| PHP | `intelephense` (default), `phpactor` (optional) |
| Java | `eclipse-jdtls` (`jdtls`, explicit configuration required) |
| XML | `lemminx` |

Adding a server means adding one declarative entry; the transport, document store, routing and renderer do not change. The initial registry follows the language ids used by NSH (`.h` maps to C, `.svg` to XML, unknown extensions stay plain text).

## Configuration

Settings → **Language Servers** exposes per-server enablement, availability, executable path, startup error and a restart action, plus a global enable switch. Persistent values live in `settings.json`:

```json
{
  "lsp": {
    "enabled": true,
    "servers": {
      "clangd": {
        "enabled": true,
        "path": "/opt/homebrew/opt/llvm/bin/clangd",
        "args": []
      }
    }
  }
}
```

Paths must be absolute and are validated at startup. The configured executable is trusted like any external tool: NCE does not sandbox language servers.

## When a server is missing

Nothing is installed or downloaded. The document still opens and edits normally. Status reports `Executable not found`, the Problems panel shows which servers are ready or unavailable, and feature commands report that no provider is available instead of pretending success.

## Feature policies

- **Completion**: merged across capable servers, de-duplicated by label/kind/detail; the selected item is resolved before insertion. Items can provide `textEdit`, `insertText` and additional edits.
- **Hover / signature help**: first provider by configured priority, cancellation on cursor/document changes.
- **Definition, declaration, implementation, type definition, references**: merged and de-duplicated across servers; multiple results open a picker; targets outside authorized files are rejected.
- **Rename and formatting**: a single deterministic provider (highest priority). Workspace edits are version-checked and confined to authorized existing files; resource operations (create/rename/delete) are explicitly rejected.
- **Code actions**: aggregated with their source; resolved and executed through opaque main-process tokens so the renderer cannot inject arbitrary server commands.
- **Document symbols / workspace symbols**: merged across capable servers.
- **Diagnostics**: always aggregated.

## Keyboard shortcuts

| Action | Default |
| --- | --- |
| Trigger completion | `Ctrl+Space` |
| Go to definition | `F12` |
| Find references | `Shift+F12` |
| Rename symbol | `F2` |
| Code actions | `Mod+.` |
| Format document or selection | `Alt+Shift+F` |
| Document symbols | `Ctrl+Alt+O` |
| Workspace symbols | `Mod+T` |
| Show Problems | `Mod+Shift+M` |

Hover, signature help, declaration, implementation and type definition are available from the command palette.

## Security

- All server parameters are validated in the main process; only known server ids from settings can start.
- Launches use `command` + argument arrays with `shell: false`; no command line is assembled from renderer input.
- Documents, workspace edits and navigation targets are checked against the window's workspace and `PathAccess` grants.
- Message sizes, diagnostics counts, log buffers, action tokens and request timeouts are bounded.
- Server stderr is kept as a bounded diagnostic log; full file contents are never logged.

## Current limits

- No Runtime Manager: no download, install, update or uninstall.
- Server-initiated `workspace/applyEdit` requests are answered with `applied: false`; all edits are applied in the renderer through the editor history.
- Snippet placeholders are not expanded; completion inserts plain text.
- Semantic tokens, code lenses, inlay hints, call hierarchy, document links and workspace-symbol resolution are not surfaced in the UI.
- Diagnostics are rendered as inline range highlights and the Problems panel, not as gutter icons.
- Files in large-file mode are intentionally not synchronized.

## Tests

- `tests/lsp-core.test.js`: framing (fragmented, grouped, UTF-8, malformed, oversized), timeouts, cancellation, server requests, UTF-16 positions, registry/root detection, settings validation, diagnostics isolation and stale versions, document store.
- `tests/lsp-integration.test.js`: a real fake LSP server over stdio; multi-server aggregation, shared sessions, incremental sync, merged completion/hover/navigation/references, rename/formatting/code actions/symbols, version-checked edits, missing executables, crashing servers, server-initiated requests and payload validation.
- `tests/lsp-renderer.test.js`: renderer positions/change payloads, bundle manifest and preload contract.

Run `npm test` (or the three files above) and `npm run typecheck`.
