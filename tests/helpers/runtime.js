const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");

function loadGlobal(relativePath, exportName, globals = {}) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  const context = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Map,
    Set,
    WeakMap,
    Promise,
    TextDecoder,
    ...globals,
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.__exported = ${exportName};`, context, {
    filename: relativePath,
  });
  return context.__exported;
}

function createLine(text = "") {
  const LineNode = loadGlobal("src/js/types/Line.js", "LineNode");
  return new LineNode(text);
}

function createEditor(text = "") {
  const LineNode = loadGlobal("src/js/types/Line.js", "LineNode");
  const file = {
    id: 1,
    name: "test.js",
    path: "",
    lines: text.split("\n").map((line) => new LineNode(line)),
    row: 1,
    column: 0,
    isSaved: true,
    isLoaded: true,
    insertMode: false,
    historyX: undefined,
    hasFinalNewline: false,
    setIsSaved(value) {
      this.isSaved = value;
    },
  };
  file.totalLines = file.lines.length;

  const editor = {
    baseX: 50,
    baseY: 2,
    posY: 23,
    letterSize: 10,
    isOnInit: false,
    cD: { classList: { add() {}, remove() {} }, style: {} },
    output: { focus() {} },
    focusOutput() {},
    keyBinding: { historyX: undefined },
    setSelected() {},
    domManager: {
      getOutputWidth: () => 800,
      getOutputHeight: () => 500,
      getLetterWidth: () => 10,
      getLineHeight: () => 23,
      getOutputY: () => 0,
      getOutputRect: () => ({ left: 0, top: 0 }),
    },
    tabManager: { activeFile: file },
    events: { calls: [], callEvent(name, payload) { this.calls.push({ name, payload }); } },
    selectController: null,
    cursorController: null,
    lineController: {
      get lines() { return editor.tabManager.activeFile.lines; },
      set lines(value) { editor.tabManager.activeFile.lines = value; },
      get totalLines() { return editor.tabManager.activeFile.lines.length; },
      markDirtyFrom() {},
      refresh() {},
      setFocusLine() {},
      getDisplayIndexForCursor(row) { return row - 1; },
      getLineTop(row) { return row * 23; },
      getViewportHeight() { return 500; },
      get maxViewLines() { return 20; },
      get maxLines() { return 20; },
      scrollTo() {},
    },
    historyController: null,
  };
  editor.selectController = {
    startSelect: null,
    containsSelected: "",
    hasActiveSelection() { return Boolean(this.startSelect && this.containsSelected); },
    unSelectAll() { this.startSelect = null; this.containsSelected = ""; },
    setSelection() {},
    getLogicalSelection() { return null; },
  };
  editor.cursorController = {
    get row() { return editor.tabManager.activeFile.row; },
    set row(value) { editor.tabManager.activeFile.row = value; },
    get column() { return editor.tabManager.activeFile.column; },
    set column(value) { editor.tabManager.activeFile.column = value; },
    setCursorPosition(row, column) {
      const activeFile = editor.tabManager.activeFile;
      activeFile.row = Math.max(1, Math.min(row, activeFile.lines.length));
      activeFile.column = Math.max(0, Math.min(column, activeFile.lines[activeFile.row - 1].getText().length));
    },
    getPosition(row, column) { return { row, column }; },
    getLine() { const activeFile = editor.tabManager.activeFile; return activeFile.lines[activeFile.row - 1]?.getText() || ""; },
    isRowVisible() { return true; },
    updateCaretPosition() {},
    columnToX() { return 0; },
    rowToY() { return 0; },
  };
  return { editor, file };
}

module.exports = { root, loadGlobal, createLine, createEditor };
