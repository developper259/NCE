import { BrowserWindow } from "electron";
const chokidar = require("chokidar");

export class Watcher {
  private window: InstanceType<typeof BrowserWindow>;
  private watcher: any = null;
  private watchedPath: string = "";

  constructor(window: BrowserWindow) {
    this.window = window;
  }

  startWatching(projectPath: string) {
    if (this.watcher) {
      this.stopWatching();
    }

    this.watchedPath = projectPath;

    this.watcher = chokidar.watch(projectPath, {
      ignored: /(^|[\/\\])\../,
      persistent: true,
    });

    this.watcher.on("all", (event: string, filePath: string) => {
      const path = require("path");
      const dirPath = path.dirname(filePath);
      this.window.webContents.send("file-system-change", {
        event,
        filePath,
        dirPath,
      });
    });

    console.log("Started watching:", projectPath);
  }

  stopWatching() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      this.watchedPath = "";
      console.log("Stopped watching");
    }
  }

  isWatching(): boolean {
    return this.watcher !== null;
  }

  getWatchedPath(): string {
    return this.watchedPath;
  }
}
