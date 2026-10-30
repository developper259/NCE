import { EventEmitter } from "node:events";
import { forkWorker, type WorkerProcess } from "./WorkerProcess";
import {
  FOREGROUND_INTERVALS,
  BACKGROUND_INTERVALS,
  WRITE_SETTLE_MS,
  TRANSITION_MARGIN_MS,
} from "./WatcherPollingConfig";
const path = require("node:path");

export class PollingWatcher extends EventEmitter {
  private child: WorkerProcess | null = null;
  private candidate: WorkerProcess | null = null;
  private candidateForeground = true;
  private activeForeground: boolean;
  private desiredForeground: boolean;
  private initialReady = false;
  private closing: Promise<void> | null = null;
  private transitionTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly closingWorkers = new WeakMap<WorkerProcess, Promise<void>>();
  private readonly intentionallyClosing = new WeakSet<WorkerProcess>();
  private readonly transitionEvents = new Map<string, Set<WorkerProcess>>();
  private readonly projectPath: string;

  constructor(projectPath: string, foreground = true) {
    super();
    this.projectPath = projectPath;
    this.activeForeground = foreground;
    this.desiredForeground = foreground;
    this.child = this.createWorker(projectPath, foreground);
  }

  private createWorker(projectPath: string, foreground: boolean): WorkerProcess {
    const child = forkWorker(
      path.join(__dirname, "WatcherPollingWorker.js"),
      [projectPath, foreground ? "foreground" : "background"],
    );
    this.attachWorker(child);
    return child;
  }

  private attachWorker(child: WorkerProcess): void {
    child.onMessage((message: any) => {
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
    child.onError((error) => {
      if (child === this.candidate) this.failCandidate(child, error);
      else if (child === this.child) this.emit("error", error);
    });
    child.onExit((code, signal) => {
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
    // The previous worker must still get one poll, let the change settle, and
    // deliver it over IPC before it is closed; a bare interval lost events.
    const graceMs = (this.activeForeground
      ? FOREGROUND_INTERVALS.interval
      : BACKGROUND_INTERVALS.interval) + WRITE_SETTLE_MS + TRANSITION_MARGIN_MS;
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

  private failCandidate(child: WorkerProcess, error: Error): void {
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

  private closeWorker(child: WorkerProcess): Promise<void> {
    const existing = this.closingWorkers.get(child);
    if (existing) return existing;
    this.intentionallyClosing.add(child);
    const closing = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 2000);
      child.onExit(() => {
        clearTimeout(timer);
        resolve();
      });
      child.postMessage({ type: "close" }, () => child.kill());
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
    const workers = [...new Set([this.child, this.candidate].filter(Boolean) as WorkerProcess[])];
    this.child = null;
    this.candidate = null;
    this.transitionEvents.clear();
    this.closing = Promise.all(workers.map((child) => this.closeWorker(child))).then(() => undefined);
    return this.closing;
  }
}
