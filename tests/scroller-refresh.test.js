const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

class MeasuredScroller {
  constructor() {
    this.active = true;
    this.metricReads = 0;
    this.refreshCount = 0;
  }

  init() {}
  refreshMetrics() {
    this.metricReads += 3;
    this._metricsDirty = false;
  }
  refresh() { this.refreshCount += 1; }
  setActive(active) { this.active = active; }
  destroy() { this._destroyed = true; }
}

function createManager() {
  const ScrollerManager = loadGlobal(
    "src/js/manager/ScrollerManager.js",
    "ScrollerManager",
    { Scroller: MeasuredScroller },
  );
  const manager = new ScrollerManager({ isOnInit: false });
  return {
    manager,
    addScroller() {
      return manager.addScroller(
        manager.createScroller({}, manager.VERTICAL_TYPE, false),
      );
    },
  };
}

test("adding one scroller refreshes only its own metrics", () => {
  const { manager, addScroller } = createManager();
  const existing = Array.from({ length: 10 }, addScroller);
  const existingReads = existing.map((scroller) => scroller.metricReads);
  const added = addScroller();

  assert.deepEqual(existingReads, Array(10).fill(3));
  assert.deepEqual(existing.map((scroller) => scroller.metricReads), existingReads);
  assert.equal(added.metricReads, 3);
  assert.equal(manager.scrollers.reduce((sum, scroller) => sum + scroller.metricReads, 0), 33);
});

test("suspended scrollers stay unmeasured during active and targeted refreshes", () => {
  const { manager, addScroller } = createManager();
  const scrollers = Array.from({ length: 10 }, addScroller);
  const suspended = scrollers[0];
  const target = scrollers[1];
  manager.deactivateScroller(suspended);
  for (const scroller of scrollers) scroller.metricReads = 0;

  assert.equal(manager.invalidateScroller(suspended), false);
  assert.equal(manager.refreshActive(), 9);
  assert.equal(suspended.metricReads, 0);
  assert.equal(target.metricReads, 0);

  assert.equal(manager.invalidateScroller(target), true);
  assert.equal(target.metricReads, 3);
  assert.equal(suspended.metricReads, 0);
  assert.equal(scrollers.slice(2).reduce((sum, scroller) => sum + scroller.metricReads, 0), 0);
});

test("activation measures one resumed scroller and full refresh skips suspended views", () => {
  const { manager, addScroller } = createManager();
  const scrollers = Array.from({ length: 10 }, addScroller);
  manager.deactivateScroller(scrollers[0]);
  for (const scroller of scrollers) scroller.metricReads = 0;

  assert.equal(manager.activateScroller(scrollers[0]), true);
  assert.equal(scrollers[0].metricReads, 3);
  assert.equal(scrollers.slice(1).reduce((sum, scroller) => sum + scroller.metricReads, 0), 0);

  manager.deactivateScroller(scrollers[0]);
  for (const scroller of scrollers) scroller.metricReads = 0;
  assert.equal(manager.refreshAll(), 9);
  assert.deepEqual(scrollers.map((scroller) => scroller.metricReads), [
    0, ...Array(9).fill(3),
  ]);
  assert.equal(scrollers[0]._metricsDirty, true);
});

test("hidden invalidations coalesce until resume performs one metric refresh", () => {
  const { manager, addScroller } = createManager();
  const scroller = addScroller();
  manager.deactivateScroller(scroller);
  scroller.metricReads = 0;
  scroller.refreshCount = 0;

  assert.equal(manager.invalidateScroller(scroller), false);
  assert.equal(manager.invalidateScroller(scroller), false);
  assert.equal(manager.refreshAll(), 0);
  assert.equal(scroller.metricReads, 0);
  assert.equal(scroller.refreshCount, 0);
  assert.equal(scroller._metricsDirty, true);

  assert.equal(manager.activateScroller(scroller), true);
  assert.equal(scroller.metricReads, 3);
  assert.equal(scroller.refreshCount, 1);
  assert.equal(scroller._metricsDirty, false);
});
