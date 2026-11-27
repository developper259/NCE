# Runtimes and execution

NCE deals with three different things that all happen to be called a runtime. Keeping them apart is what makes the behaviour predictable.

| Concern | Who runs it | Purpose |
| --- | --- | --- |
| Embedded Node.js | NCE, shipped in application resources | Runs NCE's own tooling: the TypeScript Language Server and Pyright |
| Managed project runtimes | Installed by the Version Manager | Run the user's Python and JavaScript/TypeScript projects |
| External runtimes | Already on the user's machine | Used when the project or the user points at them |

The embedded Node.js is never the runtime of a project, and a managed project runtime is never used to launch a language server.

## Embedded Node.js

- Standalone binary in the application resources, outside `app.asar`, so it survives packaging and signing.
- One pinned version, declared once in `scripts/internal-node-config.cjs`; `src/ts/runtime/InternalNodeRuntime.ts` reads that pin and never guesses.
- SHA-256 verified at build time against the official archive; the download happens at build time only, never on a user's machine.
- Distributions are embedded per platform and architecture: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`. A platform without a distribution is reported as unsupported rather than silently falling back.
- `RunAsNode` stays disabled. The binary is spawned directly; NCE never sets `ELECTRON_RUN_AS_NODE`.

## Managed project runtimes

The Version Manager installs two language environments, each as a set of independent technical components:

| Environment | Components | Notes |
| --- | --- | --- |
| Python | `python` | CPython from python-build-standalone, installed under `tools/python/<version>` |
| JavaScript & TypeScript | `typescript`, `typescript-language-server` | TypeScript SDK and the language server; the server depends on the SDK |

The user installs an environment, not a list of packages: one card, one button. The components stay independent internally so the plan can reuse what is already installed and repair what is broken.

Platform coverage is per package and per architecture, not per operating system:

| Package | darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64 | win32-x64 | win32-arm64 |
| --- | --- | --- | --- | --- | --- | --- |
| `python` | yes | yes | yes | no | yes | no |
| `typescript` | yes | yes | yes | yes | yes | yes |
| `typescript-language-server` | yes | yes | yes | yes | yes | yes |

A package with no distribution for the current platform and architecture is reported as unsupported. It is never offered as installable.

## Resolution order for a project

The controlled process runner (`src/ts/addon/AgentProcessRunner.ts`) resolves a runtime before it spawns anything, in this order:

1. A virtual environment inside the project: `.venv` then `venv`, for Python.
2. An executable on PATH: `python3`/`python` (`py -3` on Windows), or `node`.
3. Nothing: the request fails with `RUNTIME_UNAVAILABLE` instead of running something incompatible.

The resolved executable is what actually runs. There is no second resolver in the renderer: `RuntimeResolver.js` only asks the main process and caches the answer per strategy and project root.

## Running a file

The Run panel executes the active file through the same controlled runner, using the `python-script` and `node-script` strategies.

- Python files use `python-script`; JavaScript and TypeScript files use `node-script`.
- A file that cannot run is refused before any request, with the reason shown: unsaved, unsupported language, extension mismatch, no open folder.
- The process is spawned with an argument array and `shell: false`. No command line is assembled from renderer input.
- The request is validated in the main process: the workspace must be the active one, and the file, working directory and target must resolve inside it.
- Output, exit code and duration are shown in the Run panel. Stop cancels the request that is actually running.
- A missing runtime is reported in user terms and points at the Version Manager; the technical code stays in the log.

The Run panel is not the terminal (an interactive shell the user drives) and not the test runner (a discovered project test command). They share the process runner, not their responsibilities.

## Not implemented

These are deliberately absent, and the documentation does not claim them:

- No version manager for Node.js or Python beyond the single version each package pins.
- `.nvmrc`, `.node-version`, Volta and pyenv are not read.
- `engines.node` is not enforced when resolving a runtime.
- npm, pnpm, yarn and bun are not installed by NCE. They are used only when they are already on PATH.
- TypeScript files are executed by Node in strip-only mode, which is what Node 24 does by default: type annotations are removed and the file runs, but syntax that needs real transformation fails with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Measured on the embedded runtime: `const x: number = 1` runs, `enum E { A = 1 }` fails. NCE does not rewrite the project to work around this, and does not claim general TypeScript execution.

## Tests

- `tests/internal-node-runtime.test.js`: pinned version, resource layout outside `app.asar`, platform/architecture selection, executable permissions, no PATH fallback.
- `tests/run-panel.test.js`: runnable targets, refusal reasons, request shape, output rendering, exit codes, error translation, stop, concurrent runs.
- `tests/lsp-managed-launch.test.js`: managed server launch through the embedded runtime.

Run `npm test` and `npm run typecheck`.
