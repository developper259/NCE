class HighlightController {
  constructor(editor) {
    this.editor = editor;
    this.nshClient = new NSHClient(editor);
    this.nshClient.onSessionReset = () => this.handleSessionReset();
    this.documentModes = new Map();
    this.documentEpochs = new Map();
    this.documentRevisions = new Map();
    this.nextDocumentId = 0;
    this.documentQueues = new Map();
    this.documentIds = new Map();
    this.rangeRequests = new Map();
    this.lastLoadedRanges = new Map();
    this.rangeFailures = new Map();
    this.incrementalMaxFileSize = 1024 * 1024;
    this.incrementalMaxLineLength = 1000;

    this.lineNodes = new Map();
    this.dirtyLines = new Set();
    this.isProcessingDirty = false;

    this.maxLength = 1000;
    this.marginHighlight = 100;

    this.supportedLanguage = null;
  }

  getId() {
    return Date.now().toString() + Math.random().toString(36).substring(2, 9);
  }

  async highlight(text, language, includeClasses = true) {
    try {
      const response = await this.nshClient.request("highlight", {
        requestType: "highlight",
        code: text,
        language: language,
        responseType: "tokens",
        options: {
          theme: "dark",
          lineNumbers: false,
          language: language,
          includeClasses: includeClasses,
        },
      });

      if (response && response.tokens) {
        return response.tokens;
      }
      return [];
    } catch (error) {
      console.error("Erreur lors de la coloration syntaxique :", error);
      return [];
    }
  }

  async getSupportedLanguage() {
    if (this.supportedLanguage) return this.supportedLanguage;

    try {
      const response = await this.nshClient.request("supportedLanguages", {
        id: this.getId(),
        requestType: "supportedLanguages",
      });

      if (response && response.languages) {
        this.supportedLanguage = response.languages;
        return this.supportedLanguage;
      }
      return [];
    } catch (error) {
      console.error(
        "Erreur lors de la récupération des langages supportés :",
        error,
      );
      return [];
    }
  }

  async detectLanguage(fileName) {
    try {
      const response = await this.nshClient.request("detectLanguage", {
        fileName: fileName,
      });

      return response?.language?.toLowerCase() || "plaintext";
    } catch (error) {
      console.error("Erreur lors de la détection du langage :", error);
      return "plaintext";
    }
  }

  getDocumentId(file) {
    if (!this.documentIds.has(file.id)) {
      this.documentIds.set(
        file.id,
        `nce-document-${file.id}-${++this.nextDocumentId}`,
      );
    }
    return this.documentIds.get(file.id);
  }

  getLogicalText(file) {
    return file.lines.map((line) => line.getText()).join("\n");
  }

  canUseIncremental(file) {
    if (
      !file ||
      file.incrementalEligible !== true ||
      !file.language ||
      file.language === "plaintext"
    )
      return false;
    if (file.loadingState && file.loadingState.status !== "loaded")
      return false;
    const metrics = file.getSyntaxMetrics();
    return (
      metrics.logicalLength <= this.incrementalMaxFileSize &&
      metrics.longLineCount === 0
    );
  }

  async openFile(file) {
    if (this.documentModes.has(file.id)) return;
    if (!this.canUseIncremental(file)) {
      this.documentModes.set(file.id, "line");
      this.reset();
      return;
    }

    const documentId = this.getDocumentId(file);
    const epoch = this.documentEpochs.get(file.id);
    this.documentModes.set(file.id, "incremental");
    try {
      await this.queueDocumentRequest(file, async () => {
        await this.nshClient.request("openDocument", {
          documentId,
          language: file.language,
          code: this.getLogicalText(file),
        });
        if (this.documentEpochs.get(file.id) !== epoch) return;
        const range = this.getVisibleDocumentRange(file);
        if (range)
          await this.loadDocumentLines(file, range.startLine, range.endLine);
      });
    } catch (error) {
      if (this.documentEpochs.get(file.id) !== epoch) return;
      console.error("[NSH] Incremental document unavailable", error);
      this.documentModes.set(file.id, "line");
      this.reset();
    }
  }

  async changeLanguage(file, language) {
    await this.invalidateFile(file);
    file.language = String(language || "plaintext").toLowerCase();
    if (file === this.editor.tabManager.activeFile) {
      await this.openFile(file);
      this.editor.lineController.refresh(true);
    }
  }

  async recoverDocumentHighlight(file, reason) {
    if (!file) return;
    const epoch = this.documentEpochs.get(file.id);
    if (this.documentModes.get(file.id) !== "incremental") return;

    console.warn("[NSH] Recovering document highlighting", {
      event: "document_highlight_recovery",
      fileId: file.id,
      reason: reason?.message || String(reason || "unknown"),
    });

    await this.invalidateFile(file);
    if (this.documentEpochs.get(file.id) === epoch) return;

    try {
      await this.openFile(file);
      if (file === this.editor.tabManager.activeFile) {
        this.editor.lineController.refresh(true);
      }
    } catch (error) {
      console.error("[NSH] Document highlighting recovery failed", error);
      this.documentModes.set(file.id, "line");
      this.reset();
    }
  }

  invalidateFile(file) {
    const closing = this.closeFile(file);
    for (const line of file.lines) {
      line.clearTokens();
      line.setState(null);
    }
    return closing;
  }

  handleSessionReset() {
    for (const file of this.editor.tabManager.files || []) {
      this.documentEpochs.set(
        file.id,
        (this.documentEpochs.get(file.id) || 0) + 1,
      );
      this.bumpDocumentRevision(file);
      for (const line of file.lines) {
        line.clearTokens();
        line.setState(null);
      }
    }
    this.documentModes.clear();
    this.documentIds.clear();
    this.documentQueues.clear();
    this.rangeRequests.clear();
    this.lastLoadedRanges.clear();
    this.rangeFailures.clear();
    const activeFile = this.editor.tabManager.activeFile;
    if (activeFile) this.openFile(activeFile);
  }

  async loadDocumentLines(file, startLine, endLine) {
    if (startLine < 0 || endLine <= startLine || endLine > file.lines.length)
      return;
    const epoch = this.documentEpochs.get(file.id);
    const revision = this.documentRevisions.get(file.id) || 0;
    const response = await this.nshClient.request("getDocumentLines", {
      documentId: this.getDocumentId(file),
      startLine,
      endLine,
    });
    if (
      this.documentEpochs.get(file.id) === epoch &&
      (this.documentRevisions.get(file.id) || 0) === revision
    )
      this.applyCachedLines(file, response.lines || [], startLine);
    return this.documentEpochs.get(file.id) === epoch &&
      (this.documentRevisions.get(file.id) || 0) === revision;
  }

  bumpDocumentRevision(file) {
    const revision = (this.documentRevisions.get(file.id) || 0) + 1;
    this.documentRevisions.set(file.id, revision);
    this.lastLoadedRanges.delete(file.id);
    this.rangeRequests.delete(file.id);
    return revision;
  }

  async syncDocumentFromEditor(file, previousText) {
    if (this.documentModes.get(file.id) !== "incremental") return;
    if (!this.canUseIncremental(file)) {
      await this.closeFile(file);
      this.documentModes.set(file.id, "line");
      this.reset();
      return;
    }
    const revision = this.bumpDocumentRevision(file);
    const currentLines = file.lines.map((line) => line.getText());
    const previousLines = typeof previousText === "string"
      ? previousText.replace(/\r\n?/g, "\n").split("\n")
      : null;
    let startLine = 0;
    let previousEnd = previousLines?.length ?? previousText;
    let currentEnd = currentLines.length;
    if (previousLines) {
      while (
        startLine < previousEnd && startLine < currentEnd &&
        previousLines[startLine] === currentLines[startLine]
      ) startLine++;
      while (
        previousEnd > startLine && currentEnd > startLine &&
        previousLines[previousEnd - 1] === currentLines[currentEnd - 1]
      ) {
        previousEnd--;
        currentEnd--;
      }
    }
    const insertedLines = currentLines.slice(startLine, currentEnd);
    const deletedLines = previousEnd - startLine;
    if (deletedLines === 0 && insertedLines.length === 0) return;
    const epoch = this.documentEpochs.get(file.id);
    try {
      await this.queueDocumentRequest(file, async () => {
        const response = await this.nshClient.request("updateDocument", {
          documentId: this.getDocumentId(file),
          startLine,
          deletedLines,
          insertedLines,
        });
        if (
          this.documentEpochs.get(file.id) === epoch &&
          this.documentRevisions.get(file.id) === revision
        ) this.applyCachedLines(file, response.lines || [], response.changedStartLine || 0);
      });
    } catch (error) {
      if (this.documentEpochs.get(file.id) !== epoch) return;
      await this.recoverDocumentHighlight(file, error);
    }
  }

  loadVisibleDocumentLines(file) {
    const range = this.getVisibleDocumentRange(file);
    if (!range) return Promise.resolve();
    const requestEpoch = this.documentEpochs.get(file.id);
    const requestRevision = this.documentRevisions.get(file.id) || 0;
    const rangeKey = `${requestEpoch}:${requestRevision}:${range.startLine}:${range.endLine}`;
    if (this.lastLoadedRanges.get(file.id) === rangeKey)
      return Promise.resolve();

    const pending = this.rangeRequests.get(file.id);
    if (pending?.rangeKey === rangeKey) return pending.promise;

    const promise = this.queueDocumentRequest(file, async () => {
      if ((this.documentRevisions.get(file.id) || 0) !== requestRevision) return;
      const currentRange = this.getVisibleDocumentRange(file);
      if (!currentRange) return;
      const currentKey = `${requestEpoch}:${requestRevision}:${currentRange.startLine}:${currentRange.endLine}`;
      const failureKey = `${file.id}:${currentKey}`;
      if (this.rangeFailures.has(failureKey)) return;

      try {
        await this.loadDocumentLines(
          file,
          currentRange.startLine,
          currentRange.endLine,
        );
        if (
          this.documentEpochs.get(file.id) !== requestEpoch ||
          (this.documentRevisions.get(file.id) || 0) !== requestRevision
        ) return;
        this.lastLoadedRanges.set(file.id, currentKey);
        this.rangeFailures.delete(failureKey);
      } catch (error) {
        if (
          this.documentEpochs.get(file.id) !== requestEpoch ||
          (this.documentRevisions.get(file.id) || 0) !== requestRevision
        ) {
          console.debug("[NCE NSH stale range]", {
            fileId: file.id, requestEpoch, currentEpoch: this.documentEpochs.get(file.id),
            requestRevision, currentRevision: this.documentRevisions.get(file.id) || 0,
            requestedRange: currentRange,
          });
          return;
        }
        if (!this.isRangeError(error)) throw error;
        this.rangeFailures.set(failureKey, true);
        return { recover: error };
      }
    }).then(async (result) => {
      if (result?.recover) await this.recoverDocumentHighlight(file, result.recover);
    }).finally(() => {
      if (this.rangeRequests.get(file.id)?.promise === promise) {
        this.rangeRequests.delete(file.id);
      }
    });
    this.rangeRequests.set(file.id, { rangeKey, promise });
    return promise;
  }

  getVisibleDocumentRange(file) {
    const lineCount = file?.lines?.length || 0;
    if (lineCount === 0) return null;

    const lineController = this.editor.lineController;
    const displayLineCount =
      typeof lineController.getDisplayLineCount === "function"
        ? lineController.getDisplayLineCount()
        : lineCount;
    const displayStart = Number.isFinite(lineController.startIndex)
      ? Math.max(
          0,
          Math.min(
            Math.floor(lineController.startIndex),
            Math.max(0, displayLineCount - 1),
          ),
        )
      : 0;
    const visibleLines = Math.max(1, lineController.maxViewLines || 1);
    const displayEnd = Math.min(
      displayLineCount,
      displayStart + visibleLines + this.marginHighlight,
    );
    const documentIndexes = [];
    for (
      let displayIndex = displayStart;
      displayIndex < displayEnd;
      displayIndex++
    ) {
      const row =
        typeof lineController.getDisplayRow === "function"
          ? lineController.getDisplayRow(displayIndex)
          : { documentIndex: displayIndex };
      if (
        Number.isInteger(row?.documentIndex) &&
        row.documentIndex >= 0 &&
        row.documentIndex < lineCount
      ) {
        documentIndexes.push(row.documentIndex);
      }
    }
    if (documentIndexes.length === 0) return null;
    const startLine = Math.min(...documentIndexes);
    const endLine = Math.min(
      lineCount,
      Math.max(...documentIndexes) + this.marginHighlight + 1,
    );
    if (lineController.startIndex !== displayStart) {
      lineController.startIndex = displayStart;
      this.editor.lineController.offsetY = 0;
    }
    if (endLine <= startLine) return null;
    return { startLine, endLine };
  }

  isRangeError(error) {
    return /line range is outside the document/i.test(error?.message || error);
  }

  applyCachedLines(file, cachedLines, startLine = 0) {
    for (const [offset, cached] of cachedLines.entries()) {
      const lineIndex = Number.isInteger(cached.tokens?.[0]?.line)
        ? cached.tokens[0].line - 1
        : startLine + offset;
      const line = file.lines[lineIndex];
      if (!line || line.getText() !== cached.text) continue;
      line.setTokens(cached.tokens || []);
      line.setState(cached.stateAfter || null);
      line.setHighlighted(true);
      if (file === this.editor.tabManager.activeFile) {
        this.applyHighlightToLine(lineIndex, cached.tokens || []);
      }
    }
  }

  queueDocumentRequest(file, task) {
    const previous = this.documentQueues.get(file.id) || Promise.resolve();
    const epoch = this.documentEpochs.get(file.id);
    const next = previous
      .catch(() => {})
      .then(() => {
        if (this.documentEpochs.get(file.id) === epoch) return task();
      });
    this.documentQueues.set(file.id, next);
    return next.finally(() => {
      if (this.documentQueues.get(file.id) === next)
        this.documentQueues.delete(file.id);
    });
  }

  handleChange(change) {
    const file = this.editor.tabManager.activeFile;
    const update = change?.nshUpdate;
    if (!file || this.documentModes.get(file.id) !== "incremental" || !update)
      return;

    if (!this.canUseIncremental(file)) {
      this.closeFile(file);
      this.documentModes.set(file.id, "line");
      this.reset();
      return;
    }

    for (const key of this.rangeFailures.keys()) {
      if (key.startsWith(`${file.id}:`)) this.rangeFailures.delete(key);
    }
    const revision = this.bumpDocumentRevision(file);
    const epoch = this.documentEpochs.get(file.id);
    this.queueDocumentRequest(file, async () => {
      const response = await this.nshClient.request("updateDocument", {
        documentId: this.getDocumentId(file),
        ...update,
      });
      if (
        this.documentEpochs.get(file.id) !== epoch ||
        this.documentRevisions.get(file.id) !== revision
      ) return;
      this.applyCachedLines(
        file,
        response.lines || [],
        response.changedStartLine || update.startLine,
      );
    }).catch((error) => {
      console.error("[NSH] Document update failed", error);
      return this.recoverDocumentHighlight(file, error);
    });
  }

  closeFile(file) {
    const documentId = this.documentIds.get(file.id);
    const previous = this.documentQueues.get(file.id) || Promise.resolve();
    this.documentEpochs.set(
      file.id,
      (this.documentEpochs.get(file.id) || 0) + 1,
    );
    this.bumpDocumentRevision(file);
    this.documentModes.delete(file.id);
    this.documentIds.delete(file.id);
    this.documentQueues.delete(file.id);
    this.rangeRequests.delete(file.id);
    this.lastLoadedRanges.delete(file.id);
    for (const key of this.rangeFailures.keys()) {
      if (key.startsWith(`${file.id}:`)) this.rangeFailures.delete(key);
    }
    return previous
      .catch(() => {})
      .then(() => {
        if (documentId)
          return this.nshClient
            .request("closeDocument", { documentId })
            .catch(() => {});
      });
  }

  closeAllFiles() {
    for (const fileId of [...this.documentModes.keys()])
      this.closeFile({ id: fileId });
  }

  splitValidWord(tokenValue) {
    return this.editor.writerController
      .splitWord(tokenValue || "")
      .filter((w) => w && w !== " " && w !== "\t");
  }

  refreshLineNode() {
    this.lineNodes.clear();
    this.editor.output.childNodes.forEach((node) => {
      const lineNumber = parseInt(node.dataset.line, 10);
      if (Number.isInteger(lineNumber) && lineNumber >= 0) {
        this.lineNodes.set(lineNumber, node);
      }
    });
  }

  setLineNode(documentIndex, node) {
    if (!Number.isInteger(documentIndex) || documentIndex < 0 || !node) return;
    this.lineNodes.set(documentIndex, node);
  }

  getLineNode(documentIndex) {
    if (!Number.isInteger(documentIndex) || documentIndex < 0) return null;
    return this.lineNodes.get(documentIndex) || null;
  }

  markDirty(lineNumber) {
    if (
      !Number.isInteger(lineNumber) ||
      lineNumber < 0 ||
      lineNumber >= this.editor.lineController.lines.length ||
      this.dirtyLines.has(lineNumber)
    )
      return;
    this.dirtyLines.add(lineNumber);
  }

  markDirtyAll(onlyUnHighlight = false) {
    if (
      !this.editor.lineController.lines ||
      this.editor.lineController.lines.length === 0
    )
      return;
    if (onlyUnHighlight) {
      let l = 0;
      for (const node of this.lineNodes.values()) {
        l = parseInt(node.dataset.line, 10);
        const lineNode = this.editor.lineController.lines[l];
        if (!lineNode || !lineNode.isHighlight) this.markDirty(l);
      }
      for (let i = 1; i < this.marginHighlight + 1; i++) {
        const lineNode = this.editor.lineController.lines[l + i];
        if (
          !lineNode ||
          (!lineNode.getTokens() &&
            this.editor.lineController.getLineLength(l + 1) > 0)
        )
          this.markDirty(l + i);
      }
    } else {
      const lines = this.editor.lineController.lines;
      for (let index = 0; index < lines.length; index++) {
        const lineNode = lines[index];
        lineNode.setState(null);
        this.dirtyLines.add(index);
      }
    }
  }

  getInitialState(lineNumber) {
    const prevLineNode = this.editor.lineController.lines[lineNumber - 1];
    return (prevLineNode && prevLineNode.getState()) || ["root"];
  }

  statesEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  propagateState(lineNumber, finalState) {
    const lineNode = this.editor.lineController.lines[lineNumber];
    if (!lineNode) return;

    const previousState = lineNode.getState();
    lineNode.setState(finalState);

    const nextLineExists =
      lineNumber + 1 < this.editor.lineController.lines.length;

    if (nextLineExists && !this.statesEqual(previousState, finalState)) {
      this.markDirty(lineNumber + 1);
    }
  }

  markDirtyFrom(dataIndex) {
    if (
      !this.editor.lineController.lines ||
      this.editor.lineController.lines.length === 0
    )
      return;

    const start = Math.max(dataIndex, this.editor.lineController.startIndex);
    let end = Math.min(
      this.editor.lineController.lines.length,
      this.editor.lineController.startIndex +
        this.editor.lineController.maxViewLines,
    );

    end = Math.min(
      this.editor.lineController.lines.length,
      end + this.marginHighlight,
    );

    for (let i = 0; i < this.marginHighlight; i++) {
      const lineNode = this.editor.lineController.lines[end + i];
      if (
        !lineNode ||
        (!lineNode.getTokens() &&
          this.editor.lineController.getLineLength(end + i + 1) > 0)
      )
        this.dirtyLines.add(end + i);
    }
  }

  reset() {
    const lines = this.editor.lineController.lines;
    this.dirtyLines.clear();

    for (const line of lines) {
      line.clearTokens();
      line.setState(null);
    }

    this.markDirtyAll(false);
    this.editor.lineController.refresh(true);
    this.refresh();
  }

  async refresh() {
    if (this.isProcessingDirty) return;

    const language = this.editor.tabManager.activeFile?.language || "plaintext";
    if (language === "plaintext") {
      return;
    }

    const activeFile = this.editor.tabManager.activeFile;
    if (activeFile && this.documentModes.get(activeFile.id) === "incremental") {
      this.loadVisibleDocumentLines(activeFile).catch((error) =>
        console.error("[NSH] Visible document range failed", error),
      );
      return;
    }

    if (this.dirtyLines.size === 0) return;

    this.isProcessingDirty = true;

    try {
      const linesToProcess = [...this.dirtyLines].sort((a, b) => a - b);
      this.dirtyLines.clear();

      for (const lineNumber of linesToProcess) {
        const lineNode = this.editor.lineController.lines[lineNumber];
        const lineText = lineNode ? lineNode.getText() : "";
        const initialState = this.getInitialState(lineNumber);

        if (lineText === undefined || lineText === null) {
          continue;
        }

        if (lineText.trim() === "") {
          this.propagateState(lineNumber, initialState);
          continue;
        }

        if (lineText.length >= this.maxLength) {
          this.propagateState(lineNumber, lineNode.getState() || initialState);
          continue;
        }

        const renderNode = this.getLineNode(lineNumber);
        const renderGeneration = renderNode?.dataset?.renderGeneration;
        try {
          const result = await this.nshClient.request("highlightLine", {
            requestType: "highlightLine",
            code: lineText,
            language: language,
            initialState: initialState,
            lineIndex: lineNumber,
            responseType: "tokens",
            options: {
              theme: "dark",
              lineNumbers: false,
              language: language,
              includeClasses: true,
            },
          });

          if (
            activeFile !== this.editor.tabManager.activeFile ||
            activeFile.language !== language ||
            activeFile.lines[lineNumber] !== lineNode ||
            lineNode.getText() !== lineText
          )
            continue;
          if (result && result.tokens) {
            lineNode.setTokens(result.tokens);
            lineNode.setHighlighted(true);

            this.applyHighlightToLine(
              lineNumber,
              result.tokens,
              renderNode,
              renderGeneration,
            );
            this.dirtyLines.delete(lineNumber);
          }

          this.propagateState(
            lineNumber,
            (result && result.finalState) || initialState,
          );
        } catch (error) {
          console.error(
            `Erreur lors du highlight de la ligne ${lineNumber} :`,
            error,
          );
          this.propagateState(lineNumber, initialState);
        }
      }
    } catch (error) {
      console.error("Erreur lors du refresh :", error);
    } finally {
      this.isProcessingDirty = false;
      if (this.dirtyLines.size > 0) {
        this.refresh();
      }
    }
  }

  applyHighlightToLine(
    lineNumber,
    tokens,
    expectedNode = null,
    expectedGeneration = null,
  ) {
    const lineNode = this.getLineNode(lineNumber);

    if (!lineNode) return;
    if (expectedNode && lineNode !== expectedNode) return;
    if (
      expectedGeneration !== null &&
      lineNode.dataset?.renderGeneration !== expectedGeneration
    )
      return;

    const documentLine = this.editor.lineController.lines[lineNumber];
    const text = documentLine?.getText();

    if (!text) return;
    if (
      lineNode.dataset?.line !== undefined &&
      parseInt(lineNode.dataset.line, 10) !== lineNumber
    )
      return;
    if (lineNode.isConnected === false) return;

    // Highlighting is asynchronous, so it must use the same horizontal
    // projection as the line renderer at the time the response is applied.
    const slicedLine = this.editor.lineController.getSlicedLine(text);
    const visibleTokens = this.editor.lineController.getVisibleTokens(
      tokens,
      slicedLine,
    );
    const visibleDiffSegments = this.editor.lineController.getVisibleDiffSegments?.(
      documentLine?.diffSegments,
      slicedLine,
    );
    const fragment = this.editor.writerController.textToOBJ(
      slicedLine.text,
      visibleTokens,
      visibleDiffSegments,
    );

    try {
      lineNode.replaceChildren(fragment);
    } catch (error) {
      console.warn("[NCE Highlight] stale DOM mapping skipped", {
        event: "stale_dom_mapping_skipped",
        documentIndex: lineNumber,
        error,
      });
      this.markDirty(lineNumber);
      return false;
    }
    return true;
  }
}
