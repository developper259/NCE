export type InstallerPlatform = NodeJS.Platform;
export type InstallerArchitecture = "x64" | "arm64" | "ia32" | "arm";

export type ChecksumAlgorithm = "sha256" | "sha512";

export interface DownloadConfig {
  url: string;
  checksum: string;
  checksumAlgorithm: ChecksumAlgorithm;
  size?: number;
}

export interface ArchiveConfig {
  format: "zip" | "tar.gz";
  stripComponents?: number;
}

export interface PlatformConfig {
  download: DownloadConfig;
  archive: ArchiveConfig;
  executable: string;
}

export type InstallStep =
  | { type: "download" }
  | { type: "extract" }
  | {
      type: "command";
      executable: string;
      args?: string[];
      cwd?: string;
      timeoutMs?: number;
      required?: boolean;
    }
  | { type: "copy"; from: string; to: string; required?: boolean }
  | { type: "move"; from: string; to: string; required?: boolean }
  | { type: "delete"; path: string; required?: boolean }
  | {
      type: "verify";
      executable: string;
      args?: string[];
      timeoutMs?: number;
      required?: boolean;
    };

export interface InstallConfig {
  destination?: string;
  steps?: InstallStep[];
}

export interface VerificationConfig {
  executable: string;
  args?: string[];
  timeoutMs?: number;
}

export interface PackageDefinition {
  id: string;
  name: string;
  version: string;
  platforms: Partial<
    Record<InstallerPlatform, Partial<Record<InstallerArchitecture, PlatformConfig>>>
  >;
  install?: InstallConfig;
  verification: VerificationConfig;
}

export type InstallerErrorCode =
  | "PACKAGE_NOT_FOUND"
  | "INVALID_PACKAGE"
  | "UNSUPPORTED_PLATFORM"
  | "INSTALL_BUSY"
  | "DOWNLOAD_FAILED"
  | "CHECKSUM_MISMATCH"
  | "EXTRACTION_FAILED"
  | "STEP_FAILED"
  | "VERIFICATION_FAILED"
  | "CANCELLED"
  | "INSTALL_FAILED";

export interface InstallProgress {
  packageId: string;
  version: string;
  step: string;
  stepIndex: number;
  stepCount: number;
  message: string;
  percent?: number;
  receivedBytes?: number;
  totalBytes?: number;
}

export interface InstallSuccess {
  success: true;
  packageId: string;
  version: string;
  executable: string;
  installDir: string;
  alreadyInstalled?: boolean;
}

export interface InstallFailure {
  success: false;
  packageId: string;
  code: InstallerErrorCode;
  error: string;
}

export type InstallResult = InstallSuccess | InstallFailure;

export interface InstallOptions {
  onProgress?: (progress: InstallProgress) => void;
  signal?: AbortSignal;
}

export interface InstallerOptions {
  userDataPath: string;
  registry?: Record<string, PackageDefinition>;
  platform?: InstallerPlatform;
  arch?: InstallerArchitecture;
}