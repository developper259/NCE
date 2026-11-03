class LspController {
  constructor(editor) {
    this.editor = editor;
    this.api = window.api?.lsp || null;
    this.documents = new Map();
    this.diagnosticsByPath = new Map();
    this.diagnosticsDocuments = [];
    this.status = null;
    this.changeQueues = new Map();
    this.syncQueues = new Map();
    this.diagnosticNodes = [];
    this.overlayFrame = null;
    this.problemsPanel = null;
    this.completionWidget = new LspCompletionWidget(editor);
    this.hoverPopover = new LspPopover(editor, "lsp-popover lsp-hover");
    this.signaturePopover = new LspPopover(editor, "lsp-popover lsp-signature");
    this.hoverToken = 0;
    this.requestToken = 0;
    this.completionSession = null;
    this.autoCompletionTimer = null;
    this.signatureTimer = null;
    this.unsupported = new Map();
    this.editQueue = Promise.resolve(true);
    this.progressByServer = new Map();
    this.markdownRenderer = null;
    this.markdownLoadPromise = null;
    this.disposed = false;
    this.unsubscribe = [];
    this.pointerLeaveHandler = () => this.hideHover();
    this.pointerDownHandler = (event) => {
      if (this.completionWidget.isVisible &&
          !event.target?.closest?.(".lsp-completion")) this.completionWidget.hide();
    };
    this.wheelHandler = () => this.hideTransientUi();
    this.keyDownHandler = (event) => this.handleKeyDown(event);

    this.registerProblemsPanel();

    if (!this.api) {
      this.notify("Language server integration is unavailable in this window.", "warning");
      return;
    }

    const subscribe = (callback) => {
      const unsubscribe = callback();
      if (typeof unsubscribe === "function") this.unsubscribe.push(unsubscribe);
    };
    subscribe(() => this.api.onDiagnostics((payload) => this.handleDiagnostics(payload)));
    subscribe(() => this.api.onStatus((payload) => this.handleStatus(payload)));
    subscribe(() => this.api.onReset(() => this.handleReset()));
    subscribe(() => this.api.onApplyEditRequest?.((payload) => this.handleApplyEditRequest(payload)));
    subscribe(() => this.api.onProgress?.((payload) => this.handleProgress(payload)));
    subscribe(() => this.api.onMessage?.((payload) => {
      if (typeof payload?.message !== "string") return;
      const level = payload.type === 1 ? "error" : payload.type === 2 ? "warning" : "info";
      this.notify(payload.message, level);
    }));
    if (typeof editor.tabManager?.onActiveTabChange === "function") {
      const unsubscribe = editor.tabManager.onActiveTabChange(() => {
        this.ensureActiveDocument();
        this.scheduleDiagnosticsOverlay();
        this.hideTransientUi();
      });
      if (typeof unsubscribe === "function") this.unsubscribe.push(unsubscribe);
    }
    editor.editorOBJ?.addEventListener("pointerleave", this.pointerLeaveHandler);
    editor.editorOBJ?.addEventListener("wheel", this.wheelHandler, { passive: true });
    document.addEventListener("pointerdown", this.pointerDownHandler, true);
    // Window capture runs before the editor's document-level key handler so the
    // completion list can consume navigation keys without moving the caret.
    window.addEventListener("keydown", this.keyDownHandler, true);
    void this.refreshStatus();
  }

  handleKeyDown(event) {
    if (this.editor.quickPanel?.isOpen?.()) {
      if (this.completionWidget.isVisible) this.completionWidget.hide();
      return;
    }
    if (this.completionWidget.isVisible && this.completionWidget.handleKeyDown(event)) return;
    if (event.key === "Escape" && (this.hoverPopover.isVisible || this.signaturePopover.isVisible)) {
      event.preventDefault();
      event.stopPropagation();
      this.hideTransientUi();
    }
  }

  registerProblemsPanel() {
    const manager = this.editor.bottomPanelManager;
    if (!manager || typeof manager.registerPanel !== "function") return;
    manager.registerPanel({
      id: "problems",
      title: "Problems",
      createView: (container, editor) => {
        this.problemsPanel = new ProblemsPanel(editor, this);
        container?.replaceChildren?.(this.problemsPanel.element);
        this.problemsPanel.render(this.diagnosticsDocuments);
        this.updateProblemsStatus();
        return this.problemsPanel;
      },
      canKill: () => false,
    });
  }

  destroy() {
    this.disposed = true;
    for (const unsubscribe of this.unsubscribe.splice(0)) {
      try { unsubscribe(); } catch {}
    }
    if (this.signatureTimer) clearTimeout(this.signatureTimer);
    this.signatureTimer = null;
    if (this.overlayFrame !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.overlayFrame);
      this.overlayFrame = null;
    }
    this.editor.editorOBJ?.removeEventListener("pointerleave", this.pointerLeaveHandler);
    this.editor.editorOBJ?.removeEventListener("wheel", this.wheelHandler);
    document.removeEventListener("pointerdown", this.pointerDownHandler, true);
    window.removeEventListener("keydown", this.keyDownHandler, true);
    this.completionWidget?.destroy?.();
    this.hoverPopover?.destroy?.();
    this.signaturePopover?.destroy?.();
    this.editor.diagnosticsOutput?.replaceChildren?.();
    for (const record of this.documents.values()) {
      void this.api?.closeDocument?.({ path: record.path });
    }
    this.documents.clear();
  }

  // ---- Document synchronization -------------------------------------------------

  handleOpenFile(payload) {
    const files = Array.isArray(payload?.files) ? payload.files : [];
    for (const file of files) void this.ensureDocument(file);
    if (payload?.activeFile) void this.ensureDocument(payload.activeFile);
    this.scheduleDiagnosticsOverlay();
  }

  handleEditorLoaded() {
    for (const file of this.editor.tabManager?.files || []) void this.ensureDocument(file);
    this.ensureActiveDocument();
  }

  handleCloseFile(payload) {
    if (payload?.file) {
      void this.closeFileDocument(payload.file);
      return;
    }
    for (const record of [...this.documents.values()]) {
      void this.api?.closeDocument?.({ path: record.path });
    }
    this.documents.clear();
    this.diagnosticsByPath.clear();
    this.diagnosticsDocuments = [];
    this.refreshProblems();
    this.refreshDiagnosticsOverlay();
  }

  handleChange(payload) {
    const file = this.editor.tabManager?.activeFile;
    if (!file) return;
    if (this.completionWidget.isVisible) this.updateCompletionPrefix(file);
    const record = this.documents.get(file.id);
    if (!record) {
      void this.ensureDocument(file);
      return;
    }
    this.queueChange(file, record, payload);
    const afterText = typeof payload?.afterText === "string" ? payload.afterText : "";
    const typedCharacter = payload?.batch ? "" : afterText.slice(-1);
    if (typedCharacter) {
      if (this.getTriggerCharacters("completion").includes(typedCharacter)) {
        this.scheduleAutoCompletion(file, typedCharacter);
      }
      if (this.getTriggerCharacters("signature").includes(typedCharacter)) {
        this.scheduleSignatureHelp(file);
      }
    }
    this.hideHover();
  }

  handleSavedFile(file) {
    if (!file) return;
    const record = this.documents.get(file.id);
    if (!record || record.filePath !== file.path) {
      void this.ensureDocument(file, { force: true });
      return;
    }
    void this.api?.saveDocument?.({ path: record.path, text: LspPositions.documentText(file) });
  }

  handleRenamedPaths(oldPath, newPath) {
    if (!oldPath || !newPath) return;
    for (const record of [...this.documents.values()]) {
      if (record.filePath === oldPath || record.filePath.startsWith(`${oldPath}/`) ||
          record.filePath.startsWith(`${oldPath}\\`)) {
        void this.closeRecord(record);
      }
    }
    for (const file of this.editor.tabManager?.files || []) void this.ensureDocument(file);
    this.scheduleDiagnosticsOverlay();
  }

  handleDeletedPath(deletedPath) {
    if (!deletedPath) return;
    for (const record of [...this.documents.values()]) {
      if (record.filePath === deletedPath || record.filePath.startsWith(`${deletedPath}/`) ||
          record.filePath.startsWith(`${deletedPath}\\`)) {
        void this.closeRecord(record);
      }
    }
  }

  ensureActiveDocument() {
    const file = this.editor.tabManager?.activeFile;
    if (file) void this.ensureDocument(file);
  }

  ensureDocument(file, options = {}) {
    if (!this.api || this.disposed || !file) return Promise.resolve();
    const previous = this.syncQueues.get(file.id) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this.ensureDocumentNow(file, options));
    this.syncQueues.set(file.id, next);
    void next.finally(() => {
      if (this.syncQueues.get(file.id) === next) this.syncQueues.delete(file.id);
    });
    return next;
  }

  getEligibility(file) {
    if (!file || file.type !== TAB_TYPES.FILE || !file.path) return false;
    if (/(^|[\\/])\.nce([\\/]|$)/.test(file.path)) return false;
    if (!file.isLoaded || file.loadError || file.isDiffView || file.largeFileMode) return false;
    if (file.loadingState && file.loadingState.status !== "loaded") return false;
    return true;
  }

  async ensureDocumentNow(file, options = {}) {
    const existing = this.documents.get(file.id);
    if (!this.getEligibility(file)) {
      if (existing) await this.closeRecord(existing);
      return;
    }
    if (existing && existing.filePath !== file.path) await this.closeRecord(existing);
    const record = this.documents.get(file.id);
    if (record && !options.force && record.generation === file.contentGeneration) return;
    if (record) await this.closeRecord(record);
    if (!options.force && this.unsupported.get(file.id) === `${file.path}:${file.contentGeneration}`)
      return;
    let result = null;
    try {
      result = await this.api.openDocument({ path: file.path, text: LspPositions.documentText(file) });
    } catch (error) {
      console.warn("[LSP] Unable to open document", error);
      return;
    }
    if (!result?.success) return;
    if (!result.supported) {
      this.unsupported.set(file.id, `${file.path}:${file.contentGeneration}`);
      return;
    }
    this.unsupported.delete(file.id);
    this.documents.set(file.id, {
      fileId: file.id,
      filePath: file.path,
      path: result.path || file.path,
      generation: file.contentGeneration,
      languageId: result.languageId,
      servers: result.servers || [],
      lastVersion: 1,
    });
    this.scheduleDiagnosticsOverlay();
  }

  async closeFileDocument(file) {
    const record = this.documents.get(file.id);
    if (!record) return;
    await this.closeRecord(record);
  }

  async closeRecord(record) {
    this.documents.delete(record.fileId);
    this.unsupported.delete(record.fileId);
    this.syncQueues.delete(record.fileId);
    this.changeQueues.delete(record.fileId);
    this.diagnosticsByPath.delete(record.path);
    this.diagnosticsDocuments = this.diagnosticsDocuments.filter((document) => document.path !== record.path);
    try {
      await this.api?.closeDocument?.({ path: record.path });
    } catch {}
    this.refreshProblems();
    this.scheduleDiagnosticsOverlay();
  }

  buildChanges(file, payload) {
    return LspPositions.changeForEdit(file, payload);
  }

  queueChange(file, record, payload) {
    const changes = this.buildChanges(file, payload);
    const previous = this.changeQueues.get(file.id) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (!this.documents.has(file.id) || this.documents.get(file.id) !== record) return;
      let result = null;
      try {
        result = await this.api.changeDocument({ path: record.path, changes });
      } catch (error) {
        console.warn("[LSP] Unable to synchronize a change", error);
        return;
      }
      if (result?.success) {
        record.lastVersion = result.version;
        return;
      }
      if (result?.code === "LSP_DOCUMENT_NOT_OPEN") {
        this.documents.delete(file.id);
        await this.ensureDocument(file, { force: true });
      }
    });
    this.changeQueues.set(file.id, next);
    void next.finally(() => {
      if (this.changeQueues.get(file.id) === next) this.changeQueues.delete(file.id);
    });
  }

  // ---- Diagnostics --------------------------------------------------------------

  handleDiagnostics(payload) {
    const documents = Array.isArray(payload?.documents) ? payload.documents : [];
    this.diagnosticsDocuments = documents;
    this.diagnosticsByPath = new Map(
      documents.map((document) => [document.path, document.diagnostics || []]),
    );
    this.refreshProblems();
    this.scheduleDiagnosticsOverlay();
  }

  handleStatus(status) {
    this.status = status;
    this.updateProblemsStatus();
  }

  handleReset() {
    this.documents.clear();
    this.unsupported.clear();
    this.progressByServer.clear();
    this.diagnosticsByPath.clear();
    this.diagnosticsDocuments = [];
    this.completionWidget.hide();
    this.hideHover();
    this.signaturePopover.hide();
    this.refreshProblems();
    this.refreshDiagnosticsOverlay();
    for (const file of this.editor.tabManager?.files || []) void this.ensureDocument(file);
    void this.refreshStatus();
  }

  async refreshStatus() {
    if (!this.api) return;
    try {
      const status = await this.api.getStatus();
      if (status?.success) this.handleStatus(status);
    } catch {}
  }

  handleProgress(payload) {
    const serverId = payload?.serverId;
    if (typeof serverId !== "string" || typeof payload?.kind !== "string") return;
    if (payload.kind === "end") this.progressByServer.delete(serverId);
    else {
      this.progressByServer.set(serverId, {
        title: payload.title || "",
        message: payload.message || "",
        percentage: Number.isFinite(payload.percentage) ? payload.percentage : null,
      });
    }
    this.updateProblemsStatus();
  }

  updateProblemsStatus() {
    if (!this.problemsPanel) return;
    const parts = [];
    if (this.status) {
      const enabled = this.status.enabled !== false;
      const servers = this.status.servers || [];
      const ready = (this.status.sessions || []).filter((session) => session.state === "ready").length;
      const unavailable = servers.filter((server) => server.enabled && !server.available).length;
      if (!enabled) parts.push("Language servers disabled");
      else {
        parts.push(`${ready} server${ready === 1 ? "" : "s"} ready`);
        if (unavailable) parts.push(`${unavailable} unavailable`);
      }
    }
    for (const progress of this.progressByServer.values()) {
      const label = progress.message || progress.title;
      if (!label) continue;
      parts.push(progress.percentage === null
        ? label
        : `${label} (${Math.round(progress.percentage)}%)`);
    }
    this.problemsPanel.setServerStatus(parts.join(" · "));
  }

  refreshProblems() {
    if (this.problemsPanel) this.problemsPanel.render(this.diagnosticsDocuments);
    this.updateProblemsStatus();
  }

  scheduleDiagnosticsOverlay() {
    if (this.overlayFrame !== null) return;
    const requestFrame = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (callback) => setTimeout(callback, 0);
    this.overlayFrame = requestFrame(() => {
      this.overlayFrame = null;
      this.refreshDiagnosticsOverlay();
    });
  }

  refreshDiagnosticsOverlay() {
    const layer = this.editor.diagnosticsOutput;
    const file = this.editor.tabManager?.activeFile;
    if (!layer || !file) {
      layer?.replaceChildren?.();
      return;
    }
    const record = this.documents.get(file.id);
    const diagnostics = record ? this.diagnosticsByPath.get(record.path) : null;
    if (!diagnostics || !diagnostics.length) {
      layer.replaceChildren();
      this.diagnosticNodes = [];
      return;
    }
    const lc = this.editor.lineController;
    const cursor = this.editor.cursorController;
    const outputRect = this.editor.domManager.getOutputRect();
    const renderStart = lc.renderStartIndex ?? lc.startIndex ?? 0;
    const startIndex = lc.startIndex ?? 0;
    const visibleStart = Math.max(0, startIndex - renderStart);
    const displayTotal = lc.getDisplayLineCount();
    const visibleCount = Math.max(0, Math.min(
      (lc.maxViewLines || lc.renderedLineCount || 1) + 1,
      displayTotal - startIndex,
    ));
    const offsetX = lc.offsetX || 0;
    const viewportEnd = offsetX + (lc.maxCharactersPerLine || 0);
    const rects = [];
    for (let offset = 0; offset < visibleCount; offset += 1) {
      const screenIndex = visibleStart + offset;
      const displayRow = lc.getDisplayRow(renderStart + screenIndex);
      if (!displayRow || displayRow.documentIndex === null) continue;
      const row = displayRow.documentIndex + 1;
      const lineNode = lc.lines[displayRow.documentIndex];
      const text = lineNode?.getText?.() || displayRow.text || "";
      for (const diagnostic of diagnostics) {
        const start = diagnostic.range?.start;
        const end = diagnostic.range?.end;
        if (!start || !end) continue;
        if (row < start.line + 1 || row > end.line + 1) continue;
        const realStart = row === start.line + 1 ? start.character : 0;
        const realEnd = row === end.line + 1 ? end.character : text.length;
        if (realEnd <= realStart) continue;
        const positionIndex = lineNode?.getPositionIndex?.();
        const viewStart = positionIndex
          ? positionIndex.realToVisual(Math.min(realStart, text.length))
          : realStart;
        const viewEnd = positionIndex
          ? positionIndex.realToVisual(Math.min(realEnd, text.length))
          : realEnd;
        const clippedStart = Math.max(viewStart, offsetX);
        const clippedEnd = Math.min(viewEnd, viewportEnd);
        if (clippedEnd <= clippedStart) continue;
        const x = cursor.columnToX(clippedStart + 1);
        const width = Math.max(2, (clippedEnd - clippedStart) * this.editor.letterSize);
        if (x + width < 0 || x > outputRect.width) continue;
        rects.push({
          x,
          y: lc.getLineTop(screenIndex),
          width,
          height: cursor.mpY + 4,
          severity: LspPositions.severityClass(diagnostic.severity),
          message: diagnostic.message,
          source: diagnostic.serverName || diagnostic.source || "LSP",
        });
        if (rects.length >= 300) break;
      }
      if (rects.length >= 300) break;
    }
    this.renderDiagnosticRects(rects);
  }

  renderDiagnosticRects(rects) {
    const layer = this.editor.diagnosticsOutput;
    if (!layer || typeof document === "undefined") return;
    while (this.diagnosticNodes.length < rects.length) {
      const node = document.createElement("div");
      node.className = "lsp-diagnostic";
      layer.appendChild(node);
      this.diagnosticNodes.push(node);
    }
    for (let index = 0; index < this.diagnosticNodes.length; index += 1) {
      const node = this.diagnosticNodes[index];
      const rect = rects[index];
      if (!rect) {
        node.style.display = "none";
        continue;
      }
      node.style.display = "block";
      node.className = `lsp-diagnostic lsp-diagnostic-${rect.severity}`;
      node.style.left = `${rect.x}px`;
      node.style.top = `${Math.round(rect.y)}px`;
      node.style.width = `${rect.width}px`;
      node.style.height = `${rect.height}px`;
      const title = `${rect.message}${rect.source ? ` — ${rect.source}` : ""}`;
      if (node.title !== title) node.title = title;
    }
  }

  // ---- Feature commands ---------------------------------------------------------

  getActiveContext() {
    const file = this.editor.tabManager?.activeFile;
    if (!file || !this.api) return null;
    const record = this.documents.get(file.id);
    if (!record) {
      void this.ensureDocument(file);
      return null;
    }
    return { file, record };
  }

  getPosition(file) {
    return LspPositions.position(file.row, file.column);
  }

  async requestCompletion(triggerKind = 1, triggerCharacter = undefined) {
    let context = this.getActiveContext();
    if (!context) {
      const file = this.editor.tabManager?.activeFile;
      if (!file || !this.api) return null;
      await this.ensureDocument(file);
      context = this.getActiveContext();
      if (!context) return null;
    }
    const { file, record } = context;
    const requestRow = file.row;
    const requestColumn = file.column;
    const token = ++this.requestToken;
    let result = null;
    try {
      result = await this.api.completion({
        path: record.path,
        position: this.getPosition(file),
        triggerKind,
        ...(triggerCharacter ? { triggerCharacter } : {}),
      });
    } catch (error) {
      console.warn("[LSP] Completion failed", error);
      return null;
    }
    if (token !== this.requestToken || this.editor.tabManager?.activeFile !== file) return null;
    if (file.row !== requestRow || file.column < requestColumn) return null;
    if (!result?.success) {
      if (result?.code !== "LSP_NO_PROVIDER") this.notify(result?.error || "Completion failed.", "error");
      return null;
    }
    const items = Array.isArray(result.items) ? result.items : [];
    const anchor = this.editor.cD?.getBoundingClientRect?.();
    this.completionSession = {
      token,
      file,
      record,
      row: file.row,
      column: file.column,
      editVersion: file.editVersion,
      items,
      triggerColumn: file.column,
    };
    this.completionWidget.show({
      items,
      prefix: "",
      session: this.completionSession,
      anchorRect: anchor,
      onAccept: (item, session) => this.applyCompletion(item, session),
      onDismiss: () => {
        if (this.completionSession?.token === token) this.completionSession = null;
      },
    });
    void this.resolveCompletionDetails(this.completionSession);
    return result;
  }

  completionSourceSupportsResolve(source) {
    return (this.status?.sessions || []).some((session) =>
      session.state === "ready" &&
      session.serverId === source &&
      session.capabilities?.completionResolve === true);
  }

  async resolveCompletionDetails(session) {
    if (!session || this.completionSession !== session || !this.api?.resolveCompletion) return;
    const pending = session.items
      .slice(0, 100)
      .filter((item) => item?.id && !item.detail &&
        this.completionSourceSupportsResolve(item.source));
    if (!pending.length) return;
    let index = 0;
    const worker = async () => {
      while (this.completionSession === session) {
        const item = pending[index];
        index += 1;
        if (!item) return;
        try {
          const resolved = await this.api.resolveCompletion({ id: item.id });
          if (this.completionSession !== session) return;
          if (resolved?.success && typeof resolved.item?.detail === "string" && resolved.item.detail)
            item.detail = resolved.item.detail;
        } catch {}
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, pending.length) }, worker));
    if (this.completionSession === session && this.completionWidget.isVisible)
      this.completionWidget.render();
  }

  updateCompletionPrefix(file) {
    const session = this.completionSession;
    if (!session || session.file !== file) {
      this.completionWidget.hide();
      return;
    }
    if (file.row !== session.row || file.column < session.triggerColumn) {
      this.completionWidget.hide();
      return;
    }
    const line = file.lines[file.row - 1]?.getText?.() || "";
    this.completionWidget.setPrefix(line.slice(session.triggerColumn, file.column));
    this.completionWidget.position(this.editor.cD?.getBoundingClientRect?.());
  }

  async applyCompletion(item, session) {
    if (!item || !session || this.editor.tabManager?.activeFile !== session.file) return;
    if (item.id && typeof this.api.resolveCompletion === "function") {
      try {
        const resolved = await this.api.resolveCompletion({ id: item.id });
        if (resolved?.success && resolved.item) item = resolved.item;
      } catch {}
    }
    const file = session.file;
    if (this.documents.get(file.id) !== session.record) return;
    const edits = [];
    const currentVersionMatches = file.editVersion === session.editVersion;
    const textEdit = currentVersionMatches && LspPositions.isValidRange(item.textEdit?.range)
      ? item.textEdit
      : null;
    if (textEdit) {
      const range = LspPositions.editorRange(textEdit.range, file.lines.length);
      if (range) edits.push({ ...range, text: textEdit.newText });
    }
    if (!edits.length) {
      const line = file.lines[file.row - 1]?.getText?.() || "";
      const word = LspPositions.wordRangeAt(line, file.column);
      edits.push({
        start: { row: file.row, column: word.start },
        end: { row: file.row, column: file.column },
        text: item.insertText ?? item.label ?? "",
      });
    }
    if (currentVersionMatches && Array.isArray(item.additionalTextEdits)) {
      for (const additional of item.additionalTextEdits) {
        if (!LspPositions.isValidRange(additional?.range)) continue;
        const range = LspPositions.editorRange(additional.range, file.lines.length);
        if (range) edits.push({ ...range, text: additional.newText ?? "" });
      }
    }
    edits.sort((left, right) =>
      right.start.row - left.start.row ||
      right.start.column - left.start.column);
    for (const edit of edits) {
      this.editor.writerController.applyRangeEdit(edit.start, edit.end, edit.text, {
        source: "lsp.completion",
        ensureVisible: false,
      });
    }
    this.completionSession = null;
  }

  getTriggerCharacters(kind) {
    const triggers = new Set();
    for (const session of this.status?.sessions || []) {
      if (session.state !== "ready") continue;
      const capabilities = session.capabilities || {};
      const values = kind === "completion"
        ? capabilities.completionTriggerCharacters
        : capabilities.signatureHelpTriggerCharacters;
      for (const value of values || []) triggers.add(value);
    }
    if (kind === "completion" && triggers.size === 0) triggers.add(".");
    return [...triggers];
  }

  scheduleAutoCompletion(file, triggerCharacter = undefined) {
    clearTimeout(this.autoCompletionTimer);
    this.autoCompletionTimer = setTimeout(() => {
      this.autoCompletionTimer = null;
      if (this.editor.tabManager?.activeFile !== file) return;
      void this.requestCompletion(2, triggerCharacter);
    }, 40);
  }

  scheduleSignatureHelp(file) {
    clearTimeout(this.signatureTimer);
    this.signatureTimer = setTimeout(() => {
      this.signatureTimer = null;
      if (this.editor.tabManager?.activeFile !== file) return;
      if (this.signaturePopover.isVisible) return;
      void this.signatureHelp();
    }, 80);
  }

  async hover() {
    const context = this.getActiveContext();
    if (!context) return null;
    const result = await this.requestHover(context, this.getPosition(context.file));
    if (!result) {
      this.notify("No hover information.", "info");
      return null;
    }
    return result;
  }

  async requestHover(context, position) {
    const { file, record } = context;
    const token = ++this.hoverToken;
    let result = null;
    try {
      result = await this.api.hover({ path: record.path, position });
    } catch {
      return null;
    }
    if (token !== this.hoverToken || this.editor.tabManager?.activeFile !== file) return null;
    if (!result?.success) {
      if (result?.code !== "LSP_NO_PROVIDER") this.notify(result?.error || "Hover failed.", "error");
      return null;
    }
    if (!result.hover?.contents) return null;
    const anchor = this.editor.cD?.getBoundingClientRect?.();
    this.renderHover(result.hover, anchor, token);
    return result.hover;
  }

  renderHover(hover, anchorRect, token = this.hoverToken) {
    const content = document.createElement("div");
    content.className = "lsp-hover-content";
    content.textContent = String(hover.contents || "");
    this.hoverPopover.setContent(content);
    if (anchorRect) this.hoverPopover.showAt(anchorRect.right, anchorRect.bottom, { width: 480, align: "left" });
    void this.upgradeHoverMarkdown(content, hover.contents, token);
  }

  async upgradeHoverMarkdown(container, markdown, token) {
    if (typeof ensureMarkdownBundle !== "function") return;
    try {
      if (!this.markdownLoadPromise) {
        this.markdownLoadPromise = ensureMarkdownBundle().catch(() => {
          this.markdownLoadPromise = null;
          return null;
        });
      }
      await this.markdownLoadPromise;
      if (token !== this.hoverToken || !this.hoverPopover.isVisible) return;
      if (typeof MarkdownRenderer === "undefined") return;
      if (!this.markdownRenderer) this.markdownRenderer = new MarkdownRenderer();
      this.markdownRenderer.render(String(markdown || ""), container, { mode: "strict" });
    } catch {}
  }

  hideHover() {
    this.hoverPopover.hide();
  }

  hideTransientUi() {
    this.hoverPopover.hide();
    this.signaturePopover.hide();
    if (this.completionWidget.isVisible) this.completionWidget.hide();
  }

  async signatureHelp() {
    const context = this.getActiveContext();
    if (!context) return null;
    const result = await this.api.signatureHelp({
      path: context.record.path,
      position: this.getPosition(context.file),
    });
    if (!result?.success) {
      if (result?.code !== "LSP_NO_PROVIDER") this.notify(result?.error || "Signature help failed.", "error");
      return null;
    }
    if (!result.help?.signatures?.length) {
      this.notify("No signature information.", "info");
      return null;
    }
    const content = document.createElement("div");
    content.className = "lsp-signature-content";
    for (const signature of result.help.signatures) {
      const line = document.createElement("div");
      line.className = "lsp-signature-line";
      line.textContent = signature.label;
      content.appendChild(line);
      if (signature.documentation) {
        const documentation = document.createElement("div");
        documentation.className = "lsp-signature-documentation";
        documentation.textContent = signature.documentation;
        content.appendChild(documentation);
      }
    }
    const anchor = this.editor.cD?.getBoundingClientRect?.();
    this.signaturePopover.setContent(content);
    if (anchor) this.signaturePopover.showAt(anchor.right, anchor.bottom, { width: 440 });
    return result.help;
  }

  async definition() { return this.navigateLocations("definition", "Go to Definition"); }
  async declaration() { return this.navigateLocations("declaration", "Go to Declaration"); }
  async implementation() { return this.navigateLocations("implementation", "Go to Implementation"); }
  async typeDefinition() { return this.navigateLocations("typeDefinition", "Go to Type Definition"); }

  async navigateLocations(method, title) {
    const context = this.getActiveContext();
    if (!context) return null;
    let result = null;
    try {
      result = await this.api[method]({
        path: context.record.path,
        position: this.getPosition(context.file),
      });
    } catch (error) {
      console.warn(`[LSP] ${method} failed`, error);
      return null;
    }
    if (!result?.success) {
      if (result?.code !== "LSP_NO_PROVIDER") this.notify(result?.error || `${title} failed.`, "error");
      return null;
    }
    const locations = (result.locations || []).filter((location) => location?.path && location.authorized !== false);
    if (!locations.length) {
      this.notify("No result.", "info");
      return null;
    }
    if (locations.length === 1) {
      void this.navigateTo(locations[0]);
      return locations;
    }
    this.editor.quickPanel?.open({
      id: `lsp-${method}`,
      title,
      placeholder: "Select a location",
      items: locations.map((location, index) => ({
        id: `${method}:${index}`,
        label: this.formatLocationLabel(location),
        description: location.path,
        data: location,
      })),
      onAccept: (item) => {
        const location = item?.data || item;
        if (location?.path) void this.navigateTo(location);
      },
    });
    return locations;
  }

  formatLocationLabel(location) {
    const root = this.editor.fileExplorer?.rootPath || "";
    const relative = location.path?.startsWith(root)
      ? location.path.slice(root.length).replace(/^[\\/]/, "")
      : location.path || location.uri;
    return `${relative}:${location.range.start.line + 1}:${location.range.start.character + 1}`;
  }

  async navigateTo(location) {
    if (!location?.path) {
      this.notify("This target is not a local file.", "error");
      return false;
    }
    if (location.authorized === false) {
      this.notify("This target is outside the workspace and cannot be opened.", "warning");
      return false;
    }
    let file = null;
    try {
      file = await this.editor.tabManager.openFileWithPath(location.path);
    } catch (error) {
      this.notify("Unable to open the target file.", "error");
      return false;
    }
    file = file || this.editor.tabManager.activeFile;
    if (!file || file.path !== location.path && !this.isPathForFile(file, location.path)) {
      this.notify("Unable to open the target file.", "error");
      return false;
    }
    const row = Math.min(Math.max(location.range.start.line + 1, 1), file.lines.length);
    const column = Math.min(location.range.start.character, file.lines[row - 1]?.getText?.().length || 0);
    this.editor.cursorController.setCursorPosition(row, column, { ensureVisible: true });
    const endRow = Math.min(Math.max(location.range.end.line + 1, row), file.lines.length);
    const endColumn = Math.min(location.range.end.character, file.lines[endRow - 1]?.getText?.().length || 0);
    if (endRow !== row || endColumn !== column) {
      this.editor.selectController.setSelection(
        { row, column },
        { row: endRow, column: endColumn },
        { emitEvent: true },
      );
    }
    this.editor.focusOutput?.();
    return true;
  }

  isPathForFile(file, targetPath) {
    if (!file) return false;
    if (file.path === targetPath) return true;
    const record = this.documents.get(file.id);
    return record?.path === targetPath;
  }

  async references() {
    const context = this.getActiveContext();
    if (!context) return null;
    const result = await this.api.references({
      path: context.record.path,
      position: this.getPosition(context.file),
      includeDeclaration: true,
    });
    if (!result?.success) {
      if (result?.code !== "LSP_NO_PROVIDER") this.notify(result?.error || "References failed.", "error");
      return null;
    }
    const locations = (result.groups || [])
      .flatMap((group) => group.locations || [])
      .filter((location) => location?.path && location.authorized !== false);
    const unique = [];
    const seen = new Set();
    for (const location of locations) {
      const key = `${location.path}:${JSON.stringify(location.range)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(location);
    }
    if (!unique.length) {
      this.notify("No references found.", "info");
      return null;
    }
    if (unique.length === 1) {
      void this.navigateTo(unique[0]);
      return unique;
    }
    this.editor.quickPanel?.open({
      id: "lsp-references",
      title: `References (${unique.length})`,
      placeholder: "Select a reference",
      items: unique.map((location, index) => ({
        id: `reference:${index}`,
        label: this.formatLocationLabel(location),
        description: location.path,
        data: location,
      })),
      onAccept: (item) => {
        const location = item?.data || item;
        if (location?.path) void this.navigateTo(location);
      },
    });
    return unique;
  }

  async rename() {
    const context = this.getActiveContext();
    if (!context) return null;
    let preparation = null;
    try {
      const prepared = await this.api.prepareRename({
        path: context.record.path,
        position: this.getPosition(context.file),
      });
      if (prepared?.success) preparation = prepared.preparation;
      else if (prepared?.code !== "LSP_NO_PROVIDER") {
        this.notify(prepared?.error || "Rename is unavailable here.", "error");
        return null;
      }
    } catch {
      return null;
    }
    const line = context.file.lines[context.file.row - 1]?.getText?.() || "";
    const word = LspPositions.wordRangeAt(line, context.file.column);
    const value = await this.quickInput({
      id: "lsp-rename",
      title: "Rename Symbol",
      placeholder: preparation?.placeholder || "New name",
      value: word.text,
    });
    if (!value || !value.trim() || value === word.text) return null;
    const result = await this.api.rename({
      path: context.record.path,
      position: this.getPosition(context.file),
      newName: value.trim(),
    });
    if (!result?.success) {
      this.notify(result?.error || "Rename failed.", "error");
      return null;
    }
    if (result.edit) await this.applyWorkspaceEdit(result.edit);
    return result.edit;
  }

  quickInput({ id, title, placeholder, value }) {
    return new Promise((resolve) => {
      const quickPanel = this.editor.quickPanel;
      if (!quickPanel) {
        resolve("");
        return;
      }
      quickPanel.open({
        id,
        mode: "input",
        title,
        placeholder,
        value,
        onAccept: (input) => resolve(String(input ?? "")),
        onCancel: () => resolve(""),
      });
    });
  }

  getEditorSelection() {
    const selection = this.editor.selectController?.getLogicalSelection?.();
    if (!selection) return null;
    return {
      start: { row: selection.startRow, column: selection.startColumn },
      end: { row: selection.endRow, column: selection.endColumn },
    };
  }

  async codeActions() {
    const context = this.getActiveContext();
    if (!context) return null;
    const { file, record } = context;
    const selection = this.getEditorSelection();
    const range = selection
      ? LspPositions.range(selection.start, selection.end)
      : (() => {
          const position = this.getPosition(file);
          return { start: position, end: position };
        })();
    const lineDiagnostics = (this.diagnosticsByPath.get(record.path) || [])
      .filter((diagnostic) =>
        diagnostic.range.start.line + 1 <= file.row && diagnostic.range.end.line + 1 >= file.row)
      .map((diagnostic) => ({
        range: diagnostic.range,
        message: diagnostic.message,
        severity: diagnostic.severity,
        source: diagnostic.source,
        code: diagnostic.code,
      }));
    const result = await this.api.codeActions({
      path: record.path,
      range,
      context: { diagnostics: lineDiagnostics },
    });
    if (!result?.success) {
      if (result?.code !== "LSP_NO_PROVIDER") this.notify(result?.error || "Code actions failed.", "error");
      return null;
    }
    const actions = result.actions || [];
    if (!actions.length) {
      this.notify("No code actions available.", "info");
      return null;
    }
    this.editor.quickPanel?.open({
      id: "lsp-code-actions",
      title: "Code Actions",
      placeholder: "Select a code action",
      items: actions.map((action) => ({
        id: action.id,
        label: action.title,
        description: action.source,
        detail: action.kind || "",
        data: action,
      })),
      onAccept: (item) => {
        const action = item?.data || item;
        if (action) void this.applyCodeAction(action);
      },
    });
    return actions;
  }

  async applyCodeAction(action) {
    let resolved = action;
    if (!resolved.edit && resolved.command) {
      const result = await this.api.resolveCodeAction({ id: resolved.id });
      if (result?.success) resolved = result.action;
    }
    if (resolved.edit) {
      await this.applyWorkspaceEdit(resolved.edit);
      return;
    }
    if (resolved.command) {
      const executed = await this.api.executeCodeAction({ id: resolved.id });
      if (!executed?.success) {
        this.notify(executed?.error || "The code action failed.", "error");
        return;
      }
      if (executed.edit) await this.applyWorkspaceEdit(executed.edit);
      return;
    }
    this.notify("This code action has no supported effect.", "warning");
  }

  async formatDocument() {
    const context = this.getActiveContext();
    if (!context) return null;
    const selection = this.getEditorSelection();
    const range = selection ? LspPositions.range(selection.start, selection.end) : undefined;
    const result = await this.api.format({ path: context.record.path, ...(range ? { range } : {}) });
    if (!result?.success) {
      if (result?.code !== "LSP_NO_PROVIDER") this.notify(result?.error || "Formatting failed.", "error");
      return null;
    }
    if (!result.edit) {
      this.notify("The document is already formatted.", "info");
      return null;
    }
    await this.applyWorkspaceEdit(result.edit);
    return result.edit;
  }

  async documentSymbols() {
    const context = this.getActiveContext();
    if (!context) return null;
    const result = await this.api.documentSymbols({ path: context.record.path });
    if (!result?.success) {
      if (result?.code !== "LSP_NO_PROVIDER") this.notify(result?.error || "Symbols failed.", "error");
      return null;
    }
    const symbols = result.symbols || [];
    if (!symbols.length) {
      this.notify("No symbols found.", "info");
      return null;
    }
    this.editor.quickPanel?.open({
      id: "lsp-document-symbols",
      title: "Document Symbols",
      placeholder: "Select a symbol",
      items: symbols.map((symbol, index) => ({
        id: `symbol:${index}`,
        label: symbol.name,
        description: symbol.detail || "",
        detail: symbol.source || "",
        data: symbol,
      })),
      onAccept: (item) => {
        const symbol = item?.data || item;
        if (symbol?.selectionRange) {
          void this.navigateTo({
            path: context.record.path,
            range: symbol.selectionRange,
            authorized: true,
          });
        }
      },
    });
    return symbols;
  }

  async workspaceSymbols() {
    const context = this.getActiveContext();
    if (!context) return null;
    const query = await this.quickInput({
      id: "lsp-workspace-symbols-query",
      title: "Workspace Symbols",
      placeholder: "Search symbols",
      value: "",
    });
    if (query === null || query === undefined) return null;
    const result = await this.api.workspaceSymbols({ path: context.record.path, query });
    if (!result?.success) {
      if (result?.code !== "LSP_NO_PROVIDER") this.notify(result?.error || "Workspace symbols failed.", "error");
      return null;
    }
    const symbols = (result.symbols || []).filter((symbol) => symbol?.location?.path);
    if (!symbols.length) {
      this.notify("No workspace symbols found.", "info");
      return null;
    }
    this.editor.quickPanel?.open({
      id: "lsp-workspace-symbols",
      title: "Workspace Symbols",
      placeholder: "Select a symbol",
      items: symbols.map((symbol, index) => ({
        id: `workspace-symbol:${index}`,
        label: symbol.name,
        description: symbol.location.path,
        detail: symbol.containerName || symbol.source || "",
        data: symbol,
      })),
      onAccept: (item) => {
        const symbol = item?.data || item;
        if (symbol?.location?.path) void this.navigateTo(symbol.location);
      },
    });
    return symbols;
  }

  showProblems() {
    return this.editor.bottomPanelManager?.openPanel?.("problems") || false;
  }

  applyWorkspaceEdit(edit) {
    const run = this.editQueue
      .catch(() => false)
      .then(() => this.applyWorkspaceEditNow(edit));
    this.editQueue = run.catch(() => false);
    return run;
  }

  async handleApplyEditRequest(payload) {
    if (!payload || typeof payload.id !== "string") return;
    let applied = false;
    let failureReason = "The editor rejected the workspace edit.";
    try {
      applied = await this.applyWorkspaceEdit(payload.edit);
    } catch (error) {
      failureReason = String(error && error.message || error);
    }
    try {
      await this.api.applyEditResult({
        id: payload.id,
        applied,
        ...(applied ? {} : { failureReason }),
      });
    } catch {}
  }

  async applyResourceOperations(edit) {
    const resources = Array.isArray(edit?.resources) ? edit.resources : [];
    for (const resource of resources) {
      if (!resource || typeof resource.path !== "string") return false;
      if (resource.kind === "create") {
        const result = await this.editor.api.createFile(
          NCEPath.dirname(resource.path),
          NCEPath.basename(resource.path),
          "",
          resource.options?.overwrite === true,
        );
        if (!result?.success) {
          if (resource.options?.ignoreIfExists === true &&
              result?.code === "FILE_ALREADY_EXISTS") continue;
          this.notify(result?.error || "The language server could not create a file.", "error");
          return false;
        }
        continue;
      }
      if (resource.kind === "rename") {
        if (typeof resource.oldPath !== "string") return false;
        const result = await this.editor.api.renameEntry(resource.oldPath, resource.path);
        if (!result?.success) {
          if (resource.options?.ignoreIfExists === true &&
              result?.code === "TARGET_EXISTS") continue;
          this.notify(result?.error || "The language server could not rename a file.", "error");
          return false;
        }
        await this.editor.tabManager?.updateFilePath?.(resource.oldPath, resource.path);
        continue;
      }
      if (resource.kind === "delete") {
        const result = await this.editor.api.moveToTrash(resource.path);
        if (!result?.success) {
          this.notify(result?.error || "The language server could not delete a file.", "error");
          return false;
        }
        this.editor.tabManager?.markFileAsDeleted?.(resource.path);
        continue;
      }
      return false;
    }
    return true;
  }

  async applyWorkspaceEditNow(edit) {
    const files = Array.isArray(edit?.files) ? edit.files : [];
    const resources = Array.isArray(edit?.resources) ? edit.resources : [];
    if (!files.length && !resources.length) return false;
    const originalActive = this.editor.tabManager?.activeFile || null;
    try {
      if (!(await this.applyResourceOperations(edit))) return false;
      for (const fileEdit of files) {
        if (!fileEdit || !Array.isArray(fileEdit.edits) || !fileEdit.edits.length) continue;
        let file = this.findOpenFileForEdit(fileEdit.path);
        if (!file) {
          file = await this.editor.tabManager.openFileWithPath(fileEdit.path);
        }
        if (!file) {
          this.notify(`Unable to open ${fileEdit.path} for editing.`, "error");
          return false;
        }
        if (this.editor.tabManager.activeFile !== file) await this.editor.tabManager.setFocusTab(file);
        if (this.editor.tabManager.activeFile !== file) {
          this.notify(`Unable to focus ${fileEdit.path} for editing.`, "error");
          return false;
        }
        await this.editor.fileLoader?.waitForFileLoaded?.(file);
        const edits = [...fileEdit.edits].sort((left, right) =>
          right.range.start.line - left.range.start.line ||
          right.range.start.character - left.range.start.character);
        for (const change of edits) {
          const range = LspPositions.editorRange(change.range, file.lines.length);
          if (!range) continue;
          const startLine = file.lines[range.start.row - 1]?.getText?.() || "";
          const endLine = file.lines[range.end.row - 1]?.getText?.() || "";
          range.start.column = Math.min(range.start.column, startLine.length);
          range.end.column = Math.min(range.end.column, endLine.length);
          if (this.rangeText(file, range) === (change.newText ?? "").replace(/\r\n/g, "\n")) continue;
          const applied = this.editor.writerController.applyRangeEdit(
            range.start,
            range.end,
            change.newText ?? "",
            { source: "lsp.edit", ensureVisible: false },
          );
          if (!applied) {
            this.notify("A language server edit could not be applied.", "error");
            return false;
          }
        }
      }
      if (originalActive && this.editor.tabManager.tabs.includes(originalActive) &&
          this.editor.tabManager.activeFile !== originalActive) {
        await this.editor.tabManager.setFocusTab(originalActive);
      }
      return true;
    } catch (error) {
      console.warn("[LSP] Workspace edit failed", error);
      this.notify("A language server edit could not be applied.", "error");
      return false;
    }
  }

  rangeText(file, range) {
    const lines = file.lines
      .slice(range.start.row - 1, range.end.row)
      .map((line) => line?.getText?.() ?? "");
    if (lines.length === 1)
      return lines[0].slice(range.start.column, range.end.column);
    lines[0] = lines[0].slice(range.start.column);
    lines[lines.length - 1] = lines[lines.length - 1].slice(0, range.end.column);
    return lines.join("\n");
  }

  findOpenFileForEdit(path) {
    if (!path) return null;
    for (const file of this.editor.tabManager?.files || []) {
      if (!file?.path) continue;
      if (file.path === path) return file;
      const record = this.documents.get(file.id);
      if (record?.path === path) return file;
    }
    return null;
  }

  notify(message, level = "info") {
    if (!message || typeof document === "undefined" || !this.editor.mainSection) return;
    const notice = document.createElement("div");
    notice.className = `lsp-notice lsp-notice-${level}`;
    notice.setAttribute("role", "status");
    notice.textContent = message;
    this.editor.mainSection.appendChild(notice);
    const remove = () => notice.remove();
    setTimeout(remove, level === "error" ? 6000 : 3500);
  }
}
