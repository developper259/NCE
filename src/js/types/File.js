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
  }

  async loadContent() {
    if (!this.path) {
      const content = this.lines.map((line) => line.getText()).join("\n");
      this.editor.lineController.loadContent(content);
      this.isLoaded = true;
      return;
    }

    try {
      const { initialLines, totalLines } =
        await this.editor.fileLoader.loadFile(this.path);

      this.editor.lineController.loadContent(
        initialLines.join("\n"),
        totalLines,
      );

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
        this.isLoaded = true;
      } else {
        throw error;
      }
    }
  }

  async save() {
    if (!this.path) {
      let r = await this.selectFileToSave();
      if (!r) return;
      await this.loadLanguage();
    }

    let r = await this.editor.api.saveFile(
      this.path,
      this.editor.lineController.getContent(),
    );

    if (r) {
      this.setIsSaved(true);
      this.editor.tabManager.refresh();
    }
  }

  async selectFileToSave() {
    const file = await this.editor.tabManager.selectNewFile();
    if (!file) return false;
    this.path = file.path;
    this.name = file.name;
    return true;
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
      this.setIsSaved(false);
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
