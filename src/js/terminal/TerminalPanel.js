export class TerminalPanel {
  constructor(editor, Terminal, FitAddon, WebLinksAddon) {
    this.editor = editor;
    this.Terminal = Terminal;
    this.FitAddon = FitAddon;
    this.WebLinksAddon = WebLinksAddon;
    this.sessions = new Map();
    this.pendingOutput = new Map();
    this.activeSessionId = null;
    this.nextNumber = 1;
    this.hasOpened = false;
    this.destroyed = false;
    this.frame = null;

    this.element = document.createElement("section");
    this.element.className = "terminal-panel";
    this.element.setAttribute("aria-label", "Terminal sessions");
    this.element.innerHTML = `
      <div class="terminal-tabs" role="tablist" aria-label="Terminal sessions">
        <div class="terminal-tabs-list"></div>
        <div class="terminal-tabs-actions">
          <button class="bottom-panel-button terminal-select-all" type="button" title="Select All" aria-label="Select All">Select All</button>
          <button class="bottom-panel-button terminal-copy" type="button" title="Copy Selection" aria-label="Copy Selection">Copy</button>
          <button class="bottom-panel-button terminal-paste" type="button" title="Paste" aria-label="Paste">Paste</button>
          <button class="bottom-panel-button terminal-clear" type="button" title="Clear Terminal" aria-label="Clear Terminal">Clear</button>
        </div>
      </div>
      <div class="terminal-view"></div>`;
    this.tabsList = this.element.querySelector(".terminal-tabs-list");
    this.view = this.element.querySelector(".terminal-view");
    this.errorStatus = null;
    this.emptyStatus = null;
    this.onClearClick = () => this.getActiveSession()?.terminal.clear();
    this.onSelectAllClick = () => this.getActiveSession()?.terminal.selectAll();
    this.onCopyClick = () => {
      const selection = this.getActiveSession()?.terminal.getSelection();
      if (selection) void this.editor.api.writeClipboardText(selection).catch((error) =>
        console.error("[Terminal] Failed to copy terminal selection", error),
      );
    };
    this.onPasteClick = async () => {
      const record = this.getActiveSession();
      if (!record) return;
      try {
        const text = await this.editor.api.readClipboardText();
        if (typeof text === "string") record.terminal.paste(text);
        if (this.isActive(record)) record.terminal.focus();
      } catch (error) {
        console.error("[Terminal] Failed to paste terminal content", error);
      }
    };
    this.element.querySelector(".terminal-clear")?.addEventListener("click", this.onClearClick);
    this.element.querySelector(".terminal-select-all")?.addEventListener("click", this.onSelectAllClick);
    this.element.querySelector(".terminal-copy")?.addEventListener("click", this.onCopyClick);
    this.element.querySelector(".terminal-paste")?.addEventListener("click", this.onPasteClick);

    this.removeOutputListener = editor.api.onTerminalOutput?.((payload) => this.handleOutput(payload));
    this.removeExitListener = editor.api.onTerminalExit?.((payload) => this.handleExit(payload));
    this.removeErrorListener = editor.api.onTerminalError?.((payload) => this.handleError(payload));
    this.applyTheme();
  }

  onOpen({ restoring = false } = {}) {
    if (this.hasOpened) {
      this.scheduleFit();
      return;
    }
    this.hasOpened = true;
    if (restoring) this.showEmptyState();
    else void this.createTerminal();
  }

  onActivate() {
    this.scheduleFit();
  }

  onDeactivate() {}

  onResize() {
    this.scheduleFit();
  }

  onThemeChanged() {
    this.applyTheme();
  }

  async createTerminal() {
    if (this.destroyed) return false;
    const focusInitiator = document.activeElement;
    this.clearStatus();
    const terminal = new this.Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 12,
      scrollback: 5000,
      allowProposedApi: false,
      theme: this.getXtermTheme(),
    });
    const fitAddon = new this.FitAddon();
    terminal.loadAddon(fitAddon);
    const webLinksAddon = new this.WebLinksAddon((_event, uri) => {
      let url;
      try { url = new URL(uri); } catch { return; }
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      void this.editor.api.openTerminalExternalLink(url.href).catch((error) =>
        console.error("[Terminal] Failed to open external link", error),
      );
    });
    terminal.loadAddon(webLinksAddon);
    const record = {
      id: null,
      number: this.nextNumber++,
      label: "Terminal",
      shell: "",
      terminal,
      fitAddon,
      webLinksAddon,
      wrapper: document.createElement("div"),
      cols: 0,
      rows: 0,
      exited: false,
      disposed: false,
      subscriptions: [],
    };
    record.wrapper.className = "terminal-instance";
    record.wrapper.hidden = true;
    this.view?.appendChild(record.wrapper);
    terminal.open(record.wrapper);
    record.subscriptions.push(terminal.onData((data) => {
      if (!record.id || record.exited || record.disposed) return;
      void this.editor.api.writeTerminalSession(record.id, data).catch((error) =>
        console.error("[Terminal] Failed to write terminal input", error),
      );
    }));
    record.subscriptions.push(terminal.onResize(({ cols, rows }) => {
      this.syncPtySize(record, cols, rows);
    }));
    this.sessions.set(`pending-${record.number}`, record);
    this.activeSessionId = `pending-${record.number}`;
    this.renderTabs();
    this.showActive(record);

    try {
      await this.fitRecord(record);
      const result = await this.editor.api.createTerminalSession({
        cols: Math.max(2, terminal.cols || 80),
        rows: Math.max(2, terminal.rows || 24),
      });
      if (!result?.success || typeof result.sessionId !== "string") {
        throw new Error(result?.error?.message || "Failed to start terminal.");
      }
      if (record.disposed || this.destroyed) {
        this.pendingOutput.delete(result.sessionId);
        await this.editor.api.closeTerminalSession(result.sessionId);
        return false;
      }
      this.sessions.delete(`pending-${record.number}`);
      record.id = result.sessionId;
      record.shell = result.shell || "shell";
      record.cwd = typeof result.cwd === "string" ? result.cwd : "";
      const folder = record.cwd.split(/[\\/]/).filter(Boolean).at(-1) || "Home";
      record.label = `${record.shell} — ${folder} (${record.number})`;
      this.sessions.set(record.id, record);
      this.activeSessionId = record.id;
      this.renderTabs();
      this.showActive(record);
      this.scheduleFit();
      const pending = this.pendingOutput.get(record.id) || [];
      this.pendingOutput.delete(record.id);
      for (const payload of pending) this.writeOutput(record, payload);
      if (this.shouldTakeFocus(record, focusInitiator)) record.terminal.focus();
      return true;
    } catch (error) {
      this.disposeRecord(record);
      this.sessions.delete(`pending-${record.number}`);
      this.activeSessionId = this.sessions.keys().next().value || null;
      this.renderTabs();
      if (this.destroyed) return false;
      this.showError(error?.message || "Failed to start terminal.");
      return false;
    }
  }

  handleOutput(payload) {
    if (!payload || typeof payload.sessionId !== "string" ||
        typeof payload.data !== "string" || !Number.isSafeInteger(payload.sequence)) return;
    const record = this.sessions.get(payload.sessionId);
    if (!record) {
      const pending = this.pendingOutput.get(payload.sessionId) || [];
      pending.push(payload);
      this.pendingOutput.set(payload.sessionId, pending);
      return;
    }
    this.writeOutput(record, payload);
  }

  writeOutput(record, payload) {
    if (record.disposed) {
      void this.editor.api.acknowledgeTerminalOutput(payload.sessionId, payload.sequence);
      return;
    }
    record.terminal.write(payload.data, () => {
      void this.editor.api.acknowledgeTerminalOutput(payload.sessionId, payload.sequence)
        .catch((error) => console.error("[Terminal] Failed to acknowledge output", error));
    });
  }

  handleExit(payload) {
    const record = this.sessions.get(payload?.sessionId);
    if (!record || record.exited) return;
    record.exited = true;
    record.exitCode = Number.isInteger(payload.exitCode) ? payload.exitCode : null;
    record.terminal.write(`\r\n\x1b[90m[Process exited${record.exitCode === null ? "" : ` with code ${record.exitCode}`}]\x1b[0m\r\n`);
    this.renderTabs();
  }

  handleError(payload) {
    const record = this.sessions.get(payload?.sessionId);
    const error = payload?.error;
    if (!record || !error) return;
    record.exited = true;
    record.terminal.write(`\r\n\x1b[31m${error.message || "Terminal session unavailable."}\x1b[0m\r\n`);
    this.renderTabs();
  }

  getActiveSession() {
    return this.sessions.get(this.activeSessionId) || null;
  }

  isActive(record) {
    return !this.destroyed && this.activeSessionId === record.id &&
      this.editor.bottomPanelManager?.visible === true;
  }

  shouldTakeFocus(record, initiator) {
    if (!this.isActive(record)) return false;
    const active = document.activeElement;
    return Boolean(
      this.element.contains(active) ||
      (initiator?.isConnected && active === initiator),
    );
  }

  activateSession(id) {
    const record = this.sessions.get(id);
    if (!record || this.destroyed) return false;
    this.activeSessionId = id;
    this.renderTabs();
    this.showActive(record);
    this.scheduleFit({ focus: true });
    return true;
  }

  async closeSession(id) {
    const record = this.sessions.get(id);
    if (!record) return false;
    if (id && !String(id).startsWith("pending-")) {
      await this.editor.api.closeTerminalSession(id).catch(() => false);
    }
    this.sessions.delete(id);
    this.disposeRecord(record);
    if (this.activeSessionId === id) {
      this.activeSessionId = this.sessions.keys().next().value || null;
    }
    this.renderTabs();
    const active = this.getActiveSession();
    if (active) this.showActive(active);
    else this.showEmptyState();
    return true;
  }

  showActive(record) {
    this.clearStatus();
    this.emptyStatus?.remove();
    this.emptyStatus = null;
    for (const candidate of this.sessions.values())
      candidate.wrapper.hidden = candidate !== record;
    this.element.querySelector(".terminal-clear").disabled = !record;
  }

  showEmptyState() {
    if (!this.view) return;
    for (const record of this.sessions.values()) record.wrapper.hidden = true;
    this.element.querySelector(".terminal-clear").disabled = true;
    this.clearStatus();
    const empty = document.createElement("div");
    empty.className = "terminal-empty-state";
    const message = document.createElement("p");
    message.textContent = "No terminal sessions. Create a terminal to get started.";
    empty.appendChild(message);
    this.emptyStatus = empty;
    this.view.replaceChildren(empty);
  }

  showError(message) {
    if (!this.view) return;
    this.clearStatus();
    const status = document.createElement("div");
    status.className = "terminal-error-state";
    status.setAttribute("role", "status");
    const text = document.createElement("p");
    text.textContent = message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "bottom-panel-button";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => void this.createTerminal(), { once: true });
    status.append(text, retry);
    if (!this.sessions.size) {
      this.emptyStatus?.remove();
      this.emptyStatus = null;
      this.view.replaceChildren(status);
    } else {
      this.view.appendChild(status);
    }
    this.errorStatus = status;
  }

  clearStatus() {
    this.errorStatus?.remove();
    this.errorStatus = null;
  }

  renderTabs() {
    if (!this.tabsList) return;
    this.tabsList.replaceChildren();
    for (const [id, record] of this.sessions) {
      const tab = document.createElement("div");
      tab.className = "terminal-tab";
      tab.setAttribute("role", "presentation");
      const activate = document.createElement("button");
      activate.className = "terminal-tab-select";
      activate.type = "button";
      activate.setAttribute("role", "tab");
      activate.setAttribute("aria-selected", String(id === this.activeSessionId));
      activate.textContent = record.label;
      activate.title = `Shell: ${record.shell}\nWorking directory: ${record.cwd}`;
      if (record.exited) {
        const status = document.createElement("span");
        status.className = "terminal-tab-exited";
        status.textContent = "exited";
        activate.appendChild(status);
      }
      activate.addEventListener("click", () => this.activateSession(id));
      activate.addEventListener("dblclick", () => this.renameSession(id, activate));
      const close = document.createElement("button");
      close.type = "button";
      close.className = "terminal-tab-close";
      close.setAttribute("aria-label", `Close ${record.label}`);
      close.title = "Close Terminal";
      close.innerHTML = '<i class="fi fi-rr-cross-small" aria-hidden="true"></i>';
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.closeSession(id);
      });
      tab.append(activate, close);
      this.tabsList.appendChild(tab);
    }
  }

  renameSession(id, button) {
    const record = this.sessions.get(id);
    if (!record || record.disposed) return;
    const input = document.createElement("input");
    input.className = "terminal-tab-rename";
    input.value = record.label;
    input.setAttribute("aria-label", "Terminal name");
    button.replaceWith(input);
    input.focus();
    input.select();
    const finish = (save) => {
      if (input.dataset.finished === "true") return;
      input.dataset.finished = "true";
      if (save && input.value.trim()) record.label = input.value.trim().slice(0, 80);
      this.renderTabs();
      this.activateSession(id);
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") finish(true);
      if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true), { once: true });
  }

  scheduleFit({ focus = false } = {}) {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    const focusOrigin = focus ? document.activeElement : null;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      const record = this.getActiveSession();
      if (!record || !this.isActive(record)) return;
      void this.fitRecord(record).then(() => {
        if (
          focus &&
          this.isActive(record) &&
          document.activeElement === focusOrigin &&
          focusOrigin?.isConnected
        ) record.terminal.focus();
      });
    });
  }

  async fitRecord(record) {
    if (record.disposed || !record.wrapper?.isConnected || record.wrapper.hidden) return false;
    const bounds = record.wrapper.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return false;
    try { record.fitAddon.fit(); } catch { return false; }
    const cols = record.terminal.cols;
    const rows = record.terminal.rows;
    if (cols >= 2 && rows >= 2) this.syncPtySize(record, cols, rows);
    return true;
  }

  syncPtySize(record, cols, rows) {
    if (!record.id || record.exited || record.disposed ||
        !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 ||
        (record.cols === cols && record.rows === rows)) return;
    record.cols = cols;
    record.rows = rows;
    void this.editor.api.resizeTerminalSession(record.id, cols, rows).catch((error) =>
      console.error("[Terminal] Failed to resize PTY", error),
    );
  }

  getXtermTheme() {
    const style = getComputedStyle(document.documentElement);
    return {
      background: style.getPropertyValue("--bg-secondary").trim(),
      foreground: style.getPropertyValue("--text-primary").trim(),
      cursor: style.getPropertyValue("--text-primary").trim(),
      selectionBackground: style.getPropertyValue("--selection-bg").trim(),
    };
  }

  applyTheme() {
    const theme = this.getXtermTheme();
    for (const record of this.sessions.values()) record.terminal.options.theme = theme;
  }

  focus() {
    const record = this.getActiveSession();
    if (record && this.isActive(record)) {
      record.terminal.focus();
      return true;
    }
    this.element.querySelector(".terminal-tabs .terminal-tab-select")?.focus();
    return false;
  }

  disposeRecord(record) {
    if (!record || record.disposed) return;
    record.disposed = true;
    for (const subscription of record.subscriptions) subscription.dispose?.();
    record.subscriptions = [];
    record.terminal.dispose();
    record.fitAddon.dispose?.();
    record.webLinksAddon.dispose?.();
    record.wrapper.remove();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.removeOutputListener?.();
    this.removeExitListener?.();
    this.removeErrorListener?.();
    this.element.querySelector(".terminal-clear")?.removeEventListener("click", this.onClearClick);
    this.element.querySelector(".terminal-select-all")?.removeEventListener("click", this.onSelectAllClick);
    this.element.querySelector(".terminal-copy")?.removeEventListener("click", this.onCopyClick);
    this.element.querySelector(".terminal-paste")?.removeEventListener("click", this.onPasteClick);
    for (const record of this.sessions.values()) {
      if (record.id) void this.editor.api.closeTerminalSession(record.id).catch(() => false);
      this.disposeRecord(record);
    }
    this.sessions.clear();
    this.pendingOutput.clear();
    this.element.remove();
  }
}
