import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../installer/command";
import type { Installer } from "../installer/Installer";
import { builtinLanguages } from "../languages/index";
import type {
  InstallResult,
  InstallerArchitecture,
  InstallerPlatform,
  UninstallResult,
} from "../installer/types";
import { InstallationStore } from "./InstallationStore";
import { PackageRegistry } from "./PackageRegistry";
import type {
  ExternalInstallation,
  InstallationRecord,
  InstallationState,
  ManagedPackageDefinition,
  OperationFailure,
  OperationKind,
  OperationSnapshot,
  OperationState,
  PackageInfo,
  PackageState,
  SettingsBridge,
  VerifyResult,
  VersionManagerEvent,
  VersionManagerSnapshot,
} from "./types";
import {
  PackageDependencyGraph,
  type ComponentDependencyEdge,
  type RemovalCheck,
} from "./PackageDependencyGraph";

const MAX_RECENT_OPERATIONS = 20;
const EXTERNAL_VERSION_TIMEOUT_MS = 10_000;

export type ManagedInstallResult = Extract<InstallResult, { success: true }> | OperationFailure;
export type ManagedUninstallResult = Extract<UninstallResult, { success: true }> | OperationFailure;

interface ActiveOperation {
  snapshot: OperationSnapshot;
  controller: AbortController;
}

export interface PackageManagerOptions {
  userDataPath: string;
  installer: Installer;
  registry?: PackageRegistry;
  store?: InstallationStore;
  settings?: SettingsBridge;
  platform?: InstallerPlatform;
  arch?: InstallerArchitecture;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  createId?: () => string;
}

export interface OperationResult {
  success: boolean;
  code?: string;
  error?: string;
}

/**
 * Central lifecycle orchestrator. It owns no package-specific installation code:
 * concrete download/extract/verify/remove work stays in the shared Installer,
 * while this class reconciles the inventory, guards concurrency, applies the
 * declarative settings integration and emits operation events.
 */
export class PackageManager {
  readonly registry: PackageRegistry;
  readonly store: InstallationStore;
  private readonly userDataPath: string;
  private readonly installer: Installer;
  private readonly settings?: SettingsBridge;
  private readonly platform: InstallerPlatform;
  private readonly arch: InstallerArchitecture;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly emitter = new EventEmitter();
  private readonly active = new Map<string, ActiveOperation>();
  private recent: OperationSnapshot[] = [];
  private readonly external = new Map<string, ExternalInstallation>();
  private readonly issues = new Map<string, string>();

  constructor(options: PackageManagerOptions) {
    this.userDataPath = options.userDataPath;
    this.installer = options.installer;
    this.registry = options.registry ?? new PackageRegistry();
    this.store = options.store ?? new InstallationStore(options.userDataPath);
    this.settings = options.settings;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? (process.arch as InstallerArchitecture);
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.emitter.setMaxListeners(64);
  }

  subscribe(listener: (event: VersionManagerEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.reconcile();
  }

  async refresh(): Promise<VersionManagerSnapshot> {
    await this.reconcile();
    this.emitInventoryChanged();
    return this.getState();
  }

  getState(): VersionManagerSnapshot {
    const operations = [
      ...[...this.active.values()].map((operation) => cloneOperation(operation.snapshot)),
      ...this.recent.map(cloneOperation),
    ];
    return {
      packages: this.registry.list().map((definition) => this.packageInfo(definition)),
      operations,
      generatedAt: this.now(),
    };
  }

  async install(packageId: string): Promise<ManagedInstallResult> {
    const definition = this.registry.has(packageId) ? this.registry.get(packageId) : null;
    if (!definition)
      return { success: false, packageId, code: "PACKAGE_NOT_FOUND", error: `Unknown package "${String(packageId)}".` };
    return this.installWithDependencies(definition, new Set());
  }

  /**
   * Install a package and everything it declares it needs.
   *
   * `ManagedPackageDefinition.dependencies` was declarative only: nothing made
   * sure a dependency was present, so Pyright could be installed without the
   * Node.js runtime it cannot run without. Dependencies are now installed
   * first, dependency-first, and a dependency that cannot run on this platform
   * stops the whole operation with an explicit reason instead of producing a
   * package that will never work.
   */
  private async installWithDependencies(
    definition: ManagedPackageDefinition,
    visiting: Set<string>,
  ): Promise<ManagedInstallResult> {
    if (visiting.has(definition.id))
      return {
        success: false,
        packageId: definition.id,
        code: "DEPENDENCY_CYCLE",
        error: `Circular dependency involving ${definition.name}.`,
      };
    visiting.add(definition.id);

    for (const dependencyId of definition.dependencies ?? []) {
      if (!this.registry.has(dependencyId)) continue;
      const dependency = this.registry.get(dependencyId);
      if (!dependency.platforms.includes(this.platform))
        return {
          success: false,
          packageId: definition.id,
          code: "UNSUPPORTED_PLATFORM",
          error: `${definition.name} requires ${dependency.name}, which has no distribution for ${this.platform}/${this.arch}.`,
        };
      if (this.hasUsableInstallation(dependencyId)) continue;
      const installed = await this.installWithDependencies(dependency, visiting);
      if (!installed.success) {
        return {
          success: false,
          packageId: definition.id,
          code: installed.code,
          error: `${definition.name} needs ${dependency.name}, which could not be installed: ${installed.error}`,
        };
      }
    }

    visiting.delete(definition.id);
    return this.installOne(definition);
  }

  /** True when a package has at least one installation in a usable state. */
  private hasUsableInstallation(packageId: string): boolean {
    return this.store
      .listByPackage(packageId)
      .some((record) => record.state === "installed");
  }

  /**
   * Whether a package can be uninstalled without breaking another installed
   * package. Exposed so the UI can explain a refusal before attempting it.
   */
  removalCheck(packageId: string): RemovalCheck {
    return this.dependencyGraph().checkRemoval(packageId);
  }

  private dependencyGraph(): PackageDependencyGraph {
    return new PackageDependencyGraph({
      registry: this.registry,
      installedPackageIds: () => this.store
        .list()
        .filter((record) => record.state === "installed")
        .map((record) => record.packageId),
      installedVersions: (packageId) => this.store
        .listByPackage(packageId)
        .filter((record) => record.state === "installed")
        .map((record) => record.version),
      componentDependencies: () => {
        const edges: ComponentDependencyEdge[] = [];
        for (const language of builtinLanguages) {
          const byComponentId = new Map(language.components.map((component) => [component.id, component]));
          for (const component of language.components) {
            for (const dependencyId of component.dependencies ?? []) {
              const dependency = byComponentId.get(dependencyId);
              if (dependency) {
                edges.push({
                  packageId: component.packageId,
                  dependsOnPackageId: dependency.packageId,
                });
              }
            }
          }
        }
        return edges;
      },
    });
  }

  private async installOne(definition: ManagedPackageDefinition): Promise<ManagedInstallResult> {
    const packageId = definition.id;
    if (!definition.capabilities.includes("install"))
      return { success: false, packageId, code: "UNSUPPORTED_OPERATION", error: `${definition.name} cannot be installed by NCE.` };
    if (!definition.platforms.includes(this.platform))
      return { success: false, packageId, code: "UNSUPPORTED_PLATFORM", error: `${definition.name} has no distribution for ${this.platform}/${this.arch}.` };
    if (this.active.has(definition.id))
      return { success: false, packageId, code: "OPERATION_BUSY", error: `Another operation is already running for ${definition.name}.` };

    const operation = this.startOperation(definition.id, "install");
    let result: ManagedInstallResult;
    try {
      result = await this.installer.install(definition.installerPackageId, {
        signal: operation.controller.signal,
        onProgress: (progress) => {
          operation.snapshot.progress = progress;
          this.emit({ type: "operation", operation: cloneOperation(operation.snapshot) });
        },
      });
    } catch (error) {
      result = { success: false, packageId, code: "INSTALL_FAILED", error: errorMessage(error) };
    }

    if (result.success) {
      let version = result.version;
      const verified = await this.installer
        .verifyInstallation(definition.installerPackageId, result.installDir, { functional: false })
        .catch(() => null);
      if (verified?.success) version = this.parseVersion(definition, verified.stdout) ?? version;
      const record = await this.recordInstallation(definition, result, version);
      await this.applyInstallSettings(definition, record);
      this.finishOperation(operation, "completed");
      this.emitInventoryChanged(definition.id);
    } else {
      this.finishOperation(
        operation,
        result.code === "CANCELLED" ? "cancelled" : "failed",
        { code: result.code, message: result.error },
      );
    }
    return result;
  }

  async uninstall(installationId: string): Promise<ManagedUninstallResult> {
    const record = typeof installationId === "string" ? this.store.get(installationId) : null;
    if (!record)
      return { success: false, packageId: "", code: "INSTALLATION_NOT_FOUND", error: "Unknown installation." };
    const definition = this.registry.has(record.packageId) ? this.registry.get(record.packageId) : null;
    if (!definition)
      return { success: false, packageId: record.packageId, code: "PACKAGE_NOT_FOUND", error: `Unknown package "${record.packageId}".` };
    if (!definition.capabilities.includes("uninstall"))
      return { success: false, packageId: record.packageId, code: "UNSUPPORTED_OPERATION", error: `${definition.name} cannot be uninstalled by NCE.` };
    if (this.active.has(definition.id))
      return { success: false, packageId: record.packageId, code: "OPERATION_BUSY", error: `Another operation is already running for ${definition.name}.` };

    // A shared runtime must not disappear while something still needs it.
    const removal = this.removalCheck(record.packageId);
    if (!removal.allowed)
      return {
        success: false,
        packageId: record.packageId,
        code: "PACKAGE_REQUIRED",
        error: removal.reason ?? `${definition.name} is still required by another package.`,
      };

    const operation = this.startOperation(definition.id, "uninstall", record.id);
    let result: ManagedUninstallResult;
    try {
      result = await this.installer.uninstall(definition.installerPackageId, { installDir: record.installDir });
    } catch (error) {
      result = { success: false, packageId: record.packageId, code: "INSTALL_FAILED", error: errorMessage(error) };
    }

    if (result.success) {
      await this.applyUninstallSettings(definition, record);
      await this.store.remove(record.id);
      this.finishOperation(operation, "completed");
      this.emitInventoryChanged(record.packageId);
    } else {
      this.finishOperation(operation, "failed", { code: result.code, message: result.error });
    }
    return result;
  }

  async verify(installationId: string): Promise<VerifyResult> {
    const record = typeof installationId === "string" ? this.store.get(installationId) : null;
    if (!record) return { success: false, code: "INSTALLATION_NOT_FOUND", error: "Unknown installation." };
    const definition = this.registry.has(record.packageId) ? this.registry.get(record.packageId) : null;
    if (!definition) return { success: false, code: "PACKAGE_NOT_FOUND", error: `Unknown package "${record.packageId}".` };
    if (!definition.capabilities.includes("verify"))
      return { success: false, code: "UNSUPPORTED_OPERATION", error: `${definition.name} cannot be verified.` };
    if (this.active.has(definition.id))
      return { success: false, code: "OPERATION_BUSY", error: `Another operation is already running for ${definition.name}.` };

    const operation = this.startOperation(definition.id, "verify", record.id);
    const outcome = await this.installer.verifyInstallation(definition.installerPackageId, record.installDir, {
      functional: true,
      signal: operation.controller.signal,
    });
    let state: InstallationState;
    let version = record.version;
    let error: InstallationRecord["error"];
    if (outcome.success) {
      state = "installed";
      version = this.parseVersion(definition, outcome.stdout) ?? record.version;
    } else if (outcome.code === "VERIFICATION_FAILED") {
      state = "corrupted";
      error = { code: outcome.code, message: outcome.error, at: this.now() };
    } else {
      state = "unknown";
      error = { code: outcome.code, message: outcome.error, at: this.now() };
    }
    const updated = await this.store.update(record.id, {
      state,
      version,
      executable: outcome.executable || record.executable,
      verifiedAt: this.now(),
      error,
    });
    // A failed verification must not be reported as a successful operation:
    // callers (notably the component orchestrator) use this flag to decide
    // whether it is safe to uninstall the components this one replaces.
    this.finishOperation(
      operation,
      outcome.success ? "completed" : "failed",
      outcome.success ? undefined : { code: outcome.code, message: outcome.error },
    );
    this.emitInventoryChanged(record.packageId);
    if (!outcome.success) {
      return { success: false, code: outcome.code, error: outcome.error };
    }
    return { success: true, installation: updated ?? { ...record, state, version, error } };
  }

  cancel(packageId: string): boolean {
    const operation = this.active.get(packageId);
    if (!operation || operation.snapshot.state !== "running") return false;
    if (operation.snapshot.kind === "uninstall") return false;
    operation.controller.abort();
    if (operation.snapshot.kind === "install") this.installer.cancel();
    return true;
  }

  /** Reconcile the inventory with the filesystem: import, refresh, mark or drop records. */
  private async reconcile(): Promise<void> {
    await this.recoverInterruptedCommits();
    for (const definition of this.registry.list()) {
      this.external.delete(definition.id);
      this.issues.delete(definition.id);
      if (this.active.has(definition.id)) continue;
      if (!definition.platforms.includes(this.platform)) {
        if (this.store.listByPackage(definition.id).length)
          this.issues.set(definition.id, `Unsupported platform ${this.platform}/${this.arch}.`);
        continue;
      }
      const root = path.join(this.userDataPath, definition.installationRoot);
      let entries: string[];
      try {
        entries = await fs.readdir(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = [];
        else {
          this.issues.set(definition.id, errorMessage(error));
          continue;
        }
      }
      const seen = new Set<string>();
      for (const entry of entries) {
        const dir = path.join(root, entry);
        const stats = await fs.stat(dir).catch(() => null);
        if (!stats?.isDirectory()) continue;
        seen.add(path.resolve(dir));
        const outcome = await this.installer.verifyInstallation(definition.installerPackageId, dir, { functional: false });
        if (outcome.success) {
          const version = this.parseVersion(definition, outcome.stdout) ?? entry;
          await this.upsert(definition, dir, "installed", version, outcome.executable, stats.birthtimeMs, undefined);
        } else {
          const state: InstallationState = outcome.code === "VERIFICATION_FAILED" ? "corrupted" : "unknown";
          await this.upsert(
            definition, dir, state, entry, outcome.executable, stats.birthtimeMs,
            { code: outcome.code, message: outcome.error, at: this.now() },
          );
        }
      }
      for (const record of this.store.listByPackage(definition.id)) {
        if (!seen.has(path.resolve(record.installDir))) await this.store.remove(record.id);
      }
      await this.detectExternal(definition);
    }
  }

  /**
   * Recover an install interrupted between moving the old version aside and
   * moving the validated new version into place. In that window the destination
   * is missing and the previous install lives in a staging backup folder.
   * Without this, reconciliation would drop the record and lose a working install.
   */
  private async recoverInterruptedCommits(): Promise<void> {
    const toolsRoot = path.join(this.userDataPath, "tools");
    let entries: string[];
    try {
      entries = await fs.readdir(toolsRoot);
    } catch {
      return;
    }
    for (const entry of entries) {
      const match = /^\.staging-([a-zA-Z0-9][a-zA-Z0-9._-]+)-/.exec(entry);
      if (!match || !this.registry.has(match[1])) continue;
      const staging = path.join(toolsRoot, entry);
      const previous = path.join(staging, "previous");
      if (!await this.directoryExists(previous)) continue;
      const definition = this.registry.get(match[1]);
      const destination = this.installer.destinationFor(definition.installerPackageId);
      if (await this.directoryExists(destination)) continue;
      try {
        await fs.rename(previous, destination);
      } catch {
        // Leave the backup in place for the next launch rather than losing it.
      }
    }
  }

  private async directoryExists(target: string): Promise<boolean> {
    try {
      return (await fs.stat(target)).isDirectory();
    } catch {
      return false;
    }
  }

  private async upsert(
    definition: ManagedPackageDefinition,
    dir: string,
    state: InstallationState,
    version: string,
    executable: string,
    birthtimeMs: number,
    error: InstallationRecord["error"],
  ): Promise<void> {
    const installDir = path.resolve(dir);
    const existing = this.store.findByInstallDir(installDir);
    const target = executable || existing?.executable || installDir;
    const patch = {
      name: definition.name,
      categories: [...definition.categories],
      version,
      executable: target,
      state,
      verifiedAt: this.now(),
      error,
    };
    if (existing) {
      await this.store.update(existing.id, patch);
      return;
    }
    await this.store.add({
      id: this.createId(),
      packageId: definition.id,
      name: definition.name,
      version,
      categories: [...definition.categories],
      installDir,
      executable: target,
      platform: this.platform,
      arch: this.arch,
      state,
      provenance: "managed",
      installedAt: Number.isFinite(birthtimeMs) && birthtimeMs > 0 ? Math.round(birthtimeMs) : this.now(),
      updatedAt: this.now(),
      verifiedAt: this.now(),
      uninstall: { strategy: definition.uninstall.strategy },
      error,
    });
  }

  private async recordInstallation(
    definition: ManagedPackageDefinition,
    result: Extract<InstallResult, { success: true }>,
    version: string,
  ): Promise<InstallationRecord> {
    const installDir = path.resolve(result.installDir);
    const existing = this.store.findByInstallDir(installDir);
    const base = {
      packageId: definition.id,
      name: definition.name,
      version,
      categories: [...definition.categories],
      installDir,
      executable: result.executable,
      platform: this.platform,
      arch: this.arch,
      state: "installed" as InstallationState,
      provenance: "managed" as const,
      updatedAt: this.now(),
      verifiedAt: this.now(),
      source: result.source,
      uninstall: { strategy: definition.uninstall.strategy },
      error: undefined,
    };
    if (existing) {
      const updated = await this.store.update(existing.id, base);
      return updated ?? { ...existing, ...base };
    }
    const record: InstallationRecord = { id: this.createId(), installedAt: this.now(), ...base };
    await this.store.add(record);
    return record;
  }

  private async detectExternal(definition: ManagedPackageDefinition): Promise<void> {
    if (!definition.externalCandidates) return;
    const toolsRoot = this.toolsRoot();
    for (const candidate of definition.externalCandidates(this.platform, this.env)) {
      const stats = await fs.stat(candidate).catch(() => null);
      if (!stats?.isFile()) continue;
      if (this.platform !== "win32" && (stats.mode & 0o111) === 0) continue;
      if (isInsidePath(candidate, toolsRoot)) continue;
      let version: string | undefined;
      try {
        const outcome = await runCommand(candidate, definition.versionArgs ?? ["--version"], {
          cwd: os.tmpdir(),
          timeoutMs: EXTERNAL_VERSION_TIMEOUT_MS,
          signal: new AbortController().signal,
        });
        version = this.parseVersion(definition, outcome.stdout);
      } catch {
        version = undefined;
      }
      this.external.set(definition.id, { packageId: definition.id, executable: candidate, version, provenance: "external" });
      return;
    }
  }

  private async applyInstallSettings(definition: ManagedPackageDefinition, record: InstallationRecord): Promise<void> {
    if (!this.settings || !definition.managedSettings) return;
    const root = path.join(this.userDataPath, definition.installationRoot);
    for (const key of definition.managedSettings) {
      const current = this.settings.get(key);
      const value = typeof current === "string" ? current.trim() : "";
      // Adopt the managed build when unset or already managed; never override an explicit external choice.
      if (!value || isInsidePath(value, root)) await this.settings.set(key, record.executable);
    }
  }

  private async applyUninstallSettings(definition: ManagedPackageDefinition, record: InstallationRecord): Promise<void> {
    if (!this.settings || !definition.managedSettings) return;
    for (const key of definition.managedSettings) {
      const current = this.settings.get(key);
      if (typeof current === "string" && isInsidePath(current, record.installDir))
        await this.settings.set(key, "");
    }
  }

  private packageInfo(definition: ManagedPackageDefinition): PackageInfo {
    const installations = this.store.listByPackage(definition.id);
    const active = this.active.get(definition.id)?.snapshot;
    const supported = definition.platforms.includes(this.platform);
    const lastFinished = this.recent.find((operation) => operation.packageId === definition.id);
    let state: PackageState;
    if (active?.state === "running" && active.kind === "install") state = "installing";
    else if (active?.state === "running" && active.kind === "uninstall") state = "uninstalling";
    else if (installations.some((record) => record.state === "installed")) state = "installed";
    else if (installations.length && installations.every((record) => record.state === "corrupted")) state = "corrupted";
    else if (installations.length && installations.some((record) => record.state === "unknown")) state = "unknown";
    else if (installations.length) state = installations[0].state;
    else if (this.issues.has(definition.id)) state = "unknown";
    else state = lastFinished?.state === "failed" ? "failed" : "not-installed";

    const recordError = installations
      .map((record) => record.error)
      .filter((error): error is NonNullable<InstallationRecord["error"]> => Boolean(error))
      .sort((a, b) => b.at - a.at)[0];
    const lastError = recordError ?? (lastFinished?.state === "failed" && lastFinished.error
      ? { code: lastFinished.error.code, message: lastFinished.error.message, at: lastFinished.finishedAt ?? lastFinished.startedAt }
      : undefined);

    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      publisher: definition.publisher,
      homepage: definition.homepage,
      categories: [...definition.categories],
      icon: definition.icon,
      platforms: [...definition.platforms],
      capabilities: [...definition.capabilities],
      dependencies: definition.dependencies ? [...definition.dependencies] : undefined,
      state,
      supported,
      installableVersion: definition.installableVersion,
      managedSettings: definition.managedSettings ? [...definition.managedSettings] : undefined,
      installations,
      external: this.external.get(definition.id),
      lastError,
      hiddenFromCatalog: definition.hiddenFromCatalog === true,
    };
  }

  private parseVersion(definition: ManagedPackageDefinition, stdout: string): string | undefined {
    if (!definition.versionPattern) return undefined;
    try {
      const match = new RegExp(definition.versionPattern).exec(stdout);
      return match?.[1] || undefined;
    } catch {
      return undefined;
    }
  }

  private startOperation(packageId: string, kind: OperationKind, installationId?: string): ActiveOperation {
    const snapshot: OperationSnapshot = {
      id: this.createId(),
      packageId,
      installationId,
      kind,
      state: "running",
      startedAt: this.now(),
    };
    const operation: ActiveOperation = { snapshot, controller: new AbortController() };
    this.active.set(packageId, operation);
    this.emit({ type: "operation", operation: cloneOperation(snapshot) });
    return operation;
  }

  private finishOperation(operation: ActiveOperation, state: OperationState, error?: { code: string; message: string }): void {
    operation.snapshot.state = state;
    operation.snapshot.finishedAt = this.now();
    if (error) operation.snapshot.error = error;
    this.active.delete(operation.snapshot.packageId);
    this.recent.unshift(cloneOperation(operation.snapshot));
    this.recent = this.recent.slice(0, MAX_RECENT_OPERATIONS);
    this.emit({ type: "operation", operation: cloneOperation(operation.snapshot) });
  }

  private toolsRoot(): string {
    return path.join(this.userDataPath, "tools");
  }

  private emit(event: VersionManagerEvent): void {
    this.emitter.emit("event", event);
  }

  /** Announce which packages changed, for services that depend on them. */
  private emitInventoryChanged(...packageIds: string[]): void {
    this.emit({ type: "inventory-changed", packageIds: [...new Set(packageIds)] });
  }
}

function cloneOperation(operation: OperationSnapshot): OperationSnapshot {
  return {
    ...operation,
    progress: operation.progress ? { ...operation.progress } : undefined,
    error: operation.error ? { ...operation.error } : undefined,
  };
}

/** Windows-aware containment check mirroring SettingsView.isInstalledPackagePathCurrent. */
export function isInsidePath(value: string, directory: string): boolean {
  const current = String(value || "").trim();
  const target = String(directory || "").trim();
  if (!current || !target) return false;
  const windows = /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith("\\\\");
  const normalize = (input: string) => {
    const normalized = input.replace(/\\/g, "/").replace(/\/+$/, "");
    return windows ? normalized.toLowerCase() : normalized;
  };
  const a = normalize(current);
  const b = normalize(target);
  return a === b || a.startsWith(`${b}/`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}