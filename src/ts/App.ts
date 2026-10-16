import { app, BrowserWindow, dialog } from "electron";
import fs from "node:fs";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";
import { Window } from "./Window";
import { NSHServer } from "nsh/server";
import { SettingsManager } from "./manager/SettingsManager";
import { RecentFoldersManager } from "./manager/RecentFoldersManager";
import { AgentConversationStore } from "./manager/AgentConversationStore";
import { AgentSecretStore } from "./manager/AgentSecretStore";
import { IpcRouter } from "./manager/IpcRouter";
import { WindowManager } from "./manager/WindowManager";
import { WindowSessionStore } from "./manager/WindowSessionStore";
import { ExternalOpenCoordinator } from "./manager/ExternalOpenCoordinator";

const SWITCHES_WITH_VALUES = new Set([
  "--app",
  "--auth-negotiate-delegate-whitelist",
  "--auth-server-whitelist",
  "--class",
  "--disk-cache-dir",
  "--disk-cache-size",
  "--dns-result-order",
  "--force-fieldtrials",
  "--host-rules",
  "--host-resolver-rules",
  "--ignore-connections-limit",
  "--js-flags",
  "--lang",
  "--log-file",
  "--log-level",
  "--log-net-log",
  "--proxy-pac-url",
  "--proxy-bypass-list",
  "--proxy-server",
  "--remote-debugging-port",
  "--user-data-dir",
  "--v",
  "--vmodule",
  "--xdg-portal-required-version",
  "--diagnostic-dir",
]);

function currentWorkingDirectory(): string {
  return typeof process.cwd === "function" ? process.cwd() : ".";
}

function externalPathArguments(
  args: unknown,
  cwd = currentWorkingDirectory(),
  platform = process.platform,
): string[] {
  if (!Array.isArray(args)) return [];
  const output: string[] = [];
  let skipNext = false;
  let afterSeparator = false;
  const pathApi = platform === "win32" ? path.win32 : path;
  const appPath = typeof app.getAppPath === "function" ? pathApi.resolve(app.getAppPath()) : "";
  const executablePath = typeof process.execPath === "string"
    ? pathApi.resolve(process.execPath)
    : "";
  for (const value of args) {
    if (typeof value !== "string" || !value) continue;
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!afterSeparator && value === "--") {
      afterSeparator = true;
      continue;
    }
    if (!afterSeparator && value.startsWith("-")) {
      const separatorIndex = value.indexOf("=");
      const flag = separatorIndex === -1 ? value : value.slice(0, separatorIndex);
      if (separatorIndex === -1 && SWITCHES_WITH_VALUES.has(flag)) skipNext = true;
      continue;
    }
    let filePath = value;
    if (/^file:/i.test(value)) {
      try {
        const url = new URL(value);
        if (url.protocol !== "file:" || url.search || url.hash) continue;
        filePath = fileURLToPath(url);
      } catch {
        continue;
      }
    } else if (/^[a-z][a-z\d+.-]*:/i.test(value) &&
        !(platform === "win32" && /^[a-z]:[\\/]/i.test(value))) {
      continue;
    }
    const resolved = pathApi.resolve(cwd, filePath);
    if ((appPath && resolved === appPath) || (executablePath && resolved === executablePath)) continue;
    output.push(filePath);
  }
  return output;
}

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
  agentSecrets!: AgentSecretStore;
  externalOpenCoordinator!: ExternalOpenCoordinator;
  name = "NCE";
  version = getPackageVersion();
  private quitPromise: Promise<boolean> | null = null;
  private readonly earlyOpenFilePaths: string[] = [];

  constructor() {
    // macOS can deliver document opens before Electron emits `ready`.
    app.on("open-file", (event, filePath) => {
      event.preventDefault();
      this.receiveOpenFilePath(filePath);
    });

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
    this.agentSecrets = new AgentSecretStore(userData);
    this.windowSessionStore = new WindowSessionStore(userData, process.platform, this.agentSecrets);
    this.windowManager = new WindowManager(this, this.ipcRouter, this.windowSessionStore);
    this.externalOpenCoordinator = new ExternalOpenCoordinator(this.windowManager);
    const startupArgStart = app.isPackaged ? 1 : 2;
    const argv = Array.isArray(process.argv) ? process.argv : [];
    const startupPaths = process.env?.NCE_DISABLE_EXTERNAL_STARTUP_PATHS === "1"
      ? []
      : externalPathArguments(argv.slice(startupArgStart));
    if (startupPaths.length) {
      void this.externalOpenCoordinator.enqueueSystemPaths(startupPaths, currentWorkingDirectory());
    }
    for (const filePath of this.earlyOpenFilePaths.splice(0)) {
      void this.externalOpenCoordinator.enqueueSystemPaths([filePath], currentWorkingDirectory());
    }
    this.setupAppEvents();
  }

  private receiveOpenFilePath(filePath: unknown): void {
    if (typeof filePath !== "string") return;
    if (this.externalOpenCoordinator) {
      void this.externalOpenCoordinator.enqueueSystemPaths([filePath], currentWorkingDirectory());
    } else {
      this.earlyOpenFilePaths.push(filePath);
    }
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
      await this.windowManager.restoreSessions({
        createEmptyWindow: !this.externalOpenCoordinator.hasPendingSystemRequests(),
      });
      this.externalOpenCoordinator.start();
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

    app.on("second-instance", (_event, argv, workingDirectory) => {
      void (async () => {
        const cwd = typeof workingDirectory === "string" && workingDirectory
          ? workingDirectory
          : currentWorkingDirectory();
        const paths = externalPathArguments(
          Array.isArray(argv) ? argv.slice(app.isPackaged ? 1 : 2) : [],
          cwd,
        );
        if (paths.length) {
          const result = await this.externalOpenCoordinator.enqueueSystemPaths(paths, cwd);
          if (result.failures.length) console.warn("[External Open] Some second-instance paths could not be opened", result.failures);
          return;
        }
        const focused = this.windowManager.getFocusedWindow() || this.windowManager.getAllWindows()[0];
        if (focused) this.windowManager.focusWindow(focused.id);
        else this.windowManager.createEmptyWindow();
      })();
    });

    app.on("will-quit", () => {
      this.externalOpenCoordinator?.dispose();
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
    const sessionsFlushed = await this.windowSessionStore.flush();
    const conversationStoreAvailable = this.agentConversations.getStatus?.().available === true;
    const conversationsFlushed = await this.agentConversations.flush();
    if (!sessionsFlushed || (conversationStoreAvailable && !conversationsFlushed)) {
      console.warn("[App] Quit cancelled because required session or Agent data could not be persisted");
      this.isQuitting = false;
      for (const window of prepared) await window.cancelPreparedClose();
      return false;
    }
    for (const window of prepared) {
      const closed = await window.commitPreparedClose();
      if (!closed) {
        this.isQuitting = false;
        for (const remaining of prepared) await remaining.cancelPreparedClose();
        return false;
      }
    }
    if (!prepared.every((window) => window.canCloseCommittedWindow())) {
      this.isQuitting = false;
      for (const window of prepared) await window.cancelPreparedClose();
      return false;
    }
    for (const window of prepared) window.closeCommittedWindow();
    for (const window of prepared) await window.waitForDisposal();
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
