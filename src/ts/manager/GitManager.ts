import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import type { PathAccess } from "./PathAccess";
import type { IpcHandlerRegistrar } from "./IpcRouter";
import { GitTaskQueue } from "./GitTaskQueue";

const DEFAULT_TIMEOUT_MS = 15_000;
const VERSION_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_OUTPUT_BYTES = 1024 * 1024;
const MAX_DIFF_FILE_BYTES = 1024 * 1024;
const MAX_UNTRACKED_PREVIEW_BYTES = 64 * 1024;
const MAX_COMMIT_MESSAGE_LENGTH = 10_000;
const MAX_DETAIL_LENGTH = 2_000;
const MAX_VERSION_BYTES = 4 * 1024 * 1024;
const DEFAULT_LOG_LIMIT = 50;
const MAX_LOG_LIMIT = 200;

export type GitErrorCode =
  | "GIT_NOT_FOUND"
  | "NOT_A_REPOSITORY"
  | "REPOSITORY_NOT_FOUND"
  | "PERMISSION_DENIED"
  | "INVALID_PATH"
  | "INVALID_ARGUMENT"
  | "EMPTY_COMMIT_MESSAGE"
  | "NOTHING_TO_COMMIT"
  | "GIT_IDENTITY_MISSING"
  | "GIT_HOOK_FAILED"
  | "GIT_COMMAND_FAILED"
  | "GIT_OUTPUT_LIMIT"
  | "GIT_TIMEOUT"
  | "OPERATION_CANCELLED";

export interface GitFailure {
  success: false;
  code: GitErrorCode;
  error: string;
}

export type GitResult<T> = ({ success: true } & T) | GitFailure;

export interface GitRepositoryInfo {
  root: string;
  gitDir: string;
}

export interface GitStatusBranch {
  name: string | null;
  oid: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface GitStatusEntry {
  path: string;
  originalPath: string | null;
  index: string | null;
  worktree: string | null;
  conflicted: boolean;
  kind: "untracked" | "added" | "modified" | "deleted" | "renamed" | "copied" | "conflicted";
}

export interface GitStatus {
  branch: GitStatusBranch;
  hasCommits: boolean;
  entries: GitStatusEntry[];
  merging: boolean;
  rebasing: boolean;
}

export interface GitDiffSummaryEntry {
  path: string;
  originalPath: string | null;
  added: number | null;
  deleted: number | null;
  binary: boolean;
}

export interface GitDiff {
  path: string;
  staged: boolean;
  available: boolean;
  reason?: "untracked" | "binary" | "too-large" | "no-changes";
  patch?: string;
  preview?: string;
  added?: number | null;
  deleted?: number | null;
}

export interface GitFileVersions {
  path: string;
  staged: boolean;
  oldContent: string;
  newContent: string;
  binary: boolean;
  tooLarge: boolean;
  untracked: boolean;
  deleted: boolean;
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
}

export interface GitLogEntry {
  hash: string;
  author: string;
  email: string;
  timestamp: number;
  subject: string;
}

interface GitManagerOptions {
  getWorkspaceRoot: () => string | null | undefined;
  pathAccess?: Pick<PathAccess, "isAuthorized">;
  gitPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxConcurrentCommands?: number;
  env?: NodeJS.ProcessEnv;
}

interface GitCommandOutput {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

interface GitRunFailure {
  ok: false;
  failure: GitFailure;
  outputLimit: boolean;
  exitCode?: number;
  stderr?: string;
}

type GitRunOutcome = { ok: true; output: GitCommandOutput } | GitRunFailure;

interface GitRunOptions {
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  allowExitCodes?: readonly number[];
  literalPaths?: boolean;
}

interface RepositoryContext {
  workspace: string;
  root: string;
}

function failure(code: GitErrorCode, error: string): GitFailure {
  return { success: false, code, error };
}

function validPathValue(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && !value.includes("\0");
}

function comparable(value: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  const relative = path.relative(comparable(root, platform), comparable(candidate, platform));
  return relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function trimmedDetail(output: GitCommandOutput): string | undefined {
  const text = output.stderr.toString("utf8").trim() || output.stdout.toString("utf8").trim();
  return text ? text.slice(0, MAX_DETAIL_LENGTH) : undefined;
}

/** Main-process Git integration for one NCE window. */
export class GitManager {
  private readonly getWorkspaceRoot: () => string | null | undefined;
  private readonly pathAccess?: Pick<PathAccess, "isAuthorized">;
  private readonly gitPath: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly extraEnv?: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform = process.platform;
  private readonly children = new Set<ChildProcess>();
  private readonly commandQueue: GitTaskQueue;
  private readonly mutationQueue = new GitTaskQueue(1);
  private readonly statusRequests = new Map<string, Promise<GitResult<{ status: GitStatus }>>>();
  private disposed = false;

  constructor(options: GitManagerOptions) {
    this.getWorkspaceRoot = options.getWorkspaceRoot;
    this.pathAccess = options.pathAccess;
    this.gitPath = options.gitPath || "git";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    this.extraEnv = options.env;
    this.commandQueue = new GitTaskQueue(options.maxConcurrentCommands ?? 2);
  }

  handleIPC(ipc: IpcHandlerRegistrar): void {
    ipc.handle("Git:isAvailable", async () => this.isGitAvailable());
    ipc.handle("Git:version", async () => this.getGitVersion());
    ipc.handle("Git:repository", async () => this.getRepository());
    ipc.handle("Git:isRepository", async () => this.isRepository());
    ipc.handle("Git:repositoryRoot", async () => this.getRepositoryRoot());
    ipc.handle("Git:status", async () => this.getStatus());
    ipc.handle("Git:diff", async (_event, filePath, options) =>
      this.getDiff(filePath, { staged: options?.staged === true }));
    ipc.handle("Git:fileVersions", async (_event, filePath, options) =>
      this.getFileVersions(filePath, {
        staged: options?.staged === true,
        originalPath: options?.originalPath,
      }));
    ipc.handle("Git:diffSummary", async (_event, options) =>
      this.getDiffSummary({ staged: options?.staged === true }));
    ipc.handle("Git:stage", async (_event, filePath) => this.stageFile(filePath));
    ipc.handle("Git:unstage", async (_event, filePath) => this.unstageFile(filePath));
    ipc.handle("Git:commit", async (_event, message) => this.commit(message));
    ipc.handle("Git:branches", async () => this.getBranches());
    ipc.handle("Git:currentBranch", async () => this.getCurrentBranch());
    ipc.handle("Git:log", async (_event, options) => this.getLog(options));
  }

  dispose(): void {
    this.disposed = true;
    for (const child of this.children) this.killProcessTree(child, "SIGKILL");
    this.children.clear();
  }

  async isGitAvailable(): Promise<boolean> {
    const result = await this.runGit(["--version"], {
      cwd: process.cwd(),
      timeoutMs: Math.min(VERSION_TIMEOUT_MS, this.timeoutMs),
    });
    return result.ok && result.output.code === 0;
  }

  async getGitVersion(): Promise<GitResult<{ version: string }>> {
    const result = await this.runGit(["--version"], {
      cwd: process.cwd(),
      timeoutMs: Math.min(VERSION_TIMEOUT_MS, this.timeoutMs),
    });
    if (!result.ok) return result.failure;
    const match = result.output.stdout.toString("utf8").match(/git version (\S+)/i);
    if (!match) return failure("GIT_COMMAND_FAILED", "Unable to read the Git version.");
    return { success: true, version: match[1] };
  }

  async getRepository(): Promise<GitResult<{ repository: GitRepositoryInfo }>> {
    const context = await this.resolveContext();
    if ("failure" in context) return context.failure;
    const gitDir = await this.runGit(["rev-parse", "--absolute-git-dir"], {
      cwd: context.root,
    });
    if (!gitDir.ok) return gitDir.failure;
    return {
      success: true,
      repository: {
        root: context.root,
        gitDir: gitDir.output.stdout.toString("utf8").trim(),
      },
    };
  }

  async isRepository(): Promise<boolean> {
    const context = await this.resolveContext();
    return !("failure" in context);
  }

  async getRepositoryRoot(): Promise<GitResult<{ root: string }>> {
    const context = await this.resolveContext();
    if ("failure" in context) return context.failure;
    return { success: true, root: context.root };
  }

  getStatus(): Promise<GitResult<{ status: GitStatus }>> {
    const key = this.getWorkspaceRoot() || "";
    const existing = this.statusRequests.get(key);
    if (existing) return existing;
    let request: Promise<GitResult<{ status: GitStatus }>>;
    request = this.getStatusNow().finally(() => {
      if (this.statusRequests.get(key) === request)
        this.statusRequests.delete(key);
    });
    this.statusRequests.set(key, request);
    return request;
  }

  private async getStatusNow(): Promise<GitResult<{ status: GitStatus }>> {
    const context = await this.resolveContext();
    if ("failure" in context) return context.failure;
    // NCE's own workspace state must never appear as user changes.
    const result = await this.runGit(
      [
        "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all",
        "--", ...this.scopePathspecs(context),
      ],
      { cwd: context.root },
    );
    if (!result.ok) return result.failure;
    let status: GitStatus;
    try {
      status = this.parseStatus(result.output.stdout);
    } catch (error: any) {
      return failure("GIT_COMMAND_FAILED", "Unable to parse the Git status output.");
    }
    const state = await this.readOperationState(context.root);
    return { success: true, status: { ...status, ...state } };
  }

  async getDiff(
    filePath: unknown,
    options: { staged?: boolean } = {},
  ): Promise<GitResult<GitDiff>> {
    const staged = options.staged === true;
    const target = await this.resolveFile(filePath);
    if ("failure" in target) return target.failure;
    const { root, relativePath, absolutePath } = target;
    const summary = await this.getFileNumstat(root, relativePath, staged);
    if ("failure" in summary) return summary.failure;
    if (summary.untracked) {
      if (staged)
        return { success: true, path: relativePath, staged, available: false, reason: "no-changes" };
      const preview = await this.readUntrackedPreview(absolutePath);
      if (preview.binary)
        return {
          success: true,
          path: relativePath,
          staged,
          available: false,
          reason: "binary",
        };
      return {
        success: true,
        path: relativePath,
        staged,
        available: false,
        reason: "untracked",
        preview: preview.text,
      };
    }
    if (summary.binary)
      return {
        success: true,
        path: relativePath,
        staged,
        available: false,
        reason: "binary",
        added: null,
        deleted: null,
      };
    if (!summary.found)
      return { success: true, path: relativePath, staged, available: false, reason: "no-changes" };
    const stats = await fs.stat(absolutePath).catch(() => null);
    if (stats?.isFile() && stats.size > MAX_DIFF_FILE_BYTES)
      return {
        success: true,
        path: relativePath,
        staged,
        available: false,
        reason: "too-large",
        added: summary.added,
        deleted: summary.deleted,
      };
    const patch = await this.runGit(
      [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        ...(staged ? ["--cached"] : []),
        "--",
        relativePath,
      ],
      {
        cwd: root,
        maxOutputBytes: MAX_DIFF_OUTPUT_BYTES,
        literalPaths: true,
      },
    );
    if (!patch.ok) {
      if (patch.outputLimit)
        return {
          success: true,
          path: relativePath,
          staged,
          available: false,
          reason: "too-large",
          added: summary.added,
          deleted: summary.deleted,
        };
      return patch.failure;
    }
    const text = patch.output.stdout.toString("utf8");
    if (!text.trim())
      return { success: true, path: relativePath, staged, available: false, reason: "no-changes" };
    return {
      success: true,
      path: relativePath,
      staged,
      available: true,
      patch: text,
      added: summary.added,
      deleted: summary.deleted,
    };
  }

  async getFileVersions(
    filePath: unknown,
    options: { staged?: boolean; originalPath?: unknown } = {},
  ): Promise<GitResult<GitFileVersions>> {
    const staged = options.staged === true;
    const target = await this.resolveFile(filePath);
    if ("failure" in target) return target.failure;
    const { root, relativePath, absolutePath } = target;
    const originalPath = this.sanitizeRepositoryPath(options.originalPath);
    if (options.originalPath != null && !originalPath)
      return failure("INVALID_PATH", "The original file path is invalid.");
    if (originalPath) {
      const originalAbsolute = path.resolve(root, originalPath);
      if (!isInside(target.workspace, originalAbsolute, this.platform))
        return failure("INVALID_PATH", "The original file must remain inside the authorized workspace.");
    }
    const tracked = await this.runGit(
      ["ls-files", "-z", "--", relativePath],
      { cwd: root, literalPaths: true },
    );
    if (!tracked.ok) return tracked.failure;
    const isTracked = tracked.output.stdout.length > 0;
    const empty = { content: "", binary: false, tooLarge: false, missing: false };
    let oldVersion = empty;
    let newVersion = empty;
    let untracked = false;
    let deleted = false;
    if (staged) {
      const reference = await this.readBlobVersion(root, `HEAD:${originalPath || relativePath}`);
      if ("failure" in reference) return reference.failure;
      oldVersion = reference;
      if (isTracked) {
        const index = await this.readBlobVersion(root, `:${relativePath}`);
        if ("failure" in index) return index.failure;
        newVersion = index;
        deleted = index.missing;
      } else {
        untracked = true;
      }
    } else {
      const working = await this.readWorkingVersion(absolutePath);
      if ("failure" in working) return working.failure;
      newVersion = working;
      deleted = working.missing;
      if (isTracked) {
        const index = await this.readBlobVersion(root, `:${relativePath}`);
        if ("failure" in index) return index.failure;
        oldVersion = index;
      } else {
        untracked = true;
      }
    }
    const binary = oldVersion.binary || newVersion.binary;
    const tooLarge = oldVersion.tooLarge || newVersion.tooLarge;
    return {
      success: true,
      path: relativePath,
      staged,
      oldContent: binary || tooLarge ? "" : oldVersion.content,
      newContent: binary || tooLarge ? "" : newVersion.content,
      binary,
      tooLarge,
      untracked,
      deleted,
    };
  }

  private sanitizeRepositoryPath(value: unknown): string | null {
    if (typeof value !== "string" || !value || value.includes("\0")) return null;
    if (value.startsWith("/") || /^[a-zA-Z]:/.test(value)) return null;
    const segments = value.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === ".."))
      return null;
    if (segments.some((segment) => this.isNceStateSegment(segment)))
      return null;
    return segments.join("/");
  }

  private isNceStateSegment(segment: string): boolean {
    return this.platform === "win32"
      ? segment.toLowerCase() === ".nce"
      : segment === ".nce";
  }

  private async readBlobVersion(
    root: string,
    spec: string,
  ): Promise<{ content: string; binary: boolean; tooLarge: boolean; missing: boolean } | { failure: GitFailure }> {
    const result = await this.runGit(
      ["show", spec],
      { cwd: root, maxOutputBytes: MAX_VERSION_BYTES + 1, allowExitCodes: [0, 128] },
    );
    if (!result.ok) return { failure: result.failure };
    if (result.output.code !== 0)
      return { content: "", binary: false, tooLarge: false, missing: true };
    return this.decodeVersion(result.output.stdout);
  }

  private async readWorkingVersion(
    absolutePath: string,
  ): Promise<{ content: string; binary: boolean; tooLarge: boolean; missing: boolean } | { failure: GitFailure }> {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(absolutePath, flags);
      const stats = await handle.stat();
      if (!stats.isFile()) return { content: "", binary: false, tooLarge: false, missing: true };
      if (stats.size > MAX_VERSION_BYTES)
        return { content: "", binary: false, tooLarge: true, missing: false };
      return this.decodeVersion(await handle.readFile());
    } catch (error: any) {
      if (error?.code === "ENOENT")
        return { content: "", binary: false, tooLarge: false, missing: true };
      if (error?.code === "ELOOP")
        return { failure: failure("INVALID_PATH", "The file changed into a symbolic link.") };
      if (error?.code === "EACCES" || error?.code === "EPERM")
        return { failure: failure("PERMISSION_DENIED", "The file cannot be read.") };
      return { failure: failure("GIT_COMMAND_FAILED", "The file cannot be read.") };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private decodeVersion(buffer: Buffer): {
    content: string;
    binary: boolean;
    tooLarge: boolean;
    missing: boolean;
  } {
    if (buffer.length > MAX_VERSION_BYTES)
      return { content: "", binary: false, tooLarge: true, missing: false };
    const binary = buffer.includes(0);
    return {
      content: binary ? "" : buffer.toString("utf8"),
      binary,
      tooLarge: false,
      missing: false,
    };
  }

  async getDiffSummary(
    options: { staged?: boolean } = {},
  ): Promise<GitResult<{ staged: boolean; files: GitDiffSummaryEntry[] }>> {
    const staged = options.staged === true;
    const context = await this.resolveContext();
    if ("failure" in context) return context.failure;
    const result = await this.runGit(
      [
        "diff", "--numstat", "-z", ...(staged ? ["--cached"] : []),
        "--", ...this.scopePathspecs(context),
      ],
      { cwd: context.root, maxOutputBytes: MAX_DIFF_OUTPUT_BYTES },
    );
    if (!result.ok) return result.failure;
    try {
      return {
        success: true,
        staged,
        files: this.parseNumstat(result.output.stdout),
      };
    } catch (error: any) {
      return failure("GIT_COMMAND_FAILED", "Unable to parse the Git diff summary.");
    }
  }

  stageFile(filePath: unknown): Promise<GitResult<{ path: string }>> {
    return this.mutationQueue.run(() => this.stageFileNow(filePath));
  }

  private async stageFileNow(filePath: unknown): Promise<GitResult<{ path: string }>> {
    const target = await this.resolveFile(filePath);
    if ("failure" in target) return target.failure;
    const result = await this.runGit(
      ["add", "--", target.relativePath],
      { cwd: target.root, literalPaths: true },
    );
    if (!result.ok) return result.failure;
    return { success: true, path: target.relativePath };
  }

  unstageFile(filePath: unknown): Promise<GitResult<{ path: string }>> {
    return this.mutationQueue.run(() => this.unstageFileNow(filePath));
  }

  private async unstageFileNow(filePath: unknown): Promise<GitResult<{ path: string }>> {
    const target = await this.resolveFile(filePath);
    if ("failure" in target) return target.failure;
    const head = await this.hasHeadCommit(target.root);
    if ("failure" in head) return head.failure;
    if (!head.found) {
      const staged = await this.runGit(
        ["ls-files", "-z", "--", target.relativePath],
        { cwd: target.root, literalPaths: true },
      );
      if (!staged.ok) return staged.failure;
      if (!staged.output.stdout.length)
        return failure("NOTHING_TO_COMMIT", "This file has no staged changes.");
      const removed = await this.runGit(
        ["rm", "--cached", "-q", "--", target.relativePath],
        { cwd: target.root, literalPaths: true },
      );
      if (!removed.ok) return removed.failure;
      return { success: true, path: target.relativePath };
    }
    const result = await this.runGit(
      ["reset", "-q", "--", target.relativePath],
      { cwd: target.root, literalPaths: true },
    );
    if (!result.ok) return result.failure;
    return { success: true, path: target.relativePath };
  }

  commit(message: unknown): Promise<GitResult<{ hash: string; summary: string }>> {
    return this.mutationQueue.run(() => this.commitNow(message));
  }

  private async commitNow(message: unknown): Promise<GitResult<{ hash: string; summary: string }>> {
    if (typeof message !== "string")
      return failure("INVALID_ARGUMENT", "The commit message must be a string.");
    if (!validPathValue(message))
      return failure("EMPTY_COMMIT_MESSAGE", "A commit message is required.");
    if (message.length > MAX_COMMIT_MESSAGE_LENGTH)
      return failure("INVALID_ARGUMENT", "The commit message is too long.");
    const context = await this.resolveContext();
    if ("failure" in context) return context.failure;
    const pathspecs = this.scopePathspecs(context);
    const staged = await this.runGit(
      ["diff", "--cached", "--quiet", "--", ...pathspecs],
      { cwd: context.root, allowExitCodes: [0, 1] },
    );
    if (!staged.ok) return staged.failure;
    if (staged.output.code === 0)
      return failure("NOTHING_TO_COMMIT", "There are no staged changes to commit.");
    const result = await this.runGit(
      ["commit", "-m", message, "--", ...pathspecs],
      { cwd: context.root },
    );
    if (!result.ok) {
      const stderr = result.stderr || "";
      if (/Please tell me who you are|auto-detect email address|empty ident name/i.test(stderr))
        return failure("GIT_IDENTITY_MISSING", "Git needs an author name and email before it can commit.");
      if (result.exitCode === 1 || /hook/i.test(stderr))
        return failure("GIT_HOOK_FAILED", "A Git hook rejected the commit.");
      return result.failure;
    }
    const head = await this.runGit(["rev-parse", "HEAD"], { cwd: context.root });
    if (!head.ok) return head.failure;
    const subject = await this.runGit(
      ["log", "-1", "--format=%s"],
      { cwd: context.root },
    );
    return {
      success: true,
      hash: head.output.stdout.toString("utf8").trim(),
      summary: subject.ok ? subject.output.stdout.toString("utf8").trim() : "",
    };
  }

  async getBranches(): Promise<GitResult<{ branches: GitBranchInfo[]; current: string | null }>> {
    const context = await this.resolveContext();
    if ("failure" in context) return context.failure;
    const result = await this.runGit(
      ["for-each-ref", "--format=%(HEAD)%09%(refname:short)", "refs/heads"],
      { cwd: context.root },
    );
    if (!result.ok) return result.failure;
    const branches: GitBranchInfo[] = [];
    for (const line of result.output.stdout.toString("utf8").split("\n")) {
      if (!line) continue;
      const [marker, name] = line.split("\t");
      if (!name) continue;
      branches.push({ name, current: marker === "*" });
    }
    return {
      success: true,
      branches,
      current: branches.find(branch => branch.current)?.name || null,
    };
  }

  async getCurrentBranch(): Promise<GitResult<{ branch: string | null }>> {
    const context = await this.resolveContext();
    if ("failure" in context) return context.failure;
    const result = await this.runGit(
      ["symbolic-ref", "-q", "--short", "HEAD"],
      { cwd: context.root, allowExitCodes: [0, 1] },
    );
    if (!result.ok) return result.failure;
    return {
      success: true,
      branch: result.output.code === 0
        ? result.output.stdout.toString("utf8").trim()
        : null,
    };
  }

  async getLog(
    options: { limit?: unknown; skip?: unknown } = {},
  ): Promise<GitResult<{ commits: GitLogEntry[]; limit: number; skip: number }>> {
    const limit = this.readInteger(options?.limit, DEFAULT_LOG_LIMIT, 1, MAX_LOG_LIMIT);
    const skip = this.readInteger(options?.skip, 0, 0, 1_000_000);
    if (limit === null || skip === null)
      return failure("INVALID_ARGUMENT", "Invalid Git log pagination.");
    const context = await this.resolveContext();
    if ("failure" in context) return context.failure;
    const head = await this.hasHeadCommit(context.root);
    if ("failure" in head) return head.failure;
    if (!head.found) return { success: true, commits: [], limit, skip };
    const result = await this.runGit(
      [
        "log",
        `--max-count=${limit}`,
        `--skip=${skip}`,
        "--format=%H%x00%an%x00%ae%x00%at%x00%s",
      ],
      { cwd: context.root },
    );
    if (!result.ok) return result.failure;
    const commits: GitLogEntry[] = [];
    for (const line of result.output.stdout.toString("utf8").split("\n")) {
      if (!line) continue;
      const [hash, author, email, timestamp, subject] = line.split("\0");
      if (!hash || timestamp === undefined) continue;
      commits.push({
        hash,
        author: author || "",
        email: email || "",
        timestamp: Number(timestamp) || 0,
        subject: subject || "",
      });
    }
    return { success: true, commits, limit, skip };
  }

  private scopePathspecs(context: RepositoryContext): string[] {
    const scope = comparable(context.root, this.platform) === comparable(context.workspace, this.platform)
      ? "."
      : path.relative(context.root, context.workspace).split(path.sep).join("/");
    return [`:(literal)${scope}`, ":(exclude,glob)**/.nce/**"];
  }

  private async resolveContext(): Promise<RepositoryContext | { failure: GitFailure }> {
    if (this.disposed)
      return { failure: failure("OPERATION_CANCELLED", "The Git manager was disposed.") };
    const raw = this.getWorkspaceRoot();
    if (!validPathValue(raw))
      return { failure: failure("NOT_A_REPOSITORY", "No workspace is open.") };
    let workspace: string;
    try {
      workspace = await fs.realpath(raw.trim());
      if (!(await fs.stat(workspace)).isDirectory())
        return { failure: failure("REPOSITORY_NOT_FOUND", "The workspace folder is not available.") };
    } catch (error: any) {
      if (error?.code === "EACCES" || error?.code === "EPERM")
        return { failure: failure("PERMISSION_DENIED", "The workspace folder cannot be accessed.") };
      return { failure: failure("REPOSITORY_NOT_FOUND", "The workspace folder is not available.") };
    }
    if (this.pathAccess &&
        !(await this.pathAccess.isAuthorized(workspace, { requireDirectory: true })))
      return { failure: failure("INVALID_PATH", "The workspace is not authorized.") };
    const toplevel = await this.runGit(
      ["rev-parse", "--show-toplevel"],
      { cwd: workspace, allowExitCodes: [0, 128] },
    );
    if (!toplevel.ok) return { failure: toplevel.failure };
    if (toplevel.output.code !== 0) {
      const stderr = toplevel.output.stderr.toString("utf8");
      if (/dubious ownership/i.test(stderr))
        return { failure: failure("PERMISSION_DENIED", "Git refuses this repository because of its ownership.") };
      return { failure: failure("NOT_A_REPOSITORY", "The workspace is not inside a Git repository.") };
    }
    const root = toplevel.output.stdout.toString("utf8").trim();
    if (!root)
      return { failure: failure("NOT_A_REPOSITORY", "The workspace is not inside a Git repository.") };
    let rootReal: string;
    try {
      rootReal = await fs.realpath(root);
    } catch {
      return { failure: failure("REPOSITORY_NOT_FOUND", "The repository folder is not available.") };
    }
    return { workspace, root: rootReal };
  }

  private async resolveFile(
    filePath: unknown,
  ): Promise<(RepositoryContext & { absolutePath: string; relativePath: string }) | { failure: GitFailure }> {
    if (!validPathValue(filePath))
      return { failure: failure("INVALID_PATH", "A valid file path is required.") };
    const context = await this.resolveContext();
    if ("failure" in context) return context;
    const resolved = path.resolve(filePath.trim());
    if (!path.isAbsolute(resolved))
      return { failure: failure("INVALID_PATH", "The file path must be absolute.") };
    const absolutePath = await this.canonical(resolved);
    if (!absolutePath)
      return { failure: failure("INVALID_PATH", "The file path cannot be resolved.") };
    if (!isInside(context.workspace, absolutePath, this.platform) ||
        !isInside(context.root, absolutePath, this.platform))
      return { failure: failure("INVALID_PATH", "The file must remain inside the authorized workspace.") };
    const relativePath = path.relative(context.root, absolutePath)
      .split(path.sep)
      .join("/");
    if (!relativePath)
      return { failure: failure("INVALID_PATH", "The repository root is not a file.") };
    if (relativePath.split("/").some((segment) => this.isNceStateSegment(segment)))
      return { failure: failure("INVALID_PATH", "NCE workspace state cannot be used as a file.") };
    return { ...context, absolutePath, relativePath };
  }

  private async canonical(value: string): Promise<string | null> {
    try {
      return await fs.realpath(value);
    } catch (error: any) {
      if (error?.code !== "ENOENT") return null;
      try {
        const parent = await fs.realpath(path.dirname(value));
        return path.join(parent, path.basename(value));
      } catch {
        return null;
      }
    }
  }

  private async hasHeadCommit(cwd: string): Promise<{ found: boolean } | { failure: GitFailure }> {
    const result = await this.runGit(
      ["rev-parse", "--verify", "-q", "HEAD"],
      { cwd, allowExitCodes: [0, 1] },
    );
    if (!result.ok) return { failure: result.failure };
    return { found: result.output.code === 0 };
  }

  private async readOperationState(root: string): Promise<{ merging: boolean; rebasing: boolean }> {
    const result = await this.runGit(
      ["rev-parse", "--git-path", "MERGE_HEAD", "--git-path", "rebase-merge", "--git-path", "rebase-apply"],
      { cwd: root, timeoutMs: Math.min(VERSION_TIMEOUT_MS, this.timeoutMs) },
    );
    if (!result.ok) return { merging: false, rebasing: false };
    const [mergeHead, rebaseMerge, rebaseApply] =
      result.output.stdout.toString("utf8").split("\n");
    const exists = async (value?: string) => {
      if (!value) return false;
      try { await fs.access(path.resolve(root, value)); return true; }
      catch { return false; }
    };
    return {
      merging: await exists(mergeHead),
      rebasing: (await exists(rebaseMerge)) || (await exists(rebaseApply)),
    };
  }

  private parseStatus(output: Buffer): GitStatus {
    const chunks = output.toString("utf8").split("\0");
    const headers: string[] = [];
    const entries: GitStatusEntry[] = [];
    for (let position = 0; position < chunks.length; position++) {
      const record = chunks[position];
      if (!record) continue;
      if (record.startsWith("# ")) {
        headers.push(record.slice(2));
        continue;
      }
      const type = record[0];
      if (type === "1" || type === "u") {
        const parsed = this.parseEntry(record);
        if (parsed) entries.push(parsed);
      } else if (type === "2") {
        const parsed = this.parseEntry(record);
        const originalPath = chunks[position + 1] ?? null;
        position += 1;
        if (parsed) entries.push({ ...parsed, originalPath });
      } else if (type === "?") {
        entries.push({
          path: record.slice(2),
          originalPath: null,
          index: null,
          worktree: "?",
          conflicted: false,
          kind: "untracked",
        });
      }
    }
    const header = (name: string) =>
      headers.find(line => line.startsWith(`${name} `))?.slice(name.length + 1) ?? null;
    const oid = header("branch.oid");
    const head = header("branch.head");
    const upstream = header("branch.upstream");
    const ab = header("branch.ab");
    const aheadBehind = ab?.match(/\+(\d+)\s+-(\d+)/);
    return {
      branch: {
        name: head && head !== "(detached)" ? head : null,
        oid: oid && oid !== "(initial)" ? oid : null,
        detached: head === "(detached)",
        upstream,
        ahead: aheadBehind ? Number(aheadBehind[1]) : 0,
        behind: aheadBehind ? Number(aheadBehind[2]) : 0,
      },
      hasCommits: Boolean(oid && oid !== "(initial)"),
      entries,
      merging: false,
      rebasing: false,
    };
  }

  private parseEntry(record: string): GitStatusEntry | null {
    const type = record[0];
    const fixed = type === "u" ? 9 : type === "2" ? 8 : 7;
    const fields: string[] = [];
    let cursor = 2;
    for (let index = 0; index < fixed; index++) {
      const next = record.indexOf(" ", cursor);
      if (next === -1) return null;
      fields.push(record.slice(cursor, next));
      cursor = next + 1;
    }
    const xy = fields[0] || "..";
    const entryPath = record.slice(cursor);
    if (!entryPath) return null;
    const indexStatus = xy[0] === "." ? null : xy[0];
    const worktreeStatus = xy[1] === "." ? null : xy[1];
    const conflicted = type === "u";
    let kind: GitStatusEntry["kind"] = "modified";
    if (conflicted) kind = "conflicted";
    else if (indexStatus === "R" || worktreeStatus === "R") kind = "renamed";
    else if (indexStatus === "C" || worktreeStatus === "C") kind = "copied";
    else if (indexStatus === "A" || worktreeStatus === "A") kind = "added";
    else if (indexStatus === "D" || worktreeStatus === "D") kind = "deleted";
    return {
      path: entryPath,
      originalPath: null,
      index: indexStatus,
      worktree: worktreeStatus,
      conflicted,
      kind,
    };
  }

  private async getFileNumstat(
    root: string,
    relativePath: string,
    staged: boolean,
  ): Promise<
    | { found: boolean; untracked: boolean; binary: boolean; added: number | null; deleted: number | null }
    | { failure: GitFailure }
  > {
    const tracked = await this.runGit(
      ["ls-files", "-z", "--", relativePath],
      { cwd: root, literalPaths: true },
    );
    if (!tracked.ok) return { failure: tracked.failure };
    if (!tracked.output.stdout.length)
      return { found: false, untracked: true, binary: false, added: null, deleted: null };
    const result = await this.runGit(
      ["diff", "--numstat", "-z", ...(staged ? ["--cached"] : []), "--", relativePath],
      { cwd: root, maxOutputBytes: MAX_DIFF_OUTPUT_BYTES, literalPaths: true },
    );
    if (!result.ok) return { failure: result.failure };
    const entry = this.parseNumstat(result.output.stdout)
      .find(file => file.path === relativePath);
    if (!entry)
      return { found: false, untracked: false, binary: false, added: null, deleted: null };
    return {
      found: true,
      untracked: false,
      binary: entry.binary,
      added: entry.added,
      deleted: entry.deleted,
    };
  }

  private parseNumstat(output: Buffer): GitDiffSummaryEntry[] {
    const chunks = output.toString("utf8").split("\0");
    const files: GitDiffSummaryEntry[] = [];
    for (let index = 0; index < chunks.length; index++) {
      const record = chunks[index];
      if (!record) continue;
      const firstTab = record.indexOf("\t");
      const secondTab = record.indexOf("\t", firstTab + 1);
      if (firstTab < 0 || secondTab < 0) continue;
      const addedRaw = record.slice(0, firstTab);
      const deletedRaw = record.slice(firstTab + 1, secondTab);
      const pathField = record.slice(secondTab + 1);
      const added = addedRaw === "-" ? null : Number(addedRaw);
      const deleted = deletedRaw === "-" ? null : Number(deletedRaw);
      const binary = added === null || deleted === null;
      if (pathField) {
        files.push({ path: pathField, originalPath: null, added, deleted, binary });
        continue;
      }
      const originalPath = chunks[index + 1] ?? null;
      const targetPath = chunks[index + 2] ?? null;
      index += 2;
      if (!targetPath) continue;
      files.push({ path: targetPath, originalPath, added, deleted, binary });
    }
    return files;
  }

  private async readUntrackedPreview(
    absolutePath: string,
  ): Promise<{ text?: string; binary: boolean }> {
    try {
      const handle = await fs.open(absolutePath, "r");
      try {
        const buffer = Buffer.alloc(MAX_UNTRACKED_PREVIEW_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const slice = buffer.subarray(0, bytesRead);
        if (slice.includes(0)) return { binary: true };
        return { text: slice.toString("utf8"), binary: false };
      } finally {
        await handle.close();
      }
    } catch {
      return { binary: false };
    }
  }

  private readInteger(
    value: unknown,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number | null {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
    if (value < minimum || value > maximum) return null;
    return value;
  }

  private runGit(args: string[], options: GitRunOptions): Promise<GitRunOutcome> {
    return this.commandQueue.run(() => this.runGitCommand(args, options));
  }

  private buildGitEnvironment(literalPaths: boolean): NodeJS.ProcessEnv {
    // Never inherit repository/object/config redirections from the launch environment.
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
    }
    Object.assign(env, this.extraEnv);
    for (const key of [
      "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE",
      "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_PREFIX",
    ]) delete env[key];
    env.LC_ALL = "C";
    env.GIT_TERMINAL_PROMPT = "0";
    env.GIT_OPTIONAL_LOCKS = "0";
    if (literalPaths) env.GIT_LITERAL_PATHSPECS = "1";
    else delete env.GIT_LITERAL_PATHSPECS;
    return env;
  }

  private killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) return;
    if (this.platform === "win32") {
      try { child.kill(signal); } catch {}
      if (signal === "SIGKILL") {
        try {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
          killer.on("error", () => {});
          killer.unref();
        } catch {}
      }
      return;
    }
    try { process.kill(-child.pid, signal); }
    catch { try { child.kill(signal); } catch {} }
  }

  private async runGitCommand(args: string[], options: GitRunOptions): Promise<GitRunOutcome> {
    if (this.disposed)
      return {
        ok: false,
        failure: failure("OPERATION_CANCELLED", "The Git manager was disposed."),
        outputLimit: false,
      };
    const env = this.buildGitEnvironment(options.literalPaths === true);
    let child: ChildProcess;
    try {
      child = spawn(this.gitPath, args, {
        cwd: options.cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: this.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return {
        ok: false,
        failure: failure("GIT_COMMAND_FAILED", "Git could not be started."),
        outputLimit: false,
      };
    }
    this.children.add(child);
    const maxOutputBytes = options.maxOutputBytes ?? this.maxOutputBytes;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    return await new Promise<GitRunOutcome>((resolve) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let total = 0;
      let settled = false;
      let timedOut = false;
      let outputLimit = false;
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (outcome: GitRunOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        this.children.delete(child);
        resolve(outcome);
      };
      const stopChild = (signal: NodeJS.Signals) => {
        this.killProcessTree(child, signal);
        child.stdout?.destroy();
        child.stderr?.destroy();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        this.killProcessTree(child, "SIGTERM");
        forceKillTimer = setTimeout(() => {
          stopChild("SIGKILL");
          finish({
            ok: false,
            failure: failure("GIT_TIMEOUT", "The Git command timed out."),
            outputLimit: false,
          });
        }, 250);
      }, timeoutMs);
      const collect = (target: Buffer[], chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > maxOutputBytes) {
          outputLimit = true;
          stopChild("SIGKILL");
          finish({
            ok: false,
            failure: failure("GIT_OUTPUT_LIMIT", "The Git command produced too much output."),
            outputLimit: true,
          });
          return;
        }
        target.push(chunk);
      };
      child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (this.disposed) {
          finish({
            ok: false,
            failure: failure("OPERATION_CANCELLED", "The Git manager was disposed."),
            outputLimit: false,
          });
          return;
        }
        if (error.code === "ENOENT") {
          finish({
            ok: false,
            failure: failure("GIT_NOT_FOUND", "Git is not installed or cannot be found."),
            outputLimit: false,
          });
          return;
        }
        finish({
          ok: false,
          failure: failure("GIT_COMMAND_FAILED", "Git could not be started."),
          outputLimit: false,
        });
      });
      child.on("close", (code) => {
        if (this.disposed) {
          finish({
            ok: false,
            failure: failure("OPERATION_CANCELLED", "The Git manager was disposed."),
            outputLimit: false,
          });
          return;
        }
        if (timedOut) {
          finish({
            ok: false,
            failure: failure("GIT_TIMEOUT", "The Git command timed out."),
            outputLimit: false,
          });
          return;
        }
        if (outputLimit) {
          finish({
            ok: false,
            failure: failure("GIT_OUTPUT_LIMIT", "The Git command produced too much output."),
            outputLimit: true,
          });
          return;
        }
        const output: GitCommandOutput = {
          code: code ?? 1,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        };
        const allowed = options.allowExitCodes ?? [0];
        if (!allowed.includes(output.code)) {
          finish({
            ok: false,
            failure: failure("GIT_COMMAND_FAILED", "The Git command failed."),
            outputLimit: false,
            exitCode: output.code,
            stderr: trimmedDetail(output),
          });
          return;
        }
        finish({ ok: true, output });
      });
    });
  }
}
