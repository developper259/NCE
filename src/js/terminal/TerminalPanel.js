export class TerminalPanel {
  constructor(editor, Terminal, FitAddon, WebLinksAddon) {
    this.editor = editor;
    this.Terminal = Terminal;
    this.FitAddon = FitAddon;
    this.WebLinksAddon = WebLinksAddon;
    this.workspaceSessions = new Map();
    this.sessionIndex = new Map();
    this.pendingOutput = new Map();
    this.closedSessionIds = new Set();
    this.currentWorkspaceKey = "no-workspace";
    this.currentWorkspaceRoot = null;
    this.workspaceGeneration = 0;
    this.pendingNumber = 0;
    this.destroyed = false;
    this.frame = null;

    this.element = document.createElement("section");
    this.element.className = "terminal-panel";
    this.element.setAttribute("aria-label", "Terminal workspace");
    this.element.innerHTML = `
      <div class="terminal-tabs">
        <div class="terminal-tabs-list" role="tablist" aria-label="Terminal sessions"></div>
        <div class="terminal-tabs-actions">
          <button class="bottom-panel-icon-button terminal-actions-toggle" type="button" aria-label="Terminal actions" aria-haspopup="menu" aria-expanded="false" title="Terminal actions">
            <i class="fi fi-rr-menu-dots" aria-hidden="true"></i>
          </button>
          <div class="terminal-actions-menu" role="menu" hidden>
            <button type="button" role="menuitem" data-action="select-all">Select All</button>
            <button type="button" role="menuitem" data-action="copy">Copy Selection</button>
            <button type="button" role="menuitem" data-action="paste">Paste</button>
            <button type="button" role="menuitem" data-action="clear">Clear Terminal</button>
          </div>
        </div>
      </div>
      <div class="terminal-view"></div>`;
    this.tabsElement = this.element.querySelector(".terminal-tabs");
    this.tabsList = this.element.querySelector(".terminal-tabs-list");
    this.view = this.element.querySelector(".terminal-view");
    this.actionsContainer = this.element.querySelector(".terminal-tabs-actions");
    this.actionsToggle = this.element.querySelector(".terminal-actions-toggle");
    this.actionsMenu = this.element.querySelector(".terminal-actions-menu");
    const actionsSlot = editor.bottomPanelManager?.root?.querySelector?.(
      ".bottom-panel-terminal-actions-slot",
    );
    if (actionsSlot && this.actionsContainer)
      actionsSlot.appendChild(this.actionsContainer);
    this.errorStatus = null;

    this.onActionsToggle = () => this.toggleActionsMenu();
    this.onActionsMenuClick = (event) => {
      const action = event.target?.closest?.("[data-action]")?.dataset?.action;
      if (!action) return;
      this.closeActionsMenu();
      void this.runAction(action);
    };
    this.onOutsidePointerDown = (event) => {
      if (!this.actionsContainer?.contains(event.target))
        this.closeActionsMenu();
    };
    this.onTabsKeyDown = (event) => this.handleTabsKeyDown(event);
    this.onActionsMenuKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      this.closeActionsMenu();
      this.actionsToggle?.focus();
    };
    this.actionsToggle?.addEventListener("click", this.onActionsToggle);
    this.actionsMenu?.addEventListener("click", this.onActionsMenuClick);
    this.actionsMenu?.addEventListener("keydown", this.onActionsMenuKeyDown);
    this.tabsList?.addEventListener("keydown", this.onTabsKeyDown);
    document.addEventListener("pointerdown", this.onOutsidePointerDown);

    this.removeOutputListener = editor.api.onTerminalOutput?.((payload) => this.handleOutput(payload));
    this.removeExitListener = editor.api.onTerminalExit?.((payload) => this.handleExit(payload));
    this.removeErrorListener = editor.api.onTerminalError?.((payload) => this.handleError(payload));
    this.applyTheme();
  }

  get currentState() {
    return this.getWorkspaceState(this.currentWorkspaceKey);
  }

  // Kept as a read-only compatibility surface for diagnostics and tests. The
  // actual registries are isolated in workspaceSessions.
  get sessions() {
    return this.currentState.sessions;
  }

  get activeSessionId() {
    return this.currentState.activeSessionId;
  }

  set activeSessionId(value) {
    this.currentState.activeSessionId = value;
  }

  getWorkspaceState(workspaceKey, workspaceRoot = null) {
    const key = typeof workspaceKey === "string" && workspaceKey
      ? workspaceKey : "no-workspace";
    let state = this.workspaceSessions.get(key);
    if (!state) {
      state = {
        workspaceKey: key,
        workspaceRoot,
        sessions: new Map(),
        activeSessionId: null,
        pendingRestoreTabs: null,
        restoreActiveIndex: 0,
        restoreSessionIds: [],
        initialOpenPromise: null,
        initialOpenAttempted: false,
        lastError: null,
      };
      this.workspaceSessions.set(key, state);
    } else if (workspaceRoot) {
      state.workspaceRoot = workspaceRoot;
    }
    return state;
  }

  activateWorkspace(workspaceKey, workspaceRoot = null, terminalState = null) {
    if (this.destroyed || typeof workspaceKey !== "string" || !workspaceKey) return false;
    const changed = this.currentWorkspaceKey !== workspaceKey;
    if (changed) {
      this.workspaceGeneration += 1;
      this.closeActionsMenu();
      const previous = this.getWorkspaceState(this.currentWorkspaceKey);
      const focused = this.getActiveSessionFor(previous);
      if (focused) focused.terminal.blur?.();
    }

    this.currentWorkspaceKey = workspaceKey;
    this.currentWorkspaceRoot = workspaceRoot || null;
    const state = this.getWorkspaceState(workspaceKey, workspaceRoot);
    if (!state.sessions.size && terminalState && !state.pendingRestoreTabs) {
      state.pendingRestoreTabs = Array.isArray(terminalState.tabs)
        ? terminalState.tabs.map((tab) => ({
            baseLabel: this.safeLabel(tab?.baseLabel) || "Terminal",
            customLabel: this.safeLabel(tab?.customLabel) || null,
            duplicateIndex: Number.isInteger(tab?.duplicateIndex) && tab.duplicateIndex > 0
              ? tab.duplicateIndex : null,
          }))
        : [];
      state.restoreActiveIndex = Number.isInteger(terminalState.activeTabIndex)
        ? Math.max(0, terminalState.activeTabIndex) : 0;
    }

    this.hideInactiveWorkspaceSessions();
    this.renderTabs();
    const active = this.getActiveSession();
    if (active) this.showActive(active);
    else this.clearTerminalActions();
    this.clearStatus();
    if (this.editor.bottomPanelManager?.visible) this.scheduleFit();
    return true;
  }

  getPersistedState(workspaceKey = this.currentWorkspaceKey) {
    const state = this.getWorkspaceState(workspaceKey);
    const liveRecords = [...state.sessions.values()].filter((record) => !record.disposed);
    const records = state.pendingRestoreTabs?.length
      ? [
          ...state.restoreSessionIds
            .map((id) => state.sessions.get(id))
            .filter((record) => record && !record.disposed),
          ...liveRecords.filter((record) => !state.restoreSessionIds.includes(record.id)),
        ]
      : liveRecords;
    const restoredTabs = records.map((record) => ({
          baseLabel: this.safeLabel(record.baseLabel) || "Terminal",
          customLabel: this.safeLabel(record.customLabel) || null,
          duplicateIndex: Number.isInteger(record.duplicateIndex) && record.duplicateIndex > 0
            ? record.duplicateIndex : null,
        }));
    const pendingTabs = (state.pendingRestoreTabs || []).map((tab) => ({
          baseLabel: this.safeLabel(tab.baseLabel) || "Terminal",
          customLabel: this.safeLabel(tab.customLabel) || null,
          duplicateIndex: Number.isInteger(tab.duplicateIndex) && tab.duplicateIndex > 0
            ? tab.duplicateIndex : null,
        }));
    const tabs = state.pendingRestoreTabs?.length
      ? [...restoredTabs, ...pendingTabs]
      : restoredTabs.length ? restoredTabs : pendingTabs;
    let activeTabIndex = 0;
    if (state.pendingRestoreTabs?.length) {
      activeTabIndex = Math.min(state.restoreActiveIndex || 0, Math.max(0, tabs.length - 1));
    } else if (records.length) {
      const index = records.findIndex((record) => record.id === state.activeSessionId);
      activeTabIndex = index >= 0 ? index : 0;
    } else {
      activeTabIndex = Math.min(state.restoreActiveIndex || 0, Math.max(0, tabs.length - 1));
    }
    return { version: 1, activeTabIndex, tabs };
  }

  handleTabKeybinding(action) {
    const state = this.currentState;
    if (action === "new_file") {
      void this.createTerminal();
      return true;
    }
    if (action === "close_file") {
      if (state.activeSessionId) void this.closeSession(state.activeSessionId);
      return true;
    }
    if (action === "close_all_file") {
      this.closeAllSessions();
      return true;
    }
    if (action === "next_tab") {
      this.cycleSession(1);
      return true;
    }
    if (action === "previous_tab") {
      this.cycleSession(-1);
      return true;
    }
    return false;
  }

  cycleSession(direction) {
    const state = this.currentState;
    const ids = [...state.sessions.keys()];
    if (!ids.length) return false;
    const currentIndex = ids.indexOf(state.activeSessionId);
    const nextIndex = currentIndex < 0
      ? direction > 0 ? 0 : ids.length - 1
      : (currentIndex + direction + ids.length) % ids.length;
    return this.activateSession(ids[nextIndex]);
  }

  closeAllSessions() {
    const ids = [...this.currentState.sessions.keys()];
    for (const id of ids) void this.closeSession(id);
    return ids.length > 0;
  }

  onOpen() {
    const state = this.currentState;
    this.clearStatus();
    if (state.sessions.size) {
      const active = this.getActiveSession();
      if (active) this.showActive(active);
      if (state.pendingRestoreTabs?.length && !state.initialOpenPromise) {
        state.initialOpenAttempted = true;
        state.initialOpenPromise = this.restoreOrCreateInitialSessions(state)
          .finally(() => { state.initialOpenPromise = null; });
      }
      this.scheduleFit();
      return;
    }
    if (state.initialOpenAttempted && state.lastError) {
      this.showError(state.lastError, state.workspaceKey);
      return;
    }
    if (!state.initialOpenPromise && !state.initialOpenAttempted) {
      state.initialOpenAttempted = true;
      state.initialOpenPromise = this.restoreOrCreateInitialSessions(state)
        .finally(() => { state.initialOpenPromise = null; });
    }
  }

  async restoreOrCreateInitialSessions(state) {
    const ownerKey = state.workspaceKey;
    const generation = this.workspaceGeneration;
    const pending = state.pendingRestoreTabs;
    if (pending?.length) {
      while (pending.length && !this.destroyed) {
        const metadata = pending[0];
        const record = await this.createTerminal({
          workspaceKey: ownerKey,
          customLabel: metadata.customLabel,
          duplicateIndex: metadata.duplicateIndex,
          focus: false,
          activate: false,
          reportError: ownerKey === this.currentWorkspaceKey,
          returnRecord: true,
        });
        if (!record) return false;
        state.restoreSessionIds.push(record.id);
        pending.shift();
        this.editor.statesManager?.scheduleBottomPanelStateSave?.(ownerKey);
      }
      state.pendingRestoreTabs = null;
      this.normalizeSingletonDuplicateIndices(state);
      state.activeSessionId = state.restoreSessionIds[
        Math.min(state.restoreActiveIndex, Math.max(0, state.restoreSessionIds.length - 1))
      ] || state.restoreSessionIds[0] || state.activeSessionId || null;
      if (state.workspaceKey === this.currentWorkspaceKey) {
        this.renderTabs();
        const active = this.getActiveSession();
        if (active) this.showActive(active);
        if (generation === this.workspaceGeneration) this.scheduleFit();
      }
      this.notifyWorkspaceChanged(ownerKey);
      return Boolean(state.restoreSessionIds.length);
    }

    const created = await this.createTerminal({
      workspaceKey: ownerKey,
      focus: true,
      activate: true,
      reportError: ownerKey === this.currentWorkspaceKey,
    });
    return Boolean(created);
  }

  onActivate() {
    const record = this.getActiveSession();
    if (record) this.showActive(record);
    this.scheduleFit();
  }

  onDeactivate() {
    this.closeActionsMenu();
    this.getActiveSession()?.terminal.blur?.();
  }

  onResize() {
    this.scheduleFit();
  }

  onThemeChanged() {
    this.applyTheme();
  }

  async createTerminal({
    workspaceKey = this.currentWorkspaceKey,
    customLabel = null,
    duplicateIndex,
    focus = true,
    activate = true,
    reportError = true,
    returnRecord = false,
  } = {}) {
    if (this.destroyed || typeof workspaceKey !== "string" || !workspaceKey) return null;
    const state = this.getWorkspaceState(workspaceKey);
    const isCurrent = () => !this.destroyed && this.currentWorkspaceKey === workspaceKey;
    const generation = this.workspaceGeneration;
    const focusInitiator = focus && isCurrent() ? document.activeElement : null;
    if (isCurrent()) this.clearStatus();

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
    const pendingId = `pending-${++this.pendingNumber}`;
    const record = {
      id: null,
      internalId: pendingId,
      workspaceKey,
      workspaceRoot: state.workspaceRoot,
      baseLabel: "Starting terminal…",
      customLabel: this.safeLabel(customLabel) || null,
      duplicateIndex: null,
      displayLabel: "Starting terminal…",
      shell: "",
      cwd: "",
      terminal,
      fitAddon,
      webLinksAddon,
      wrapper: document.createElement("div"),
      cols: 0,
      rows: 0,
      exited: false,
      disposed: false,
      closingPromise: null,
      subscriptions: [],
    };
    record.wrapper.className = "terminal-instance";
    record.wrapper.hidden = true;
    record.wrapper.id = `terminal-view-${++this.pendingNumber}`;
    record.wrapper.setAttribute("role", "tabpanel");
    record.wrapper.setAttribute("aria-label", "Terminal output");
    this.view?.appendChild(record.wrapper);
    terminal.open(record.wrapper);
    record.subscriptions.push(terminal.onData((data) => {
      if (!record.id || record.exited || record.disposed || !this.isActive(record)) return;
      void this.editor.api.writeTerminalSession(record.id, record.workspaceKey, data).catch((error) =>
        console.error("[Terminal] Failed to write PTY input", error),
      );
    }));
    record.subscriptions.push(terminal.onResize(({ cols, rows }) => {
      if (record.workspaceKey === this.currentWorkspaceKey)
        this.syncPtySize(record, cols, rows);
    }));
    state.sessions.set(pendingId, record);
    if (activate) state.activeSessionId = pendingId;
    this.recomputeLabels(state);
    if (isCurrent()) {
      this.renderTabs();
      if (activate) this.showActive(record);
      if (this.editor.bottomPanelManager?.visible) void this.fitRecord(record);
    }

    try {
      if (isCurrent()) await this.fitRecord(record);
      const scope = await this.editor.api.getTerminalWorkspaceScope?.();
      if (this.destroyed || record.disposed || scope?.workspaceKey !== workspaceKey) {
        throw new Error("The active workspace changed. Reopen the terminal and try again.");
      }
      const result = await this.editor.api.createTerminalSession({
        cols: Math.max(2, terminal.cols || 80),
        rows: Math.max(2, terminal.rows || 24),
      }, workspaceKey);
      if (!result?.success || typeof result.sessionId !== "string")
        throw new Error(result?.error?.message || "Failed to start terminal.");
      if (result.workspaceKey !== workspaceKey) {
        void this.editor.api.closeTerminalSession(result.sessionId, result.workspaceKey).catch(() => false);
        throw new Error("Terminal ownership could not be verified.");
      }
      if (record.disposed || this.destroyed) {
        this.pendingOutput.delete(result.sessionId);
        void this.editor.api.closeTerminalSession(result.sessionId, workspaceKey).catch(() => false);
        return false;
      }

      state.sessions.delete(pendingId);
      record.id = result.sessionId;
      record.internalId = result.sessionId;
      record.shell = result.shell || "shell";
      record.cwd = typeof result.cwd === "string" ? result.cwd : "";
      record.baseLabel = this.createBaseLabel(record, state);
      record.duplicateIndex = this.allocateDuplicateIndex(record, state, duplicateIndex);
      state.sessions.set(record.id, record);
      this.sessionIndex.set(record.id, record);
      if (state.activeSessionId === pendingId) state.activeSessionId = record.id;
      this.recomputeLabels(state);
      const pending = this.pendingOutput.get(record.id) || [];
      this.pendingOutput.delete(record.id);
      for (const payload of pending) {
        if (payload.workspaceKey === workspaceKey) this.writeOutput(record, payload);
        else void this.editor.api.acknowledgeTerminalOutput(
          payload.sessionId, payload.workspaceKey, payload.sequence,
        );
      }

      if (workspaceKey === this.currentWorkspaceKey) {
        this.renderTabs();
        if (state.activeSessionId === record.id) this.showActive(record);
        if (this.editor.bottomPanelManager?.visible) this.scheduleFit({ focus: false });
        if (focus && generation === this.workspaceGeneration && this.shouldTakeFocus(record, focusInitiator))
          record.terminal.focus();
      }
      state.lastError = null;
      this.notifyWorkspaceChanged(workspaceKey);
      return returnRecord ? record : true;
    } catch (error) {
      const cancelled = record.disposed;
      if (record.id) this.sessionIndex.delete(record.id);
      state.sessions.delete(record.internalId);
      this.disposeRecord(record);
      if (state.activeSessionId === record.internalId)
        state.activeSessionId = state.sessions.keys().next().value || null;
      this.recomputeLabels(state);
      if (!cancelled) state.lastError = error?.message || "Failed to start terminal.";
      if (workspaceKey === this.currentWorkspaceKey) {
        this.renderTabs();
        const active = this.getActiveSession();
        if (active) this.showActive(active);
        else this.clearTerminalActions();
        if (!cancelled && reportError) this.showError(state.lastError, workspaceKey);
      }
      return false;
    }
  }

  createBaseLabel(record, state) {
    const rootName = this.pathBasename(record.workspaceRoot) ||
      this.pathBasename(record.cwd) || "Home";
    return `${record.shell} — ${rootName}`;
  }

  pathBasename(value) {
    if (typeof NCEPath !== "undefined" && NCEPath?.basename) return NCEPath.basename(value);
    return typeof value === "string" ? value.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || "" : "";
  }

  safeLabel(value) {
    return typeof value === "string" && value.trim()
      ? value.trim().slice(0, 128) : null;
  }

  getNameBase(record) {
    return this.safeLabel(record.customLabel) || this.safeLabel(record.baseLabel) || "Terminal";
  }

  allocateDuplicateIndex(record, state, preferredIndex = undefined) {
    const name = this.getNameBase(record);
    const occupied = new Set([...state.sessions.values()]
      .filter((other) => other !== record && !other.disposed && this.getNameBase(other) === name)
      .map((other) => Number.isInteger(other.duplicateIndex) && other.duplicateIndex > 0
        ? other.duplicateIndex : null));

    if (preferredIndex === null && !occupied.has(null)) return null;
    if (Number.isInteger(preferredIndex) && preferredIndex > 0 && !occupied.has(preferredIndex))
      return preferredIndex;
    if (!occupied.has(null)) return null;

    let index = 1;
    while (occupied.has(index)) index++;
    return index;
  }

  normalizeSingletonDuplicateIndices(state, name = null) {
    const groups = new Map();
    for (const record of state.sessions.values()) {
      if (record.disposed) continue;
      const base = this.getNameBase(record);
      if (name !== null && base !== name) continue;
      const group = groups.get(base) || [];
      group.push(record);
      groups.set(base, group);
    }
    for (const [base, records] of groups) {
      if (records.length === 1 && records[0].duplicateIndex !== null) {
        records[0].duplicateIndex = null;
      }
    }
  }

  recomputeLabels(state) {
    for (const record of state.sessions.values()) {
      if (record.disposed) continue;
      const base = this.getNameBase(record);
      record.displayLabel = Number.isInteger(record.duplicateIndex) && record.duplicateIndex > 0
        ? `${base} (${record.duplicateIndex})` : base;
    }
  }

  notifyWorkspaceChanged(workspaceKey) {
    this.recomputeLabels(this.getWorkspaceState(workspaceKey));
    if (workspaceKey === this.currentWorkspaceKey) {
      this.renderTabs();
      this.editor.bottomPanelManager?.syncControls?.();
    }
    this.editor.statesManager?.scheduleBottomPanelStateSave?.(workspaceKey);
  }

  handleOutput(payload) {
    if (!payload || typeof payload.sessionId !== "string" ||
        typeof payload.workspaceKey !== "string" || typeof payload.data !== "string" ||
        !Number.isSafeInteger(payload.sequence)) return;
    const record = this.sessionIndex.get(payload.sessionId);
    if (!record) {
      if (this.closedSessionIds.has(payload.sessionId)) {
        void this.editor.api.acknowledgeTerminalOutput(
          payload.sessionId, payload.workspaceKey, payload.sequence,
        );
        return;
      }
      if (this.pendingOutput.size >= 8 && !this.pendingOutput.has(payload.sessionId)) return;
      const pending = this.pendingOutput.get(payload.sessionId) || [];
      if (pending.length < 2) pending.push(payload);
      this.pendingOutput.set(payload.sessionId, pending);
      return;
    }
    if (payload.workspaceKey !== record.workspaceKey) {
      void this.editor.api.acknowledgeTerminalOutput(
        payload.sessionId, payload.workspaceKey, payload.sequence,
      );
      return;
    }
    this.writeOutput(record, payload);
  }

  writeOutput(record, payload) {
    if (record.disposed) {
      void this.editor.api.acknowledgeTerminalOutput(
        payload.sessionId, record.workspaceKey, payload.sequence,
      );
      return;
    }
    record.terminal.write(payload.data, () => {
      void this.editor.api.acknowledgeTerminalOutput(
        payload.sessionId, record.workspaceKey, payload.sequence,
      ).catch((error) => console.error("[Terminal] Failed to acknowledge PTY output", error));
    });
  }

  handleExit(payload) {
    const record = this.sessionIndex.get(payload?.sessionId);
    if (!record || payload.workspaceKey !== record.workspaceKey || record.exited) return;
    record.exited = true;
    record.exitCode = Number.isInteger(payload.exitCode) ? payload.exitCode : null;
    const exitLabel = record.exitCode === null
      ? "Process exited" : `Process exited with code ${record.exitCode}`;
    record.terminal.write(`\r\n\x1b[90m[${exitLabel}]\x1b[0m\r\n`);
    if (record.workspaceKey === this.currentWorkspaceKey) this.renderTabs();
  }

  handleError(payload) {
    const record = this.sessionIndex.get(payload?.sessionId);
    const error = payload?.error;
    if (!record || payload.workspaceKey !== record.workspaceKey || !error) return;
    record.exited = true;
    record.terminal.write(`\r\n\x1b[31m${error.message || "Terminal session unavailable."}\x1b[0m\r\n`);
    if (record.workspaceKey === this.currentWorkspaceKey) this.renderTabs();
  }

  getActiveSessionFor(state) {
    return state?.sessions.get(state.activeSessionId) || null;
  }

  getActiveSession() {
    return this.getActiveSessionFor(this.currentState);
  }

  isActive(record) {
    return !this.destroyed && record.workspaceKey === this.currentWorkspaceKey &&
      this.currentState.activeSessionId === record.id &&
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

  activateSession(id, { focus = true, focusTerminal = false } = {}) {
    const state = this.currentState;
    const record = state.sessions.get(id);
    if (!record || record.workspaceKey !== this.currentWorkspaceKey) return false;
    const keepTabFocus = this.tabsList?.contains?.(document.activeElement) &&
      document.activeElement?.getAttribute?.("role") === "tab";
    const changed = state.activeSessionId !== id;
    state.activeSessionId = id;
    this.renderTabs();
    if (keepTabFocus && !focusTerminal) {
      const index = [...state.sessions.keys()].indexOf(id);
      this.tabsList?.querySelectorAll?.('[role="tab"]')?.[index]?.focus?.();
    }
    this.showActive(record);
    this.scheduleFit({ focus: focus && !focusTerminal });
    if (focusTerminal) record.terminal.focus?.();
    if (changed) this.notifyWorkspaceChanged(this.currentWorkspaceKey);
    return true;
  }

  async closeSession(id) {
    const state = this.currentState;
    const record = state.sessions.get(id);
    if (!record || record.workspaceKey !== this.currentWorkspaceKey || record.closingPromise) return false;
    const removedName = this.getNameBase(record);
    record.closingPromise = Promise.resolve();
    const wasActive = state.activeSessionId === id;
    const keepTabFocus = this.tabsList?.contains?.(document.activeElement) === true;
    state.sessions.delete(id);
    if (record.id) {
      this.sessionIndex.delete(record.id);
      this.closedSessionIds.add(record.id);
      if (this.closedSessionIds.size > 32)
        this.closedSessionIds.delete(this.closedSessionIds.values().next().value);
      this.pendingOutput.delete(record.id);
      state.restoreSessionIds = state.restoreSessionIds.filter((sessionId) => sessionId !== record.id);
    }
    if (wasActive) state.activeSessionId = state.sessions.keys().next().value || null;
    this.disposeRecord(record);
    this.normalizeSingletonDuplicateIndices(state, removedName);
    this.recomputeLabels(state);
    this.renderTabs();
    if (keepTabFocus && state.activeSessionId && state.sessions.size > 1) {
      const index = [...state.sessions.keys()].indexOf(state.activeSessionId);
      this.tabsList?.querySelectorAll?.('[role="tab"]')?.[index]?.focus?.();
    } else if (keepTabFocus && state.activeSessionId) {
      this.getActiveSession()?.terminal.focus?.();
    }
    const active = this.getActiveSession();
    if (active) this.showActive(active);
    else this.clearTerminalActions();
    this.notifyWorkspaceChanged(this.currentWorkspaceKey);

    if (!state.sessions.size) {
      state.initialOpenAttempted = false;
      state.lastError = null;
      this.editor.bottomPanelManager?.closePanel?.({ restoreFocus: false });
    }
    if (record.id) {
      const close = Promise.resolve(this.editor.api.closeTerminalSession(record.id, record.workspaceKey))
        .catch((error) => {
          console.error("[Terminal] Failed to close PTY session", error);
          return false;
        });
      let timeoutId;
      const timeout = new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve(false), 2000);
      });
      void Promise.race([close, timeout]).finally(() => clearTimeout(timeoutId));
    }
    return true;
  }

  showActive(record) {
    this.clearStatus();
    for (const state of this.workspaceSessions.values()) {
      for (const candidate of state.sessions.values())
        candidate.wrapper.hidden = candidate !== record;
    }
    const selected = Boolean(record);
    for (const button of this.actionsMenu?.querySelectorAll?.("[data-action]") || [])
      button.disabled = !selected;
  }

  hideInactiveWorkspaceSessions() {
    for (const state of this.workspaceSessions.values()) {
      for (const record of state.sessions.values()) {
        record.wrapper.hidden = record.workspaceKey !== this.currentWorkspaceKey ||
          record.id !== this.currentState.activeSessionId;
      }
    }
  }

  clearTerminalActions() {
    for (const button of this.actionsMenu?.querySelectorAll?.("[data-action]") || [])
      button.disabled = true;
  }

  showError(message, workspaceKey = this.currentWorkspaceKey) {
    if (!this.view || workspaceKey !== this.currentWorkspaceKey) return;
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
    retry.addEventListener("click", () => {
      if (workspaceKey !== this.currentWorkspaceKey) return;
      this.clearStatus();
      const state = this.currentState;
      state.initialOpenAttempted = true;
      if (!state.initialOpenPromise) {
        state.initialOpenPromise = this.restoreOrCreateInitialSessions(state)
          .finally(() => { state.initialOpenPromise = null; });
      }
    }, { once: true });
    status.append(text, retry);
    this.view.appendChild(status);
    this.errorStatus = status;
  }

  clearStatus() {
    this.errorStatus?.remove();
    this.errorStatus = null;
  }

  renderTabs() {
    if (!this.tabsList) return;
    const state = this.currentState;
    const records = [...state.sessions.entries()];
    const showTabManager = records.length > 1;
    if (this.tabsElement) this.tabsElement.hidden = !showTabManager;
    this.tabsList.hidden = !showTabManager;
    this.tabsList.replaceChildren();
    for (const [id, record] of showTabManager ? records : []) {
      const tab = document.createElement("div");
      tab.className = "terminal-tab";
      tab.classList.toggle("is-active", id === state.activeSessionId);
      tab.setAttribute("role", "presentation");
      const activate = document.createElement("button");
      activate.className = "terminal-tab-select";
      activate.type = "button";
      activate.id = `terminal-tab-${this.domSafeId(id)}`;
      activate.setAttribute("role", "tab");
      activate.setAttribute("aria-controls", record.wrapper.id);
      activate.setAttribute("aria-selected", String(id === state.activeSessionId));
      activate.tabIndex = id === state.activeSessionId ? 0 : -1;
      activate.title = `${record.displayLabel}\nShell: ${record.shell || "Starting…"}\nInitial directory: ${record.cwd || "Pending"}`;
      const icon = document.createElement("i");
      icon.className = "fi fi-rr-terminal terminal-tab-icon";
      icon.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "terminal-tab-label";
      label.textContent = record.displayLabel;
      activate.append(icon, label);
      if (record.exited) {
        const status = document.createElement("span");
        status.className = "terminal-tab-exited";
        status.textContent = "exited";
        status.setAttribute("aria-label", "Process exited");
        activate.appendChild(status);
      }
      activate.addEventListener("click", () =>
        this.activateSession(id, { focusTerminal: true }),
      );
      activate.addEventListener("dblclick", () => this.renameSession(id, activate));
      const close = document.createElement("button");
      close.type = "button";
      close.className = "terminal-tab-close";
      close.setAttribute("aria-label", `Close ${record.displayLabel}`);
      close.title = `Close ${record.displayLabel}`;
      close.innerHTML = '<i class="fi fi-rr-cross-small" aria-hidden="true"></i>';
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.closeSession(id);
      });
      tab.append(activate, close);
      this.tabsList.appendChild(tab);
    }
    const active = this.getActiveSession();
    if (active) this.showActive(active);
    else this.clearTerminalActions();
  }

  domSafeId(value) {
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
  }

  handleTabsKeyDown(event) {
    if (!event.target?.matches?.('[role="tab"]')) return;
    const tabs = [...(this.tabsList?.querySelectorAll?.('[role="tab"]') || [])];
    if (!tabs.length) return;
    const current = tabs.indexOf(event.target);
    let next = current;
    if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    const id = [...this.currentState.sessions.keys()][next];
    this.activateSession(id, { focus: false });
    this.tabsList?.querySelectorAll?.('[role="tab"]')?.[next]?.focus?.();
  }

  renameSession(id, button) {
    const record = this.currentState.sessions.get(id);
    if (!record || record.disposed || record.workspaceKey !== this.currentWorkspaceKey) return;
    const input = document.createElement("input");
    input.className = "terminal-tab-rename";
    input.value = record.customLabel || record.baseLabel;
    input.setAttribute("aria-label", "Terminal name");
    button.replaceWith(input);
    input.focus();
    input.select();
    const finish = (save) => {
      if (input.dataset.finished === "true") return;
      input.dataset.finished = "true";
      if (save && input.value.trim()) {
        const custom = input.value.trim().slice(0, 80);
        record.customLabel = custom === record.baseLabel ? null : custom;
        record.duplicateIndex = this.allocateDuplicateIndex(record, this.currentState);
        this.recomputeLabels(this.currentState);
        this.notifyWorkspaceChanged(this.currentWorkspaceKey);
      }
      this.renderTabs();
      this.activateSession(id, { focus: false });
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") finish(true);
      if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true), { once: true });
  }

  toggleActionsMenu() {
    if (!this.actionsMenu) return;
    const open = this.actionsMenu.hidden;
    this.actionsMenu.hidden = !open;
    this.actionsToggle?.setAttribute("aria-expanded", String(open));
    if (open) this.actionsMenu.querySelector('[role="menuitem"]')?.focus();
  }

  closeActionsMenu() {
    if (!this.actionsMenu || this.actionsMenu.hidden) return;
    this.actionsMenu.hidden = true;
    this.actionsToggle?.setAttribute("aria-expanded", "false");
  }

  async runAction(action) {
    const record = this.getActiveSession();
    if (!record || !this.isActive(record)) return false;
    if (action === "select-all") record.terminal.selectAll();
    else if (action === "clear") record.terminal.clear();
    else if (action === "copy") {
      const selection = record.terminal.getSelection();
      if (selection) {
        try { await this.editor.api.writeClipboardText(selection); }
        catch (error) { console.error("[Terminal] Failed to copy terminal selection", error); }
      }
    } else if (action === "paste") {
      try {
        const text = await this.editor.api.readClipboardText();
        if (typeof text === "string" && this.isActive(record)) record.terminal.paste(text);
      } catch (error) {
        console.error("[Terminal] Failed to paste terminal content", error);
      }
    }
    if (this.isActive(record)) record.terminal.focus();
    return true;
  }

  scheduleFit({ focus = false } = {}) {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    const focusOrigin = focus ? document.activeElement : null;
    const workspaceKey = this.currentWorkspaceKey;
    const generation = this.workspaceGeneration;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (workspaceKey !== this.currentWorkspaceKey || generation !== this.workspaceGeneration) return;
      const record = this.getActiveSession();
      if (!record || !this.isActive(record)) return;
      void this.fitRecord(record).then(() => {
        if (
          focus && generation === this.workspaceGeneration &&
          this.isActive(record) && document.activeElement === focusOrigin &&
          focusOrigin?.isConnected
        ) record.terminal.focus();
      });
    });
  }

  async fitRecord(record) {
    if (record.disposed || record.workspaceKey !== this.currentWorkspaceKey ||
        !record.wrapper?.isConnected || record.wrapper.hidden) return false;
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
        record.workspaceKey !== this.currentWorkspaceKey ||
        !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 ||
        (record.cols === cols && record.rows === rows)) return;
    record.cols = cols;
    record.rows = rows;
    void this.editor.api.resizeTerminalSession(record.id, record.workspaceKey, cols, rows).catch((error) =>
      console.error("[Terminal] Failed to resize PTY", error),
    );
  }

  getXtermTheme() {
    const style = getComputedStyle(document.documentElement);
    return {
      background: style.getPropertyValue("--terminal-surface").trim(),
      foreground: style.getPropertyValue("--text-primary").trim(),
      cursor: style.getPropertyValue("--text-primary").trim(),
      selectionBackground: style.getPropertyValue("--selection-bg").trim(),
    };
  }

  applyTheme() {
    const theme = this.getXtermTheme();
    for (const state of this.workspaceSessions.values())
      for (const record of state.sessions.values()) record.terminal.options.theme = theme;
  }

  focus() {
    const record = this.getActiveSession();
    if (record && this.isActive(record)) {
      record.terminal.focus();
      return true;
    }
    this.element.querySelector('.terminal-tabs [role="tab"]')?.focus();
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
    this.actionsToggle?.removeEventListener("click", this.onActionsToggle);
    this.actionsMenu?.removeEventListener("click", this.onActionsMenuClick);
    this.actionsMenu?.removeEventListener("keydown", this.onActionsMenuKeyDown);
    this.tabsList?.removeEventListener("keydown", this.onTabsKeyDown);
    document.removeEventListener("pointerdown", this.onOutsidePointerDown);
    this.actionsContainer?.remove();
    for (const state of this.workspaceSessions.values()) {
      for (const record of state.sessions.values()) {
        if (record.id)
          void this.editor.api.closeTerminalSession(record.id, record.workspaceKey).catch(() => false);
        this.disposeRecord(record);
      }
      state.sessions.clear();
    }
    this.workspaceSessions.clear();
    this.sessionIndex.clear();
    this.pendingOutput.clear();
    this.element.remove();
  }
}
