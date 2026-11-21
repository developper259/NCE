import type { ManagedPackageDefinition } from "./types";

/** TypeScript compiler and tsserver, installed as an isolated npm tarball. */
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
  dependencies: ["node"],
  installerPackageId: "typescript",
  installableVersion: "5.9.3",
  installationRoot: "tools/typescript",
  uninstall: { strategy: "installer-directory" },
};
