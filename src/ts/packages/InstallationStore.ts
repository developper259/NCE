import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  InstallationRecord,
  InstallationState,
  PackageCategory,
} from "./types";
import { PACKAGE_CATEGORIES } from "./types";

export const INSTALLATION_SCHEMA_VERSION = 1;

const SAFE_TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const STATES: InstallationState[] = [
  "installing",
  "installed",
  "uninstalling",
  "failed",
  "corrupted",
  "unknown",
];
const ARCHITECTURES = ["x64", "arm64", "ia32", "arm"];

export interface InstallationStoreStatus {
  available: boolean;
  /** A newer schema was found; the store reads empty and refuses to overwrite it. */
  degraded: boolean;
  /** Entries dropped because they were invalid or the file could not be read. */
  dropped: number;
}

interface StoreFile {
  schemaVersion: number;
  installations: unknown[];
}

/**
 * Persistent inventory of the installations NCE owns. Writes are serialized and
 * atomic (tmp + fsync + rename), mirroring SettingsManager. The filesystem stays
 * the source of truth: a lost or corrupt inventory is rebuilt by reconciliation.
 */
export class InstallationStore {
  readonly filePath: string;
  private readonly now: () => number;
  private records = new Map<string, InstallationRecord>();
  private writeQueue: Promise<boolean> = Promise.resolve(true);
  private initialized = false;
  private degraded = false;
  private dropped = 0;

  constructor(userDataPath: string, options: { now?: () => number } = {}) {
    this.filePath = path.join(userDataPath, "installations.json");
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<InstallationStoreStatus> {
    this.records.clear();
    this.degraded = false;
    this.dropped = 0;
    let content: string;
    try {
      content = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.initialized = true;
        return this.status();
      }
      this.dropped = 1;
      this.initialized = true;
      return this.status();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      this.dropped = 1;
      this.initialized = true;
      return this.status();
    }
    const file = migrateStoreFile(parsed);
    if (!file) {
      this.dropped = 1;
      this.initialized = true;
      return this.status();
    }
    if (file.schemaVersion > INSTALLATION_SCHEMA_VERSION) {
      this.degraded = true;
      this.initialized = true;
      return this.status();
    }
    for (const entry of file.installations) {
      const record = validateRecord(entry);
      if (record && !this.records.has(record.id)) this.records.set(record.id, record);
      else this.dropped++;
    }
    this.initialized = true;
    return this.status();
  }

  status(): InstallationStoreStatus {
    return { available: this.initialized, degraded: this.degraded, dropped: this.dropped };
  }

  list(): InstallationRecord[] {
    return [...this.records.values()].map(cloneRecord);
  }

  get(id: string): InstallationRecord | null {
    const record = typeof id === "string" ? this.records.get(id) : undefined;
    return record ? cloneRecord(record) : null;
  }

  listByPackage(packageId: string): InstallationRecord[] {
    return this.list().filter((record) => record.packageId === packageId);
  }

  findByInstallDir(installDir: string): InstallationRecord | null {
    const target = path.resolve(installDir);
    return this.list().find((record) => path.resolve(record.installDir) === target) ?? null;
  }

  async add(record: InstallationRecord): Promise<boolean> {
    const valid = validateRecord(record);
    if (!valid || this.records.has(valid.id)) return false;
    const previous = this.records.get(valid.id) ?? null;
    this.records.set(valid.id, valid);
    if (!(await this.persist())) {
      // Memory must never claim an installation that could not be persisted:
      // it would disappear on the next launch while the UI showed it as ready.
      if (previous) this.records.set(valid.id, previous);
      else this.records.delete(valid.id);
      return false;
    }
    return true;
  }

  async update(id: string, patch: Partial<InstallationRecord>): Promise<InstallationRecord | null> {
    const existing = this.records.get(id);
    if (!existing) return null;
    const candidate: InstallationRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      packageId: existing.packageId,
      updatedAt: this.now(),
    };
    const valid = validateRecord(candidate);
    if (!valid) return null;
    this.records.set(id, valid);
    if (!(await this.persist())) {
      this.records.set(id, existing);
      return null;
    }
    return cloneRecord(valid);
  }

  async remove(id: string): Promise<boolean> {
    const previous = this.records.get(id);
    if (!previous) return false;
    this.records.delete(id);
    if (!(await this.persist())) {
      this.records.set(id, previous);
      return false;
    }
    return true;
  }

  flush(): Promise<boolean> {
    return this.writeQueue;
  }

  private persist(): Promise<boolean> {
    if (this.degraded) return Promise.resolve(false);
    // Take the snapshot when the write actually starts, not when it is queued:
    // a queued write must not persist a state that has since been rolled back.
    this.writeQueue = this.writeQueue
      .catch(() => false)
      .then(() => this.writeSnapshot({
        schemaVersion: INSTALLATION_SCHEMA_VERSION,
        installations: [...this.records.values()].map(cloneRecord),
      }));
    return this.writeQueue;
  }

  private async writeSnapshot(snapshot: StoreFile): Promise<boolean> {
    const temporaryPath = `${this.filePath}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const handle = await fs.open(temporaryPath, "w");
      try {
        await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporaryPath, this.filePath);
      return true;
    } catch {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      return false;
    }
  }
}

/** Normalizes known schema versions; returns null for unreadable shapes. */
export function migrateStoreFile(parsed: unknown): StoreFile | null {
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as { schemaVersion?: unknown; installations?: unknown };
  if (candidate.schemaVersion === INSTALLATION_SCHEMA_VERSION) {
    if (!Array.isArray(candidate.installations)) return null;
    return { schemaVersion: INSTALLATION_SCHEMA_VERSION, installations: candidate.installations };
  }
  if (typeof candidate.schemaVersion === "number" && candidate.schemaVersion > INSTALLATION_SCHEMA_VERSION) {
    return { schemaVersion: candidate.schemaVersion, installations: [] };
  }
  return null;
}

export function validateRecord(entry: unknown): InstallationRecord | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.id !== "string" || !SAFE_TOKEN.test(record.id)) return null;
  if (typeof record.packageId !== "string" || !SAFE_TOKEN.test(record.packageId)) return null;
  if (typeof record.name !== "string" || !record.name.trim()) return null;
  if (typeof record.version !== "string" || !SAFE_TOKEN.test(record.version)) return null;
  if (!Array.isArray(record.categories) || record.categories.length === 0) return null;
  if (record.categories.some((category) => !PACKAGE_CATEGORIES.includes(category as PackageCategory))) return null;
  if (!isAbsolutePath(record.installDir) || !isAbsolutePath(record.executable)) return null;
  if (typeof record.platform !== "string" || !record.platform) return null;
  if (typeof record.arch !== "string" || !ARCHITECTURES.includes(record.arch)) return null;
  if (typeof record.state !== "string" || !STATES.includes(record.state as InstallationState)) return null;
  if (record.provenance !== "managed") return null;
  if (!isTimestamp(record.installedAt) || !isTimestamp(record.updatedAt)) return null;
  if (record.verifiedAt !== undefined && !isTimestamp(record.verifiedAt)) return null;
  const uninstall = record.uninstall as { strategy?: unknown } | undefined;
  if (!uninstall || uninstall.strategy !== "installer-directory") return null;
  if (record.source !== undefined && !isSource(record.source)) return null;
  if (record.error !== undefined && !isError(record.error)) return null;
  return cloneRecord(record as unknown as InstallationRecord);
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && path.isAbsolute(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSource(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const source = value as Record<string, unknown>;
  return ["url", "checksum", "checksumAlgorithm"].every(
    (key) => source[key] === undefined || typeof source[key] === "string",
  );
}

function isError(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const error = value as Record<string, unknown>;
  return typeof error.code === "string" && typeof error.message === "string" && isTimestamp(error.at);
}

function cloneRecord(record: InstallationRecord): InstallationRecord {
  return {
    ...record,
    categories: [...record.categories],
    source: record.source ? { ...record.source } : undefined,
    uninstall: { ...record.uninstall },
    error: record.error ? { ...record.error } : undefined,
  };
}