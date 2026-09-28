const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

function createScroller({ frames, calls, offsetX = 0 } = {}) {
  const OutputScroller = loadGlobal("src/js/scrollers/Output.Scroller.js", "OutputScroller");
  const lineController = {
    offsetX,
    maxLineLength: 1_000_000,
    outputWidth: 100,
    getDisplayLineCount: () => 1,
    getLineHeight: () => 20,
    refreshHorizontalViewport: () => calls.push("horizontal viewport"),
  };
  const scroller = Object.create(OutputScroller.prototype);
  scroller.editor = {
    letterSize: 10,
    posY: 20,
    domManager: { getOutputWidth: () => 100 },
    get output() { throw new Error("horizontal scrolling must not read output layout"); },
    cursorController: { updateCaretPosition: () => calls.push("caret") },
    selectController: { refreshSelectPositions: () => calls.push("selection") },
    searchController: { refreshSelectionDOM: () => calls.push("search") },
    highlightController: { refresh: () => calls.push("highlight") },
  };
  scroller.lineController = lineController;
  scroller.marginChars = 10;
  scroller.pendingHorizontalColumns = 0;
  scroller.horizontalWheelFrame = null;
  scroller.hScroller = {
    calcIsActive: () => true,
    setScrollRatio: (ratio) => calls.push(["ratio", ratio]),
    refresh: () => calls.push("thumb refresh"),
  };
  scroller.setHorizontalOffset = OutputScroller.prototype.setHorizontalOffset;
  scroller.getVisibleHorizontalWidth = () => 100;
  return { scroller, lineController };
}

test("horizontal wheel accumulates pixel deltas into columns in one animation frame", () => {
  const frames = [];
  const calls = [];
  const { scroller, lineController } = createScroller({ frames, calls });
  const OutputScroller = loadGlobal("src/js/scrollers/Output.Scroller.js", "OutputScroller", {
    requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
  });
  scroller.queueHorizontalWheel = OutputScroller.prototype.queueHorizontalWheel;

  scroller.queueHorizontalWheel(7, { deltaMode: 0 });
  scroller.queueHorizontalWheel(7, { deltaMode: 0 });
  scroller.queueHorizontalWheel(7, { deltaMode: 0 });

  assert.equal(frames.length, 1);
  assert.equal(lineController.offsetX, 0);
  frames[0]();
  assert.equal(lineController.offsetX, 2);
  assert.ok(Math.abs(scroller.pendingHorizontalColumns - 0.1) < 1e-9);
  assert.equal(calls.filter((call) => call === "horizontal viewport").length, 1);
  assert.ok(calls.includes("thumb refresh"));
  assert.ok(!calls.some((call) => ["highlight", "selection", "search", "caret"].includes(call)));
});

test("thumb ratio maps to the full horizontal range and refreshes only visible rows", () => {
  const calls = [];
  const { scroller, lineController } = createScroller({ calls });
  scroller.applyHorizontalScrollFromRatio(0.5);

  assert.equal(lineController.offsetX, 500_000);
  assert.equal(calls.filter((call) => call === "horizontal viewport").length, 1);
  assert.ok(!calls.some((call) => ["highlight", "selection", "search", "caret"].includes(call)));
});
