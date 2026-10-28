import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  shell,
  type IpcMainInvokeEvent,
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
import { PathAccess } from "./manager/PathAccess";
import { TITLEBAR_OVERLAY_THEME } from "./manager/TitleBarTheme";
import type { WindowSession } from "./manager/WindowSessionStore";
import type { DeliveredFileResult, ExternalOpenResult } from "./manager/ExternalOpenCoordinator";

const TITLEBAR_CONTROLS_HEIGHT = 35;
const MACOS_TRAFFIC_LIGHT_SIZE = 14;
const MACOS_TRAFFIC_LIGHT_Y = Math.round(
  (TITLEBAR_CONTROLS_HEIGHT - MACOS_TRAFFIC_LIGHT_SIZE) / 2,
);
const RENDERER_DEV_URL = "http://127.0.0.1:5173/html/index.html";
const WINDOW_RELOAD_DELAY_MS = 50;
const WINDOW_CLOSE_RESPONSE_TIMEOUT_MS = 10_000;
export const EXTERNAL_OPEN_TIMEOUTS_MS = Object.freeze({
  rendererReady: 90_000,
  acknowledgement: 120_000,
});
const AGENT_MODEL_ENDPOINTS: Record<
  string,
  { urls: string[]; requiresApiKey: boolean }
> = {
  modalQwen: {
    urls: ["https://trolleur-belvedere--nce-coder-serve.modal.run/v1/chat/completions"],
    requiresApiKey: false,
  },
  opencode: {
    urls: [
      "https://opencode.ai/zen/go/v1/chat/completions",
      "https://opencode.ai/zen/go/v1/responses",
    ],
    requiresApiKey: true,
  },
  openrouter: {
    urls: ["https://openrouter.ai/api/v1/chat/completions"],
    requiresApiKey: true,
  },
};

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
      ...TITLEBAR_OVERLAY_THEME.dark,
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
  readonly pathAccess: PathAccess;
  private readonly activeAgentModelRequests = new Map<string, AbortController>();
  app: App;
  forceQuit: boolean;
  rendererReady: boolean;
  reloadPending: boolean;
  quitState: "idle" | "preparing" | "prepared" | "committing" | "committed" |
    "rolling-back" | "closing" | "closed" | "cancelled" | "failed";
  quitTimer: ReturnType<typeof setTimeout> | null;
  private quitRequestResolve: ((approved: boolean) => void) | null = null;
  private prepareQuitOnly = false;
  private commitAttempted = false;
  private rendererCommitSkipped = false;
  private activeQuitRequestId: string | null = null;
  private rendererGone = false;
  private closed = false;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;
  private boundsSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private resourceDisposal: Promise<void> = Promise.resolve();
  private readonly initialSession: WindowSession;
  private readonly pendingExternalOpenDeliveries = new Map<string, {
    paths: string[];
    sent: boolean;
    attempt: number;
    timer: ReturnType<typeof setTimeout>;
    resolve: (result: DeliveredFileResult) => void;
  }>();
  private readonly pendingExternalOpenResults: ExternalOpenResult[] = [];

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
      fullScreen: false, rendererState: null, authorizedFiles: [], lastActiveAt: Date.now(),
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
    this.closedPromise = new Promise((resolve) => { this.resolveClosed = resolve; });
    this.agentApprovalManager = undefined;
    this.agentProcessRunner = undefined;
    this.terminalManager = undefined;
    this.pathAccess = new PathAccess(
      () => this.watcher?.getWatchedPath?.() || this.workspacePath,
      process.platform,
      this.initialSession.authorizedFiles,
    );
    if (this.initialSession.workspacePath)
      this.pathAccess.trustRootSync(this.initialSession.workspacePath);
    for (const folder of this.app.recentFolders?.getAll?.() || [])
      this.pathAccess.trustRootSync(folder);
    if (this.app.settings?.settingsPath)
      void this.pathAccess.authorizeFile(this.app.settings.settingsPath);
  }

  create() {
    this.forceQuit = false;
    this.rendererReady = false;
    this.reloadPending = false;
    this.quitState = "idle";
    this.rendererGone = false;

    const appRoot = app.isPackaged
      ? app.getAppPath()
      : path.join(__dirname, "../..");
    const assetRoot = app.isPackaged ? appRoot : path.join(appRoot, "src");

    const restoreBounds = this.app.windowManager?.getRestoreBounds(this.initialSession.bounds) || null;
    this.window = new BrowserWindow({
      ...(restoreBounds || { width: 1100, height: 720 }),
      minWidth: Math.min(800, restoreBounds?.width || 800),
      minHeight: Math.min(600, restoreBounds?.height || 600),
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
        backgroundThrottling: true,
      },
    });

    // Let renderer KeyBindingManager own keyboard shortcuts regardless of
    // whether the custom editor output or a native input currently has focus.
    this.window.webContents.setIgnoreMenuShortcuts(true);

    this.app.windowManager?.registerBrowserWindow(this, this.window);
    this.fileManager = new FileManager(this, undefined, this.ipc);
    this.watcher = new Watcher(this.window, this.ipc, {
      reserveWorkspace: (projectPath) => this.app.windowManager.reserveWorkspace(this.id, projectPath),
      commitWorkspace: (projectPath, _previousPath, token) =>
        this.app.windowManager.commitWorkspace(this.id, projectPath, token),
      releaseWorkspace: (projectPath, updateWindow, token) =>
        this.app.windowManager.releaseWorkspace(this.id, projectPath, updateWindow, token),
      isWorkspaceAllowed: (projectPath) =>
        this.pathAccess.isAuthorized(projectPath, { requireDirectory: true }),
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
    if (this.initialSession.fullScreen) this.window.setFullScreen(true);

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
    const reportWindowActivity = (active: boolean) => {
      const target = this.window;
      if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return;
      try { target.webContents.send("Window:activity", active); } catch {}
    };
    this.window.on("focus", () => reportWindowActivity(true));
    this.window.on("blur", () => reportWindowActivity(false));
    this.window.on("enter-full-screen", () => this.scheduleBoundsSave());
    this.window.on("leave-full-screen", () => this.scheduleBoundsSave());
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
      this.rendererGone = true;
      this.failPendingExternalOpenDeliveries("The editor closed before confirming these files.");
      this.reloadPending = false;
      this.agentApprovalManager?.cancelAll();
      this.terminalManager?.closeForOwner(terminalOwner, {
        deferProcessDisposal: true,
      });
      this.clearQuitTimer();
      this.preserveSessionOnClose = true;
      this.quitState = "failed";
      this.resolveQuitRequest(false);
      this.app.windowManager?.updateWindowState(this);
      this.forceCloseAfterRendererGone();
    });
    this.window.webContents.on(
      "did-start-navigation",
      (_event, _url, _inPlace, isMainFrame) => {
        if (isMainFrame) {
          this.rendererReady = false;
          for (const [requestId, delivery] of this.pendingExternalOpenDeliveries) {
            delivery.sent = false;
            this.armExternalOpenDeliveryTimeout(
              requestId,
              delivery,
              EXTERNAL_OPEN_TIMEOUTS_MS.rendererReady,
            );
          }
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
      this.closed = true;
      this.quitState = "closed";
      this.failPendingExternalOpenDeliveries("The target NCE window was closed before the files were opened.");
      this.resolveQuitRequest(false);
      this.resolveClosed();
      this.resourceDisposal = this.disposeWindowServices(terminalOwner);
      this.window = null;
    });
  }

  private registerIPC(): void {
    this.ipc.handle("App:quit", async () => this.app.requestQuitAll());
    this.ipc.handle("App:closeWindow", async () => this.requestQuit());
    this.ipc.handle("App:command", async (_event, command) => this.executeWindowCommand(command));
    this.ipc.handle("Clipboard:readText", async () => {
      if (!this.window || this.window.isDestroyed() || !this.window.isFocused())
        return "";
      return clipboard.readText();
    });
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
    this.ipc.handle("RecentFolders:add", async (_event, folderPath) => {
      if (!(await this.pathAccess.isAuthorized(folderPath, { requireDirectory: true })))
        return false;
      return this.addRecentFolder(folderPath);
    });
    this.ipc.handle("RecentFolders:remove", async (_event, folderPath) => this.removeRecentFolder(folderPath));
    this.ipc.handle("RecentFolders:clear", async () => this.clearRecentFolders());
    this.ipc.handle("App:rendererReady", async () => {
      this.rendererReady = true;
      this.flushExternalOpenDeliveries();
      this.flushExternalOpenResults();
      return true;
    });
    this.ipc.handle("ExternalOpen:drop", async (event, paths) => {
      const target = this.app.windowManager.getWindowByWebContents(event.sender);
      if (!target || target !== this || !this.window || this.window.isDestroyed()) {
        return {
          success: false,
          openedFiles: 0,
          openedFolders: 0,
          focusedFolders: 0,
          failures: [{ path: "", code: "WINDOW_UNAVAILABLE", message: "The drop target window is no longer available." }],
        } satisfies ExternalOpenResult;
      }
      const authorized = await this.confirmDroppedPaths(paths);
      if (!authorized) {
        return {
          success: false,
          openedFiles: 0,
          openedFolders: 0,
          focusedFolders: 0,
          failures: [],
        } satisfies ExternalOpenResult;
      }
      return this.app.externalOpenCoordinator.enqueueDrop(authorized, target);
    });
    this.ipc.handle("ExternalOpen:ack", async (_event, requestId, attempt, rawResult) =>
      this.acknowledgeExternalOpen(requestId, attempt, rawResult));
    this.ipc.handle("ExternalOpen:progress", async (_event, requestId, attempt) =>
      this.noteExternalOpenProgress(requestId, attempt));
    this.ipc.handle("App:approveQuit", async (_event, options) => {
      return this.approveQuit(
        options?.prepareOnly === true,
        options?.requestId,
        options?.commit === true,
        options?.rollback === true,
      );
    });
    this.ipc.handle("App:cancelQuit", async (_event, requestId) => this.cancelQuitRequest(requestId));
    this.ipc.handle("App:restoreAfterCancelledQuit", async (_event, requestId) =>
      this.finishRollback(requestId, true));
    this.ipc.handle("App:failedToRestoreAfterCancelledQuit", async (_event, requestId) =>
      this.finishRollback(requestId, false));
    this.ipc.handle("Window:focusWorkspace", async (_event, folderPath) =>
      this.app.windowManager.focusWorkspace(folderPath, this.id));
    this.ipc.handle("Window:openWorkspaceInNewWindow", async (_event, folderPath) => {
      if (!(await this.pathAccess.isAuthorized(folderPath, { requireDirectory: true })))
        return false;
      return this.app.windowManager.openWorkspaceInNewWindow(folderPath);
    });
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
    this.ipc.handle("Agent:aiChat", async (event, request) =>
      this.requestAgentModel(event, request));
    this.ipc.handle("Agent:cancelModelRequest", async (event, requestId) =>
      this.cancelAgentModelRequest(event, requestId));

    this.fileManager?.handleIPC();
    this.watcher?.handleIPC();
    this.contextMenu?.handleIPC();
    this.workspaceSearch?.handleIPC();
    this.agentApprovalManager?.handleIPC();
    this.agentProcessRunner?.handleIPC();
    this.terminalManager?.registerIPC();
  }

  private async confirmDroppedPaths(paths: unknown): Promise<string[] | null> {
    if (!Array.isArray(paths)) return null;
    const candidates = paths.filter((value): value is string =>
      typeof value === "string" && Boolean(value.trim()) && !value.includes("\0"));
    if (!candidates.length) return [];
    const dialogApi = dialog as typeof dialog | undefined;
    if (this.window && typeof dialogApi?.showMessageBox === "function") {
      const visible = candidates.slice(0, 8).join("\n");
      const more = candidates.length > 8
        ? `\n… ${candidates.length - 8} more`
        : "";
      const result = await dialogApi.showMessageBox(this.window, {
        type: "question",
        buttons: ["Open", "Cancel"],
        defaultId: 0,
        cancelId: 1,
        message: "Open dropped items?",
        detail: `${visible}${more}`,
      });
      if (result?.response !== 0) return null;
    }
    const authorized: string[] = [];
    for (const candidate of candidates)
      if (await this.pathAccess.authorizeExternal(candidate))
        authorized.push(candidate);
    return authorized;
  }

  async deliverExternalFiles(paths: string[]): Promise<DeliveredFileResult> {
    await Promise.all(paths.map((filePath) =>
      this.pathAccess.authorizeExternal(filePath)));
    const target = this.window;    if (!target || target.isDestroyed() || target.webContents.isDestroyed()) {
      return Promise.resolve({
        openedPaths: [],
        failures: paths.map((filePath) => ({
          path: filePath,
          message: "The target NCE window is no longer available.",
        })),
      });
    }
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timeoutMs = this.rendererReady
        ? EXTERNAL_OPEN_TIMEOUTS_MS.acknowledgement
        : EXTERNAL_OPEN_TIMEOUTS_MS.rendererReady;
      const timer = setTimeout(
        () => this.expireExternalOpenDelivery(requestId),
        timeoutMs,
      );
      this.pendingExternalOpenDeliveries.set(requestId, {
        paths: [...paths],
        sent: false,
        attempt: 0,
        timer,
        resolve,
      });
      this.flushExternalOpenDeliveries();
    });
  }

  notifyExternalOpenResult(result: ExternalOpenResult): void {
    const target = this.window;
    if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return;
    if (!this.rendererReady) {
      if (this.pendingExternalOpenResults.length >= 8) this.pendingExternalOpenResults.shift();
      this.pendingExternalOpenResults.push(result);
      return;
    }
    try { target.webContents.send("ExternalOpen:result", result); }
    catch (error) { console.warn("[External Open] Failed to report open result", error); }
  }

  private flushExternalOpenResults(): void {
    const target = this.window;
    if (!this.rendererReady || !target || target.isDestroyed() || target.webContents.isDestroyed()) return;
    const results = this.pendingExternalOpenResults.splice(0);
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      try { target.webContents.send("ExternalOpen:result", result); }
      catch (error) {
        console.warn("[External Open] Failed to report queued open result", error);
        this.pendingExternalOpenResults.unshift(...results.slice(index));
        break;
      }
    }
  }

  private flushExternalOpenDeliveries(): void {
    const target = this.window;
    if (!this.rendererReady || !target || target.isDestroyed() || target.webContents.isDestroyed()) return;
    for (const [requestId, delivery] of this.pendingExternalOpenDeliveries) {
      if (delivery.sent) continue;
      try {
        delivery.attempt += 1;
        target.webContents.send("ExternalOpen:files", {
          requestId,
          attempt: delivery.attempt,
          paths: delivery.paths,
        });
        delivery.sent = true;
        this.armExternalOpenDeliveryTimeout(
          requestId,
          delivery,
          EXTERNAL_OPEN_TIMEOUTS_MS.acknowledgement,
        );
      } catch (error) {
        console.warn("[External Open] Failed to send files to renderer", error);
      }
    }
  }

  private noteExternalOpenProgress(requestId: unknown, attempt: unknown): boolean {
    if (typeof requestId !== "string" || !Number.isSafeInteger(attempt)) return false;
    const delivery = this.pendingExternalOpenDeliveries.get(requestId);
    if (!delivery || attempt !== delivery.attempt || !delivery.sent) return false;
    this.armExternalOpenDeliveryTimeout(
      requestId,
      delivery,
      EXTERNAL_OPEN_TIMEOUTS_MS.acknowledgement,
    );
    return true;
  }

  private acknowledgeExternalOpen(requestId: unknown, attempt: unknown, rawResult: unknown): boolean {
    if (typeof requestId !== "string" || !Number.isSafeInteger(attempt)) return false;
    const delivery = this.pendingExternalOpenDeliveries.get(requestId);
    if (!delivery || attempt !== delivery.attempt || !delivery.sent) return false;
    const payload = rawResult && typeof rawResult === "object" ? rawResult as Record<string, unknown> : {};
    const openedCandidates = Array.isArray(payload.openedPaths)
      ? payload.openedPaths.filter((value): value is string => typeof value === "string")
      : [];
    const failureCandidates = Array.isArray(payload.failures)
      ? payload.failures.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const item = value as Record<string, unknown>;
        return typeof item.path === "string" && typeof item.message === "string"
          ? [{ path: item.path, message: item.message }]
          : [];
      })
      : [];
    const openedSet = new Set(openedCandidates);
    const failuresByPath = new Map(failureCandidates.map((item) => [item.path, item.message]));
    const openedPaths: string[] = [];
    const failures: Array<{ path: string; message: string }> = [];
    for (const filePath of delivery.paths) {
      if (openedSet.has(filePath)) openedPaths.push(filePath);
      else failures.push({
        path: filePath,
        message: failuresByPath.get(filePath) || "The editor did not confirm that this file was opened.",
      });
    }
    this.settleExternalOpenDelivery(requestId, { openedPaths, failures });
    return true;
  }

  private settleExternalOpenDelivery(requestId: string, result: DeliveredFileResult): void {
    const delivery = this.pendingExternalOpenDeliveries.get(requestId);
    if (!delivery) return;
    clearTimeout(delivery.timer);
    this.pendingExternalOpenDeliveries.delete(requestId);
    delivery.resolve(result);
  }

  /**
   * Each acknowledgement or progress report re-arms an inactivity timeout, so a
   * large but steadily progressing batch is never mistaken for a stalled one.
   */
  private armExternalOpenDeliveryTimeout(
    requestId: string,
    delivery: { timer: ReturnType<typeof setTimeout> },
    timeoutMs: number,
  ): void {
    clearTimeout(delivery.timer);
    delivery.timer = setTimeout(
      () => this.expireExternalOpenDelivery(requestId),
      timeoutMs,
    );
  }

  private expireExternalOpenDelivery(requestId: string): void {
    const delivery = this.pendingExternalOpenDeliveries.get(requestId);
    if (!delivery) return;
    this.settleExternalOpenDelivery(requestId, {
      openedPaths: [],
      failures: delivery.paths.map((filePath) => ({
        path: filePath,
        message: "The editor did not confirm that this file was opened.",
      })),
    });
  }

  private failPendingExternalOpenDeliveries(message: string): void {
    for (const [requestId, delivery] of this.pendingExternalOpenDeliveries) {
      this.settleExternalOpenDelivery(requestId, {
        openedPaths: [],
        failures: delivery.paths.map((filePath) => ({ path: filePath, message })),
      });
    }
  }

  private async requestAgentModel(
    event: IpcMainInvokeEvent,
    request: unknown,
  ): Promise<unknown> {
    const failure = (message: string, code: string, status?: number) => ({
      success: false,
      ...(status ? { status } : {}),
      error: { message, code },
    });
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      return failure("Invalid Agent model request.", "INVALID_REQUEST");
    }
    const input = request as Record<string, unknown>;
    const provider = input.provider;
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
      return failure("Invalid Agent model provider.", "INVALID_PROVIDER");
    }
    const providerConfig = provider as Record<string, unknown>;
    const providerId = providerConfig.id;
    const endpoint = typeof providerId === "string"
      ? AGENT_MODEL_ENDPOINTS[providerId]
      : undefined;
    const requestedEndpoint = input.endpoint;
    const configuredEndpoint = input.apiFormat === "responses"
      ? providerConfig.responsesBaseURL || providerConfig.baseURL
      : providerConfig.baseURL;
    if (typeof providerId !== "string" || !endpoint ||
        !endpoint.urls.includes(String(providerConfig.baseURL)) ||
        typeof requestedEndpoint !== "string" ||
        !endpoint.urls.includes(requestedEndpoint) ||
        configuredEndpoint !== requestedEndpoint ||
        (input.apiFormat !== "responses" && input.apiFormat !== "chat-completions")) {
      return failure("The Agent model provider is not allowed.", "INVALID_PROVIDER");
    }
    if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
      return failure("Invalid Agent model payload.", "INVALID_REQUEST");
    }
    if (typeof input.requestId !== "string" ||
        input.requestId.length < 1 || input.requestId.length > 256) {
      return failure("Invalid Agent model request ID.", "INVALID_REQUEST");
    }

    const requestKey = `${event.sender.id}:${input.requestId}`;
    if (this.activeAgentModelRequests.has(requestKey)) {
      return failure("Duplicate Agent model request ID.", "INVALID_REQUEST");
    }
    const controller = new AbortController();
    this.activeAgentModelRequests.set(requestKey, controller);
    const onSenderDestroyed = () => controller.abort();
    event.sender.once("destroyed", onSenderDestroyed);
    const timeout = setTimeout(() => controller.abort(), 65_000);

    try {
      const apiKey = await this.app.agentSecrets?.get(providerId) || "";
      if (endpoint.requiresApiKey && !apiKey) {
        return failure("The provider API key is not configured.", "AUTH_ERROR", 401);
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": providerId === "opencode"
          ? "nce-agent/0.1.0"
          : "nce-agent/0.0.1",
      };
      const requestHeaders = providerConfig.requestHeaders;
      if (requestHeaders && typeof requestHeaders === "object" && !Array.isArray(requestHeaders)) {
        for (const [name, value] of Object.entries(requestHeaders)) {
          if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) ||
              ["authorization", "content-type", "host", "content-length"].includes(name.toLowerCase()) ||
              (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") ||
              /[\r\n]/.test(String(value))) continue;
          headers[name] = String(value);
        }
      }
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const sessionHeader = providerConfig.sessionHeader;
      if (typeof sessionHeader === "string" &&
          /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(sessionHeader) &&
          typeof input.sessionId === "string" && input.sessionId.length > 0 &&
          input.sessionId.length <= 256 && !/[\r\n]/.test(input.sessionId)) {
        headers[sessionHeader] = input.sessionId;
      }

      const response = await fetch(requestedEndpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(input.payload),
        signal: controller.signal,
      });
      const responseText = await response.text();
      let body: unknown = responseText;
      try {
        body = responseText ? JSON.parse(responseText) : null;
      } catch {}

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        responseHeaders[name] = value;
      });
      const responseInfo = {
        status: response.status,
        headers: responseHeaders,
      };
      if (!response.ok) {
        const providerError = body && typeof body === "object" && "error" in body
          ? (body as Record<string, unknown>).error
          : body;
        return {
          success: false,
          status: response.status,
          error: providerError || {
            message: `Model request failed (${response.status})`,
          },
          body,
          response: responseInfo,
        };
      }
      return body;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code || "")
        : "NETWORK_ERROR";
      return {
        success: false,
        error: { message, code: code || "NETWORK_ERROR" },
      };
    } finally {
      clearTimeout(timeout);
      event.sender.removeListener("destroyed", onSenderDestroyed);
      this.activeAgentModelRequests.delete(requestKey);
    }
  }

  private cancelAgentModelRequest(
    event: IpcMainInvokeEvent,
    requestId: unknown,
  ): boolean {
    if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 256) {
      return false;
    }
    const controller = this.activeAgentModelRequests.get(
      `${event.sender.id}:${requestId}`,
    );
    if (!controller) return false;
    controller.abort();
    return true;
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
    if (this.app.settings.get("files.openRecentIn") === "new-window") {
      void this.app.windowManager.openWorkspaceInNewWindow(folderPath);
      return;
    }
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
    this.failPendingExternalOpenDeliveries("NCE closed before confirming these files.");
    this.pendingExternalOpenResults.length = 0;
    if (this.boundsSaveTimer) clearTimeout(this.boundsSaveTimer);
    this.boundsSaveTimer = null;
    this.clearQuitTimer();
    const owner = this.window?.webContents;
    await this.disposeWindowServices(owner);
  }

  async waitForDisposal(): Promise<void> {
    if (!this.closed) await this.closedPromise;
    await this.resourceDisposal;
  }

  private async disposeWindowServices(owner?: WebContents): Promise<void> {
    this.agentApprovalManager?.cancelAll();
    this.agentProcessRunner?.dispose();
    await this.watcher?.dispose();
    if (owner) await this.terminalManager?.closeForOwner(owner);
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
    if (prepareOnly && this.quitState === "prepared") return Promise.resolve(true);
    if (this.quitState === "failed") {
      this.quitState = "idle";
      this.activeQuitRequestId = null;
    }
    if (!this.window || this.forceQuit || this.quitState !== "idle") return Promise.resolve(false);
    if (this.rendererGone || this.window.webContents.isDestroyed()) {
      this.forceCloseAfterRendererGone();
      return Promise.resolve(true);
    }
    if (!this.rendererReady) {
      return Promise.resolve(this.closeBeforeRendererReady(prepareOnly));
    }
    this.rendererCommitSkipped = false;
    this.prepareQuitOnly = prepareOnly;
    this.quitState = "preparing";
    return this.requestRenderer("Request:saveState", "preparing", { prepareOnly });
  }

  /**
   * The renderer has not finished its startup restoration, so it cannot own a
   * newer session state than the one already persisted. Preserve that state and
   * skip the renderer handshake instead of silently refusing the close.
   */
  private closeBeforeRendererReady(prepareOnly: boolean): boolean {
    this.preserveSessionOnClose = true;
    this.rendererCommitSkipped = true;
    if (prepareOnly) {
      this.quitState = "prepared";
      return true;
    }
    return this.finishClose();
  }

  prepareForApplicationQuit(): Promise<boolean> {
    return this.requestQuit(true);
  }

  approveQuit(
    prepareOnly = false,
    requestId?: unknown,
    commit = false,
    rollback = false,
  ): boolean {
    if (!this.isActiveRequest(requestId)) return false;
    this.clearQuitTimer();
    if (rollback && this.quitState === "rolling-back") {
      this.quitState = "idle";
      this.prepareQuitOnly = false;
      this.resolveQuitRequest(true);
      return true;
    }
    if (commit && this.quitState === "committing") {
      this.quitState = "committed";
      this.resolveQuitRequest(true);
      return true;
    }
    if (this.quitState !== "preparing") return false;
    if (prepareOnly || this.prepareQuitOnly) {
      this.quitState = "prepared";
      this.resolveQuitRequest(true);
      return true;
    }
    this.finishClose();
    return true;
  }

  cancelQuitRequest(requestId?: unknown): boolean {
    if (!this.isActiveRequest(requestId)) return false;
    this.clearQuitTimer();
    this.quitState = this.quitState === "committing" ? "prepared" : "cancelled";
    if (this.quitState === "cancelled") this.quitState = "idle";
    this.resolveQuitRequest(false);
    return true;
  }

  commitPreparedClose(): Promise<boolean> {
    if (this.quitState !== "prepared") return Promise.resolve(false);
    if (this.rendererGone || !this.window || this.window.isDestroyed() || this.window.webContents.isDestroyed()) {
      this.preserveSessionOnClose = true;
      this.forceCloseAfterRendererGone();
      return Promise.resolve(true);
    }
    if (this.rendererCommitSkipped) {
      this.preserveSessionOnClose = true;
      return Promise.resolve(true);
    }
    if (!this.rendererReady) {
      this.preserveSessionOnClose = true;
      this.rendererCommitSkipped = true;
      return Promise.resolve(true);
    }
    this.quitState = "committing";
    this.commitAttempted = true;
    this.prepareQuitOnly = false;
    return this.requestRenderer("Request:commitClose", "committing");
  }

  closeCommittedWindow(): boolean {
    const closeSkippedCommit =
      this.rendererCommitSkipped && this.quitState === "prepared";
    if (
      (this.quitState !== "committed" && !closeSkippedCommit) ||
      !this.window ||
      this.window.isDestroyed()
    ) {
      return false;
    }
    this.forceQuit = true;
    this.quitState = "closing";
    return this.closeNativeWindow(true);
  }

  canCloseCommittedWindow(): boolean {
    const closeSkippedCommit =
      this.rendererCommitSkipped && this.quitState === "prepared";
    return (
      (this.quitState === "committed" || closeSkippedCommit) &&
      Boolean(this.window && !this.window.isDestroyed())
    );
  }

  async cancelPreparedClose(): Promise<boolean> {
    if (!["prepared", "committed", "failed"].includes(this.quitState)) return false;
    const mustRestoreRecovery = this.commitAttempted;
    this.commitAttempted = false;
    if (this.rendererCommitSkipped) {
      this.rendererCommitSkipped = false;
      this.preserveSessionOnClose = false;
    }
    this.quitState = "idle";
    this.prepareQuitOnly = false;
    if (!mustRestoreRecovery || !this.window || this.window.isDestroyed() || this.window.webContents.isDestroyed())
      return true;
    this.quitState = "rolling-back";
    return this.requestRenderer("Request:rollbackClose", "rolling-back");
  }

  private finishClose(): boolean {
    this.clearQuitTimer();
    this.quitState = "closing";
    this.forceQuit = true;
    const closed = this.closeNativeWindow(true);
    this.resolveQuitRequest(closed);
    return closed;
  }

  private closeNativeWindow(forceAfterAcknowledgment = false): boolean {
    const target = this.window;
    if (!target || target.isDestroyed()) return this.closed;
    this.app.windowManager?.updateWindowState(this);
    try { this.terminalManager?.closeForOwner(target.webContents); } catch {}
    try { target.close(); }
    catch {
      if (forceAfterAcknowledgment) {
        try { target.destroy(); return true; } catch {}
      }
      this.forceQuit = false;
      this.quitState = "failed";
      return false;
    }
    return true;
  }

  private forceCloseAfterRendererGone(): void {
    const target = this.window;
    if (!target || target.isDestroyed()) return;
    this.preserveSessionOnClose = true;
    this.forceQuit = true;
    this.quitState = "closing";
    this.closeNativeWindow(true);
  }

  private requestRenderer(channel: string, expectedState: string, payload: Record<string, unknown> = {}): Promise<boolean> {
    const target = this.window;
    if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return Promise.resolve(false);
    const requestId = randomUUID();
    this.activeQuitRequestId = requestId;
    return new Promise<boolean>((resolve) => {
      this.quitRequestResolve = resolve;
      try {
        target.webContents.send(channel, { ...payload, requestId });
      } catch {
        this.quitState = "failed";
        this.resolveQuitRequest(false);
        return;
      }
      this.quitTimer = setTimeout(() => {
        this.quitTimer = null;
        if (this.quitState !== expectedState || this.activeQuitRequestId !== requestId) return;
        console.warn("[Window] Renderer did not acknowledge shutdown work; keeping the window open.");
        this.quitState = "failed";
        this.prepareQuitOnly = false;
        this.resolveQuitRequest(false);
      }, WINDOW_CLOSE_RESPONSE_TIMEOUT_MS);
    });
  }

  private isActiveRequest(requestId: unknown): boolean {
    return typeof requestId === "string" && requestId === this.activeQuitRequestId;
  }

  private finishRollback(requestId: unknown, success: boolean): boolean {
    if (!this.isActiveRequest(requestId) || this.quitState !== "rolling-back") return false;
    this.clearQuitTimer();
    this.quitState = success ? "idle" : "failed";
    this.prepareQuitOnly = false;
    this.resolveQuitRequest(success);
    return true;
  }

  private resolveQuitRequest(approved: boolean): void {
    const resolve = this.quitRequestResolve;
    this.quitRequestResolve = null;
    resolve?.(approved);
  }

  clearQuitTimer() {
    if (this.quitTimer) clearTimeout(this.quitTimer);
    this.quitTimer = null;
  }
}
