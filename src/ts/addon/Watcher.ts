import { BrowserWindow, ipcMain } from "electron";
import { PollingWatcher } from "./WatcherPolling";
import { watcherIgnored } from "./WatcherIgnore";
const chokidar = require("chokidar");
const path = require("path");
const fs = require("node:fs/promises");

const fsSync = require("node:fs");

interface FileChange {
  event: string;
  filePath: string;
  dirPath: string;
}

export class Watcher {
  private window: InstanceType<typeof BrowserWindow>;
  private watcher: any = null;
  private watchedPath: string = "";

  private pendingEvents: Map<string, FileChange> = new Map();

  private flushTimeout: ReturnType<typeof setTimeout> | null = null;

  private ownWrites: Map<string, Array<{ token: symbol; signature: string | null; expiresAt: number; timer: ReturnType<typeof setTimeout> }>> = new Map();
  private readonly ownWriteLifetimeMs = 5000;

  private usePolling: boolean = false;

  private restarting: boolean = false;

  private watchGeneration: number = 0;

  private reportedWatcherErrors: Set<string> = new Set();

  onChange: ((filePath: string) => void) | null = null;

  constructor(window: BrowserWindow) {
    this.window = window;
  }

  setWindow(window: BrowserWindow): void {
    this.window = window;
  }

  handleIPC() {
    ipcMain.handle(
      "Watcher:startWatching",
      async (event, projectPath: string) => {
        return this.startWatching(projectPath);
      },
    );

    ipcMain.handle("Watcher:stopWatching", async () => {
      return this.stopWatching();
    });
  }

  async startWatching(projectPath: string): Promise<void> {
    if (typeof projectPath !== "string" || !projectPath.trim() || projectPath.includes("\0")) return;
    await this.stopWatching();

    const generation = this.watchGeneration;

    const stats = await fs.stat(projectPath);
    if (generation !== this.watchGeneration) return;
    if (!stats.isDirectory()) {
      const error: any = new Error("Workspace path is not a directory.");
      error.code = "ENOTDIR";
      throw error;
    }

    this.watchedPath = projectPath;

    this.usePolling = false;

    this.createWatcher(projectPath, generation);
  }

  private createWatcher(projectPath: string, generation: number): void {
    const watcher = this.usePolling
      ? new PollingWatcher(projectPath)
      : chokidar.watch(projectPath, {
      ignored: watcherIgnored,
      persistent: true,
      ignoreInitial: true,

      usePolling: this.usePolling,
      interval: 400,
      binaryInterval: 1000,

      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
        });

    this.watcher = watcher;

    watcher.on("all", (event: string, filePath: string) => {
      if (generation !== this.watchGeneration || this.watcher !== watcher) return;
      this.onChange?.(filePath);
      const normalizedPath = path.normalize(filePath);

      if (event === "change" && this.consumeOwnWrite(normalizedPath)) {
        return;
      }

      const dirPath = path.dirname(filePath);

      if (
        event === "unlinkDir" &&
        path.resolve(filePath) === path.resolve(this.watchedPath)
      ) {
        this.window.webContents.send("file-system-change", [
          { event: "root-deleted", filePath, dirPath },
        ]);
        void this.stopWatching().catch((error) =>
          console.error("[Watcher] failed to stop after root deletion:", error),
        );
        return;
      }

      this.queueEvent(event, filePath, dirPath);
    });

    watcher.on("error", (err: unknown) => {
      if (generation !== this.watchGeneration || this.watcher !== watcher) return;
      this.handleError(err, projectPath, generation, watcher);
    });
  }

  private handleError(
    err: unknown,
    projectPath: string,
    generation: number,
    watcher: any,
  ): void {
    const code = (err as { code?: string } | null)?.code;
    const asarPath = this.getUnreadableAsarPath(err);
    if (asarPath) {
      const normalizedPath = path.normalize(asarPath);
      if (!this.reportedWatcherErrors.has(normalizedPath)) {
        this.reportedWatcherErrors.add(normalizedPath);
        console.warn(`[Watcher] skipping unreadable ASAR entry: ${normalizedPath}`);
      }
      this.restartWithPolling(projectPath, generation, watcher);
      return;
    }
    const recoverable = code === "UNKNOWN" || code === "EPERM" || code === "EBUSY";

    if (!recoverable) {
      console.error("[Watcher] error:", err);
      return;
    }
    if (this.usePolling || this.restarting) return;
    console.warn(
      `[Watcher] native file watching failed (${code}), falling back to polling.`,
    );

    this.restartWithPolling(projectPath, generation, watcher);
  }

  private restartWithPolling(
    projectPath: string,
    generation: number,
    watcher: any,
  ): void {
    if (this.usePolling || this.restarting) return;

    this.restarting = true;
    this.usePolling = true;

    void (async () => {
      try {
        if (this.watcher === watcher) this.watcher = null;
        await watcher.close();
        if (
          generation !== this.watchGeneration ||
          this.watchedPath !== projectPath ||
          !this.usePolling
        ) return;
        this.createWatcher(projectPath, generation);
      } catch (error) {
        if (generation === this.watchGeneration) {
          console.error("[Watcher] polling fallback failed:", error);
        }
      } finally {
        if (generation === this.watchGeneration) this.restarting = false;
      }
    })();
  }

  private getUnreadableAsarPath(err: unknown): string | null {
    const candidate = err as { path?: unknown; message?: unknown } | null;
    if (typeof candidate?.path === "string" && path.extname(candidate.path).toLowerCase() === ".asar") {
      return candidate.path;
    }
    const message = typeof candidate?.message === "string" ? candidate.message : "";
    const match = /^Invalid package\s+(.+?\.asar)(?:[\/\\].*)?$/i.exec(message);
    return match?.[1] || null;
  }

  beginOwnWrite(filePath: string): symbol | null {
    if (!filePath) return null;
    const normalizedPath = path.normalize(filePath);
    const token = Symbol(normalizedPath);
    const writes = this.ownWrites.get(normalizedPath) || [];
    const timer = setTimeout(() => this.cancelOwnWrite(normalizedPath, token), this.ownWriteLifetimeMs);
    writes.push({ token, signature: null, expiresAt: Date.now() + this.ownWriteLifetimeMs, timer });
    this.ownWrites.set(normalizedPath, writes);
    return token;
  }

  commitOwnWrite(filePath: string, token: symbol | null): void {
    if (!token) return;
    const normalizedPath = path.normalize(filePath);
    const write = this.ownWrites.get(normalizedPath)?.find((entry) => entry.token === token);
    if (!write) return;
    clearTimeout(write.timer);
    write.signature = this.fileSignature(normalizedPath);
    write.expiresAt = Date.now() + this.ownWriteLifetimeMs;
    write.timer = setTimeout(() => this.cancelOwnWrite(normalizedPath, token), this.ownWriteLifetimeMs);
  }

  cancelOwnWrite(filePath: string, token: symbol | null): void {
    if (!token) return;
    const normalizedPath = path.normalize(filePath);
    const writes = this.ownWrites.get(normalizedPath) || [];
    const removed = writes.find((entry) => entry.token === token);
    if (removed) clearTimeout(removed.timer);
    const remaining = writes.filter((entry) => entry.token !== token);
    if (remaining.length) this.ownWrites.set(normalizedPath, remaining);
    else this.ownWrites.delete(normalizedPath);
  }

  private fileSignature(filePath: string): string | null {
    try {
      const stat = fsSync.statSync(filePath);
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return null;
    }
  }

  private consumeOwnWrite(filePath: string): boolean {
    const now = Date.now();
    const signature = this.fileSignature(filePath);
    const allWrites = this.ownWrites.get(filePath) || [];
    const writes = allWrites.filter((entry) => entry.expiresAt > now);
    for (const entry of allWrites)
      if (entry.expiresAt <= now) clearTimeout(entry.timer);
    const match = [...writes].reverse().find((entry) => entry.signature !== null && entry.signature === signature);
    if (!match) {
      if (writes.length) this.ownWrites.set(filePath, writes);
      else this.ownWrites.delete(filePath);
      return false;
    }
    for (const entry of writes) clearTimeout(entry.timer);
    this.ownWrites.delete(filePath);
    return true;
  }

  private queueEvent(event: string, filePath: string, dirPath: string) {
    this.pendingEvents.set(filePath, {
      event,
      filePath,
      dirPath,
    });

    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
    }

    this.flushTimeout = setTimeout(() => this.flushEvents(), 150);
  }

  private flushEvents() {
    this.flushTimeout = null;

    if (this.pendingEvents.size === 0) {
      return;
    }

    const changes = Array.from(this.pendingEvents.values());

    this.pendingEvents.clear();

    this.window.webContents.send("file-system-change", changes);
  }

  async stopWatching(): Promise<void> {
    this.watchGeneration++;
    this.restarting = false;
    this.usePolling = false;
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);

      this.flushTimeout = null;
    }

    this.pendingEvents.clear();

    for (const writes of this.ownWrites.values())
      for (const write of writes) clearTimeout(write.timer);
    this.ownWrites.clear();

    this.reportedWatcherErrors.clear();

    const watcher = this.watcher;
    this.watcher = null;
    this.watchedPath = "";
    if (watcher) await watcher.close();
  }

  isWatching(): boolean {
    return this.watcher !== null;
  }

  getWatchedPath(): string {
    return this.watchedPath;
  }
}
