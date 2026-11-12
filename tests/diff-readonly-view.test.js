const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

const root = path.resolve(__dirname, "..");
const CursorController = loadGlobal(
  "src/js/controller/CursorController.js",
  "CursorController",
  { document: { fonts: null }, window: {} },
);
const HistoryController = loadGlobal(
  "src/js/controller/HistoryController.js",
  "HistoryController",
);
const WriterController = loadGlobal(
  "src/js/controller/WriterController.js",
  "WriterController",
);
const SelectController = loadGlobal(
  "src/js/controller/SelectController.js",
  "SelectController",
  { addEvent() {} },
);
const MultiCursorController = loadGlobal(
  "src/js/controller/MultiCursorController.js",
  "MultiCursorController",
);
const LineController = loadGlobal(
  "src/js/controller/LineController.js",
  "LineController",
);

function createCursorController(activeFile) {
  const displays = [];
  const editor = {
    cD: {},
    posY: 19,
    domManager: {
      wrapFastNode: () => ({
        setDisplay(value) { displays.push(value); },
        setHeight() {},
        setStyle() {},
        setLeft() {},
        setTop() {},
      }),
    },
    tabManager: { activeFile },
  };
  const controller = new CursorController(editor);
  return { controller, editor, displays };
}

test("CursorController suppresses the caret while a diff view is active", () => {
  const activeFile = { isDiffView: true, row: 1, column: 0 };
  const { controller, editor, displays } = createCursorController(activeFile);
  controller.enable();
  assert.equal(displays.at(-1), "none");
  controller.disable();
  controller.enable();
  assert.equal(displays.at(-1), "none", "click focus cannot reveal the caret in a diff");
  controller.updateCaretPosition();
  assert.equal(displays.at(-1), "none", "caret updates stay hidden without geometry work");

  editor.tabManager.activeFile = { isDiffView: false, row: 1, column: 0 };
  controller.enable();
  assert.equal(displays.at(-1), "block", "normal files must get their caret back");
});

test("HistoryController refuses undo and redo on a diff buffer", async () => {
  const history = Object.create(HistoryController.prototype);
  history.editor = { tabManager: { activeFile: { isDiffView: true } } };
  assert.equal(await history.undo(), false);
  assert.equal(await history.redo(), false);
});

test("WriterController mutations are ignored on a diff buffer", () => {
  const writer = Object.create(WriterController.prototype);
  let touched = false;
  writer.editor = {
    tabManager: { activeFile: { isDiffView: true } },
    keyBinding: {},
    lineController: {
      get lines() { touched = true; return []; },
    },
  };
  assert.equal(writer.write("x"), undefined);
  assert.equal(writer.replaceRange("x", 1, 0, 1, 0), null);
  assert.equal(writer.deleteSelection(), null);
  assert.equal(writer.insertTextAt("x", 1, 0), null);
  assert.equal(writer.applyRangeEdit({ row: 1, column: 0 }, { row: 1, column: 0 }, "x"), null);
  assert.equal(touched, false, "no line buffer may be read or mutated");
});

test("Alt-click cannot add editing cursors inside a diff view", () => {
  let added = 0;
  let prevented = false;
  const select = Object.create(SelectController.prototype);
  select.stopAutoScroll = () => {};
  select.editor = {
    tabManager: { activeFile: { isDiffView: true } },
    multiCursorController: {
      isEligible: () => true,
      addCursorAtClientCoordinates() { added += 1; },
    },
  };
  select.mouseDown({
    altKey: true,
    button: 0,
    clientX: 10,
    clientY: 10,
    preventDefault() { prevented = true; },
    stopPropagation() {},
  });
  assert.equal(added, 0);
  assert.equal(prevented, true);
});

test("Diff focus styling dims context and accents changed lines with theme tokens", () => {
  const variables = fs.readFileSync(path.join(root, "src/css/var.css"), "utf8");
  const editorCss = fs.readFileSync(path.join(root, "src/css/editor.css"), "utf8");
  assert.match(variables, /--diff-focus-context-opacity:\s*0\.72/);
  assert.match(variables, /--diff-focus-context-opacity:\s*0\.68/);
  assert.match(variables, /--diff-focus-added-bg:\s*rgba\(95, 191, 127/);
  assert.match(variables, /--diff-focus-removed-bg:\s*rgba\(201, 60, 71/);
  assert.match(editorCss, /\.editor-git-diff-active \.line-unchanged\s*\{\s*opacity:\s*var\(--diff-focus-context-opacity\)/);
  assert.match(editorCss, /\.editor-git-diff-active \.line-added\s*\{[\s\S]*?var\(--diff-focus-added-bg\)[\s\S]*?inset 2px 0 0 var\(--git-added\)/);
  assert.match(editorCss, /\.editor-git-diff-active \.line-removed\s*\{[\s\S]*?var\(--diff-focus-removed-bg\)[\s\S]*?inset 2px 0 0 var\(--git-deleted\)/);
  assert.match(editorCss, /\.editor-git-diff-active \.line-number-added::after\s*\{[\s\S]*?content:\s*"\+"/);
  assert.match(editorCss, /\.editor-git-diff-active \.line-number-removed::after\s*\{[\s\S]*?content:\s*"−"/);
  assert.doesNotMatch(editorCss, /\.editor-git-diff-active \.line-unchanged\s*\{[^}]*color:/s,
    "syntax colors must not be replaced for context lines");
});


test("Keyboard multi-cursor actions are refused in a diff view", () => {
  const file = { isDiffView: true, type: undefined };
  const multi = new MultiCursorController({
    tabManager: { activeFile: file },
  });
  assert.equal(multi.isEligible(file), false);
  assert.equal(multi.addCursor({ row: 1, column: 0 }), false);
  assert.equal(multi.addCursorAtClientCoordinates(10, 10), false);
  assert.equal(multi.addCursorsVertically(1), false);
  assert.equal(multi.addNextOccurrence(), false);
  assert.equal(multi.selectAllOccurrences(), false);
  assert.equal(multi.renderedCarets, 0);
});

test("Diff display indexes are mapped once per diffRows model", () => {
  const controller = Object.create(LineController.prototype);
  controller.diffDisplayIndexRows = null;
  controller.diffDisplayIndexMap = null;
  const rows = [
    { type: "unchanged", documentIndex: 0 },
    { type: "removed", documentIndex: null },
    { type: "added", documentIndex: 1 },
    { type: "unchanged", documentIndex: 2 },
  ];
  controller.editor = { tabManager: { activeFile: { diffRows: rows } } };
  assert.equal(controller.getDisplayIndexForDocument(1), 2);
  assert.equal(controller.getDisplayIndexForDocument(9), 9);
  const mappedRows = controller.diffDisplayIndexRows;
  controller.getDisplayIndexForDocument(2);
  assert.equal(controller.diffDisplayIndexRows, mappedRows, "the index is cached per model");
  controller.editor.tabManager.activeFile.diffRows =
    [{ type: "added", documentIndex: 0 }, { type: "unchanged", documentIndex: 1 }];
  assert.equal(controller.getDisplayIndexForDocument(1), 1);
  assert.notEqual(controller.diffDisplayIndexRows, mappedRows, "a new model rebuilds the index");
});

test("LineController mutators are inert on a diff buffer", () => {
  const controller = Object.create(LineController.prototype);
  let touched = false;
  controller.editor = {
    tabManager: { activeFile: { isDiffView: true } },
    lineController: {},
  };
  Object.defineProperty(controller, "lines", {
    get() { touched = true; return []; },
  });
  assert.equal(controller.addLine("x", 0), undefined);
  assert.equal(controller.changeLine("x", 0), undefined);
  assert.equal(controller.supLine(0), undefined);
  assert.equal(touched, false);
});

function createOpenFilesHarness(tabs, activeTab) {
  const TabManager = loadGlobal("src/js/manager/TabManager.js", "tabManager", {
    TAB_TYPES: { FILE: "file", GIT_DIFF: "git-diff", PICTURE: "picture" },
    PictureView: { isSupportedPath: () => false },
    Events: { ON_OPEN_FILE: "onOpen" },
    NCEPath: { equals: (a, b) => a === b },
  });
  const focused = [];
  const manager = Object.assign(Object.create(TabManager.prototype), {
    tabs,
    activeTab,
    editor: { events: { callEvent() {} }, refreshAll() {} },
    async setFocusTab(tab) { this.activeTab = tab; focused.push(tab); },
  });
  return { manager, focused };
}

test("opening a file never replaces an active diff buffer, even an empty one", async () => {
  // A pure-deletion diff has an empty document; it must not be mistaken for
  // the empty untitled buffer that openFiles replaces in place.
  const diffBuffer = {
    id: 3, type: "file", path: null, isDiffView: true, isLoaded: true,
    hasPath() { return Boolean(this.path); },
    isEmpty() { return true; },
    replaceFile() { assert.fail("a diff buffer must never be replaced in place"); },
  };
  const diffTab = { id: 4, type: "git-diff", filePath: "/workspace/deleted.js", textTab: diffBuffer };
  const { manager, focused } = createOpenFilesHarness([diffTab], diffTab);
  const file = {
    id: 5, type: "file", path: "/workspace/file.js", language: "javascript",
    hasPath() { return true; },
    isEmpty() { return false; },
  };
  const opened = await manager.openFiles([file]);
  assert.equal(opened, file, "the opened file is returned, not the diff buffer");
  assert.deepEqual(manager.tabs, [diffTab, file], "the file gets its own tab");
  assert.equal(manager.activeTab, file);
  assert.deepEqual(focused, [file]);
  assert.equal(diffBuffer.path, null, "the diff buffer keeps its identity");
  assert.equal(manager.activeFile, file, "activeFile resolves to a real tab");
});

test("opening a file still replaces the empty untitled file tab in place", async () => {
  const untitled = {
    id: 1, type: "file", path: null,
    hasPath() { return Boolean(this.path); },
    isEmpty() { return true; },
    replaceFile(file) { this.path = file.path; },
  };
  const { manager } = createOpenFilesHarness([untitled], untitled);
  const file = {
    id: 5, type: "file", path: "/workspace/file.js", language: "javascript",
    hasPath() { return true; },
    isEmpty() { return false; },
  };
  const opened = await manager.openFiles([file]);
  assert.equal(opened, untitled, "the untitled tab is reused");
  assert.equal(manager.tabs.length, 1);
  assert.equal(untitled.path, "/workspace/file.js");
});
