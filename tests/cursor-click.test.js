const assert = require("node:assert/strict");
const test = require("node:test");
const { createEditor, loadGlobal } = require("./helpers/runtime");

const LINE_HEIGHT = 23;

function createCursor(text, options = {}) {
  const { editor, file } = createEditor(text);
  const lineController = editor.lineController;
  const displayRows = options.displayRows || null;
  const scrollStart = options.scrollStart || 0;
  const scrollOffset = options.scrollOffset || 0;
  const outputRect = {
    left: 100,
    top: 40,
    right: 500,
    bottom: 540,
    width: 400,
    height: 500,
  };

  editor.domManager.getOutputRect = () => outputRect;
  lineController.offsetX = options.offsetX || 0;
  lineController.offsetY = scrollOffset;
  lineController.startIndex = scrollStart;
  lineController.getScrollOffsetY = () =>
    scrollStart * LINE_HEIGHT + scrollOffset;
  lineController.getDisplayLineCount = () =>
    displayRows ? displayRows.length : lineController.lines.length;
  lineController.getDisplayRow = (index) =>
    displayRows
      ? displayRows[index] || null
      : lineController.lines[index]
        ? { documentIndex: index }
        : null;
  lineController.getDisplayIndexForCursor = (row) => row - 1;
  lineController.getLineTop = (screenRow) => screenRow * LINE_HEIGHT;
  lineController.getViewportHeight = () => 500;
  lineController.maxViewLines = 20;
  lineController.setFocusLine = () => {};

  const CursorController = loadGlobal(
    "src/js/controller/CursorController.js",
    "CursorController",
    {
      Events: { CURSOR_CHANGE: "cursor-change" },
      roundX: Math.round,
      roundY: Math.round,
      realColumnToViewColumn: (_line, column) => column,
      viewColumnToRealColumn: (_line, column) => column,
    },
  );
  const cursor = new CursorController(editor);
  editor.cursorController = cursor;

  function clickAtScreenRow(screenRow, x = outputRect.left + 20) {
    return cursor.onClick({
      clientX: x,
      clientY:
        outputRect.top + cursor.mY + editor.baseY + screenRow * LINE_HEIGHT,
    });
  }

  return { clickAtScreenRow, cursor, editor, file };
}

test("clicking below the final line moves to its last column", () => {
  const { clickAtScreenRow, file } = createCursor("first\nsecond\nfinal");

  const position = clickAtScreenRow(5);

  assert.equal(position.row, 3);
  assert.equal(position.column, 5);
  assert.equal(file.row, 3);
  assert.equal(file.column, 5);
});

test("clicking on the final line still uses the clicked horizontal position", () => {
  const { clickAtScreenRow, file } = createCursor("first\nsecond\nfinal");

  const position = clickAtScreenRow(2);

  assert.equal(position.row, 3);
  assert.equal(position.column, 2);
  assert.equal(file.column, 2);
});

test("clicking below the final line works after vertical scrolling", () => {
  const { clickAtScreenRow, file } = createCursor("one\ntwo\nthree\nfinal", {
    scrollStart: 2,
    scrollOffset: 4,
  });

  const position = clickAtScreenRow(2);

  assert.equal(position.row, 4);
  assert.equal(position.column, 5);
  assert.equal(file.row, 4);
  assert.equal(file.column, 5);
});

test("clicking below an empty document stays on its single empty line", () => {
  const { clickAtScreenRow, file } = createCursor("");

  const position = clickAtScreenRow(3);

  assert.equal(position.row, 1);
  assert.equal(position.column, 0);
  assert.equal(file.row, 1);
  assert.equal(file.column, 0);
});

test("clicking below a horizontally scrolled long line goes to its true end", () => {
  const { clickAtScreenRow, file } = createCursor("prefix\nabcdefghij", {
    offsetX: 5,
  });

  const position = clickAtScreenRow(3);

  assert.equal(position.row, 2);
  assert.equal(position.column, 10);
  assert.equal(file.column, 10);
});

test("clicking below trailing diff rows lands at the last document position", () => {
  const displayRows = [
    { type: "unchanged", text: "first", documentIndex: 0 },
    { type: "unchanged", text: "final", documentIndex: 1 },
    { type: "removed", text: "old trailing row", documentIndex: null },
  ];
  const { clickAtScreenRow, file } = createCursor("first\nfinal", {
    displayRows,
  });

  const position = clickAtScreenRow(4);

  assert.equal(position.row, 2);
  assert.equal(position.column, 5);
  assert.equal(file.row, 2);
  assert.equal(file.column, 5);
});
