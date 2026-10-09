import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
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
  return platform === "win32" ? path.win32 : path;
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
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  const hasPath = path.isAbsolute(trimmed) || trimmed.includes("/") ||
    trimmed.includes("\\");
  const extensions = platform === "win32"
    ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const suffixes = platform === "win32" && path.extname(trimmed)
    ? [""]
    : extensions;
  const candidates = hasPath
    ? suffixes.map((extension) => `${trimmed}${extension}`)
    : (env.PATH || "").split(path.delimiter).flatMap((directory) =>
        suffixes.map((extension) => path.join(directory, `${trimmed}${extension}`)),
      );

  for (const file of candidates) {
    try {
      await fsApi.access(file, platform === "win32" ? undefined : fsConstants.X_OK);
      return path.resolve(file);
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
  const configuredShell = typeof configured === "string" ? configured.trim() : "";
  if (configuredShell) {
    const resolved = await executablePath(configuredShell, platform, env, fsApi);
    if (!resolved) throw Object.assign(
      new Error("The configured terminal shell could not be found or executed."),
      { code: "SHELL_NOT_FOUND" },
    );
    return { path: resolved, args: [], name: path.basename(resolved) };
  }

  const candidates = platform === "win32"
    ? ["pwsh.exe", "powershell.exe", env.ComSpec || "cmd.exe"]
    : [env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const resolved = await executablePath(candidate, platform, env, fsApi);
    if (resolved) return { path: resolved, args: [], name: path.basename(resolved) };
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
    const count = [...this.sessions.values()].filter((session) => session.owner === event.sender).length;
    const pending = this.pendingCreates.get(event.sender) || 0;
    if (count + pending >= terminalLimits.maxSessions) return this.failure("SESSION_LIMIT", `NCE supports up to ${terminalLimits.maxSessions} live terminal sessions across all workspaces.`);
    this.pendingCreates.set(event.sender, pending + 1);

    try {
      // Reserve a session slot before any async filesystem/shell resolution so
      // concurrent create requests cannot exceed the global per-window limit.
      const scope = await this.resolveWorkspaceScope(workspacePath);
      if (!validWorkspaceKey(request?.workspaceKey) || request?.workspaceKey !== scope.workspaceKey)
        return this.failure("WORKSPACE_CHANGED", "The active workspace changed. Reopen the terminal and try again.");
      const shell = await resolveTerminalShell(this.getShellSetting(), {
        platform: this.platform,
        env: this.env,
        fs: this.fsApi,
      });
      if (!this.isOwner(event.sender)) return this.failure("UNAUTHORIZED", "Terminal access is unavailable.");
      // `workspacePath` and its canonical key were captured before any await.
      // A renderer can identify the requested scope but cannot provide a CWD.
      const cwd = scope.cwd;
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
      this.logger.error("[Terminal] Failed to create PTY session", error);
      const code = isRecord(error) && typeof error.code === "string"
        ? error.code
        : "SPAWN_FAILED";
      const message = code === "SHELL_NOT_FOUND" && error instanceof Error
        ? error.message
        : "Could not start the terminal shell. Check the configured shell in Settings.";
      return this.failure(code, message);
    } finally {
      const remaining = (this.pendingCreates.get(event.sender) || 1) - 1;
      if (remaining > 0) this.pendingCreates.set(event.sender, remaining);
      else this.pendingCreates.delete(event.sender);
    }
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
