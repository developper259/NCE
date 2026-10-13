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

function makeEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      const values = listeners.get(type) || new Set();
      values.add(listener);
      listeners.set(type, values);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type) {
      for (const listener of listeners.get(type) || []) listener();
    },
    listenerCount(type) {
      return listeners.get(type)?.size || 0;
    },
  };
}

function makeCursorDocument() {
  const fonts = makeEventTarget();
  fonts.status = "loaded";
  const metrics = { scale: 1, measurements: 0 };
  return {
    fonts,
    metrics,
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
          metrics.measurements++;
          return { left: 50 + glyphOffsets[offset] * metrics.scale };
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

  const cursorDocument = makeCursorDocument();
  const viewport = makeEventTarget();
  viewport.visualViewport = makeEventTarget();
  const animationFrames = new Map();
  let nextAnimationFrame = 1;
  const Cursor = loadGlobal(
    "src/js/controller/CursorController.js",
    "CursorController",
    {
      NodeFilter: { SHOW_TEXT: 4 },
      TextPositionIndex,
      SETTINGS_GET: () => 4,
      document: cursorDocument,
      window: viewport,
      requestAnimationFrame(callback) {
        const id = nextAnimationFrame++;
        animationFrames.set(id, callback);
        return id;
      },
      cancelAnimationFrame(id) {
        animationFrames.delete(id);
      },
      Events: { CURSOR_CHANGE: "cursor-change" },
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
  return {
    editor,
    file,
    caretOutput,
    selectionOutput,
    cursorDocument,
    viewport,
    flushAnimationFrames() {
      const callbacks = [...animationFrames.values()];
      animationFrames.clear();
      for (const callback of callbacks) callback();
    },
    pendingAnimationFrames: animationFrames,
  };
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

test("caret geometry cache invalidates on font and viewport metric changes", () => {
  const { editor, cursorDocument, viewport, flushAnimationFrames,
    pendingAnimationFrames } = makeMeasuredSetup();
  const cursor = editor.cursorController;

  assert.equal(cursor.getCaretPosition(1, 2).contentLeft, 69);
  assert.equal(cursorDocument.metrics.measurements, 1);
  cursor.getCaretPosition(1, 2);
  assert.equal(cursorDocument.metrics.measurements, 1);

  cursorDocument.metrics.scale = 2;
  cursorDocument.fonts.dispatch("loadingdone");
  assert.equal(cursor.getCaretPosition(1, 2).contentLeft, 88);
  assert.equal(cursorDocument.metrics.measurements, 2);

  cursorDocument.metrics.scale = 3;
  viewport.visualViewport.dispatch("resize");
  assert.equal(cursor.getCaretPosition(1, 2).contentLeft, 107);
  assert.equal(cursorDocument.metrics.measurements, 3);

  cursorDocument.metrics.scale = 4;
  viewport.dispatch("resize");
  assert.equal(cursor.getCaretPosition(1, 2).contentLeft, 126);
  assert.equal(cursorDocument.metrics.measurements, 4);
  assert.equal(pendingAnimationFrames.size, 1);
  flushAnimationFrames();
  assert.equal(editor.cD.style.display, "block");

  cursor.invalidateCaretGeometry();
  assert.equal(pendingAnimationFrames.size, 1);
  cursor.destroy();
  assert.equal(pendingAnimationFrames.size, 0);
  assert.equal(cursorDocument.fonts.listenerCount("loading"), 0);
  assert.equal(cursorDocument.fonts.listenerCount("loadingdone"), 0);
  assert.equal(cursorDocument.fonts.listenerCount("loadingerror"), 0);
  assert.equal(viewport.listenerCount("resize"), 0);
  assert.equal(viewport.visualViewport.listenerCount("resize"), 0);
});

test("mono cursor movement skips multi-selection normalization and overlay refresh", () => {
  const { editor } = makeMeasuredSetup();
  const multi = editor.multiCursorController;
  let normalizations = 0;
  let overlayRefreshes = 0;
  const normalizeSelections = multi.normalizeSelections.bind(multi);
  multi.normalizeSelections = (...args) => {
    normalizations++;
    return normalizeSelections(...args);
  };
  multi.refreshOverlays = () => overlayRefreshes++;

  editor.cursorController.setCursorPosition(1, 2);

  assert.equal(normalizations, 0);
  assert.equal(overlayRefreshes, 0);

  setSelections(editor, [
    { id: 1, anchor: { row: 1, column: 2 }, active: { row: 1, column: 2 } },
    { id: 2, anchor: { row: 1, column: 4 }, active: { row: 1, column: 4 } },
  ]);
  normalizations = 0;
  editor.cursorController.setCursorPosition(1, 3);
  assert.equal(normalizations, 1);
  assert.equal(overlayRefreshes, 1);
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
  assert.match(stylesheet, /\.editor-caret\s*,\s*\.editor-secondary-carets\s*\{[^}]*animation:\s*nce-caret-blink/s);
  assert.match(stylesheet, /@media\s*\(prefers-reduced-motion:\s*reduce\)[^{]*\{[^}]*\.editor-secondary-carets[^}]*animation:\s*none/s);
  assert.doesNotMatch(stylesheet, /--nce-caret-blink/);
});
