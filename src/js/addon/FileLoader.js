class FileLoader {
  constructor(editor) {
    this.editor = editor;
    this.loadingStates = new Map();
    this.initialChunkSize = 1000;
    this.backgroundChunkSize = 1000;
  }

  getState(filePath) {
    let state = this.loadingStates.get(filePath);
    if (!state) {
      state = { isLoading: false, isFullyLoaded: false, timer: undefined };
      this.loadingStates.set(filePath, state);
    }
    return state;
  }

  async loadFile(filePath) {
    const state = this.getState(filePath);
    state.isFullyLoaded = false;

    const initResponse = await this.editor.api.initializeFile(filePath);
    if (!initResponse || !initResponse.success) {
      if (initResponse && initResponse.errorCode === "ENOENT") {
        throw new Error("ENOENT");
      }
      throw new Error("Failed to initialize file");
    }

    const totalLines = initResponse.totalLines;

    if (totalLines <= this.initialChunkSize) {
      state.isFullyLoaded = true;
    }

    const chunkResponse = await this.editor.api.getFileChunk(
      filePath,
      0,
      this.initialChunkSize,
    );
    if (!chunkResponse || !chunkResponse.success) {
      throw new Error("Failed to load initial chunk");
    }

    return {
      initialLines: chunkResponse.lines,
      totalLines,
    };
  }

  loadRemainingLines(file, currentLineCount, totalLines) {
    const filePath = file.path;
    const state = this.getState(filePath);

    if (state.isFullyLoaded || currentLineCount >= totalLines) {
      state.isFullyLoaded = true;
      return;
    }

    if (state.isLoading) {
      return;
    }

    state.isLoading = true;

    const loadChunk = (startLine) => {
      if (startLine >= totalLines) {
        state.isLoading = false;
        state.isFullyLoaded = true;
        if (state.timer) state.timer.close();
        return;
      }

      const endLine = Math.min(
        startLine + this.backgroundChunkSize,
        totalLines,
      );

      const loadWithIdleCallback = () => {
        if (state.isFullyLoaded || !state.isLoading) return;
        if ("requestIdleCallback" in window) {
          const handle = requestIdleCallback(
            () =>
              this.performChunkLoad(
                file,
                filePath,
                startLine,
                endLine,
                totalLines,
                loadChunk,
              ),
            { timeout: 100 },
          );
          state.timer = { close: () => cancelIdleCallback(handle) };
        } else {
          const handle = setTimeout(
            () =>
              this.performChunkLoad(
                file,
                filePath,
                startLine,
                endLine,
                totalLines,
                loadChunk,
              ),
            1,
          );
          state.timer = { close: () => clearTimeout(handle) };
        }
      };

      loadWithIdleCallback();
    };

    loadChunk(currentLineCount);
  }

  async performChunkLoad(
    file,
    filePath,
    startLine,
    endLine,
    totalLines,
    nextCallback,
  ) {
    const state = this.getState(filePath);

    if (!state.isLoading) {
      return;
    }

    try {
      const response = await this.editor.api.getFileChunk(
        filePath,
        startLine,
        endLine - startLine,
      );

      if (
        response &&
        response.success &&
        response.lines &&
        response.lines.length > 0
      ) {
        if (file === this.editor.tabManager.activeFile) {
          this.editor.lineController.appendLines(response.lines);
          this.editor.scrollerManager.refreshAll();
        } else {
          const newLineNodes = response.lines.map((text) => new LineNode(text));
          file.lines = file.lines.concat(newLineNodes);
          file.totalLines = file.lines.length;
        }

        nextCallback(endLine);
      } else {
        state.isLoading = false;
        state.isFullyLoaded = true;
        if (state.timer) state.timer.close();
      }
    } catch (error) {
      console.error("Error loading chunk:", error);
      state.isLoading = false;
      if (state.timer) state.timer.close();
    }
  }

  cancelLoading(filePath) {
    if (filePath) {
      const state = this.loadingStates.get(filePath);
      if (state) {
        state.isLoading = false;
        if (state.timer) state.timer.close();
        this.loadingStates.delete(filePath);
      }
      return;
    }

    for (const state of this.loadingStates.values()) {
      state.isLoading = false;
      if (state.timer) state.timer.close();
    }
    this.loadingStates.clear();
  }
}
