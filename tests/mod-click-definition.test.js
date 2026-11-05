const assert = require("node:assert/strict");
const test = require("node:test");
const { createEditor, loadGlobal } = require("./helpers/runtime");

function setup({ platform = "win32", api = {}, clickColumn = 2 } = {}) {
  const { editor, file } = createEditor("const value = 1;\nvalue");
  const LspPositions = loadGlobal("src/js/lsp/LspPositions.js", "LspPositions");
  const SelectController = loadGlobal(
    "src/js/controller/SelectController.js",
    "SelectController",
    {
      addEvent() {},
      Events: { ON_SELECT: "select" },
      document: {},
      LspPositions,
    },
  );
  editor.api = { platform };
  file._selectedLines = new Map();
  file._selectionRange = null;
  file._selectionTextCache = null;
  const selection = new SelectController(editor);
  editor.selectController = selection;
  const clicks = [];
  editor.cursorController.onClick = (event) => {
    const position = { row: 2, column: clickColumn };
    file.row = position.row;
    file.column = position.column;
    clicks.push(event);
    return position;
  };
  let definitions = 0;
  editor.lspController = {
    api,
    definition() {
      definitions += 1;
      return Promise.resolve([]);
    },
  };
  return { editor, file, selection, clicks, definitions: () => definitions };
}

test("primary-modifier click places the caret and runs Go to Definition", () => {
  const state = setup();
  let prevented = 0;
  let stopped = 0;

  state.selection.mouseDown({
    button: 0,
    ctrlKey: true,
    clientX: 40,
    clientY: 23,
    preventDefault() {
      prevented += 1;
    },
    stopPropagation() {
      stopped += 1;
    },
  });

  assert.equal(state.clicks.length, 1);
  assert.equal(state.definitions(), 1);
  assert.equal(state.file.row, 2);
  assert.equal(state.file.column, 2);
  assert.deepEqual({ ...state.selection.startSelect }, { row: 2, column: 2 });
  assert.deepEqual({ ...state.selection.endSelect }, { row: 2, column: 2 });
  assert.equal(state.file.isMouseDown, undefined);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
});

test("definition click snaps an end-of-word position inside the word", () => {
  const state = setup({ clickColumn: 5 });

  state.selection.mouseDown({ button: 0, ctrlKey: true });

  assert.equal(state.definitions(), 1);
  assert.equal(state.file.column, 4);
  assert.deepEqual({ ...state.selection.startSelect }, { row: 2, column: 4 });
});

test("definition click on whitespace places the caret without a request", () => {
  const state = setup({ clickColumn: 7 });
  state.file.lines[1].setText("value  ");

  state.selection.mouseDown({ button: 0, ctrlKey: true });

  assert.equal(state.definitions(), 0);
  assert.equal(state.file.column, 7);
});

test("Go to Definition click follows the platform primary modifier", () => {
  const mac = setup({ platform: "darwin" });
  mac.selection.mouseDown({ button: 0, ctrlKey: true });
  assert.equal(mac.definitions(), 0);

  mac.selection.mouseDown({ button: 0, metaKey: true });
  assert.equal(mac.definitions(), 1);

  const windows = setup({ platform: "win32" });
  windows.selection.mouseDown({ button: 0, metaKey: true });
  assert.equal(windows.definitions(), 0);
});

test("modifier click without a language server keeps normal click behavior", () => {
  const state = setup({ api: null });
  let prevented = 0;

  state.selection.mouseDown({
    button: 0,
    ctrlKey: true,
    preventDefault() {
      prevented += 1;
    },
  });

  assert.equal(state.definitions(), 0);
  assert.equal(state.clicks.length, 1);
  assert.equal(state.file.isMouseDown, true);
  assert.equal(prevented, 0);
});

test("shift or alt click never triggers Go to Definition", () => {
  const shift = setup();
  shift.selection.mouseDown({ button: 0, ctrlKey: true, shiftKey: true });
  assert.equal(shift.definitions(), 0);

  const alt = setup();
  alt.selection.mouseDown({ button: 0, ctrlKey: true, altKey: true });
  assert.equal(alt.definitions(), 0);
});
