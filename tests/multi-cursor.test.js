const assert = require("node:assert/strict");
const test = require("node:test");
const { createEditor, loadGlobal } = require("./helpers/runtime");

const LineNode = loadGlobal("src/js/types/Line.js", "LineNode");
const TextPositions = loadGlobal("src/js/core/Tools.js", "NCETextPosition", {
  SETTINGS_GET: () => 4,
});
const MultiCursorController = loadGlobal(
  "src/js/controller/MultiCursorController.js",
  "MultiCursorController",
  {
    Events: { CURSOR_CHANGE: "cursorChange", ON_SELECT: "select" },
    normalizeTextBoundary: TextPositions.normalizeTextBoundary,
    previousGraphemeBoundary: TextPositions.previousGraphemeBoundary,
    nextGraphemeBoundary: TextPositions.nextGraphemeBoundary,
  },
);
const WriterController = loadGlobal(
  "src/js/controller/WriterController.js",
  "WriterController",
  {
    LineNode,
    Events: { ON_CHANGE: "change" },
    previousGraphemeBoundary: TextPositions.previousGraphemeBoundary,
    nextGraphemeBoundary: TextPositions.nextGraphemeBoundary,
  },
);
const HistoryController = loadGlobal(
  "src/js/controller/HistoryController.js",
  "HistoryController",
  { Events: { ON_CHANGE: "change" } },
);
const SmartTypingController = loadGlobal(
  "src/js/controller/SmartTypingController.js",
  "SmartTypingController",
  { SETTINGS_GET: () => 2 },
);
const clipboardState = { text: "" };
const KeyBinding = loadGlobal("src/js/addon/KeyBinding.js", "KeyBinding", {
  document: { hasFocus: () => true },
  navigator: { clipboard: { writeText: async (text) => { clipboardState.text = text; } } },
  window: { api: {} },
});

function setup(source = "") {
  const { editor, file } = createEditor(source);
  file.eol = "\n";
  file.lineEndings = Array(Math.max(0, file.lines.length - 1)).fill("\n");
  file.editVersion = 0;
  file.largeFileMode = false;
  editor.multiCursorController = new MultiCursorController(editor);
  editor.writerController = new WriterController(editor);
  editor.historyController = new HistoryController(editor);
  editor.smartTypingController = new SmartTypingController(editor);
  editor.lineController.syncLineLengthsForBatch = () => {};
  editor.lineController.getDisplayLineCount = () => file.lines.length;
  editor.lineController.renderedLineCount = 20;
  editor.lineController.startIndex = 0;
  editor.cursorController.getViewPosition = (row, column) => ({ row, column });
  editor.cursorController.positionFromClientCoordinates = () => null;
  editor.cursorController.ensureCursorVisible = () => {};
  editor.selectController.refreshSelectionDOM = () => {};
  return { editor, file };
}

function content(file) {
  return file.lines.map((line) => line.getText()).join("\n");
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function setCarets(editor, positions) {
  editor.multiCursorController.setSelections(
    positions.map((position, index) => ({
      id: index + 1,
      anchor: { ...position },
      active: { ...position },
      preferredVisualColumn: null,
    })),
    { primaryId: 1, render: false },
  );
}

test("batch typing edits many positions with one event, refresh and revision", () => {
  const { editor, file } = setup("abcd\nefgh");
  setCarets(editor, [
    { row: 1, column: 1 },
    { row: 1, column: 3 },
    { row: 2, column: 2 },
  ]);
  let refreshes = 0;
  editor.lineController.refresh = () => refreshes++;

  editor.writerController.write("X");

  assert.equal(content(file), "aXbcXd\nefXgh");
  assert.equal(file.editVersion, 1);
  assert.equal(editor.events.calls.filter(({ name }) => name === "change").length, 1);
  assert.equal(refreshes, 1);
  assert.deepEqual(
    plain(editor.multiCursorController.getSelections().map(({ active }) => active)),
    [
      { row: 1, column: 2 },
      { row: 1, column: 5 },
      { row: 2, column: 3 },
    ],
  );
});

test("same-line edits are planned against the original text", () => {
  const { editor, file } = setup("0123456789");
  setCarets(editor, [{ row: 1, column: 2 }, { row: 1, column: 7 }]);
  editor.writerController.write("ABCDE");
  assert.equal(content(file), "01ABCDE23456ABCDE789");
});

test("overlapping batch edits are rejected without partial document changes", () => {
  const { editor, file } = setup("abcdef");
  const beforeVersion = file.editVersion;
  const result = editor.writerController.applyBatchEdits([
    { start: { row: 1, column: 1 }, end: { row: 1, column: 4 }, text: "X" },
    { start: { row: 1, column: 3 }, end: { row: 1, column: 5 }, text: "Y" },
  ]);
  assert.equal(result, null);
  assert.equal(content(file), "abcdef");
  assert.equal(file.editVersion, beforeVersion);
});

test("normalization deduplicates carets, merges overlaps and keeps adjacent selections", () => {
  const { editor } = setup("abcdef");
  editor.multiCursorController.setSelections([
    { id: 1, anchor: { row: 1, column: 1 }, active: { row: 1, column: 3 } },
    { id: 2, anchor: { row: 1, column: 4 }, active: { row: 1, column: 2 } },
    { id: 3, anchor: { row: 1, column: 5 }, active: { row: 1, column: 6 } },
    { id: 4, anchor: { row: 1, column: 6 }, active: { row: 1, column: 6 } },
    { id: 5, anchor: { row: 1, column: 6 }, active: { row: 1, column: 6 } },
  ], { primaryId: 2, render: false });
  const selections = plain(editor.multiCursorController.getSelections());
  assert.equal(selections.length, 2);
  assert.equal(editor.multiCursorController.getPrimarySelection().id, 2);
  assert.deepEqual(selections[0].anchor, { row: 1, column: 4 });
  assert.deepEqual(selections[0].active, { row: 1, column: 1 });
  assert.deepEqual(selections[1].anchor, { row: 1, column: 5 });
  assert.deepEqual(selections[1].active, { row: 1, column: 6 });
});

test("cursor positions normalize to Unicode grapheme boundaries", () => {
  const { editor } = setup("A😀e\u0301B");
  editor.multiCursorController.setSelections([
    { id: 7, anchor: { row: 1, column: 2 }, active: { row: 1, column: 2 } },
    { id: 8, anchor: { row: 1, column: 4 }, active: { row: 1, column: 4 } },
  ], { primaryId: 7, render: false });
  const selections = plain(editor.multiCursorController.getSelections());
  assert.equal(selections[0].active.column, 1);
  assert.equal(selections[1].active.column, 3);
});

test("multi-cursor state belongs to each file object", () => {
  const { editor, file } = setup("first\nsecond");
  setCarets(editor, [{ row: 1, column: 2 }, { row: 2, column: 3 }]);
  const other = {
    ...file,
    id: 2,
    lines: [new LineNode("other")],
    row: 1,
    column: 0,
    _multiSelections: null,
    _multiCursorPrimaryId: null,
    _multiCursorNextId: 1,
  };
  editor.tabManager.activeFile = other;
  editor.multiCursorController.setSelections([
    { id: 1, anchor: { row: 1, column: 1 }, active: { row: 1, column: 1 } },
  ], { primaryId: 1, render: false });
  editor.tabManager.activeFile = file;
  assert.equal(editor.multiCursorController.getSelections().length, 2);
  assert.deepEqual(
    plain(editor.multiCursorController.getSelections().map(({ active }) => active)),
    [{ row: 1, column: 2 }, { row: 2, column: 3 }],
  );
});

test("batch undo and redo are one transaction and restore selections", async () => {
  const { editor, file } = setup("first\nsecond");
  setCarets(editor, [{ row: 1, column: 5 }, { row: 2, column: 6 }]);
  const before = editor.multiCursorController.getSelections().map((selection) => ({
    id: selection.id,
    anchor: { ...selection.anchor },
    active: { ...selection.active },
  }));

  editor.writerController.write("!");
  assert.equal(content(file), "first!\nsecond!");
  assert.equal(editor.historyController.getState(file).entries.length, 1);
  assert.equal(await editor.historyController.undo(), true);
  assert.equal(content(file), "first\nsecond");
  assert.deepEqual(
    plain(editor.multiCursorController.getSelections().map(({ id, anchor, active }) => ({ id, anchor, active }))),
    plain(before),
  );
  assert.equal(await editor.historyController.redo(), true);
  assert.equal(content(file), "first!\nsecond!");
});

test("consecutive multi-cursor typing groups and undoes atomically", async () => {
  const { editor, file } = setup("\n");
  setCarets(editor, [{ row: 1, column: 0 }, { row: 2, column: 0 }]);
  editor.writerController.write("a");
  editor.writerController.write("b");
  assert.equal(content(file), "ab\nab");
  assert.equal(editor.historyController.getState(file).entries.length, 1);
  assert.equal(await editor.historyController.undo(), true);
  assert.equal(content(file), "\n");
});

test("same-line multi-cursor typing grouping undoes original coordinates", async () => {
  const { editor, file } = setup("----");
  setCarets(editor, [{ row: 1, column: 0 }, { row: 1, column: 3 }]);
  editor.writerController.write("a");
  editor.writerController.write("b");
  assert.equal(content(file), "ab---ab-");
  assert.equal(editor.historyController.getState(file).entries.length, 1);
  assert.equal(await editor.historyController.undo(), true);
  assert.equal(content(file), "----");
});

test("typing after an auto-pair does not corrupt grouped undo text", async () => {
  const { editor, file } = setup("z");
  setCarets(editor, [{ row: 1, column: 0 }, { row: 1, column: 1 }]);
  assert.equal(editor.smartTypingController.handleCharacter("(", {}), true);
  editor.writerController.write("x");
  assert.equal(content(file), "(x)z(x)");
  assert.equal(editor.historyController.getState(file).entries.length, 2);
  assert.equal(await editor.historyController.undo(), true);
  assert.equal(content(file), "()z()");
  assert.equal(await editor.historyController.undo(), true);
  assert.equal(content(file), "z");
});

test("typing after skipping a closing character does not group a no-op edit", async () => {
  const { editor, file } = setup(")\nx");
  setCarets(editor, [{ row: 1, column: 0 }, { row: 2, column: 0 }]);
  assert.equal(editor.smartTypingController.handleCharacter(")", {}), true);
  assert.equal(content(file), ")\n)x");
  editor.writerController.write("y");
  assert.equal(content(file), ")y\n)yx");
  assert.equal(editor.historyController.getState(file).entries.length, 2);
  assert.equal(await editor.historyController.undo(), true);
  assert.equal(content(file), ")\n)x");
  assert.equal(await editor.historyController.undo(), true);
  assert.equal(content(file), ")\nx");
});

test("batch insertion keeps CRLF separators and updates one revision", () => {
  const { editor, file } = setup("aa\nbb");
  file.eol = "\r\n";
  file.lineEndings = ["\r\n"];
  setCarets(editor, [{ row: 1, column: 1 }, { row: 2, column: 1 }]);
  editor.writerController.write("\nX");
  assert.equal(content(file), "a\nXa\nb\nXb");
  assert.deepEqual(file.lineEndings, ["\r\n", "\r\n", "\r\n"]);
  assert.equal(file.editVersion, 1);
});

test("multi-cursor Backspace and Delete remove graphemes in one batch", () => {
  const { editor, file } = setup("A😀B\nC👍🏻D");
  setCarets(editor, [{ row: 1, column: 3 }, { row: 2, column: 5 }]);
  editor.writerController.deleteBackwardAtSelections();
  assert.equal(content(file), "AB\nCD");
  editor.writerController.deleteForwardAtSelections();
  assert.equal(content(file), "A\nC");
  assert.equal(editor.historyController.getState(file).entries.length, 2);
});

test("Smart Typing inserts pairs independently and keeps each caret inside", () => {
  const { editor, file } = setup("one\ntwo");
  setCarets(editor, [{ row: 1, column: 1 }, { row: 2, column: 1 }]);
  assert.equal(editor.smartTypingController.handleCharacter("(", {}), true);
  assert.equal(content(file), "o()ne\nt()wo");
  assert.deepEqual(
    plain(editor.multiCursorController.getSelections().map(({ active }) => active)),
    [{ row: 1, column: 2 }, { row: 2, column: 2 }],
  );
});

test("multiline paste adapts indentation at each caret", () => {
  const { editor, file } = setup("  first\n    second");
  setCarets(editor, [{ row: 1, column: 7 }, { row: 2, column: 10 }]);
  assert.equal(editor.smartTypingController.handlePaste("  A\n    B"), true);
  assert.equal(content(file), "  firstA\n    B\n    secondA\n      B");
  assert.equal(editor.historyController.getState(file).entries.length, 1);
});

test("Enter applies each caret's indentation in one transaction", async () => {
  const { editor, file } = setup("  if {\nvalue");
  setCarets(editor, [{ row: 1, column: 6 }, { row: 2, column: 5 }]);
  assert.equal(editor.smartTypingController.handleEnter({}), true);
  assert.equal(content(file), "  if {\n    \nvalue\n");
  assert.equal(editor.historyController.getState(file).entries.length, 1);
  assert.equal(await editor.historyController.undo(), true);
  assert.equal(content(file), "  if {\nvalue");
});

test("next occurrence wraps without selecting the current word twice", () => {
  const { editor } = setup("foo foo foo");
  setCarets(editor, [{ row: 1, column: 0 }]);
  editor.multiCursorController.setSelections([
    { id: 1, anchor: { row: 1, column: 0 }, active: { row: 1, column: 3 } },
  ], { primaryId: 1, render: false });
  assert.equal(editor.multiCursorController.addNextOccurrence(), true);
  assert.equal(editor.multiCursorController.getSelections().length, 2);
  assert.deepEqual(
    plain(editor.multiCursorController.getSelections().map(({ anchor, active }) => ({ anchor, active }))),
    [
      { anchor: { row: 1, column: 0 }, active: { row: 1, column: 3 } },
      { anchor: { row: 1, column: 4 }, active: { row: 1, column: 7 } },
    ],
  );
  assert.equal(editor.multiCursorController.addNextOccurrence(), true);
  assert.equal(editor.multiCursorController.addNextOccurrence(), false);
  assert.equal(editor.multiCursorController.getSelections().length, 3);
});

test("Copy and Cut join selections in document order and cut transactionally", async () => {
  const { editor, file } = setup("one two one");
  clipboardState.text = "";
  editor.multiCursorController.setSelections([
    { id: 1, anchor: { row: 1, column: 0 }, active: { row: 1, column: 3 } },
    { id: 2, anchor: { row: 1, column: 8 }, active: { row: 1, column: 11 } },
  ], { primaryId: 1, render: false });
  const testKeyBinding = Object.create(KeyBinding.prototype);
  testKeyBinding.editor = editor;
  assert.equal(testKeyBinding.getClipboardText(), "one\none");
  assert.equal(await testKeyBinding.control_cut(), true);
  assert.equal(clipboardState.text, "one\none");
  assert.equal(content(file), " two ");
  assert.equal(editor.historyController.getState(file).entries.length, 1);
  assert.equal(await editor.historyController.undo(), true);
  assert.equal(content(file), "one two one");
});

test("multiline selection Tab and Shift+Tab update all selected rows", async () => {
  const { editor, file } = setup("  one\n  two\nthree");
  editor.multiCursorController.setSelections([
    { id: 1, anchor: { row: 1, column: 0 }, active: { row: 2, column: 3 } },
    { id: 2, anchor: { row: 3, column: 0 }, active: { row: 3, column: 0 } },
  ], { primaryId: 1, render: false });
  assert.equal(editor.smartTypingController.handleTab(false, {}), true);
  assert.equal(content(file), "    one\n    two\nthree");
  assert.equal(await editor.historyController.undo(), true);
  assert.equal(content(file), "  one\n  two\nthree");
  assert.equal(editor.smartTypingController.handleTab(true, {}), true);
  assert.equal(content(file), "one\ntwo\nthree");
});
