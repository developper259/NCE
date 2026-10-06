import { promises as fs } from "fs";
import path from "path";
import { NceWorkspaceStorage } from "./NceWorkspaceStorage";

export const WORKSPACE_INDEX_VERSION = 1;
export const WORKSPACE_INDEX_CACHE_FILE = "files-index-v1.json";
export const MAX_WORKSPACE_INDEX_ENTRIES = 200_000;
export const MAX_WORKSPACE_INDEX_BYTES = 64 * 1024 * 1024;

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

export interface WorkspaceIndexEntry {
  relativePath: string;
  name: string;
  extension: string;
  size: number;
  mtimeMs: number;
  type: "file";
}

export interface WorkspaceIndexSnapshot {
  version: 1;
  root: string;
  generatedAt: number;
  complete: true;
  entries: WorkspaceIndexEntry[];
}

interface PendingWatcherEvent {
  event: string;
  relativePath: string;
  filePath: string;
}

export class WorkspaceIndex {
  private readonly snapshots = new Map<string, WorkspaceIndexSnapshot>();
  private readonly invalidRoots = new Map<string, number>();
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
  private readonly watcherDebounceMs = 150;
  private readonly coalescedWatcherEvents = {
    received: 0,
    batches: 0,
    persistedWrites: 0,
    reconciliations: 0,
  };
  onReconciled: ((rootPath: string) => void) | null = null;

  getDiagnostics() {
    return { ...this.coalescedWatcherEvents };
  }

  consumeNeedsReconcile(rootPath: string): boolean {
    const root = path.resolve(rootPath);
    if (!this.needsReconcileRoots.has(root)) return false;
    this.needsReconcileRoots.delete(root);
    return true;
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
      candidate.type !== "file"
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
    entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
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
    while (this.snapshots.size > this.maxCachedWorkspaces) {
      const oldestRoot = this.snapshots.keys().next().value;
      if (!oldestRoot) break;
      this.snapshots.delete(oldestRoot);
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
      this.remember(memory);
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
    normalized.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
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
    }, this.watcherDebounceMs));
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
    }, this.watcherDebounceMs));
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
    }, this.watcherDebounceMs));
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
        }, this.watcherDebounceMs));
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
            const stats = await fs.stat(absolutePath);
            entries.push({
              relativePath: path.relative(root, absolutePath)
                .split(path.sep).join("/"),
              name: child.name,
              extension: path.extname(child.name).toLowerCase(),
              size: stats.size,
              mtimeMs: stats.mtimeMs,
              type: "file",
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
    this.rememberInvalidRoot(root);
    this.needsReconcileRoots.delete(root);
    this.snapshots.delete(root);
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
