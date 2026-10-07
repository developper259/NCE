const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

const LineNode = loadGlobal("src/js/types/Line.js", "LineNode");
const LineController = loadGlobal(
  "src/js/controller/LineController.js",
  "LineController",
  { OutputScroller: class {}, SETTINGS_GET: () => 4 },
);

function makeController(lineCount = 12, visibleRows = 4) {
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
    },
  };
  const controller = Object.create(LineController.prototype);
  controller.editor = editor;
  controller.outputWidth = 800;
  controller.marginChars = 10;
  controller.offsetX = 0;
  controller.renderGeneration = 1;
  Object.defineProperty(controller, "renderedLineCount", { value: visibleRows });
  Object.defineProperty(controller, "maxCharactersPerLine", { value: 90 });
  controller.getDisplayRow = (displayIndex) => {
    const line = lines[displayIndex];
    return line
      ? { type: "unchanged", text: line.getText(), documentIndex: displayIndex }
      : null;
  };
  controller.getLineTop = (screenIndex) => screenIndex * 20;
  controller.applyOutputTransform = () => {};
  controller.refreshNumberLines = (updateWidth) => {
    controller.numberRefreshes += 1;
    controller.numberWidthUpdated = updateWidth;
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
    const documentIndex = file.startIndex + screenIndex;
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
  for (let index = 0; index < visibleRows; index += 1) addRow(index);

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
  assert.equal(controller.widthRefreshes, 0);
  assert.deepEqual(scrolledHighlightIndexes, []);
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
