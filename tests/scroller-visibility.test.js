const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

function createScroller(extraGlobals = {}) {
  let nextTimerId = 0;
  const timers = new Map();
  const cleared = [];
  let opacity = "0";
  const Scroller = loadGlobal("src/js/types/Scroller.js", "Scroller", {
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
      timers.delete(id);
    },
    requestAnimationFrame() { return 1; },
    cancelAnimationFrame() {},
    ...extraGlobals,
  });
  const editor = {
    scrollerManager: { VERTICAL_TYPE: 0, HORIZONTAL_TYPE: 1 },
    domManager: {
      getElementMetrics() { return { top: 0, left: 0 }; },
    },
  };
  const scroller = new Scroller(editor);
  scroller.scrollerOBJ = {};
  scroller.itemOBJ = { removeEventListener() {} };
  scroller.scrollerFast = {
    setOpacity(value) { opacity = String(value); },
    toggleClass() {},
    remove() {},
  };
  scroller.scrollerOBJHeight = 100;
  scroller.itemOBJHeight = 20;
  scroller.calcIsActive = () => true;
  const runTimers = (delay) => {
    for (const [id, timer] of [...timers]) {
      if (timer.delay !== delay) continue;
      timers.delete(id);
      timer.callback();
    }
  };
  return {
    scroller,
    timers,
    cleared,
    runTimers,
    opacity: () => opacity,
  };
}

test("hover shows the thumb and mouse leave fades it unless an interaction is recent", () => {
  const fixture = createScroller();
  const { scroller } = fixture;
  scroller.isHovered = true;
  scroller.updateVisibility();
  assert.equal(fixture.opacity(), "1");

  scroller.isHovered = false;
  scroller.updateVisibility();
  assert.equal(fixture.opacity(), "0");

  scroller.markRecentlyInteracted();
  scroller.isHovered = true;
  scroller.updateVisibility();
  scroller.isHovered = false;
  scroller.updateVisibility();
  assert.equal(fixture.opacity(), "1");
  fixture.runTimers(650);
  assert.equal(fixture.opacity(), "0");
});

test("drag start and end keep the thumb visible briefly without hover events", () => {
  const fixture = createScroller();
  const { scroller } = fixture;
  scroller.parentOBJ = {};
  let prevented = false;
  assert.equal(scroller.handlePointerDown({ clientY: 5, preventDefault() { prevented = true; } }), true);
  assert.equal(prevented, true);
  assert.equal(fixture.opacity(), "1");

  scroller.handlePointerUp();
  assert.equal(scroller.isDragging, false);
  assert.equal(fixture.opacity(), "1");
  fixture.runTimers(650);
  assert.equal(fixture.opacity(), "0");
});

test("wheel interaction shows the thumb and schedules its fade", () => {
  const fixture = createScroller();
  const { scroller } = fixture;
  let prevented = false;
  scroller.handleWheel({
    deltaX: 0,
    deltaY: 12,
    shiftKey: false,
    preventDefault() { prevented = true; },
    stopPropagation() {},
  });
  assert.equal(prevented, true);
  assert.equal(fixture.opacity(), "1");
  assert.equal([...fixture.timers.values()].some((timer) => timer.delay === 650), true);
  fixture.runTimers(650);
  assert.equal(fixture.opacity(), "0");
});

test("inactive scrollers remain hidden during hover, drag and wheel", () => {
  const fixture = createScroller();
  const { scroller } = fixture;
  scroller.setActive(false);
  scroller.isHovered = true;
  scroller.updateVisibility();
  assert.equal(fixture.opacity(), "0");
  assert.equal(scroller.handlePointerDown({ clientY: 0 }), false);
  scroller.handleWheel({ deltaX: 0, deltaY: 1, preventDefault() {}, stopPropagation() {} });
  assert.equal(fixture.opacity(), "0");
});

test("destroy during interaction clears the fade timer and visibility state", () => {
  const fixture = createScroller();
  const { scroller } = fixture;
  scroller.markRecentlyInteracted();
  const timerId = scroller._interactionTimer;
  scroller.destroy();
  assert.equal(scroller._interactionTimer, null);
  assert.equal(scroller.recentlyInteracted, false);
  assert.equal(fixture.timers.has(timerId), false);
  assert.ok(fixture.cleared.includes(timerId));
});

test("deactivation cancels pending animation and scroll-end work", () => {
  const cancelledFrames = [];
  const fixture = createScroller({
    cancelAnimationFrame(id) { cancelledFrames.push(id); },
  });
  const { scroller } = fixture;
  scroller._rafId = 44;
  scroller._scrollEndTimer = 45;
  scroller.scrollRatio = 0.25;
  scroller.targetScrollRatio = 0.75;

  scroller.setActive(false);

  assert.deepEqual(cancelledFrames, [44]);
  assert.ok(fixture.cleared.includes(45));
  assert.equal(scroller._rafId, null);
  assert.equal(scroller._scrollEndTimer, null);
  assert.equal(scroller.targetScrollRatio, 0.25);
});
