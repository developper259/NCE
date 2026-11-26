import type { ManagedPackageDefinition } from "./types";

/**
 * TypeScript compiler and tsserver, installed as an isolated npm tarball.
 *
 * The catalog does not list it as its own card: it is a component of the
 * JavaScript & TypeScript language, which installs it through its components.
 * A separate card would show the same environment twice.
 */
export const typescript: ManagedPackageDefinition = {
  id: "typescript",
  name: "TypeScript",
  description: "TypeScript compiler and language server backend (tsserver).",
  publisher: "Microsoft",
  homepage: "https://www.typescriptlang.org",
  categories: ["compiler", "language"],
  icon: "fi fi-brands-typescript",
  platforms: ["darwin", "win32", "linux"],
  capabilities: ["install", "uninstall", "verify"],
  dependencies: [],
  installerPackageId: "typescript",
  installableVersion: "6.0.3",
  installationRoot: "tools/typescript",
  uninstall: { strategy: "installer-directory" },
  hiddenFromCatalog: true,
};
