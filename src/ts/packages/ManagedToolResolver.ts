import { promises as fs } from "node:fs";
import path from "node:path";
import type { InstallationRecord, InstallationState } from "./types";

/**
 * One installation that NCE itself owns and that can be used to launch a tool.
 *
 * This is a narrow, read-only view over `InstallationStore`: consumers such as
 * the LSP engine and the runtime resolver never see the PackageManager itself,
 * so they cannot install, uninstall or mutate the inventory.
 */
export interface ManagedToolInstallation {
  packageId: string;
  installationId: string;
  version: string;
  installDir: string;
  /** Absolute path of the package entry point as recorded by the Installer. */
  executable: string;
  state: InstallationState;
  platform: string;
  arch: string;
}

export type ManagedToolSource = "managed" | "missing";

export interface ManagedToolResolution {
  available: boolean;
  source: ManagedToolSource;
  installation: ManagedToolInstallation | null;
  /** Absolute path of the requested entry point, checked on disk. */
  executable: string | null;
  /** Absolute directory the entry point belongs to. */
  installDir: string | null;
  version: string | null;
  error: string | null;
}

/**
 * Read-only inventory port. `InstallationStore` satisfies it structurally, and
 * tests can provide a plain in-memory implementation.
 */
export interface ManagedInstallationSource {
  listByPackage(packageId: string): InstallationRecord[];
  list(): InstallationRecord[];
}

export interface ManagedToolResolverOptions {
  store: ManagedInstallationSource;
  platform?: NodeJS.Platform;
  /** Injectable for tests; defaults to a real filesystem check. */
  pathExists?: (target: string) => Promise<boolean>;
  /** Injectable for tests; defaults to a real executable-bit check. */
  isExecutable?: (target: string) => Promise<boolean>;
}

/** States in which an installation can actually be launched. */
const USABLE_STATES: ReadonlySet<InstallationState> = new Set<InstallationState>(["installed"]);

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function failure(error: string): ManagedToolResolution {
  return {
    available: false,
    source: "missing",
    installation: null,
    executable: null,
    installDir: null,
    version: null,
    error,
  };
}

function toInstallation(record: InstallationRecord): ManagedToolInstallation {
  return {
    packageId: record.packageId,
    installationId: record.id,
    version: record.version,
    installDir: record.installDir,
    executable: record.executable,
    state: record.state,
    platform: record.platform,
    arch: record.arch,
  };
}

/**
 * Resolves executables that NCE installed itself.
 *
 * The resolver never guesses: an installation is usable only when its state is
 * `installed`, its directory is the one the store recorded, and the requested
 * entry point really exists inside that directory. Anything else is reported as
 * an explicit failure so callers can fall back deliberately instead of silently
 * launching a stale or half-removed tool.
 */
export class ManagedToolResolver {
  private readonly store: ManagedInstallationSource;
  private readonly platform: NodeJS.Platform;
  private readonly pathExists: (target: string) => Promise<boolean>;
  private readonly isExecutable: (target: string) => Promise<boolean>;

  constructor(options: ManagedToolResolverOptions) {
    this.store = options.store;
    this.platform = options.platform ?? process.platform;
    this.pathExists = options.pathExists ?? defaultPathExists;
    this.isExecutable = options.isExecutable ?? ((target) => defaultIsExecutable(target, this.platform));
  }

  /** Every usable installation of a package, newest version first. */
  installationsFor(packageId: string): ManagedToolInstallation[] {
    return this.store
      .listByPackage(packageId)
      .filter((record) => USABLE_STATES.has(record.state))
      .map(toInstallation)
      .sort((left, right) => compareVersions(right.version, left.version));
  }

  /** The installation NCE would use for a package, without touching the disk. */
  activeInstallation(packageId: string): ManagedToolInstallation | null {
    return this.installationsFor(packageId)[0] ?? null;
  }

  /**
   * Resolve a package entry point.
   *
   * `entryPoint` is relative to the installation directory (for example
   * `lib/cli.mjs`). When omitted, the entry point recorded by the Installer is
   * used. The returned path is always absolute and always inside the install
   * directory.
   */
  async resolve(packageId: string, entryPoint?: string): Promise<ManagedToolResolution> {
    const installations = this.installationsFor(packageId);
    if (!installations.length) {
      const all = this.store.listByPackage(packageId);
      if (all.length) {
        const states = [...new Set(all.map((record) => record.state))].join(", ");
        return failure(`${packageId} is installed but not usable (state: ${states}).`);
      }
      return failure(`${packageId} is not installed by NCE.`);
    }

    const errors: string[] = [];
    for (const installation of installations) {
      const resolved = await this.resolveOne(installation, entryPoint);
      if (resolved.available) return resolved;
      if (resolved.error) errors.push(resolved.error);
    }
    return failure(errors[0] ?? `${packageId} has no usable installation.`);
  }

  /**
   * Resolve a package entry point only when the package is installed. Unlike
   * `resolve`, a missing package is reported as `available: false` with a
   * `missing` source and no error, which lets callers treat "not installed" as
   * an ordinary fallback case rather than a failure.
   */
  async resolveIfInstalled(packageId: string, entryPoint?: string): Promise<ManagedToolResolution> {
    const resolution = await this.resolve(packageId, entryPoint);
    if (!resolution.available && resolution.error && /is not installed by NCE/.test(resolution.error)) {
      return { ...resolution, error: null };
    }
    return resolution;
  }

  private async resolveOne(
    installation: ManagedToolInstallation,
    entryPoint?: string,
  ): Promise<ManagedToolResolution> {
    const installDir = path.resolve(installation.installDir);
    if (!(await this.pathExists(installDir)))
      return failure(`${installation.packageId} ${installation.version}: install directory is missing.`);

    const candidate = entryPoint
      ? path.resolve(installDir, entryPoint)
      : path.resolve(installation.executable);

    if (!isInside(installDir, candidate))
      return failure(`${installation.packageId}: entry point escapes the install directory.`);

    if (!(await this.pathExists(candidate)))
      return failure(`${installation.packageId} ${installation.version}: entry point is missing (${path.basename(candidate)}).`);

    // A JavaScript entry point is launched through a runtime, so it does not
    // need the executable bit. Native binaries do.
    if (!isScriptEntryPoint(candidate) && !(await this.isExecutable(candidate)))
      return failure(`${installation.packageId} ${installation.version}: entry point is not executable.`);

    return {
      available: true,
      source: "managed",
      installation,
      executable: candidate,
      installDir,
      version: installation.version,
      error: null,
    };
  }
}

/** `.js`, `.mjs`, `.cjs` entry points are run by a Node.js runtime, not exec'd. */
export function isScriptEntryPoint(target: string): boolean {
  return /\.(?:js|mjs|cjs)$/i.test(target);
}

async function defaultPathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function defaultIsExecutable(target: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const stats = await fs.stat(target);
    if (!stats.isFile()) return false;
    if (platform === "win32") return true;
    return (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Compare two dotted version strings numerically. Non-numeric segments fall back
 * to a lexical comparison so pre-release tags stay deterministic.
 */
export function compareVersions(left: string, right: string): number {
  const leftParts = left.split(/[.+-]/);
  const rightParts = right.split(/[.+-]/);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? "";
    const rightPart = rightParts[index] ?? "";
    const leftNumber = Number(leftPart);
    const rightNumber = Number(rightPart);
    const bothNumeric = Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
      && leftPart !== "" && rightPart !== "";
    if (bothNumeric) {
      if (leftNumber !== rightNumber) return leftNumber - rightNumber;
      continue;
    }
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}
