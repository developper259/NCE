import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import type { Window } from "../Window";
import type { WindowManager } from "./WindowManager";

export const MAX_EXTERNAL_OPEN_PATHS = 64;
const MAX_QUEUED_EXTERNAL_OPEN_BATCHES = 64;
const MAX_PENDING_STARTUP_NOTIFICATIONS = 8;
const MAX_EXTERNAL_PATH_LENGTH = 32_768;

export interface ExternalOpenFailure {
  path: string;
  code: string;
  message: string;
}

export interface ExternalOpenResult {
  success: boolean;
  openedFiles: number;
  openedFolders: number;
  focusedFolders: number;
  failures: ExternalOpenFailure[];
}

export interface DeliveredFileResult {
  openedPaths: string[];
  failures: Array<{ path: string; message: string }>;
}

interface ClassifiedPath {
  path: string;
  kind: "file" | "directory";
}

interface QueuedRequest {
  paths: unknown;
  cwd: string;
  target: Window | null;
  targetCaptured: boolean;
  requireAbsolute: boolean;
  resolve: (result: ExternalOpenResult) => void;
  settled: boolean;
}

const STARTUP_QUEUE_KEY = "system-startup";

function failed(pathValue: unknown, code: string, message: string): ExternalOpenFailure {
  return {
    path: typeof pathValue === "string" ? pathValue.slice(0, MAX_EXTERNAL_PATH_LENGTH) : "",
    code,
    message,
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function getPathApi(platform = process.platform) {
  return platform === "win32" ? path.win32 : path;
}

function pathComparisonKey(value: string, platform = process.platform): string {
  const api = getPathApi(platform);
  const normalized = api.normalize(value).normalize("NFC");
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function isPathCandidate(value: string, platform: NodeJS.Platform): boolean {
  if (!value || value.length > MAX_EXTERNAL_PATH_LENGTH || value.includes("\0")) return false;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return false;
  if (platform === "win32") return path.win32.isAbsolute(value);
  return path.isAbsolute(value);
}

export class ExternalOpenCoordinator {
  private readonly windowManager: WindowManager;
  private readonly platform: NodeJS.Platform;
  private readonly waitingForStart: QueuedRequest[] = [];
  private readonly requestChains = new Map<string, Promise<void>>();
  private readonly pendingRequests = new Set<QueuedRequest>();
  private readonly pendingStartupNotifications: ExternalOpenResult[] = [];
  private pendingRequestCount = 0;
  private startupTarget: Window | null = null;
  private started = false;
  private disposed = false;

  constructor(windowManager: WindowManager, platform = process.platform) {
    this.windowManager = windowManager;
    this.platform = platform;
  }

  /** Hold startup/system opens until session and renderer restoration has completed. */
  start(): void {
    if (this.disposed) return;
    this.started = true;
    this.startupTarget = this.findAvailableSystemTarget();
    this.flushPendingStartupNotifications();
    const requests = this.waitingForStart.splice(0);
    for (const request of requests) {
      if (!request.targetCaptured && this.startupTarget) {
        request.target = this.startupTarget;
        request.targetCaptured = true;
      }
      this.dispatch(request);
    }
  }

  hasPendingSystemRequests(): boolean {
    return [...this.pendingRequests].some((request) => !request.requireAbsolute);
  }

  enqueueSystemPaths(paths: unknown, cwd = process.cwd()): Promise<ExternalOpenResult> {
    const target = this.findAvailableSystemTarget();
    return this.enqueue({
      paths,
      cwd,
      target,
      targetCaptured: target !== null,
      requireAbsolute: false,
    });
  }

  /** The target is captured from the actual IPC sender before any async work. */
  enqueueDrop(paths: unknown, target: Window): Promise<ExternalOpenResult> {
    return this.enqueue({
      paths,
      cwd: process.cwd(),
      target,
      targetCaptured: true,
      requireAbsolute: true,
    });
  }

  dispose(): void {
    this.disposed = true;
    this.started = false;
    const message = "NCE is shutting down before this request could be processed.";
    this.waitingForStart.length = 0;
    this.pendingStartupNotifications.length = 0;
    for (const request of this.pendingRequests) this.settle(request, this.closingResult(message));
  }

  private enqueue(options: Omit<QueuedRequest, "resolve" | "settled">): Promise<ExternalOpenResult> {
    if (this.disposed) {
      return Promise.resolve(this.result([
        failed("", "APP_CLOSING", "NCE is shutting down."),
      ]));
    }
    if (this.pendingRequestCount >= MAX_QUEUED_EXTERNAL_OPEN_BATCHES) {
      const result = this.result([
        failed("", "QUEUE_FULL", "Too many external open requests are waiting."),
      ]);
      if (!options.requireAbsolute) this.reportSystemFailure(result);
      return Promise.resolve(result);
    }
    return new Promise((resolve) => {
      const request: QueuedRequest = { ...options, resolve, settled: false };
      this.pendingRequestCount += 1;
      this.pendingRequests.add(request);
      if (this.started) this.dispatch(request);
      else this.waitingForStart.push(request);
    });
  }

  private dispatch(request: QueuedRequest): void {
    const key = request.target?.id || STARTUP_QUEUE_KEY;
    const previous = this.requestChains.get(key) || Promise.resolve();
    let chain!: Promise<void>;
    chain = previous.catch(() => undefined).then(async () => {
      if (this.disposed) {
        this.settle(request, this.closingResult("NCE is shutting down."));
        return;
      }
      try {
        this.settle(request, await this.processRequest(request));
      } catch (error) {
        console.error("[External Open] Request failed", error);
        this.settle(request, this.result([
          failed("", "OPEN_FAILED", "NCE could not process this open request."),
        ]));
      }
    }).finally(() => {
      if (this.requestChains.get(key) === chain) this.requestChains.delete(key);
    });
    this.requestChains.set(key, chain);
  }

  private async processRequest(request: QueuedRequest): Promise<ExternalOpenResult> {
    const classified = await this.classify(request.paths, request.cwd, request.requireAbsolute);
    const failures = [...classified.failures];
    if (classified.entries.length === 0) {
      if (!request.requireAbsolute) {
        const current = this.isLiveWindow(request.target)
          ? request.target
          : this.findAvailableSystemTarget() || (failures.length ? this.windowManager.createEmptyWindow() : null);
        if (this.isLiveWindow(current)) {
          this.adoptStartupTarget(current);
          this.windowManager.focusWindow(current.id);
          if (failures.length) current.notifyExternalOpenResult(this.result(failures));
        }
      }
      this.flushPendingStartupNotifications();
      return this.result(failures);
    }

    const files = classified.entries.filter((entry) => entry.kind === "file");
    const folders = classified.entries.filter((entry) => entry.kind === "directory");
    let openedFiles = 0;
    let openedFolders = 0;
    let focusedFolders = 0;

    if (files.length) {
      let target = request.target;
      if (!this.isLiveWindow(target) && !request.requireAbsolute) {
        target = this.findAvailableSystemTarget() || this.windowManager.createEmptyWindow();
        if (this.isLiveWindow(target)) this.adoptStartupTarget(target);
      }
      if (!this.isLiveWindow(target)) {
        for (const entry of files) {
          failures.push(failed(entry.path, "WINDOW_UNAVAILABLE", "The target NCE window is no longer available."));
        }
      } else {
        this.windowManager.focusWindow(target.id);
        try {
          const delivery: DeliveredFileResult = await target.deliverExternalFiles(
            files.map((entry) => entry.path),
          );
          openedFiles += delivery.openedPaths.length;
          for (const item of delivery.failures) {
            failures.push(failed(item.path, "FILE_OPEN_FAILED", item.message || "The file could not be opened."));
          }
        } catch (error: unknown) {
          const message = errorMessage(error, "The target window could not open the files.");
          for (const entry of files) failures.push(failed(entry.path, "FILE_OPEN_FAILED", message));
        }
        if (!request.targetCaptured) this.adoptStartupTarget(target);
      }
    }

    // Workspace openings are deliberately serialized through WindowManager so its
    // duplicate-workspace and eight-window limit checks remain authoritative.
    for (const entry of folders) {
      try {
        const outcome = await this.windowManager.openWorkspaceInNewWindowWithOutcome(entry.path);
        if (!outcome.opened) {
          failures.push(failed(entry.path, "FOLDER_OPEN_FAILED", "The folder could not be opened in a new NCE window."));
        } else if (outcome.focused) {
          focusedFolders += 1;
        } else {
          openedFolders += 1;
        }
      } catch (error: unknown) {
        failures.push(failed(entry.path, "FOLDER_OPEN_FAILED", errorMessage(error, "The folder could not be opened.")));
      }
    }

    const result = this.result(failures, openedFiles, openedFolders, focusedFolders);
    const notificationTarget = this.isLiveWindow(request.target)
      ? request.target
      : this.isLiveWindow(this.startupTarget)
        ? this.startupTarget
        : this.findAvailableSystemTarget();
    if (!request.requireAbsolute && failures.length && this.isLiveWindow(notificationTarget)) {
      notificationTarget.notifyExternalOpenResult(result);
    }
    this.flushPendingStartupNotifications();
    return result;
  }

  private reportSystemFailure(result: ExternalOpenResult): void {
    const target = this.findAvailableSystemTarget();
    if (this.isLiveWindow(target)) {
      target.notifyExternalOpenResult(result);
      return;
    }
    if (this.pendingStartupNotifications.length >= MAX_PENDING_STARTUP_NOTIFICATIONS) {
      this.pendingStartupNotifications.shift();
    }
    this.pendingStartupNotifications.push(result);
  }

  private flushPendingStartupNotifications(): void {
    if (this.pendingStartupNotifications.length === 0) return;
    const target = this.findAvailableSystemTarget();
    if (!this.isLiveWindow(target)) return;
    for (const result of this.pendingStartupNotifications.splice(0)) {
      target.notifyExternalOpenResult(result);
    }
  }

  private async classify(
    rawPaths: unknown,
    cwd: string,
    requireAbsolute: boolean,
  ): Promise<{ entries: ClassifiedPath[]; failures: ExternalOpenFailure[] }> {
    if (!Array.isArray(rawPaths)) {
      return { entries: [], failures: [failed("", "INVALID_REQUEST", "Expected a list of file or folder paths.")] };
    }
    if (rawPaths.length > MAX_EXTERNAL_OPEN_PATHS) {
      return {
        entries: [],
        failures: [failed("", "TOO_MANY_PATHS", `A single request can contain at most ${MAX_EXTERNAL_OPEN_PATHS} paths.`)],
      };
    }

    const entries: ClassifiedPath[] = [];
    const failures: ExternalOpenFailure[] = [];
    const seen = new Set<string>();
    const api = getPathApi(this.platform);
    for (const rawPath of rawPaths) {
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        failures.push(failed(rawPath, "INVALID_PATH", "The path is empty or invalid."));
        continue;
      }
      if (rawPath.length > MAX_EXTERNAL_PATH_LENGTH || rawPath.includes("\0") ||
          /^[a-z][a-z\d+.-]*:\/\//i.test(rawPath)) {
        failures.push(failed(rawPath, "INVALID_PATH", "The path is not a valid local file system path."));
        continue;
      }
      if (requireAbsolute && !isPathCandidate(rawPath, this.platform)) {
        failures.push(failed(rawPath, "INVALID_PATH", "Dropped items must provide an absolute local path."));
        continue;
      }

      const resolvedPath = api.resolve(cwd, rawPath);
      try {
        const canonicalPath = await fs.realpath(resolvedPath);
        const stats = await fs.stat(canonicalPath);
        if (!stats.isFile() && !stats.isDirectory()) {
          failures.push(failed(rawPath, "UNSUPPORTED_PATH", "Only regular files and folders can be opened."));
          continue;
        }
        await fs.access(canonicalPath, fsConstants.R_OK | (stats.isDirectory() ? fsConstants.X_OK : 0));
        const key = pathComparisonKey(canonicalPath, this.platform);
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ path: canonicalPath, kind: stats.isDirectory() ? "directory" : "file" });
      } catch (error: unknown) {
        const fileSystemCode = (error as NodeJS.ErrnoException)?.code;
        const code = fileSystemCode === "EACCES" || fileSystemCode === "EPERM" ? "ACCESS_DENIED" :
          fileSystemCode === "ENOENT" || fileSystemCode === "ENOTDIR" ? "PATH_NOT_FOUND" : "INVALID_PATH";
        const message = code === "ACCESS_DENIED"
          ? "NCE does not have permission to access this path."
          : code === "PATH_NOT_FOUND"
            ? "This file or folder no longer exists."
            : "NCE could not validate this path.";
        failures.push(failed(rawPath, code, message));
      }
    }
    return { entries, failures };
  }

  private isLiveWindow(window: Window | null): window is Window {
    return Boolean(window?.window && !window.window.isDestroyed() && !window.window.webContents.isDestroyed());
  }

  private findAvailableSystemTarget(): Window | null {
    const focused = this.windowManager.getFocusedWindow();
    if (this.isLiveWindow(focused)) return focused;
    return this.windowManager.getAllWindows().find((window) => this.isLiveWindow(window)) || null;
  }

  private adoptStartupTarget(window: Window): void {
    if (!this.isLiveWindow(window)) return;
    this.startupTarget = window;
    const startupChain = this.requestChains.get(STARTUP_QUEUE_KEY);
    if (startupChain) this.requestChains.set(window.id, startupChain);
  }

  private settle(request: QueuedRequest, result: ExternalOpenResult): void {
    if (request.settled) return;
    request.settled = true;
    this.pendingRequestCount = Math.max(0, this.pendingRequestCount - 1);
    this.pendingRequests.delete(request);
    request.resolve(result);
  }

  private closingResult(message: string): ExternalOpenResult {
    return this.result([failed("", "APP_CLOSING", message)]);
  }

  private result(
    failures: ExternalOpenFailure[],
    openedFiles = 0,
    openedFolders = 0,
    focusedFolders = 0,
  ): ExternalOpenResult {
    return {
      success: failures.length === 0,
      openedFiles,
      openedFolders,
      focusedFolders,
      failures,
    };
  }
}
