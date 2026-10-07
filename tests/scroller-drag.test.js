const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
    this.capturedPointerIds = new Set();
    this.captureCalls = [];
    this.releaseCalls = [];
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
    if (this.listeners.get(type)?.size === 0) this.listeners.delete(type);
  }

  dispatch(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) || [])]) {
      listener({ type, target: this, ...event });
    }
  }

  setPointerCapture(pointerId) {
    this.captureCalls.push(pointerId);
    this.capturedPointerIds.add(pointerId);
  }

  hasPointerCapture(pointerId) {
    return this.capturedPointerIds.has(pointerId);
  }

  releasePointerCapture(pointerId) {
    this.releaseCalls.push(pointerId);
    this.capturedPointerIds.delete(pointerId);
  }

  get listenerCount() {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }
}

function createHarness() {
  const document = new FakeEventTarget();
  const window = new FakeEventTarget();
  const Scroller = loadGlobal("src/js/types/Scroller.js", "Scroller", { document });
  const ScrollerManager = loadGlobal(
    "src/js/manager/ScrollerManager.js",
    "ScrollerManager",
    { Scroller, document, window },
  );
  const editor = {
    isOnInit: true,
    scrollerManager: null,
    domManager: {
      getElementMetrics(element) {
        return element?.rect || { left: 10, top: 20 };
      },
    },
    sidebarResizer: null,
  };
  editor.scrollerManager = new ScrollerManager(editor);
  return { document, window, Scroller, manager: editor.scrollerManager, editor };
}

function createRegisteredScroller(harness, type) {
  const scroller = new harness.Scroller(harness.editor);
  const track = { rect: { left: 10, top: 20 } };
  const thumb = new FakeEventTarget();
  Object.assign(scroller, {
    type,
    active: true,
    parentOBJ: new FakeEventTarget(),
    scrollerOBJ: track,
    itemOBJ: thumb,
    scrollerOBJWidth: 100,
    scrollerOBJHeight: 100,
    itemOBJWidth: 20,
    itemOBJHeight: 20,
    init() {},
    scheduleScrollRender() {},
  });
  harness.manager.addScroller(scroller);
  return scroller;
}

test("ten scrollers share one pointer drag listener set and captured drags survive pointer exit", () => {
  const harness = createHarness();
  const { manager, document, window } = harness;
  const scrollers = Array.from({ length: 10 }, () =>
    createRegisteredScroller(harness, manager.HORIZONTAL_TYPE),
  );
  assert.equal(document.listenerCount, 0);

  const scroller = scrollers[0];
  const thumb = scroller.itemOBJ;
  scroller.addScrollListeners();
  let prevented = false;
  thumb.dispatch("pointerdown", {
    pointerId: 11,
    clientX: 15,
    clientY: 25,
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(manager.activeDrag.scroller, scroller);
  assert.equal(document.listenerCount, 4);
  assert.equal(window.listenerCount, 1);
  assert.deepEqual(thumb.captureCalls, [11]);

  document.dispatch("pointermove", {
    pointerId: 12,
    clientX: 90,
    clientY: 25,
    target: new FakeEventTarget(),
  });
  assert.equal(scroller.targetScrollRatio, 0);
  document.dispatch("pointermove", {
    pointerId: 11,
    clientX: 55,
    clientY: 25,
    target: new FakeEventTarget(),
  });
  assert.equal(scroller.targetScrollRatio, 0.5);
  assert.equal(manager.activeDrag.scroller, scroller);

  document.dispatch("pointerup", { pointerId: 11 });
  assert.equal(manager.activeDrag, null);
  assert.equal(document.listenerCount, 0);
  assert.equal(window.listenerCount, 0);
  assert.deepEqual(thumb.releaseCalls, [11]);
  assert.equal(scroller.isDragging, false);
});

test("vertical and horizontal drags use their axis, and pointercancel releases capture", () => {
  const harness = createHarness();
  const { manager, document, window } = harness;
  const vertical = createRegisteredScroller(harness, manager.VERTICAL_TYPE);
  const horizontal = createRegisteredScroller(harness, manager.HORIZONTAL_TYPE);

  manager.startDrag(vertical, {
    currentTarget: vertical.itemOBJ,
    pointerId: 21,
    clientX: 0,
    clientY: 25,
    preventDefault() {},
  });
  document.dispatch("pointermove", { pointerId: 21, clientX: 80, clientY: 65 });
  assert.equal(vertical.targetScrollRatio, 0.5);
  document.dispatch("pointercancel", { pointerId: 21 });
  assert.equal(manager.activeDrag, null);
  assert.deepEqual(vertical.itemOBJ.releaseCalls, [21]);
  assert.equal(document.listenerCount, 0);
  assert.equal(window.listenerCount, 0);

  manager.startDrag(horizontal, {
    currentTarget: horizontal.itemOBJ,
    pointerId: 22,
    clientX: 15,
    clientY: 0,
    preventDefault() {},
  });
  document.dispatch("pointermove", { pointerId: 22, clientX: 55, clientY: 80 });
  assert.equal(horizontal.targetScrollRatio, 0.5);
  document.dispatch("pointerup", { pointerId: 22 });
  assert.equal(document.listenerCount, 0);
});

test("destroying a scroller during drag releases capture and global listeners", () => {
  const harness = createHarness();
  const { manager, document, window } = harness;
  let resizerRestoreCount = 0;
  const resizerDisplay = [];
  harness.editor.domManager.wrapFastNode = () => ({
    setDisplay(value) { resizerDisplay.push(value); },
  });
  harness.editor.sidebarResizer = {
    leftResizer: {},
    rightResizer: {},
    updateResizerVisibility() { resizerRestoreCount += 1; },
  };
  const scroller = createRegisteredScroller(harness, manager.VERTICAL_TYPE);
  let scrollEndCount = 0;
  scroller.onScrollEnd = () => { scrollEndCount += 1; };
  const thumb = scroller.itemOBJ;

  manager.startDrag(scroller, {
    currentTarget: thumb,
    pointerId: 31,
    clientX: 0,
    clientY: 25,
    preventDefault() {},
  });
  assert.equal(document.listenerCount, 4);
  assert.equal(window.listenerCount, 1);
  assert.equal(manager.destroyScroller(scroller), true);
  assert.equal(document.listenerCount, 0);
  assert.equal(window.listenerCount, 0);
  assert.equal(manager.activeDrag, null);
  assert.deepEqual(thumb.releaseCalls, [31]);
  assert.deepEqual(resizerDisplay, ["none", "none"]);
  assert.equal(resizerRestoreCount, 1);
  assert.equal(scroller.isDragging, false);
  assert.equal(scrollEndCount, 0);
  assert.equal(manager.scrollers.length, 0);
});

test("unexpected lost pointer capture cancels the active drag", () => {
  const harness = createHarness();
  const { manager, document, window } = harness;
  const scroller = createRegisteredScroller(harness, manager.HORIZONTAL_TYPE);
  const thumb = scroller.itemOBJ;

  manager.startDrag(scroller, {
    currentTarget: thumb,
    pointerId: 41,
    clientX: 15,
    clientY: 0,
    preventDefault() {},
  });
  thumb.capturedPointerIds.delete(41);
  document.dispatch("lostpointercapture", { pointerId: 41 });

  assert.equal(manager.activeDrag, null);
  assert.equal(document.listenerCount, 0);
  assert.equal(window.listenerCount, 0);
  assert.equal(scroller.isDragging, false);
  assert.deepEqual(thumb.releaseCalls, []);
});

test("deactivation cancels a drag before suspending its scroller", () => {
  const harness = createHarness();
  const { manager, document, window } = harness;
  const scroller = createRegisteredScroller(harness, manager.VERTICAL_TYPE);
  const thumb = scroller.itemOBJ;
  manager.startDrag(scroller, {
    currentTarget: thumb,
    pointerId: 51,
    clientX: 0,
    clientY: 25,
    preventDefault() {},
  });

  assert.equal(manager.deactivateScroller(scroller), true);
  assert.equal(scroller.active, false);
  assert.equal(scroller.isDragging, false);
  assert.equal(manager.activeDrag, null);
  assert.equal(document.listenerCount, 0);
  assert.equal(window.listenerCount, 0);
  assert.deepEqual(thumb.releaseCalls, [51]);
});

test("window blur ends the active drag and releases pointer capture listeners", () => {
  const harness = createHarness();
  const { manager, document, window } = harness;
  const scroller = createRegisteredScroller(harness, manager.VERTICAL_TYPE);
  let scrollEndCount = 0;
  scroller.onScrollEnd = () => { scrollEndCount += 1; };
  const thumb = scroller.itemOBJ;
  manager.startDrag(scroller, {
    currentTarget: thumb,
    pointerId: 61,
    clientX: 0,
    clientY: 25,
    preventDefault() {},
  });

  window.dispatch("blur");

  assert.equal(manager.activeDrag, null);
  assert.equal(document.listenerCount, 0);
  assert.equal(window.listenerCount, 0);
  assert.deepEqual(thumb.releaseCalls, [61]);
  assert.equal(scroller.isDragging, false);
  assert.equal(scrollEndCount, 1);
});
