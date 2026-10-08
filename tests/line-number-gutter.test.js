const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

const LineNode = loadGlobal("src/js/types/Line.js", "LineNode");
const LineController = loadGlobal(
  "src/js/controller/LineController.js",
  "LineController",
  { OutputScroller: class {}, SETTINGS_GET: () => 4, LineNode },
);

function makeController(file, letterSize = 10.8) {
  const widths = [];
  const baseXs = [];
  const controller = Object.create(LineController.prototype);
  controller.editor = {
    letterSize,
    tabManager: { activeFile: file },
    updateBaseX(width) { baseXs.push(width + 10); },
  };
  controller.lineNumberFast = { setWidth(width) { widths.push(width); } };
  controller.lastLineNumberWidth = null;
  return { controller, widths, baseXs };
}

test("gutter width follows 1-based line number digit boundaries and editor font metrics", () => {
  const { controller } = makeController({ lines: [], totalLines: 0 });
  const cases = [
    [9, 50], [10, 50], [99, 50], [100, 50], [999, 50], [1000, 59],
    [9999, 59], [10000, 69], [100000, 80], [1000000, 91],
  ];

  for (const [totalLines, expectedWidth] of cases) {
    controller.editor.tabManager.activeFile.totalLines = totalLines;
    assert.equal(controller.calculateLineNumberWidth(), expectedWidth, `${totalLines} lines`);
  }

  controller.editor.letterSize = 12;
  controller.editor.tabManager.activeFile.totalLines = 100000;
  assert.equal(controller.calculateLineNumberWidth(), 87);
});

test("progressive loading sizes from expected total and preserves it across loaded chunks", () => {
  const file = {
    lines: [new LineNode("first")],
    totalLines: 1,
    loadingState: {
      status: "loading",
      loadedLineCount: 1,
      expectedTotalLines: 100000,
    },
  };
  const { controller } = makeController(file);

  assert.equal(controller.calculateLineNumberWidth(), 80);
  controller.totalLines = file.lines.length;
  controller.syncLineLengthsForAppend = () => {};
  controller.syncLogicalLineLengthsForAppend = () => {};
  controller.appendLoadedLines(file, ["second chunk"]);
  assert.equal(file.totalLines, 100000);
  assert.equal(controller.calculateLineNumberWidth(), 80);

  file.loadingState.status = "loaded";
  controller.appendLoadedLines(file, ["last line"]);
  assert.equal(file.totalLines, 3);
  assert.equal(controller.calculateLineNumberWidth(), 50);
});

test("gutter writes are coalesced and large-to-small file switches shrink immediately", () => {
  const largeFile = { lines: [], totalLines: 100000 };
  const smallFile = { lines: [], totalLines: 9 };
  const { controller, widths, baseXs } = makeController(largeFile);

  for (let index = 0; index < 20; index++) controller.updateLineNumberWidth();
  assert.deepEqual(widths, [80]);
  assert.deepEqual(baseXs, [90]);

  controller.editor.tabManager.activeFile = smallFile;
  controller.updateLineNumberWidth();
  assert.deepEqual(widths, [80, 50]);
  assert.deepEqual(baseXs, [90, 60]);
});

test("line number layer is one pixel shorter than rendered editor output", () => {
  const { controller } = makeController({ lines: [], totalLines: 0 });
  const heights = {};
  for (const name of ["outputFast", "lineNumberFast", "selectOutputFast", "searchOutputFast"])
    controller[name] = {
      setHeight(height) { heights[name] = height; },
      setTransform() {},
    };
  controller.getRenderedLayerHeight = () => 480;
  controller.getOutputTransform = () => "translate(0px, 0px)";

  controller.applyOutputTransform();

  assert.equal(heights.outputFast, "480px");
  assert.equal(heights.lineNumberFast, "479px");
  assert.equal(heights.selectOutputFast, "480px");
  assert.equal(heights.searchOutputFast, "480px");
});
