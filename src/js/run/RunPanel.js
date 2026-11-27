/**
 * Run panel: the OUTPUT view for a single file run.
 *
 * This is a view over RunController. It draws what the controller reports and
 * sends user intent back to it; it does not decide whether a process is alive
 * and it does not build command lines. The main process owns the process, the
 * controller owns the state, this owns the pixels.
 *
 * It is deliberately not the terminal: there is no input, no prompt, no ANSI
 * emulation. A program that wants input will block, exactly as it would in a
 * pipe, and the panel says so rather than pretending to be a shell.
 */

/** Languages the renderer offers to run, mirroring the main-process table. */
const RUNNABLE = Object.freeze({
  python: { strategy: "python-script", label: "Python", extensions: [".py"] },
  javascript: {
    strategy: "node-script",
    label: "Node.js",
    extensions: [".js", ".mjs", ".cjs"],
  },
});

/** Languages NCE knows about but cannot run, with the reason to show. */
const UNRUNNABLE_REASONS = Object.freeze({
  typescript:
    "TypeScript needs a build step. Run the compiled JavaScript, or use the terminal.",
});

class RunPanel {
  static RUNNABLE = RUNNABLE;

  /**
   * Why a file cannot be run, or null when it can.
   *
   * These are the checks the renderer can make without asking the main
   * process. Runtime availability is confirmed separately, because only the
   * main process can look at the machine.
   *
   * `ignoreUnsaved` exists for the Run path itself: Run saves the file first,
   * so "unsaved" is a step to perform, not a reason to refuse. Everywhere else
   * (the button's enabled state, the idle message) it stays a refusal.
   */
  static describeRunTarget(file, { ignoreUnsaved = false } = {}) {
    if (!file) return { runnable: false, reason: "Open a file to run it." };
    if (file.isPicture || file.type === "picture")
      return { runnable: false, reason: "Images cannot be run." };
    if (!file.path)
      return { runnable: false, reason: "Save the file before running it." };
    if (!ignoreUnsaved && !file.isSaved)
      return { runnable: false, reason: "Save the file before running it." };

    const language = String(file.language || "").toLowerCase();
    const spec = RUNNABLE[language];
    if (!spec)
      return {
        runnable: false,
        reason:
          UNRUNNABLE_REASONS[language] ||
          `Running ${language || "this file type"} is not supported yet.`,
      };

    const name = String(file.name || file.path || "").toLowerCase();
    if (!spec.extensions.some((extension) => name.endsWith(extension)))
      return {
        runnable: false,
        reason: `Only ${spec.extensions.join(", ")} files run as ${spec.label}.`,
      };

    return { runnable: true, strategy: spec.strategy, language, label: spec.label };
  }

  constructor(editor) {
    this.editor = editor;
    this.controller = new RunController({
      onChange: () => {
        this.render();
        // The tab-strip control mirrors the run, so it repaints with the panel.
        this.editor.runAction?.refresh();
      },
      onEntry: (entry) => this.renderEntry(entry),
    });

    /** Entry id to its rendered text node, so growth is an append. */
    this.entryNodes = new Map();
    /** True while the view should follow new output. */
    this.following = true;
    this.unsubscribe = null;

    this.element = document.createElement("div");
    this.element.className = "run-panel";

    this.header = this.buildHeader();
    this.info = this.buildInfo();
    this.log = this.buildLog();
    this.errorBlock = this.buildErrorBlock();
    this.jumpButton = this.buildJumpButton();

    this.logWrap.append(this.log, this.jumpButton);
    this.element.append(this.header, this.info, this.errorBlock, this.logWrap);

    this.log.addEventListener("scroll", () => this.syncFollow());
    this.clearButton.addEventListener("click", () => this.clear());
    this.stopButton.addEventListener("click", () => void this.stop());

    this.subscribe();
    this.render();
  }

  // ---- construction -------------------------------------------------------

  buildHeader() {
    const header = document.createElement("div");
    header.className = "run-panel-header";

    const title = document.createElement("span");
    title.className = "run-panel-title";
    title.textContent = "OUTPUT";

    this.status = document.createElement("span");
    this.status.className = "run-panel-status";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");

    const heading = document.createElement("div");
    heading.className = "run-panel-heading";
    heading.append(title, this.status);

    const actions = document.createElement("div");
    actions.className = "run-panel-actions";

    this.stopButton = document.createElement("button");
    this.stopButton.type = "button";
    this.stopButton.className = "run-panel-button run-panel-stop";
    this.stopButton.textContent = "Stop";
    this.stopButton.title = "Stop the running program";
    this.stopButton.setAttribute("aria-label", "Stop the running program");
    this.stopButton.hidden = true;

    this.clearButton = document.createElement("button");
    this.clearButton.type = "button";
    this.clearButton.className = "run-panel-button";
    this.clearButton.textContent = "Clear";
    this.clearButton.title = "Clear the output. The program keeps running.";
    this.clearButton.setAttribute(
      "aria-label",
      "Clear the output. The program keeps running.",
    );

    actions.append(this.stopButton, this.clearButton);
    header.append(heading, actions);
    return header;
  }

  buildInfo() {
    const info = document.createElement("div");
    info.className = "run-panel-info";
    info.hidden = true;

    this.infoFile = document.createElement("span");
    this.infoFile.className = "run-panel-info-file";

    this.infoLanguage = document.createElement("span");
    this.infoLanguage.className = "run-panel-info-item";

    this.infoRuntime = document.createElement("span");
    this.infoRuntime.className = "run-panel-info-item run-panel-info-runtime";

    this.infoResult = document.createElement("span");
    this.infoResult.className = "run-panel-info-item run-panel-info-result";

    info.append(this.infoFile, this.infoLanguage, this.infoRuntime, this.infoResult);
    return info;
  }

  buildLog() {
    this.logWrap = document.createElement("div");
    this.logWrap.className = "run-panel-log-wrap";

    const log = document.createElement("div");
    log.className = "run-panel-log";
    log.setAttribute("role", "log");
    log.setAttribute("aria-live", "polite");
    log.setAttribute("aria-atomic", "false");
    log.tabIndex = 0;
    return log;
  }

  buildJumpButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "run-panel-jump";
    button.textContent = "Jump to latest";
    button.hidden = true;
    button.addEventListener("click", () => {
      this.following = true;
      this.scrollToEnd();
      this.syncFollow();
    });
    return button;
  }

  buildErrorBlock() {
    const block = document.createElement("div");
    block.className = "run-panel-error";
    block.hidden = true;
    block.setAttribute("role", "alert");

    this.errorTitle = document.createElement("p");
    this.errorTitle.className = "run-panel-error-title";

    this.errorMessage = document.createElement("p");
    this.errorMessage.className = "run-panel-error-message";

    this.errorActions = document.createElement("div");
    this.errorActions.className = "run-panel-error-actions";

    block.append(this.errorTitle, this.errorMessage, this.errorActions);
    return block;
  }

  // ---- lifecycle ----------------------------------------------------------

  /** Subscribe to main-process run events exactly once. */
  subscribe() {
    if (this.unsubscribe) return;
    const api = this.editor.api;
    if (typeof api?.onRunEvent !== "function") return;
    this.unsubscribe = api.onRunEvent((event) => this.handleEvent(event));
  }

  unsubscribeEvents() {
    if (typeof this.unsubscribe === "function") this.unsubscribe();
    this.unsubscribe = null;
  }

  handleEvent(event) {
    const accepted = this.controller.apply(event);
    if (!accepted) return;
    // A run that has ended is a good moment to stop following, so the final
    // output stays where the user can read it.
    if (this.controller.isTerminal && this.following) this.scrollToEnd();
  }

  onOpen() {
    this.subscribe();
    this.render();
  }

  onActivate() {
    this.subscribe();
    this.render();
  }

  onDeactivate() {}

  onClose() {}

  destroy() {
    this.unsubscribeEvents();
    this.entryNodes.clear();
  }

  focus() {
    this.log.focus();
  }

  // ---- rendering ----------------------------------------------------------

  render() {
    const state = this.controller.state;
    this.element.dataset.state = state;

    this.status.textContent = this.statusLabel();
    this.status.dataset.state = state;

    this.stopButton.hidden = !this.controller.canStop;
    this.stopButton.disabled = this.controller.isStopping;
    this.stopButton.textContent = this.controller.isStopping ? "Stopping…" : "Stop";

    this.renderInfo();
    this.renderError();
    this.renderEmptyState();
  }

  /** The word shown next to OUTPUT. Short, and true to the process. */
  statusLabel() {
    switch (this.controller.state) {
      case RunController.STATES.IDLE:
        return "";
      case RunController.STATES.RESOLVING:
        return "Resolving";
      case RunController.STATES.STARTING:
        return "Starting";
      case RunController.STATES.RUNNING:
        return "Running";
      case RunController.STATES.STOPPING:
        return "Stopping";
      case RunController.STATES.SUCCESS:
        return "Finished";
      case RunController.STATES.CANCELLED:
        return "Stopped";
      case RunController.STATES.ERROR:
        return "Failed";
      default:
        return "";
    }
  }

  renderInfo() {
    const { target, runtime, exit } = this.controller;
    const hasRun = Boolean(target);
    this.info.hidden = !hasRun;
    if (!hasRun) return;

    this.infoFile.textContent = target.name || target.path || "";
    this.infoFile.title = target.path || "";

    const spec = RunPanel.RUNNABLE[String(target.language || "").toLowerCase()];
    this.infoLanguage.textContent = spec ? spec.label : "";

    if (runtime) {
      const version = runtime.version ? ` ${runtime.version}` : "";
      const where = runtime.source === "project-venv" ? "project venv" : "PATH";
      this.infoRuntime.textContent = `${runtime.executable}${version} · ${where}`;
      this.infoRuntime.title = `${runtime.executable}${version} (${where})`;
    } else {
      this.infoRuntime.textContent = "";
      this.infoRuntime.title = "";
    }

    // Result is only meaningful once the process has ended.
    if (exit && this.controller.isTerminal) {
      const parts = [];
      if (this.controller.state === RunController.STATES.CANCELLED) {
        parts.push("stopped");
      } else if (exit.exitCode !== null && exit.exitCode !== undefined) {
        parts.push(`exit ${exit.exitCode}`);
      } else if (exit.signal) {
        parts.push(exit.signal);
      }
      const duration = RunController.formatDuration(exit.durationMs);
      if (duration) parts.push(duration);
      this.infoResult.textContent = parts.join(" · ");
      this.infoResult.dataset.state = this.controller.state;
    } else {
      this.infoResult.textContent = "";
      delete this.infoResult.dataset.state;
    }
  }

  /**
   * Show an actionable error block.
   *
   * Only errors that have a real remedy get an action. A program that exited
   * non-zero gets no button, because there is nothing for NCE to do about it.
   */
  renderError() {
    const error = this.controller.error;
    const state = this.controller.state;

    // A cancelled run is not an error and gets no block.
    if (!error || state === RunController.STATES.CANCELLED) {
      this.errorBlock.hidden = true;
      return;
    }

    this.errorBlock.hidden = false;
    this.errorTitle.textContent = error.title;
    this.errorMessage.textContent = error.message;
    this.errorActions.replaceChildren();

    const action = this.errorAction(error.code);
    if (action) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "run-panel-button run-panel-error-action";
      button.textContent = action.label;
      button.addEventListener("click", action.run);
      this.errorActions.append(button);
    }
  }

  /** The remedy for an error code, when one exists. */
  errorAction(code) {
    if (code === "RUNTIME_UNAVAILABLE")
      return {
        label: "Open Version Manager",
        run: () => this.editor.openVersionManager?.(),
      };
    return null;
  }

  /** A quiet line when there is nothing to show yet. */
  renderEmptyState() {
    const hasEntries = this.controller.entries.length > 0;
    const existing = this.log.querySelector?.(".run-panel-empty");

    if (hasEntries || this.controller.isLive) {
      if (existing) existing.remove();
      return;
    }
    if (existing) {
      existing.textContent = this.emptyText();
      return;
    }
    const empty = document.createElement("p");
    empty.className = "run-panel-empty";
    empty.textContent = this.emptyText();
    this.log.append(empty);
  }

  emptyText() {
    if (this.controller.state === RunController.STATES.IDLE) {
      const file = this.editor.tabManager?.activeFile;
      const target = RunPanel.describeRunTarget(file);
      return target.runnable
        ? `Press Run to execute ${file.name}.`
        : target.reason;
    }
    return "No output.";
  }

  /**
   * Append one log entry.
   *
   * Growth is an append on the entry's text node, not a rewrite of the log,
   * so a chatty program costs one DOM write per batch instead of a full
   * re-render per chunk. The controller merges consecutive chunks into one
   * entry, so the delta is whatever was added since the last render.
   */
  renderEntry(entry) {
    if (!entry) return;
    const empty = this.log.querySelector?.(".run-panel-empty");
    if (empty) empty.remove();

    let node = this.entryNodes.get(entry.id);
    if (!node) {
      const line = document.createElement("div");
      line.className = `run-panel-line run-panel-line-${entry.kind}`;
      line.dataset.kind = entry.kind;
      const text = document.createTextNode(entry.text);
      line.append(text);
      this.log.append(line);
      node = { line, text, length: entry.text.length };
      this.entryNodes.set(entry.id, node);
    } else if (entry.text.length > node.length) {
      node.text.appendData(entry.text.slice(node.length));
      node.length = entry.text.length;
    }

    if (this.following) this.scrollToEnd();
    else this.syncFollow();
  }

  // ---- scrolling ----------------------------------------------------------

  scrollToEnd() {
    this.log.scrollTop = this.log.scrollHeight;
  }

  /** True when the view is close enough to the bottom to keep following. */
  isAtEnd() {
    const distance = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight;
    return distance <= 24;
  }

  /** Follow new output only while the user is at the bottom. */
  syncFollow() {
    this.following = this.isAtEnd();
    this.jumpButton.hidden = this.following;
  }

  // ---- commands -----------------------------------------------------------

  /**
   * Run the active file.
   *
   * Unsaved changes are never silently ignored: the file is saved first, and
   * if the save fails the run does not happen.
   */
  async run() {
    if (this.controller.isLive) return { success: false, code: "ALREADY_RUNNING" };

    const file = this.editor.tabManager?.activeFile;
    // Run saves the file before starting, so an unsaved file is still runnable.
    const target = RunPanel.describeRunTarget(file, { ignoreUnsaved: true });
    if (!target.runnable) {
      this.controller.reset();
      this.render();
      return { success: false, code: "NOT_RUNNABLE", reason: target.reason };
    }

    const root = this.editor.fileExplorer?.rootPath;
    if (typeof root !== "string" || !root.trim()) {
      this.controller.reset();
      this.render();
      return { success: false, code: "NO_WORKSPACE", reason: "Open a folder before running a file." };
    }

    const api = this.editor.api;
    if (typeof api?.startRun !== "function") {
      this.controller.reset();
      this.render();
      return { success: false, code: "UNAVAILABLE", reason: "Running files is unavailable in this build." };
    }

    // Save before running so the program sees exactly what is on screen.
    if (file.isSaved === false) {
      const saved = await this.saveFile(file);
      if (!saved) {
        this.controller.reset();
        this.render();
        return {
          success: false,
          code: "NOT_SAVED",
          reason: "The file could not be saved, so it was not run.",
        };
      }
    }

    // A snapshot of the target, so a later tab switch cannot change what the
    // panel claims it ran.
    const snapshot = {
      id: file.id,
      name: file.name,
      path: file.path,
      language: target.language,
    };

    this.controller.begin(snapshot, null);
    this.clearLogNodes();
    this.following = true;
    this.render();

    let result;
    try {
      result = await api.startRun({
        strategy: target.strategy,
        projectRoot: root,
        workspaceRoot: root,
        target: file.path,
        language: target.language,
        name: file.name,
      });
    } catch (error) {
      result = {
        ok: false,
        error: { code: "RUN_FAILED", message: error?.message || String(error) },
      };
    }

    if (!result?.ok) {
      const code = result?.error?.code || "RUN_FAILED";
      const [title, message] = String(result?.error?.message || "").split("\u0000");
      this.controller.apply({
        type: "error",
        runId: this.controller.runId,
        code,
        title: title || "Cannot run this file",
        message: message || title || "The file could not be started.",
      });
      this.controller.applyState(RunController.STATES.ERROR);
      return { success: false, code };
    }

    this.controller.adoptRunId(result.runId);
    return { success: true, runId: result.runId };
  }

  /** Save the file through the editor's own save path. */
  async saveFile(file) {
    try {
      if (typeof this.editor.tabManager?.saveFileOnce === "function") {
        const saved = await this.editor.tabManager.saveFileOnce(file);
        return saved !== false && file.isSaved !== false;
      }
      if (typeof file.save === "function") {
        await file.save();
        return file.isSaved !== false;
      }
    } catch {
      return false;
    }
    return false;
  }

  /** Stop the current run. The state stays Stopping until the process exits. */
  async stop() {
    const runId = this.controller.runId;
    if (!runId || !this.controller.canStop) return false;
    const api = this.editor.api;
    if (typeof api?.stopRun !== "function") return false;
    try {
      return Boolean(await api.stopRun(runId));
    } catch {
      return false;
    }
  }

  /** Clear the visible output. Does not touch the process. */
  clear() {
    this.controller.clear();
    this.clearLogNodes();
    this.renderEmptyState();
  }

  clearLogNodes() {
    this.log.replaceChildren();
    this.entryNodes.clear();
  }
}

if (typeof window !== "undefined") window.RunPanel = RunPanel;
