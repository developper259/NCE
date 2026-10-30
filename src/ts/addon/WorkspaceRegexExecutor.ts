import path from "node:path";
import { forkWorker, type WorkerProcess } from "./WorkerProcess";

export interface WorkspaceRegexMatch {
  index: number;
  length: number;
  line?: number;
  column?: number;
}

interface RegexConfiguration {
  source: string;
  flags: string;
}

export type WorkspaceRegexPattern = RegexConfiguration;

interface FindRequest extends RegexConfiguration {
  operation: "find";
  text: string;
  multiline: boolean;
  maxMatches: number;
}

interface ReplaceRequest extends RegexConfiguration {
  operation: "replace";
  text: string;
  replacement: string;
}

type RegexRequest = FindRequest | ReplaceRequest;

interface RegexWorkerResponse {
  type?: "ready";
  id?: number;
  success: boolean;
  matches?: WorkspaceRegexMatch[];
  content?: string;
  replacements?: number;
  error?: { code?: string; message?: string };
}

interface RegexTask<T> {
  id: number;
  request: RegexRequest;
  resolve(value: T): void;
  reject(error: WorkspaceRegexExecutionError): void;
  signal?: AbortSignal;
  abortListener?: () => void;
  timeout?: ReturnType<typeof setTimeout>;
}

export class WorkspaceRegexExecutionError extends Error {
  readonly code:
    | "ABORTED"
    | "TIMEOUT"
    | "QUEUE_FULL"
    | "WORKER_ERROR"
    | "INVALID_REGEX"
    | "DISPOSED";

  constructor(
    code: WorkspaceRegexExecutionError["code"],
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceRegexExecutionError";
    this.code = code;
  }
}

const REGEX_EXECUTION_TIMEOUT_MS = 1500;
const MAX_QUEUED_REGEX_TASKS = 32;

/**
 * Runs user supplied regular expressions in one reusable child process. The
 * process is killed on cancellation or timeout so synchronous regex execution
 * can never hold up Electron's main event loop indefinitely.
 */
export class WorkspaceRegexExecutor {
  private worker: WorkerProcess | null = null;
  private activeTask: RegexTask<unknown> | null = null;
  private readonly queue: RegexTask<unknown>[] = [];
  private nextTaskId = 1;
  private pumping = false;
  private stoppingWorker: Promise<void> | null = null;
  private readonly readyWorkers = new WeakSet<WorkerProcess>();
  private disposed = false;

  constructor(
    private readonly timeoutMs = REGEX_EXECUTION_TIMEOUT_MS,
    private readonly maxQueuedTasks = MAX_QUEUED_REGEX_TASKS,
  ) {}

  findMatches(
    regex: WorkspaceRegexPattern,
    text: string,
    multiline: boolean,
    maxMatches: number,
    signal?: AbortSignal,
  ): Promise<WorkspaceRegexMatch[]> {
    const request: FindRequest = {
      operation: "find",
      source: regex.source,
      flags: regex.flags,
      text,
      multiline,
      maxMatches,
    };
    return this.enqueue<WorkspaceRegexMatch[]>(request, signal);
  }

  replace(
    regex: WorkspaceRegexPattern,
    text: string,
    replacement: string,
    signal?: AbortSignal,
  ): Promise<{ content: string; replacements: number }> {
    const request: ReplaceRequest = {
      operation: "replace",
      source: regex.source,
      flags: regex.flags,
      text,
      replacement,
    };
    return this.enqueue<{ content: string; replacements: number }>(request, signal);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const error = new WorkspaceRegexExecutionError(
      "DISPOSED",
      "Regex execution was disposed.",
    );
    for (const task of this.queue.splice(0)) this.rejectTask(task, error);
    if (this.activeTask) this.failActiveTask(error, true);
    else if (this.worker) await this.stopCurrentWorker();
    if (this.stoppingWorker) await this.stoppingWorker;
  }

  private enqueue<T>(request: RegexRequest, signal?: AbortSignal): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new WorkspaceRegexExecutionError(
        "DISPOSED",
        "Regex execution was disposed.",
      ));
    }
    if (signal?.aborted) {
      return Promise.reject(new WorkspaceRegexExecutionError(
        "ABORTED",
        "Regex execution was cancelled.",
      ));
    }
    if (this.queue.length >= this.maxQueuedTasks) {
      return Promise.reject(new WorkspaceRegexExecutionError(
        "QUEUE_FULL",
        "Too many regex operations are queued.",
      ));
    }

    return new Promise<T>((resolve, reject) => {
      const task: RegexTask<T> = {
        id: this.nextTaskId++,
        request,
        resolve,
        reject,
        signal,
      };
      if (signal) {
        task.abortListener = () => this.cancelTask(task);
        signal.addEventListener("abort", task.abortListener, { once: true });
      }
      this.queue.push(task as RegexTask<unknown>);
      this.pumpQueue();
    });
  }

  private pumpQueue(): void {
    if (this.pumping || this.activeTask || this.disposed) return;
    this.pumping = true;
    void this.startNextTask().finally(() => {
      this.pumping = false;
      if (!this.activeTask && this.queue.length && !this.disposed)
        this.pumpQueue();
    });
  }

  private async startNextTask(): Promise<void> {
    if (this.stoppingWorker) await this.stoppingWorker;
    while (this.queue.length && !this.disposed) {
      const task = this.queue.shift()!;
      if (task.signal?.aborted) {
        this.rejectTask(task, new WorkspaceRegexExecutionError(
          "ABORTED",
          "Regex execution was cancelled.",
        ));
        continue;
      }

      const worker = this.worker || this.createWorker();
      this.activeTask = task;
      if (this.readyWorkers.has(worker)) this.dispatchTask(worker, task);
      return;
    }
  }

  private createWorker(): WorkerProcess {
    const worker = forkWorker(path.join(__dirname, "WorkspaceRegexWorker.js"));
    this.worker = worker;
    worker.onMessage((message: RegexWorkerResponse) => {
      if (this.worker !== worker) return;
      if (message?.type === "ready") {
        this.readyWorkers.add(worker);
        if (this.activeTask) this.dispatchTask(worker, this.activeTask);
        return;
      }
      if (message?.id !== this.activeTask?.id) return;
      const task = this.activeTask;
      if (!task) return;
      this.activeTask = null;
      this.cleanupTask(task);
      if (!message.success) {
        task.reject(new WorkspaceRegexExecutionError(
          message.error?.code === "INVALID_REGEX" ? "INVALID_REGEX" : "WORKER_ERROR",
          message.error?.message || "Regex worker failed.",
        ));
      } else if (task.request.operation === "find") {
        task.resolve(message.matches || []);
      } else {
        task.resolve({
          content: message.content ?? task.request.text,
          replacements: message.replacements || 0,
        });
      }
      this.pumpQueue();
    });
    worker.onError((error) => {
      this.handleWorkerFailure(worker, error);
    });
    worker.onExit((code, signal) => {
      if (this.worker !== worker) return;
      this.handleWorkerFailure(
        worker,
        new Error(`Regex worker exited (${code ?? signal ?? "unknown"}).`),
      );
    });
    return worker;
  }

  private handleWorkerFailure(worker: WorkerProcess, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    const task = this.activeTask;
    this.activeTask = null;
    if (task) {
      this.cleanupTask(task);
      task.reject(new WorkspaceRegexExecutionError(
        "WORKER_ERROR",
        error.message,
      ));
    }
    const stopping = this.terminateWorker(worker);
    this.stoppingWorker = stopping;
    void stopping.finally(() => {
      if (this.stoppingWorker === stopping) this.stoppingWorker = null;
      if (!this.disposed) this.pumpQueue();
    });
  }

  private dispatchTask(worker: WorkerProcess, task: RegexTask<unknown>): void {
    if (this.worker !== worker || this.activeTask !== task) return;
    task.timeout = setTimeout(() => {
      if (this.activeTask !== task) return;
      this.failActiveTask(new WorkspaceRegexExecutionError(
        "TIMEOUT",
        `Regex execution exceeded ${this.timeoutMs} ms and was terminated.`,
      ), true);
    }, this.timeoutMs);
    try {
      worker.postMessage({ type: "execute", id: task.id, request: task.request }, (error) => {
        if (error && this.activeTask === task)
          this.failActiveTask(new WorkspaceRegexExecutionError(
            "WORKER_ERROR",
            `Unable to send regex work to its worker: ${error.message}`,
          ), true);
      });
    } catch (error) {
      this.failActiveTask(new WorkspaceRegexExecutionError(
        "WORKER_ERROR",
        `Unable to start regex work: ${String(error)}`,
      ), true);
    }
  }

  private cancelTask(task: RegexTask<unknown>): void {
    if (this.activeTask === task) {
      this.failActiveTask(new WorkspaceRegexExecutionError(
        "ABORTED",
        "Regex execution was cancelled.",
      ), true);
      return;
    }
    const queueIndex = this.queue.indexOf(task);
    if (queueIndex >= 0) {
      this.queue.splice(queueIndex, 1);
      this.rejectTask(task, new WorkspaceRegexExecutionError(
        "ABORTED",
        "Regex execution was cancelled.",
      ));
    }
  }

  private failActiveTask(
    error: WorkspaceRegexExecutionError,
    terminateWorker: boolean,
  ): void {
    const task = this.activeTask;
    this.activeTask = null;
    if (task) {
      this.cleanupTask(task);
      task.reject(error);
    }
    if (terminateWorker) this.stopCurrentWorker();
    this.pumpQueue();
  }

  private stopCurrentWorker(): Promise<void> {
    const worker = this.worker;
    if (!worker) return this.stoppingWorker || Promise.resolve();
    this.worker = null;
    const stopped = this.terminateWorker(worker);
    this.stoppingWorker = stopped;
    void stopped.finally(() => {
      if (this.stoppingWorker === stopped) this.stoppingWorker = null;
      if (!this.disposed) this.pumpQueue();
    });
    return stopped;
  }

  private terminateWorker(worker: WorkerProcess): Promise<void> {
    return new Promise<void>((resolve) => {
      if (worker.exited) {
        resolve();
        return;
      }
      let unsubscribe = () => {};
      unsubscribe = worker.onExit(() => {
        unsubscribe();
        resolve();
      });
      worker.kill();
    });
  }

  private cleanupTask(task: RegexTask<unknown>): void {
    if (task.timeout) clearTimeout(task.timeout);
    task.timeout = undefined;
    if (task.signal && task.abortListener)
      task.signal.removeEventListener("abort", task.abortListener);
    task.abortListener = undefined;
  }

  private rejectTask(
    task: RegexTask<unknown>,
    error: WorkspaceRegexExecutionError,
  ): void {
    this.cleanupTask(task);
    task.reject(error);
  }
}

let sharedWorkspaceRegexExecutor: WorkspaceRegexExecutor | null = null;
let sharedWorkspaceRegexExecutorUsers = 0;

export function acquireWorkspaceRegexExecutor(): WorkspaceRegexExecutor {
  if (!sharedWorkspaceRegexExecutor)
    sharedWorkspaceRegexExecutor = new WorkspaceRegexExecutor();
  sharedWorkspaceRegexExecutorUsers++;
  return sharedWorkspaceRegexExecutor;
}

export async function releaseWorkspaceRegexExecutor(
  executor: WorkspaceRegexExecutor,
): Promise<void> {
  if (executor !== sharedWorkspaceRegexExecutor) return;
  sharedWorkspaceRegexExecutorUsers = Math.max(
    0,
    sharedWorkspaceRegexExecutorUsers - 1,
  );
  if (sharedWorkspaceRegexExecutorUsers !== 0) return;
  sharedWorkspaceRegexExecutor = null;
  await executor.dispose();
}
