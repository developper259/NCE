import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { ipcMain } from "electron";
import { Window } from "../Window";

export interface AgentProcessRequest {
  executable: string;
  args?: string[];
  cwd: string;
  workspaceRoot: string;
  timeoutMs?: number;
  maxOutputCharacters?: number;
}

export interface AgentProcessResult {
  success: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  error?: { code: string; message: string };
}

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_OUTPUT_CHARACTERS = 12000;
const MAX_TIMEOUT_MS = 300000;
const MAX_OUTPUT_CHARACTERS = 50000;

export class AgentProcessRunner {
  constructor(private readonly _window: Window) {}

  handleIPC() {
    ipcMain.handle("Agent:runProcess", async (_event, request: unknown) =>
      this.run(request),
    );
  }

  async run(request: unknown): Promise<AgentProcessResult> {
    const invalid = (code: string, message: string): AgentProcessResult => ({
      success: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      durationMs: 0,
      stdout: "",
      stderr: "",
      truncated: false,
      error: { code, message },
    });
    if (!request || typeof request !== "object")
      return invalid("INVALID_REQUEST", "A process request is required.");
    const input = request as Partial<AgentProcessRequest>;
    if (
      typeof input.executable !== "string" ||
      !input.executable.trim() ||
      !Array.isArray(input.args) ||
      !input.args.every((arg) => typeof arg === "string") ||
      typeof input.cwd !== "string" ||
      !input.cwd.trim() ||
      typeof input.workspaceRoot !== "string" ||
      !input.workspaceRoot.trim()
    ) {
      return invalid("INVALID_REQUEST", "The process request is invalid.");
    }
    const root = path.resolve(input.workspaceRoot);
    const cwd = path.resolve(input.cwd);
    if (cwd !== root && !cwd.startsWith(`${root}${path.sep}`)) {
      return invalid("OUTSIDE_WORKSPACE", "The process cwd must stay in the workspace.");
    }
    try {
      const stats = await fs.stat(cwd);
      if (!stats.isDirectory()) return invalid("INVALID_CWD", "The process cwd must be a directory.");
    } catch {
      return invalid("INVALID_CWD", "The process cwd does not exist.");
    }

    const timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(1, Math.floor(Number(input.timeoutMs) || DEFAULT_TIMEOUT_MS)),
    );
    const maxOutputCharacters = Math.min(
      MAX_OUTPUT_CHARACTERS,
      Math.max(100, Math.floor(Number(input.maxOutputCharacters) || DEFAULT_OUTPUT_CHARACTERS)),
    );
    const executable = input.executable.trim();
    const args = input.args;
    const started = Date.now();
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;
      const append = (target: "stdout" | "stderr", value: Buffer | string) => {
        const text = String(value);
        const remaining = maxOutputCharacters - stdout.length - stderr.length;
        if (remaining <= 0) {
          truncated = true;
          return;
        }
        const chunk = text.slice(0, remaining);
        if (chunk.length < text.length) truncated = true;
        if (target === "stdout") stdout += chunk;
        else stderr += chunk;
      };
      let settled = false;
      const finish = (result: AgentProcessResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const child = spawn(executable, args, {
        cwd,
        shell: false,
        windowsHide: true,
      });
      child.stdout?.on("data", (chunk) => append("stdout", chunk));
      child.stderr?.on("data", (chunk) => append("stderr", chunk));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        finish({
          success: false,
          exitCode: null,
          signal: null,
          timedOut,
          durationMs: Date.now() - started,
          stdout,
          stderr,
          truncated,
          error: { code: error.code || "PROCESS_ERROR", message: error.message },
        });
      });
      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        finish({
          success: true,
          exitCode,
          signal,
          timedOut,
          durationMs: Date.now() - started,
          stdout,
          stderr,
          truncated,
        });
      });
    });
  }
}