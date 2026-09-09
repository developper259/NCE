import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "path";

import { FileManager } from "./addon/FileManager";
import { Watcher } from "./addon/Watcher";
import { AppMenu } from "./addon/Menu";
import { ContextMenu } from "./addon/ContextMenu";
import { WorkspaceSearch } from "./addon/WorkspaceSearch";
import { App } from "./App";

const TITLEBAR_CONTROLS_HEIGHT = 35;

export function getWindowChromeConfig(
  platform: NodeJS.Platform = process.platform,
) {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset" as const,
      trafficLightPosition: { x: 14, y: 13 },
    };
  }
  return {
    titleBarStyle: "hidden" as const,
    titleBarOverlay: {
      color: "#181818",
      symbolColor: "#b8b8b8",
      height: TITLEBAR_CONTROLS_HEIGHT,
    },
  };
}

export class Window {
  window: InstanceType<typeof BrowserWindow> | null;
  fileManager: FileManager | undefined;
  appMenu: AppMenu | undefined;
  watcher: Watcher | undefined;
  contextMenu: ContextMenu | undefined;
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

    const appRoot = app.isPackaged
      ? app.getAppPath()
      : path.join(__dirname, "../..");
    const assetRoot = app.isPackaged ? appRoot : path.join(appRoot, "src");

    this.window = new BrowserWindow({
      width: 800,
      height: 600,
      minWidth: 800,
      minHeight: 600,
      title: this.app.name,
      show: false,
      backgroundColor: "#181818",
      ...getWindowChromeConfig(),
      icon: path.join(appRoot, "assets/logo/NCE/dark-logo.png"),

      webPreferences: {
        sandbox: true,

        preload: path.join(assetRoot, "js/main/Preload.js"),

        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    if (!this.fileManager) this.fileManager = new FileManager(this);
    if (!this.watcher) this.watcher = new Watcher(this.window);
    else this.watcher.setWindow(this.window);
    this.watcher.onChange = (filePath) => this.fileManager?.clearFileCache(filePath);
    if (!this.contextMenu) this.contextMenu = new ContextMenu(this.window);
    else this.contextMenu.window = this.window;
    if (!this.workspaceSearch) this.workspaceSearch = new WorkspaceSearch(this);

    this.appMenu = new AppMenu(this.window, this);

    this.window.loadFile(path.join(assetRoot, "html/index.html"));
    this.window.once("ready-to-show", () => {
      this.window?.maximize();
      this.window?.show();
    });

      this.window.webContents.on("console-message", (...args: any[]) => {
        const details = typeof args[1] === "object"
          ? args[1]
          : {
              level: args[1],
              message: args[2],
              lineNumber: args[3],
              sourceId: args[4],
            };
        if (details.level >= 2) {
          console.error(
            `[Renderer] ${details.message} (${details.sourceId}:${details.lineNumber})`,
          );
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
      if (url !== this.window?.webContents.getURL()) event.preventDefault();
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
      ipcMain.handle("App:command", async (_event, command) =>
        this.executeWindowCommand(command),
      );
      ipcMain.handle("App:setAutoSaveState", async (_event, enabled) => {
        if (typeof enabled !== "boolean") return false;
        this.appMenu?.setAutoSaveState(enabled);
        return true;
      });
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
      ipcMain.handle("NSH:getEndpoint", async () => this.app.nshEndpoint);

      this.fileManager.handleIPC();
      this.watcher.handleIPC();
      this.contextMenu.handleIPC();
      this.workspaceSearch.handleIPC();
      this.ipcRegistered = true;
    }
  }

  async executeWindowCommand(command: unknown) {
    if (!this.window || typeof command !== "string") return false;
    switch (command) {
      case "view.fullscreen":
        this.window.setFullScreen(!this.window.isFullScreen());
        return true;
      case "view.devtools":
        if (this.window.webContents.isDevToolsOpened())
          this.window.webContents.closeDevTools();
        else this.window.webContents.openDevTools();
        return true;
      case "help.about":
        await this.appMenu?.showAbout();
        return true;
      default:
        return false;
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
