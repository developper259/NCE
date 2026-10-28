import type { WebContents } from "electron";
import type { IDisposable, IPty } from "node-pty";
import { terminalLimits, type TerminalOutputMessage } from "./TerminalTypes";

function splitUtf8(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes && bytes + size > maxBytes) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += character;
    bytes += size;
  }
  if (current) chunks.push(current);
  return chunks;
}

export class TerminalSession {
  readonly id: string;
  readonly workspaceKey: string;
  readonly owner: WebContents;
  private process: IPty | null;
  private readonly logger: Pick<Console, "error">;
  private dataSubscription: IDisposable | null = null;
  private exitSubscription: IDisposable | null = null;
  private exited = false;
  private disposed = false;
  private processExited = false;
  private processExitPromise: Promise<void>;
  private resolveProcessExit!: () => void;
  private disposalWait: Promise<boolean> | null = null;
  private pendingExit: { exitCode: number; signal: number | null } | null = null;
  private queue: string[] = [];
  private queuedBytes = 0;
  private sequence = 1;
  private inFlight: { sequence: number; bytes: number } | null = null;
  private paused = false;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    id: string,
    workspaceKey: string,
    owner: WebContents,
    process: IPty,
    logger: Pick<Console, "error">,
  ) {
    this.id = id;
    this.workspaceKey = workspaceKey;
    this.owner = owner;
    this.process = process;
    this.logger = logger;
    this.processExitPromise = new Promise((resolve) => { this.resolveProcessExit = resolve; });
    this.dataSubscription = process.onData((data) => this.enqueue(data));
    this.exitSubscription = process.onExit(({ exitCode, signal }) => {
      this.processExited = true;
      this.exited = true;
      this.process = null;
      this.resolveProcessExit();
      this.disposeSubscriptions();
      if (this.disposed) return;
      this.pendingExit = { exitCode, signal: signal ?? null };
      this.dispatchNext();
    });
  }

  get isExited(): boolean {
    return this.exited;
  }

  write(data: string): boolean {
    if (this.exited || this.disposed || Buffer.byteLength(data, "utf8") > terminalLimits.maxWriteBytes) return false;
    try {
      this.process?.write(data);
      return Boolean(this.process);
    } catch {
      return false;
    }
  }

  resize(cols: number, rows: number): boolean {
    if (this.exited || this.disposed) return false;
    try {
      this.process?.resize(cols, rows);
      return Boolean(this.process);
    } catch {
      return false;
    }
  }

  acknowledge(sequence: number): boolean {
    if (this.disposed || !this.inFlight || this.inFlight.sequence !== sequence) return false;
    this.inFlight = null;
    this.clearAckTimer();
    if (this.paused && this.queuedBytes < terminalLimits.outputResumeBytes) {
      this.paused = false;
      try { this.process?.resume(); } catch {}
    }
    this.dispatchNext();
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopProcess();
    this.queue = [];
    this.queuedBytes = 0;
    this.inFlight = null;
    this.clearAckTimer();
    this.dataSubscription?.dispose();
    this.dataSubscription = null;
    if (this.processExited) {
      this.exitSubscription?.dispose();
      this.exitSubscription = null;
    }
  }

  async disposeAndWait(timeoutMs = 5000): Promise<boolean> {
    this.dispose();
    if (this.processExited) return true;
    if (!this.disposalWait) {
      this.disposalWait = new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.disposeSubscriptions();
          resolve(false);
        }, timeoutMs);
        void this.processExitPromise.then(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    }
    return this.disposalWait;
  }

  whenProcessExited(): Promise<void> {
    return this.processExitPromise;
  }

  private enqueue(data: string): void {
    if (this.exited || this.disposed || !data) return;
    const bytes = Buffer.byteLength(data, "utf8");
    if (this.queuedBytes + bytes + (this.inFlight?.bytes || 0) > terminalLimits.maxOutputBytes) {
      this.send("Terminal:error", {
        sessionId: this.id,
        workspaceKey: this.workspaceKey,
        error: {
          code: "OUTPUT_LIMIT",
          message: "Terminal output exceeded the safe buffering limit; the process was stopped.",
        },
      });
      this.exited = true;
      this.stopProcess();
      this.queue = [];
      this.queuedBytes = 0;
      this.inFlight = null;
      return;
    }
    this.queue.push(...splitUtf8(data, terminalLimits.outputChunkBytes));
    this.queuedBytes += bytes;
    if (!this.paused && this.queuedBytes >= terminalLimits.outputPauseBytes) {
      this.paused = true;
      try { this.process?.pause(); } catch {}
    }
    this.dispatchNext();
  }

  private dispatchNext(): void {
    if (this.disposed || this.inFlight) return;
    if (!this.queue.length) {
      if (this.pendingExit) {
        const exit = this.pendingExit;
        this.pendingExit = null;
        this.send("Terminal:exit", {
          sessionId: this.id,
          workspaceKey: this.workspaceKey,
          exitCode: exit.exitCode,
          signal: exit.signal,
        });
      }
      return;
    }
    const data = this.queue.shift()!;
    const bytes = Buffer.byteLength(data, "utf8");
    this.queuedBytes -= bytes;
    const sequence = this.sequence++;
    this.inFlight = { sequence, bytes };
    this.armAckTimer(sequence);
    const delivered = this.send("Terminal:output", {
      sessionId: this.id,
      workspaceKey: this.workspaceKey,
      sequence,
      data,
    } satisfies TerminalOutputMessage);
    if (!delivered) {
      this.inFlight = null;
      this.clearAckTimer();
      this.exited = true;
      this.queue = [];
      this.queuedBytes = 0;
      this.stopProcess();
    }
  }

  private armAckTimer(sequence: number): void {
    this.clearAckTimer();
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      if (!this.inFlight || this.inFlight.sequence !== sequence) return;
      this.inFlight = null;
      this.send("Terminal:error", {
        sessionId: this.id,
        workspaceKey: this.workspaceKey,
        error: {
          code: "OUTPUT_ACK_TIMEOUT",
          message: "Terminal output delivery stalled; the process was stopped.",
        },
      });
      this.exited = true;
      this.queue = [];
      this.queuedBytes = 0;
      this.stopProcess();
    }, terminalLimits.outputAckTimeoutMs);
    this.ackTimer.unref?.();
  }

  private clearAckTimer(): void {
    if (!this.ackTimer) return;
    clearTimeout(this.ackTimer);
    this.ackTimer = null;
  }

  private stopProcess(): void {
    if (this.exited && !this.process) return;
    this.exited = true;
    this.clearAckTimer();
    const processHandle = this.process;
    this.process = null;
    if (!processHandle) return;
    if (process.platform === "win32") {
      try { processHandle.kill(); } catch {}
      return;
    }
    const pid = Number.isInteger(processHandle.pid) ? processHandle.pid : null;
    const signal = (name: "SIGHUP" | "SIGKILL") => {
      if (pid) {
        try { process.kill(-pid, name); return; } catch {}
      }
      try { processHandle.kill(name); } catch {}
    };
    signal("SIGHUP");
    const timer = setTimeout(() => signal("SIGKILL"), 750);
    timer.unref?.();
    void this.processExitPromise.finally(() => clearTimeout(timer));
  }

  private disposeSubscriptions(): void {
    this.dataSubscription?.dispose();
    this.exitSubscription?.dispose();
    this.dataSubscription = null;
    this.exitSubscription = null;
  }

  private send(channel: string, payload: unknown): boolean {
    if (this.owner.isDestroyed()) return false;
    try {
      this.owner.send(channel, payload);
      return true;
    } catch (error) {
      this.logger.error("[Terminal] Failed to send PTY event", error);
      return false;
    }
  }
}
