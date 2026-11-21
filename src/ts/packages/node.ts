import type { ManagedPackageDefinition } from "./types";

/** Node.js runtime managed by the Version Manager via the official Installer distribution. */
export const node: ManagedPackageDefinition = {
  id: "node",
  name: "Node.js",
  description: "JavaScript runtime with npm and npx, used to run tools and scripts.",
  publisher: "Node.js Foundation",
  homepage: "https://nodejs.org",
  categories: ["language", "runtime"],
  icon: "fi fi-brands-nodejs",
  platforms: ["darwin", "win32"],
  capabilities: ["install", "uninstall", "verify"],
  installerPackageId: "node",
  installableVersion: "24.22.3",
  installationRoot: "tools/node",
  uninstall: { strategy: "installer-directory" },
  versionPattern: "v(\\S+)",
  versionArgs: ["--version"],
};
