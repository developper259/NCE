const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("ScrollerManager owns unique registration, activation and destruction", () => {
  class ScrollerStub {
    constructor() {
      this.initCount = 0;
      this.destroyCount = 0;
      this.active = false;
    }
    init() { this.initCount += 1; }
    refreshMetrics() {}
    refresh() {}
    setActive(active) { this.active = active; }
    destroy() {
      this.destroyCount += 1;
      this._destroyed = true;
      this.manager.removeScroller(this);
    }
  }
  const ScrollerManager = loadGlobal(
    "src/js/manager/ScrollerManager.js",
    "ScrollerManager",
    { Scroller: ScrollerStub },
  );
  const manager = new ScrollerManager({ isOnInit: true });
  const first = manager.createScroller({}, manager.VERTICAL_TYPE, false);
  const second = manager.createScroller({}, manager.HORIZONTAL_TYPE, false);

  assert.equal(manager.addScroller(first), first);
  assert.equal(manager.addScroller(first), first);
  manager.addScroller(second);
  assert.equal(first.initCount, 1);
  assert.equal(second.initCount, 1);
  assert.deepEqual(Array.from(manager.scrollers), [first, second]);
  assert.notEqual(first.id, second.id);
  assert.equal(manager.activateScroller(first), true);
  assert.equal(first.active, true);
  assert.equal(manager.deactivateScroller(first), true);
  assert.equal(first.active, false);

  assert.equal(manager.destroyScroller(first), true);
  assert.equal(first.destroyCount, 1);
  assert.deepEqual(Array.from(manager.scrollers), [second]);
  manager.destroyAll();
  assert.equal(second.destroyCount, 1);
  assert.deepEqual(Array.from(manager.scrollers), []);
  assert.equal(manager.activateScroller(second), false);
  assert.equal(manager.destroyScroller(second), false);
  assert.equal(second.destroyCount, 1);

  for (let cycle = 0; cycle < 100; cycle += 1) {
    const scroller = manager.createScroller({}, manager.VERTICAL_TYPE, false);
    manager.addScroller(scroller);
    assert.equal(manager.scrollers.length, 1);
    manager.destroyScroller(scroller);
    assert.equal(manager.scrollers.length, 0);
  }
});

test("low-level Scroller destroy clears registry, DOM, timers, RAF and listeners once", () => {
  const removedListeners = [];
  const clearedTimers = [];
  const cancelledFrames = [];
  let removedDom = 0;
  const Scroller = loadGlobal("src/js/types/Scroller.js", "Scroller", {
    document: {
      removeEventListener(type, listener) {
        removedListeners.push([type, listener]);
      },
    },
    clearTimeout(id) { clearedTimers.push(id); },
  });
  const removedFromRegistry = [];
  const scroller = new Scroller({
    domManager: { cancelFrame(id) { cancelledFrames.push(id); } },
    scrollerManager: {
      removeScroller(item) {
        removedFromRegistry.push(item);
        item.id = null;
      },
    },
  });
  const removedFrom = (name) => ({ removeEventListener(type, listener) {
    removedListeners.push([`${name}:${type}`, listener]);
  } });
  scroller.id = 4;
  scroller.parentOBJ = removedFrom("parent");
  scroller.wheelTarget = removedFrom("wheel");
  scroller.itemOBJ = removedFrom("item");
  scroller.scrollerFast = { remove() { removedDom += 1; } };
  scroller._onPointerDown = () => {};
  scroller._onMouseEnter = () => {};
  scroller._onMouseLeave = () => {};
  scroller._onWheel = () => {};
  scroller._rafId = 31;
  scroller._scrollEndTimer = 47;

  assert.equal(scroller.destroy(), true);
  assert.equal(scroller.destroy(), false);
  assert.deepEqual(removedFromRegistry, [scroller]);
  assert.deepEqual(cancelledFrames, [31]);
  assert.deepEqual(clearedTimers, [47]);
  assert.equal(removedDom, 1);
  assert.deepEqual(removedListeners.map(([type]) => type).sort(), [
    "item:pointerdown",
    "parent:mouseenter",
    "parent:mouseleave",
    "wheel:wheel",
  ].sort());
  assert.equal(scroller.parentOBJ, null);
  assert.equal(scroller.scrollerOBJ, null);
  assert.equal(scroller.onScroll, null);
  assert.equal(scroller.calcIsActive, null);
});

test("scroller components use lifecycle APIs and never mutate the registry", () => {
  const files = [
    "src/js/scrollers/QuickPanel.Scroller.js",
    "src/js/scrollers/FileExplorer.Scroller.js",
    "src/js/scrollers/SearchResults.Scroller.js",
    "src/js/scrollers/MarkdownView.Scroller.js",
    "src/js/scrollers/PictureView.Scroller.js",
    "src/js/scrollers/Settings.Scroller.js",
    "src/js/scrollers/Sidebar.Scroller.js",
    "src/js/scrollers/TabManager.Scroller.js",
    "src/js/scrollers/Output.Scroller.js",
  ];
  for (const file of files) {
    const source = read(file);
    assert.match(source, /destroyScroller/, file);
    assert.doesNotMatch(source, /scrollers\.(?:splice|push|filter)/, file);
  }
  for (const file of [
    "src/js/view/MarkdownView.js",
    "src/js/view/PictureView.js",
    "src/js/view/SettingsView.js",
    "src/js/sidebar/FileExplorer.Sidebar.js",
    "src/js/sidebar/Search.Sidebar.js",
  ]) {
    assert.match(read(file), /destroy\(\)/, file);
  }
});
