import { spawn, ChildProcess } from "child_process";
import { promises as fs, mkdirSync, writeFileSync, appendFileSync } from "fs";
import path from "path";
import { ipcMain } from "electron";
import { Window } from "../Window";
import { NceWorkspaceStorage } from "./NceWorkspaceStorage";

export interface AgentProcessRequest {
  strategy: string;
  projectRoot: string;
  cwd: string;
  target?: string | null;
  workspaceRoot: string;
  requestId?: string;
  runId?: number | null;
  sessionId?: string | null;
  timeoutMs?: number;
  maxOutputCharacters?: number;
  maxStoredOutputCharacters?: number;
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
  outputStored?: boolean;
  outputPath?: string;
  outputCharacters?: number;
  storageTruncated?: boolean;
  storageError?: string;
  runtime?: { executable: string; version?: string | null };
  error?: { code: string; message: string };
}

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_OUTPUT_CHARACTERS = 12000;
const MAX_TIMEOUT_MS = 300000;
const MAX_OUTPUT_CHARACTERS = 50000;
const DEFAULT_STORED_OUTPUT_CHARACTERS = 5 * 1024 * 1024;
const MAX_STORED_OUTPUT_CHARACTERS = 50 * 1024 * 1024;
const STRATEGY_REGISTRY = {
  "npm-test": { runtime: "npm", command: "package-test" },
  "pnpm-test": { runtime: "pnpm", command: "package-test" },
  "yarn-test": { runtime: "yarn", command: "package-test" },
  "bun-test": { runtime: "bun", command: "package-test" },
  "node-test": { runtime: "node", command: "node-test" },
  "node-script": { runtime: "node", command: "script" },
  "python-pytest": { runtime: "python", command: "python-pytest" },
  "python-unittest": { runtime: "python", command: "python-unittest" },
  "python-script": { runtime: "python", command: "script" },
  "composer-test": { runtime: "composer", command: "composer-test" },
  phpunit: { runtime: "php", command: "phpunit" },
  "php-script": { runtime: "php", command: "script" },
} as const;
const STRATEGIES = new Set(Object.keys(STRATEGY_REGISTRY));

export class AgentProcessRunner {
  private readonly active = new Map<string, ChildProcess>();

  constructor(private readonly window: Window) {}

  handleIPC() {
    ipcMain.handle("Agent:runProcess", async (_event, request: unknown) =>
      this.run(request),
    );
    ipcMain.handle(
      "Agent:cancelProcess",
      async (_event, requestId: unknown) => {
        if (typeof requestId !== "string") return false;
        return this.cancel(requestId);
      },
    );
    ipcMain.handle("Agent:resolveRuntime", async (_event, request: unknown) =>
      this.resolveRuntime(request),
    );
  }

  private invalid(code: string, message: string): AgentProcessResult {
    return {
      success: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      durationMs: 0,
      stdout: "",
      stderr: "",
      truncated: false,
      error: { code, message },
    };
  }

  private createOutputSpool(
    workspaceRoot: string,
    runId: string,
    maxCharacters: number,
  ) {
    const storage = new NceWorkspaceStorage(workspaceRoot);
    const safeRunId = String(runId || "").replace(/[^A-Za-z0-9._-]/g, "_");
    const root = storage.getRunTempRoot(safeRunId);
    const outputPath = path.join(root, "run-tests.log");
    void storage.cleanupTemp(7 * 24 * 60 * 60 * 1000, safeRunId);
    mkdirSync(root, { recursive: true });
    writeFileSync(outputPath, "", "utf8");
    return {
      outputPath,
      relativePath: path.posix.join(".nce", "temp", safeRunId, "run-tests.log"),
      maxCharacters,
      writtenCharacters: 0,
      storageTruncated: false,
      storageError: undefined as string | undefined,
      append(kind: string, text: string) {
        if (this.storageError || this.storageTruncated || !text) return;
        const remaining = this.maxCharacters - this.writtenCharacters;
        if (remaining <= 0) {
          this.storageTruncated = true;
          return;
        }
        const value = text.slice(0, remaining);
        this.writtenCharacters += value.length;
        if (value.length < text.length) this.storageTruncated = true;
        const tagged = kind === "stderr" ? `[stderr]\n${value}` : value;
        try {
          appendFileSync(this.outputPath, tagged, "utf8");
        } catch (error) {
          this.storageError =
            error instanceof Error ? error.message : String(error);
        }
      },
      async finish() {
        return this;
      },
    };
  }

  private async realInside(candidate: string, root: string): Promise<boolean> {
    const resolvedRoot = await fs.realpath(root);
    const resolvedCandidate = await fs.realpath(candidate);
    return (
      resolvedCandidate === resolvedRoot ||
      resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
    );
  }

  private async executableExists(candidate: string): Promise<boolean> {
    try {
      await fs.access(candidate);
      return true;
    } catch {
      return false;
    }
  }

  private async runtimeAvailable(
    executable: string,
    prefix: string[],
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = spawn(executable, [...prefix, "--version"], {
        shell: false,
        windowsHide: true,
      });
      let settled = false;
      const finish = (available: boolean) => {
        if (settled) return;
        settled = true;
        resolve(available);
      };
      const timer = setTimeout(() => {
        probe.kill();
        finish(false);
      }, 2000);
      probe.once("error", () => {
        clearTimeout(timer);
        finish(false);
      });
      probe.once("close", (code) => {
        clearTimeout(timer);
        finish(code === 0);
      });
    });
  }

  private executableName(name: string): string {
    return process.platform === "win32" &&
      ["npm", "pnpm", "yarn", "bun", "composer"].includes(name)
      ? `${name}.cmd`
      : name;
  }

  private async findRuntime(
    strategy: string,
    projectRoot: string,
  ): Promise<{ executable: string; prefix: string[] } | null> {
    const definition =
      STRATEGY_REGISTRY[strategy as keyof typeof STRATEGY_REGISTRY];
    if (!definition) return null;
    const pythonCandidates =
      process.platform === "win32"
        ? [
            path.join(projectRoot, ".venv", "Scripts", "python.exe"),
            path.join(projectRoot, "venv", "Scripts", "python.exe"),
          ]
        : [
            path.join(projectRoot, ".venv", "bin", "python"),
            path.join(projectRoot, "venv", "bin", "python"),
          ];
    if (definition.runtime === "python") {
      for (const candidate of pythonCandidates)
        if (
          (await this.executableExists(candidate)) &&
          (await this.runtimeAvailable(candidate, []))
        )
          return { executable: candidate, prefix: [] };
      for (const name of process.platform === "win32"
        ? ["python", "python3", "py"]
        : ["python3", "python"])
        if (await this.runtimeAvailable(name, name === "py" ? ["-3"] : []))
          return { executable: name, prefix: name === "py" ? ["-3"] : [] };
      return null;
    }
    const name = this.executableName(definition.runtime);
    return (await this.runtimeAvailable(name, []))
      ? { executable: name, prefix: [] }
      : null;
  }

  private async resolveRuntime(request: unknown) {
    if (!request || typeof request !== "object")
      return { available: false, code: "INVALID_REQUEST" };
    const input = request as { strategy?: unknown; projectRoot?: unknown };
    if (
      typeof input.strategy !== "string" ||
      !STRATEGIES.has(input.strategy) ||
      typeof input.projectRoot !== "string"
    )
      return { available: false, code: "INVALID_REQUEST" };
    const runtime = await this.findRuntime(input.strategy, input.projectRoot);
    return runtime
      ? { available: true, executable: runtime.executable }
      : { available: false, code: "RUNTIME_UNAVAILABLE" };
  }

  private killTree(child: ChildProcess) {
    if (!child.pid) return;
    if (process.platform === "win32") {
      const killer = spawn(
        "taskkill",
        ["/PID", String(child.pid), "/T", "/F"],
        { shell: false, windowsHide: true },
      );
      killer.unref();
      return;
    }
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* process already exited */
      }
    }, 750).unref();
  }

  private command(
    strategy: string,
    runtime: { executable: string; prefix: string[] },
    target: string | null,
  ): string[] {
    const targetArg = target ? [target] : [];
    const definition =
      STRATEGY_REGISTRY[strategy as keyof typeof STRATEGY_REGISTRY];
    if (definition?.command === "package-test")
      return [...runtime.prefix, "test", ...targetArg];
    if (definition?.command === "node-test") return ["--test", ...targetArg];
    if (definition?.command === "python-pytest")
      return [...runtime.prefix, "-m", "pytest", ...targetArg];
    if (definition?.command === "python-unittest")
      return [
        ...runtime.prefix,
        "-m",
        "unittest",
        ...(target ? ["discover", "-s", path.dirname(target)] : []),
      ];
    if (definition?.command === "script")
      return [...runtime.prefix, target || ""];
    if (definition?.command === "phpunit")
      return [path.join("vendor", "bin", "phpunit"), ...targetArg];
    if (definition?.command === "composer-test")
      return ["run-script", "test", ...targetArg];
    return [];
  }

  private commandPreview(
    runtime: { executable: string; prefix: string[] },
    args: string[],
  ): string {
    return [runtime.executable, ...runtime.prefix, ...args]
      .map((value) =>
        /[\s"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value,
      )
      .join(" ");
  }

  async run(request: unknown): Promise<AgentProcessResult> {
    if (!request || typeof request !== "object")
      return this.invalid("INVALID_REQUEST", "A process request is required.");
    const input = request as Partial<AgentProcessRequest>;
    if (
      typeof input.strategy !== "string" ||
      !STRATEGIES.has(input.strategy) ||
      typeof input.workspaceRoot !== "string" ||
      typeof input.projectRoot !== "string" ||
      typeof input.cwd !== "string"
    )
      return this.invalid(
        "INVALID_REQUEST",
        "The controlled process request is invalid.",
      );
    const root = path.resolve(input.workspaceRoot);
    const projectRoot = path.resolve(input.projectRoot);
    const cwd = path.resolve(input.cwd);
    const target = input.target ? path.resolve(input.target) : null;
    try {
      await new NceWorkspaceStorage(root).ensureStructure();
    } catch {}
    try {
      if (
        !(await this.realInside(projectRoot, root)) ||
        !(await this.realInside(cwd, root)) ||
        (target && !(await this.realInside(target, root)))
      )
        return this.invalid(
          "OUTSIDE_WORKSPACE",
          "The process target must stay in the workspace.",
        );
      if (!(await fs.stat(cwd)).isDirectory())
        return this.invalid(
          "INVALID_CWD",
          "The process cwd must be a directory.",
        );
    } catch {
      return this.invalid(
        "INVALID_TARGET",
        "The process target does not exist inside the workspace.",
      );
    }
    const runtime = await this.findRuntime(input.strategy, projectRoot);
    if (!runtime)
      return this.invalid(
        "RUNTIME_UNAVAILABLE",
        "The required runtime is unavailable.",
      );
    const timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(1, Math.floor(Number(input.timeoutMs) || DEFAULT_TIMEOUT_MS)),
    );
    const maxOutputCharacters = Math.min(
      MAX_OUTPUT_CHARACTERS,
      Math.max(
        100,
        Math.floor(
          Number(input.maxOutputCharacters) || DEFAULT_OUTPUT_CHARACTERS,
        ),
      ),
    );
    const maxStoredOutputCharacters = Math.min(
      MAX_STORED_OUTPUT_CHARACTERS,
      Math.max(
        maxOutputCharacters,
        Math.floor(
          Number(input.maxStoredOutputCharacters) ||
            DEFAULT_STORED_OUTPUT_CHARACTERS,
        ),
      ),
    );
    const args = this.command(
      input.strategy,
      runtime,
      target ? path.relative(cwd, target) : null,
    );
    const approval = await this.window.agentApprovalManager?.request({
      permissionType: "code_execution",
      workspaceRoot: root,
      requestId: input.requestId,
      runId: input.runId,
      sessionId: input.sessionId,
      title: "Allow code execution?",
      message: "The agent wants to run a validation.",
      preview: {
        type: "command",
        value: this.commandPreview(runtime, args),
      },
      allowWorkspaceGrant: true,
    });
    if (!approval || approval.decision === "cancel")
      return this.invalid(
        "EXECUTION_CANCELLED",
        "Code execution was cancelled by the user.",
      );
    const started = Date.now();
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      const previews = {
        stdout: { text: "", head: "", tail: "", truncated: false },
        stderr: { text: "", head: "", tail: "", truncated: false },
      };
      let outputCharacters = 0;
      let spool: ReturnType<AgentProcessRunner["createOutputSpool"]> | null =
        null;
      let storageError: string | undefined;
      const events: { kind: "stdout" | "stderr"; text: string }[] = [];
      let truncated = false;
      let timedOut = false;
      let settled = false;
      const appendPreview = (kind: "stdout" | "stderr", text: string) => {
        const preview = previews[kind];
        if (
          !preview.truncated &&
          preview.text.length + text.length <= maxOutputCharacters
        ) {
          preview.text += text;
          return;
        }
        truncated = true;
        if (!preview.truncated) {
          const combined = preview.text + text;
          const headLimit = Math.floor(maxOutputCharacters * 0.4);
          preview.head = combined.slice(0, headLimit);
          preview.tail = combined.slice(-maxOutputCharacters + headLimit);
          preview.truncated = true;
          preview.text = "";
          return;
        }
        preview.tail = (preview.tail + text).slice(
          -Math.ceil(maxOutputCharacters * 0.6),
        );
      };
      const append = (kind: "stdout" | "stderr", chunk: Buffer | string) => {
        const text = String(chunk);
        outputCharacters += text.length;
        if (
          !spool &&
          stdout.length + stderr.length + text.length <= maxOutputCharacters
        ) {
          events.push({ kind, text });
          appendPreview(kind, text);
          return;
        }
        if (!spool) {
          try {
            spool = this.createOutputSpool(
              root,
              String(input.requestId || input.runId || `run-${started}`),
              maxStoredOutputCharacters,
            );
            for (const event of events) spool.append(event.kind, event.text);
            events.length = 0;
          } catch (error) {
            spool = null;
            storageError =
              error instanceof Error ? error.message : String(error);
          }
        }
        if (spool) spool.append(kind, text);
        appendPreview(kind, text);
      };
      const finish = async (
        result: Omit<AgentProcessResult, "stdout" | "stderr">,
      ) => {
        if (settled) return;
        settled = true;
        if (spool) await spool.finish();
        stdout = previews.stdout.truncated
          ? `${previews.stdout.head}\n[output truncated]\n${previews.stdout.tail}`
          : previews.stdout.text;
        stderr = previews.stderr.truncated
          ? `${previews.stderr.head}\n[output truncated]\n${previews.stderr.tail}`
          : previews.stderr.text;
        if (input.requestId) this.active.delete(input.requestId);
        resolve({
          ...result,
          stdout,
          stderr,
          truncated: truncated || Boolean(spool?.storageTruncated),
          outputStored: Boolean(spool && !spool.storageError),
          ...(spool && !spool.storageError
            ? { outputPath: spool.relativePath }
            : {}),
          outputCharacters,
          storageTruncated: Boolean(spool?.storageTruncated),
          ...(spool?.storageError || storageError
            ? { storageError: spool?.storageError || storageError }
            : {}),
        });
      };
      const child = spawn(runtime.executable, args, {
        cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      if (input.requestId) this.active.set(input.requestId, child);
      child.stdout?.on("data", (chunk) => append("stdout", chunk));
      child.stderr?.on("data", (chunk) => append("stderr", chunk));
      const timer = setTimeout(() => {
        timedOut = true;
        this.killTree(child);
      }, timeoutMs);
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        void finish({
          success: false,
          exitCode: null,
          signal: null,
          timedOut,
          durationMs: Date.now() - started,
          truncated,
          runtime: { executable: runtime.executable },
          error: {
            code: error.code || "PROCESS_ERROR",
            message: error.message,
          },
        });
      });
      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        void finish({
          success: true,
          exitCode,
          signal,
          timedOut,
          durationMs: Date.now() - started,
          truncated,
          runtime: { executable: runtime.executable },
        });
      });
    });
  }

  cancel(requestId: string): boolean {
    const approvalCancelled =
      this.window.agentApprovalManager?.cancelByRequestId(requestId) || false;
    const child = this.active.get(requestId);
    if (!child) return approvalCancelled;
    this.killTree(child);
    return true;
  }
}
