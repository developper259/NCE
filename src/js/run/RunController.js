/**
 * Run controller: the state machine and the log model for one Run session.
 *
 * This class holds no DOM. It receives events from the main process, decides
 * what state the run is really in, and keeps an ordered list of log entries.
 * The view renders what this reports. Splitting it this way means the
 * lifecycle can be tested without a browser, and the view cannot invent a
 * state the engine never reported.
 *
 * Two invariants:
 *
 * - Only one run id is current. Every event carries a run id; anything from a
 *   different id is a late event from a finished run and is dropped.
 * - A state only moves forward. `success` never becomes `running`, and a
 *   cancelled run never becomes an error.
 */

/** Lifecycle states, matching the supervisor's. */
const RUN_STATES = Object.freeze({
  IDLE: "idle",
  RESOLVING: "resolving",
  STARTING: "starting",
  RUNNING: "running",
  STOPPING: "stopping",
  SUCCESS: "success",
  ERROR: "error",
  CANCELLED: "cancelled",
});

/** States in which a process exists or is about to. */
const LIVE_STATES = new Set([
  RUN_STATES.RESOLVING,
  RUN_STATES.STARTING,
  RUN_STATES.RUNNING,
  RUN_STATES.STOPPING,
]);

/** States that end a run. */
const TERMINAL_STATES = new Set([
  RUN_STATES.SUCCESS,
  RUN_STATES.ERROR,
  RUN_STATES.CANCELLED,
]);

/** Log entry kinds. `system` is NCE talking, never the program. */
const ENTRY_KINDS = Object.freeze({
  STDOUT: "stdout",
  STDERR: "stderr",
  SYSTEM: "system",
  ERROR: "error",
});

/** Cap on retained entries, so a long run cannot grow without bound. */
const MAX_ENTRIES = 20000;
/** Cap on retained characters across all entries. */
const MAX_CHARACTERS = 4 * 1024 * 1024;

class RunController {
  static STATES = RUN_STATES;
  static KINDS = ENTRY_KINDS;

  constructor(options = {}) {
    this.onChange = typeof options.onChange === "function" ? options.onChange : null;
    this.onEntry = typeof options.onEntry === "function" ? options.onEntry : null;

    this.state = RUN_STATES.IDLE;
    this.runId = null;
    this.target = null;
    this.runtime = null;
    this.error = null;
    this.exit = null;
    this.entries = [];
    this.characters = 0;
    this.droppedEntries = 0;
    /** Monotonic counter so the view can key entries without reindexing. */
    this.sequence = 0;
  }

  /** True while a process exists or is starting. */
  get isLive() {
    return LIVE_STATES.has(this.state);
  }

  /** True when the run has ended and its result is on screen. */
  get isTerminal() {
    return TERMINAL_STATES.has(this.state);
  }

  /** True when Stop should be offered. */
  get canStop() {
    return (
      this.state === RUN_STATES.RUNNING ||
      this.state === RUN_STATES.STARTING ||
      this.state === RUN_STATES.RESOLVING
    );
  }

  /** True when the user has asked to stop and the process has not exited. */
  get isStopping() {
    return this.state === RUN_STATES.STOPPING;
  }

  begin(target, runId) {
    this.state = RUN_STATES.RESOLVING;
    this.runId = runId || null;
    this.target = target || null;
    this.runtime = null;
    this.error = null;
    this.exit = null;
    this.entries = [];
    this.characters = 0;
    this.droppedEntries = 0;
    this.notify();
  }

  /** Adopt the run id the main process assigned. */
  adoptRunId(runId) {
    if (typeof runId === "string" && runId) this.runId = runId;
  }

  /** Reset to idle, discarding the previous run's log. */
  reset() {
    this.state = RUN_STATES.IDLE;
    this.runId = null;
    this.target = null;
    this.runtime = null;
    this.error = null;
    this.exit = null;
    this.entries = [];
    this.characters = 0;
    this.droppedEntries = 0;
    this.notify();
  }

  /**
   * Apply an event from the main process.
   *
   * Returns true when the event was accepted, false when it was dropped as
   * stale. The view uses that to decide whether to repaint.
   */
  apply(event) {
    if (!event || typeof event !== "object") return false;
    const runId = typeof event.runId === "string" ? event.runId : null;

    // A run id that is not the current one is a late event. Drop it rather
    // than let a finished run write into the new run's panel.
    if (runId && this.runId && runId !== this.runId) return false;
    if (runId && !this.runId) this.runId = runId;

    switch (event.type) {
      case "state": {
        this.applyState(event.state);
        return true;
      }
      case "runtime": {
        this.runtime = {
          executable: String(event.executable || ""),
          version: event.version ? String(event.version) : null,
          source: String(event.source || ""),
        };
        this.notify();
        return true;
      }
      case "system": {
        this.append(ENTRY_KINDS.SYSTEM, String(event.text || ""));
        return true;
      }
      case "output": {
        const stream = event.stream === "stderr" ? ENTRY_KINDS.STDERR : ENTRY_KINDS.STDOUT;
        this.append(stream, String(event.text || ""));
        return true;
      }
      case "error": {
        this.error = {
          code: String(event.code || "RUN_FAILED"),
          message: String(event.message || ""),
          title: String(event.title || "Cannot run this file"),
        };
        this.append(ENTRY_KINDS.ERROR, this.error.message);
        this.notify();
        return true;
      }
      case "exit": {
        this.exit = {
          exitCode: Number.isFinite(event.exitCode) ? event.exitCode : null,
          signal: event.signal ? String(event.signal) : null,
          durationMs: Number.isFinite(event.durationMs) ? event.durationMs : 0,
          cancelled: event.cancelled === true,
          timedOut: event.timedOut === true,
          truncated: event.truncated === true,
        };
        this.notify();
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * Move to a new state, refusing to move backwards.
   *
   * A terminal state is final: once a run has ended, a stray `running` event
   * from a dying process cannot resurrect it.
   */
  applyState(next) {
    if (!Object.values(RUN_STATES).includes(next)) return;
    if (TERMINAL_STATES.has(this.state) && !TERMINAL_STATES.has(next)) return;
    if (this.state === next) return;
    this.state = next;
    this.notify();
  }

  /**
   * Append a log entry.
   *
   * Consecutive chunks on the same stream are merged into one entry, so a
   * program printing one character at a time produces one entry rather than
   * thousands. That keeps the DOM small and the scroll stable.
   */
  append(kind, text) {
    if (!text) return;
    const last = this.entries[this.entries.length - 1];
    if (last && last.kind === kind && !last.closed) {
      last.text += text;
      this.characters += text.length;
    } else {
      this.entries.push({
        id: ++this.sequence,
        kind,
        text,
        closed: false,
      });
      this.characters += text.length;
    }
    this.trim();
    if (this.onEntry) this.onEntry(this.entries[this.entries.length - 1], kind);
  }

  /**
   * Close the current entry so the next chunk starts a new one.
   *
   * Used when a system message or an error interrupts a stream, so program
   * output and NCE's own messages never merge into one block.
   */
  seal() {
    const last = this.entries[this.entries.length - 1];
    if (last) last.closed = true;
  }

  /** Drop the oldest entries once the caps are exceeded. */
  trim() {
    while (
      this.entries.length > MAX_ENTRIES ||
      this.characters > MAX_CHARACTERS
    ) {
      const removed = this.entries.shift();
      if (!removed) break;
      this.characters -= removed.text.length;
      this.droppedEntries += 1;
    }
  }

  /** Clear the visible log without touching the process. */
  clear() {
    this.entries = [];
    this.characters = 0;
    this.droppedEntries = 0;
    this.notify();
  }

  notify() {
    if (this.onChange) this.onChange(this);
  }

  /** A short, human summary of the current state. */
  describe() {
    const name = this.target?.name || "The program";
    switch (this.state) {
      case RUN_STATES.IDLE:
        return this.target ? `Ready to run ${name}.` : "Nothing to run.";
      case RUN_STATES.RESOLVING:
        return `Finding a runtime for ${name}…`;
      case RUN_STATES.STARTING:
        return `Starting ${name}…`;
      case RUN_STATES.RUNNING:
        return `${name} is running.`;
      case RUN_STATES.STOPPING:
        return `Stopping ${name}…`;
      case RUN_STATES.SUCCESS: {
        const duration = RunController.formatDuration(this.exit?.durationMs);
        return duration ? `${name} finished in ${duration}.` : `${name} finished.`;
      }
      case RUN_STATES.CANCELLED:
        return `${name} was stopped.`;
      case RUN_STATES.ERROR: {
        if (this.error) return this.error.title;
        const code = this.exit?.exitCode;
        const duration = RunController.formatDuration(this.exit?.durationMs);
        if (this.exit?.timedOut)
          return `${name} did not finish${duration ? ` after ${duration}` : ""}.`;
        if (code === null || code === undefined)
          return `${name} stopped unexpectedly.`;
        return `${name} exited with code ${code}${duration ? ` after ${duration}` : ""}.`;
      }
      default:
        return "";
    }
  }

  static formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.round((ms % 60000) / 1000);
    return `${minutes} min ${seconds} s`;
  }
}

if (typeof window !== "undefined") window.RunController = RunController;
