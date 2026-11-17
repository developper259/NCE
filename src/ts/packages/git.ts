import { git as gitDistribution } from "../installer/packages/git";
import { trustedGitCandidates } from "../manager/GitProcess";
import type { ManagedPackageDefinition } from "./types";

/**
 * Git lifecycle managed through the existing dugite-native Installer package.
 * Installation, verification and directory removal stay in the Installer; this
 * definition only declares how the Version Manager discovers and integrates it.
 */
export const git: ManagedPackageDefinition = {
  id: "git",
  name: "Git",
  description: "Distributed version control system powering NCE Source Control.",
  publisher: "Git project",
  homepage: "https://git-scm.com",
  categories: ["git"],
  icon: "fi fi-rr-code-branch",
  platforms: ["darwin", "linux", "win32"],
  capabilities: ["install", "uninstall", "verify"],
  installerPackageId: gitDistribution.id,
  installableVersion: gitDistribution.version,
  installationRoot: "tools/git",
  uninstall: { strategy: "installer-directory" },
  managedSettings: ["git.path"],
  versionPattern: "git version (\\S+)",
  versionArgs: ["--version"],
  externalCandidates: trustedGitCandidates,
};