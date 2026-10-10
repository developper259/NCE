import { app, BrowserWindow, dialog } from "electron";
import fs from "node:fs";
import path from "node:path";
import { Window } from "./Window";
import { NSHServer } from "nsh/server";
import { SettingsManager } from "./manager/SettingsManager";
import { RecentFoldersManager } from "./manager/RecentFoldersManager";
import { AgentConversationStore } from "./manager/AgentConversationStore";
import { IpcRouter } from "./manager/IpcRouter";
import { WindowManager } from "./manager/WindowManager";
import { WindowSessionStore } from "./manager/WindowSessionStore";

function getPackageVersion() {
  try {
    const packagePath = path.join(app.getAppPath(), "package.json");
    const packageVersion = JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
    if (typeof packageVersion === "string" && packageVersion.trim()) return packageVersion;
  } catch {}
  return app.getVersion();
}

export class App {
  readonly ipcRouter: IpcRouter;
  windowManager!: WindowManager;
  windowSessionStore!: WindowSessionStore;
  nsh: NSHServer;
  nshEndpoint: { host: string; port: number } | null = null;
  nshStarting = false;
  nshStopping = false;
  isQuitting = false;
  settings!: SettingsManager;
  recentFolders!: RecentFoldersManager;
  agentConversations!: AgentConversationStore;
  name = "NCE";
  version = getPackageVersion();
  private quitPromise: Promise<boolean> | null = null;

  constructor() {
    const gotTheLock = app.requestSingleInstanceLock();
    if (!gotTheLock) {
      this.ipcRouter = new IpcRouter();
      this.nsh = new NSHServer({ host: "127.0.0.1", port: 0 });
      app.quit();
      return;
    }

    this.ipcRouter = new IpcRouter();
    this.nsh = new NSHServer({ host: "127.0.0.1", port: 0 });
    const userData = app.getPath("userData");
    this.settings = new SettingsManager(userData);
    this.recentFolders = new RecentFoldersManager(userData);
    this.agentConversations = new AgentConversationStore(userData);
    this.windowSessionStore = new WindowSessionStore(userData);
    this.windowManager = new WindowManager(this, this.ipcRouter, this.windowSessionStore);
    this.setupAppEvents();
  }

  /** Compatibility accessor for older main-process call sites. */
  get window(): Window | null {
    return this.windowManager?.getFocusedWindow() || this.windowManager?.getAllWindows()[0] || null;
  }

  setupAppEvents() {
    app.on("ready", async () => {
      await this.settings.initialize();
      await this.recentFolders.initialize();
      await this.agentConversations.initialize();
      await this.windowSessionStore.initialize();
      await this.startNsh();
      await this.windowManager.restoreSessions();
    });

    app.on("before-quit", (event) => {
      if (this.isQuitting) return;
      event.preventDefault();
      void this.requestQuitAll();
    });

    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") void this.requestQuitAll();
    });

    app.on("activate", () => {
      if (this.windowManager.getAllWindows().length === 0) {
        this.windowManager.createEmptyWindow();
      } else {
        this.windowManager.getFocusedWindow()?.window?.focus();
      }
    });

    app.on("second-instance", (_event, argv) => {
      void (async () => {
        for (const argument of argv.slice(1)) {
          if (!path.isAbsolute(argument) || argument.startsWith("--")) continue;
          const folder = await this.windowManager.resolveWorkspacePath(argument);
          if (!folder) continue;
          await this.windowManager.openWorkspaceInNewWindow(folder);
          return;
        }
        const focused = this.windowManager.getFocusedWindow() || this.windowManager.getAllWindows()[0];
        if (focused) this.windowManager.focusWindow(focused.id);
        else this.windowManager.createEmptyWindow();
      })();
    });

    app.on("will-quit", () => {
      this.ipcRouter.dispose();
      this.windowManager.dispose();
    });
  }

  async openFolderInNewWindow(): Promise<boolean> {
    const parent = this.windowManager.getFocusedWindow()?.window || BrowserWindow.getFocusedWindow();
    const result = parent
      ? await dialog.showOpenDialog(parent, { properties: ["openDirectory"] })
      : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return false;
    return this.windowManager.openWorkspaceInNewWindow(result.filePaths[0]);
  }

  broadcastToWindows(channel: string, payload: unknown): void {
    for (const window of this.windowManager?.getAllWindows() || []) {
      const target = window.window;
      if (!target || target.isDestroyed() || target.webContents.isDestroyed()) continue;
      try { target.webContents.send(channel, payload); }
      catch (error) { console.warn(`[App] Failed to broadcast ${channel}`, error); }
    }
    for (const window of this.windowManager?.getAllWindows() || []) {
      window.appMenu?.refreshKeybindings();
      if (channel === "settings-changed") {
        window.appMenu?.setAutoSaveState((payload as any)?.files?.autoSave === true);
      }
    }
  }

  async requestQuitAll(): Promise<boolean> {
    if (this.isQuitting) return true;
    if (this.quitPromise) return this.quitPromise;
    this.quitPromise = this.performQuitAll().finally(() => { this.quitPromise = null; });
    return this.quitPromise;
  }

  private async performQuitAll(): Promise<boolean> {
    const windows = this.windowManager.getAllWindows();
    const prepared: Window[] = [];
    for (const window of windows) {
      const approved = await window.prepareForApplicationQuit();
      if (!approved) {
        for (const preparedWindow of prepared) preparedWindow.cancelPreparedClose();
        return false;
      }
      prepared.push(window);
    }

    this.isQuitting = true;
    for (const window of prepared) this.windowManager.updateWindowState(window);
    for (const window of prepared) {
      const closed = await window.commitPreparedClose();
      if (!closed) {
        this.isQuitting = false;
        for (const remaining of prepared) remaining.cancelPreparedClose();
        return false;
      }
      await window.waitForDisposal();
    }
    await this.windowSessionStore.flush();
    await this.stopNsh();
    app.quit();
    return true;
  }

  async startNsh() {
    if (this.nshStarting || this.nshEndpoint) return this.nshEndpoint;
    this.nshStarting = true;
    try {
      const port = await this.nsh.start();
      this.nshEndpoint = { host: "127.0.0.1", port };
      return this.nshEndpoint;
    } catch (error) {
      console.error("[NSH] Failed to start syntax server", error);
      this.nshEndpoint = null;
      return null;
    } finally {
      this.nshStarting = false;
    }
  }

  async stopNsh() {
    if (this.nshStopping) return;
    this.nshStopping = true;
    try {
      if (this.nsh.getPort() !== null) await this.nsh.stop();
    } catch (error) {
      console.error("[NSH] Failed to stop syntax server", error);
    } finally {
      this.nshEndpoint = null;
    }
  }
}
