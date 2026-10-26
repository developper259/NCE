const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

const LineNode = loadGlobal("src/js/types/Line.js", "LineNode");
const LineController = loadGlobal(
  "src/js/controller/LineController.js",
  "LineController",
  { OutputScroller: class {}, SETTINGS_GET: () => 4 },
);

function makeController(lineCount = 12, visibleRows = 4, scrollBufferLines = 0) {
  const lines = Array.from({ length: lineCount }, (_, index) => {
    const line = new LineNode(`const value${index} = ${index};`);
    line.setTokens([{ value: line.getText(), type: "source" }]);
    return line;
  });
  const file = { lines, startIndex: 0, offsetX: 0, loadError: null };
  const output = {
    children: [],
    get firstElementChild() { return this.children[0] || null; },
    get lastElementChild() { return this.children.at(-1) || null; },
    appendChild(node) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = this;
      this.children.push(node);
      return node;
    },
    insertBefore(node, reference) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      const index = this.children.indexOf(reference);
      node.parent = this;
      this.children.splice(index < 0 ? this.children.length : index, 0, node);
      return node;
    },
  };
  const scrolledHighlightIndexes = [];
  const editor = {
    output,
    tabManager: { activeFile: file },
    domManager: { getLetterWidth: () => 10 },
    cursorController: { updateCaretPosition() {} },
    selectController: { refreshSelectionDOM() {} },
    searchController: { refreshSelectionDOM() {} },
    highlightController: {
      lineNodes: new Map(),
      setLineNode(index, node) { this.lineNodes.set(index, node); },
      refreshForVerticalScroll(indexes) { scrolledHighlightIndexes.push(indexes); },
      refresh() {},
      markDirtyAll() {},
      markDirtyFrom() {},
    },
  };
  const controller = Object.create(LineController.prototype);
  controller.editor = editor;
  controller.outputWidth = 800;
  controller.marginChars = 10;
  controller.offsetX = 0;
  controller.renderGeneration = 1;
  controller.dirtyLines = new Set();
  controller.scrollBufferLines = scrollBufferLines;
  Object.defineProperty(controller, "maxViewLines", { value: visibleRows });
  Object.defineProperty(controller, "maxCharactersPerLine", { value: 90 });
  controller.getDisplayRow = (displayIndex) => {
    const line = lines[displayIndex];
    return line
      ? { type: "unchanged", text: line.getText(), documentIndex: displayIndex }
      : null;
  };
  controller.getLineTop = (screenIndex) => screenIndex * 20;
  controller.applyOutputTransform = () => {};
  controller.refreshNumberLines = (updateWidth, previousStartIndex) => {
    controller.numberRefreshes += 1;
    controller.numberWidthUpdated = updateWidth;
    controller.numberPreviousStartIndex = previousStartIndex;
  };
  controller.updateLineNumberWidth = () => { controller.widthRefreshes += 1; };
  controller.numberRefreshes = 0;
  controller.widthRefreshes = 0;
  controller.slicesCreated = 0;
  controller.rowsCreated = [];
  controller.initCalls = 0;
  controller.getSlicedLine = (text) => {
    controller.slicesCreated += 1;
    const startChar = file.offsetX;
    const endChar = Math.min(text.length, startChar + controller.maxCharactersPerLine);
    return {
      text: text.slice(startChar, endChar),
      displayText: text.slice(startChar, endChar),
      startChar,
      endChar,
      startVisual: startChar,
      endVisual: endChar,
      visualLength: text.length,
    };
  };
  controller.getFastNode = (node) => ({
    setTop(value) { node.top = value; },
    setDataset(name, value) { node.dataset[name] = String(value); },
    removeChildren() { node.children = []; },
    removeAttribute(name) { delete node.dataset[name.replace(/^data-/, "")]; },
    replaceWith(replacement) {
      const parent = node.parent;
      const index = parent.children.indexOf(node);
      parent.children[index] = replacement;
      replacement.parent = parent;
      node.parent = null;
    },
  });
  controller.createLineOBJ = (slice, screenIndex) => {
    const documentIndex = controller.renderStartIndex + screenIndex;
    const node = {
      dataset: {},
      children: [],
      parent: null,
      text: slice?.displayText || "",
      top: screenIndex * 20,
    };
    controller.rowsCreated.push(documentIndex);
    return node;
  };
  controller.initLineOutput = () => { controller.initCalls += 1; };

  function addRow(displayIndex) {
    const line = lines[displayIndex];
    const text = line.getText();
    const node = {
      dataset: { line: String(displayIndex), displayLine: String(displayIndex) },
      children: [],
      parent: output,
      top: displayIndex * 20,
      __nceRenderMeta: {
        documentIndex: displayIndex,
        lineNode: line,
        displayText: text,
        startChar: 0,
        endChar: text.length,
        startVisual: 0,
        endVisual: text.length,
        horizontalOffset: 0,
        maxCharactersPerLine: 90,
        tabWidth: 4,
        textVersion: line.textVersion,
        tokenVersion: line.tokensVersion,
        diffVersion: line.diffVersion,
        diffState: "unchanged",
      },
    };
    output.children.push(node);
    editor.highlightController.setLineNode(displayIndex, node);
  }
  const initialRowCount = Math.min(lineCount, visibleRows + scrollBufferLines * 2);
  for (let index = 0; index < initialRowCount; index += 1) addRow(index);

  return { controller, editor, file, lines, output, scrolledHighlightIndexes };
}

test("window resize defers output thumb refresh to the shared scroller pass", () => {
  const { controller } = makeController();
  const calls = [];
  controller.editor.isOnRefresh = false;
  controller.outputScroller = { clampScrollState() {} };
  controller.syncDimensions = () => calls.push("dimensions");
  controller.markDirtyAll = () => calls.push("dirty");
  controller.refresh = (...args) => calls.push(args);

  controller.resize({ deferScrollerRefresh: true });

  assert.deepEqual(calls.slice(0, 2), ["dimensions", "dirty"]);
  assert.equal(calls[2][0], true);
  assert.equal(calls[2][1].deferScrollerRefresh, true);
});

test("window resize refreshes the cached horizontal bar height before clamping", () => {
  const { controller } = makeController();
  const calls = [];
  controller.editor.isOnRefresh = true;
  controller.syncDimensions = () => calls.push("dimensions");
  controller.outputScroller = {
    measureHorizontalScrollbarHeight() { calls.push("measure bar"); },
    clampScrollState() { calls.push("clamp"); },
  };

  controller.resize({ deferScrollerRefresh: true });

  assert.deepEqual(calls, ["dimensions", "measure bar", "clamp"]);
});

test("viewport height never reads horizontal scroller layout", () => {
  const { controller } = makeController();
  controller.outputHeight = 100;
  controller.outputScroller = {
    getHorizontalScrollbarHeight: () => 14,
    hScroller: {
      calcIsActive() { throw new Error("viewport math must use the cached bar state"); },
      scrollerOBJ: {
        get clientHeight() { throw new Error("viewport math must not measure the bar"); },
      },
    },
  };

  assert.equal(controller.getViewportHeight(), 86);

  controller.outputScroller = {};
  assert.equal(controller.getViewportHeight(), 100);
});

test("one-line vertical scroll reuses unchanged highlighted rows and rebuilds only the entering row", () => {
  const { controller, file, output, scrolledHighlightIndexes } = makeController();
  const originalRows = output.children.slice();
  file.startIndex = 1;

  controller.refreshForVerticalScroll(0);

  assert.deepEqual(controller.rowsCreated, [4]);
  assert.equal(controller.slicesCreated, 1);
  assert.equal(output.children.length, 4);
  assert.equal(output.children[0], originalRows[1]);
  assert.equal(output.children[1], originalRows[2]);
  assert.equal(output.children[2], originalRows[3]);
  assert.equal(output.children[3].dataset.line, "4");
  assert.deepEqual(output.children.map((row) => row.top), [0, 20, 40, 60]);
  assert.equal(controller.numberWidthUpdated, false);
  assert.equal(controller.numberPreviousStartIndex, 0);
  assert.equal(controller.widthRefreshes, 0);
  assert.deepEqual(scrolledHighlightIndexes, []);
});

test("vertical scroll rotates the gutter and rewrites only the entering row", () => {
  const { controller, file } = makeController();
  const spans = Array.from({ length: 4 }, (_, index) => ({
    children: [],
    dataset: {},
    textContent: String(index + 1),
    top: index * 20,
    textWrites: 0,
    classes: new Set(),
  }));
  const gutter = {
    children: spans,
    get firstElementChild() { return this.children[0] || null; },
    get lastElementChild() { return this.children.at(-1) || null; },
    appendChild(node) {
      const existing = this.children.indexOf(node);
      if (existing >= 0) this.children.splice(existing, 1);
      this.children.push(node);
      return node;
    },
    insertBefore(node, reference) {
      const existing = this.children.indexOf(node);
      if (existing >= 0) this.children.splice(existing, 1);
      const index = this.children.indexOf(reference);
      this.children.splice(index < 0 ? this.children.length : index, 0, node);
      return node;
    },
  };
  controller.editor.lineNumberOutput = gutter;
  controller.getFastNode = (node) => ({
    setTop(value) { node.top = value; },
    setDataset(name, value) { node.dataset[name] = String(value); },
    setTextContent(value) {
      node.textContent = String(value);
      node.textWrites += 1;
    },
    toggleClass(name, force) {
      if (force) node.classes.add(name);
      else node.classes.delete(name);
    },
  });
  controller.getViewNumberLines = () => 4;
  controller.getLineTop = (screenIndex) => screenIndex * 20;
  controller.refreshNumberLines = LineController.prototype.refreshNumberLines;
  file.index = 5;

  file.startIndex = 1;
  controller.refreshNumberLines(false, 0);

  assert.deepEqual(gutter.children.map((span) => span.textContent), ["2", "3", "4", "5"]);
  assert.deepEqual(gutter.children.map((span) => span.top), [0, 20, 40, 60]);
  assert.deepEqual(gutter.children.map((span) => span.dataset.displayLine), ["1", "2", "3", "4"]);
  assert.deepEqual(gutter.children.map((span) => span.textWrites), [0, 0, 0, 1]);
  assert.ok(gutter.children[3].classes.has("line-selected"));

  gutter.children.forEach((span) => { span.textWrites = 0; });
  file.startIndex = 2;
  controller.refreshNumberLines(false);

  assert.deepEqual(gutter.children.map((span) => span.textContent), ["3", "4", "5", "6"]);
  assert.deepEqual(gutter.children.map((span) => span.textWrites), [1, 1, 1, 1]);
});

test("text, token, line identity, and horizontal slice changes invalidate the row content", () => {
  const cases = [
    ["text version", (line) => line.setText("const changed = true;")],
    ["token version", (line) => line.setTokens([{ value: "updated token" }])],
    ["line identity", (_line, file) => { file.lines[0] = new LineNode("const value0 = 0;"); }],
    ["horizontal slice", (_line, file) => { file.offsetX = 1; }],
  ];

  for (const [name, change] of cases) {
    const { controller, file, lines } = makeController();
    change(lines[0], file);
    controller.refreshLineOutput(0);
    assert.deepEqual(controller.rowsCreated, [0], `${name} should rebuild row content`);
    assert.equal(controller.slicesCreated, 1, `${name} should reproject its visible slice`);
  }
});

test("large jumps rebuild the bounded viewport pool", () => {
  const { controller, file, output } = makeController();
  file.startIndex = 8;

  controller.refreshForVerticalScroll(0);

  assert.equal(controller.initCalls, 1);
  assert.equal(output.children.length, 4);
});

test("repeated down and up scroll keeps the row pool bounded", () => {
  const { controller, file, output } = makeController();
  for (let index = 0; index < 8; index += 1) {
    const previous = file.startIndex;
    file.startIndex += 1;
    controller.refreshForVerticalScroll(previous);
    const beforeUp = file.startIndex;
    file.startIndex -= 1;
    controller.refreshForVerticalScroll(beforeUp);
    assert.equal(output.children.length, 4);
    assert.equal(new Set(output.children).size, 4);
  }
});

test("scrolling inside the render buffer reuses every row without rebuilding", () => {
  const { controller, file, output, scrolledHighlightIndexes } = makeController(40, 4, 8);
  const originalRows = output.children.slice();

  assert.equal(controller.renderedLineCount, 20);
  assert.equal(output.children.length, 20);
  assert.equal(controller.renderStartIndex, 0);

  for (const startIndex of [1, 4, 7]) {
    file.startIndex = startIndex;
    controller.refreshForVerticalScroll(startIndex - 1);
  }

  assert.equal(controller.renderStartIndex, 0);
  assert.deepEqual(controller.rowsCreated, []);
  assert.equal(controller.slicesCreated, 0);
  assert.equal(controller.initCalls, 0);
  assert.equal(output.children.length, 20);
  originalRows.forEach((row, index) => assert.equal(output.children[index], row));
  assert.deepEqual(scrolledHighlightIndexes, []);
});

test("crossing the render window boundary rebuilds only the entering rows", () => {
  const { controller, file, output } = makeController(40, 4, 8);
  const originalRows = output.children.slice();

  file.startIndex = 16;
  controller.refreshForVerticalScroll(15);

  assert.equal(controller.renderStartIndex, 8);
  assert.equal(controller.renderedLineCount, 20);
  assert.equal(controller.initCalls, 0);
  assert.deepEqual(controller.rowsCreated, [20, 21, 22, 23, 24, 25, 26, 27]);
  assert.equal(controller.slicesCreated, 8);
  assert.equal(output.children.length, 20);
  assert.deepEqual(
    output.children.map((row) => row.top),
    Array.from({ length: 20 }, (_, index) => index * 20),
  );
  assert.deepEqual(
    output.children.map((row) => row.dataset.displayLine),
    Array.from({ length: 20 }, (_, index) => String(index + 8)),
  );
  for (let index = 0; index < 12; index += 1) {
    assert.equal(output.children[index], originalRows[index + 8]);
  }
});

test("refresh rebuilds the render window when the document grows", () => {
  const { controller, file, output } = makeController(1, 4, 0);
  controller.outputScroller = {
    clampScrollState: () => false,
    updateNbItem() {},
    refresh() {},
  };
  controller.applyScrollTransform = () => {};
  controller.updateRenderWindow();
  assert.equal(controller.renderedLineCount, 1);
  assert.equal(output.children.length, 1);

  for (let index = 1; index < 6; index += 1) {
    file.lines.push(new LineNode(`line ${index}`));
  }

  controller.initLineOutput = () => {
    controller.initCalls += 1;
    output.children = [];
    const count = controller.renderedLineCount;
    for (let screenIndex = 0; screenIndex < count; screenIndex += 1) {
      const displayIndex = controller.renderStartIndex + screenIndex;
      output.children.push({
        dataset: { line: String(displayIndex), displayLine: String(displayIndex) },
        children: [],
        parent: output,
        top: screenIndex * 20,
      });
    }
  };

  controller.refresh();

  assert.equal(controller.initCalls, 1);
  assert.equal(controller.renderedLineCount, 4);
  assert.equal(output.children.length, 4);
  assert.deepEqual(
    output.children.map((row) => row.dataset.displayLine),
    ["0", "1", "2", "3"],
  );
});
