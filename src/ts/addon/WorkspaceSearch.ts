import { ipcMain } from "electron";
import type { IpcHandlerRegistrar } from "../manager/IpcRouter";
import { constants as fsConstants, promises as fs, type Stats } from "fs";
import path from "path";
import { Window } from "../Window";
import { atomicWriteFile } from "./FileManager";
import { NceWorkspaceStorage } from "./NceWorkspaceStorage";
import {
  compareWorkspaceIndexPaths,
  WORKSPACE_INDEX_IGNORED_DIRECTORIES,
  WorkspaceIndex,
  type WorkspaceIndexEntry,
} from "./WorkspaceIndex";
import {
  isOpenableFileAtPath,
} from "./OpenableFile";
import {
  acquireWorkspaceRegexExecutor,
  releaseWorkspaceRegexExecutor,
  WorkspaceRegexExecutionError,
  WorkspaceRegexExecutor,
  WorkspaceRegexPattern,
} from "./WorkspaceRegexExecutor";

interface SearchOptions {
  include?: string;
  exclude?: string;
  caseSensitive?: boolean;
  useRegex?: boolean;
  wholeWord?: boolean;
  offset?: number;
  limit?: number;
  maxMatches?: number;
  requestId?: string;
  sessionId?: string;
  workspaceGeneration?: number;
  paths?: string[];
  dirtyPaths?: string[];
  replaceFirst?: boolean;
  ignoreHiddenDirectories?: boolean;
  forceFilesystemScan?: boolean;
}

interface SearchResult {
  path: string;
  relativePath: string;
  name: string;
  line: number;
  column: number;
  preview: string;
  matchStart: number;
  matchLength: number;
}

interface SearchResponse {
  results: SearchResult[];
  totalMatches: number;
  filesSearched: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

interface SearchStreamMessage {
  sessionId: string;
  workspaceGeneration: number;
  type: "batch" | "progress" | "complete" | "cancelled" | "error" | "reset";
  results?: SearchResult[];
  totalMatches: number;
  filesSearched: number;
  scannedFiles: number;
  error?: string;
}

interface SearchSession {
  id: string;
  root: string;
  query: string;
  optionsKey: string;
  workspaceGeneration: number;
  lastAccess: number;
  results: SearchResult[];
  cursor: number;
  totalMatches: number;
  filesSearched: number;
  scannedFiles: number;
  candidateFiles: number;
  directoriesVisited: number;
  usedIndex: boolean;
  filesRead: number;
  complete: boolean;
  cancelled: boolean;
  abortController: AbortController;
  promise: Promise<SearchResponse> | null;
  streamEmitter: ((message: SearchStreamMessage) => void) | null;
  streamLimit: number;
  streamedResultCount: number;
  streamBatch: SearchResult[];
  streamBatchTimer: ReturnType<typeof setTimeout> | null;
  streamProgressTimer: ReturnType<typeof setTimeout> | null;
}

/** Files commit atomically and independently; a later failure does not roll back earlier files. */
interface ReplaceResponse {
  success: boolean;
  filesChanged: number;
  replacements: number;
  filesScanned: number;
  filesMatched: number;
  skippedFiles: ReplaceFileIssue[];
  conflictedFiles: ReplaceFileIssue[];
  failedFiles: ReplaceFileIssue[];
  cancelled: boolean;
  error?: string;
}

interface ReplaceFileIssue {
  path: string;
  code: string;
  message: string;
}

interface ReplacementCandidate {
  filePath: string;
  relativePath: string;
  name: string;
  issue?: ReplaceFileIssue;
}

interface ProjectMapOptions {
  maxDepth?: number;
  maxFiles?: number;
  inspectionBudgetBytes?: number;
  requestId?: string;
}

const DEFAULT_PROJECT_MAP_INSPECTION_BYTES = 16 * 1024 * 1024;
const MAX_PROJECT_MAP_INSPECTION_BYTES = 64 * 1024 * 1024;
const PROJECT_MAP_BINARY_SAMPLE_BYTES = 8 * 1024;
const PROJECT_MAP_INSPECTION_BUFFER_BYTES = 64 * 1024;

type ProjectMapInspectionStatus =
  | "exact"
  | "binary"
  | "budget-skipped"
  | "unavailable"
  | "symlink-skipped"
  | "cancelled";

interface ProjectMapInspection {
  binary: boolean;
  lineCount: number | null;
  inspectionStatus: ProjectMapInspectionStatus;
  bytesRead: number;
  cacheHit: boolean;
}

interface ProjectMapInspectionCacheEntry {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  binary: boolean;
  lineCount: number | null;
  inspectionStatus: "exact" | "binary";
}

interface ProjectMapEntry {
  name: string;
  path: string;
  relativePath: string;
  type: "file" | "directory";
  depth: number;
  lineCount: number | null;
  binary: boolean;
  inspectionStatus?: ProjectMapInspectionStatus;
}

interface ProjectMapResponse {
  success: boolean;
  root: string;
  entries: ProjectMapEntry[];
  files: number;
  directories: number;
  truncated: boolean;
  maxDepth: number;
  maxFiles: number;
  inspectionBytes: number;
  inspectionBudgetBytes: number;
  inspectionSkippedFiles: number;
  inspectionUnavailableFiles: number;
  inspectionCacheHits: number;
  indexedMetadataHits: number;
  indexHit: boolean;
  cancelled: boolean;
  error?: { code: string; message: string };
}

interface ProjectFileEntry {
  name: string;
  path: string;
  relativePath: string;
}
interface ProjectFilesResponse {
  success: boolean;
  entries: ProjectFileEntry[];
  indexHit?: boolean;
  filesProbed?: number;
  error?: { code: string; message: string };
}
interface ProjectFilesOptions {
  openableOnly?: boolean;
  ignoreHiddenDirectories?: boolean;
}

export class WorkspaceSearch {
  window: Window;
  readonly workspaceIndex: WorkspaceIndex;
  private readonly cancelledRequests = new Set<string>();
  private readonly requestControllers = new Map<string, Set<AbortController>>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly searchSessions = new Map<string, SearchSession>();
  private readonly cancelledSearchSessions = new Map<string, number>();
  private readonly maxSearchSessions = 8;
  private readonly searchSessionTtlMs = 5 * 60 * 1000;
  private readonly ipc: IpcHandlerRegistrar;
  private regexExecutor: WorkspaceRegexExecutor | null = null;
  private disposed = false;
  private readonly projectMapInspectionCache = new Map<
    string,
    ProjectMapInspectionCacheEntry
  >();
  private readonly maxProjectMapInspectionCacheEntries = 5000;

  private readonly maxFileSize = 5 * 1024 * 1024;
  private readonly maxResults = 50000;
  private readonly maxReplaceCandidates = 50000;
  private readonly binaryExtensions = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".bmp",
    ".pdf",
    ".zip",
    ".gz",
    ".tar",
    ".7z",
    ".rar",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".mp3",
    ".wav",
    ".ogg",
    ".mp4",
    ".mov",
    ".avi",
    ".webm",
    ".asar",
  ]);

  constructor(window: Window, ipc: IpcHandlerRegistrar = ipcMain as any) {
    this.window = window;
    this.ipc = ipc;
    this.workspaceIndex = new WorkspaceIndex();
  }

  private getRegexExecutor(): WorkspaceRegexExecutor {
    if (!this.regexExecutor)
      this.regexExecutor = acquireWorkspaceRegexExecutor();
    return this.regexExecutor;
  }

  private registerRequestController(
    requestId: string | undefined,
    controller: AbortController,
  ): () => void {
    this.activeControllers.add(controller);
    const controllers = typeof requestId === "string" && requestId
      ? this.requestControllers.get(requestId) || new Set()
      : null;
    if (controllers) {
      controllers.add(controller);
      this.requestControllers.set(requestId!, controllers);
    }
    return () => {
      this.activeControllers.delete(controller);
      if (!controllers || !requestId) return;
      controllers.delete(controller);
      if (!controllers.size) this.requestControllers.delete(requestId);
    };
  }

  private async ensureWorkspaceStorage(rootPath: string): Promise<void> {
    if (typeof rootPath !== "string" || !rootPath.trim()) return;
    try {
      await new NceWorkspaceStorage(rootPath).ensureStructure();
    } catch {}
  }

  private activeWorkspaceRoot(): string | null {
    const root = this.window?.watcher?.getWatchedPath?.();
    return typeof root === "string" && root.trim() ? path.resolve(root) : null;
  }

  private async isActiveWorkspaceRoot(value: unknown): Promise<boolean> {
    const active = this.activeWorkspaceRoot();
    if (!active || typeof value !== "string" || !value.trim() || value.includes("\0"))
      return false;
    try {
      return path.resolve(await fs.realpath(value)) ===
        path.resolve(await fs.realpath(active));
    } catch {
      return false;
    }
  }

  private inactiveReplaceResponse(): ReplaceResponse {
    return {
      success: false,
      filesChanged: 0,
      replacements: 0,
      filesScanned: 0,
      filesMatched: 0,
      skippedFiles: [],
      conflictedFiles: [],
      failedFiles: [],
      cancelled: false,
      error: "The requested workspace is not active.",
    };
  }

  handleIPC() {
    this.ipc.handle(
      "WorkspaceSearch:indexStats",
      async (_event, rootPath: unknown) => {
        if (!(await this.isActiveWorkspaceRoot(rootPath))) return null;
        const root = path.resolve(rootPath as string);
        this.workspaceIndex.scheduleBuild(root);
        return this.workspaceIndex.getStats(root);
      },
    );
    this.ipc.handle(
      "WorkspaceSearch:search",
      async (
        _event,
        rootPath: string,
        query: string,
        options: SearchOptions = {},
      ) => {
        const requestId = options?.requestId;
        if (requestId) this.cancelledRequests.delete(requestId);
        if (!(await this.isActiveWorkspaceRoot(rootPath)))
          return this.emptySearchResponse(options);
        await this.ensureWorkspaceStorage(rootPath);
        try {
          return await this.search(rootPath, query, options);
        } finally {
          if (requestId) this.cancelledRequests.delete(requestId);
        }
      },
    );
    this.ipc.handle(
      "WorkspaceSearch:startStream",
      async (event, rootPath: string, query: string, options: SearchOptions = {}) => {
        const requestId = options?.requestId;
        if (requestId) this.cancelledRequests.delete(requestId);
        if (!(await this.isActiveWorkspaceRoot(rootPath)))
          return { success: false, error: "The requested workspace is not active." };
        await this.ensureWorkspaceStorage(rootPath);
        try {
          return this.startSearchStream(
            rootPath,
            query,
            options,
            (message) => {
              if (!event.sender.isDestroyed())
                event.sender.send("WorkspaceSearch:streamEvent", message);
            },
          );
        } finally {
          if (requestId) this.cancelledRequests.delete(requestId);
        }
      },
    );
    this.ipc.handle(
      "WorkspaceSearch:cancel",
      async (_event, requestId: string) => {
        this.cancelSearch(requestId);
        return true;
      },
    );
    this.ipc.handle(
      "WorkspaceSearch:replace",
      async (
        _event,
        rootPath: string,
        query: string,
        replacement: string,
        options: SearchOptions = {},
      ): Promise<ReplaceResponse> => {
        if (!(await this.isActiveWorkspaceRoot(rootPath)))
          return this.inactiveReplaceResponse();
        return this.replace(rootPath, query, replacement, options);
      },
    );
    this.ipc.handle(
      "WorkspaceSearch:projectMap",
      async (
        _event,
        rootPath: string,
        targetPath: string,
        options: ProjectMapOptions = {},
      ) => {
        const requestId = options?.requestId;
        if (requestId) this.cancelledRequests.delete(requestId);
        if (!(await this.isActiveWorkspaceRoot(rootPath)))
          return {
            success: false,
            root: "",
            entries: [],
            files: 0,
            directories: 0,
            truncated: false,
            maxDepth: 0,
            maxFiles: 0,
            inspectionBytes: 0,
            inspectionBudgetBytes: 0,
            inspectionSkippedFiles: 0,
            inspectionUnavailableFiles: 0,
            inspectionCacheHits: 0,
            indexedMetadataHits: 0,
            indexHit: false,
            cancelled: false,
            error: {
              code: "WORKSPACE_NOT_ACTIVE",
              message: "The requested workspace is not active.",
            },
          };
        try {
          await this.ensureWorkspaceStorage(rootPath);
          return await this.getProjectMap(rootPath, targetPath, options);
        } finally {
          if (requestId) this.cancelledRequests.delete(requestId);
        }
      },
    );
    this.ipc.handle(
      "WorkspaceSearch:projectFiles",
      async (_event, rootPath: string, options: ProjectFilesOptions = {}) => {
        if (!(await this.isActiveWorkspaceRoot(rootPath)))
          return {
            success: false,
            entries: [],
            indexHit: false,
            filesProbed: 0,
            error: {
              code: "WORKSPACE_NOT_ACTIVE",
              message: "The requested workspace is not active.",
            },
          };
        await this.ensureWorkspaceStorage(rootPath);
        return this.listProjectFiles(rootPath, options);
      },
    );
  }

  async listProjectFiles(
    rootPath: string,
    options: ProjectFilesOptions = {},
  ): Promise<ProjectFilesResponse> {
    const failure = (code: string, message: string): ProjectFilesResponse => ({
      success: false,
      entries: [],
      indexHit: false,
      filesProbed: 0,
      error: { code, message },
    });
    if (typeof rootPath !== "string" || !rootPath)
      return failure("INVALID_PATH", "A workspace is required.");
    const root = path.resolve(rootPath);
    try {
      if (!(await fs.stat(root)).isDirectory())
        return failure("NOT_A_DIRECTORY", "The workspace is not a directory.");
    } catch {
      return failure("DIRECTORY_NOT_FOUND", "The workspace was not found.");
    }

    const openableOnly = options?.openableOnly === true;
    const ignoreHiddenDirectories = options?.ignoreHiddenDirectories === true;
    if (openableOnly) {
      const index = await this.workspaceIndex.load(root, {
        freshness: "allow-stale-while-revalidate",
      });
      if (index) {
        const entries: ProjectFileEntry[] = [];
        for (const candidate of index.entries) {
          if (!candidate.openable) continue;
          const directories = ignoreHiddenDirectories
            ? candidate.relativePath.split("/").slice(0, -1)
            : [];
          if (directories.some((directory) => directory.startsWith(".")))
            continue;
          entries.push({
            name: candidate.name,
            path: path.join(root, ...candidate.relativePath.split("/")),
            relativePath: candidate.relativePath,
          });
        }
        return { success: true, entries, indexHit: true, filesProbed: 0 };
      }
    }

    const entries: ProjectFileEntry[] = [];
    let filesProbed = 0;
    const walk = async (directory: string): Promise<void> => {
      let children;
      try {
        children = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        if (child.isSymbolicLink()) continue;
        const absolutePath = path.join(directory, child.name);
        if (child.isDirectory()) {
          if (
            WORKSPACE_INDEX_IGNORED_DIRECTORIES.has(child.name) ||
            (ignoreHiddenDirectories && child.name.startsWith("."))
          ) continue;
          await walk(absolutePath);
          continue;
        }
        if (
          !child.isFile() ||
          path.extname(child.name).toLowerCase() === ".asar"
        )
          continue;
        if (openableOnly) {
          filesProbed += 1;
          if (!(await this.isOpenableFile(absolutePath))) continue;
        }
        entries.push({
          name: child.name,
          path: absolutePath,
          relativePath: this.normalizeRelative(
            path.relative(root, absolutePath),
          ),
        });
      }
    };
    await walk(root);
    this.workspaceIndex.scheduleBuild(root);
    return {
      success: true,
      entries,
      indexHit: false,
      filesProbed,
    };
  }

  private async isOpenableFile(filePath: string): Promise<boolean> {
    try {
      const stats = await fs.lstat(filePath);
      if (!stats.isFile() || stats.isSymbolicLink()) return false;
      return await isOpenableFileAtPath(filePath, stats.size);
    } catch {
      return false;
    }
  }

  async getProjectMap(
    rootPath: string,
    targetPath: string,
    options: ProjectMapOptions = {},
  ): Promise<ProjectMapResponse> {
    options = options && typeof options === "object" ? options : {};
    const requestId = typeof options.requestId === "string" && options.requestId
      ? options.requestId
      : undefined;
    try {
      return await this.buildProjectMap(rootPath, targetPath, options);
    } finally {
      if (requestId) this.cancelledRequests.delete(requestId);
    }
  }

  private async buildProjectMap(
    rootPath: string,
    targetPath: string,
    options: ProjectMapOptions,
  ): Promise<ProjectMapResponse> {
    rootPath = typeof rootPath === "string" ? rootPath : "";
    targetPath = typeof targetPath === "string" ? targetPath : "";
    const requestedDepth = Number.isFinite(options.maxDepth)
      ? Math.floor(options.maxDepth!)
      : 6;
    const requestedFiles = Number.isFinite(options.maxFiles)
      ? Math.floor(options.maxFiles!)
      : 1000;
    const requestedInspectionBytes = Number.isFinite(options.inspectionBudgetBytes)
      ? Math.floor(options.inspectionBudgetBytes!)
      : DEFAULT_PROJECT_MAP_INSPECTION_BYTES;
    const maxDepth = Math.min(
      20,
      Math.max(1, requestedDepth),
    );
    const maxFiles = Math.min(
      5000,
      Math.max(1, requestedFiles),
    );
    const inspectionBudgetBytes = Math.min(
      MAX_PROJECT_MAP_INSPECTION_BYTES,
      Math.max(0, requestedInspectionBytes),
    );
    const root = path.resolve(rootPath || "");
    const target = path.resolve(targetPath || root);
    const requestId = typeof options.requestId === "string" && options.requestId
      ? options.requestId
      : undefined;
    const isCancelled = (): boolean =>
      Boolean(requestId && this.cancelledRequests.has(requestId));
    let inspectionBytes = 0;
    let inspectionSkippedFiles = 0;
    let inspectionUnavailableFiles = 0;
    let inspectionCacheHits = 0;
    let indexedMetadataHits = 0;
    let indexHit = false;
    let cancelled = false;
    const empty = (code: string, message: string): ProjectMapResponse => ({
      success: false,
      root: "",
      entries: [],
      files: 0,
      directories: 0,
      truncated: false,
      maxDepth,
      maxFiles,
      inspectionBytes,
      inspectionBudgetBytes,
      inspectionSkippedFiles,
      inspectionUnavailableFiles,
      inspectionCacheHits,
      indexedMetadataHits,
      indexHit,
      cancelled,
      error: { code, message },
    });
    if (!rootPath || !this.isPathInside(root, target)) {
      return empty("INVALID_PATH", "Le chemin doit rester dans le workspace.");
    }
    let realRoot: string;
    let realTarget: string;
    try {
      [realRoot, realTarget] = await Promise.all([
        fs.realpath(root),
        fs.realpath(target),
      ]);
      if (!this.isPathInside(realRoot, realTarget)) {
        return empty(
          "INVALID_PATH",
          "Le chemin doit rester dans le workspace.",
        );
      }
      if (!(await fs.stat(realTarget)).isDirectory()) {
        return empty(
          "NOT_A_DIRECTORY",
          "Le chemin demandé n'est pas un dossier.",
        );
      }
    } catch {
      return empty(
        "DIRECTORY_NOT_FOUND",
        "Le dossier demandé est introuvable.",
      );
    }

    // The index supplies current size/mtime metadata for inspection caching;
    // filesystem traversal remains responsible for directory entries and
    // empty directories, and symlinked targets fall back to that traversal.
    const targetRelativeFromRoot = path.relative(root, target);
    const expectedRealTarget = path.resolve(realRoot, targetRelativeFromRoot);
    const indexSnapshot = path.resolve(expectedRealTarget) === path.resolve(realTarget)
      ? await this.workspaceIndex.load(root, { freshness: "require-current" })
      : null;
    indexHit = Boolean(indexSnapshot);

    const entries: ProjectMapEntry[] = [];
    const inspectionBuffer = Buffer.allocUnsafe(PROJECT_MAP_INSPECTION_BUFFER_BYTES);
    let files = 0;
    let directories = 0;
    let truncated = false;
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (isCancelled()) {
        cancelled = true;
        truncated = true;
        return;
      }
      let children;
      try {
        children = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      children.sort((left, right) => {
        const typeOrder = Number(left.isFile()) - Number(right.isFile());
        if (typeOrder) return typeOrder;
        return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
      });
      for (const child of children) {
        if (isCancelled()) {
          cancelled = true;
          truncated = true;
          return;
        }
        if (files >= maxFiles) {
          truncated = true;
          return;
        }
        if (child.isSymbolicLink()) continue;
        const absolutePath = path.join(directory, child.name);
        const relativePath = this.normalizeRelative(
          path.relative(target, absolutePath),
        );
        const workspacePath = this.normalizeRelative(
          path.relative(root, absolutePath),
        );
        if (child.isDirectory()) {
          if (WORKSPACE_INDEX_IGNORED_DIRECTORIES.has(child.name)) continue;
          directories += 1;
          entries.push({
            name: child.name,
            path: workspacePath,
            relativePath,
            type: "directory",
            depth,
            lineCount: null,
            binary: false,
          });
          if (depth >= maxDepth) {
            truncated = true;
          } else {
            await walk(absolutePath, depth + 1);
          }
          continue;
        }
        if (!child.isFile()) continue;
        const indexedMetadata = indexSnapshot
          ? this.findProjectMapIndexMetadata(indexSnapshot.entries, workspacePath)
          : undefined;
        const inspection = await this.inspectProjectMapFile(absolutePath, {
          authorizedRoot: realRoot,
          remainingBytes: Math.max(0, inspectionBudgetBytes - inspectionBytes),
          buffer: inspectionBuffer,
          indexedMetadata,
          isCancelled,
        });
        inspectionBytes += inspection.bytesRead;
        if (inspection.cacheHit) inspectionCacheHits += 1;
        if (indexedMetadata && inspection.indexMetadataMatched) indexedMetadataHits += 1;
        if (inspection.inspectionStatus === "budget-skipped") inspectionSkippedFiles += 1;
        if (
          inspection.inspectionStatus === "unavailable" ||
          inspection.inspectionStatus === "symlink-skipped"
        ) inspectionUnavailableFiles += 1;
        files += 1;
        entries.push({
          name: child.name,
          path: workspacePath,
          relativePath,
          type: "file",
          depth,
          lineCount: inspection.lineCount,
          binary: inspection.binary,
          inspectionStatus: inspection.inspectionStatus,
        });
        if (isCancelled() || inspection.inspectionStatus === "cancelled") {
          cancelled = true;
          truncated = true;
          return;
        }
      }
    };
    await walk(target, 1);
    return {
      success: true,
      root: this.normalizeRelative(path.relative(root, target)) || ".",
      entries,
      files,
      directories,
      truncated,
      maxDepth,
      maxFiles,
      inspectionBytes,
      inspectionBudgetBytes,
      inspectionSkippedFiles,
      inspectionUnavailableFiles,
      inspectionCacheHits,
      indexedMetadataHits,
      indexHit,
      cancelled,
    };
  }

  private isPathInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      )
    );
  }

  private findProjectMapIndexMetadata(
    entries: WorkspaceIndexEntry[],
    relativePath: string,
  ): WorkspaceIndexEntry | undefined {
    let low = 0;
    let high = entries.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const comparison = compareWorkspaceIndexPaths(
        entries[middle].relativePath,
        relativePath,
      );
      if (comparison === 0) return entries[middle];
      if (comparison < 0) low = middle + 1;
      else high = middle - 1;
    }
    return undefined;
  }

  protected async openProjectMapFile(filePath: string, flags: number) {
    return fs.open(filePath, flags);
  }

  private rememberProjectMapInspection(
    filePath: string,
    stats: Stats,
    inspection: ProjectMapInspection,
  ): void {
    if (
      inspection.inspectionStatus !== "exact" &&
      inspection.inspectionStatus !== "binary"
    ) return;
    const key = path.resolve(filePath);
    this.projectMapInspectionCache.delete(key);
    this.projectMapInspectionCache.set(key, {
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
      binary: inspection.binary,
      lineCount: inspection.lineCount,
      inspectionStatus: inspection.inspectionStatus,
    });
    while (this.projectMapInspectionCache.size > this.maxProjectMapInspectionCacheEntries) {
      const oldestPath = this.projectMapInspectionCache.keys().next().value;
      if (!oldestPath) break;
      this.projectMapInspectionCache.delete(oldestPath);
    }
  }

  protected async inspectProjectMapFile(
    filePath: string,
    options: {
      authorizedRoot: string;
      remainingBytes: number;
      buffer: Buffer;
      indexedMetadata?: WorkspaceIndexEntry;
      isCancelled: () => boolean;
    },
  ): Promise<ProjectMapInspection & { indexMetadataMatched: boolean }> {
    const unavailable = (
      status: "unavailable" | "symlink-skipped" | "cancelled" | "budget-skipped",
      bytesRead = 0,
      indexMetadataMatched = false,
    ) => ({
      binary: false,
      lineCount: null,
      inspectionStatus: status,
      bytesRead,
      cacheHit: false,
      indexMetadataMatched,
    });
    if (options.isCancelled()) return unavailable("cancelled");

    let handle;
    let position = 0;
    try {
      const lexicalStats = await fs.lstat(filePath);
      if (lexicalStats.isSymbolicLink()) return unavailable("symlink-skipped");
      if (!lexicalStats.isFile()) return unavailable("unavailable");
      const realPath = await fs.realpath(filePath);
      if (!this.isPathInside(options.authorizedRoot, realPath))
        return unavailable("symlink-skipped");
      const realStats = await fs.stat(realPath);
      if (
        !realStats.isFile() ||
        realStats.dev !== lexicalStats.dev ||
        realStats.ino !== lexicalStats.ino
      ) return unavailable("unavailable");

      const indexMetadataMatched = Boolean(
        options.indexedMetadata &&
        options.indexedMetadata.size === lexicalStats.size &&
        options.indexedMetadata.mtimeMs === lexicalStats.mtimeMs,
      );
      const cacheKey = path.resolve(filePath);
      const cached = this.projectMapInspectionCache.get(cacheKey);
      if (
        cached &&
        cached.dev === lexicalStats.dev &&
        cached.ino === lexicalStats.ino &&
        cached.size === lexicalStats.size &&
        cached.mtimeMs === lexicalStats.mtimeMs &&
        cached.ctimeMs === lexicalStats.ctimeMs &&
        (!options.indexedMetadata || indexMetadataMatched)
      ) {
        this.projectMapInspectionCache.delete(cacheKey);
        this.projectMapInspectionCache.set(cacheKey, cached);
        return {
          binary: cached.binary,
          lineCount: cached.lineCount,
          inspectionStatus: cached.inspectionStatus,
          bytesRead: 0,
          cacheHit: true,
          indexMetadataMatched,
        };
      }

      if (this.binaryExtensions.has(path.extname(filePath).toLowerCase())) {
        const inspection: ProjectMapInspection = {
          binary: true,
          lineCount: null,
          inspectionStatus: "binary",
          bytesRead: 0,
          cacheHit: false,
        };
        this.rememberProjectMapInspection(filePath, lexicalStats, inspection);
        return { ...inspection, indexMetadataMatched };
      }

      if (lexicalStats.size > 0 && options.remainingBytes <= 0)
        return unavailable("budget-skipped", 0, indexMetadataMatched);

      const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
        ? fsConstants.O_NOFOLLOW
        : 0;
      handle = await this.openProjectMapFile(
        filePath,
        fsConstants.O_RDONLY | noFollow,
      );
      const openedStats = await handle.stat();
      if (
        !openedStats.isFile() ||
        openedStats.dev !== lexicalStats.dev ||
        openedStats.ino !== lexicalStats.ino
      ) return unavailable("unavailable", 0, indexMetadataMatched);
      const openedPath = await fs.realpath(filePath);
      if (!this.isPathInside(options.authorizedRoot, openedPath))
        return unavailable("symlink-skipped", 0, indexMetadataMatched);
      const openedRealStats = await fs.stat(openedPath);
      if (
        openedRealStats.dev !== openedStats.dev ||
        openedRealStats.ino !== openedStats.ino
      ) return unavailable("unavailable", 0, indexMetadataMatched);

      const bytesToInspect = Math.min(lexicalStats.size, options.remainingBytes);
      let lineFeeds = 0;
      let lastByte: number | null = null;
      let foundBinaryMarker = false;
      while (position < bytesToInspect) {
        if (options.isCancelled()) return unavailable("cancelled", position, indexMetadataMatched);
        const beforeSampleEnd = position < PROJECT_MAP_BINARY_SAMPLE_BYTES;
        const sampleRemaining = beforeSampleEnd
          ? PROJECT_MAP_BINARY_SAMPLE_BYTES - position
          : options.buffer.length;
        const readLength = Math.min(
          options.buffer.length,
          sampleRemaining,
          bytesToInspect - position,
        );
        const { bytesRead } = await handle.read(
          options.buffer,
          0,
          readLength,
          position,
        );
        if (!bytesRead) break;
        for (let index = 0; index < bytesRead; index += 1) {
          if (
            position + index < PROJECT_MAP_BINARY_SAMPLE_BYTES &&
            options.buffer[index] === 0
          ) foundBinaryMarker = true;
          if (options.buffer[index] === 10) lineFeeds += 1;
        }
        position += bytesRead;
        lastByte = options.buffer[bytesRead - 1];
        if (foundBinaryMarker) break;
      }

      const afterStats = await handle.stat();
      if (
        afterStats.dev !== openedStats.dev ||
        afterStats.ino !== openedStats.ino ||
        afterStats.size !== openedStats.size ||
        afterStats.mtimeMs !== openedStats.mtimeMs ||
        afterStats.ctimeMs !== openedStats.ctimeMs
      ) return unavailable("unavailable", position, indexMetadataMatched);
      if (foundBinaryMarker) {
        const inspection: ProjectMapInspection = {
          binary: true,
          lineCount: null,
          inspectionStatus: "binary",
          bytesRead: position,
          cacheHit: false,
        };
        this.rememberProjectMapInspection(filePath, afterStats, inspection);
        return { ...inspection, indexMetadataMatched };
      }
      if (options.isCancelled())
        return unavailable("cancelled", position, indexMetadataMatched);
      if (position !== openedStats.size) {
        const budgetLimited = bytesToInspect < openedStats.size;
        return unavailable(
          budgetLimited ? "budget-skipped" : "unavailable",
          position,
          indexMetadataMatched,
        );
      }
      const inspection: ProjectMapInspection = {
        binary: false,
        lineCount: openedStats.size === 0
          ? 0
          : lineFeeds + (lastByte === 10 ? 0 : 1),
        inspectionStatus: "exact",
        bytesRead: position,
        cacheHit: false,
      };
      this.rememberProjectMapInspection(filePath, afterStats, inspection);
      return { ...inspection, indexMetadataMatched };
    } catch (error: any) {
      return unavailable(
        options.isCancelled() ? "cancelled" : "unavailable",
        position,
      );
    } finally {
      await handle?.close();
    }
  }

  private searchOptionsKey(options: SearchOptions): string {
    return JSON.stringify({
      include: options.include ?? "",
      exclude: options.exclude ?? "",
      caseSensitive: options.caseSensitive === true,
      useRegex: options.useRegex === true,
      wholeWord: options.wholeWord === true,
      ignoreHiddenDirectories: options.ignoreHiddenDirectories === true,
      maxMatches: options.maxMatches ?? this.maxResults,
    });
  }

  private emitSearchStreamMessage(
    session: SearchSession,
    fields: Pick<SearchStreamMessage, "type"> &
      Partial<Omit<SearchStreamMessage, "sessionId" | "workspaceGeneration" | "type">>,
  ): void {
    if (!session.streamEmitter) return;
    try {
      session.streamEmitter({
        sessionId: session.id,
        workspaceGeneration: session.workspaceGeneration,
        type: fields.type,
        results: fields.results,
        totalMatches: fields.totalMatches ?? session.totalMatches,
        filesSearched: fields.filesSearched ?? session.filesSearched,
        scannedFiles: fields.scannedFiles ?? session.scannedFiles,
        error: fields.error,
      });
    } catch (error) {
      console.error("Unable to send workspace search update:", error);
      session.streamEmitter = null;
      if (session.streamBatchTimer) clearTimeout(session.streamBatchTimer);
      if (session.streamProgressTimer) clearTimeout(session.streamProgressTimer);
      session.streamBatchTimer = null;
      session.streamProgressTimer = null;
      session.streamBatch = [];
    }
  }

  private flushSearchStreamBatch(session: SearchSession): void {
    if (session.streamBatchTimer) clearTimeout(session.streamBatchTimer);
    session.streamBatchTimer = null;
    if (!session.streamBatch.length || session.cancelled) return;
    const results = session.streamBatch.splice(0);
    this.emitSearchStreamMessage(session, { type: "batch", results });
  }

  private queueSearchStreamResult(session: SearchSession, result: SearchResult): void {
    if (
      !session.streamEmitter ||
      session.cancelled ||
      session.streamedResultCount >= session.streamLimit
    ) return;
    session.streamBatch.push(result);
    session.streamedResultCount++;
    session.cursor = Math.max(session.cursor, session.streamedResultCount);
    if (session.streamBatch.length >= 100) {
      this.flushSearchStreamBatch(session);
      return;
    }
    if (!session.streamBatchTimer) {
      session.streamBatchTimer = setTimeout(
        () => this.flushSearchStreamBatch(session),
        50,
      );
    }
  }

  private scheduleSearchStreamProgress(session: SearchSession): void {
    if (
      !session.streamEmitter ||
      session.streamProgressTimer ||
      session.cancelled
    ) return;
    session.streamProgressTimer = setTimeout(() => {
      session.streamProgressTimer = null;
      this.emitSearchStreamMessage(session, { type: "progress" });
    }, 100);
  }

  private replaySearchStreamResults(session: SearchSession): void {
    session.streamBatch = [];
    const results = session.results.slice(0, session.streamLimit);
    session.streamedResultCount = results.length;
    session.cursor = Math.max(session.cursor, results.length);
    for (let start = 0; start < results.length; start += 100) {
      this.emitSearchStreamMessage(session, {
        type: "batch",
        results: results.slice(start, start + 100),
      });
    }
  }

  private finishSearchStream(
    session: SearchSession,
    response: SearchResponse,
  ): void {
    if (session.cancelled || !session.streamEmitter) return;
    session.totalMatches = response.totalMatches;
    session.filesSearched = response.filesSearched;
    this.flushSearchStreamBatch(session);
    this.emitSearchStreamMessage(session, { type: "progress" });
    this.emitSearchStreamMessage(session, { type: "complete" });
    session.streamEmitter = null;
    if (session.streamProgressTimer) clearTimeout(session.streamProgressTimer);
    session.streamProgressTimer = null;
  }

  async startSearchStream(
    rootPath: string,
    query: string,
    options: SearchOptions,
    emit: (message: SearchStreamMessage) => void,
  ): Promise<{ success: boolean; sessionId?: string; error?: string }> {
    if (
      typeof options?.sessionId !== "string" || !options.sessionId ||
      typeof rootPath !== "string" || !rootPath ||
      typeof query !== "string" || !query
    ) return { success: false, error: "A workspace, query, and session are required." };

    const pending = this.search(rootPath, query, options);
    const session = this.searchSessions.get(options.sessionId.slice(0, 256));
    if (!session) return { success: false, error: "The workspace search session was cancelled." };
    session.streamEmitter = emit;
    const maxMatches = Math.min(
      this.maxResults,
      Math.max(1, Math.floor(options.maxMatches || this.maxResults)),
    );
    session.streamLimit = Math.min(
      maxMatches,
      Math.max(1, Math.floor(options.limit || 50)),
    );
    this.replaySearchStreamResults(session);
    void pending.then(
      (response) => this.finishSearchStream(session, response),
      (error) => {
        if (!session.cancelled) {
          if (session.streamBatchTimer) clearTimeout(session.streamBatchTimer);
          if (session.streamProgressTimer) clearTimeout(session.streamProgressTimer);
          session.streamBatchTimer = null;
          session.streamProgressTimer = null;
          session.streamBatch = [];
          this.emitSearchStreamMessage(session, {
            type: "error",
            error: error?.message || String(error),
          });
          session.streamEmitter = null;
        }
      },
    );
    return { success: true, sessionId: session.id };
  }

  private addSearchResult(
    results: SearchResult[],
    session: SearchSession | undefined,
    result: SearchResult,
    totalMatches: number,
  ): void {
    results.push(result);
    if (session) {
      session.results.push(result);
      session.totalMatches = totalMatches;
      this.queueSearchStreamResult(session, result);
    }
  }

  private cancelSession(session: SearchSession): void {
    if (session.cancelled) return;
    session.cancelled = true;
    session.abortController.abort();
    if (session.streamBatchTimer) clearTimeout(session.streamBatchTimer);
    if (session.streamProgressTimer) clearTimeout(session.streamProgressTimer);
    session.streamBatchTimer = null;
    session.streamProgressTimer = null;
    session.streamBatch = [];
    this.emitSearchStreamMessage(session, { type: "cancelled" });
    session.streamEmitter = null;
    session.results = [];
    this.searchSessions.delete(session.id);
  }

  private rememberCancelledSearchSession(sessionId: string): void {
    this.cancelledSearchSessions.set(sessionId, Date.now());
    while (this.cancelledSearchSessions.size > this.maxSearchSessions * 2) {
      const oldestId = this.cancelledSearchSessions.keys().next().value;
      if (!oldestId) break;
      this.cancelledSearchSessions.delete(oldestId);
    }
  }

  cancelSearch(requestId: string): void {
    if (typeof requestId !== "string" || !requestId) return;
    for (const controller of this.requestControllers.get(requestId) || [])
      controller.abort();
    const session = this.searchSessions.get(requestId);
    if (session) {
      this.cancelSession(session);
      this.rememberCancelledSearchSession(requestId);
      return;
    }
    if (requestId.startsWith("workspace-search-session-")) {
      this.rememberCancelledSearchSession(requestId);
      return;
    }
    this.cancelledRequests.add(requestId);
  }

  cleanupSearchSessions(now = Date.now()): void {
    for (const session of this.searchSessions.values()) {
      if (now - session.lastAccess >= this.searchSessionTtlMs) {
        this.cancelSession(session);
        this.rememberCancelledSearchSession(session.id);
      }
    }
    for (const [sessionId, cancelledAt] of this.cancelledSearchSessions) {
      if (now - cancelledAt >= this.searchSessionTtlMs)
        this.cancelledSearchSessions.delete(sessionId);
    }
  }

  async releaseWorkspace(rootPath: string): Promise<void> {
    if (typeof rootPath !== "string" || !rootPath.trim()) return;
    const root = path.resolve(rootPath);
    const pendingSearches: Promise<SearchResponse>[] = [];
    for (const session of [...this.searchSessions.values()]) {
      if (session.root !== root) continue;
      if (session.promise) pendingSearches.push(session.promise);
      this.cancelSession(session);
      this.rememberCancelledSearchSession(session.id);
    }
    await Promise.allSettled(pendingSearches);
    await this.workspaceIndex.release(root);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.activeControllers) controller.abort();
    for (const session of [...this.searchSessions.values()]) {
      this.cancelSession(session);
      this.rememberCancelledSearchSession(session.id);
    }
    this.searchSessions.clear();
    this.activeControllers.clear();
    this.requestControllers.clear();
    this.cancelledRequests.clear();
    this.cancelledSearchSessions.clear();
    if (this.regexExecutor) {
      await releaseWorkspaceRegexExecutor(this.regexExecutor);
      this.regexExecutor = null;
    }
    await this.workspaceIndex.dispose();
  }

  getSearchSessionStats(sessionId?: string): {
    activeSessions: number;
    directoriesVisited?: number;
    candidateFiles?: number;
    usedIndex?: boolean;
    filesRead?: number;
    scannedFiles?: number;
    resultCount?: number;
    cursor?: number;
    complete?: boolean;
    workspaceSessions?: number;
  } {
    const session = sessionId ? this.searchSessions.get(sessionId) : undefined;
    return {
      activeSessions: this.searchSessions.size,
      ...(session ? {
        directoriesVisited: session.directoriesVisited,
        candidateFiles: session.candidateFiles,
        usedIndex: session.usedIndex,
        filesRead: session.filesRead,
        scannedFiles: session.scannedFiles,
        resultCount: session.results.length,
        cursor: session.cursor,
        complete: session.complete,
        workspaceSessions: [...this.searchSessions.values()]
          .filter((candidate) => candidate.root === session.root).length,
      } : {}),
    };
  }

  private async searchWithSession(
    rootPath: string,
    query: string,
    options: SearchOptions,
  ): Promise<SearchResponse> {
    const sessionId = options.sessionId!.slice(0, 256);
    const root = path.resolve(rootPath);
    const requestedWorkspaceGeneration = Number(options.workspaceGeneration);
    const workspaceGeneration = Number.isFinite(requestedWorkspaceGeneration)
      ? Math.max(0, Math.floor(requestedWorkspaceGeneration))
      : 0;
    const optionsKey = this.searchOptionsKey(options);
    this.cleanupSearchSessions();

    const cancellationTime = this.cancelledSearchSessions.get(sessionId);
    if (cancellationTime !== undefined) {
      if (Date.now() - cancellationTime < this.searchSessionTtlMs)
        return this.emptySearchResponse(options);
      this.cancelledSearchSessions.delete(sessionId);
    }

    let session = this.searchSessions.get(sessionId);
    if (
      session &&
      (session.root !== root || session.query !== query ||
        session.optionsKey !== optionsKey ||
        session.workspaceGeneration !== workspaceGeneration)
    ) {
      this.cancelSession(session);
      session = undefined;
    }

    if (!session) {
      const rootSessionLimit = this.workspaceIndex
        .getPerformanceProfile(root).maxCachedSearchSessions;
      const sameRootSessions = [...this.searchSessions.values()]
        .filter((candidate) => candidate.root === root)
        .sort((left, right) => left.lastAccess - right.lastAccess);
      while (sameRootSessions.length >= rootSessionLimit) {
        const oldest = sameRootSessions.shift();
        if (!oldest) break;
        this.cancelSession(oldest);
        this.rememberCancelledSearchSession(oldest.id);
      }
      while (this.searchSessions.size >= this.maxSearchSessions) {
        const oldest = [...this.searchSessions.values()].sort(
          (left, right) => left.lastAccess - right.lastAccess,
        )[0];
        if (!oldest) break;
        this.cancelSession(oldest);
        this.rememberCancelledSearchSession(oldest.id);
      }
      const now = Date.now();
      session = {
        id: sessionId,
        root,
        query,
        optionsKey,
        workspaceGeneration,
        lastAccess: now,
        results: [],
        cursor: 0,
        totalMatches: 0,
        filesSearched: 0,
        scannedFiles: 0,
        candidateFiles: 0,
        directoriesVisited: 0,
        usedIndex: false,
        filesRead: 0,
        complete: false,
        cancelled: false,
        abortController: new AbortController(),
        promise: null,
        streamEmitter: null,
        streamLimit: 0,
        streamedResultCount: 0,
        streamBatch: [],
        streamBatchTimer: null,
        streamProgressTimer: null,
      };
      this.searchSessions.set(sessionId, session);
    }

    const activeSession = session!;
    activeSession.lastAccess = Date.now();
    if (!activeSession.complete && !activeSession.promise) {
      const maxMatches = Math.min(
        this.maxResults,
        Math.max(1, Math.floor(options.maxMatches || this.maxResults)),
      );
      const scanOptions: SearchOptions = {
        ...options,
        offset: 0,
        limit: maxMatches,
        maxMatches,
        sessionId: undefined,
        requestId: options.requestId,
      };
      const unregisterRequest = this.registerRequestController(
        options.requestId,
        activeSession.abortController,
      );
      activeSession.promise = this.searchUncached(
        root,
        query,
        scanOptions,
        activeSession,
        activeSession.abortController.signal,
      )
        .then((response) => {
          if (activeSession.abortController.signal.aborted && !activeSession.cancelled)
            this.cancelSession(activeSession);
          if (!activeSession.cancelled) {
            activeSession.results = response.results;
            activeSession.totalMatches = response.totalMatches;
            activeSession.filesSearched = response.filesSearched;
            activeSession.complete = true;
          }
          return response;
        })
        .finally(() => {
          unregisterRequest();
          activeSession.promise = null;
        });
    }
    if (activeSession.promise) {
      try {
        await activeSession.promise;
      } catch (error) {
        if (
          error instanceof WorkspaceRegexExecutionError &&
          error.code === "ABORTED"
        ) {
          if (!activeSession.cancelled) this.cancelSession(activeSession);
          return this.emptySearchResponse(options);
        }
        if (
          error instanceof WorkspaceRegexExecutionError &&
          error.code === "INVALID_REGEX"
        ) {
          activeSession.results = [];
          activeSession.totalMatches = 0;
          activeSession.filesSearched = 0;
          activeSession.complete = true;
          return this.emptySearchResponse(options);
        }
        throw error;
      }
    }

    if (activeSession.cancelled) return this.emptySearchResponse(options);
    activeSession.lastAccess = Date.now();
    const offset = Math.max(0, Math.floor(options.offset || 0));
    const maxMatches = Math.min(
      this.maxResults,
      Math.max(1, Math.floor(options.maxMatches || this.maxResults)),
    );
    const limit = Math.min(maxMatches, Math.max(1, Math.floor(options.limit || 50)));
    const results = activeSession.results.slice(offset, offset + limit);
    activeSession.cursor = Math.max(activeSession.cursor, offset + results.length);
    return {
      results,
      totalMatches: activeSession.totalMatches,
      filesSearched: activeSession.filesSearched,
      offset,
      limit,
      hasMore: offset + results.length < activeSession.totalMatches,
    };
  }

  private emptySearchResponse(options: SearchOptions): SearchResponse {
    return {
      results: [],
      totalMatches: 0,
      filesSearched: 0,
      offset: Math.max(0, Math.floor(options.offset || 0)),
      limit: Math.max(1, Math.floor(options.limit || 50)),
      hasMore: false,
    };
  }

  async search(
    rootPath: string,
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchResponse> {
    if (
      typeof options?.sessionId === "string" && options.sessionId &&
      typeof rootPath === "string" && rootPath &&
      typeof query === "string" && query && options && typeof options === "object"
    ) {
      return this.searchWithSession(rootPath, query, options);
    }
    const controller = new AbortController();
    const unregisterRequest = this.registerRequestController(
      options.requestId,
      controller,
    );
    try {
      return await this.searchUncached(
        rootPath,
        query,
        options,
        undefined,
        controller.signal,
      );
    } catch (error) {
      if (
        error instanceof WorkspaceRegexExecutionError &&
        (error.code === "ABORTED" || error.code === "INVALID_REGEX")
      ) return this.emptySearchResponse(options);
      throw error;
    } finally {
      unregisterRequest();
      if (options.requestId) this.cancelledRequests.delete(options.requestId);
    }
  }

  protected readSearchFile(filePath: string): Promise<Buffer> {
    return fs.readFile(filePath);
  }

  private async searchUncached(
    rootPath: string,
    query: string,
    options: SearchOptions = {},
    session?: SearchSession,
    signal?: AbortSignal,
  ): Promise<SearchResponse> {
    const empty: SearchResponse = {
      results: [],
      totalMatches: 0,
      filesSearched: 0,
      offset: 0,
      limit: 50,
      hasMore: false,
    };

    if (
      typeof rootPath !== "string" ||
      !rootPath ||
      typeof query !== "string" ||
      !query ||
      !options ||
      typeof options !== "object"
    ) {
      return empty;
    }

    const root = path.resolve(rootPath);

    try {
      const stat = await fs.stat(root);

      if (!stat.isDirectory()) {
        return empty;
      }
    } catch {
      return empty;
    }

    const matcher = this.createMatcher(query, options);

    if (!matcher) {
      return empty;
    }

    const includePatterns = this.splitPatterns(options.include);
    const excludePatterns = this.splitPatterns(options.exclude);
    const useMultilineMatcher = Boolean(
      options.useRegex && /(?:\\[nr]|[\r\n]|\[\^?[\\s\\S])/.test(query),
    );

    const results: SearchResult[] = [];
    const offset = Math.max(0, Math.floor(options.offset || 0));
    const maxMatches = Math.min(
      this.maxResults,
      Math.max(1, Math.floor(options.maxMatches || this.maxResults)),
    );
    const limit = Math.min(maxMatches, Math.max(1, Math.floor(options.limit || 50)));
    let totalMatches = 0;

    let filesSearched = 0;
    let indexSnapshot = null;
    if (!options.forceFilesystemScan) {
      indexSnapshot = await this.workspaceIndex.load(root, {
        freshness: "require-current",
      });
    }
    const indexRevision = indexSnapshot
      ? this.workspaceIndex.getRevision(root)
      : 0;

    const isSearchCancelled = (): boolean =>
      Boolean(
        session?.cancelled ||
        signal?.aborted ||
        (options.requestId && this.cancelledRequests.has(options.requestId)),
      );

    const scanCandidate = async (
      fullPath: string,
      relativePath: string,
      name: string,
    ): Promise<void> => {
      if (isSearchCancelled() || totalMatches >= maxMatches) return;
      let buffer: Buffer;
      try {
        const stat = await fs.lstat(fullPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxFileSize)
          return;
        if (session) session.filesRead++;
        buffer = await this.readSearchFile(fullPath);
        if (session) {
          session.scannedFiles++;
          this.scheduleSearchStreamProgress(session);
        }
      } catch {
        // The file may have disappeared between discovery and content read.
        return;
      }

      if (this.isBinary(buffer) || isSearchCancelled()) return;
      const content = buffer.toString("utf8");
      filesSearched++;
      if (session) session.filesSearched = filesSearched;
      const lines = content.split(/\r?\n/);
      const matches = await this.getRegexExecutor().findMatches(
        matcher,
        content,
        useMultilineMatcher,
        maxMatches - totalMatches,
        signal,
      );

      if (useMultilineMatcher) {
        const lineStarts = [0];
        for (let index = 0; index < content.length; index++) {
          if (content[index] === "\n") lineStarts.push(index + 1);
        }

        // Worker matches are yielded in increasing UTF-16 offset order, so a
        // single cursor locates all of them in O(lines + matches).
        let lineIndex = 0;
        for (const match of matches) {
          if (isSearchCancelled() || totalMatches >= maxMatches) return;
          totalMatches++;
          if (totalMatches <= offset || results.length >= limit) continue;
          while (
            lineIndex + 1 < lineStarts.length &&
            lineStarts[lineIndex + 1] <= match.index
          ) lineIndex++;
          const line = lines[lineIndex] || "";
          const column = match.index - lineStarts[lineIndex];
          const previewLength = Math.min(
            match.length,
            Math.max(0, line.length - column),
          );
          const preview = this.createPreview(line, column, previewLength);
          this.addSearchResult(results, session, {
            path: fullPath,
            relativePath,
            name,
            line: lineIndex + 1,
            column,
            preview: preview.text,
            matchStart: preview.matchStart,
            matchLength: match.length,
          }, totalMatches);
        }
        return;
      }

      for (const match of matches) {
        if (isSearchCancelled() || totalMatches >= maxMatches) return;
        totalMatches++;
        if (totalMatches <= offset || results.length >= limit) continue;
        const lineIndex = Math.max(0, (match.line || 1) - 1);
        const line = lines[lineIndex] || "";
        const column = match.column ?? match.index;
        const preview = this.createPreview(line, column, match.length);
        this.addSearchResult(results, session, {
          path: fullPath,
          relativePath,
          name,
          line: lineIndex + 1,
          column,
          preview: preview.text,
          matchStart: preview.matchStart,
          matchLength: match.length,
        }, totalMatches);
      }
    };

    const shouldScanCandidate = (relativePath: string): boolean =>
      !this.matchesAny(relativePath, excludePatterns) &&
      (includePatterns.length === 0 ||
        this.matchesAny(relativePath, includePatterns));

    let usedIndex = Boolean(indexSnapshot);
    if (session) session.usedIndex = usedIndex;
    if (indexSnapshot) {
      const candidates = indexSnapshot.entries
        .filter((entry) =>
          (!options.ignoreHiddenDirectories ||
            !entry.relativePath.split("/").slice(0, -1)
              .some((directory) => directory.startsWith("."))) &&
          shouldScanCandidate(entry.relativePath),
        );
      if (session) session.candidateFiles = candidates.length;
      for (const candidate of candidates) {
        if (isSearchCancelled() || totalMatches >= maxMatches) break;
        const fullPath = path.join(root, ...candidate.relativePath.split("/"));
        await scanCandidate(fullPath, candidate.relativePath, candidate.name);
      }
    } else {
      const walk = async (directory: string): Promise<void> => {
        if (session) session.directoriesVisited++;
        if (isSearchCancelled() || totalMatches >= maxMatches) return;
        let entries;
        try {
          entries = await fs.readdir(directory, { withFileTypes: true });
        } catch {
          return;
        }
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          if (isSearchCancelled() || totalMatches >= maxMatches) return;
          const fullPath = path.join(directory, entry.name);
          const relativePath = this.normalizeRelative(
            path.relative(root, fullPath),
          );
          if (entry.isDirectory()) {
            if (
              WORKSPACE_INDEX_IGNORED_DIRECTORIES.has(entry.name) ||
              (options.ignoreHiddenDirectories && entry.name.startsWith(".")) ||
              this.matchesAny(relativePath, excludePatterns)
            ) continue;
            await walk(fullPath);
            continue;
          }
          if (!entry.isFile() || path.extname(entry.name).toLowerCase() === ".asar")
            continue;
          if (!shouldScanCandidate(relativePath)) continue;
          if (session) session.candidateFiles++;
          await scanCandidate(fullPath, relativePath, entry.name);
        }
      };
      await walk(root);
      if (!options.forceFilesystemScan && !this.workspaceIndex.requiresReconcile(root))
        this.workspaceIndex.scheduleBuild(root);
    }

    if (
      indexSnapshot &&
      this.workspaceIndex.getRevision(root) !== indexRevision &&
      !isSearchCancelled()
    ) {
      await this.workspaceIndex.flushEvents(root);
      if (session) {
        if (session.streamBatchTimer) clearTimeout(session.streamBatchTimer);
        if (session.streamProgressTimer) clearTimeout(session.streamProgressTimer);
        session.streamBatchTimer = null;
        session.streamProgressTimer = null;
        session.streamBatch = [];
        session.results = [];
        session.cursor = 0;
        session.totalMatches = 0;
        session.filesSearched = 0;
        session.scannedFiles = 0;
        session.candidateFiles = 0;
        session.directoriesVisited = 0;
        session.filesRead = 0;
        session.usedIndex = false;
        session.streamedResultCount = 0;
        session.complete = false;
        if (session.streamEmitter)
          this.emitSearchStreamMessage(session, { type: "reset" });
      }
      return this.searchUncached(root, query, {
        ...options,
        forceFilesystemScan: true,
      }, session, signal);
    }

    if (signal?.aborted) {
      throw new WorkspaceRegexExecutionError(
        "ABORTED",
        "Workspace search was cancelled.",
      );
    }

    return {
      results,
      totalMatches,
      filesSearched,
      offset,
      limit,
      hasMore: offset + results.length < totalMatches,
    };
  }

  async replace(
    rootPath: string,
    query: string,
    replacement: string,
    options: SearchOptions = {},
  ): Promise<ReplaceResponse> {
    options = options && typeof options === "object" ? options : {};
    const response: ReplaceResponse = {
      success: false,
      filesChanged: 0,
      replacements: 0,
      filesScanned: 0,
      filesMatched: 0,
      skippedFiles: [],
      conflictedFiles: [],
      failedFiles: [],
      cancelled: false,
    };
    if (
      typeof rootPath !== "string" || !rootPath.trim() ||
      typeof query !== "string" || !query ||
      typeof replacement !== "string"
    ) {
      return { ...response, error: "Invalid replacement request." };
    }
    const root = path.resolve(rootPath);
    if (options.requestId) this.cancelledRequests.delete(options.requestId);
    const controller = new AbortController();
    const unregisterRequest = this.registerRequestController(
      options.requestId,
      controller,
    );
    try {
      const rootStats = await fs.stat(root);
      if (!rootStats.isDirectory()) {
        return { ...response, error: "The workspace is not a directory." };
      }
      const rootRealPath = await fs.realpath(root);
      const dirtyPaths = new Set(
        (Array.isArray(options.dirtyPaths) ? options.dirtyPaths : [])
          .filter((value): value is string => typeof value === "string")
          .map((value) => path.resolve(root, value)),
      );
      const regex = this.createReplacementRegex(
        query,
        options,
        Boolean(options.replaceFirst),
      );
      if (!regex) {
        return { ...response, error: "Invalid regular expression." };
      }
      await this.getRegexExecutor().findMatches(regex, "", true, 1, controller.signal);

      let candidatesProcessed = 0;
      for await (const candidate of this.iterateReplacementCandidates(
        root,
        options,
        controller,
      )) {
        if (this.replacementIsCancelled(controller, options.requestId)) {
          response.cancelled = true;
          break;
        }
        if (candidatesProcessed >= this.maxReplaceCandidates) {
          response.failedFiles.push({
            path: candidate.relativePath,
            code: "REPLACE_FILE_LIMIT_REACHED",
            message: `Replace All stopped after ${this.maxReplaceCandidates} files to keep the operation bounded.`,
          });
          response.error = "Replace All stopped at its file limit; remaining files were not processed.";
          break;
        }
        candidatesProcessed++;
        if (candidate.issue) {
          if (candidate.issue.code === "SYMLINK_SKIPPED") {
            response.skippedFiles.push(candidate.issue);
          } else {
            response.failedFiles.push(candidate.issue);
          }
          continue;
        }
        if (dirtyPaths.has(path.resolve(candidate.filePath))) {
          response.skippedFiles.push({
            path: candidate.relativePath,
            code: "DIRTY_EDITOR_BUFFER",
            message: "The file has unsaved editor changes and was not replaced.",
          });
          continue;
        }

        let snapshot: { buffer: Buffer; stats: Stats };
        try {
          const linkStats = await fs.lstat(candidate.filePath);
          if (linkStats.isSymbolicLink()) {
            response.skippedFiles.push({
              path: candidate.relativePath,
              code: "SYMLINK_SKIPPED",
              message: "Symbolic links are not replaced.",
            });
            continue;
          }
          if (!linkStats.isFile()) continue;
          if (!this.isPathInside(rootRealPath, await fs.realpath(candidate.filePath))) {
            response.skippedFiles.push({
              path: candidate.relativePath,
              code: "PATH_OUTSIDE_WORKSPACE",
              message: "The file resolves outside the workspace.",
            });
            continue;
          }
          if (linkStats.size > this.maxFileSize) {
            response.skippedFiles.push({
              path: candidate.relativePath,
              code: "FILE_TOO_LARGE",
              message: `The file exceeds the ${this.maxFileSize} byte replacement limit.`,
            });
            continue;
          }
          if ((linkStats.mode & 0o222) === 0) {
            response.skippedFiles.push({
              path: candidate.relativePath,
              code: "READ_ONLY_FILE",
              message: "The file has no write permission bits.",
            });
            continue;
          }
          if (this.binaryExtensions.has(path.extname(candidate.name).toLowerCase())) {
            response.skippedFiles.push({
              path: candidate.relativePath,
              code: "BINARY_FILE",
              message: "Binary files are not replaced.",
            });
            continue;
          }
          snapshot = await this.readReplacementSnapshot(candidate.filePath);
          await this.validateReplacementTarget(
            rootRealPath,
            candidate.filePath,
            snapshot.stats,
          );
        } catch (error) {
          const issue = this.toReplacementIssue(candidate, error);
          if (["FILE_TOO_LARGE", "PATH_OUTSIDE_WORKSPACE"].includes(issue.code)) {
            response.skippedFiles.push(issue);
          } else if (["ENOENT", "ELOOP", "FILE_CHANGED_ON_DISK"].includes(issue.code)) {
            response.conflictedFiles.push(issue);
          } else {
            response.failedFiles.push(issue);
          }
          continue;
        }

        if (this.isBinary(snapshot.buffer)) {
          response.skippedFiles.push({
            path: candidate.relativePath,
            code: "BINARY_FILE",
            message: "Binary files are not replaced.",
          });
          continue;
        }
        const content = snapshot.buffer.toString("utf8");
        if (!Buffer.from(content, "utf8").equals(snapshot.buffer)) {
          response.skippedFiles.push({
            path: candidate.relativePath,
            code: "INVALID_TEXT_ENCODING",
            message: "The file is not valid UTF-8 text.",
          });
          continue;
        }
        response.filesScanned++;

        try {
          const result = await this.getRegexExecutor().replace(
            regex,
            content,
            replacement,
            controller.signal,
          );
          if (this.replacementIsCancelled(controller, options.requestId)) {
            response.cancelled = true;
            break;
          }
          if (!result.replacements) continue;
          response.filesMatched++;
          await this.validateReplacementTarget(
            rootRealPath,
            candidate.filePath,
            snapshot.stats,
          );
          await this.writeReplacementFile(
            candidate.filePath,
            result.content,
            this.getReplacementFingerprint(snapshot.stats),
          );
          response.filesChanged++;
          response.replacements += result.replacements;
          if (this.replacementIsCancelled(controller, options.requestId)) {
            response.cancelled = true;
            break;
          }
        } catch (error) {
          const issue = this.toReplacementIssue(candidate, error);
          if (issue.code === "ABORTED") {
            response.cancelled = true;
            break;
          }
          if (error instanceof WorkspaceRegexExecutionError && !response.error) {
            response.error = error.message;
          }
          if (["ENOENT", "ELOOP", "FILE_CHANGED_ON_DISK", "PATH_OUTSIDE_WORKSPACE"].includes(issue.code)) {
            response.conflictedFiles.push(issue);
          } else {
            response.failedFiles.push(issue);
          }
        }
      }
      response.cancelled ||= this.replacementIsCancelled(controller, options.requestId);
      response.success = !response.cancelled &&
        response.skippedFiles.length === 0 &&
        response.conflictedFiles.length === 0 &&
        response.failedFiles.length === 0;
      return response;
    } catch (error) {
      return {
        ...response,
        error: error instanceof WorkspaceRegexExecutionError &&
            error.code === "INVALID_REGEX"
          ? "Invalid regular expression."
          : error instanceof WorkspaceRegexExecutionError && error.code === "ABORTED"
            ? undefined
            : error instanceof Error ? error.message : String(error),
        cancelled: error instanceof WorkspaceRegexExecutionError && error.code === "ABORTED" || response.cancelled,
      };
    } finally {
      unregisterRequest();
      if (options.requestId) this.cancelledRequests.delete(options.requestId);
    }
  }

  private replacementIsCancelled(
    controller: AbortController,
    requestId?: string,
  ): boolean {
    return controller.signal.aborted || Boolean(
      requestId && this.cancelledRequests.has(requestId),
    );
  }

  private async *iterateReplacementCandidates(
    root: string,
    options: SearchOptions,
    controller: AbortController,
  ): AsyncGenerator<ReplacementCandidate> {
    const includePatterns = this.splitPatterns(options.include);
    const excludePatterns = this.splitPatterns(options.exclude);
    const selectedPaths = Array.isArray(options.paths) && options.paths.length > 0
      ? new Set(options.paths
        .filter((value): value is string => typeof value === "string")
        .map((value) => path.resolve(root, value)))
      : null;
    const requestId = options.requestId;

    const shouldInclude = (relativePath: string, absolutePath: string): boolean =>
      (!selectedPaths || selectedPaths.has(absolutePath)) &&
      !this.matchesAny(relativePath, excludePatterns) &&
      (includePatterns.length === 0 || this.matchesAny(relativePath, includePatterns));

    const walk = async function* (
      search: WorkspaceSearch,
      directory: string,
    ): AsyncGenerator<ReplacementCandidate> {
      if (search.replacementIsCancelled(controller, requestId)) return;
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error: any) {
        const relativePath = search.normalizeRelative(path.relative(root, directory)) || ".";
        yield {
          filePath: directory,
          relativePath,
          name: path.basename(directory) || directory,
          issue: {
            path: relativePath,
            code: error?.code === "ENOENT" ? "DIRECTORY_CHANGED" : "DIRECTORY_READ_FAILED",
            message: error?.message || "The directory could not be read.",
          },
        };
        return;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (search.replacementIsCancelled(controller, requestId)) return;
        const filePath = path.join(directory, entry.name);
        const relativePath = search.normalizeRelative(path.relative(root, filePath));
        if (entry.isSymbolicLink()) {
          if (shouldInclude(relativePath, filePath)) {
            yield {
              filePath,
              relativePath,
              name: entry.name,
              issue: {
                path: relativePath,
                code: "SYMLINK_SKIPPED",
                message: "Symbolic links are not replaced.",
              },
            };
          }
          continue;
        }
        if (entry.isDirectory()) {
          if (
            WORKSPACE_INDEX_IGNORED_DIRECTORIES.has(entry.name) ||
            (options.ignoreHiddenDirectories && entry.name.startsWith(".")) ||
            search.matchesAny(relativePath, excludePatterns)
          ) continue;
          yield* walk(search, filePath);
          continue;
        }
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() === ".asar")
          continue;
        if (shouldInclude(relativePath, filePath)) {
          yield { filePath, relativePath, name: entry.name };
        }
      }
    };

    yield* walk(this, root);
  }

  private getReplacementFingerprint(stats: Stats): string {
    return `nonsymlink:${[
      stats.dev,
      stats.ino,
      stats.size,
      stats.mtimeMs,
      stats.ctimeMs,
    ].join(":")}`;
  }

  protected async readReplacementSnapshot(
    filePath: string,
  ): Promise<{ buffer: Buffer; stats: Stats }> {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
      ? fsConstants.O_NOFOLLOW
      : 0;
    const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
    try {
      const before = await handle.stat();
      if (!before.isFile()) {
        throw Object.assign(new Error("The target is not a regular file."), {
          code: "NOT_A_REGULAR_FILE",
        });
      }
      if (before.size > this.maxFileSize) {
        throw Object.assign(new Error("The file exceeds the replacement size limit."), {
          code: "FILE_TOO_LARGE",
        });
      }
      const bytes = Buffer.allocUnsafe(
        Math.min(this.maxFileSize + 1, before.size + 1),
      );
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const result = await handle.read(
          bytes,
          bytesRead,
          bytes.length - bytesRead,
          bytesRead,
        );
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      const after = await handle.stat();
      if (
        before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs || bytesRead !== after.size
      ) {
        throw Object.assign(new Error("The file changed while it was read."), {
          code: "FILE_CHANGED_ON_DISK",
        });
      }
      return { buffer: Buffer.from(bytes.subarray(0, bytesRead)), stats: after };
    } finally {
      await handle.close();
    }
  }

  private async validateReplacementTarget(
    rootRealPath: string,
    candidatePath: string,
    stats: Stats,
  ): Promise<void> {
    const current = await fs.lstat(candidatePath);
    if (
      current.isSymbolicLink() || !current.isFile() ||
      current.dev !== stats.dev || current.ino !== stats.ino ||
      current.size !== stats.size || current.mtimeMs !== stats.mtimeMs ||
      current.ctimeMs !== stats.ctimeMs
    ) {
      throw Object.assign(new Error("The file changed during replacement."), {
        code: "FILE_CHANGED_ON_DISK",
      });
    }
    const realPath = await fs.realpath(candidatePath);
    if (!this.isPathInside(rootRealPath, realPath)) {
      throw Object.assign(new Error("The file resolves outside the workspace."), {
        code: "PATH_OUTSIDE_WORKSPACE",
      });
    }
  }

  protected async writeReplacementFile(
    filePath: string,
    content: string,
    expectedFingerprint: string,
  ): Promise<void> {
    const fileManager = this.window?.fileManager;
    const saveFile = fileManager?.saveFile;
    if (typeof saveFile === "function") {
      const savedPath = await saveFile.call(
        fileManager,
        filePath,
        content,
        expectedFingerprint,
      );
      if (
        typeof savedPath !== "string" ||
        path.resolve(savedPath) !== path.resolve(filePath)
      ) {
        throw Object.assign(new Error("The replacement could not be persisted."), {
          code: "SAVE_FAILED",
        });
      }
      return;
    }
    await atomicWriteFile(filePath, content, fs, expectedFingerprint);
  }

  private toReplacementIssue(
    candidate: ReplacementCandidate,
    error: unknown,
  ): ReplaceFileIssue {
    const source = error as NodeJS.ErrnoException;
    return {
      path: candidate.relativePath,
      code: source?.code || "REPLACEMENT_FAILED",
      message: source?.message || String(error),
    };
  }

  private createReplacementRegex(
    query: string,
    options: SearchOptions,
    replaceFirst = false,
  ): WorkspaceRegexPattern | null {
    const flags = `${replaceFirst ? "" : "g"}${options.caseSensitive ? "" : "i"}u`;
    const character = "[\\p{L}\\p{N}\\p{M}\\p{Pc}]";
    const prefix = `(?<!${character})`;
    const suffix = `(?!${character})`;
    const source = options.useRegex ? query : query.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
    return {
      source: options.wholeWord ? `${prefix}(?:${source})${suffix}` : source,
      flags,
    };
  }

  private createMatcher(
    query: string,
    options: SearchOptions,
  ): WorkspaceRegexPattern | null {
    const flags = `${options.caseSensitive ? "g" : "gi"}u`;
    const wordCharacter = "[\\p{L}\\p{N}\\p{M}\\p{Pc}]";
    const wordBoundaryPrefix = `(?<!${wordCharacter})`;
    const wordBoundarySuffix = `(?!${wordCharacter})`;

    if (options.useRegex) {
      return {
        source: options.wholeWord
          ? `${wordBoundaryPrefix}(?:${query})${wordBoundarySuffix}`
          : query,
        flags,
      };
    }

    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const expression = options.wholeWord
      ? `${wordBoundaryPrefix}${escaped}${wordBoundarySuffix}`
      : escaped;

    return { source: expression, flags };
  }

  private splitPatterns(value?: string): string[] {
    if (typeof value !== "string" || !value) {
      return [];
    }

    return value
      .split(/[;,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private matchesAny(value: string, patterns: string[]): boolean {
    return patterns.some((pattern) => this.matchGlob(value, pattern));
  }

  private matchGlob(value: string, pattern: string): boolean {
    const normalizedValue = this.normalizeRelative(value);

    let normalizedPattern = this.normalizeRelative(pattern);

    if (normalizedPattern.startsWith("./")) {
      normalizedPattern = normalizedPattern.slice(2);
    }

    const hasWildcard = /[*?]/.test(normalizedPattern);
    const directoryPattern =
      normalizedPattern.endsWith("/") ||
      (!hasWildcard && !path.posix.extname(normalizedPattern));

    if (directoryPattern) {
      normalizedPattern = normalizedPattern.replace(/\/+$/, "");
    }

    const regexSource = normalizedPattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "§§GLOBSTAR_DIR§§")
      .replace(/\*\*/g, "§§DOUBLESTAR§§")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/§§DOUBLESTAR§§/g, ".*")
      .replace(/§§GLOBSTAR_DIR§§/g, "(?:.*/)?");

    const recursiveSuffix = directoryPattern ? "(?:/.*)?" : "";
    const regex = new RegExp(`^${regexSource}${recursiveSuffix}$`, "i");

    if (regex.test(normalizedValue)) {
      return true;
    }

    const basename = path.posix.basename(normalizedValue);

    return regex.test(basename);
  }

  private normalizeRelative(value: string): string {
    return value.replace(/\\/g, "/").replace(/^\/+/, "");
  }

  private isBinary(buffer: Buffer): boolean {
    const sampleLength = Math.min(buffer.length, 8192);

    for (let i = 0; i < sampleLength; i++) {
      if (buffer[i] === 0) {
        return true;
      }
    }

    return false;
  }

  private createPreview(
    line: string,
    matchIndex: number,
    matchLength: number,
  ): {
    text: string;
    matchStart: number;
  } {
    const maxLength = 180;
    const padding = 70;

    let start = Math.max(0, matchIndex - padding);

    let end = Math.min(line.length, matchIndex + matchLength + padding);

    if (end - start > maxLength) {
      const desiredStart = Math.max(0, matchIndex - Math.floor(maxLength / 2));

      start = desiredStart;

      end = Math.min(line.length, start + maxLength);
    }

    const text = line.slice(start, end);

    return {
      text,
      matchStart: matchIndex - start,
    };
  }
}
