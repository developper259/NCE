import { app, ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import {
  accessSync,
  constants as nativeFsConstants,
  existsSync,
  statSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TerminalSession } from "./TerminalSession";
import {
  terminalLimits,
  type TerminalActionResult,
  type TerminalCreateResult,
  type TerminalWorkspaceScope,
} from "./TerminalTypes";

type Shell = { path: string; args: string[]; name: string };
type TerminalSpawn = typeof import("node-pty").spawn;

type TerminalManagerOptions = {
  getWorkspacePath: () => string | null | undefined;
  getShellSetting: () => unknown;
  owner?: WebContents | null;
  ipc?: typeof ipcMain;
  spawn?: TerminalSpawn;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  fs?: Pick<typeof fs, "realpath" | "stat" | "access">;
  logger?: Pick<Console, "error">;
};

export type PtySpawnHelperDiagnostics = {
  status: "available" | "not-executable" | "unavailable" | "not-applicable";
  path: string | null;
  permissions: string | null;
};

type NativeFsDiagnostics = Pick<typeof import("node:fs"), "accessSync" | "existsSync" | "statSync">;

function unpackedAsarPath(value: string): string {
  return value
    .replace("app.asar/", "app.asar.unpacked/")
    .replace("node_modules.asar/", "node_modules.asar.unpacked/");
}

export function inspectPtySpawnHelper(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  fsApi: NativeFsDiagnostics = { accessSync, existsSync, statSync },
): PtySpawnHelperDiagnostics {
  if (platform !== "darwin")
    return { status: "not-applicable", path: null, permissions: null };

  try {
    const entry = require.resolve("node-pty");
    const packageRoot = path.resolve(path.dirname(entry), "..");
    const nativeDirectories = [
      "build/Release",
      "build/Debug",
      `prebuilds/${platform}-${arch}`,
    ];
    const nativeDirectory = nativeDirectories.find((directory) =>
      fsApi.existsSync(path.join(packageRoot, directory, "pty.node")),
    );
    if (!nativeDirectory)
      return { status: "unavailable", path: null, permissions: null };

    const helperPath = unpackedAsarPath(
      path.resolve(packageRoot, nativeDirectory, "spawn-helper"),
    );
    let permissions: string | null = null;
    try {
      permissions = (fsApi.statSync(helperPath).mode & 0o777).toString(8).padStart(3, "0");
    } catch {
      return { status: "unavailable", path: helperPath, permissions };
    }
    try {
      fsApi.accessSync(helperPath, nativeFsConstants.X_OK);
    } catch {
      return { status: "not-executable", path: helperPath, permissions };
    }
    if ((Number.parseInt(permissions, 8) & 0o111) === 0)
      return { status: "not-executable", path: helperPath, permissions };
    return { status: "available", path: helperPath, permissions };
  } catch {
    return { status: "unavailable", path: null, permissions: null };
  }
}

export function classifyPtySpawnFailure(
  error: unknown,
  helper: PtySpawnHelperDiagnostics | null,
): string {
  if (isRecord(error) && ["SHELL_NOT_FOUND", "INVALID_CWD"].includes(String(error.code)))
    return String(error.code);
  if (helper?.status === "not-executable") return "PTY_HELPER_NOT_EXECUTABLE";
  if (helper?.status === "unavailable") return "PTY_HELPER_UNAVAILABLE";
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/too many open files|resource temporarily unavailable|cannot allocate memory|no space left on device/i.test(message))
    return "PTY_RESOURCE_EXHAUSTED";
  return "PTY_SPAWN_FAILED";
}

function spawnFailureMessage(code: string): string {
  switch (code) {
    case "SHELL_NOT_FOUND":
      return "The configured terminal shell could not be found or executed.";
    case "INVALID_CWD":
      return "The terminal working folder is unavailable. Reopen the workspace and try again.";
    case "PTY_HELPER_NOT_EXECUTABLE":
      return "The terminal helper cannot run. Reinstall or rebuild NCE, then try again.";
    case "PTY_HELPER_UNAVAILABLE":
      return "The terminal helper is missing. Reinstall or rebuild NCE, then try again.";
    case "PTY_RESOURCE_EXHAUSTED":
      return "The system cannot allocate another terminal right now. Close unused terminals and retry.";
    default:
      return "The terminal process could not be started. Review the diagnostic log and retry.";
  }
}

function validDimensions(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 2 &&
    (value as number) <= terminalLimits.maxDimension;
}

function validId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function workspacePathApi(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function workspaceKeyFor(value: string, platform: NodeJS.Platform): string {
  const pathApi = workspacePathApi(platform);
  const normalized = pathApi.normalize(pathApi.resolve(value));
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function validWorkspaceKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 &&
    !value.includes("\0");
}

async function executablePath(
  candidate: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  fsApi: Pick<typeof fs, "access">,
): Promise<string | null> {
  const pathApi = workspacePathApi(platform);
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  const hasPath = pathApi.isAbsolute(trimmed) || trimmed.includes("/") ||
    trimmed.includes("\\");
  const extensions = platform === "win32"
    ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const suffixes = platform === "win32" && pathApi.extname(trimmed)
    ? [""]
    : extensions;
  const candidates = hasPath
    ? suffixes.map((extension) => `${trimmed}${extension}`)
    : (env.PATH || "").split(pathApi.delimiter).flatMap((directory) =>
        suffixes.map((extension) => pathApi.join(directory, `${trimmed}${extension}`)),
      );

  for (const file of candidates) {
    try {
      await fsApi.access(file, platform === "win32" ? undefined : fsConstants.X_OK);
      return pathApi.resolve(file);
    } catch {}
  }
  return null;
}

export async function resolveTerminalShell(
  configured: unknown,
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    fs?: Pick<typeof fs, "access">;
  } = {},
): Promise<Shell> {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const fsApi = options.fs || fs;
  const pathApi = workspacePathApi(platform);
  const configuredShell = typeof configured === "string" ? configured.trim() : "";
  if (configuredShell) {
    const resolved = await executablePath(configuredShell, platform, env, fsApi);
    if (!resolved) throw Object.assign(
      new Error("The configured terminal shell could not be found or executed."),
      { code: "SHELL_NOT_FOUND" },
    );
    return { path: resolved, args: [], name: pathApi.basename(resolved) };
  }

  const candidates = platform === "win32"
    ? ["pwsh.exe", "powershell.exe", env.ComSpec || "cmd.exe"]
    : [env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const resolved = await executablePath(candidate, platform, env, fsApi);
    if (resolved) return { path: resolved, args: [], name: pathApi.basename(resolved) };
  }
  throw Object.assign(new Error("No usable system shell was found."), { code: "SHELL_NOT_FOUND" });
}

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly pendingCreates = new Map<WebContents, number>();
  private owner: WebContents | null;
  private readonly ipc: typeof ipcMain;
  private readonly spawnPty?: TerminalSpawn;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly homeDir: string;
  private readonly fsApi: Pick<typeof fs, "realpath" | "stat" | "access">;
  private readonly logger: Pick<Console, "error">;
  private readonly getWorkspacePath: TerminalManagerOptions["getWorkspacePath"];
  private readonly getShellSetting: TerminalManagerOptions["getShellSetting"];
  private ipcRegistered = false;
  private ownerGeneration = 0;

  constructor(options: TerminalManagerOptions) {
    this.owner = options.owner || null;
    this.ipc = options.ipc || ipcMain;
    this.spawnPty = options.spawn;
    this.platform = options.platform || process.platform;
    this.env = options.env || process.env;
    this.homeDir = options.homeDir || os.homedir();
    this.fsApi = options.fs || fs;
    this.logger = options.logger || console;
    this.getWorkspacePath = options.getWorkspacePath;
    this.getShellSetting = options.getShellSetting;
  }

  attachOwner(owner: WebContents): void {
    if (this.owner && this.owner !== owner) this.closeForOwner(this.owner);
    this.owner = owner;
  }

  ownsSender(sender: WebContents): boolean {
    return this.isOwner(sender);
  }

  registerIPC(): void {
    if (this.ipcRegistered) return;
    this.ipcRegistered = true;
    this.ipc.handle("Terminal:create", (event, size) => this.create(event, size));
    this.ipc.handle("Terminal:getWorkspaceScope", (event) =>
      this.isOwner(event.sender) ? this.getWorkspaceScope() : null,
    );
    this.ipc.handle("Terminal:write", (event, id, workspaceKey, data) =>
      validWorkspaceKey(workspaceKey)
        ? this.write(event, id, workspaceKey, data)
        : this.actionFailure("INVALID_INPUT", "Invalid terminal workspace."),
    );
    this.ipc.handle("Terminal:resize", (event, id, workspaceKey, cols, rows) =>
      validWorkspaceKey(workspaceKey)
        ? this.resize(event, id, workspaceKey, cols, rows)
        : this.actionFailure("INVALID_INPUT", "Invalid terminal workspace."),
    );
    this.ipc.handle("Terminal:ack", (event, id, workspaceKey, sequence) =>
      validWorkspaceKey(workspaceKey)
        ? this.ack(event, id, workspaceKey, sequence)
        : this.actionFailure("INVALID_INPUT", "Invalid terminal workspace."),
    );
    this.ipc.handle("Terminal:close", (event, id, workspaceKey) =>
      validWorkspaceKey(workspaceKey)
        ? this.close(event, id, workspaceKey)
        : this.actionFailure("INVALID_INPUT", "Invalid terminal workspace."),
    );
  }

  private isOwner(sender: WebContents): boolean {
    return Boolean(this.owner && sender === this.owner && !sender.isDestroyed());
  }

  async create(
    event: IpcMainInvokeEvent | { sender: WebContents },
    size: unknown,
  ): Promise<TerminalCreateResult> {
    if (!this.isOwner(event.sender)) return this.failure("UNAUTHORIZED", "Terminal access is unavailable.");
    const request = isRecord(size) ? size : null;
    const cols = request?.cols;
    const rows = request?.rows;
    if (!validDimensions(cols) || !validDimensions(rows)) return this.failure("INVALID_SIZE", "Invalid terminal dimensions.");
    const workspacePath = this.getWorkspacePath() || null;
    const ownerGeneration = this.ownerGeneration;
    const count = [...this.sessions.values()].filter((session) => session.owner === event.sender).length;
    const pending = this.pendingCreates.get(event.sender) || 0;
    if (count + pending >= terminalLimits.maxSessions) return this.failure("SESSION_LIMIT", `NCE supports up to ${terminalLimits.maxSessions} live terminal sessions across all workspaces.`);
    this.pendingCreates.set(event.sender, pending + 1);

    let cwd: string | null = null;
    let shellPath: string | null = null;
    try {
      // Reserve a session slot before any async filesystem/shell resolution so
      // concurrent create requests cannot exceed the global per-window limit.
      const scope = await this.resolveWorkspaceScope(workspacePath);
      if (!validWorkspaceKey(request?.workspaceKey) || request?.workspaceKey !== scope.workspaceKey)
        return this.failure("WORKSPACE_CHANGED", "The active workspace changed. Reopen the terminal and try again.");
      cwd = scope.cwd;
      if (!await this.isUsableWorkingDirectory(cwd))
        return this.failure("INVALID_CWD", spawnFailureMessage("INVALID_CWD"));
      const shell = await resolveTerminalShell(this.getShellSetting(), {
        platform: this.platform,
        env: this.env,
        fs: this.fsApi,
      });
      shellPath = shell.path;
      if (!this.isOwner(event.sender) || ownerGeneration !== this.ownerGeneration)
        return this.failure("CREATE_CANCELLED", "Terminal creation was cancelled.");
      // `workspacePath` and its canonical key were captured before any await.
      // A renderer can identify the requested scope but cannot provide a CWD.
      const childEnv: Record<string, string> = Object.fromEntries(
        Object.entries(this.env).filter((entry): entry is [string, string] =>
          typeof entry[1] === "string",
        ),
      );
      childEnv.TERM = "xterm-256color";
      childEnv.COLORTERM = "truecolor";
      childEnv.PWD = cwd;
      delete childEnv.ELECTRON_RUN_AS_NODE;
      // Keep node-pty and its native module unloaded until the first terminal is requested.
      const spawnPty = this.spawnPty || require("node-pty").spawn as TerminalSpawn;
      const helper = this.platform === "darwin" && !this.spawnPty
        ? inspectPtySpawnHelper(this.platform, process.arch)
        : null;
      if (helper?.status === "unavailable" || helper?.status === "not-executable") {
        const code = classifyPtySpawnFailure(new Error("The node-pty spawn helper is unavailable."), helper);
        if (!app?.isPackaged) {
          this.logger.error("[Terminal] PTY spawn preflight failed", {
            code,
            platform: this.platform,
            arch: process.arch,
            shellExecutable: shell.path,
            cwd,
            nodePtyVersion: this.nodePtyVersion(),
            helper,
            activeSessions: count,
            pendingCreates: this.pendingCreates.get(event.sender) || 0,
          });
        }
        return this.failure(code, spawnFailureMessage(code));
      }
      const child = spawnPty(shell.path, shell.args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: childEnv,
        ...(this.platform === "win32" ? { useConpty: true } : {}),
      });
      const id = randomUUID();
      const session = new TerminalSession(id, scope.workspaceKey, event.sender, child, this.logger);
      this.sessions.set(id, session);
      return { success: true, sessionId: id, shell: shell.name, cwd, workspaceKey: scope.workspaceKey };
    } catch (error: unknown) {
      const helper = this.platform === "darwin" && !this.spawnPty
        ? inspectPtySpawnHelper(this.platform, process.arch)
        : null;
      const code = await this.classifySpawnFailure(error, helper, cwd, shellPath);
      if (!app?.isPackaged) {
        const cause = error instanceof Error
          ? {
              name: error.name,
              code: isRecord(error) && typeof error.code === "string" ? error.code : null,
              message: error.message.slice(0, 512),
            }
          : { name: typeof error, message: String(error).slice(0, 512) };
        this.logger.error("[Terminal] Failed to create PTY session", {
          code,
          cause,
          platform: this.platform,
          arch: process.arch,
          shellExecutable: shellPath,
          cwd,
          nodePtyVersion: this.nodePtyVersion(),
          helper,
          activeSessions: [...this.sessions.values()].filter((session) => session.owner === event.sender).length,
          pendingCreates: this.pendingCreates.get(event.sender) || 0,
        });
      }
      return this.failure(code, spawnFailureMessage(code));
    } finally {
      const remaining = (this.pendingCreates.get(event.sender) || 1) - 1;
      if (remaining > 0) this.pendingCreates.set(event.sender, remaining);
      else this.pendingCreates.delete(event.sender);
    }
  }

  private async isUsableWorkingDirectory(cwd: string): Promise<boolean> {
    try {
      const stat = await this.fsApi.stat(cwd);
      if (!stat.isDirectory()) return false;
      await this.fsApi.access(cwd, this.platform === "win32" ? undefined : fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async classifySpawnFailure(
    error: unknown,
    helper: PtySpawnHelperDiagnostics | null,
    cwd: string | null,
    shellPath: string | null,
  ): Promise<string> {
    if (cwd && !await this.isUsableWorkingDirectory(cwd)) return "INVALID_CWD";
    if (shellPath && !await executablePath(shellPath, this.platform, this.env, this.fsApi))
      return "SHELL_NOT_FOUND";
    return classifyPtySpawnFailure(error, helper);
  }

  private nodePtyVersion(): string | null {
    try { return require("node-pty/package.json").version as string; }
    catch { return null; }
  }

  async getWorkspaceScope(): Promise<TerminalWorkspaceScope> {
    const requested = this.getWorkspacePath() || null;
    return this.resolveWorkspaceScope(requested);
  }

  private async resolveWorkspaceScope(requested: string | null): Promise<TerminalWorkspaceScope> {
    if (typeof requested === "string" && requested.trim() && !requested.includes("\0")) {
      const pathApi = workspacePathApi(this.platform);
      let workspacePath = pathApi.normalize(pathApi.resolve(requested));
      let cwd = workspacePath;
      try {
        const real = await this.fsApi.realpath(workspacePath);
        if ((await this.fsApi.stat(real)).isDirectory()) {
          workspacePath = real;
          cwd = real;
        } else {
          cwd = await this.resolveHomeDirectory();
        }
      } catch {
        cwd = await this.resolveHomeDirectory();
      }
      return {
        workspaceKey: workspaceKeyFor(workspacePath, this.platform),
        workspacePath: requested,
        cwd,
      };
    }
    return {
      workspaceKey: "no-workspace",
      workspacePath: null,
      cwd: await this.resolveHomeDirectory(),
    };
  }

  private async resolveHomeDirectory(): Promise<string> {
    try {
      const realHome = await this.fsApi.realpath(this.homeDir);
      if ((await this.fsApi.stat(realHome)).isDirectory()) return realHome;
    } catch {}
    return this.homeDir;
  }

  write(event: { sender: WebContents }, id: unknown, workspaceKey: unknown, data: unknown): TerminalActionResult {
    if (!this.isOwner(event.sender)) return this.actionFailure("UNAUTHORIZED", "Terminal access is unavailable.");
    if (!validId(id) || typeof data !== "string" ||
        Buffer.byteLength(data, "utf8") > terminalLimits.maxWriteBytes) return this.actionFailure("INVALID_INPUT", "Invalid terminal input.");
    const session = this.sessions.get(id);
    if (!session || session.owner !== event.sender || session.workspaceKey !== workspaceKey) return this.actionFailure("SESSION_UNAVAILABLE", "Terminal session is unavailable in this workspace.");
    return session.write(data)
      ? { success: true }
      : this.actionFailure("SESSION_EXITED", "Terminal session is no longer running.");
  }

  resize(event: { sender: WebContents }, id: unknown, workspaceKey: unknown, cols: unknown, rows: unknown): TerminalActionResult {
    if (!this.isOwner(event.sender)) return this.actionFailure("UNAUTHORIZED", "Terminal access is unavailable.");
    if (!validId(id) || !validDimensions(cols) || !validDimensions(rows)) return this.actionFailure("INVALID_SIZE", "Invalid terminal dimensions.");
    const session = this.sessions.get(id);
    if (!session || session.owner !== event.sender || session.workspaceKey !== workspaceKey) return this.actionFailure("SESSION_UNAVAILABLE", "Terminal session is unavailable in this workspace.");
    return session.resize(cols, rows)
      ? { success: true }
      : this.actionFailure("SESSION_EXITED", "Terminal session is no longer running.");
  }

  ack(event: { sender: WebContents }, id: unknown, workspaceKey: unknown, sequence: unknown): TerminalActionResult {
    if (!this.isOwner(event.sender)) return this.actionFailure("UNAUTHORIZED", "Terminal access is unavailable.");
    if (!validId(id) || !Number.isSafeInteger(sequence)) return this.actionFailure("INVALID_INPUT", "Invalid terminal acknowledgement.");
    const session = this.sessions.get(id);
    if (!session || session.owner !== event.sender || session.workspaceKey !== workspaceKey) return this.actionFailure("SESSION_UNAVAILABLE", "Terminal session is unavailable in this workspace.");
    return session.acknowledge(sequence as number)
      ? { success: true }
      : this.actionFailure("STALE_ACK", "Terminal output acknowledgement is stale.");
  }

  close(event: { sender: WebContents }, id: unknown, workspaceKey: unknown): TerminalActionResult {
    if (!this.isOwner(event.sender)) return this.actionFailure("UNAUTHORIZED", "Terminal access is unavailable.");
    if (!validId(id)) return this.actionFailure("INVALID_INPUT", "Invalid terminal session identifier.");
    const session = this.sessions.get(id);
    if (!session || session.owner !== event.sender || session.workspaceKey !== workspaceKey) return this.actionFailure("SESSION_UNAVAILABLE", "Terminal session is unavailable in this workspace.");
    this.removeSession(session);
    return { success: true };
  }

  closeForOwner(owner: WebContents): void {
    if (owner === this.owner) this.ownerGeneration += 1;
    for (const session of this.sessions.values()) {
      if (session.owner === owner) this.removeSession(session);
    }
  }

  closeAll(): void {
    for (const session of this.sessions.values()) this.removeSession(session);
  }

  private removeSession(session: TerminalSession): void {
    session.dispose();
    this.sessions.delete(session.id);
  }

  private failure(code: string, message: string): TerminalCreateResult {
    return { success: false, error: { code, message } };
  }

  private actionFailure(code: string, message: string): TerminalActionResult {
    return { success: false, error: { code, message } };
  }
}
