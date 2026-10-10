import { BrowserWindow, dialog, screen, type MessageBoxOptions, type WebContents } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { App } from "../App";
import { Window } from "../Window";
import { AppMenu } from "../addon/Menu";
import { IpcRouter } from "./IpcRouter";
import { WindowSessionStore, type WindowBounds, type WindowSession } from "./WindowSessionStore";

export const MAX_NCE_WINDOWS = 8;
const WINDOW_RESTORE_STAGGER_MS = 80;

export interface CreateWindowOptions {
  session?: WindowSession;
  workspacePath?: string | null;
  bounds?: WindowBounds | null;
  maximized?: boolean;
  focus?: boolean;
}

function workspaceComparisonKey(value: string, platform = process.platform): string {
  const pathApi = platform === "win32" ? path.win32 : path;
  const normalized = pathApi.resolve(value).normalize("NFC");
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

export class WindowManager {
  readonly windows = new Map<string, Window>();
  private readonly byWebContents = new Map<WebContents, string>();
  private readonly workspaceOwners = new Map<string, string>();
  private activeWindowId: string | null = null;
  private creationIndex = 0;
  private readonly app: App;
  private readonly ipcRouter: IpcRouter;
  private readonly sessions: WindowSessionStore;

  constructor(app: App, ipcRouter: IpcRouter, sessions: WindowSessionStore) {
    this.app = app;
    this.ipcRouter = ipcRouter;
    this.sessions = sessions;
  }

  createEmptyWindow(focus = true): Window | null {
    if (this.windows.size >= MAX_NCE_WINDOWS) {
      void this.showWindowLimitMessage();
      return null;
    }
    const window = this.createWindow({ focus });
    if (!window) void this.showWindowCreationError();
    return window;
  }

  createWindow(options: CreateWindowOptions = {}): Window | null {
    if (this.windows.size >= MAX_NCE_WINDOWS) return null;
    let session = options.session || null;
    let createdWindow: Window | null = null;
    try {
      if (!session) {
        const workspacePath = options.workspacePath || null;
        let rendererState: Record<string, unknown> | null = null;
        if (workspacePath) rendererState = { version: 2, lastWorkspace: workspacePath, noWorkspaceState: null };
        const area = screen.getPrimaryDisplay().workArea;
        const offset = (this.creationIndex++ % 8) * 28;
        session = this.sessions.create({
          workspacePath,
          rendererState,
          bounds: options.bounds || {
            x: area.x + Math.min(60 + offset, Math.max(0, area.width - 820)),
            y: area.y + Math.min(60 + offset, Math.max(0, area.height - 620)),
            width: Math.max(800, Math.min(1100, area.width - 64)),
            height: Math.max(600, Math.min(720, area.height - 64)),
          },
          maximized: options.maximized,
        });
      }
      const id = randomUUID();
      const window = new Window(this.app, {
        id,
        session,
        ipc: this.ipcRouter.forWindow(id),
        focusWhenReady: options.focus !== false,
      });
      createdWindow = window;
      this.windows.set(id, window);
      if (session.workspacePath) {
        const key = workspaceComparisonKey(session.workspacePath);
        const owner = this.workspaceOwners.get(key);
        if (owner && owner !== id) {
          this.windows.delete(id);
          this.sessions.remove(session.id);
          this.focusWindow(owner);
          return null;
        }
        this.workspaceOwners.set(key, id);
      }
      window.create();
      return window;
    } catch (error) {
      if (createdWindow) {
        const target = createdWindow.window;
        this.removeWindow(createdWindow.id, target?.webContents);
        createdWindow.dispose();
        if (target && !target.isDestroyed()) target.destroy();
      }
      if (session) this.sessions.remove(session.id);
      console.error("[Window Manager] Failed to create window", error);
      return null;
    }
  }

  async restoreSessions(): Promise<void> {
    const sessions = this.sessions.getAll().slice(0, MAX_NCE_WINDOWS);
    for (let index = 0; index < sessions.length; index++) {
      const session = sessions[index];
      const workspace = await this.validateWorkspace(session.workspacePath);
      if (session.workspacePath && !workspace) {
        session.workspacePath = null;
        const state = session.rendererState;
        if (state && typeof state === "object") {
          session.rendererState = { ...state, lastWorkspace: null };
        }
        this.sessions.update(session.id, {
          workspacePath: null,
          rendererState: session.rendererState,
        });
      } else if (workspace) {
        session.workspacePath = workspace;
        this.sessions.update(session.id, { workspacePath: workspace });
      }
      this.createWindow({ session, focus: false });
      if (index + 1 < sessions.length) {
        await new Promise((resolve) => setTimeout(resolve, WINDOW_RESTORE_STAGGER_MS));
      }
    }
    if (this.windows.size === 0) this.createEmptyWindow();
    const lastActiveId = this.sessions.getLastActiveSessionId();
    const lastActive = [...this.windows.values()].find((window) => window.sessionId === lastActiveId);
    if (lastActive) lastActive.window?.focus();
  }

  async openWorkspaceInNewWindow(folderPath: unknown): Promise<boolean> {
    const canonical = await this.validateWorkspace(folderPath);
    if (!canonical) {
      const focused = this.getFocusedWindow()?.window || BrowserWindow.getFocusedWindow();
      const options: MessageBoxOptions = {
        type: "error",
        buttons: ["OK"],
        message: "Unable to open folder",
        detail: "The selected path is not an available folder.",
      };
      if (focused) await dialog.showMessageBox(focused, options);
      else await dialog.showMessageBox(options);
      return false;
    }
    const existing = this.findWindowByWorkspace(canonical);
    if (existing) {
      this.focusWindow(existing.id);
      return true;
    }
    if (this.windows.size >= MAX_NCE_WINDOWS) {
      const parent = this.getFocusedWindow()?.window || BrowserWindow.getFocusedWindow();
      const options: MessageBoxOptions = {
        type: "info",
        buttons: ["OK"],
        message: "Window limit reached",
        detail: `NCE can have up to ${MAX_NCE_WINDOWS} windows open at once.`,
      };
      if (parent) await dialog.showMessageBox(parent, options);
      else await dialog.showMessageBox(options);
      return false;
    }
    const created = this.createWindow({ workspacePath: canonical, focus: true });
    if (!created) {
      await this.showWindowCreationError();
      return false;
    }
    const added = await this.app.recentFolders?.add(canonical);
    if (added) this.app.broadcastToWindows("recent-folders-changed", this.app.recentFolders.getAll());
    return true;
  }

  findWindowByWorkspace(folderPath: string): Window | null {
    const key = workspaceComparisonKey(folderPath);
    const ownerId = this.workspaceOwners.get(key);
    return ownerId ? this.windows.get(ownerId) || null : null;
  }

  async focusWorkspace(folderPath: unknown, requestingWindowId?: string): Promise<boolean> {
    const canonical = await this.validateWorkspace(folderPath);
    if (!canonical) return false;
    const existing = this.findWindowByWorkspace(canonical);
    if (!existing || existing.id === requestingWindowId) return false;
    this.focusWindow(existing.id);
    return true;
  }

  async reserveWorkspace(windowId: string, folderPath: unknown): Promise<{ success: boolean; path?: string; existingWindowId?: string }> {
    const canonical = await this.validateWorkspace(folderPath);
    if (!canonical) return { success: false };
    const keys = [workspaceComparisonKey(canonical)];
    if (typeof folderPath === "string") keys.push(workspaceComparisonKey(folderPath));
    const ownerId = keys.map((key) => this.workspaceOwners.get(key)).find(Boolean);
    if (ownerId && ownerId !== windowId) {
      this.focusWindow(ownerId);
      return { success: false, existingWindowId: ownerId };
    }
    const window = this.windows.get(windowId);
    if (!window) return { success: false };
    for (const key of keys) this.workspaceOwners.set(key, windowId);
    window.setWorkspacePath(canonical);
    return { success: true, path: canonical };
  }

  releaseWorkspace(windowId: string, folderPath?: string | null, updateWindow = true): void {
    for (const [key, owner] of this.workspaceOwners) {
      if (owner === windowId) this.workspaceOwners.delete(key);
    }
    const window = this.windows.get(windowId);
    if (window && updateWindow) window.setWorkspacePath(null);
  }

  focusWindow(windowId: string): boolean {
    const window = this.windows.get(windowId)?.window;
    if (!window || window.isDestroyed()) return false;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    this.markActive(windowId);
    return true;
  }

  getWindowByWebContents(sender: WebContents): Window | null {
    const id = this.byWebContents.get(sender);
    return id ? this.windows.get(id) || null : null;
  }

  getFocusedWindow(): Window | null {
    const nativeFocused = BrowserWindow.getFocusedWindow();
    if (nativeFocused) {
      for (const window of this.windows.values()) if (window.window === nativeFocused) return window;
    }
    return this.activeWindowId ? this.windows.get(this.activeWindowId) || null : null;
  }

  getAllWindows(): Window[] {
    return [...this.windows.values()];
  }

  async closeWindow(windowId: string): Promise<boolean> {
    const window = this.windows.get(windowId);
    return window ? window.requestQuit() : false;
  }

  async closeAllWindows({ preserveSessions = true }: { preserveSessions?: boolean } = {}): Promise<boolean> {
    const prepared: Window[] = [];
    for (const window of this.getAllWindows()) {
      if (!(await window.prepareForApplicationQuit())) {
        for (const earlier of prepared) earlier.cancelPreparedClose();
        return false;
      }
      prepared.push(window);
    }
    for (const window of prepared) {
      if (preserveSessions) window.preserveSessionOnClose = true;
      if (!(await window.commitPreparedClose())) {
        for (const remaining of prepared) remaining.cancelPreparedClose();
        return false;
      }
      await window.waitForDisposal();
    }
    return true;
  }

  registerBrowserWindow(window: Window, browserWindow: InstanceType<typeof BrowserWindow>): void {
    // Electron destroys BrowserWindow's native wrapper before emitting `closed`.
    // Keep the sender captured here because reading browserWindow.webContents in
    // that callback throws "Object has been destroyed" on macOS.
    const sender = browserWindow.webContents;
    this.ipcRouter.attachWindow(window.id, sender);
    this.byWebContents.set(sender, window.id);
    browserWindow.on("focus", () => this.markActive(window.id));
    browserWindow.on("closed", () => this.removeWindow(window.id, sender));
    if (window.workspacePath) {
      this.workspaceOwners.set(workspaceComparisonKey(window.workspacePath), window.id);
    }
  }

  removeWindow(windowId: string, sender?: WebContents): void {
    const window = this.windows.get(windowId);
    this.windows.delete(windowId);
    if (sender) this.byWebContents.delete(sender);
    this.ipcRouter.detachWindow(windowId, sender);
    this.releaseWorkspace(windowId, window?.workspacePath, false);
    if (this.activeWindowId === windowId) {
      this.activeWindowId = [...this.windows.keys()].at(-1) || null;
      const active = this.activeWindowId ? this.windows.get(this.activeWindowId) : null;
      if (active) active.appMenu?.activate();
      else AppMenu.installWindowlessMenu(this.app);
    }
    if (window && !this.app.isQuitting && !window.preserveSessionOnClose)
      void this.sessions.remove(window.sessionId);
  }

  updateWindowState(window: Window): void {
    const browserWindow = window.window;
    if (!browserWindow || browserWindow.isDestroyed()) return;
    const maximized = browserWindow.isMaximized();
    const bounds = maximized || browserWindow.isFullScreen()
      ? browserWindow.getNormalBounds()
      : browserWindow.getBounds();
    this.sessions.update(window.sessionId, { bounds, maximized });
  }

  getRestoreBounds(bounds: WindowBounds | null): WindowBounds | null {
    return WindowManager.getRestoreBounds(bounds);
  }

  dispose(): void {
    for (const window of this.windows.values()) void window.dispose();
    this.windows.clear();
    this.byWebContents.clear();
    this.workspaceOwners.clear();
    this.activeWindowId = null;
  }

  private markActive(windowId: string): void {
    if (!this.windows.has(windowId)) return;
    this.activeWindowId = windowId;
    for (const [id, candidate] of this.windows) {
      if (id !== windowId) candidate.appMenu?.deactivate();
    }
    const window = this.windows.get(windowId);
    window?.appMenu?.activate();
    this.sessions.markActive(window!.sessionId);
  }

  private async validateWorkspace(folderPath: unknown): Promise<string | null> {
    if (typeof folderPath !== "string" || !folderPath.trim() || folderPath.includes("\0")) return null;
    try {
      const canonical = await fs.realpath(path.resolve(folderPath));
      if (!(await fs.stat(canonical)).isDirectory()) return null;
      return canonical;
    } catch {
      return null;
    }
  }

  private async showWindowLimitMessage(): Promise<void> {
    const parent = this.getFocusedWindow()?.window || BrowserWindow.getFocusedWindow();
    const options: MessageBoxOptions = {
      type: "info", buttons: ["OK"], message: "Window limit reached",
      detail: `NCE can have up to ${MAX_NCE_WINDOWS} windows open at once.`,
    };
    if (parent) await dialog.showMessageBox(parent, options);
    else await dialog.showMessageBox(options);
  }

  private async showWindowCreationError(): Promise<void> {
    const parent = this.getFocusedWindow()?.window || BrowserWindow.getFocusedWindow();
    const options: MessageBoxOptions = {
      type: "error", buttons: ["OK"], message: "Unable to create window",
      detail: "NCE could not create another window.",
    };
    if (parent) await dialog.showMessageBox(parent, options);
    else await dialog.showMessageBox(options);
  }

  async resolveWorkspacePath(folderPath: unknown): Promise<string | null> {
    return this.validateWorkspace(folderPath);
  }

  static getRestoreBounds(bounds: WindowBounds | null, platform = process.platform): WindowBounds | null {
    if (!bounds) return null;
    const displays = screen.getAllDisplays();
    const intersects = displays.some(({ workArea }) =>
      bounds.x < workArea.x + workArea.width && bounds.x + bounds.width > workArea.x &&
      bounds.y < workArea.y + workArea.height && bounds.y + bounds.height > workArea.y,
    );
    if (intersects) return bounds;
    const area = screen.getPrimaryDisplay().workArea;
    return { x: area.x + 32, y: area.y + 32, width: Math.min(bounds.width, area.width), height: Math.min(bounds.height, area.height) };
  }
}
