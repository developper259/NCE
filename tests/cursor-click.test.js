const assert = require("node:assert/strict");
const test = require("node:test");
const { createEditor, loadGlobal } = require("./helpers/runtime");

const DEFAULT_LINE_HEIGHT = 23;

function createCursor(text, options = {}) {
  const { editor, file } = createEditor(text);
  const lineController = editor.lineController;
  const lineHeight = options.lineHeight || DEFAULT_LINE_HEIGHT;
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
  editor.posY = lineHeight;
  lineController.offsetX = options.offsetX || 0;
  lineController.offsetY = scrollOffset;
  lineController.startIndex = scrollStart;
  if (options.renderStart !== undefined) {
    Object.defineProperty(lineController, "renderStartIndex", {
      configurable: true,
      get: () => options.renderStart,
    });
  }
  // Mouse Y is measured in viewport-local CSS pixels.  Add the current scroll
  // offset before converting to a display row, using the same measured height
  // as the production LineController.
  lineController.getScrollOffsetY = () =>
    scrollStart * lineHeight + scrollOffset;
  lineController.getDisplayLineCount = () =>
    displayRows ? displayRows.length : lineController.lines.length;
  lineController.getLineHeight = () => lineHeight;
  lineController.getDisplayRow = (index) =>
    displayRows
      ? displayRows[index] || null
      : lineController.lines[index]
        ? { documentIndex: index }
        : null;
  lineController.getDisplayIndexForCursor = (row) => row - 1;
  lineController.getLineTop = (screenRow) => screenRow * lineHeight;
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
      clientY: outputRect.top + (screenRow + 0.5) * lineHeight,
    });
  }

  function clickAtLocalY(localY, x = outputRect.left + 20) {
    return cursor.onClick({
      clientX: x,
      clientY: outputRect.top + localY,
    });
  }

  return { clickAtLocalY, clickAtScreenRow, cursor, editor, file };
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

test("caret geometry includes the overscan window offset", () => {
  const lineHeight = 23;
  const { cursor } = createCursor("one\ntwo\nthree\nfour", {
    scrollStart: 2,
    scrollOffset: 4,
    renderStart: 0,
    lineHeight,
  });

  // Row 4 is screen row 3 of a window that starts two rows above startIndex.
  assert.equal(cursor.rowToY(4), (0 - 2) * lineHeight + 3 * lineHeight + 4);
  const position = cursor.getCaretPosition(4, 0);
  assert.equal(
    position.top,
    (0 - 2) * lineHeight + 3 * lineHeight - 4,
    "the caret follows the translated overscan window",
  );
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

test("mouse mapping uses measured line height and fractional scroll in viewport coordinates", () => {
  const { clickAtLocalY, file } = createCursor("one\ntwo\nthree\nfour", {
    lineHeight: 31,
    scrollStart: 1,
    scrollOffset: 8.5,
  });

  // 22 CSS px locally plus the 39.5 px scroll position lands in display row 1.
  const position = clickAtLocalY(22);

  assert.equal(position.row, 2);
  assert.equal(file.row, 2);
});

test("mouse row boundaries use the viewport top edge and the next line height", () => {
  const { clickAtLocalY } = createCursor("first\nsecond\nthird", {
    lineHeight: 30,
  });

  assert.equal(clickAtLocalY(0).row, 1);
  assert.equal(clickAtLocalY(29.999).row, 1);
  assert.equal(clickAtLocalY(30).row, 2);
});
