import type { ManagedPackageDefinition } from "./types";

/** CPython runtime managed by the Version Manager via python-build-standalone. */
export const python: ManagedPackageDefinition = {
  id: "python",
  name: "Python",
  description: "CPython interpreter and standard library for running Python projects.",
  publisher: "Python Software Foundation",
  homepage: "https://www.python.org",
  categories: ["language", "runtime"],
  icon: "fi fi-brands-python",
  platforms: ["darwin", "win32", "linux"],
  capabilities: ["install", "uninstall", "verify"],
  installerPackageId: "python",
  installableVersion: "3.12.16",
  installationRoot: "tools/python",
  uninstall: { strategy: "installer-directory" },
  versionPattern: "Python (\\S+)",
  versionArgs: ["--version"],
};
