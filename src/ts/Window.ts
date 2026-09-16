import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import path from "path";

import { FileManager } from "./addon/FileManager";
import { Watcher } from "./addon/Watcher";
import { AppMenu } from "./addon/Menu";
import { ContextMenu } from "./addon/ContextMenu";
import { WorkspaceSearch } from "./addon/WorkspaceSearch";
import { AgentProcessRunner } from "./addon/AgentProcessRunner";
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
  agentProcessRunner: AgentProcessRunner | undefined;
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
    this.agentProcessRunner = undefined;
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
        backgroundThrottling: false,
        
      },
    });

    // Let renderer KeyBindingManager own keyboard shortcuts regardless of
    // whether the custom editor output or a native input currently has focus.
    this.window.webContents.setIgnoreMenuShortcuts(true);

    if (!this.fileManager) this.fileManager = new FileManager(this);
    if (!this.watcher) this.watcher = new Watcher(this.window);
    else this.watcher.setWindow(this.window);
    this.watcher.onChange = (filePath) =>
      this.fileManager?.clearFileCache(filePath);
    if (!this.contextMenu) this.contextMenu = new ContextMenu(this.window);
    else this.contextMenu.window = this.window;
    if (!this.workspaceSearch) this.workspaceSearch = new WorkspaceSearch(this);
    if (!this.agentProcessRunner) this.agentProcessRunner = new AgentProcessRunner(this);

    this.appMenu = new AppMenu(this.window, this);

    this.window.loadFile(path.join(assetRoot, "html/index.html"));
    this.window.once("ready-to-show", () => {
      this.window?.maximize();
      this.window?.show();
    });

    this.window.webContents.on("console-message", (...args: any[]) => {
      const details =
        typeof args[1] === "object"
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
    this.window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL) => {
        console.error("[Renderer] did-fail-load", {
          errorCode,
          errorDescription,
          validatedURL,
        });
      },
    );
    this.window.webContents.on("render-process-gone", (_event, details) => {
      console.error("[Renderer] render-process-gone", details);
      this.rendererReady = false;
      this.clearQuitTimer();
    });
    this.window.webContents.on(
      "preload-error",
      (_event, preloadPath, error) => {
        console.error("[Renderer] preload-error", {
          preloadPath,
          message: error?.message,
        });
        this.rendererReady = false;
      },
    );

    this.window.webContents.toggleDevTools();

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

    if (!this.ipcRegistered) {
      ipcMain.handle("App:quit", async () => this.requestQuit());
      ipcMain.handle("App:command", async (_event, command) =>
        this.executeWindowCommand(command),
      );
      ipcMain.handle("Clipboard:readText", async () => clipboard.readText());
      ipcMain.handle("App:setIgnoreMenuShortcuts", async (_event, ignored) =>
        this.setMenuShortcutsIgnored(ignored),
      );
      ipcMain.handle("App:setActiveFileContext", async (_event, hasActiveFile) =>
        this.setActiveFileContext(hasActiveFile),
      );
      ipcMain.handle("App:setAutoSaveState", async (_event, enabled) => {
        if (typeof enabled !== "boolean") return false;
        const saved = await this.app.settings.set("files.autoSave", enabled);
        if (!saved) return false;
        this.appMenu?.setAutoSaveState(enabled);
        return true;
      });
      ipcMain.handle("Settings:getAll", async () => this.app.settings.getAll());
      ipcMain.handle("Settings:get", async (_event, key) =>
        typeof key === "string" ? this.app.settings.get(key) : undefined,
      );
      ipcMain.handle("Settings:set", async (_event, key, value) => {
        return this.setSetting(key, value);
      });
      ipcMain.handle("RecentFolders:getAll", async () =>
        this.app.recentFolders.getAll(),
      );
      ipcMain.handle("RecentFolders:add", async (_event, folderPath) =>
        this.addRecentFolder(folderPath),
      );
      ipcMain.handle("RecentFolders:remove", async (_event, folderPath) =>
        this.removeRecentFolder(folderPath),
      );
      ipcMain.handle("RecentFolders:clear", async () =>
        this.clearRecentFolders(),
      );
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
      this.agentProcessRunner.handleIPC();
      this.ipcRegistered = true;
    }
  }

  async setSetting(key: unknown, value: unknown) {
    if (typeof key !== "string") return false;
    const saved = await this.app.settings.set(key, value);
    if (!saved) return false;

    if (key === "files.autoSave") {
      this.appMenu?.setAutoSaveState(value === true);
    } else if (key.startsWith("keybindings.")) {
      this.appMenu?.refreshKeybindings();
    }
    return true;
  }

  async addRecentFolder(folderPath: unknown) {
    const saved = await this.app.recentFolders.add(folderPath);
    if (saved) this.refreshRecentFolders();
    return saved;
  }

  async removeRecentFolder(folderPath: unknown) {
    const saved = await this.app.recentFolders.remove(folderPath);
    if (saved) this.refreshRecentFolders();
    return saved;
  }

  async clearRecentFolders() {
    const saved = await this.app.recentFolders.clear();
    if (saved) this.refreshRecentFolders();
    return saved;
  }

  refreshRecentFolders() {
    const folders = this.app.recentFolders.getAll();
    this.appMenu?.refreshKeybindings();
    this.window?.webContents.send("recent-folders-changed", folders);
  }

  requestOpenRecentFolder(folderPath: string) {
    this.window?.webContents.send("open-recent-folder-requested", folderPath);
  }

  setMenuShortcutsIgnored(ignored: unknown) {
    if (!this.window || typeof ignored !== "boolean") return false;
    this.window.webContents.setIgnoreMenuShortcuts(ignored);
    return true;
  }

  setActiveFileContext(hasActiveFile: unknown) {
    if (typeof hasActiveFile !== "boolean") return false;
    this.appMenu?.setFileActionsEnabled(hasActiveFile);
    return true;
  }

  async executeWindowCommand(command: unknown) {
    if (!this.window || typeof command !== "string") return false;
    switch (command) {
      case "view.fullscreen":
        this.window.setFullScreen(!this.window.isFullScreen());
        return true;
      case "view.reload":
        this.window.webContents.reload();
        return true;
      case "help.about":
        await this.appMenu?.showAbout();
        return true;
      default:
        return false;
    }
  }

  requestQuit() {
    if (!this.window || this.forceQuit || this.quitState !== "idle")
      return false;
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
      dialog
        .showMessageBox(this.window, {
          type: "warning",
          buttons: ["Force Quit", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          message: "NCE is not responding.",
          detail: "Force quit may lose unsaved changes.",
        })
        .then(({ response }) => {
          if (response === 0 && this.window) {
            this.forceQuit = true;
            this.quitState = "approved";
            this.window.close();
          } else {
            this.quitState = "idle";
          }
        })
        .catch(() => {
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
