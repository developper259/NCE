const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const { loadGlobal, root } = require("./helpers/runtime");

function loadTools() {
  return loadGlobal("src/js/core/Tools.js", "NCETextPosition", {
    SETTINGS_GET: () => 4,
  });
}

function loadLineNodeWithIndex() {
  const context = vm.createContext({ SETTINGS_GET: () => 4, Map, Set, WeakMap });
  const index = fs.readFileSync(`${root}/src/js/types/TextPositionIndex.js`, "utf8");
  const line = fs.readFileSync(`${root}/src/js/types/Line.js`, "utf8");
  vm.runInContext(`${index}\n${line}\nthis.__LineNode = LineNode;`, context);
  return context.__LineNode;
}

test("grapheme boundaries keep UTF-16 offsets legal", () => {
  const {
    getGraphemeBoundaries,
    normalizeTextBoundary,
    previousGraphemeBoundary,
    nextGraphemeBoundary,
  } = loadTools();

  assert.deepEqual(Array.from(getGraphemeBoundaries("A😀B")), [0, 1, 3, 4]);
  assert.deepEqual(Array.from(getGraphemeBoundaries("A👨‍👩‍👧‍👦B")), [0, 1, 12, 13]);
  assert.deepEqual(
    Array.from(getGraphemeBoundaries("e\u0301👍🏻🇫🇷")),
    [0, 2, 6, 10],
  );
  assert.equal(normalizeTextBoundary("A😀B", 2), 1);
  assert.equal(previousGraphemeBoundary("A😀B", 2), 1);
  assert.equal(nextGraphemeBoundary("A😀B", 2), 3);
});

test("visual-column conversion round-trips legal Unicode offsets and tabs", () => {
  const {
    getGraphemeBoundaries,
    realColumnToViewColumn,
    viewColumnToRealColumn,
  } = loadTools();
  for (const text of ["abc", "\tabc", "a😀b", "👍🏻", "A👨‍👩‍👧‍👦\tB", "e\u0301"]) {
    for (const offset of getGraphemeBoundaries(text)) {
      const viewColumn = realColumnToViewColumn(text, offset, 4);
      assert.equal(viewColumnToRealColumn(text, viewColumn, 4), offset, text);
    }
  }
});

test("random mixed grapheme and tab positions match the slow reference APIs", () => {
  const TextPositionIndex = loadGlobal(
    "src/js/types/TextPositionIndex.js",
    "TextPositionIndex",
  );
  const reference = loadTools();
  const parts = ["a", "Z", "\t", "😀", "👍🏻", "👨‍👩‍👧‍👦", "e\u0301", "🇫🇷", "❤️"];
  let seed = 0x51f15e;
  const random = (limit) => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed % limit;
  };
  for (let sample = 0; sample < 100; sample++) {
    const text = Array.from({ length: 4 + random(24) }, () => parts[random(parts.length)]).join("");
    const index = new TextPositionIndex(text, 4);
    const boundaries = Array.from(reference.getGraphemeBoundaries(text));
    const visualAtReal = new Map([[0, 0]]);
    let visual = 0;
    for (let position = 0; position < boundaries.length - 1; position++) {
      const start = boundaries[position];
      const end = boundaries[position + 1];
      visual += text.slice(start, end) === "\t" ? 4 : 1;
      visualAtReal.set(end, visual);
    }
    for (const real of boundaries) {
      assert.equal(index.realToVisual(real), visualAtReal.get(real), JSON.stringify(text));
      assert.equal(index.normalize(real), real, JSON.stringify(text));
      assert.equal(index.previous(real), reference.previousGraphemeBoundary(text, real));
      assert.equal(index.next(real), reference.nextGraphemeBoundary(text, real));
    }
    for (let column = 0; column <= index.visualLength + 1; column++) {
      assert.equal(
        index.visualToReal(column),
        reference.viewColumnToRealColumn(text, column, 4),
        `${JSON.stringify(text)} @ ${column}`,
      );
    }
  }
});

test("million-character ASCII lines use constant-time positions and viewport-sized slices", () => {
  const TextPositionIndex = loadGlobal(
    "src/js/types/TextPositionIndex.js",
    "TextPositionIndex",
  );
  const text = "a".repeat(1_000_000);
  const index = new TextPositionIndex(text, 4);
  const scannedBefore = index.metrics.charactersScanned;

  assert.equal(index.kind, "ascii");
  assert.equal(index.tabOffsets.length, 0);
  assert.equal(index.checkpoints.length, 0);
  assert.equal(index.visualLength, 1_000_000);
  assert.equal(index.realToVisual(900_000), 900_000);
  assert.equal(index.visualToReal(900_000), 900_000);
  assert.equal(index.previous(900_000), 899_999);
  assert.equal(index.next(900_000), 900_001);
  assert.equal(index.normalize(900_000), 900_000);

  const slice = index.sliceVisualRange(900_000, 150);
  assert.equal(slice.text.length, 150);
  assert.equal(slice.text, "a".repeat(150));
  assert.ok(index.metrics.charactersScanned - scannedBefore <= 150);
  assert.equal(index.metrics.boundariesMaterialized, 0);
});

test("ASCII tab index stays sparse and slices partial tab cells correctly", () => {
  const TextPositionIndex = loadGlobal(
    "src/js/types/TextPositionIndex.js",
    "TextPositionIndex",
  );
  const text = `${"x".repeat(300_000)}\t${"y".repeat(300_000)}\tend`;
  const index = new TextPositionIndex(text, 4);
  assert.equal(index.kind, "ascii");
  assert.deepEqual(Array.from(index.tabOffsets), [300_000, 600_001]);
  assert.equal(index.checkpoints.length, 0);
  assert.equal(index.visualLength, text.length + 6);
  assert.equal(index.realToVisual(300_001), 300_004);
  assert.equal(index.visualToReal(300_004), 300_001);

  const partial = new TextPositionIndex("a\tbc", 4).sliceVisualRange(2, 3);
  assert.equal(partial.displayText, "   ");
  assert.equal(partial.text, "\t");
});

test("Unicode checkpoints keep local grapheme lookups bounded", () => {
  const TextPositionIndex = loadGlobal(
    "src/js/types/TextPositionIndex.js",
    "TextPositionIndex",
  );
  const unit = "A😀e\u0301👨‍👩‍👧‍👦🇫🇷";
  const text = unit.repeat(4_000);
  const index = new TextPositionIndex(text, 4);
  const offset = text.length - unit.length * 20 + 1;
  const scannedBefore = index.metrics.charactersScanned;
  const previous = index.previous(offset);
  const next = index.next(offset);
  assert.ok(previous < next);
  assert.ok(index.checkpoints.length < text.length / 20);
  assert.ok(index.metrics.charactersScanned - scannedBefore < 4_000);
  const slice = index.sliceVisualRange(index.visualLength - 24, 24);
  assert.ok(slice.text.length <= 24 * 12);
  assert.equal(index.metrics.boundariesMaterialized, 0);
});

test("line index cache survives localized ASCII edits and stays out of JSON", () => {
  const LineNode = loadLineNodeWithIndex();
  const original = "a".repeat(1_000_000);
  const line = new LineNode(original);
  const index = line.getPositionIndex(4);
  const updated = `${original.slice(0, 500_000)}X${original.slice(500_001)}`;
  line.setText(updated, { start: 500_000, end: 500_001, text: "X" });

  assert.equal(line.getPositionIndex(4), index);
  assert.equal(index.realToVisual(900_000), 900_000);
  assert.equal(line.textVersion, 1);
  assert.equal(line.clone().positionIndex, null);
  assert.equal(JSON.stringify(line).includes("positionIndex"), false);
});

test("max visual line length updates and shrinks without accumulating heap entries", () => {
  class OutputScrollerStub {}
  const LineController = loadGlobal(
    "src/js/controller/LineController.js",
    "LineController",
    { OutputScroller: OutputScrollerStub, SETTINGS_GET: () => 4 },
  );
  const lines = [
    { text: "x".repeat(1_000_000), getText() { return this.text; } },
    { text: "y".repeat(100), getText() { return this.text; } },
  ];
  const file = { lines, maxLineLength: 0, maxLineLengthDirty: false, diffRows: null };
  const controller = Object.create(LineController.prototype);
  controller.editor = { tabManager: { activeFile: file } };
  controller.getViewTextLength = (text) => text.length;

  controller.rebuildLineLengthIndex();
  assert.equal(controller.maxLineLength, 1_000_000);
  assert.equal(controller.sumLineTextLengths(0, 2), 1_000_100);
  lines[0].text = "short";
  controller.syncLineLengthsForEdit(0, [lines[0]], [lines[0]]);
  assert.equal(controller.maxLineLength, 100);
  assert.equal(controller.sumLineTextLengths(0, 2), 105);

  for (let edit = 0; edit < 500; edit++) {
    lines[0].text = `edit-${edit}`;
    controller.syncLineLengthsForEdit(0, [lines[0]], [lines[0]]);
  }
  assert.equal(file._lineLengthHeap.length, lines.length);
  assert.equal(controller.maxLineLength, 100);

  lines.push({ text: "z".repeat(250), getText() { return this.text; } });
  controller.syncLineLengthsForEdit(2, [], [lines[2]]);
  assert.equal(controller.maxLineLength, 250);
  const [removed] = lines.splice(2, 1);
  controller.syncLineLengthsForEdit(2, [removed], []);
  assert.equal(controller.maxLineLength, 100);
});

test("word navigation scans nearby word boundaries without building per-word arrays", () => {
  const TextPositionIndex = loadGlobal(
    "src/js/types/TextPositionIndex.js",
    "TextPositionIndex",
  );
  const index = new TextPositionIndex(`${"x ".repeat(250_000)}`, 4);
  const separators = [" ", "\t", ".", ","];
  const scannedBefore = index.metrics.charactersScanned;
  assert.equal(JSON.stringify(index.getWordRangeAt(499_998, separators)), JSON.stringify({
    start: 499_998, end: 499_999, separator: false,
  }));
  assert.equal(index.previousWordBoundary(499_999, separators), 499_998);
  assert.equal(index.nextWordBoundary(499_998, separators), 499_999);
  assert.ok(index.metrics.charactersScanned - scannedBefore <= 8);
  assert.equal(index.wordSeparators.size, 1);
});

test("ArrowRight and End on a million-character line reuse the line index", () => {
  const LineNode = loadLineNodeWithIndex();
  const KeyBinding = loadGlobal("src/js/addon/KeyBinding.js", "KeyBinding");
  const line = new LineNode("a".repeat(1_000_000));
  const index = line.getPositionIndex(4);
  const file = { row: 1, column: 900_000, historyX: undefined };
  const editor = {
    tabManager: { activeFile: file },
    lineController: { lines: [line], offsetX: 0 },
    cursorController: {
      get row() { return file.row; },
      get column() { return file.column; },
      setCursorPosition(row, column) { file.row = row; file.column = column; },
    },
    selectController: { hasActiveSelection: () => false, unSelectAll() {} },
  };
  const binding = Object.create(KeyBinding.prototype);
  binding.editor = editor;
  const scannedBefore = index.metrics.charactersScanned;

  binding.key_arrow_right(false, false, false, false);
  assert.equal(file.column, 900_001);
  assert.equal(index.metrics.charactersScanned, scannedBefore);

  binding.key_end(false, false, false, false);
  assert.equal(file.column, 1_000_000);
  assert.equal(index.metrics.charactersScanned, scannedBefore);
});
