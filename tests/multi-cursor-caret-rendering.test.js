const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createEditor, loadGlobal, root } = require("./helpers/runtime");

const TextPositionIndex = loadGlobal(
  "src/js/types/TextPositionIndex.js",
  "TextPositionIndex",
);
const normalizeBoundary = (text, column) =>
  Math.max(0, Math.min(column, text.length));
const glyphOffsets = [0, 8, 19, 31, 44, 53];

function makeElement() {
  return {
    className: "",
    style: {},
    appendChild(child) {
      (this.children ||= []).push(child);
      child.parentNode = this;
      return child;
    },
  };
}

function makeRenderedLine(text, baseX, documentIndex = 0) {
  return {
    textContent: text,
    textNode: { nodeValue: text },
    __nceRenderMeta: { documentIndex, startVisual: 0, endVisual: text.length },
    getBoundingClientRect() { return { left: baseX }; },
  };
}

function makeCursorDocument() {
  return {
    fonts: { status: "loaded" },
    createTreeWalker(element) {
      let visited = false;
      return {
        nextNode() {
          if (visited) return null;
          visited = true;
          return element.textNode;
        },
      };
    },
    createRange() {
      let textNode;
      let offset;
      return {
        setStart(node, at) { textNode = node; offset = at; },
        collapse() {},
        getBoundingClientRect() {
          assert.ok(textNode.nodeValue.length >= offset);
          return { left: 50 + glyphOffsets[offset] };
        },
      };
    },
  };
}

function makeMeasuredSetup(text = "abcde") {
  const { editor, file } = createEditor(text);
  file.largeFileMode = false;
  const lines = file.lines.map((line, index) =>
    makeRenderedLine(line.getText(), editor.baseX, index),
  );
  editor.output.children = lines;
  editor.domManager.getOutputRect = () => ({
    left: 100,
    top: 40,
    right: 500,
    bottom: 540,
    width: 400,
    height: 500,
  });
  editor.cD.className = "editor-caret";

  Object.assign(editor.lineController, {
    offsetX: 0,
    offsetY: 0,
    startIndex: 0,
    renderedLineCount: 20,
    maxCharactersPerLine: 100,
    getDisplayLineCount: () => file.lines.length,
    getDisplayRow: (index) => file.lines[index] ? { documentIndex: index } : null,
    getDisplayIndexForCursor: (row) => row - 1,
    getLineHeight: () => 23,
    getScrollOffsetY: () => 0,
    getLineTop: (screenRow) => screenRow * 23,
    setFocusLine: () => {},
  });

  const Cursor = loadGlobal(
    "src/js/controller/CursorController.js",
    "CursorController",
    {
      NodeFilter: { SHOW_TEXT: 4 },
      TextPositionIndex,
      SETTINGS_GET: () => 4,
      document: makeCursorDocument(),
      roundX: Math.round,
      roundY: Math.round,
      realColumnToViewColumn: (_value, column) => column,
      viewColumnToRealColumn: (_value, column) => column,
    },
  );
  editor.cursorController = new Cursor(editor);

  const caretOutput = makeElement();
  const selectionOutput = makeElement();
  editor.multiCursorCaretOutput = caretOutput;
  editor.multiCursorSelectionOutput = selectionOutput;
  const MultiCursor = loadGlobal(
    "src/js/controller/MultiCursorController.js",
    "MultiCursorController",
    {
      Events: { CURSOR_CHANGE: "cursor-change", ON_SELECT: "select" },
      normalizeTextBoundary: normalizeBoundary,
      previousGraphemeBoundary: (_value, column) => Math.max(0, column - 1),
      nextGraphemeBoundary: (value, column) => Math.min(value.length, column + 1),
      document: { createElement: makeElement },
    },
  );
  editor.multiCursorController = new MultiCursor(editor);
  editor.selectController.refreshSelectionDOM = () => {};
  return { editor, file, caretOutput, selectionOutput };
}

function setSelections(editor, selections) {
  editor.multiCursorController.setSelections(selections, {
    primaryId: 1,
    render: false,
  });
}

function px(value) {
  return Number.parseFloat(value);
}

test("Option-click maps the clicked visual row to the same document row", () => {
  const { editor } = makeMeasuredSetup("first\nsecond");

  assert.equal(
    editor.multiCursorController.addCursorAtClientCoordinates(120, 64),
    true,
  );

  const [primary, secondary] = editor.multiCursorController.getSelections();
  assert.equal(secondary.active.row, 2);
  assert.equal(secondary.active.column, 2);
  assert.equal(secondary.anchor.row, secondary.active.row);
  assert.equal(secondary.anchor.column, secondary.active.column);
  assert.equal(primary.active.row, 1);
  assert.equal(primary.active.column, 0);
});

test("primary and secondary carets share measured text boundaries and dimensions", () => {
  const { editor, caretOutput } = makeMeasuredSetup();
  setSelections(editor, [
    { id: 1, anchor: { row: 1, column: 1 }, active: { row: 1, column: 1 } },
    { id: 2, anchor: { row: 1, column: 4 }, active: { row: 1, column: 4 } },
  ]);
  const calls = [];
  const getCaretPosition = editor.cursorController.getCaretPosition.bind(
    editor.cursorController,
  );
  editor.cursorController.getCaretPosition = (row, column) => {
    calls.push({ row, column });
    return getCaretPosition(row, column);
  };

  editor.cursorController.updateCaretPosition();
  editor.multiCursorController.refreshOverlays();

  const primary = editor.cD;
  const secondary = caretOutput.children[0];
  assert.ok(calls.some(({ row, column }) => row === 1 && column === 1));
  assert.ok(calls.some(({ row, column }) => row === 1 && column === 4));
  assert.equal(px(primary.style.left) + px(primary.style.marginLeft), 58);
  assert.equal(px(secondary.style.left) + px(secondary.style.marginLeft), 94);
  assert.equal(px(secondary.style.top), px(primary.style.top));
  assert.equal(px(secondary.style.width), 2);
  assert.equal(px(secondary.style.height), editor.posY);
  assert.ok(secondary.className.split(/\s+/).includes("editor-caret"));
  assert.ok(secondary.className.split(/\s+/).includes("editor-secondary-caret"));
});

test("Shift+Arrow keeps the secondary caret visible and aligns its selection", () => {
  const { editor, caretOutput, selectionOutput } = makeMeasuredSetup();
  setSelections(editor, [
    { id: 1, anchor: { row: 1, column: 0 }, active: { row: 1, column: 0 } },
    { id: 2, anchor: { row: 1, column: 1 }, active: { row: 1, column: 1 } },
  ]);

  assert.equal(editor.multiCursorController.moveAll("right", { extend: true }), true);

  assert.equal(editor.multiCursorController.renderedCarets, 1);
  assert.equal(caretOutput.children[0].style.display, "block");
  assert.equal(px(caretOutput.children[0].style.left) + px(caretOutput.children[0].style.marginLeft), 69);
  assert.equal(editor.multiCursorController.renderedSelections, 1);
  assert.equal(px(selectionOutput.children[0].style.left), 58);
  assert.equal(px(selectionOutput.children[0].style.width), 11);
});

test("multi-line secondary selections round only the exposed corners", () => {
  const { editor, selectionOutput } = makeMeasuredSetup("abcde\nvwxyz\n12345");
  setSelections(editor, [
    { id: 1, anchor: { row: 1, column: 0 }, active: { row: 1, column: 0 } },
    { id: 2, anchor: { row: 1, column: 2 }, active: { row: 3, column: 3 } },
  ]);

  editor.multiCursorController.refreshOverlays();

  assert.equal(editor.multiCursorController.renderedSelections, 3);
  const [first, middle, last] = selectionOutput.children;
  assert.deepEqual(
    [first.style.borderTopLeftRadius, first.style.borderTopRightRadius,
      first.style.borderBottomLeftRadius, first.style.borderBottomRightRadius],
    ["4px", "4px", "0px", "0px"],
  );
  assert.deepEqual(
    [middle.style.borderTopLeftRadius, middle.style.borderTopRightRadius,
      middle.style.borderBottomLeftRadius, middle.style.borderBottomRightRadius],
    ["4px", "0px", "0px", "4px"],
  );
  assert.deepEqual(
    [last.style.borderTopLeftRadius, last.style.borderTopRightRadius,
      last.style.borderBottomLeftRadius, last.style.borderBottomRightRadius],
    ["0px", "0px", "4px", "4px"],
  );

  setSelections(editor, [
    { id: 1, anchor: { row: 1, column: 0 }, active: { row: 1, column: 0 } },
    { id: 2, anchor: { row: 1, column: 1 }, active: { row: 1, column: 3 } },
  ]);
  editor.multiCursorController.refreshOverlays();

  assert.deepEqual(
    [first.style.borderTopLeftRadius, first.style.borderTopRightRadius,
      first.style.borderBottomLeftRadius, first.style.borderBottomRightRadius],
    ["4px", "4px", "4px", "4px"],
  );
});

test("touching secondary selections have square shared edges", () => {
  const { editor, selectionOutput } = makeMeasuredSetup();
  setSelections(editor, [
    { id: 1, anchor: { row: 1, column: 0 }, active: { row: 1, column: 0 } },
    { id: 2, anchor: { row: 1, column: 1 }, active: { row: 1, column: 3 } },
    { id: 3, anchor: { row: 1, column: 3 }, active: { row: 1, column: 5 } },
  ]);

  editor.multiCursorController.refreshOverlays();

  assert.equal(editor.multiCursorController.renderedSelections, 2);
  const [left, right] = selectionOutput.children;
  assert.deepEqual(
    [left.style.borderTopLeftRadius, left.style.borderTopRightRadius,
      left.style.borderBottomLeftRadius, left.style.borderBottomRightRadius],
    ["4px", "0px", "4px", "0px"],
  );
  assert.deepEqual(
    [right.style.borderTopLeftRadius, right.style.borderTopRightRadius,
      right.style.borderBottomLeftRadius, right.style.borderBottomRightRadius],
    ["0px", "4px", "0px", "4px"],
  );
});

test("secondary selections on neighboring rows connect across matching edges", () => {
  const { editor, selectionOutput } = makeMeasuredSetup("abcde\nvwxyz");
  setSelections(editor, [
    { id: 1, anchor: { row: 1, column: 0 }, active: { row: 1, column: 0 } },
    { id: 2, anchor: { row: 1, column: 1 }, active: { row: 1, column: 3 } },
    { id: 3, anchor: { row: 2, column: 1 }, active: { row: 2, column: 3 } },
  ]);

  editor.multiCursorController.refreshOverlays();

  const [top, bottom] = selectionOutput.children;
  assert.deepEqual(
    [top.style.borderTopLeftRadius, top.style.borderTopRightRadius,
      top.style.borderBottomLeftRadius, top.style.borderBottomRightRadius],
    ["4px", "4px", "0px", "0px"],
  );
  assert.deepEqual(
    [bottom.style.borderTopLeftRadius, bottom.style.borderTopRightRadius,
      bottom.style.borderBottomLeftRadius, bottom.style.borderBottomRightRadius],
    ["0px", "0px", "4px", "4px"],
  );
});

test("secondary caret styling reuses the primary caret rule", () => {
  const stylesheet = fs.readFileSync(path.join(root, "src/css/editor.css"), "utf8");
  assert.match(stylesheet, /\.editor-caret\s*,\s*\.editor-secondary-caret\s*\{/);
  assert.match(stylesheet, /.editor-caret\s*,\s*\.editor-secondary-caret\s*\{[^}]*width:\s*2px/s);
});
