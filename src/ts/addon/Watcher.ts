import { BrowserWindow, ipcMain } from "electron";
const chokidar = require("chokidar");
const path = require("path");

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

  constructor(window: BrowserWindow) {
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
    await this.stopWatching();

    this.watchedPath = projectPath;

    this.watcher = chokidar.watch(projectPath, {
      ignored: DEFAULT_IGNORED,
      persistent: true,
      ignoreInitial: true,

      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    this.watcher.on("all", (event: string, filePath: string) => {
      const normalizedPath = path.normalize(filePath);

      if (event === "change" && this.ignoredChanges.has(normalizedPath)) {
        this.ignoredChanges.delete(normalizedPath);

        return;
      }

      const dirPath = path.dirname(filePath);

      this.queueEvent(event, filePath, dirPath);
    });

    this.watcher.on("error", (err: unknown) => {
      console.error("[Watcher] error:", err);
    });
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
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);

      this.flushTimeout = null;
    }

    this.pendingEvents.clear();

    this.ignoredChanges.clear();

    if (this.watcher) {
      await this.watcher.close();

      this.watcher = null;
      this.watchedPath = "";
    }
  }

  isWatching(): boolean {
    return this.watcher !== null;
  }

  getWatchedPath(): string {
    return this.watchedPath;
  }
}
