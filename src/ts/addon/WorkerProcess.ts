import { fork } from "node:child_process";

export interface WorkerProcess {
  readonly pid: number | undefined;
  readonly exited: boolean;
  postMessage(message: any, onError?: (error: Error) => void): void;
  kill(): void;
  onMessage(listener: (message: any) => void): void;
  onExit(
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): () => void;
  onError(listener: (error: Error) => void): void;
}

interface UtilityProcessLike {
  pid?: number;
  postMessage(message: unknown): void;
  kill(): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
}

interface UtilityProcessModuleLike {
  fork(
    modulePath: string,
    args?: string[],
    options?: {
      env?: NodeJS.ProcessEnv;
      stdio?: "ignore" | "inherit" | "pipe";
      serviceName?: string;
    },
  ): UtilityProcessLike;
}

function workerEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged = { ...process.env, ...env };
  // The packaged app disables the RunAsNode fuse; the variable must never
  // leak into utility processes or spawned terminals.
  delete merged.ELECTRON_RUN_AS_NODE;
  return merged;
}

function loadUtilityProcess(): UtilityProcessModuleLike | null {
  try {
    const electron = require("electron") as { utilityProcess?: UtilityProcessModuleLike };
    return typeof electron?.utilityProcess?.fork === "function"
      ? electron.utilityProcess
      : null;
  } catch {
    return null;
  }
}

export function createNodeWorker(
  modulePath: string,
  args: string[] = [],
  env?: NodeJS.ProcessEnv,
): WorkerProcess {
  const child = fork(modulePath, args, {
    execPath: process.execPath,
    env: { ...workerEnvironment(env), ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  return {
    get pid() { return child.pid; },
    get exited() {
      return child.exitCode !== null || child.signalCode !== null || child.pid === undefined;
    },
    postMessage(message, onError) {
      if (!child.connected) {
        onError?.(new Error("Worker channel is closed."));
        return;
      }
      try {
        child.send(message, (error: Error | null) => {
          if (error) onError?.(error);
        });
      } catch (error) {
        onError?.(error as Error);
      }
    },
    kill() {
      try { child.kill("SIGTERM"); } catch {}
    },
    onMessage(listener) {
      child.on("message", listener);
    },
    onExit(listener) {
      const handler = (code: number | null, signal: NodeJS.Signals | null) =>
        listener(code, signal);
      child.once("exit", handler);
      return () => child.off("exit", handler);
    },
    onError(listener) {
      child.on("error", listener);
    },
  };
}

export function createUtilityWorker(
  utilityProcess: UtilityProcessModuleLike,
  modulePath: string,
  args: string[] = [],
  env?: NodeJS.ProcessEnv,
): WorkerProcess {
  let exited = false;
  const child = utilityProcess.fork(modulePath, args, {
    env: workerEnvironment(env),
    stdio: "ignore",
    serviceName: "NCE Worker",
  });
  child.on("exit", () => { exited = true; });
  return {
    get pid() { return child.pid; },
    get exited() { return exited; },
    postMessage(message, onError) {
      try {
        child.postMessage(message);
      } catch (error) {
        onError?.(error as Error);
      }
    },
    kill() {
      try { child.kill(); } catch {}
    },
    onMessage(listener) {
      child.on("message", listener);
    },
    onExit(listener) {
      const handler = (code: number | null) => listener(code, null);
      child.on("exit", handler);
      return () => child.removeListener?.("exit", handler);
    },
    onError(listener) {
      child.on("error", listener);
    },
  };
}

/**
 * Fork a Node worker. Electron main processes use utilityProcess so packaged
 * builds keep working with the RunAsNode fuse disabled; plain Node (tests,
 * benchmarks) falls back to child_process.fork.
 */
export function forkWorker(
  modulePath: string,
  args: string[] = [],
  env?: NodeJS.ProcessEnv,
): WorkerProcess {
  const utilityProcess = loadUtilityProcess();
  return utilityProcess
    ? createUtilityWorker(utilityProcess, modulePath, args, env)
    : createNodeWorker(modulePath, args, env);
}
