const assert = require("node:assert/strict");
const test = require("node:test");
const { createEditor, loadGlobal } = require("./helpers/runtime");

function setup(text = "") {
  const { editor, file } = createEditor(text);
  const WriterController = loadGlobal("src/js/controller/WriterController.js", "WriterController", {
    LineNode: loadGlobal("src/js/types/Line.js", "LineNode"),
    Events: { ON_CHANGE: "onChange" },
  });
  const HistoryController = loadGlobal("src/js/controller/HistoryController.js", "HistoryController", {
    Events: { ON_CHANGE: "onChange" },
  });
  editor.writerController = new WriterController(editor);
  editor.historyController = new HistoryController(editor);
  return { editor, file };
}

function text(file) {
  return file.lines.map((line) => line.getText()).join("\n");
}

test("writer inserts text and emits complete NSH line mapping", () => {
  const { editor, file } = setup("hello");
  editor.cursorController.setCursorPosition(1, 5);
  editor.writerController.write(" world");
  assert.equal(text(file), "hello world");
  const change = editor.events.calls.at(-1).payload;
  assert.equal(JSON.stringify(change.nshUpdate), JSON.stringify({
    startLine: 0,
    deletedLines: 1,
    insertedLines: ["hello world"],
  }));
});

test("writer handles multiline insertion, deletion, join, and replacement", () => {
  const { editor, file } = setup("hello world\nthird");
  editor.writerController.replaceRange("NCE\nworks", 1, 6, 1, 11);
  assert.equal(text(file), "hello NCE\nworks\nthird");
  editor.writerController.deleteRange({ row: 1, column: 6 }, { row: 2, column: 0 });
  assert.equal(text(file), "hello works\nthird");
  editor.writerController.deleteRange({ row: 1, column: 11 }, { row: 2, column: 0 });
  assert.equal(text(file), "hello worksthird");
});

test("history supports undo, redo, save points, and redo invalidation", async () => {
  const { editor, file } = setup("");
  editor.writerController.write("A");
  editor.historyController.markSaved(file);
  editor.writerController.write("B");
  assert.equal(text(file), "AB");
  assert.equal(file.isSaved, false);
  await editor.historyController.undo();
  assert.equal(text(file), "A");
  assert.equal(file.isSaved, true);
  await editor.historyController.redo();
  assert.equal(text(file), "AB");
  await editor.historyController.undo();
  editor.writerController.write("C");
  assert.equal(await editor.historyController.redo(), false);
  assert.equal(text(file), "AC");
});

test("history is isolated by file object", async () => {
  const { editor, file } = setup("");
  editor.writerController.write("A");
  const LineNode = loadGlobal("src/js/types/Line.js", "LineNode");
  const second = { ...file, id: 2, lines: [new LineNode("")], row: 1, column: 0, isSaved: true };
  editor.tabManager.activeFile = second;
  editor.writerController.write("B");
  await editor.historyController.undo();
  assert.equal(text(second), "");
  editor.tabManager.activeFile = file;
  assert.equal(text(file), "A");
  assert.equal(editor.historyController.canUndo(file), true);
});

test("writer splitWord and range text preserve editor semantics", () => {
  const { editor } = setup("one two\nthree");
  assert.equal(JSON.stringify(Array.from(editor.writerController.splitWord("one + two"))), JSON.stringify(["one", " ", "+", " ", "two"]));
  assert.equal(editor.writerController.getTextInRange({ row: 1, column: 4 }, { row: 2, column: 3 }), "two\nthr");
});

test("smart typing inserts pairs, skips closing characters, and removes pairs", () => {
  const { editor, file } = setup("");
  const SmartTypingController = loadGlobal("src/js/controller/SmartTypingController.js", "SmartTypingController", {
    CONFIG_GET: () => 2,
  });
  const smart = new SmartTypingController(editor);
  assert.equal(smart.handleCharacter("(", {}), true);
  assert.equal(text(file), "()");
  assert.equal(file.column, 1);
  assert.equal(smart.handleCharacter(")", {}), true);
  assert.equal(file.column, 2);
  file.column = 1;
  assert.equal(smart.handleBackspace({}), true);
  assert.equal(text(file), "");
});

test("smart typing handles structural enter and multiline paste", () => {
  const { editor, file } = setup("{}");
  const SmartTypingController = loadGlobal("src/js/controller/SmartTypingController.js", "SmartTypingController", {
    CONFIG_GET: () => 2,
  });
  const smart = new SmartTypingController(editor);
  editor.cursorController.setCursorPosition(1, 1);
  assert.equal(smart.handleEnter({}), true);
  assert.equal(text(file), "{\n  \n}");
  editor.cursorController.setCursorPosition(2, 2);
  assert.equal(smart.handlePaste("a\n  b", {}), true);
  assert.match(text(file), /a\n    b/);
});
