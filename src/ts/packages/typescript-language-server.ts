import type { ManagedPackageDefinition } from "./types";

/** typescript-language-server, installed as an isolated npm tarball. */
export const typescriptLanguageServer: ManagedPackageDefinition = {
  id: "typescript-language-server",
  name: "TypeScript Language Server",
  description: "LSP server providing diagnostics, completion and navigation for JavaScript and TypeScript.",
  publisher: "TypeScript Language Server contributors",
  homepage: "https://github.com/typescript-language-server/typescript-language-server",
  categories: ["language-server"],
  platforms: ["darwin", "win32", "linux"],
  capabilities: ["install", "uninstall", "verify"],
  dependencies: ["typescript"],
  installerPackageId: "typescript-language-server",
  installableVersion: "6.1.0",
  installationRoot: "tools/typescript-language-server",
  uninstall: { strategy: "installer-directory" },
};
