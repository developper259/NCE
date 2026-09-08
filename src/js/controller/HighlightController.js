class HighlightController {
  constructor(editor) {
    this.editor = editor;
    this.nshClient = new NSHClient(editor);
    this.nshClient.onSessionReset = () => this.handleSessionReset();
    this.documentModes = new Map();
    this.documentEpochs = new Map();
    this.nextDocumentId = 0;
    this.documentQueues = new Map();
    this.documentIds = new Map();
    this.rangeRequests = new Map();
    this.lastLoadedRanges = new Map();
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
      this.documentIds.set(file.id, `nce-document-${file.id}-${++this.nextDocumentId}`);
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
    if (file.loadingState && file.loadingState.status !== "loaded") return false;
    const metrics = file.getSyntaxMetrics();
    return metrics.logicalLength <= this.incrementalMaxFileSize && metrics.longLineCount === 0;
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
      await this.nshClient.request("openDocument", {
        documentId,
        language: file.language,
        code: this.getLogicalText(file),
      });
      if (this.documentEpochs.get(file.id) !== epoch) return;
      const startLine = Math.max(0, file.startIndex || 0);
      const visibleLines = Math.max(
        1,
        this.editor.lineController.maxViewLines || 1,
      );
      const endLine = Math.min(
        file.lines.length,
        startLine + visibleLines + this.marginHighlight,
      );
      await this.loadDocumentLines(file, startLine, endLine);
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

  invalidateFile(file) {
    const closing = this.closeFile(file);
    for (const line of file.lines) { line.clearTokens(); line.setState(null); }
    return closing;
  }

  handleSessionReset() {
    for (const file of this.editor.tabManager.files || []) {
      this.documentEpochs.set(file.id, (this.documentEpochs.get(file.id) || 0) + 1);
      for (const line of file.lines) { line.clearTokens(); line.setState(null); }
    }
    this.documentModes.clear();
    this.documentIds.clear();
    this.documentQueues.clear();
    this.rangeRequests.clear();
    this.lastLoadedRanges.clear();
    const activeFile = this.editor.tabManager.activeFile;
    if (activeFile) this.openFile(activeFile);
  }

  async loadDocumentLines(file, startLine, endLine) {
    const epoch = this.documentEpochs.get(file.id);
    const response = await this.nshClient.request("getDocumentLines", {
      documentId: this.getDocumentId(file),
      startLine,
      endLine,
    });
    if (this.documentEpochs.get(file.id) === epoch) this.applyCachedLines(file, response.lines || [], startLine);
  }

  loadVisibleDocumentLines(file) {
    const startLine = Math.max(0, this.editor.lineController.startIndex || 0);
    const visibleLines = Math.max(
      1,
      this.editor.lineController.maxViewLines || 1,
    );
    const endLine = Math.min(
      file.lines.length,
      startLine + visibleLines + this.marginHighlight,
    );
    const rangeKey = `${startLine}:${endLine}`;
    if (this.lastLoadedRanges.get(file.id) === rangeKey)
      return Promise.resolve();

    const pending = this.rangeRequests.get(file.id);
    if (pending?.rangeKey === rangeKey) return pending.promise;

    const promise = this.queueDocumentRequest(file, async () => {
      await this.loadDocumentLines(file, startLine, endLine);
      this.lastLoadedRanges.set(file.id, rangeKey);
    }).finally(() => {
      if (this.rangeRequests.get(file.id)?.promise === promise) {
        this.rangeRequests.delete(file.id);
      }
    });
    this.rangeRequests.set(file.id, { rangeKey, promise });
    return promise;
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
    const next = previous.catch(() => {}).then(() => {
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

    const epoch = this.documentEpochs.get(file.id);
    this.queueDocumentRequest(file, async () => {
      const response = await this.nshClient.request("updateDocument", {
        documentId: this.getDocumentId(file),
        ...update,
      });
      if (this.documentEpochs.get(file.id) !== epoch) return;
      this.applyCachedLines(
        file,
        response.lines || [],
        response.changedStartLine || update.startLine,
      );
    }).catch((error) => console.error("[NSH] Document update failed", error));
  }

  closeFile(file) {
    const documentId = this.documentIds.get(file.id);
    const previous = this.documentQueues.get(file.id) || Promise.resolve();
    this.documentEpochs.set(file.id, (this.documentEpochs.get(file.id) || 0) + 1);
    this.documentModes.delete(file.id);
    this.documentIds.delete(file.id);
    this.documentQueues.delete(file.id);
    this.rangeRequests.delete(file.id);
    this.lastLoadedRanges.delete(file.id);
    return previous.catch(() => {}).then(() => {
      if (documentId) return this.nshClient.request("closeDocument", { documentId }).catch(() => {});
    });
  }

  closeAllFiles() {
    for (const fileId of [...this.documentModes.keys()]) this.closeFile({ id: fileId });
  }

  splitValidWord(tokenValue) {
    return this.editor.writerController
      .splitWord(tokenValue || "")
      .filter((w) => w && w !== " " && w !== "\t");
  }

  refreshLineNode() {
    this.editor.output.childNodes.forEach((node) => {
      const lineNumber = parseInt(node.dataset.line, 10);
      const screenRow = lineNumber - this.editor.lineController.startIndex;
      this.lineNodes.set(screenRow, node);
    });
  }

  setLineNode(lineNumber, node) {
    const screenRow = lineNumber - this.editor.lineController.startIndex;
    this.lineNodes.set(screenRow, node);
  }

  getLineNode(lineNumber) {
    const screenRow = lineNumber - this.editor.lineController.startIndex;
    return this.lineNodes.get(screenRow);
  }

  markDirty(lineNumber) {
    if (
      lineNumber > this.editor.lineController.lines.length ||
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
      lineNumber + 1 <= this.editor.lineController.lines.length;

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

          if (activeFile !== this.editor.tabManager.activeFile ||
              activeFile.language !== language || activeFile.lines[lineNumber] !== lineNode ||
              lineNode.getText() !== lineText) continue;
          if (result && result.tokens) {
            lineNode.setTokens(result.tokens);
            lineNode.setHighlighted(true);

            this.applyHighlightToLine(lineNumber, result.tokens);
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

  applyHighlightToLine(lineNumber, tokens) {
    const lineNode = this.getLineNode(lineNumber);

    if (!lineNode) return;

    const text = this.editor.lineController.lines[lineNumber]?.getText();

    if (!text) return;

    // Highlighting is asynchronous, so it must use the same horizontal
    // projection as the line renderer at the time the response is applied.
    const slicedLine = this.editor.lineController.getSlicedLine(text);
    const visibleTokens = this.editor.lineController.getVisibleTokens(
      tokens,
      slicedLine,
    );
    const fragment = this.editor.writerController.textToOBJ(
      slicedLine.text,
      visibleTokens,
    );

    lineNode.replaceChildren(fragment);
    return true;
  }
}
