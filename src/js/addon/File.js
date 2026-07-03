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
    this.longuerLine = 0;
    this.startIndex = 0;
    this.offsetY = 0;

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

    this.language = new PlainText(this.editor);
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
    this.startIndex = file.startIndex;
    this.offsetY = file.offsetY;

    this.isMouseDown = file.isMouseDown;
    this.containsSelected = file.containsSelected;

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
      this.editor.lineController.loadContent("");
      return;
    }
    let contents = await this.editor.api.getFileContent([this.path]);

    this.editor.lineController.loadContent(contents[this.path].toString());
  }

  async save() {
    if (!this.path) {
      await this.saveAs();
      return;
    } else {
      await this.editor.api.saveFile(
        this.path,
        this.editor.lineController.getContent()
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
