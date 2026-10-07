class FileLoader {
  constructor(editor) {
    this.editor = editor;
    this.loadingStates = new Map();
    this.initialChunkSize = 1000;
    this.backgroundChunkSize = 1000;
    this.incrementalMaxFileSize = 1024 * 1024;
    this.incrementalMaxLineLength = 1000;
    this.requestTimeoutMs = 15000;
    this.firstFileReadyMarked = false;
  }

  getState(filePath) {
    if (!this.loadingStates.has(filePath)) {
      this.loadingStates.set(filePath, {
        status: "idle", isLoading: false, isFullyLoaded: false,
        expectedTotalLines: 0, loadedLineCount: 0, timer: null,
        progressRefreshFrame: null, largeFileMode: false, size: 0, filePath,
        lineWaiters: new Set(),
      });
    }
    return this.loadingStates.get(filePath);
  }

  finish(state, status, error = null) {
    state.timer?.close();
    state.timer = null;
    if (status === "cancelled" || status === "failed") {
      if (state.progressRefreshFrame !== null && typeof window.cancelAnimationFrame === "function")
        window.cancelAnimationFrame(state.progressRefreshFrame);
      state.progressRefreshFrame = null;
      void this.editor.api?.releaseFile?.(state.filePath);
    }
    state.status = status;
    state.isLoading = status === "loading";
    state.isFullyLoaded = status === "loaded";
    state.error = error;
    this.notifyLineWaiters(state);
    if (status !== "loading") state.resolve?.();
    this.editor.bottomBar?.refreshFileStatus?.();
  }

  settleLineWaiter(state, waiter, { value, error }) {
    state.lineWaiters?.delete(waiter);
    if (waiter.signal && waiter.abortHandler)
      waiter.signal.removeEventListener("abort", waiter.abortHandler);
    if (error) waiter.reject(error);
    else waiter.resolve(value);
  }

  notifyLineWaiters(state) {
    if (!state?.lineWaiters?.size) return;
    for (const waiter of state.lineWaiters) {
      if (state.loadedLineCount > waiter.lineIndex) {
        this.settleLineWaiter(state, waiter, { value: true });
      } else if (state.status === "loaded") {
        this.settleLineWaiter(state, waiter, { value: false });
      } else if (state.status === "failed" || state.status === "cancelled") {
        this.settleLineWaiter(state, waiter, {
          error: state.error || Object.assign(new Error("File loading cancelled"), {
            name: state.status === "cancelled" ? "AbortError" : "Error",
          }),
        });
      }
    }
  }

  waitForLineLoaded(file, lineNumber, { signal } = {}) {
    const lineIndex = Number.isFinite(Number(lineNumber))
      ? Math.max(0, Math.floor(Number(lineNumber)) - 1)
      : 0;
    const state = file?.loadingState || this.loadingStates.get(file?.path);
    if (state?.loadedLineCount > lineIndex) return Promise.resolve(true);
    if (!state) return Promise.resolve(lineIndex < (file?.lines?.length || 0));
    if (state.status === "loaded") return Promise.resolve(false);
    if (state.status === "failed")
      return Promise.reject(state.error || new Error("File loading failed"));
    if (state.status === "cancelled") {
      return Promise.reject(
        Object.assign(new Error("File loading cancelled"), { name: "AbortError" }),
      );
    }
    if (state.status !== "loading")
      return Promise.resolve(lineIndex < (file?.lines?.length || 0));
    if (signal?.aborted) {
      return Promise.reject(
        Object.assign(new Error("File navigation cancelled"), { name: "AbortError" }),
      );
    }

    return new Promise((resolve, reject) => {
      const waiter = { lineIndex, resolve, reject, signal, abortHandler: null };
      if (!state.lineWaiters) state.lineWaiters = new Set();
      if (signal) {
        waiter.abortHandler = () =>
          this.settleLineWaiter(state, waiter, {
            error: Object.assign(new Error("File navigation cancelled"), {
              name: "AbortError",
            }),
          });
        signal.addEventListener("abort", waiter.abortHandler, { once: true });
      }
      state.lineWaiters.add(waiter);
      this.notifyLineWaiters(state);
    });
  }

  async request(promise) {
    let timer;
    const metrics = this.editor.performanceMetrics;
    metrics?.increment("files.read.requests");
    const measure = metrics?.begin("files.read.request");
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("File loading timed out")), this.requestTimeoutMs);
      })]);
    } finally {
      clearTimeout(timer);
      metrics?.end(measure);
    }
  }

  async loadFile(filePath) {
    await this.cancelLoading(filePath);
    const metrics = this.editor.performanceMetrics;
    metrics?.increment("files.open.requests");
    const measure = metrics?.begin("files.open.initialLoad");
    this.loadingStates.delete(filePath);
    const state = this.getState(filePath);
    state.completion = new Promise((resolve) => { state.resolve = resolve; });
    state.filePath = filePath;
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
      state.largeFileMode = init.largeFileMode === true;
      state.size = Number.isFinite(init.size) ? init.size : 0;
      const incrementalEligible = init.incrementalEligible === true &&
        init.size <= this.incrementalMaxFileSize && init.maxLineLength <= this.incrementalMaxLineLength;
      const count = Math.min(init.totalLines, incrementalEligible ? init.totalLines : this.initialChunkSize);
      const chunk = await this.request(this.editor.api.getFileChunk(filePath, 0, count));
      if (state.status !== "loading") throw new Error("File loading cancelled");
      if (!chunk?.success || !Array.isArray(chunk.lines) || chunk.lines.length !== count) {
        throw Object.assign(new Error("Failed to load initial chunk"), {
          code: chunk?.errorCode || "FILE_LOAD_FAILED",
        });
      }
      state.loadedLineCount = count;
      metrics?.increment("files.read.lines", chunk.lines.length);
      if (count === init.totalLines) this.finish(state, "loaded");
      if (!this.firstFileReadyMarked) {
        this.firstFileReadyMarked = true;
        metrics?.mark("files.first.initialChunkReady");
      }
      return { initialLines: chunk.lines, totalLines: init.totalLines,
        eol: init.eol || "\n", hasFinalNewline: init.hasFinalNewline === true,
        lineEndings: init.lineEndings || chunk.lineEndings || [],
        largeFileMode: state.largeFileMode, size: state.size,
        incrementalEligible, state };
    } catch (error) {
      if (state.status !== "cancelled") this.finish(state, "failed", error);
      throw error;
    } finally {
      metrics?.end(measure);
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

  scheduleLoadProgressRefresh(file, state) {
    if (file !== this.editor.tabManager.activeFile || state.progressRefreshFrame !== null) return;
    const refresh = () => {
      state.progressRefreshFrame = null;
      if (file.loadingState !== state || file !== this.editor.tabManager.activeFile ||
          (state.status !== "loading" && state.status !== "loaded")) return;
      this.editor.lineController?.outputScroller?.refreshLoadProgress?.();
    };
    if (typeof window.requestAnimationFrame === "function") {
      state.progressRefreshFrame = window.requestAnimationFrame(refresh);
    } else {
      refresh();
    }
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
      if (typeof this.editor.lineController.appendLoadedLines === "function") {
        this.editor.lineController.appendLoadedLines(file, response.lines);
      } else {
        file.lines.push(...response.lines.map((text) => new LineNode(text)));
        file.totalLines = file.lines.length;
        file.syntaxMetrics = null;
      }
      this.editor.performanceMetrics?.increment("files.read.lines", response.lines.length);
      if (file.largeFileMode && Array.isArray(response.lineEndings)) {
        for (let index = 0; index < response.lineEndings.length; index += 1)
          file.lineEndings[start + index] = response.lineEndings[index];
      }
      state.loadedLineCount = end;
      this.notifyLineWaiters(state);
      this.scheduleLoadProgressRefresh(file, state);
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
    if (filePath) return this.editor.api?.releaseFile?.(filePath);
  }
}
