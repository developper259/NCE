import {
  app,
  BrowserWindow,
  clipboard,
  shell,
  type WebContents,
} from "electron";
import path from "path";
import { randomUUID } from "node:crypto";

import { FileManager } from "./addon/FileManager";
import { Watcher } from "./addon/Watcher";
import { AppMenu } from "./addon/Menu";
import { ContextMenu } from "./addon/ContextMenu";
import { WorkspaceSearch } from "./addon/WorkspaceSearch";
import { AgentApprovalManager } from "./addon/AgentApprovalManager";
import { AgentProcessRunner } from "./addon/AgentProcessRunner";
import { TerminalManager } from "./terminal/TerminalManager";
import { normalizeTerminalLink } from "./terminal/TerminalTypes";
import { App } from "./App";
import type { IpcHandlerRegistrar } from "./manager/IpcRouter";
import type { WindowSession } from "./manager/WindowSessionStore";

const TITLEBAR_CONTROLS_HEIGHT = 35;
const MACOS_TRAFFIC_LIGHT_SIZE = 14;
const MACOS_TRAFFIC_LIGHT_Y = Math.round(
  (TITLEBAR_CONTROLS_HEIGHT - MACOS_TRAFFIC_LIGHT_SIZE) / 2,
);
const RENDERER_DEV_URL = "http://127.0.0.1:5173/html/index.html";
const WINDOW_RELOAD_DELAY_MS = 50;
const WINDOW_CLOSE_RESPONSE_TIMEOUT_MS = 10_000;

export function getWindowChromeConfig(
  platform: NodeJS.Platform = process.platform,
) {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset" as const,
      trafficLightPosition: { x: 14, y: MACOS_TRAFFIC_LIGHT_Y },
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
  readonly id: string;
  readonly sessionId: string;
  readonly ipc: IpcHandlerRegistrar;
  readonly focusWhenReady: boolean;
  window: InstanceType<typeof BrowserWindow> | null;
  workspacePath: string | null;
  preserveSessionOnClose = false;
  fileManager: FileManager | undefined;
  appMenu: AppMenu | undefined;
  watcher: Watcher | undefined;
  contextMenu: ContextMenu | undefined;
  workspaceSearch: WorkspaceSearch | undefined;
  agentApprovalManager: AgentApprovalManager | undefined;
  agentProcessRunner: AgentProcessRunner | undefined;
  terminalManager: TerminalManager | undefined;
  app: App;
  forceQuit: boolean;
  rendererReady: boolean;
  reloadPending: boolean;
  quitState: "idle" | "waiting-renderer" | "prepared" | "approved";
  quitTimer: ReturnType<typeof setTimeout> | null;
  private quitRequestResolve: ((approved: boolean) => void) | null = null;
  private prepareQuitOnly = false;
  private boundsSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private resourceDisposal: Promise<void> = Promise.resolve();
  private readonly initialSession: WindowSession;

  constructor(
    app: App,
    options: {
      id?: string;
      session?: WindowSession;
      ipc?: IpcHandlerRegistrar;
      focusWhenReady?: boolean;
    } = {},
  ) {
    this.id = options.id || randomUUID();
    this.initialSession = options.session || {
      id: randomUUID(), workspacePath: null, bounds: null, maximized: false,
      rendererState: null, lastActiveAt: Date.now(),
    };
    this.sessionId = this.initialSession.id;
    this.workspacePath = this.initialSession.workspacePath;
    this.ipc = options.ipc || app?.ipcRouter?.forWindow?.(this.id) || { handle() {} };
    this.focusWhenReady = options.focusWhenReady !== false;
    this.window = null;
    this.app = app;
    this.forceQuit = false;
    this.rendererReady = false;
    this.reloadPending = false;
    this.quitState = "idle";
    this.quitTimer = null;
    this.agentApprovalManager = undefined;
    this.agentProcessRunner = undefined;
    this.terminalManager = undefined;
  }

  create() {
    this.forceQuit = false;
    this.rendererReady = false;
    this.reloadPending = false;
    this.quitState = "idle";

    const appRoot = app.isPackaged
      ? app.getAppPath()
      : path.join(__dirname, "../..");
    const assetRoot = app.isPackaged ? appRoot : path.join(appRoot, "src");

    const restoreBounds = this.app.windowManager?.getRestoreBounds(this.initialSession.bounds) || null;
    this.window = new BrowserWindow({
      ...(restoreBounds || { width: 1100, height: 720 }),
      minWidth: 800,
      minHeight: 600,
      title: this.getWindowTitle(),
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

    this.app.windowManager?.registerBrowserWindow(this, this.window);
    this.fileManager = new FileManager(this, undefined, this.ipc);
    this.watcher = new Watcher(this.window, this.ipc, {
      reserveWorkspace: (projectPath) => this.app.windowManager.reserveWorkspace(this.id, projectPath),
      releaseWorkspace: (projectPath) => this.app.windowManager.releaseWorkspace(this.id, projectPath),
    });
    this.terminalManager = new TerminalManager({
      getWorkspacePath: () => this.watcher?.getWatchedPath() || null,
      getShellSetting: () => this.app.settings.get("terminal.shell"),
      ipc: this.ipc,
    });
    const terminalOwner = this.window.webContents;
    this.terminalManager.attachOwner(terminalOwner);
    this.watcher.onChange = (filePath) =>
      this.fileManager?.clearFileCache(filePath);
    this.contextMenu = new ContextMenu(this.window, this.ipc);
    this.workspaceSearch = new WorkspaceSearch(this, this.ipc);
    this.watcher.onWorkspaceEvent = (event, filePath, rootPath) =>
      this.workspaceSearch?.workspaceIndex.handleWatcherEvent(
        rootPath,
        event,
        filePath,
      );
    this.watcher.onWatcherStop = (rootPath) =>
      this.workspaceSearch?.releaseWorkspace(rootPath);
    this.workspaceSearch.workspaceIndex.onReconciled = (rootPath, changedDirectories) => {
      const window = this.window;
      if (
        !window || window.isDestroyed() ||
        path.resolve(this.watcher?.getWatchedPath() || "") !== path.resolve(rootPath)
      ) return;
      window.webContents.send("file-system-change", [{
        event: "index-reconciled",
        filePath: rootPath,
        changedDirectories,
      }]);
    };
    this.workspaceSearch.workspaceIndex.onStatsUpdated = (stats) => {
      const window = this.window;
      if (
        !window || window.isDestroyed() ||
        path.resolve(this.watcher?.getWatchedPath() || "") !== path.resolve(stats.root)
      ) return;
      window.webContents.send("workspace-index-stats", stats);
    };
    this.agentApprovalManager = new AgentApprovalManager(this, this.ipc);
    this.agentProcessRunner = new AgentProcessRunner(this, this.ipc);

    this.appMenu = new AppMenu(this.window, this);
    if (this.initialSession.maximized) this.window.maximize();

    if (
      !app.isPackaged &&
      process.env.NCE_RENDERER_URL === RENDERER_DEV_URL
    ) {
      this.window.loadURL(RENDERER_DEV_URL);
    } else {
      this.window.loadFile(
        path.join(appRoot, "dist/renderer/html/index.html"),
      );
    }
    this.window.once("ready-to-show", () => {
      this.window?.show();
      if (this.focusWhenReady) this.window?.focus();
    });

    this.window.on("resize", () => this.scheduleBoundsSave());
    this.window.on("move", () => this.scheduleBoundsSave());
    this.registerIPC();

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
      this.reloadPending = false;
      this.agentApprovalManager?.cancelAll();
      this.terminalManager?.closeForOwner(terminalOwner, {
        deferProcessDisposal: true,
      });
      this.clearQuitTimer();
      this.preserveSessionOnClose = true;
      this.forceQuit = true;
      this.app.windowManager?.updateWindowState(this);
      this.window?.close();
    });
    this.window.webContents.on(
      "did-start-navigation",
      (_event, _url, _inPlace, isMainFrame) => {
        if (isMainFrame) {
          this.terminalManager?.closeForOwner(terminalOwner, {
            deferProcessDisposal: true,
          });
        }
      },
    );
    this.window.webContents.on("did-finish-load", () => {
      this.reloadPending = false;
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

    // this.window.webContents.toggleDevTools();

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
      void this.requestQuit();
    });

    this.window.on("closed", () => {
      this.clearQuitTimer();
      this.resourceDisposal = this.disposeWindowServices(terminalOwner);
      this.window = null;
    });
  }

  private registerIPC(): void {
    this.ipc.handle("App:quit", async () => this.app.requestQuitAll());
    this.ipc.handle("App:closeWindow", async () => this.requestQuit());
    this.ipc.handle("App:command", async (_event, command) => this.executeWindowCommand(command));
    this.ipc.handle("Clipboard:readText", async () => clipboard.readText());
    this.ipc.handle("Clipboard:writeText", async (_event, text) => {
      clipboard.writeText(String(text ?? ""));
      return true;
    });
    this.ipc.handle("App:setIgnoreMenuShortcuts", async (_event, ignored) =>
      this.setMenuShortcutsIgnored(ignored));
    this.ipc.handle("App:setActiveFileContext", async (_event, hasActiveFile, canCycleTabs) =>
      this.setActiveFileContext(hasActiveFile, canCycleTabs));
    this.ipc.handle("App:setAutoSaveState", async (_event, enabled) => {
      if (typeof enabled !== "boolean") return false;
      return this.setSetting("files.autoSave", enabled);
    });
    this.ipc.handle("Settings:getAll", async () => this.app.settings.getAll());
    this.ipc.handle("Settings:get", async (_event, key) =>
      typeof key === "string" ? this.app.settings.get(key) : undefined);
    this.ipc.handle("Settings:getPath", async () => this.app.settings.settingsPath);
    this.ipc.handle("Settings:set", async (_event, key, value) => this.setSetting(key, value));
    this.ipc.handle("Terminal:openExternalLink", async (event, rawUrl) => {
      if (!this.terminalManager?.ownsSender(event.sender)) return false;
      const url = normalizeTerminalLink(rawUrl);
      if (!url) return false;
      try { await shell.openExternal(url); return true; }
      catch (error) { console.error("[Terminal] Failed to open external link", error); return false; }
    });
    this.ipc.handle("RecentFolders:getAll", async () => this.app.recentFolders.getAll());
    this.ipc.handle("RecentFolders:add", async (_event, folderPath) => this.addRecentFolder(folderPath));
    this.ipc.handle("RecentFolders:remove", async (_event, folderPath) => this.removeRecentFolder(folderPath));
    this.ipc.handle("RecentFolders:clear", async () => this.clearRecentFolders());
    this.ipc.handle("App:rendererReady", async () => {
      this.rendererReady = true;
      return true;
    });
    this.ipc.handle("App:approveQuit", async (_event, options) => {
      return this.approveQuit(options?.prepareOnly === true);
    });
    this.ipc.handle("App:cancelQuit", async () => this.cancelQuitRequest());
    this.ipc.handle("Window:focusWorkspace", async (_event, folderPath) =>
      this.app.windowManager.focusWorkspace(folderPath, this.id));
    this.ipc.handle("Window:openWorkspaceInNewWindow", async (_event, folderPath) =>
      this.app.windowManager.openWorkspaceInNewWindow(folderPath));
    this.ipc.handle("NSH:getEndpoint", async () => this.app.nshEndpoint);
    this.ipc.handle("AgentConversations:status", async () =>
      this.app.agentConversations?.getStatus() || { available: false, reason: "STORE_ERROR" });
    this.ipc.handle("AgentConversations:load", async () =>
      this.app.agentConversations?.load() || { status: { available: false, reason: "STORE_ERROR" }, activeSessionId: null, sessionIds: [], sessions: [] });
    this.ipc.handle("AgentConversations:save", async (_event, snapshot) =>
      this.app.agentConversations?.save(snapshot) || false);
    this.ipc.handle("AgentConversations:delete", async (_event, sessionId, activeId) =>
      this.app.agentConversations?.delete(sessionId, activeId) || false);
    this.ipc.handle("AgentConversations:setActive", async (_event, sessionId) =>
      this.app.agentConversations?.setActive(sessionId) || false);
    this.ipc.handle("AgentConversations:flush", async () =>
      this.app.agentConversations?.flush() || false);

    this.fileManager?.handleIPC();
    this.watcher?.handleIPC();
    this.contextMenu?.handleIPC();
    this.workspaceSearch?.handleIPC();
    this.agentApprovalManager?.handleIPC();
    this.agentProcessRunner?.handleIPC();
    this.terminalManager?.registerIPC();
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
    const settings = this.app.settings.getAll?.();
    if (typeof this.app.broadcastToWindows === "function") {
      this.app.broadcastToWindows("settings-changed", settings);
    } else if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send("settings-changed", settings);
    }
    return true;
  }

  async reloadSettingsFromDisk(filePath: string) {
    if (path.resolve(filePath) !== path.resolve(this.app.settings.settingsPath)) {
      return false;
    }
    const settings = await this.app.settings.reload();
    if (!settings) return false;
    this.app.broadcastToWindows("settings-changed", settings);
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
    this.app.broadcastToWindows("recent-folders-changed", folders);
  }

  requestOpenRecentFolder(folderPath: string) {
    void this.app.windowManager.focusWorkspace(folderPath, this.id).then((focused) => {
      if (!focused && this.window && !this.window.isDestroyed())
        this.window.webContents.send("open-recent-folder-requested", folderPath);
    });
  }

  setMenuShortcutsIgnored(ignored: unknown) {
    if (!this.window || typeof ignored !== "boolean") return false;
    this.window.webContents.setIgnoreMenuShortcuts(ignored);
    return true;
  }

  setActiveFileContext(hasActiveFile: unknown, canCycleTabs?: unknown) {
    if (typeof hasActiveFile !== "boolean") return false;
    this.appMenu?.setFileActionsEnabled(hasActiveFile);
    if (typeof canCycleTabs === "boolean")
      this.appMenu?.setTabCyclingEnabled(canCycleTabs);
    return true;
  }

  async executeWindowCommand(command: unknown) {
    if (!this.window || typeof command !== "string") return false;
    switch (command) {
      case "window.new":
        return Boolean(this.app.windowManager.createEmptyWindow());
      case "window.openFolderInNew":
        return this.app.openFolderInNewWindow();
      case "window.close":
        return this.requestQuit();
      case "window.quit":
        return this.app.requestQuitAll();
      case "view.fullscreen":
        this.window.setFullScreen(!this.window.isFullScreen());
        return true;
      case "view.reload":
        return this.reloadWindow();
      case "help.about":
        await this.appMenu?.showAbout();
        return true;
      default:
        return false;
    }
  }

  getWindowTitle(): string {
    const projectName = this.workspacePath ? path.basename(this.workspacePath) : "";
    return projectName ? `${this.app.name} — ${projectName}` : this.app.name;
  }

  setWorkspacePath(workspacePath: string | null): void {
    this.workspacePath = workspacePath;
    this.window?.setTitle(this.getWindowTitle());
    this.app.windowSessionStore?.update(this.sessionId, { workspacePath });
  }

  private scheduleBoundsSave(): void {
    if (this.boundsSaveTimer) clearTimeout(this.boundsSaveTimer);
    this.boundsSaveTimer = setTimeout(() => {
      this.boundsSaveTimer = null;
      this.app.windowManager?.updateWindowState(this);
    }, 300);
  }

  async dispose(): Promise<void> {
    if (this.boundsSaveTimer) clearTimeout(this.boundsSaveTimer);
    this.boundsSaveTimer = null;
    this.clearQuitTimer();
    const owner = this.window?.webContents;
    await this.disposeWindowServices(owner);
  }

  async waitForDisposal(): Promise<void> {
    const target = this.window;
    if (!target) return this.resourceDisposal;
    await new Promise<void>((resolve) => {
      target.once("closed", () => resolve());
    });
    await this.resourceDisposal;
  }

  private async disposeWindowServices(owner?: WebContents): Promise<void> {
    this.agentApprovalManager?.cancelAll();
    this.agentProcessRunner?.dispose();
    if (owner) this.terminalManager?.closeForOwner(owner);
    await this.watcher?.dispose();
    await this.workspaceSearch?.dispose();
    this.fileManager?.clearFileCache();
  }

  reloadWindow() {
    const targetWindow = this.window;
    const webContents = targetWindow?.webContents;
    if (
      !targetWindow ||
      !webContents ||
      targetWindow.isDestroyed() ||
      webContents.isDestroyed() ||
      this.reloadPending
    ) {
      return false;
    }

    this.reloadPending = true;
    const wasRendererReady = this.rendererReady;
    this.rendererReady = false;
    setTimeout(() => {
      if (
        this.window !== targetWindow ||
        targetWindow.isDestroyed() ||
        webContents.isDestroyed()
      ) {
        this.reloadPending = false;
        return;
      }

      try {
        webContents.reload();
      } catch (error) {
        this.reloadPending = false;
        this.rendererReady = wasRendererReady;
        console.error("[Main] Failed to reload window", error);
      }
    }, WINDOW_RELOAD_DELAY_MS);
    return true;
  }

  requestQuit(prepareOnly = false): Promise<boolean> {
    if (this.quitState === "prepared") return Promise.resolve(true);
    if (!this.window || this.forceQuit || this.quitState !== "idle") return Promise.resolve(false);
    this.prepareQuitOnly = prepareOnly;
    if (!this.rendererReady || this.window.webContents.isDestroyed()) {
      if (prepareOnly) {
        this.quitState = "prepared";
        return Promise.resolve(true);
      }
      this.forceQuit = true;
      this.app.windowManager?.updateWindowState(this);
      this.terminalManager?.closeForOwner(this.window.webContents);
      this.window.close();
      return Promise.resolve(true);
    }

    this.quitState = "waiting-renderer";
    return new Promise<boolean>((resolve) => {
      this.quitRequestResolve = resolve;
      this.window!.webContents.send("Request:saveState", { prepareOnly });
      this.quitTimer = setTimeout(() => {
        this.quitTimer = null;
        const target = this.window;
        if (this.quitState !== "waiting-renderer" || !target) return;
        console.warn("[Window] Renderer did not acknowledge close; keeping the window open.");
        this.quitState = "idle";
        this.prepareQuitOnly = false;
        this.resolveQuitRequest(false);
      }, WINDOW_CLOSE_RESPONSE_TIMEOUT_MS);
    });
  }

  prepareForApplicationQuit(): Promise<boolean> {
    return this.requestQuit(true);
  }

  approveQuit(prepareOnly = false): boolean {
    if (this.quitState !== "waiting-renderer") return false;
    this.clearQuitTimer();
    if (prepareOnly || this.prepareQuitOnly) {
      this.quitState = "prepared";
      this.resolveQuitRequest(true);
      return true;
    }
    this.finishClose();
    return true;
  }

  cancelQuitRequest(): boolean {
    if (this.quitState !== "waiting-renderer") return false;
    this.clearQuitTimer();
    this.quitState = "idle";
    this.resolveQuitRequest(false);
    return true;
  }

  commitPreparedClose(): Promise<boolean> {
    if (this.quitState !== "prepared") return Promise.resolve(false);
    if (!this.window || this.window.isDestroyed() || this.window.webContents.isDestroyed() || !this.rendererReady) {
      this.forceQuit = true;
      this.finishClose();
      return Promise.resolve(true);
    }
    this.quitState = "waiting-renderer";
    this.prepareQuitOnly = false;
    return new Promise((resolve) => {
      this.quitRequestResolve = resolve;
      this.window!.webContents.send("Request:commitClose");
      this.quitTimer = setTimeout(() => {
        if (this.quitState !== "waiting-renderer") return;
        this.forceQuit = true;
        this.finishClose();
      }, 2500);
    });
  }

  cancelPreparedClose(): void {
    if (this.quitState !== "prepared") return;
    this.quitState = "idle";
    this.prepareQuitOnly = false;
  }

  private finishClose(): void {
    this.clearQuitTimer();
    this.quitState = "approved";
    this.forceQuit = true;
    this.app.windowManager?.updateWindowState(this);
    const owner = this.window?.webContents;
    if (owner) this.terminalManager?.closeForOwner(owner);
    this.window?.close();
    this.resolveQuitRequest(true);
  }

  private resolveQuitRequest(approved: boolean): void {
    const resolve = this.quitRequestResolve;
    this.quitRequestResolve = null;
    resolve?.(approved);
  }

  clearQuitTimer() {
    if (this.quitTimer) clearTimeout(this.quitTimer);
    this.quitTimer = null;
    if (!this.forceQuit) this.quitState = "idle";
  }
}
