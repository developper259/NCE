import type { ManagedPackageDefinition } from "./types";

/**
 * JavaScript runtime managed by the Version Manager via the official Installer
 * distribution. The catalog labels it "JavaScript" to match the language it
 * serves; the underlying artifact is the Node.js distribution, which is why the
 * installer package keeps its own technical name.
 */
export const node: ManagedPackageDefinition = {
  id: "node",
  name: "JavaScript",
  description: "JavaScript runtime (Node.js) with npm and npx, used to run tools and scripts.",
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
