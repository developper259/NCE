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
  readonly owner: WebContents;
  private process: IPty | null;
  private readonly logger: Pick<Console, "error">;
  private dataSubscription: IDisposable | null = null;
  private exitSubscription: IDisposable | null = null;
  private exited = false;
  private disposed = false;
  private pendingExit: { exitCode: number; signal: number | null } | null = null;
  private queue: string[] = [];
  private queuedBytes = 0;
  private sequence = 1;
  private inFlight: { sequence: number; bytes: number } | null = null;
  private paused = false;

  constructor(id: string, owner: WebContents, process: IPty, logger: Pick<Console, "error">) {
    this.id = id;
    this.owner = owner;
    this.process = process;
    this.logger = logger;
    this.dataSubscription = process.onData((data) => this.enqueue(data));
    this.exitSubscription = process.onExit(({ exitCode, signal }) => {
      this.exited = true;
      this.process = null;
      this.disposeSubscriptions();
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
    this.disposeSubscriptions();
  }

  private enqueue(data: string): void {
    if (this.exited || this.disposed || !data) return;
    const bytes = Buffer.byteLength(data, "utf8");
    if (this.queuedBytes + bytes + (this.inFlight?.bytes || 0) > terminalLimits.maxOutputBytes) {
      this.send("Terminal:error", {
        sessionId: this.id,
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
    this.send("Terminal:output", {
      sessionId: this.id,
      sequence,
      data,
    } satisfies TerminalOutputMessage);
  }

  private stopProcess(): void {
    if (this.exited && !this.process) return;
    this.exited = true;
    try { this.process?.kill(); } catch {}
    this.process = null;
  }

  private disposeSubscriptions(): void {
    this.dataSubscription?.dispose();
    this.exitSubscription?.dispose();
    this.dataSubscription = null;
    this.exitSubscription = null;
  }

  private send(channel: string, payload: unknown): void {
    if (this.owner.isDestroyed()) return;
    try { this.owner.send(channel, payload); }
    catch (error) { this.logger.error("[Terminal] Failed to send PTY event", error); }
  }
}
