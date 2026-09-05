class FileNode {
  constructor(e, id, name, path) {
    this.editor = e;
    this.id = id;
    this.name = name;
    this.path = path;

    this.isSaved = true;
    this.autoSave = false;

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
    this.loadError = null;

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
    this.loadError = file.loadError || null;
  }

  async loadContent() {
    if (!this.path) {
      const content = this.lines.map((line) => line.getText()).join("\n");
      this.editor.lineController.loadContent(content);
      this.editor.historyController?.clear(this);
      this.isLoaded = true;
      return;
    }

    try {
      const { initialLines, totalLines, eol, hasFinalNewline } =
        await this.editor.fileLoader.loadFile(this.path);

      this.eol = eol || "\n";
      this.hasFinalNewline = hasFinalNewline === true;

      this.editor.lineController.loadContent(
        initialLines.join("\n"),
        totalLines,
      );
      this.editor.historyController?.clear(this);

      this.editor.fileLoader.loadRemainingLines(
        this,
        initialLines.length,
        totalLines,
      );

      this.isLoaded = true;
    } catch (error) {
      if (error.message === "ENOENT") {
        console.log(`File not found: ${this.path}, marking as unsaved`);
        this.setIsSaved(false);
        const content = this.lines.map((line) => line.getText()).join("\n");
        this.editor.lineController.loadContent(content);
        this.editor.historyController?.clear(this);
        this.isLoaded = true;
      } else {
        this.loadError = error;
        this.lines = [new LineNode("")];
        this.totalLines = 1;
        this.editor.lineController.loadContent("");
        this.editor.historyController?.clear(this);
        this.isLoaded = true;
      }
    }
  }

  async save() {
    if (this.loadError) return false;
    if (!this.path) {
      return this.saveAs();
    }

    await this.editor.fileLoader.waitForFileLoaded(this);

    const content = this.serializeContent();
    const saved = await this.editor.api.saveFile(this.path, content);

    if (saved) {
      this.setIsSaved(true);
      this.editor.historyController?.markSaved(this);
      this.editor.tabManager.refresh();
    }
    return Boolean(saved);
  }

  async saveAs() {
    if (this.loadError) return false;
    const selectedPath = await this.editor.tabManager.selectNewFile();
    if (typeof selectedPath !== "string" || !selectedPath) return false;

    await this.editor.fileLoader.waitForFileLoaded(this);

    const content = this.serializeContent();
    const saved = await this.editor.api.saveFile(selectedPath, content);
    if (!saved) return false;

    this.path = selectedPath;
    this.name = selectedPath.replace(/\\/g, "/").split("/").pop() || this.name;
    this.setIsSaved(true);
    this.editor.historyController?.markSaved(this);
    await this.loadLanguage();
    this.editor.highlightController.reset();
    this.editor.tabManager.refresh();
    return true;
  }

  async selectFileToSave() {
    return this.saveAs();
  }

  serializeContent() {
    const content = this.lines.map((line) => line.getText()).join(this.eol);
    return content + (this.hasFinalNewline ? this.eol : "");
  }

  setIsSaved(value) {
    this.isSaved = value;
  }

  shouldPersistChanges() {
    return this.autoSave === true && Boolean(this.path);
  }

  onChange() {
    if (this.shouldPersistChanges()) {
      this.save();
    } else {
      this.setIsSaved(
        this.editor.historyController
          ? this.editor.historyController.isAtSavePoint(this)
          : false,
      );
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
