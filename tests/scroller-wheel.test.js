const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

const Scroller = loadGlobal("src/js/types/Scroller.js", "Scroller");

function createWheelScroller(overrides = {}) {
  const scroller = new Scroller({
    scrollerManager: { VERTICAL_TYPE: 0, HORIZONTAL_TYPE: 1 },
  });
  Object.assign(scroller, {
    type: 0,
    active: true,
    scrollerOBJHeight: 585,
    itemOBJHeight: 40,
    nbItem: 7517,
    heightByItem: 23,
    targetScrollRatio: 0,
    markRecentlyInteracted() {},
    scheduleScrollRender() {},
    ...overrides,
  });
  return scroller;
}

function wheel(scroller, deltaY, deltaMode = 0, deltaX = 0) {
  scroller.handleWheel({
    deltaX,
    deltaY,
    deltaMode,
    shiftKey: false,
    preventDefault() {},
    stopPropagation() {},
  });
}

test("large vertical scrollers map wheel pixels through the full content range", () => {
  const scroller = createWheelScroller();
  const contentRange = 7517 * 23 - 585;

  wheel(scroller, 53);

  assert.equal(scroller.targetScrollRatio, 53 / contentRange);
  assert.ok(scroller.targetScrollRatio < 1 / 100);
});

test("wheel line and page modes use item and viewport sizes", () => {
  const contentRange = 7517 * 23 - 585;
  const lineScroller = createWheelScroller();
  const pageScroller = createWheelScroller();

  wheel(lineScroller, 2, 1);
  wheel(pageScroller, 1, 2);

  assert.equal(lineScroller.targetScrollRatio, (2 * 23) / contentRange);
  assert.equal(pageScroller.targetScrollRatio, 585 / contentRange);
});

test("scrollers without item metrics keep the legacy ratio mapping", () => {
  const scroller = createWheelScroller({
    type: 1,
    scrollerOBJWidth: 200,
    itemOBJWidth: 50,
    nbItem: 0,
    heightByItem: 0,
  });

  wheel(scroller, 0, 0, 120);

  assert.equal(scroller.targetScrollRatio, 0.3);
});
