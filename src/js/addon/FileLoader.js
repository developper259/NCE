class FileLoader {
  constructor(editor) {
    this.editor = editor;
    this.loadingStates = new Map();
    this.initialChunkSize = 1000;
    this.backgroundChunkSize = 1000;
    this.incrementalMaxFileSize = 1024 * 1024;
    this.incrementalMaxLineLength = 1000;
    this.requestTimeoutMs = 15000;
  }

  getState(filePath) {
    if (!this.loadingStates.has(filePath)) {
      this.loadingStates.set(filePath, {
        status: "idle", isLoading: false, isFullyLoaded: false,
        expectedTotalLines: 0, loadedLineCount: 0, timer: null,
      });
    }
    return this.loadingStates.get(filePath);
  }

  finish(state, status, error = null) {
    state.timer?.close();
    state.timer = null;
    state.status = status;
    state.isLoading = status === "loading";
    state.isFullyLoaded = status === "loaded";
    state.error = error;
    if (status !== "loading") state.resolve?.();
    this.editor.bottomBar?.refreshFileStatus?.();
  }

  async request(promise) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("File loading timed out")), this.requestTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  async loadFile(filePath) {
    this.cancelLoading(filePath);
    this.loadingStates.delete(filePath);
    const state = this.getState(filePath);
    state.completion = new Promise((resolve) => { state.resolve = resolve; });
    this.finish(state, "loading");
    try {
      const init = await this.request(this.editor.api.initializeFile(filePath));
      if (!init?.success) {
        const code = init?.errorCode || "FILE_LOAD_FAILED";
        const message = code === "FILE_TOO_LARGE" ? "File is too large to be opened"
          : code === "BINARY_FILE" ? "Binary file can't be opened" : code;
        throw Object.assign(new Error(message), { code });
      }
      state.expectedTotalLines = init.totalLines;
      const incrementalEligible = init.incrementalEligible === true &&
        init.size <= this.incrementalMaxFileSize && init.maxLineLength <= this.incrementalMaxLineLength;
      const count = Math.min(init.totalLines, incrementalEligible ? init.totalLines : this.initialChunkSize);
      const chunk = await this.request(this.editor.api.getFileChunk(filePath, 0, count));
      if (state.status !== "loading") throw new Error("File loading cancelled");
      if (!chunk?.success || !Array.isArray(chunk.lines) || chunk.lines.length !== count) {
        throw new Error("Failed to load initial chunk");
      }
      state.loadedLineCount = count;
      if (count === init.totalLines) this.finish(state, "loaded");
      return { initialLines: chunk.lines, totalLines: init.totalLines,
        eol: init.eol || "\n", hasFinalNewline: init.hasFinalNewline === true,
        lineEndings: init.lineEndings || [], incrementalEligible, state };
    } catch (error) {
      if (state.status !== "cancelled") this.finish(state, "failed", error);
      throw error;
    }
  }

  loadRemainingLines(file, currentLineCount, totalLines) {
    const state = file.loadingState || this.getState(file.path);
    file.loadingState = state;
    if (state.status !== "loading" || state.backgroundStarted) return;
    state.backgroundStarted = true;
    const next = (start) => {
      if (state.status !== "loading") return;
      if (start === totalLines) { this.finish(state, "loaded"); return; }
      const end = Math.min(start + this.backgroundChunkSize, totalLines);
      const callback = () => this.performChunkLoad(file, file.path, start, end, totalLines, next, state);
      if (typeof window.requestIdleCallback === "function") {
        const handle = window.requestIdleCallback(callback, { timeout: 100 });
        state.timer = { close: () => window.cancelIdleCallback(handle) };
      } else {
        const handle = setTimeout(callback, 1);
        state.timer = { close: () => clearTimeout(handle) };
      }
    };
    next(currentLineCount);
  }

  async waitForFileLoaded(file) {
    if (!file?.path) return;
    const state = file.loadingState || this.loadingStates.get(file.path);
    if (state?.status === "loading") await state.completion;
    if (state?.status === "failed") {
      throw Object.assign(new Error("File loading failed; save refused"), { code: "FILE_LOAD_FAILED" });
    }
    if (!state || state.status !== "loaded" || state.loadedLineCount !== state.expectedTotalLines) {
      throw Object.assign(new Error("File is not fully loaded"), { code: "FILE_NOT_FULLY_LOADED" });
    }
  }

  async performChunkLoad(file, filePath, start, end, total, next, state = file.loadingState) {
    if (!state || state.status !== "loading") return;
    try {
      const response = await this.request(this.editor.api.getFileChunk(filePath, start, end - start));
      if (state.status !== "loading" || file.loadingState !== state) return;
      if (!response?.success || !Array.isArray(response.lines) || response.lines.length !== end - start ||
          state.loadedLineCount !== start || file.lines.length !== start) {
        throw new Error("Failed to load complete file chunk");
      }
      file.lines.push(...response.lines.map((text) => new LineNode(text)));
      file.totalLines = file.lines.length;
      file.syntaxMetrics = null;
      state.loadedLineCount = end;
      if (file === this.editor.tabManager.activeFile) this.editor.scrollerManager.refreshAll();
      next(end);
    } catch (error) {
      if (state.status === "loading") this.finish(state, "failed", error);
    }
  }

  cancelLoading(filePath) {
    const states = filePath ? [this.loadingStates.get(filePath)] : this.loadingStates.values();
    for (const state of states) {
      if (state && state.status !== "loaded") this.finish(state, "cancelled");
    }
  }
}
