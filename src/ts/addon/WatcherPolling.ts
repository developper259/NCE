import { EventEmitter } from "node:events";
import { fork, ChildProcess } from "node:child_process";
const path = require("node:path");

const FOREGROUND_INTERVALS = { interval: 400, binaryInterval: 1000 } as const;
const BACKGROUND_INTERVALS = { interval: 2000, binaryInterval: 5000 } as const;

export class PollingWatcher extends EventEmitter {
  private child: ChildProcess | null = null;
  private candidate: ChildProcess | null = null;
  private candidateForeground = true;
  private activeForeground: boolean;
  private desiredForeground: boolean;
  private initialReady = false;
  private closing: Promise<void> | null = null;
  private transitionTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly closingWorkers = new WeakMap<ChildProcess, Promise<void>>();
  private readonly intentionallyClosing = new WeakSet<ChildProcess>();
  private readonly transitionEvents = new Map<string, Set<ChildProcess>>();
  private readonly projectPath: string;

  constructor(projectPath: string, foreground = true) {
    super();
    this.projectPath = projectPath;
    this.activeForeground = foreground;
    this.desiredForeground = foreground;
    this.child = this.createWorker(projectPath, foreground);
  }

  private createWorker(projectPath: string, foreground: boolean): ChildProcess {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    const child = fork(
      path.join(__dirname, "WatcherPollingWorker.js"),
      [projectPath, foreground ? "foreground" : "background"],
      { execPath: process.execPath, env, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    this.attachWorker(child);
    return child;
  }

  private attachWorker(child: ChildProcess): void {
    child.on("message", (message: any) => {
      if (child !== this.child && child !== this.candidate) return;
      if (message?.type === "ready") {
        if (child === this.child) {
          this.initialReady = true;
          this.emit("ready");
          this.emit("mode", this.modeDetails(this.activeForeground));
          this.beginTransition();
        } else {
          this.scheduleTransition();
        }
      }
      if (message?.type === "all") {
        if (this.candidate) {
          const key = JSON.stringify([message.event, message.filePath, message.signature]);
          const sources = this.transitionEvents.get(key);
          if (sources) {
            sources.add(child);
            return;
          }
          this.transitionEvents.set(key, new Set([child]));
          if (this.transitionEvents.size > 2048)
            this.transitionEvents.delete(this.transitionEvents.keys().next().value!);
        }
        this.emit("all", message.event, message.filePath);
      }
      if (message?.type === "error") {
        const error: any = new Error(message.error?.message || "Polling watcher failed");
        error.code = message.error?.code;
        error.path = message.error?.path;
        if (child === this.candidate) this.failCandidate(child, error);
        else this.emit("error", error);
      }
    });
    child.on("error", (error) => {
      if (child === this.candidate) this.failCandidate(child, error);
      else if (child === this.child) this.emit("error", error);
    });
    child.on("exit", (code, signal) => {
      const wasClosing = this.intentionallyClosing.has(child) || Boolean(this.closing);
      if (child === this.candidate) {
        this.candidate = null;
        this.clearTransitionTimer();
        if (!wasClosing && code !== 0) {
          this.emit("mode-error", new Error(`Polling watcher transition exited (${code ?? signal}).`));
        }
        return;
      }
      if (child === this.child) {
        this.child = null;
        if (!wasClosing && code !== 0) {
          this.emit("error", new Error(`Polling watcher exited (${code ?? signal}).`));
        }
      }
    });
  }

  private modeDetails(foreground: boolean) {
    return {
      foreground,
      ...(foreground ? FOREGROUND_INTERVALS : BACKGROUND_INTERVALS),
    };
  }

  private beginTransition(): void {
    if (this.closing || !this.initialReady || !this.child || this.candidate) return;
    if (this.desiredForeground === this.activeForeground) return;
    this.candidateForeground = this.desiredForeground;
    this.candidate = this.createWorker(
      this.getProjectPath(),
      this.candidateForeground,
    );
  }

  private getProjectPath(): string {
    // All polling workers for this watcher monitor the same root.
    return this.projectPath;
  }

  private scheduleTransition(): void {
    if (this.closing || !this.candidate || !this.child || this.transitionTimer) return;
    const graceMs = this.activeForeground
      ? FOREGROUND_INTERVALS.interval
      : BACKGROUND_INTERVALS.interval;
    const candidate = this.candidate;
    this.transitionTimer = setTimeout(() => {
      this.transitionTimer = null;
      if (this.closing || this.candidate !== candidate || !this.child) return;
      const previous = this.child;
      this.child = candidate;
      this.candidate = null;
      this.activeForeground = this.candidateForeground;
      this.transitionEvents.clear();
      this.emit("mode", this.modeDetails(this.activeForeground));
      void this.closeWorker(previous);
      this.beginTransition();
    }, graceMs);
  }

  private failCandidate(child: ChildProcess, error: Error): void {
    if (this.candidate !== child) return;
    this.candidate = null;
    this.transitionEvents.clear();
    this.clearTransitionTimer();
    void this.closeWorker(child);
    this.emit("mode-error", error);
  }

  private clearTransitionTimer(): void {
    if (!this.transitionTimer) return;
    clearTimeout(this.transitionTimer);
    this.transitionTimer = null;
  }

  private closeWorker(child: ChildProcess): Promise<void> {
    const existing = this.closingWorkers.get(child);
    if (existing) return existing;
    this.intentionallyClosing.add(child);
    const closing = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      if (child.connected) child.send({ type: "close" });
      else child.kill("SIGTERM");
    });
    this.closingWorkers.set(child, closing);
    return closing;
  }

  setForeground(foreground: boolean): void {
    if (this.closing || this.desiredForeground === foreground) return;
    this.desiredForeground = foreground;
    if (this.candidate) {
      const candidate = this.candidate;
      this.candidate = null;
      this.transitionEvents.clear();
      this.clearTransitionTimer();
      void this.closeWorker(candidate);
    }
    this.beginTransition();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.clearTransitionTimer();
    const workers = [...new Set([this.child, this.candidate].filter(Boolean) as ChildProcess[])];
    this.child = null;
    this.candidate = null;
    this.transitionEvents.clear();
    this.closing = Promise.all(workers.map((child) => this.closeWorker(child))).then(() => undefined);
    return this.closing;
  }
}
