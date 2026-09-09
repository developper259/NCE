const assert = require("node:assert/strict");
const test = require("node:test");
const { createEditor, loadGlobal } = require("./helpers/runtime");

const LineNode = loadGlobal("src/js/types/Line.js", "LineNode");

function element(tag = "div") {
  const node = {
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    style: { setProperty(name, value) { this[name] = value; } },
    className: "",
    textContent: "",
    classList: {
      values: new Set(),
      add(...names) { names.forEach((name) => this.values.add(name)); },
      remove(...names) { names.forEach((name) => this.values.delete(name)); },
      contains(name) { return this.values.has(name); },
    },
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
    replaceChildren(...children) { this.children = children; },
    addEventListener() {},
    removeAttribute(name) {
      if (name.startsWith("data-")) delete this.dataset[name.slice(5)];
    },
  };
  return node;
}

function visibleText(node) {
  return [node.textContent, ...node.children.map(visibleText)].join("");
}

test("virtual viewport remaps every visible slot after delete and scrollTo", () => {
  class OutputScrollerStub {}
  const LineController = loadGlobal(
    "src/js/controller/LineController.js",
    "LineController",
    { OutputScroller: OutputScrollerStub, CONFIG_GET: () => 4, getOccurrence: () => 0 },
  );
  const lines = Array.from({ length: 60 }, (_, index) => new LineNode(`LINE-${String(index).padStart(3, "0")}`));
  const slots = Array.from({ length: 6 }, (_, index) => {
    const slot = element();
    slot.textContent = lines[index].getText();
    slot.dataset.line = String(index);
    slot.dataset.displayLine = String(index);
    return slot;
  });
  const file = { lines, totalLines: lines.length, startIndex: 25, offsetY: 0, offsetX: 0, maxLineLength: 8 };
  const lineNodes = new Map();
  const editor = {
    tabManager: { activeFile: file },
    output: { children: slots },
    highlightController: {
      lineNodes,
      setLineNode(line, node) { lineNodes.set(line - file.startIndex, node); },
      markDirty() {}, markDirtyFrom() {}, markDirtyAll() {},
    },
  };
  const controller = Object.create(LineController.prototype);
  controller.editor = editor;
  controller.outputHeight = 115;
  controller.outputWidth = 80;
  controller.dirtyLines = new Set(lines.slice(25, 31));
  controller.createLineOBJ = (slice) => {
    const node = element();
    node.textContent = slice.text;
    node.replaceWith = (replacement) => {
      const index = slots.indexOf(node);
      if (index >= 0) slots[index] = replacement;
    };
    return node;
  };
  slots.forEach((slot) => {
    slot.replaceWith = (replacement) => { slots[slots.indexOf(slot)] = replacement; };
  });

  controller.refreshOutput();
  const rendered = slots.map((slot) => Number(slot.dataset.line));
  assert.equal(new Set(rendered).size, rendered.length);
  slots.forEach((slot) => {
    assert.equal(slot.textContent, lines[Number(slot.dataset.line)].getText());
    assert.equal(slot.dataset.displayLine, slot.dataset.line);
  });
});

test("scroll state clamps vertically and horizontally after content shrinks", () => {
  const OutputScroller = loadGlobal("src/js/scrollers/Output.Scroller.js", "OutputScroller", {
    realColumnToViewColumn: (_line, column) => column,
  });
  const scroller = Object.create(OutputScroller.prototype);
  const state = { startIndex: 180, offsetY: 12, offsetX: 90, maxLineLength: 12, maxLines: 10 };
  scroller.marginChars = 10;
  scroller.editor = { letterSize: 10, output: { clientWidth: 100 } };
  scroller.lineController = state;
  scroller.getTotalScrollLines = () => 40;
  scroller.getEffectiveTotalLines = () => 40;
  scroller.getVisibleHorizontalWidth = () => 100;
  state.getLineHeight = () => 20;

  assert.equal(scroller.clampScrollState(), true);
  assert.equal(state.startIndex, 30);
  assert.equal(state.offsetY, 0);
  assert.equal(state.offsetX, 12);
  assert.equal(scroller.clampScrollState(), false);
});

test("scrollTo requests a highlight pass for the newly rendered lines", () => {
  const OutputScroller = loadGlobal("src/js/scrollers/Output.Scroller.js", "OutputScroller", {
    realColumnToViewColumn: (_line, column) => column,
  });
  const scroller = Object.create(OutputScroller.prototype);
  const calls = [];
  const state = {
    startIndex: 0,
    offsetY: 0,
    offsetX: 0,
    maxLineLength: 12,
    maxLines: 10,
    lines: [],
    getLineHeight: () => 20,
    markDirtyAll: () => calls.push("markDirtyAll"),
    refreshOutput: () => calls.push("refreshOutput"),
    refreshNumberLines() {},
  };
  scroller.marginChars = 10;
  scroller.lineController = state;
  scroller.editor = {
    letterSize: 10,
    highlightController: { lineNodes: new Map(), refresh: () => calls.push("highlight") },
    cursorController: { updateCaretPosition() {} },
    selectController: { refreshSelectPositions() {} },
    searchController: { refreshSelectionDOM() {} },
  };
  scroller.getTotalScrollLines = () => 400;
  scroller.getEffectiveTotalLines = () => 400;
  scroller.getVisibleHorizontalWidth = () => 100;
  scroller.getVerticalScrollRatioFromState = () => 0;
  scroller.applyScrollTransform = () => {};
  scroller.vScroller = { setScrollRatio() {}, refresh() {} };
  scroller.hScroller = { setScrollRatio() {}, refresh() {} };

  scroller.scrollTo(200);

  assert.equal(state.startIndex, 200);
  assert.deepEqual(calls, ["markDirtyAll", "refreshOutput", "highlight"]);
});

test("async highlighting preserves the partial renderer horizontal slice", () => {
  const HighlightController = loadGlobal(
    "src/js/controller/HighlightController.js",
    "HighlightController",
    { NSHClient: class {} },
  );
  const fullText = "LINE-003-abcdefghijklmnopqrstuvwxyz";
  const parent = element("section");
  parent.style.transform = "translate(0px, 0px)";
  const renderedLine = element();
  parent.appendChild(renderedLine);
  let renderedText = null;
  let renderedTokens = null;
  const controller = Object.create(HighlightController.prototype);
  controller.lineNodes = new Map([[0, renderedLine]]);
  controller.editor = {
    lineController: {
      startIndex: 0,
      offsetX: 10,
      lines: [new LineNode(fullText)],
      getSlicedLine(text) { return { text: text.slice(this.offsetX), startChar: this.offsetX }; },
      getVisibleTokens(tokens, slice) {
        return tokens.map((token) => ({
          ...token,
          value: token.value.slice(slice.startChar),
          column: 1,
        }));
      },
    },
    writerController: {
      textToOBJ(text, tokens) {
        renderedText = text;
        renderedTokens = tokens;
        return { text, tokens };
      },
    },
  };

  const originalParent = renderedLine.parentElement;
  assert.equal(
    controller.applyHighlightToLine(0, [
      { column: 1, value: fullText, className: "identifier" },
    ]),
    true,
  );
  assert.equal(renderedText, fullText.slice(10));
  assert.equal(renderedTokens[0].value, fullText.slice(10));
  assert.equal(renderedLine.parentElement, originalParent);
  assert.equal(parent.style.transform, "translate(0px, 0px)");

  controller.editor.lineController.offsetX = 0;
  controller.applyHighlightToLine(0, [
    { column: 1, value: fullText, className: "identifier" },
  ]);
  assert.equal(renderedText, fullText);
});

test("cursor follows visual columns right and returns left without jitter", () => {
  const { editor, file } = createEditor("\tabcdefghijklmnopqrstuvwxyz");
  let offsetX = 0;
  editor.output.clientWidth = 100;
  editor.lineController.offsetX = 0;
  editor.lineController.outputScroller = {
    getVisibleHorizontalWidth: () => 100,
    setHorizontalOffset(value) {
      const changed = value !== offsetX;
      offsetX = value;
      editor.lineController.offsetX = value;
      return changed;
    },
  };
  const viewColumn = (line, column) => {
    let result = 0;
    for (const char of line.slice(0, column)) result += char === "\t" ? 4 : 1;
    return result;
  };
  const CursorController = loadGlobal("src/js/controller/CursorController.js", "CursorController", {
    roundX: Math.round, roundY: Math.round,
    realColumnToViewColumn: viewColumn,
    viewColumnToRealColumn: (_line, column) => column,
  });
  const cursor = new CursorController(editor);
  editor.cursorController = cursor;
  file.row = 1;
  file.column = 20;
  cursor.ensureCursorVisible();
  assert.ok(offsetX > 0);
  const stableOffset = offsetX;
  cursor.ensureCursorVisible();
  assert.equal(offsetX, stableOffset);
  file.column = 0;
  cursor.ensureCursorVisible();
  assert.equal(offsetX, 0);
});

test("a rapid unshifted click clears selection state and its DOM", () => {
  const { editor, file } = createEditor("old selection\nnew target");
  const selectionNode = element();
  selectionNode.style.display = "";
  editor.selectOutput = { children: [selectionNode] };
  editor.output = element();
  editor.cD = element();
  editor.cursorController.onClick = () => ({ row: 2, column: 2 });
  file._selectedLines = new Map([[0, { startCol: 1, length: 3 }]]);
  file.containsSelected = "old";
  file.startSelect = { row: 1, column: 0 };
  file.endSelect = { row: 1, column: 3 };
  file.lastClickTime = Date.now();
  file.clickCount = 0;
  const SelectController = loadGlobal("src/js/controller/SelectController.js", "SelectController", {
    addEvent() {}, Events: { ON_SELECT: "select" }, document: { createElement: element },
  });
  const selection = new SelectController(editor);
  editor.selectController = selection;
  selection.mouseDown({ button: 0, shiftKey: false });

  assert.equal(selection.hasActiveSelection(), false);
  assert.equal(selection.containsSelected, "");
  assert.equal(selectionNode.style.display, "none");
  assert.equal(selection.startSelect.row, file.row);
  assert.equal(selection.startSelect.column, file.column);
});

test("dragging after a double click on an empty line keeps a selection anchor", () => {
  const { editor, file } = createEditor("\nsecond line");
  editor.selectOutput = element();
  editor.output = element();
  editor.cD = element();
  editor.cursorController.onClick = () => ({ row: file.row, column: file.column });
  editor.cursorController.getViewPosition = (row, column) => ({ row, column });
  file._selectedLines = new Map();
  file.containsSelected = "";
  file.clickCount = 0;
  file.lastClickTime = Date.now();
  const SelectController = loadGlobal("src/js/controller/SelectController.js", "SelectController", {
    addEvent() {}, Events: { ON_SELECT: "select" }, document: { createElement: element },
  });
  const selection = new SelectController(editor);
  editor.selectController = selection;

  selection.mouseDown({ button: 0, shiftKey: false });
  selection.mouseDown({ button: 0, shiftKey: false });

  assert.equal(selection.clickCount, 2);
  assert.ok(selection.startSelect);

  file.column = 4;
  assert.doesNotThrow(() => selection.mouseMove({ button: 0 }));
  assert.equal(selection.startSelect.row, 1);
  assert.equal(selection.endSelect.column, 4);
});

test("File Explorer distinguishes no workspace, empty workspace and files", () => {
  class Sidebar {}
  const document = { createElement: element };
  const FileExplorer = loadGlobal("src/js/sidebar/FileExplorer.Sidebar.js", "FileExplorer", {
    Sidebar, FileOperations: class {}, document, window: { api: {} },
    USERCONFIG_FILE_ICONS: {}, USERCONFIG_FOLDER_ICON: "folder",
    buildFileContextMenu() {}, buildFolderContextMenu() {},
    buildBackgroundContextMenu() {}, buildProjectContextMenu() {},
  });
  const explorer = Object.create(FileExplorer.prototype);
  Object.assign(explorer, {
    activeFilePath: null, projectName: "", projectExpanded: true, files: [], rootPath: "",
    editor: { tabManager: { getFileByPath: () => null }, contextMenuManager: { openContextMenu() {} } },
    refresh() {}, selectFolder() {},
  });

  let rendered = explorer.render();
  assert.match(visibleText(rendered), /Open Folder/);
  explorer.rootPath = "/tmp/project";
  explorer.projectName = "project";
  rendered = explorer.render();
  assert.match(visibleText(rendered), /Folder empty/);
  assert.doesNotMatch(visibleText(rendered), /Open Folder/);
  explorer.files = [{ name: "a.js", type: "file", path: "/tmp/project/a.js" }];
  rendered = explorer.render();
  assert.doesNotMatch(visibleText(rendered), /Folder empty|Open Folder/);
});
