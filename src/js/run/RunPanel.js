/**
 * Run panel: executes the current file and shows its output.
 *
 * This is deliberately not the terminal and not the test runner. The terminal
 * is an interactive shell the user drives; the test runner discovers a project
 * test command. Run executes one file with the runtime the project already
 * resolves to, and streams what it printed.
 *
 * The process itself is started in the main process through Agent:runProcess,
 * which validates the workspace, resolves the runtime, asks for approval and
 * spawns without a shell. Nothing here builds a command line.
 */
class RunPanel {
  /** Strategies the controlled runner accepts for a single file. */
  static STRATEGY_BY_LANGUAGE = {
    python: "python-script",
    javascript: "node-script",
    typescript: "node-script",
  };

  /** File extensions each language may run through the strategies above. */
  static EXTENSIONS_BY_LANGUAGE = {
    python: [".py"],
    javascript: [".js", ".mjs", ".cjs"],
    typescript: [".ts", ".mts", ".cts"],
  };

  /**
   * Why a file cannot be run, or null when it can.
   *
   * Returning a reason instead of a boolean keeps the button honest: the panel
   * can say what is missing rather than silently doing nothing.
   */
  static describeRunTarget(file) {
    if (!file) return { runnable: false, reason: "Open a file to run it." };
    if (file.isPicture || file.type === "picture")
      return { runnable: false, reason: "Images cannot be run." };
    if (!file.path)
      return { runnable: false, reason: "Save the file before running it." };
    if (!file.isSaved)
      return { runnable: false, reason: "Save the file before running it." };
    const language = String(file.language || "").toLowerCase();
    const strategy = RunPanel.STRATEGY_BY_LANGUAGE[language];
    if (!strategy)
      return {
        runnable: false,
        reason: `Running ${language || "this file type"} is not supported yet.`,
      };
    const name = String(file.name || file.path).toLowerCase();
    const extensions = RunPanel.EXTENSIONS_BY_LANGUAGE[language] || [];
    if (!extensions.some((extension) => name.endsWith(extension)))
      return {
        runnable: false,
        reason: `Only ${extensions.join(", ")} files run as ${language}.`,
      };
    return { runnable: true, strategy, language };
  }

  static formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  }

  constructor(editor) {
    this.editor = editor;
    this.element = document.createElement("div");
    this.element.className = "run-panel";

    this.header = document.createElement("div");
    this.header.className = "run-panel-header";
    this.summary = document.createElement("span");
    this.summary.className = "run-panel-summary";
    this.actions = document.createElement("div");
    this.actions.className = "run-panel-actions";
    this.stopButton = document.createElement("button");
    this.stopButton.type = "button";
    this.stopButton.className = "run-panel-button";
    this.stopButton.textContent = "Stop";
    this.stopButton.hidden = true;
    this.clearButton = document.createElement("button");
    this.clearButton.type = "button";
    this.clearButton.className = "run-panel-button";
    this.clearButton.textContent = "Clear";
    this.actions.append(this.stopButton, this.clearButton);
    this.header.append(this.summary, this.actions);

    this.output = document.createElement("pre");
    this.output.className = "run-panel-output";
    this.output.setAttribute("role", "log");
    this.output.setAttribute("aria-live", "polite");
    this.output.tabIndex = 0;

    this.element.append(this.header, this.output);

    this.requestId = null;
    this.running = false;
    this.lastTarget = null;

    this.stopButton.addEventListener("click", () => this.stop());
    this.clearButton.addEventListener("click", () => this.clear());
    this.renderIdle();
  }

  /** Text shown before any run, so the panel is never an empty rectangle. */
  renderIdle() {
    const target = RunPanel.describeRunTarget(this.editor.tabManager?.activeFile);
    this.summary.textContent = target.runnable
      ? `Ready to run ${this.editor.tabManager.activeFile.name}.`
      : target.reason;
    this.summary.dataset.state = target.runnable ? "ready" : "unavailable";
  }

  clear() {
    this.output.textContent = "";
    if (!this.running) this.renderIdle();
  }

  focus() {
    this.output.focus();
  }

  onOpen() {
    this.renderIdle();
  }

  onActivate() {
    this.renderIdle();
  }

  onDeactivate() {}

  onClose() {}

  appendOutput(text) {
    if (!text) return;
    this.output.textContent += text;
    this.output.scrollTop = this.output.scrollHeight;
  }

  setRunning(running) {
    this.running = running;
    this.stopButton.hidden = !running;
  }

  /**
   * Run the active file.
   *
   * `requestId` is derived from the file and a counter so a second click cannot
   * adopt the response of the first, and Stop always targets the process that
   * is actually running.
   */
  async run() {
    if (this.running) return { success: false, code: "ALREADY_RUNNING" };
    const file = this.editor.tabManager?.activeFile;
    const target = RunPanel.describeRunTarget(file);
    if (!target.runnable) {
      this.summary.textContent = target.reason;
      this.summary.dataset.state = "unavailable";
      return { success: false, code: "NOT_RUNNABLE", reason: target.reason };
    }
    const root = this.editor.fileExplorer?.rootPath;
    if (typeof root !== "string" || !root.trim()) {
      const reason = "Open a folder before running a file.";
      this.summary.textContent = reason;
      this.summary.dataset.state = "unavailable";
      return { success: false, code: "NO_WORKSPACE", reason };
    }
    const api = this.editor.api;
    if (typeof api?.runAgentProcess !== "function") {
      const reason = "Running files is unavailable in this build.";
      this.summary.textContent = reason;
      this.summary.dataset.state = "unavailable";
      return { success: false, code: "UNAVAILABLE", reason };
    }

    this.lastTarget = file;
    this.requestId = `run:${file.id}:${Date.now()}`;
    this.setRunning(true);
    this.output.textContent = "";
    this.summary.textContent = `Running ${file.name}…`;
    this.summary.dataset.state = "running";

    let result;
    try {
      result = await api.runAgentProcess({
        strategy: target.strategy,
        projectRoot: root,
        cwd: root,
        target: file.path,
        workspaceRoot: root,
        requestId: this.requestId,
        timeoutMs: 120000,
        maxOutputCharacters: 200000,
      });
    } catch (error) {
      result = {
        success: false,
        error: { code: "RUN_FAILED", message: error?.message || String(error) },
      };
    } finally {
      this.setRunning(false);
    }

    this.renderResult(file, result);
    return result;
  }

  renderResult(file, result) {
    const stdout = typeof result?.stdout === "string" ? result.stdout : "";
    const stderr = typeof result?.stderr === "string" ? result.stderr : "";
    const combined = [stdout, stderr].filter(Boolean).join("");
    this.output.textContent = combined || "(no output)";

    if (result?.error) {
      this.summary.textContent = RunPanel.describeError(result.error, file);
      this.summary.dataset.state = "failed";
      return;
    }
    if (result?.timedOut) {
      this.summary.textContent = `${file.name} timed out after ${RunPanel.formatDuration(result.durationMs)}.`;
      this.summary.dataset.state = "failed";
      return;
    }
    const code = result?.exitCode;
    const duration = RunPanel.formatDuration(result?.durationMs);
    if (code === 0) {
      this.summary.textContent = `${file.name} finished successfully${duration ? ` in ${duration}` : ""}.`;
      this.summary.dataset.state = "success";
      return;
    }
    this.summary.textContent = code === null || code === undefined
      ? `${file.name} stopped${duration ? ` after ${duration}` : ""}.`
      : `${file.name} exited with code ${code}${duration ? ` after ${duration}` : ""}.`;
    this.summary.dataset.state = "failed";
  }

  /**
   * Turn a runner error code into something a user can act on.
   *
   * The technical code stays in the log line; the summary explains the cause
   * and what to do about it.
   */
  static describeError(error, file) {
    const code = String(error?.code || "");
    const language = String(file?.language || "").toLowerCase();
    const runtimeName = language === "python" ? "Python" : "Node.js";
    switch (code) {
      case "RUNTIME_UNAVAILABLE":
        return `${runtimeName} is not available. Install it from the Version Manager.`;
      case "NO_ACTIVE_WORKSPACE":
        return "Open a folder before running a file.";
      case "OUTSIDE_WORKSPACE":
        return "This file is outside the open folder.";
      case "WORKSPACE_CHANGED":
        return "The folder changed while the file was starting.";
      case "INVALID_TARGET":
        return "The file could not be found on disk.";
      case "EXECUTION_CANCELLED":
        return "Run cancelled.";
      case "NOT_RUNNABLE":
        return "This file cannot be run.";
      default:
        return error?.message || "The file could not be started.";
    }
  }

  async stop() {
    if (!this.running || !this.requestId) return false;
    const api = this.editor.api;
    if (typeof api?.cancelAgentProcess !== "function") return false;
    const cancelled = await api.cancelAgentProcess(this.requestId);
    if (cancelled) {
      this.summary.textContent = "Stopping…";
      this.summary.dataset.state = "running";
    }
    return Boolean(cancelled);
  }
}
