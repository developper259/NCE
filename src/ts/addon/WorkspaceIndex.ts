import { promises as fs } from "fs";
import path from "path";
import { NceWorkspaceStorage } from "./NceWorkspaceStorage";
import { isOpenableFileAtPath } from "./OpenableFile";

export const WORKSPACE_INDEX_VERSION = 2;
export const WORKSPACE_INDEX_CACHE_FILE = "files-index-v2.json";
export const MAX_WORKSPACE_INDEX_ENTRIES = 200_000;
export const MAX_WORKSPACE_INDEX_BYTES = 64 * 1024 * 1024;
export const LARGE_WORKSPACE_MODE_THRESHOLDS = Object.freeze({
  files: 10_000,
  directories: 1_500,
  totalIndexedBytes: 2 * 1024 * 1024 * 1024,
  pressureScore: 2,
});
export const DEFAULT_INDEX_WATCHER_DEBOUNCE_MS = 150;
export const LARGE_WORKSPACE_INDEX_WATCHER_DEBOUNCE_MS = 500;
export interface WorkspacePerformanceProfile {
  mode: "normal" | "large";
  indexWatcherDebounceMs: number;
  maxCachedSearchSessions: number;
}
export const NORMAL_WORKSPACE_PERFORMANCE_PROFILE: Readonly<WorkspacePerformanceProfile> =
  Object.freeze({
    mode: "normal",
    indexWatcherDebounceMs: DEFAULT_INDEX_WATCHER_DEBOUNCE_MS,
    maxCachedSearchSessions: 8,
  });
export const LARGE_WORKSPACE_PERFORMANCE_PROFILE: Readonly<WorkspacePerformanceProfile> =
  Object.freeze({
    mode: "large",
    indexWatcherDebounceMs: LARGE_WORKSPACE_INDEX_WATCHER_DEBOUNCE_MS,
    maxCachedSearchSessions: 4,
  });

export interface WorkspaceIndexStats {
  root: string;
  ready: boolean;
  fileCount: number;
  directoryCount: number;
  totalIndexedBytes: number;
  pressureScore: number;
  largeWorkspaceMode: boolean;
  generatedAt: number | null;
}

export const WORKSPACE_INDEX_IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "temp",
  "tmp",
  ".next",
  ".cache",
  ".turbo",
  ".nce",
]);

export function compareWorkspaceIndexPaths(leftPath: string, rightPath: string): number {
  const left = leftPath.split("/");
  const right = rightPath.split("/");
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const comparison = left[index].localeCompare(right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

export interface WorkspaceIndexEntry {
  relativePath: string;
  name: string;
  extension: string;
  size: number;
  mtimeMs: number;
  type: "file";
  openable: boolean;
}

export interface WorkspaceIndexSnapshot {
  version: 2;
  root: string;
  generatedAt: number;
  complete: true;
  entries: WorkspaceIndexEntry[];
}

export function summarizeWorkspaceIndex(
  snapshot: WorkspaceIndexSnapshot,
  ready = true,
): WorkspaceIndexStats {
  const directories = new Set<string>();
  let totalIndexedBytes = 0;
  for (const entry of snapshot.entries) {
    totalIndexedBytes = Math.min(
      Number.MAX_SAFE_INTEGER,
      totalIndexedBytes + entry.size,
    );
    for (
      let separatorIndex = entry.relativePath.indexOf("/");
      separatorIndex !== -1;
      separatorIndex = entry.relativePath.indexOf("/", separatorIndex + 1)
    ) directories.add(entry.relativePath.slice(0, separatorIndex));
  }
  const fileCount = snapshot.entries.length;
  const directoryCount = directories.size;
  const pressureScore = fileCount / LARGE_WORKSPACE_MODE_THRESHOLDS.files +
    directoryCount / LARGE_WORKSPACE_MODE_THRESHOLDS.directories +
    totalIndexedBytes / LARGE_WORKSPACE_MODE_THRESHOLDS.totalIndexedBytes;
  return {
    root: snapshot.root,
    ready,
    fileCount,
    directoryCount,
    totalIndexedBytes,
    pressureScore,
    largeWorkspaceMode: pressureScore >= LARGE_WORKSPACE_MODE_THRESHOLDS.pressureScore,
    generatedAt: snapshot.generatedAt,
  };
}

interface PendingWatcherEvent {
  event: string;
  relativePath: string;
  filePath: string;
}

export class WorkspaceIndex {
  private readonly snapshots = new Map<string, WorkspaceIndexSnapshot>();
  private readonly statsByRoot = new Map<string, WorkspaceIndexStats>();
  private readonly largeWorkspaceRoots = new Set<string>();
  private readonly invalidRoots = new Map<string, number>();
  private readonly rootRevisions = new Map<string, number>();
  private readonly buildQueues = new Map<string, Promise<void>>();
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly activeBuildTokens = new Map<string, object>();
  private readonly pendingWatcherEvents = new Map<
    string,
    Map<string, PendingWatcherEvent>
  >();
  private readonly watcherEventTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly eventFlushQueues = new Map<string, Promise<void>>();
  private readonly reconcileTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly reconcileQueues = new Map<string, Promise<void>>();
  private readonly reconcileAgainRoots = new Set<string>();
  private readonly staleRemovals = new Map<string, Promise<void>>();
  private readonly needsReconcileRoots = new Set<string>();
  private readonly maxCachedWorkspaces = 4;
  private readonly maxInvalidWorkspaces = 16;
  private readonly maxRevisionWorkspaces = 64;
  private readonly coalescedWatcherEvents = {
    received: 0,
    batches: 0,
    persistedWrites: 0,
    reconciliations: 0,
  };
  onReconciled: ((rootPath: string) => void) | null = null;
  onStatsUpdated: ((stats: WorkspaceIndexStats) => void) | null = null;

  getStats(rootPath: string): WorkspaceIndexStats {
    const root = path.resolve(rootPath);
    const previous = this.statsByRoot.get(root);
    if (previous) {
      const ready = this.snapshots.has(root) && !this.invalidRoots.has(root);
      const stats = ready === previous.ready ? previous : { ...previous, ready };
      this.statsByRoot.delete(root);
      this.statsByRoot.set(root, stats);
      return stats;
    }
    return {
      root,
      ready: false,
      fileCount: 0,
      directoryCount: 0,
      totalIndexedBytes: 0,
      pressureScore: 0,
      largeWorkspaceMode: false,
      generatedAt: null,
    };
  }

  getWatcherDebounceMs(rootPath: string): number {
    return this.getPerformanceProfile(rootPath).indexWatcherDebounceMs;
  }

  getPerformanceProfile(rootPath: string): Readonly<WorkspacePerformanceProfile> {
    return this.largeWorkspaceRoots.has(path.resolve(rootPath))
      ? LARGE_WORKSPACE_PERFORMANCE_PROFILE
      : NORMAL_WORKSPACE_PERFORMANCE_PROFILE;
  }

  getDiagnostics() {
    return { ...this.coalescedWatcherEvents };
  }

  consumeNeedsReconcile(rootPath: string): boolean {
    const root = path.resolve(rootPath);
    if (!this.needsReconcileRoots.has(root)) return false;
    this.needsReconcileRoots.delete(root);
    return true;
  }

  getRevision(rootPath: string): number {
    const root = path.resolve(rootPath);
    const revision = this.rootRevisions.get(root) || 0;
    this.rootRevisions.delete(root);
    this.rootRevisions.set(root, revision);
    return revision;
  }

  requiresReconcile(rootPath: string): boolean {
    const root = path.resolve(rootPath);
    return this.invalidRoots.has(root) ||
      this.needsReconcileRoots.has(root) ||
      this.pendingWatcherEvents.has(root) ||
      this.eventFlushQueues.has(root) ||
      this.reconcileTimers.has(root) ||
      this.reconcileQueues.has(root) ||
      this.buildQueues.has(root);
  }

  private bumpRevision(root: string): void {
    const revision = (this.rootRevisions.get(root) || 0) + 1;
    this.rootRevisions.delete(root);
    this.rootRevisions.set(root, revision);
    while (this.rootRevisions.size > this.maxRevisionWorkspaces) {
      const oldestRoot = this.rootRevisions.keys().next().value;
      if (!oldestRoot) break;
      this.rootRevisions.delete(oldestRoot);
    }
  }

  getCacheFilePath(rootPath: string): string {
    return new NceWorkspaceStorage(rootPath).getCachePath(
      WORKSPACE_INDEX_CACHE_FILE,
    );
  }

  private normalizeEntry(
    value: unknown,
  ): WorkspaceIndexEntry | null {
    if (!value || typeof value !== "object") return null;
    const candidate = value as Partial<WorkspaceIndexEntry>;
    if (
      typeof candidate.relativePath !== "string" ||
      typeof candidate.name !== "string" ||
      typeof candidate.extension !== "string" ||
      !Number.isFinite(candidate.size) ||
      !Number.isFinite(candidate.mtimeMs) ||
      candidate.size! < 0 ||
      candidate.mtimeMs! < 0 ||
      candidate.type !== "file" ||
      typeof candidate.openable !== "boolean"
    ) return null;

    const relativePath = candidate.relativePath.replace(/\\/g, "/");
    const parts = relativePath.split("/");
    if (
      !relativePath ||
      path.posix.isAbsolute(relativePath) ||
      parts.some((part) => !part || part === "." || part === "..") ||
      parts.slice(0, -1).some((part) => WORKSPACE_INDEX_IGNORED_DIRECTORIES.has(part)) ||
      path.posix.extname(candidate.name).toLowerCase() === ".asar" ||
      path.posix.basename(relativePath) !== candidate.name ||
      path.posix.extname(candidate.name).toLowerCase() !== candidate.extension
    ) return null;

    return {
      relativePath,
      name: candidate.name,
      extension: candidate.extension,
      size: candidate.size!,
      mtimeMs: candidate.mtimeMs!,
      type: "file",
      openable: candidate.openable,
    };
  }

  private validateSnapshot(
    value: unknown,
    rootPath: string,
  ): WorkspaceIndexSnapshot | null {
    if (!value || typeof value !== "object") return null;
    const candidate = value as Partial<WorkspaceIndexSnapshot>;
    const root = path.resolve(rootPath);
    if (
      candidate.version !== WORKSPACE_INDEX_VERSION ||
      candidate.root !== root ||
      candidate.complete !== true ||
      !Number.isFinite(candidate.generatedAt) ||
      !Array.isArray(candidate.entries) ||
      candidate.entries.length > MAX_WORKSPACE_INDEX_ENTRIES
    ) return null;

    const entries: WorkspaceIndexEntry[] = [];
    const paths = new Set<string>();
    for (const rawEntry of candidate.entries) {
      const entry = this.normalizeEntry(rawEntry);
      if (!entry || paths.has(entry.relativePath)) return null;
      paths.add(entry.relativePath);
      entries.push(entry);
    }
    entries.sort((left, right) => compareWorkspaceIndexPaths(
      left.relativePath,
      right.relativePath,
    ));
    return {
      version: WORKSPACE_INDEX_VERSION,
      root,
      generatedAt: candidate.generatedAt!,
      complete: true,
      entries,
    };
  }

  private remember(snapshot: WorkspaceIndexSnapshot): void {
    this.snapshots.delete(snapshot.root);
    this.snapshots.set(snapshot.root, snapshot);
    const stats = summarizeWorkspaceIndex(snapshot);
    this.statsByRoot.delete(snapshot.root);
    this.statsByRoot.set(snapshot.root, stats);
    if (stats.largeWorkspaceMode) this.largeWorkspaceRoots.add(snapshot.root);
    else this.largeWorkspaceRoots.delete(snapshot.root);
    this.onStatsUpdated?.(stats);
    while (this.snapshots.size > this.maxCachedWorkspaces) {
      const oldestRoot = this.snapshots.keys().next().value;
      if (!oldestRoot) break;
      this.snapshots.delete(oldestRoot);
      this.statsByRoot.delete(oldestRoot);
      this.largeWorkspaceRoots.delete(oldestRoot);
    }
    while (this.statsByRoot.size > this.maxCachedWorkspaces) {
      const oldestRoot = this.statsByRoot.keys().next().value;
      if (!oldestRoot) break;
      this.statsByRoot.delete(oldestRoot);
      this.largeWorkspaceRoots.delete(oldestRoot);
    }
  }

  private touch(root: string): void {
    const snapshot = this.snapshots.get(root);
    if (!snapshot) return;
    this.snapshots.delete(root);
    this.snapshots.set(root, snapshot);
    const stats = this.statsByRoot.get(root);
    if (stats) {
      this.statsByRoot.delete(root);
      this.statsByRoot.set(root, stats);
    }
  }

  private rememberInvalidRoot(root: string): void {
    this.invalidRoots.delete(root);
    this.invalidRoots.set(root, Date.now());
    while (this.invalidRoots.size > this.maxInvalidWorkspaces) {
      const oldestRoot = this.invalidRoots.keys().next().value;
      if (!oldestRoot) break;
      this.invalidRoots.delete(oldestRoot);
    }
  }

  async load(rootPath: string): Promise<WorkspaceIndexSnapshot | null> {
    if (typeof rootPath !== "string" || !rootPath.trim()) return null;
    const root = path.resolve(rootPath);
    if (this.invalidRoots.has(root)) return null;
    try {
      if (!(await fs.stat(root)).isDirectory()) return null;
    } catch {
      return null;
    }
    const memory = this.snapshots.get(root);
    if (memory?.complete) {
      this.touch(root);
      return memory;
    }

    const storage = new NceWorkspaceStorage(root);
    const target = storage.getCachePath(WORKSPACE_INDEX_CACHE_FILE);
    try {
      const stats = await fs.stat(target);
      if (stats.size > MAX_WORKSPACE_INDEX_BYTES) return null;
      const parsed = JSON.parse(await fs.readFile(target, "utf8")) as unknown;
      const snapshot = this.validateSnapshot(parsed, root);
      if (!snapshot) return null;
      this.remember(snapshot);
      this.needsReconcileRoots.add(root);
      return snapshot;
    } catch {
      return null;
    }
  }

  private createSnapshot(
    rootPath: string,
    entries: WorkspaceIndexEntry[],
  ): WorkspaceIndexSnapshot | null {
    if (entries.length > MAX_WORKSPACE_INDEX_ENTRIES) return null;
    const root = path.resolve(rootPath);
    const normalized: WorkspaceIndexEntry[] = [];
    const paths = new Set<string>();
    for (const rawEntry of entries) {
      const entry = this.normalizeEntry(rawEntry);
      if (!entry || paths.has(entry.relativePath)) continue;
      paths.add(entry.relativePath);
      normalized.push(entry);
    }
    normalized.sort((left, right) => compareWorkspaceIndexPaths(
      left.relativePath,
      right.relativePath,
    ));
    return {
      version: WORKSPACE_INDEX_VERSION,
      root,
      generatedAt: Date.now(),
      complete: true,
      entries: normalized,
    };
  }

  private queueWrite(snapshot: WorkspaceIndexSnapshot): Promise<void> {
    const storage = new NceWorkspaceStorage(snapshot.root);
    const target = storage.getCachePath(WORKSPACE_INDEX_CACHE_FILE);
    const previous = this.writeQueues.get(snapshot.root) || Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      await storage.ensureStructure();
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random()
        .toString(16).slice(2)}.tmp`;
      try {
        const serialized = JSON.stringify(snapshot);
        if (Buffer.byteLength(serialized, "utf8") > MAX_WORKSPACE_INDEX_BYTES)
          throw new Error("Workspace index exceeds the size limit.");
        await fs.writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
        await fs.rename(temporary, target);
        this.coalescedWatcherEvents.persistedWrites += 1;
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.writeQueues.set(snapshot.root, write);
    const cleanup = () => {
      if (this.writeQueues.get(snapshot.root) === write)
        this.writeQueues.delete(snapshot.root);
    };
    void write.then(cleanup, cleanup);
    return write;
  }

  primeFromScan(rootPath: string, entries: WorkspaceIndexEntry[]): boolean {
    const snapshot = this.createSnapshot(rootPath, entries);
    if (!snapshot) {
      void this.invalidate(rootPath);
      return false;
    }
    this.invalidRoots.delete(snapshot.root);
    this.needsReconcileRoots.delete(snapshot.root);
    this.remember(snapshot);
    this.bumpRevision(snapshot.root);
    void this.queueWrite(snapshot).catch((error) => {
      console.warn("[NCE Workspace Index] Unable to persist index", {
        root: snapshot.root,
        error: error?.message || String(error),
      });
    });
    return true;
  }

  scheduleBuild(rootPath: string): void {
    if (typeof rootPath !== "string" || !rootPath.trim()) return;
    const root = path.resolve(rootPath);
    if (this.buildQueues.has(root)) return;
    const build = Promise.resolve().then(async () => {
      if (await this.load(root)) return;
      await this.build(root);
    }).catch((error: any) => {
      console.warn("[NCE Workspace Index] Unable to build index", {
        root,
        error: error?.message || String(error),
      });
    });
    this.buildQueues.set(root, build);
    void build.then(() => {
      if (this.buildQueues.get(root) === build) this.buildQueues.delete(root);
    });
  }

  scheduleReconcile(rootPath: string): void {
    if (typeof rootPath !== "string" || !rootPath.trim()) return;
    const root = path.resolve(rootPath);
    const previousTimer = this.reconcileTimers.get(root);
    if (previousTimer) clearTimeout(previousTimer);
    this.reconcileTimers.set(root, setTimeout(() => {
      this.reconcileTimers.delete(root);
      void this.reconcile(root, true);
    }, this.getWatcherDebounceMs(root)));
  }

  handleWatcherEvent(rootPath: string, event: string, filePath: string): void {
    if (
      typeof rootPath !== "string" || !rootPath.trim() ||
      typeof filePath !== "string" || !filePath.trim()
    ) return;
    const root = path.resolve(rootPath);
    const absolutePath = path.resolve(filePath);
    const relativePath = path.relative(root, absolutePath);
    if (!relativePath || relativePath === ".") {
      this.bumpRevision(root);
      if (event === "unlinkDir") this.markStale(root);
      else this.markStaleAndScheduleReconcile(root);
      return;
    }
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) return;

    const normalizedRelativePath = relativePath.split(path.sep).join("/");
    const pathParts = normalizedRelativePath.split("/");
    const directories = event === "unlinkDir" || event === "addDir"
      ? pathParts
      : pathParts.slice(0, -1);
    if (
      directories.some((part) => WORKSPACE_INDEX_IGNORED_DIRECTORIES.has(part)) ||
      (event !== "unlinkDir" && event !== "addDir" &&
        path.extname(pathParts[pathParts.length - 1]).toLowerCase() === ".asar")
    ) return;

    this.bumpRevision(root);
    this.coalescedWatcherEvents.received += 1;
    if (!["add", "change", "unlink", "unlinkDir"].includes(event)) {
      this.markStaleAndScheduleReconcile(root);
      return;
    }

    let events = this.pendingWatcherEvents.get(root);
    if (!events) {
      events = new Map();
      this.pendingWatcherEvents.set(root, events);
    }
    events.set(normalizedRelativePath, {
      event,
      relativePath: normalizedRelativePath,
      filePath: absolutePath,
    });
    if (events.size > MAX_WORKSPACE_INDEX_ENTRIES) {
      this.pendingWatcherEvents.delete(root);
      this.markStaleAndScheduleReconcile(root);
      return;
    }
    const currentTimer = this.watcherEventTimers.get(root);
    if (currentTimer) clearTimeout(currentTimer);
    this.watcherEventTimers.set(root, setTimeout(() => {
      this.watcherEventTimers.delete(root);
      void this.flushEvents(root);
    }, this.getWatcherDebounceMs(root)));
  }

  async flushEvents(rootPath: string): Promise<void> {
    if (typeof rootPath !== "string" || !rootPath.trim()) return;
    const root = path.resolve(rootPath);
    const timer = this.watcherEventTimers.get(root);
    if (timer) clearTimeout(timer);
    this.watcherEventTimers.delete(root);

    while (true) {
      const events = this.pendingWatcherEvents.get(root);
      if (!events?.size) {
        this.pendingWatcherEvents.delete(root);
        await this.eventFlushQueues.get(root)?.catch(() => undefined);
        if (!this.pendingWatcherEvents.get(root)?.size) {
          await this.staleRemovals.get(root)?.catch(() => undefined);
          return;
        }
        continue;
      }
      this.pendingWatcherEvents.delete(root);
      const previous = this.eventFlushQueues.get(root) || Promise.resolve();
      const flush = previous.catch(() => undefined).then(() =>
        this.applyWatcherEvents(root, [...events.values()]),
      );
      this.eventFlushQueues.set(root, flush);
      await flush.catch((error: any) => {
        console.warn("[NCE Workspace Index] Unable to apply watcher events", {
          root,
          error: error?.message || String(error),
        });
      });
      if (this.eventFlushQueues.get(root) === flush)
        this.eventFlushQueues.delete(root);
    }
  }

  private async applyWatcherEvents(
    root: string,
    events: PendingWatcherEvent[],
  ): Promise<void> {
    if (!events.length) return;
    this.coalescedWatcherEvents.batches += 1;
    if (events.some(({ event }) => event === "addDir" || event === "rename")) {
      this.markStaleAndScheduleReconcile(root);
      return;
    }
    for (const { event } of events) {
      if (!(["add", "change", "unlink", "unlinkDir"].includes(event))) {
        this.markStaleAndScheduleReconcile(root);
        return;
      }
    }

    await this.reconcileQueues.get(root)?.catch(() => undefined);
    await this.buildQueues.get(root)?.catch(() => undefined);
    const snapshot = this.snapshots.get(root) || await this.load(root);
    if (!snapshot) {
      this.markStaleAndScheduleReconcile(root);
      return;
    }

    const entries = new Map(snapshot.entries.map((entry) => [entry.relativePath, entry]));
    const directoryRemovals = events.filter(({ event }) => event === "unlinkDir");
    for (const removal of directoryRemovals) {
      const prefix = `${removal.relativePath}/`;
      for (const relativePath of entries.keys()) {
        if (relativePath.startsWith(prefix)) entries.delete(relativePath);
      }
    }
    for (const change of events) {
      if (change.event === "unlink") entries.delete(change.relativePath);
    }

    for (const change of events) {
      if (change.event !== "add" && change.event !== "change") continue;
      try {
        const stats = await fs.lstat(change.filePath);
        if (!stats.isFile() || stats.isSymbolicLink()) {
          entries.delete(change.relativePath);
          continue;
        }
        entries.set(change.relativePath, {
          relativePath: change.relativePath,
          name: path.posix.basename(change.relativePath),
          extension: path.extname(change.relativePath).toLowerCase(),
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          type: "file",
          openable: await isOpenableFileAtPath(change.filePath, stats.size),
        });
      } catch (error: any) {
        if (error?.code === "ENOENT") entries.delete(change.relativePath);
        else {
          this.markStaleAndScheduleReconcile(root);
          return;
        }
      }
    }
    if (entries.size > MAX_WORKSPACE_INDEX_ENTRIES) {
      this.markStaleAndScheduleReconcile(root);
      return;
    }
    const updated = this.createSnapshot(root, [...entries.values()]);
    if (!updated) {
      this.markStaleAndScheduleReconcile(root);
      return;
    }
    this.remember(updated);
    try {
      await this.queueWrite(updated);
    } catch {
      this.markStaleAndScheduleReconcile(root);
    }
  }

  private markStaleAndScheduleReconcile(root: string): void {
    this.markStale(root);
    const previousTimer = this.reconcileTimers.get(root);
    if (previousTimer) clearTimeout(previousTimer);
    this.reconcileTimers.set(root, setTimeout(() => {
      this.reconcileTimers.delete(root);
      void this.reconcile(root);
    }, this.getWatcherDebounceMs(root)));
  }

  private markStale(root: string): void {
    if (this.reconcileQueues.has(root)) this.reconcileAgainRoots.add(root);
    const buildWasActive = this.activeBuildTokens.has(root);
    this.activeBuildTokens.delete(root);
    if (!this.invalidRoots.has(root) || buildWasActive) {
      const removal = this.invalidate(root);
      this.staleRemovals.set(root, removal);
      void removal.finally(() => {
        if (this.staleRemovals.get(root) === removal)
          this.staleRemovals.delete(root);
      });
    }
    const timer = this.reconcileTimers.get(root);
    if (timer) clearTimeout(timer);
    this.reconcileTimers.delete(root);
  }

  private async reconcile(root: string, force = false): Promise<void> {
    const existing = this.reconcileQueues.get(root);
    if (existing) {
      if (force || this.invalidRoots.has(root))
        this.reconcileAgainRoots.add(root);
      return existing;
    }
    const task = Promise.resolve().then(async () => {
      await this.staleRemovals.get(root)?.catch(() => undefined);
      await this.buildQueues.get(root)?.catch(() => undefined);
      if (!force && !this.invalidRoots.has(root) && await this.load(root)) return;
      this.coalescedWatcherEvents.reconciliations += 1;
      const snapshot = await this.build(root);
      if (snapshot) this.onReconciled?.(root);
    });
    this.reconcileQueues.set(root, task);
    try {
      await task;
    } catch (error: any) {
      console.warn("[NCE Workspace Index] Unable to reconcile index", {
        root,
        error: error?.message || String(error),
      });
    } finally {
      if (this.reconcileQueues.get(root) === task)
        this.reconcileQueues.delete(root);
      if (this.reconcileAgainRoots.delete(root)) {
        this.reconcileTimers.set(root, setTimeout(() => {
          this.reconcileTimers.delete(root);
          void this.reconcile(root);
        }, this.getWatcherDebounceMs(root)));
      }
    }
  }

  async build(rootPath: string): Promise<WorkspaceIndexSnapshot | null> {
    if (typeof rootPath !== "string" || !rootPath.trim()) return null;
    const root = path.resolve(rootPath);
    const token = {};
    this.activeBuildTokens.set(root, token);
    try {
      let rootStats;
      try {
        rootStats = await fs.stat(root);
      } catch {
        return null;
      }
      if (!rootStats.isDirectory()) return null;

      const entries: WorkspaceIndexEntry[] = [];
      let truncated = false;
      let incomplete = false;
      const walk = async (directory: string): Promise<void> => {
        if (truncated) return;
        let children;
        try {
          children = await fs.readdir(directory, { withFileTypes: true });
        } catch (error: any) {
          if (error?.code !== "ENOENT") incomplete = true;
          return;
        }
        children.sort((left, right) => left.name.localeCompare(right.name));
        for (const child of children) {
          if (truncated || child.isSymbolicLink()) continue;
          const absolutePath = path.join(directory, child.name);
          if (child.isDirectory()) {
            if (WORKSPACE_INDEX_IGNORED_DIRECTORIES.has(child.name)) continue;
            await walk(absolutePath);
            continue;
          }
          if (!child.isFile() || path.extname(child.name).toLowerCase() === ".asar")
            continue;
          if (entries.length >= MAX_WORKSPACE_INDEX_ENTRIES) {
            truncated = true;
            break;
          }
          try {
            const stats = await fs.lstat(absolutePath);
            if (!stats.isFile() || stats.isSymbolicLink()) continue;
            entries.push({
              relativePath: path.relative(root, absolutePath)
                .split(path.sep).join("/"),
              name: child.name,
              extension: path.extname(child.name).toLowerCase(),
              size: stats.size,
              mtimeMs: stats.mtimeMs,
              type: "file",
              openable: await isOpenableFileAtPath(absolutePath, stats.size),
            });
          } catch (error: any) {
            if (error?.code !== "ENOENT") incomplete = true;
          }
        }
      };
      await walk(root);
      if (this.activeBuildTokens.get(root) !== token) return null;
      if (truncated || incomplete) {
        await this.invalidate(root);
        return null;
      }
      const snapshot = this.createSnapshot(root, entries);
      if (!snapshot) return null;
      this.invalidRoots.delete(root);
      this.needsReconcileRoots.delete(root);
      this.remember(snapshot);
      this.bumpRevision(root);
      try {
        await this.queueWrite(snapshot);
      } catch (error: any) {
        console.warn("[NCE Workspace Index] Unable to persist index", {
          root,
          error: error?.message || String(error),
        });
      }
      if (this.activeBuildTokens.get(root) !== token) return null;
      return snapshot;
    } finally {
      if (this.activeBuildTokens.get(root) === token)
        this.activeBuildTokens.delete(root);
    }
  }

  async flush(rootPath?: string): Promise<void> {
    if (rootPath) {
      const root = path.resolve(rootPath);
      await this.flushEvents(root);
      while (this.reconcileTimers.has(root)) {
        const reconcileTimer = this.reconcileTimers.get(root);
        if (!reconcileTimer) break;
        clearTimeout(reconcileTimer);
        this.reconcileTimers.delete(root);
        await this.reconcile(root, true);
        await this.reconcileQueues.get(root)?.catch(() => undefined);
      }
      await this.reconcileQueues.get(root)?.catch(() => undefined);
      await this.staleRemovals.get(root)?.catch(() => undefined);
      await this.buildQueues.get(root)?.catch(() => undefined);
      await this.writeQueues.get(root)?.catch(() => undefined);
      return;
    }
    const roots = new Set([
      ...this.buildQueues.keys(),
      ...this.writeQueues.keys(),
      ...this.pendingWatcherEvents.keys(),
      ...this.reconcileTimers.keys(),
      ...this.reconcileQueues.keys(),
      ...this.staleRemovals.keys(),
    ]);
    await Promise.all([...roots].map((root) => this.flush(root)));
  }

  async invalidate(rootPath: string): Promise<void> {
    if (typeof rootPath !== "string" || !rootPath.trim()) return;
    const root = path.resolve(rootPath);
    this.activeBuildTokens.delete(root);
    this.bumpRevision(root);
    this.rememberInvalidRoot(root);
    this.needsReconcileRoots.delete(root);
    this.snapshots.delete(root);
    const previousStats = this.statsByRoot.get(root);
    if (previousStats) {
      const staleStats = { ...previousStats, ready: false };
      this.statsByRoot.delete(root);
      this.statsByRoot.set(root, staleStats);
      this.onStatsUpdated?.(staleStats);
    }
    const target = new NceWorkspaceStorage(root).getCachePath(
      WORKSPACE_INDEX_CACHE_FILE,
    );
    const previous = this.writeQueues.get(root) || Promise.resolve();
    const removal = previous.catch(() => undefined).then(() =>
      fs.rm(target, { force: true }),
    );
    this.writeQueues.set(root, removal);
    await removal.catch(() => undefined);
    if (this.writeQueues.get(root) === removal) this.writeQueues.delete(root);
  }
}
