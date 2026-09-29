const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

test("background line appends update cached indexes from only the appended rows", () => {
  const LineNode = loadGlobal("src/js/types/Line.js", "LineNode");
  const LineController = loadGlobal(
    "src/js/controller/LineController.js",
    "LineController",
    { SETTINGS_GET: () => 4, LineNode },
  );
  const file = {
    lines: Array.from({ length: 100_000 }, () => ({ getText: () => "a" })),
    totalLines: 100_000,
    maxLineLength: 0,
    maxLineLengthDirty: false,
    diffRows: null,
  };
  const controller = Object.create(LineController.prototype);
  controller.editor = { tabManager: { activeFile: file } };
  controller.diffMaxLineLength = 0;
  controller.syncDiffRowCache = () => {};
  controller.outputScroller = null;
  let measuredLineCount = 0;
  controller.getViewTextLength = (text) => {
    measuredLineCount++;
    return text.replace(/\t/g, "    ").length;
  };

  controller.rebuildLineLengthIndex(file);
  controller.ensureLogicalLineLengthIndex(file);
  measuredLineCount = 0;

  controller.appendLoadedLines(file, ["b", "longest-line", "\t"]);

  assert.equal(measuredLineCount, 3);
  assert.equal(file._lineLengthCount, 100_003);
  assert.equal(file._logicalLengthCount, 100_003);
  assert.equal(controller.maxLineLength, 12);
  assert.equal(controller.sumLineTextLengths(99_999, 100_003), 15);
  assert.equal(file.totalLines, 100_003);
});
