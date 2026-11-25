import type { ManagedPackageDefinition } from "./types";

/** Pyright language server, installed as an isolated npm tarball. */
export const pyright: ManagedPackageDefinition = {
  id: "pyright",
  name: "Pyright Language Server",
  description: "LSP server providing diagnostics, completion and navigation for Python.",
  publisher: "Microsoft",
  homepage: "https://github.com/microsoft/pyright",
  categories: ["language-server"],
  platforms: ["darwin", "win32", "linux"],
  capabilities: ["install", "uninstall", "verify"],
  dependencies: [],
  installerPackageId: "pyright",
  installableVersion: "1.1.414",
  installationRoot: "tools/pyright",
  uninstall: { strategy: "installer-directory" },
};
