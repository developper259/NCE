import { BrowserWindow, ipcMain } from "electron";
const chokidar = require("chokidar");
const path = require("path");
const fs = require("node:fs/promises");

const DEFAULT_IGNORED = [
  /(^|[\/\\])\../,
  /[\/\\]node_modules[\/\\]/,
  /[\/\\]dist[\/\\]/,
  /[\/\\]build[\/\\]/,
  /[\/\\]out[\/\\]/,
  /[\/\\]\.next[\/\\]/,
  /[\/\\]coverage[\/\\]/,
];

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

  private ignoredChanges: Set<string> = new Set();

  private usePolling: boolean = false;

  private restarting: boolean = false;

  private watchGeneration: number = 0;

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
    const watcher = chokidar.watch(projectPath, {
      ignored: DEFAULT_IGNORED,
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

      if (event === "change" && this.ignoredChanges.has(normalizedPath)) {
        this.ignoredChanges.delete(normalizedPath);

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
    const recoverable = code === "UNKNOWN" || code === "EPERM" || code === "EBUSY";

    if (!recoverable) {
      console.error("[Watcher] error:", err);
      return;
    }
    if (this.usePolling || this.restarting) return;

    this.restarting = true;
    this.usePolling = true;
    console.warn(
      `[Watcher] native file watching failed (${code}), falling back to polling.`,
    );

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

  ignoreNextChange(filePath: string): void {
    if (!filePath) return;

    this.ignoredChanges.add(path.normalize(filePath));
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

    this.ignoredChanges.clear();

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
