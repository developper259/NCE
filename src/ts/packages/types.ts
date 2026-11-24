import type {
  InstallerArchitecture,
  InstallerPlatform,
  InstallProgress,
} from "../installer/types";

export type PackageCategory =
  | "git"
  | "language"
  | "runtime"
  | "compiler"
  | "toolchain"
  | "language-server"
  | "other";

export const PACKAGE_CATEGORIES: readonly PackageCategory[] = [
  "git",
  "language",
  "runtime",
  "compiler",
  "toolchain",
  "language-server",
  "other",
];

/** Lifecycle capabilities a package actually implements today. */
export type PackageCapability = "install" | "uninstall" | "verify";

/** Persisted lifecycle of one managed installation. */
export type InstallationState =
  | "installing"
  | "installed"
  | "uninstalling"
  | "failed"
  | "corrupted"
  | "unknown";

/** Package-level state derived from its installations and operations. */
export type PackageState = InstallationState | "not-installed";

export type UninstallStrategy = "installer-directory";

export interface InstallationSource {
  url?: string;
  checksum?: string;
  checksumAlgorithm?: string;
}

export interface InstallationError {
  code: string;
  message: string;
  at: number;
}

/** One installation owned by NCE. The store never holds external software. */
export interface InstallationRecord {
  id: string;
  packageId: string;
  name: string;
  version: string;
  categories: PackageCategory[];
  installDir: string;
  executable: string;
  platform: InstallerPlatform;
  arch: InstallerArchitecture;
  state: InstallationState;
  provenance: "managed";
  installedAt: number;
  updatedAt: number;
  verifiedAt?: number;
  source?: InstallationSource;
  uninstall: { strategy: UninstallStrategy };
  error?: InstallationError;
}

/** Software found on the machine but not installed by NCE. Never uninstallable here. */
export interface ExternalInstallation {
  packageId: string;
  executable: string;
  version?: string;
  provenance: "external";
}

export interface ManagedPackageDefinition {
  id: string;
  name: string;
  description: string;
  publisher?: string;
  homepage?: string;
  categories: PackageCategory[];
  icon?: string;
  platforms: InstallerPlatform[];
  capabilities: PackageCapability[];
  dependencies?: string[];
  /** Id of the concrete distribution in the Installer registry. */
  installerPackageId: string;
  /** Version of that distribution, derived from the Installer package definition. */
  installableVersion: string;
  /** Directory (relative to userData, inside tools/) holding one sub-directory per installed version. */
  installationRoot: string;
  uninstall: { strategy: UninstallStrategy };
  /** Settings keys that may reference the installation; cleared on uninstall, refreshed on install. */
  managedSettings?: string[];
  /** Capture group 1 applied to the verification command stdout yields the real version. */
  versionPattern?: string;
  /** Arguments used to read the version of a managed or external executable. */
  versionArgs?: string[];
  /** Trusted absolute locations probed for an external installation. */
  externalCandidates?: (platform: InstallerPlatform, env: NodeJS.ProcessEnv) => string[];
  /**
   * True when this package is an installation artifact that the catalog must not
   * list on its own. It is installed through the components of the language that
   * owns it, so a separate card would duplicate that language.
   */
  hiddenFromCatalog?: boolean;
}

export interface PackageInfo {
  id: string;
  name: string;
  description: string;
  publisher?: string;
  homepage?: string;
  categories: PackageCategory[];
  icon?: string;
  platforms: InstallerPlatform[];
  capabilities: PackageCapability[];
  dependencies?: string[];
  state: PackageState;
  supported: boolean;
  /** Version NCE can install today; not a claim about newer upstream releases. */
  installableVersion: string;
  /** Settings keys that may reference the installation; lets the UI describe uninstall consequences. */
  managedSettings?: string[];
  installations: InstallationRecord[];
  external?: ExternalInstallation;
  lastError?: InstallationError;
  /** True when the catalog must not list this package as its own card. */
  hiddenFromCatalog?: boolean;
}

export type OperationKind = "install" | "uninstall" | "verify";
export type OperationState = "running" | "completed" | "failed" | "cancelled";

export interface OperationSnapshot {
  id: string;
  packageId: string;
  installationId?: string;
  kind: OperationKind;
  state: OperationState;
  progress?: InstallProgress;
  startedAt: number;
  finishedAt?: number;
  error?: { code: string; message: string };
}

export interface VersionManagerSnapshot {
  packages: PackageInfo[];
  operations: OperationSnapshot[];
  generatedAt: number;
}

export type VersionManagerEvent =
  | { type: "operation"; operation: OperationSnapshot }
  /** `packageIds` names what changed, so dependent services can react precisely. */
  | { type: "inventory-changed"; packageIds: string[] };

export interface OperationFailure {
  success: false;
  packageId?: string;
  code: string;
  error: string;
}

export interface VerifySuccess {
  success: true;
  installation: InstallationRecord;
}

export type VerifyResult = VerifySuccess | OperationFailure;

export interface SettingsBridge {
  get(key: string): unknown;
  set(key: string, value: unknown): Promise<boolean>;
}