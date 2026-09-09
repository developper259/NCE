class FileNode {
  constructor(e, id, name, path) {
    this.editor = e;
    this.id = id;
    this.name = name;
    this.path = path;

    this.isSaved = true;
    this.deletedFromDisk = false;
    this.editVersion = 0;

    // KeyBinding
    this.historyX = undefined;

    // Cursor
    this.row = 0;
    this.column = 0;

    // Line Controller
    this.lines = [new LineNode("")];
    this.index = 1;
    this.totalLines = 0;
    this.maxLineLength = 0;
    this.startIndex = 0;
    this.offsetY = 0;
    this.offsetX = 0;
    this.isLoaded = false;
    this.loadingState = null;
    this.syntaxMetrics = null;
    this.contentGeneration = 0;

    // Select Controller
    this.isMouseDown = false;
    this.containsSelected = "";
    this._selectedLines = new Map();

    this.lastClick = 0;
    this.clickCount = 0;

    this.HstartSelect = undefined; // historique start select
    this.startSelect = undefined;
    this.endSelect = undefined;

    // Writer Controller
    this.insertMode = false;

    // HighlightController
    this.language = undefined;
    this.eol = "\n";
    this.hasFinalNewline = false;
    this.lineEndings = [];
    this.loadError = null;
    this.incrementalEligible = false;

    // Diff State
    this.diffSnapshot = null;
    this.diffActive = false;
    this.diffRows = null;
  }

  async loadLanguage() {
    this.language = await this.editor.highlightController.detectLanguage(
      this.name,
    );
  }
  isEmpty() {
    if (this.lines.length === 0) return true;
    if (this.lines.length === 1 && this.lines[0].getText().length === 0)
      return true;
    return false;
  }

  hasPath() {
    if (this.path) return true;
    return false;
  }

  replaceFile(file) {
    this.name = file.name;
    this.path = file.path;
    this.isSaved = file.isSaved;
    this.deletedFromDisk = file.deletedFromDisk === true;

    this.historyX = file.historyX;

    this.row = file.row;
    this.column = file.column;

    this.lines = file.lines;
    this.index = file.index;
    this.totalLines = file.totalLines;
    this.maxLineLength = file.maxLineLength;
    this.startIndex = file.startIndex;
    this.offsetY = file.offsetY;
    this.offsetX = file.offsetX;
    this.isLoaded = false;

    this.isMouseDown = file.isMouseDown;
    this.containsSelected = file.containsSelected;
    this._selectedLines = file._selectedLines;

    this.lastClick = file.lastClick;
    this.clickCount = file.clickCount;

    this.HstartSelect = file.HstartSelect;
    this.startSelect = file.startSelect;
    this.endSelect = file.endSelect;

    this.insertMode = file.insertMode;

    this.language = file.language;
    this.eol = file.eol || "\n";
    this.hasFinalNewline = file.hasFinalNewline === true;
    this.lineEndings = Array.isArray(file.lineEndings)
      ? [...file.lineEndings]
      : [];
    this.loadError = file.loadError || null;
    this.incrementalEligible = file.incrementalEligible === true;
  }

  async loadContent() {
    const generation = ++this.contentGeneration;
    if (!this.path) { this.isLoaded = true; return; }
    try {
      const loading = this.editor.fileLoader.loadFile(this.path);
      this.loadingState = this.editor.fileLoader.getState(this.path);
      this.editor.bottomBar?.refreshFileStatus?.();
      const result = await loading;
      if (generation !== this.contentGeneration) return;
      this.loadingState = result.state;
      this.eol = result.eol;
      this.hasFinalNewline = result.hasFinalNewline;
      this.lineEndings = result.lineEndings;
      this.incrementalEligible = result.incrementalEligible;
      this.lines = result.initialLines.map((text) => new LineNode(text));
      if (!this.lines.length) this.lines = [new LineNode("")];
      this.totalLines = this.lines.length;
      this.syntaxMetrics = null;
      this.loadError = null;
      this.deletedFromDisk = false;
      this.editor.historyController?.clear(this);
      this.editor.fileLoader.loadRemainingLines(this, result.initialLines.length, result.totalLines);
      this.isLoaded = true;
    } catch (error) {
      if (generation !== this.contentGeneration) return;
      this.loadError = error;
      this.isLoaded = true;
      this.editor.bottomBar?.refreshFileStatus?.();
    }
  }

  async ensureSaveable() {
    if (this.loadError) return false;
    try {
      await this.editor.fileLoader.waitForFileLoaded(this);
      this.saveError = null;
      return true;
    } catch (error) {
      this.reportSaveError(error);
      return false;
    }
  }

  getSyntaxMetrics() {
    if (!this.syntaxMetrics) {
      let logicalLength = Math.max(0, this.lines.length - 1);
      let longLineCount = 0;
      for (const line of this.lines) {
        const length = line.getText().length;
        logicalLength += length;
        if (length > 1000) longLineCount++;
      }
      this.syntaxMetrics = { logicalLength, longLineCount };
    }
    return this.syntaxMetrics;
  }

  reportSaveError(error) {
    this.saveError = error;
    const message = error.code === "FILE_LOAD_FAILED" ? "File loading failed. Reload the file before saving."
      : error.code === "FILE_NOT_FULLY_LOADED" ? "File is not fully loaded. Save was cancelled."
      : "Failed to save file.";
    if (typeof alert === "function") alert(message);
    else console.warn(message);
  }

  async save() {
    if (this.loadError) { this.reportSaveError(this.loadError); return false; }
    if (!this.path) return this.saveAs();
    if (!(await this.ensureSaveable())) return false;
    const content = this.serializeContent();
    const version = this.editVersion;
    try {
      const saved = await this.editor.api.saveFile(this.path, content);
      if (!saved) throw new Error("Failed to save file");
      if (version === this.editVersion) {
        this.deletedFromDisk = false;
        this.setIsSaved(true);
        this.editor.historyController?.markSaved(this);
      }
      this.editor.tabManager.refresh();
      return true;
    } catch (error) { this.reportSaveError(error); return false; }
  }

  async saveAs() {
    if (this.loadError) { this.reportSaveError(this.loadError); return false; }
    if (!(await this.ensureSaveable())) return false;
    const selectedPath = await this.editor.tabManager.selectNewFile();
    if (typeof selectedPath !== "string" || !selectedPath) return false;
    const content = this.serializeContent();
    const version = this.editVersion;
    try {
      const saved = await this.editor.api.saveFile(selectedPath, content);
      if (!saved) throw new Error("Failed to save file");
    } catch (error) { this.reportSaveError(error); return false; }

    if (!this.path) this.loadingState = { status: "loaded", loadedLineCount: this.lines.length, expectedTotalLines: this.lines.length };
    this.path = selectedPath;
    this.deletedFromDisk = false;
    this.name = selectedPath.replace(/\\/g, "/").split("/").pop() || this.name;
    if (version === this.editVersion) {
      this.setIsSaved(true);
      this.editor.historyController?.markSaved(this);
    }
    const language = await this.editor.highlightController.detectLanguage(this.name);
    await this.editor.highlightController.changeLanguage(this, language);
    if (this === this.editor.tabManager.activeFile) this.editor.fileExplorer?.setActiveFile(this.path);
    this.editor.tabManager.refresh();
    return true;
  }

  async selectFileToSave() {
    return this.saveAs();
  }

  serializeContent() {
    if (this.lineEndings.length > 0) {
      let content = "";
      for (let index = 0; index < this.lines.length; index++) {
        content += this.lines[index].getText();
        const shouldEndLine =
          index < this.lines.length - 1 || this.hasFinalNewline;
        if (shouldEndLine) content += this.lineEndings[index] || this.eol;
      }
      return content;
    }

    const content = this.lines.map((line) => line.getText()).join(this.eol);
    return content + (this.hasFinalNewline ? this.eol : "");
  }

  setIsSaved(value) {
    this.isSaved = value;
  }

  get autoSave() {
    return this.editor.getAutoSaveState?.() === true;
  }

  shouldPersistChanges() {
    return this.autoSave === true && Boolean(this.path) && !this.deletedFromDisk;
  }

  onChange() {
    this.setIsSaved(
      this.editor.historyController
        ? this.editor.historyController.isAtSavePoint(this)
        : false,
    );
    if (this.shouldPersistChanges()) {
      void this.save();
    }
    this.editor.tabManager.refresh();
  }

  keepDiff() {
    this.diffSnapshot = null;
    this.diffActive = false;
    this.diffRows = null;
    this.setIsSaved(false);
    this.editor.lineController.refresh(true);
  }

  undoDiff() {
    if (this.diffSnapshot === null) return;
    const lineController = this.editor.lineController;
    lineController.loadContent(this.diffSnapshot);
    this.diffSnapshot = null;
    this.diffActive = false;
    this.diffRows = null;
    this.editor.tabManager.refresh();
  }
}
