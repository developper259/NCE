class FileLoader {
  constructor(editor) {
    this.editor = editor;
    this.loadingChunks = new Map();
    this.initialChunkSize = 1000;
    this.backgroundChunkSize = 1000;
    this.isLoading = false;
    this.isFullyLoaded = false;
    this.currentFilePath = null;
    this.timer = undefined;
  }

  async loadFile(filePath) {
    this.currentFilePath = filePath;
    this.isFullyLoaded = false;

    const initResponse = await this.editor.api.initializeFile(filePath);
    if (!initResponse || !initResponse.success) {
      throw new Error("Failed to initialize file");
    }

    const totalLines = initResponse.totalLines;

    if (totalLines <= this.initialChunkSize) {
      this.isFullyLoaded = true;
    }

    const chunkResponse = await this.editor.api.getFileChunk(filePath, 0, this.initialChunkSize);
    if (!chunkResponse || !chunkResponse.success) {
      throw new Error("Failed to load initial chunk");
    }

    return {
      initialLines: chunkResponse.lines,
      totalLines,
    };
  }

  loadRemainingLines(filePath, currentLineCount, totalLines) {
    if (this.isFullyLoaded || currentLineCount >= totalLines) {
      this.isFullyLoaded = true; 
      return;
    }

    if (this.isLoading) {
      return;
    }

    this.isLoading = true;

    const loadChunk = (startLine) => {
      if (startLine >= totalLines) {
        this.isLoading = false;
        this.isFullyLoaded = true;
        if (this.timer) this.timer.close();
        return;
      }

      const endLine = Math.min(startLine + this.backgroundChunkSize, totalLines);

      const loadWithIdleCallback = () => {
        if (this.isFullyLoaded || !this.isLoading) return;
        if ("requestIdleCallback" in window) {
          requestIdleCallback(
            () => this.performChunkLoad(filePath, startLine, endLine, totalLines, loadChunk),
            { timeout: 100 },
          );
        } else {
          this.timer = setTimeout(
            () => this.performChunkLoad(filePath, startLine, endLine, totalLines, loadChunk),
            1,
          );
        }
      };

      loadWithIdleCallback();
    };

    loadChunk(currentLineCount);
  }

  async performChunkLoad(filePath, startLine, endLine, totalLines, nextCallback) {
    if (this.currentFilePath !== filePath) {
      this.isLoading = false;
      return;
    }

    try {
      const response = await this.editor.api.getFileChunk(filePath, startLine, endLine - startLine);

      if (response && response.success && response.lines && response.lines.length > 0) {
        this.editor.lineController.appendLines(response.lines);
        this.editor.scrollerManager.refreshAll();
        
        nextCallback(endLine);
      } else {
        this.isLoading = false;
        this.isFullyLoaded = true;
        if (this.timer) this.timer.close();
      }
    } catch (error) {
      console.error("Error loading chunk:", error);
      this.isLoading = false;
      if (this.timer) this.timer.close();
    }
  }

  cancelLoading() {
    this.isLoading = false;
    this.isFullyLoaded = false;
    this.loadingChunks.clear();
    this.currentFilePath = null;
  }
}