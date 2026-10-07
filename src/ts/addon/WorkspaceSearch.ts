import { ipcMain } from "electron";
import { promises as fs } from "fs";
import path from "path";
import { Window } from "../Window";
import { NceWorkspaceStorage } from "./NceWorkspaceStorage";
import {
  WORKSPACE_INDEX_IGNORED_DIRECTORIES,
  WorkspaceIndex,
} from "./WorkspaceIndex";
import {
  isOpenableFileAtPath,
} from "./OpenableFile";

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
  promise: Promise<SearchResponse> | null;
  streamEmitter: ((message: SearchStreamMessage) => void) | null;
  streamLimit: number;
  streamedResultCount: number;
  streamBatch: SearchResult[];
  streamBatchTimer: ReturnType<typeof setTimeout> | null;
  streamProgressTimer: ReturnType<typeof setTimeout> | null;
}

interface ReplaceResponse {
  success: boolean;
  filesChanged: number;
  replacements: number;
  error?: string;
}

interface ProjectMapOptions {
  maxDepth?: number;
  maxFiles?: number;
}

interface ProjectMapEntry {
  name: string;
  path: string;
  relativePath: string;
  type: "file" | "directory";
  depth: number;
  lineCount: number | null;
  binary: boolean;
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
  private readonly searchSessions = new Map<string, SearchSession>();
  private readonly cancelledSearchSessions = new Map<string, number>();
  private readonly maxSearchSessions = 8;
  private readonly searchSessionTtlMs = 5 * 60 * 1000;

  private readonly maxFileSize = 5 * 1024 * 1024;
  private readonly maxResults = 50000;
  private readonly maxReplaceResults = 10000;
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

  constructor(window: Window) {
    this.window = window;
    this.workspaceIndex = new WorkspaceIndex();
  }

  private async ensureWorkspaceStorage(rootPath: string): Promise<void> {
    if (typeof rootPath !== "string" || !rootPath.trim()) return;
    try {
      await new NceWorkspaceStorage(rootPath).ensureStructure();
    } catch {}
  }

  handleIPC() {
    ipcMain.handle(
      "WorkspaceSearch:indexStats",
      async (_event, rootPath: unknown) => {
        if (typeof rootPath !== "string" || !rootPath.trim()) return null;
        const root = path.resolve(rootPath);
        this.workspaceIndex.scheduleBuild(root);
        return this.workspaceIndex.getStats(root);
      },
    );
    ipcMain.handle(
      "WorkspaceSearch:search",
      async (
        _event,
        rootPath: string,
        query: string,
        options: SearchOptions = {},
      ) => {
        const requestId = options?.requestId;
        if (requestId) this.cancelledRequests.delete(requestId);
        await this.ensureWorkspaceStorage(rootPath);
        try {
          return await this.search(rootPath, query, options);
        } finally {
          if (requestId) this.cancelledRequests.delete(requestId);
        }
      },
    );
    ipcMain.handle(
      "WorkspaceSearch:startStream",
      async (event, rootPath: string, query: string, options: SearchOptions = {}) => {
        const requestId = options?.requestId;
        if (requestId) this.cancelledRequests.delete(requestId);
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
    ipcMain.handle(
      "WorkspaceSearch:cancel",
      async (_event, requestId: string) => {
        this.cancelSearch(requestId);
        return true;
      },
    );
    ipcMain.handle(
      "WorkspaceSearch:replace",
      async (
        _event,
        rootPath: string,
        query: string,
        replacement: string,
        options: SearchOptions = {},
      ): Promise<ReplaceResponse> => this.replace(rootPath, query, replacement, options),
    );
    ipcMain.handle(
      "WorkspaceSearch:projectMap",
      async (
        _event,
        rootPath: string,
        targetPath: string,
        options: ProjectMapOptions = {},
      ) => {
        await this.ensureWorkspaceStorage(rootPath);
        return this.getProjectMap(rootPath, targetPath, options);
      },
    );
    ipcMain.handle(
      "WorkspaceSearch:projectFiles",
      async (_event, rootPath: string, options: ProjectFilesOptions = {}) => {
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
    rootPath = typeof rootPath === "string" ? rootPath : "";
    targetPath = typeof targetPath === "string" ? targetPath : "";
    const maxDepth = Math.min(
      20,
      Math.max(1, Math.floor(options.maxDepth ?? 6)),
    );
    const maxFiles = Math.min(
      5000,
      Math.max(1, Math.floor(options.maxFiles ?? 1000)),
    );
    const root = path.resolve(rootPath || "");
    const target = path.resolve(targetPath || root);
    const empty = (code: string, message: string): ProjectMapResponse => ({
      success: false,
      root: "",
      entries: [],
      files: 0,
      directories: 0,
      truncated: false,
      maxDepth,
      maxFiles,
      error: { code, message },
    });
    if (!rootPath || !this.isPathInside(root, target)) {
      return empty("INVALID_PATH", "Le chemin doit rester dans le workspace.");
    }
    try {
      const [realRoot, realTarget] = await Promise.all([
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

    const entries: ProjectMapEntry[] = [];
    let files = 0;
    let directories = 0;
    let truncated = false;
    const walk = async (directory: string, depth: number): Promise<void> => {
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
        const inspection = await this.inspectProjectMapFile(absolutePath);
        files += 1;
        entries.push({
          name: child.name,
          path: workspacePath,
          relativePath,
          type: "file",
          depth,
          lineCount: inspection.lineCount,
          binary: inspection.binary,
        });
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
    };
  }

  private isPathInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  }

  private async inspectProjectMapFile(
    filePath: string,
  ): Promise<{ binary: boolean; lineCount: number | null }> {
    if (this.binaryExtensions.has(path.extname(filePath).toLowerCase())) {
      return { binary: true, lineCount: null };
    }
    let handle;
    try {
      handle = await fs.open(filePath, "r");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      let lineFeeds = 0;
      let lastByte: number | null = null;
      let binary = false;
      while (true) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          position,
        );
        if (bytesRead === 0) break;
        const sampleLimit = Math.min(bytesRead, Math.max(0, 8192 - position));
        for (let index = 0; index < bytesRead; index += 1) {
          if (index < sampleLimit && buffer[index] === 0) binary = true;
          if (buffer[index] === 10) lineFeeds += 1;
        }
        if (binary) return { binary: true, lineCount: null };
        position += bytesRead;
        lastByte = buffer[bytesRead - 1];
      }
      return {
        binary: false,
        lineCount: position === 0 ? 0 : lineFeeds + (lastByte === 10 ? 0 : 1),
      };
    } catch {
      return { binary: false, lineCount: null };
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
      activeSession.promise = this.searchUncached(root, query, scanOptions, activeSession)
        .then((response) => {
          if (!activeSession.cancelled) {
            activeSession.results = response.results;
            activeSession.totalMatches = response.totalMatches;
            activeSession.filesSearched = response.filesSearched;
            activeSession.complete = true;
          }
          return response;
        })
        .finally(() => { activeSession.promise = null; });
    }
    if (activeSession.promise) await activeSession.promise;

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
    return this.searchUncached(rootPath, query, options);
  }

  protected readSearchFile(filePath: string): Promise<Buffer> {
    return fs.readFile(filePath);
  }

  private async searchUncached(
    rootPath: string,
    query: string,
    options: SearchOptions = {},
    session?: SearchSession,
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
        (options.requestId && this.cancelledRequests.has(options.requestId)),
      );

    const scanCandidate = async (
      fullPath: string,
      relativePath: string,
      name: string,
    ): Promise<void> => {
      if (isSearchCancelled() || totalMatches >= maxMatches) return;
      try {
        const stat = await fs.lstat(fullPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxFileSize)
          return;

        if (session) session.filesRead++;
        const buffer = await this.readSearchFile(fullPath);
        if (session) {
          session.scannedFiles++;
          this.scheduleSearchStreamProgress(session);
        }

        if (this.isBinary(buffer)) return;

        const content = buffer.toString("utf8");
        filesSearched++;
        if (session) session.filesSearched = filesSearched;
        const lines = content.split(/\r?\n/);

        if (useMultilineMatcher) {
          const matches = matcher(content);
          const lineStarts = [0];
          for (let index = 0; index < content.length; index++) {
            if (content[index] === "\n") lineStarts.push(index + 1);
          }

          for (const match of matches) {
            if (isSearchCancelled() || totalMatches >= maxMatches) return;
            totalMatches++;
            if (totalMatches <= offset || results.length >= limit) continue;
            let lineIndex = 0;
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

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
          if (isSearchCancelled() || totalMatches >= maxMatches) return;
          const line = lines[lineIndex];
          const matches = matcher(line);
          for (const match of matches) {
            if (isSearchCancelled()) return;
            totalMatches++;
            if (totalMatches <= offset || results.length >= limit) continue;
            const preview = this.createPreview(line, match.index, match.length);
            this.addSearchResult(results, session, {
              path: fullPath,
              relativePath,
              name,
              line: lineIndex + 1,
              column: match.index,
              preview: preview.text,
              matchStart: preview.matchStart,
              matchLength: match.length,
            }, totalMatches);
          }
        }
      } catch {
        // The file may have disappeared between discovery and content read.
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
      }, session);
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
    if (!rootPath || !query || typeof replacement !== "string") {
      return { success: false, filesChanged: 0, replacements: 0, error: "Invalid replacement request." };
    }

    const response = await this.search(rootPath, query, {
      ...options,
      limit: this.maxReplaceResults,
      maxMatches: this.maxReplaceResults,
    });
    const resultPaths = [...new Set(response.results.map((result) => result.path))];
    const paths = options.paths?.length
      ? resultPaths.filter((filePath) => options.paths?.includes(filePath))
      : resultPaths;
    const regex = this.createReplacementRegex(query, options, Boolean(options.replaceFirst));
    if (!regex) {
      return { success: false, filesChanged: 0, replacements: 0, error: "Invalid regular expression." };
    }

    let filesChanged = 0;
    let replacements = 0;
    for (const filePath of paths) {
      const content = await fs.readFile(filePath, "utf8");
      const matches = content.match(regex);
      if (!matches?.length) continue;
      const updated = content.replace(regex, replacement);
      const temporary = `${filePath}.nce-replace-${process.pid}-${Date.now()}`;
      await fs.writeFile(temporary, updated, "utf8");
      await fs.rename(temporary, filePath);
      filesChanged++;
      replacements += matches.length;
    }
    return { success: true, filesChanged, replacements };
  }

  private createReplacementRegex(query: string, options: SearchOptions, replaceFirst = false): RegExp | null {
    const flags = `${replaceFirst ? "" : "g"}${options.caseSensitive ? "" : "i"}u`;
    const character = "[\\p{L}\\p{N}\\p{M}\\p{Pc}]";
    const prefix = `(?<!${character})`;
    const suffix = `(?!${character})`;
    const source = options.useRegex ? query : query.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
    try {
      return new RegExp(options.wholeWord ? `${prefix}(?:${source})${suffix}` : source, flags);
    } catch {
      return null;
    }
  }

  private createMatcher(
    query: string,
    options: SearchOptions,
  ):
    | ((line: string) => {
        index: number;
        length: number;
      }[])
    | null {
    const flags = `${options.caseSensitive ? "g" : "gi"}u`;
    const wordCharacter = "[\\p{L}\\p{N}\\p{M}\\p{Pc}]";
    const wordBoundaryPrefix = `(?<!${wordCharacter})`;
    const wordBoundarySuffix = `(?!${wordCharacter})`;

    if (options.useRegex) {
      try {
        const regex = new RegExp(
          options.wholeWord
            ? `${wordBoundaryPrefix}(?:${query})${wordBoundarySuffix}`
            : query,
          flags,
        );

        return (line) => this.findAllMatches(regex, line);
      } catch {
        return null;
      }
    }

    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const expression = options.wholeWord
      ? `${wordBoundaryPrefix}${escaped}${wordBoundarySuffix}`
      : escaped;

    const regex = new RegExp(expression, flags);

    return (line) => this.findAllMatches(regex, line);
  }

  private findAllMatches(
    regex: RegExp,
    line: string,
  ): {
    index: number;
    length: number;
  }[] {
    const matches: {
      index: number;
      length: number;
    }[] = [];

    regex.lastIndex = 0;

    let match: RegExpExecArray | null;

    while ((match = regex.exec(line)) !== null) {
      const value = match[0];

      matches.push({
        index: match.index,
        length: value.length,
      });

      if (value.length === 0) {
        regex.lastIndex = this.advanceRegexIndexSafely(line, match.index);
      }
    }

    regex.lastIndex = 0;

    return matches;
  }

  private advanceRegexIndexSafely(value: string, utf16Offset: number): number {
    if (utf16Offset >= value.length) return value.length + 1;
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      const segmenter = new Intl.Segmenter(undefined, {
        granularity: "grapheme",
      });
      for (const segment of segmenter.segment(value)) {
        if (segment.index >= utf16Offset)
          return segment.index + segment.segment.length;
        if (segment.index + segment.segment.length > utf16Offset)
          return segment.index + segment.segment.length;
      }
    }
    const codePoint = value.codePointAt(utf16Offset);
    return (
      utf16Offset + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1)
    );
  }

  private splitPatterns(value?: string): string[] {
    if (!value) {
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
