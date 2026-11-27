import { spawn, ChildProcess } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { ipcMain } from "electron";
import { Window } from "../Window";
import type { IpcHandlerRegistrar } from "../manager/IpcRouter";
import {
  RuntimeProbe,
  describeRunTarget,
  isRunStrategy,
  type ResolvedRuntime,
  type RunTarget,
} from "./RunTargets";

/**
 * Run: execute one file and stream what it prints.
 *
 * This is the supervisor, not a UI. It owns exactly one live process per
 * window, reports the real lifecycle of that process, and never reports a
 * state it has not observed. The renderer draws what it is told; it does not
 * decide whether something is running.
 *
 * Boundaries that matter:
 *
 * - The renderer sends a file path and a strategy. It never sends a command
 *   line, an executable, or arguments. Everything executable is derived here.
 * - The path is validated against the active workspace before spawn and again
 *   immediately before spawn, so a workspace switch cannot redirect a run.
 * - Every event carries the run id, so a late chunk from a previous run can be
 *   recognised and dropped instead of corrupting the new run's output.
 * - Output is streamed as it arrives, coalesced into small batches so a chatty
 *   program cannot flood IPC one character at a time.
 */

/** Lifecycle states, in the order a run passes through them. */
export type RunState =
  | "resolving"
  | "starting"
  | "running"
  | "stopping"
  | "success"
  | "error"
  | "cancelled";

export interface RunStartRequest {
  strategy: string;
  projectRoot: string;
  workspaceRoot: string;
  target: string;
  requestId?: string;
}

export interface RunStartResult {
  ok: boolean;
  runId?: string;
  /** Present when the run could not start at all. */
  error?: { code: string; message: string };
}

/** Events pushed to the renderer, all tagged with the run they belong to. */
export type RunEvent =
  | { type: "state"; runId: string; state: RunState; detail?: string }
  | { type: "runtime"; runId: string; executable: string; version: string | null; source: string }
  | { type: "system"; runId: string; text: string }
  | { type: "output"; runId: string; stream: "stdout" | "stderr"; text: string }
  | {
      type: "exit";
      runId: string;
      exitCode: number | null;
      signal: string | null;
      durationMs: number;
      cancelled: boolean;
      timedOut: boolean;
      truncated: boolean;
    }
  | { type: "error"; runId: string; code: string; message: string; title: string };

/** How long a run may live before it is killed. Generous: a program may be slow. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** Output kept in memory for the renderer; beyond this the oldest is dropped. */
const MAX_STREAMED_CHARACTERS = 2 * 1024 * 1024;
/** Coalescing window for stdout/stderr chunks. */
const FLUSH_INTERVAL_MS = 16;

interface ActiveRun {
  id: string;
  child: ChildProcess;
  state: RunState;
  startedAt: number;
  cancelled: boolean;
  timedOut: boolean;
  truncated: boolean;
  streamedCharacters: number;
  pending: { stream: "stdout" | "stderr"; text: string }[];
  flushTimer: NodeJS.Timeout | null;
  timeoutTimer: NodeJS.Timeout | null;
  settled: boolean;
}

export class RunProcessSupervisor {
  private readonly active = new Map<string, ActiveRun>();
  private readonly probe = new RuntimeProbe();
  private readonly ipc: IpcHandlerRegistrar;
  private runCounter = 0;

  constructor(
    private readonly window: Window,
    ipc: IpcHandlerRegistrar = ipcMain as unknown as IpcHandlerRegistrar,
  ) {
    this.ipc = ipc;
  }

  handleIPC(): void {
    this.ipc.handle("Run:start", async (_event, request: unknown) =>
      this.start(request),
    );
    this.ipc.handle("Run:stop", async (_event, runId: unknown) =>
      this.stop(runId),
    );
    this.ipc.handle("Run:resolve", async (_event, request: unknown) =>
      this.resolve(request),
    );
  }

  /** The single live run for this window, if any. */
  getActiveRunId(): string | null {
    for (const run of this.active.values()) return run.id;
    return null;
  }

  private emit(event: RunEvent): void {
    const target = this.window.window;
    if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return;
    try {
      target.webContents.send("Run:event", event);
    } catch {
      // The window went away mid-run; the process is killed by dispose().
    }
  }

  private fail(code: string, message: string, title: string): RunStartResult {
    return { ok: false, error: { code, message: `${title}\u0000${message}` } };
  }

  /**
   * Answer "could this file run, and with what?" without starting anything.
   *
   * The renderer uses this to decide whether Run is enabled and what to say in
   * its tooltip, so the button never promises a runtime that is not there.
   */
  private async resolve(request: unknown) {
    const input = this.readRequest(request);
    if (!input) return { available: false, code: "INVALID_REQUEST" as const };

    const workspace = this.activeWorkspace();
    if (!workspace) return { available: false, code: "NO_ACTIVE_WORKSPACE" as const };

    const description = describeRunTarget({
      language: input.language,
      name: input.name,
      path: input.target,
      isSaved: true,
    });
    if (!description.runnable || !description.target)
      return {
        available: false,
        code: "NOT_RUNNABLE" as const,
        reason: description.reason,
      };

    const runtime = await this.probe.resolve(description.target.runtime, workspace);
    if (!runtime) return { available: false, code: "RUNTIME_UNAVAILABLE" as const };

    const version = await this.probe.version(runtime.executable, runtime.prefix);
    return {
      available: true,
      language: description.target.language,
      label: description.target.label,
      executable: runtime.executable,
      version,
      source: runtime.source,
    };
  }

  private readRequest(request: unknown): {
    strategy: string;
    projectRoot: string;
    workspaceRoot: string;
    target: string;
    language?: string;
    name?: string;
  } | null {
    if (!request || typeof request !== "object") return null;
    const input = request as Record<string, unknown>;
    if (
      typeof input.strategy !== "string" ||
      !isRunStrategy(input.strategy) ||
      typeof input.projectRoot !== "string" ||
      typeof input.workspaceRoot !== "string" ||
      typeof input.target !== "string"
    )
      return null;
    return {
      strategy: input.strategy,
      projectRoot: input.projectRoot,
      workspaceRoot: input.workspaceRoot,
      target: input.target,
      language: typeof input.language === "string" ? input.language : undefined,
      name: typeof input.name === "string" ? input.name : undefined,
    };
  }

  private activeWorkspace(): string | null {
    const root = this.window.watcher?.getWatchedPath?.();
    return typeof root === "string" && root.trim() ? path.resolve(root) : null;
  }

  /** True when `candidate` resolves to `root` or something inside it. */
  private async realInside(candidate: string, root: string): Promise<boolean> {
    const resolvedRoot = await fs.realpath(root);
    const resolvedCandidate = await fs.realpath(candidate);
    return (
      resolvedCandidate === resolvedRoot ||
      resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
    );
  }

  /**
   * Start a run.
   *
   * Returns as soon as the process has been spawned and its state reported, so
   * the renderer can show Starting immediately. Everything after that arrives
   * as events.
   */
  async start(request: unknown): Promise<RunStartResult> {
    const input = this.readRequest(request);
    if (!input)
      return this.fail("INVALID_REQUEST", "A run request is required.", "Cannot run this file");

    // One run at a time. A second click while a process is live is refused
    // rather than queued, so two programs can never write to one panel.
    if (this.getActiveRunId())
      return this.fail(
        "ALREADY_RUNNING",
        "A program is already running. Stop it before starting another.",
        "A program is already running",
      );

    const workspace = this.activeWorkspace();
    if (!workspace)
      return this.fail(
        "NO_ACTIVE_WORKSPACE",
        "Open a folder before running a file.",
        "No folder is open",
      );

    const description = describeRunTarget({
      language: input.language,
      name: input.name,
      path: input.target,
      isSaved: true,
    });
    if (!description.runnable || !description.target)
      return this.fail(
        "NOT_RUNNABLE",
        description.reason || "This file cannot be run.",
        "Cannot run this file",
      );
    const target: RunTarget = description.target;

    // The declared strategy must match the language the file actually is.
    if (target.strategy !== input.strategy)
      return this.fail(
        "STRATEGY_MISMATCH",
        "The file type and the requested runner do not match.",
        "Cannot run this file",
      );

    const projectRoot = path.resolve(input.projectRoot);
    const targetPath = path.resolve(input.target);

    // The target must be inside the workspace, before and after resolution.
    try {
      if (
        !(await this.realInside(projectRoot, workspace)) ||
        !(await this.realInside(targetPath, workspace))
      )
        return this.fail(
          "OUTSIDE_WORKSPACE",
          "This file is outside the open folder.",
          "Cannot run this file",
        );
      const stats = await fs.stat(targetPath);
      if (!stats.isFile())
        return this.fail(
          "INVALID_TARGET",
          "The file could not be found on disk.",
          "Cannot run this file",
        );
    } catch {
      return this.fail(
        "INVALID_TARGET",
        "The file could not be found on disk. It may have been moved or deleted.",
        "Cannot run this file",
      );
    }

    const runId = `run-${Date.now()}-${++this.runCounter}`;
    this.emit({ type: "state", runId, state: "resolving" });

    const runtime = await this.probe.resolve(target.runtime, projectRoot);
    if (!runtime)
      return this.fail(
        "RUNTIME_UNAVAILABLE",
        `${target.label} was not found on this machine.`,
        `Cannot run ${path.basename(targetPath)}`,
      );

    const version = await this.probe.version(runtime.executable, runtime.prefix);
    this.emit({
      type: "runtime",
      runId,
      executable: runtime.executable,
      version,
      source: runtime.source,
    });

    this.emit({ type: "state", runId, state: "starting" });

    // Re-validate immediately before spawn: the workspace may have changed
    // while the runtime was being resolved.
    try {
      if (
        !(await this.realInside(projectRoot, workspace)) ||
        !(await this.realInside(targetPath, workspace))
      )
        return this.fail(
          "WORKSPACE_CHANGED",
          "The folder changed while the file was starting.",
          "Cannot run this file",
        );
    } catch {
      return this.fail(
        "INVALID_TARGET",
        "The file could not be found on disk.",
        "Cannot run this file",
      );
    }

    const args = [...runtime.prefix, path.relative(projectRoot, targetPath)];
    return this.spawnRun(runId, runtime, args, projectRoot, target);
  }

  private spawnRun(
    runId: string,
    runtime: ResolvedRuntime,
    args: string[],
    cwd: string,
    target: RunTarget,
  ): RunStartResult {
    let child: ChildProcess;
    try {
      child = spawn(runtime.executable, args, {
        cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        type: "error",
        runId,
        code: "SPAWN_FAILED",
        message,
        title: "Cannot start the program",
      });
      return { ok: false, error: { code: "SPAWN_FAILED", message } };
    }

    const run: ActiveRun = {
      id: runId,
      child,
      state: "starting",
      startedAt: Date.now(),
      cancelled: false,
      timedOut: false,
      truncated: false,
      streamedCharacters: 0,
      pending: [],
      flushTimer: null,
      timeoutTimer: null,
      settled: false,
    };
    this.active.set(runId, run);

    child.stdout?.on("data", (chunk) => this.queue(run, "stdout", chunk));
    child.stderr?.on("data", (chunk) => this.queue(run, "stderr", chunk));

    child.on("spawn", () => {
      // Only now is the process really running. Until this fires the UI shows
      // Starting, never Running.
      if (run.settled) return;
      run.state = "running";
      this.emit({ type: "state", runId, state: "running" });
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (run.settled) return;
      this.emit({
        type: "error",
        runId,
        code: error.code || "PROCESS_ERROR",
        message: error.message,
        title: "Cannot start the program",
      });
      this.settle(run, { exitCode: null, signal: null });
    });

    child.on("close", (exitCode, signal) => {
      this.settle(run, { exitCode, signal });
    });

    run.timeoutTimer = setTimeout(() => {
      if (run.settled) return;
      run.timedOut = true;
      this.emit({
        type: "system",
        runId,
        text: `Stopped after ${Math.round(DEFAULT_TIMEOUT_MS / 60000)} minutes: the program did not finish.`,
      });
      this.killTree(child);
    }, DEFAULT_TIMEOUT_MS);
    run.timeoutTimer.unref?.();

    void target;
    return { ok: true, runId };
  }

  /** Coalesce chunks so a fast writer cannot flood IPC. */
  private queue(run: ActiveRun, stream: "stdout" | "stderr", chunk: Buffer | string): void {
    if (run.settled) return;
    const text = String(chunk);
    if (!text) return;

    if (run.streamedCharacters + text.length > MAX_STREAMED_CHARACTERS) {
      if (!run.truncated) {
        run.truncated = true;
        this.emit({
          type: "system",
          runId: run.id,
          text: "Output limit reached. Further output is not shown.",
        });
      }
      return;
    }
    run.streamedCharacters += text.length;
    run.pending.push({ stream, text });

    if (run.flushTimer) return;
    run.flushTimer = setTimeout(() => this.flush(run), FLUSH_INTERVAL_MS);
    run.flushTimer.unref?.();
  }

  private flush(run: ActiveRun): void {
    run.flushTimer = null;
    if (!run.pending.length) return;
    const batch = run.pending;
    run.pending = [];
    for (const item of batch)
      this.emit({
        type: "output",
        runId: run.id,
        stream: item.stream,
        text: item.text,
      });
  }

  /** Report the end of a run exactly once. */
  private settle(
    run: ActiveRun,
    outcome: { exitCode: number | null; signal: string | null },
  ): void {
    if (run.settled) return;
    run.settled = true;
    if (run.flushTimer) clearTimeout(run.flushTimer);
    if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
    this.flush(run);
    this.active.delete(run.id);

    const durationMs = Date.now() - run.startedAt;
    const cancelled = run.cancelled;

    this.emit({
      type: "exit",
      runId: run.id,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      durationMs,
      cancelled,
      timedOut: run.timedOut,
      truncated: run.truncated,
    });

    // A deliberate stop is a neutral outcome, not a failure.
    const state: RunState = cancelled
      ? "cancelled"
      : outcome.exitCode === 0
        ? "success"
        : "error";
    this.emit({ type: "state", runId: run.id, state });
  }

  /**
   * Stop a run.
   *
   * The state moves to Stopping and stays there until the process really
   * exits, so the UI never claims a stop that has not happened.
   */
  async stop(runId: unknown): Promise<boolean> {
    if (typeof runId !== "string") return false;
    const run = this.active.get(runId);
    if (!run || run.settled) return false;
    if (run.state === "stopping") return true;
    run.cancelled = true;
    run.state = "stopping";
    this.emit({ type: "state", runId, state: "stopping" });
    this.killTree(run.child);
    return true;
  }

  /** Terminate the process tree, escalating from TERM to KILL. */
  private killTree(child: ChildProcess): void {
    if (!child.pid) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
      });
      killer.unref();
      return;
    }
    const pid = child.pid;
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already gone.
        }
      }
    };
    signalGroup("SIGTERM");
    if (child.exitCode !== null || child.signalCode !== null) {
      signalGroup("SIGKILL");
      return;
    }
    const timer = setTimeout(() => signalGroup("SIGKILL"), 750);
    timer.unref?.();
    child.once("exit", () => {
      clearTimeout(timer);
      signalGroup("SIGKILL");
    });
  }

  /** Kill everything this window started. Called when the window closes. */
  dispose(): void {
    for (const run of [...this.active.values()]) {
      run.cancelled = true;
      this.killTree(run.child);
      if (run.flushTimer) clearTimeout(run.flushTimer);
      if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
    }
    this.active.clear();
  }
}
