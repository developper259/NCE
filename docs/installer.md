# Package installer

NCE embeds a generic, declarative package installer. It downloads, verifies and installs self-contained tool distributions into the NCE user data directory. Git is the only package today; language servers, runtimes and compilers can be added later as definitions without touching the engine.

The installer never writes into a project, the application bundle or `resources/`, and it never replaces a configured Git path unless the installation succeeded and was verified.

## Architecture

| Layer | Location | Responsibility |
| --- | --- | --- |
| Engine | `src/ts/installer/Installer.ts` | Definition validation, platform resolution, ordered steps, verification, transactional commit, cancellation, progress |
| Contracts | `src/ts/installer/types.ts` | `PackageDefinition`, `PlatformConfig`, `InstallStep`, `InstallProgress`, `InstallResult`, error codes |
| Errors | `src/ts/installer/errors.ts` | `InstallerError` with a stable code, cancellation detection |
| Download | `src/ts/installer/download.ts` | HTTPS streaming, redirects, inline checksum, size and idle limits, truncation detection |
| Extraction | `src/ts/installer/extract.ts` | ZIP (`yauzl`) and TAR.GZ (`tar-stream` + `zlib`), path gating, link materialization, `stripComponents` |
| Registry | `src/ts/installer/registry.ts`, `packages/index.ts` | Package lookup by id over the embedded definitions |
| Git definition | `src/ts/installer/packages/git.ts` | Verified dugite-native distributions, checksums, sizes, executables |
| App service | `src/ts/manager/InstallerManager.ts` | One shared installer per app, `Installer:install` / `Installer:cancel` IPC, per-window progress |
| Preload | `src/js/main/Preload.js` | `window.api.installer.install/cancel/onProgress` |
| Trigger | `src/js/sidebar/Git.Sidebar.js` | "Install Git" in the missing-Git state, progress display, `git.path` configuration |

Downloads and child processes run exclusively in the Electron main process. The renderer only uses the explicit `window.api.installer` surface.

## Install flow

```
definition → platform/arch → existing install? → staging → steps → verification → atomic commit
                                                    ↘ failure: clean staging, keep the previous install
```

1. The definition is validated (ids, HTTPS URL, checksum shape, archive format, relative executable, step arguments, timeouts).
2. The platform and architecture select one `PlatformConfig`; an unknown combination fails with `UNSUPPORTED_PLATFORM` before any network access.
3. If `tools/{id}/{version}` already exists and passes verification, the call returns `alreadyInstalled: true` without downloading.
4. Work happens in `tools/.staging-{id}-{uuid}` (`download/` and `install/`).
5. Steps run in order: `download`, `extract`, `command`, `copy`, `move`, `delete`, `verify`. A step marked `required: false` may fail without aborting the installation.
6. Final verification stats the executable, checks its exec bit and runs it (for Git: `git --version`).
7. Only then is the validated directory renamed into place. A previous installation is moved aside first and restored if the rename fails.
8. Staging is always removed, on success and on failure.

`await installer.install("git", { onProgress })` resolves to `{ success: true, packageId, version, executable, installDir }` or `{ success: false, packageId, code, error }`. `installer.cancel()` aborts the active installation; a cancelled install reports `CANCELLED` and leaves no partial directory.

## Supported Git platforms

Git 2.56.1 comes from [dugite-native v2.56.1](https://github.com/desktop/dugite-native/releases/tag/v2.56.1), the prebuilt Git used by GitHub Desktop. Checksums and sizes are the release's published `.sha256` values.

| Platform | Architecture | Asset | Installed executable |
| --- | --- | --- | --- |
| macOS | x64 (Intel) | `dugite-native-v2.56.1-238326e-macOS-x64.tar.gz` | `tools/git/2.56.1/bin/git` |
| macOS | arm64 (Apple Silicon) | `…-macOS-arm64.tar.gz` | `tools/git/2.56.1/bin/git` |
| Linux | x64 | `…-ubuntu-x64.tar.gz` | `tools/git/2.56.1/bin/git` |
| Linux | arm64 | `…-ubuntu-arm64.tar.gz` | `tools/git/2.56.1/bin/git` |
| Windows | x64 | `…-windows-x64.tar.gz` | `tools/git/2.56.1/cmd/git.exe` |
| Windows | arm64 | `…-windows-arm64.tar.gz` | `tools/git/2.56.1/cmd/git.exe` |

The Linux assets are glibc builds (Ubuntu-compatible); musl distributions such as Alpine are not supported. 32-bit x86 and 32-bit ARM are not supported. Any other combination fails explicitly instead of installing something incompatible.

After a successful install the sidebar writes the returned executable to the existing `git.path` setting, so `GitManager` resolves Git through its normal mechanism.

## Security

- HTTPS only. Plain HTTP is accepted for `127.0.0.1`, `localhost` and `[::1]` so tests can serve local fixtures.
- No system `curl`, `wget`, `unzip` or `tar`: downloads use Node HTTPS streams, archives use `yauzl` and `tar-stream`.
- Archive entries are gated: absolute paths, drive letters, `..`, null bytes and any target outside the destination are rejected, and existing files are never overwritten.
- Symlinks and hardlinks are never created. In-tree links are materialized as regular-file copies (resolved in multiple passes so forward references work); links pointing outside the tree are rejected.
- Limits: 512 MB per download, 2 GB extracted, 64 KB per link target, 5 redirects, 60 s download idle timeout.
- Commands use `child_process.spawn()` with `shell: false` and an argument array. Only paths inside the install directory (or the bundled Node runtime, `process.execPath`) can be executed; timeouts default to 30 s and cannot exceed 120 s; the process group is killed on timeout or cancellation.
- Package definitions are embedded, privileged code. Nothing downloaded from a server can introduce a command, a path or an executable.

## Adding a package

1. Find a real, self-contained prebuilt distribution for each target platform, and record its published checksum. Never invent a URL or a checksum.
2. Add `src/ts/installer/packages/{id}.ts` exporting a `PackageDefinition`:

```ts
export const tool: PackageDefinition = {
  id: "tool",
  name: "Tool",
  version: "1.2.3",
  platforms: {
    darwin: {
      arm64: {
        download: {
          url: "https://example.org/tool-1.2.3-darwin-arm64.tar.gz",
          checksum: "<published sha256>",
          checksumAlgorithm: "sha256",
          size: 12345678,
        },
        archive: { format: "tar.gz", stripComponents: 1 },
        executable: "bin/tool",
      },
    },
  },
  install: {
    destination: "tools/{id}/{version}",
    steps: [{ type: "download" }, { type: "extract" }],
  },
  verification: { executable: "{installDir}/bin/tool", args: ["--version"] },
};
```

3. Register it in `src/ts/installer/packages/index.ts`.
4. Add a definition to `tests/installer.test.js`-style fixtures (local archives, loopback HTTP) covering the new platform layout, and only then a gated real-network test.
5. Trigger it from the UI that needs it, and feed `result.executable` into the setting that subsystem already uses.

Step paths and arguments accept the tokens `{installDir}`, `{stagingDir}`, `{downloadDir}`, `{archive}`, `{id}`, `{version}`, `{platform}` and `{arch}`. `command`, `copy`, `move` and `delete` steps are confined to the staging directory; `command` and `verify` executables are confined to the install directory.

Future subsystems keep their own directories (`tools/language-servers`, `tools/runtimes` are not created yet); nothing in the engine is Git-specific.

## Tests

```bash
npm test                                   # engine, Git definition, IPC and sidebar tests
NCE_INSTALLER_NETWORK=1 node --test tests/installer-git.test.js   # real download and install
npm run test:electron                      # includes the Source Control install state
```

`tests/installer.test.js` runs without network access: a loopback HTTP server serves locally built ZIP and TAR.GZ fixtures. It covers definition validation, platform resolution, unsupported platforms, download failures (HTTP error, truncation, refused connection), checksum mismatch, ZIP and TAR.GZ extraction, traversal and escaping-link rejection, link materialization, required and optional steps, command timeouts, verification failure, cancellation, concurrent installs, staging cleanup and preservation of a previous installation.

`tests/installer-manager.test.js` covers the IPC surface, progress routing to the requesting window, destroyed windows, malformed payloads and the app-wide busy guard. `tests/git-sidebar.test.js` covers the button, progress display, `git.path` configuration and failure notifications. `tests/electron/source-control-ui.cjs` checks the rendered states with a stubbed installer.

## Current limits

- One installation at a time across the whole app; a second request returns `INSTALL_BUSY`.
- No auto-update, no version picker and no package-manager UI: the installed version is the one pinned in the definition.
- No system package manager is used or required.
- Archive links become file copies, so a distribution that relies on symlink semantics at runtime is not supported.
- Linux support means glibc/Ubuntu-compatible builds; there is no musl or 32-bit distribution.
- A failed or cancelled install leaves the previously configured Git untouched, but the user must retry manually.