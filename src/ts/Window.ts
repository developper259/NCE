import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "path";

import { FileManager } from "./addon/FileManager";
import { Watcher } from "./addon/Watcher";
import { AppMenu } from "./addon/Menu";
import { NSH } from "./NSH";
import { ContextMenu } from "./addon/ContextMenu";
import { WorkspaceSearch } from "./addon/WorkspaceSearch";
import { App } from "./App";

export class Window {
  window: InstanceType<typeof BrowserWindow> | null;
  fileManager: FileManager | undefined;
  watcher: Watcher | undefined;
  contextMenu: ContextMenu | undefined;
  nsh: NSH | undefined;
  workspaceSearch: WorkspaceSearch | undefined;
  app: App;
  forceQuit: boolean;
  rendererReady: boolean;
  quitState: "idle" | "waiting-renderer" | "approved";
  quitTimer: ReturnType<typeof setTimeout> | null;
  ipcRegistered: boolean;

  constructor(app: App) {
    this.window = null;
    this.app = app;
    this.forceQuit = false;
    this.rendererReady = false;
    this.quitState = "idle";
    this.quitTimer = null;
    this.ipcRegistered = false;
  }

  create() {
    this.forceQuit = false;
    this.rendererReady = false;
    this.quitState = "idle";

    this.window = new BrowserWindow({
      width: 800,
      height: 600,
      minWidth: 800,
      minHeight: 600,
      title: this.app.name,
      fullscreen: true,
      icon: path.join(__dirname, "../../assets/logo/NCE/dark-logo.png"),

      webPreferences: {
        sandbox: true,

        preload: path.join(__dirname, "../../src/js/main/Preload.js"),

        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    this.fileManager = new FileManager(this);

    this.watcher = new Watcher(this.window);

    this.contextMenu = new ContextMenu(this.window);

    this.nsh = new NSH(this);

    this.workspaceSearch = new WorkspaceSearch(this);

    const menu = new AppMenu(this.window, this);

    this.window.loadFile(path.join(__dirname, "../../src/html/index.html"));

    this.window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      if (level >= 2) {
        console.error(`[Renderer] ${message} (${sourceId}:${line})`);
      }
    });
    this.window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
      console.error("[Renderer] did-fail-load", { errorCode, errorDescription, validatedURL });
    });
    this.window.webContents.on("render-process-gone", (_event, details) => {
      console.error("[Renderer] render-process-gone", details);
      this.rendererReady = false;
      this.clearQuitTimer();
    });
    this.window.webContents.on("preload-error", (_event, preloadPath, error) => {
      console.error("[Renderer] preload-error", { preloadPath, message: error?.message });
      this.rendererReady = false;
    });

    this.window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });

    this.window.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith("file://")) event.preventDefault();
    });

    this.window.on("close", (event) => {
      if (this.forceQuit) {
        return;
      }

      event.preventDefault();
      this.requestQuit();
    });

    this.window.on("closed", () => {
      this.window = null;
    });

    this.window.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") {
        return;
      }

      const isReload =
        (input.meta || input.control) && input.key.toLowerCase() === "r";

      if (!isReload) {
        return;
      }

      event.preventDefault();

      this.window?.webContents.reload();
    });

    // this.window.webContents.openDevTools();

    if (!this.fileManager) {
      console.log("FileManager is not defined");
    }

    if (!this.ipcRegistered) {
      ipcMain.handle("App:quit", async () => this.requestQuit());
      ipcMain.handle("App:rendererReady", async () => {
        this.rendererReady = true;
        return true;
      });
      ipcMain.handle("App:approveQuit", async () => {
        this.clearQuitTimer();
        this.quitState = "approved";
        this.forceQuit = true;
        this.window?.close();
        return true;
      });
      ipcMain.handle("App:cancelQuit", async () => {
        this.clearQuitTimer();
        return true;
      });

      this.fileManager.handleIPC();
      this.watcher.handleIPC();
      this.contextMenu.handleIPC();
      this.workspaceSearch.handleIPC();
      this.ipcRegistered = true;
    }
  }

  requestQuit() {
    if (!this.window || this.forceQuit || this.quitState !== "idle") return false;
    if (!this.rendererReady || this.window.webContents.isDestroyed()) {
      this.forceQuit = true;
      this.window.close();
      return true;
    }

    this.quitState = "waiting-renderer";
    this.window.webContents.send("Request:saveState");
    this.quitTimer = setTimeout(() => {
      this.quitTimer = null;
      if (this.quitState !== "waiting-renderer" || !this.window) return;
      dialog.showMessageBox(this.window, {
        type: "warning",
        buttons: ["Force Quit", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        message: "NCE is not responding.",
        detail: "Force quit may lose unsaved changes.",
      }).then(({ response }) => {
        if (response === 0 && this.window) {
          this.forceQuit = true;
          this.quitState = "approved";
          this.window.close();
        } else {
          this.quitState = "idle";
        }
      }).catch(() => {
        this.quitState = "idle";
      });
    }, 2500);
    return true;
  }

  clearQuitTimer() {
    if (this.quitTimer) clearTimeout(this.quitTimer);
    this.quitTimer = null;
    if (!this.forceQuit) this.quitState = "idle";
  }
}
