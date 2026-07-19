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
    this.history = [];
    this.indexHistory = 1;

    // Cursor
    this.row = 0;
    this.column = 0;

    // Line Controller
    this.lines = [""];
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
  }

  isEmpty() {
    if (this.lines.length === 0) return true;
    if (this.lines.length === 1 && this.lines[0].length === 0) return true;
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
    this.history = file.history;
    this.indexHistory = file.indexHistory;
    this.lastIndexHistory = file.lastIndexHistory;

    this.row = file.row;
    this.column = file.column;

    this.lines = file.lines;
    this.index = file.index;
    this.totalLines = file.totalLines;
    this.maxLineLength = file.maxLineLength;
    this.startIndex = file.startIndex;
    this.offsetY = file.offsetY;
    this.offsetX = file.offsetX;

    this.isMouseDown = file.isMouseDown;
    this.containsSelected = file.containsSelected;

    this.lastClick = file.lastClick;
    this.clickCount = file.clickCount;

    this.HstartSelect = file.HstartSelect;
    this.startSelect = file.startSelect;
    this.endSelect = file.endSelect;

    this.insertMode = file.insertMode;
  }

  async loadContent() {
    if (!this.path) {
      this.editor.lineController.loadContent(this.lines.join("\n"));
      this.isLoaded = true;
      return;
    }

    const { initialLines, totalLines } = await this.editor.fileLoader.loadFile(
      this.path,
    );

    this.editor.lineController.loadContent(initialLines.join("\n"), totalLines);

    this.editor.fileLoader.loadRemainingLines(
      this.path,
      initialLines.length,
      totalLines,
    );

    this.isLoaded = true;
  }

  async save() {
    if (!this.path) {
      await this.saveAs();
      return;
    } else {
      await this.editor.api.saveFile(
        this.path,
        this.editor.lineController.getContent(),
      );
    }
    this.setIsSaved(true);
    this.editor.tabManager.refresh();
  }

  async saveAs() {
    const file = await this.editor.tabManager.selectNewFile();
    if (!file || file.hasPath()) return;
    this.path = file.path;
    this.name = file.name;
    this.save();
  }

  setIsSaved(value) {
    this.isSaved = value;
  }

  onChange() {
    if (this.autoSave) this.save();
    else {
      this.setIsSaved(false);
    }
    this.editor.tabManager.refresh();
  }
}
