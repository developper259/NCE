const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

class CountingScroller {
  constructor() {
    this.active = true;
    this.refreshCount = 0;
    this.metricReads = 0;
  }
  init() {}
  refreshMetrics() { this.metricReads += 1; this._metricsDirty = false; }
  refresh() { this.refreshCount += 1; }
  setScrollRatio(value) { this.ratio = value; }
  setActive(active) { this.active = active; }
  destroy() { this._destroyed = true; }
}

function createHarness() {
  let nextFrameId = 0;
  const frames = new Map();
  const editor = {
    isOnInit: false,
    domManager: {
      requestFrame(callback) {
        const frameId = ++nextFrameId;
        frames.set(frameId, callback);
        return frameId;
      },
      cancelFrame(frameId) { frames.delete(frameId); },
      getElementMetrics(element) {
        return {
          scrollTop: element.scrollTop || 0,
          clientHeight: element.clientHeight || 0,
          scrollHeight: element.scrollHeight || 0,
        };
      },
    },
  };
  const ScrollerManager = loadGlobal(
    "src/js/manager/ScrollerManager.js",
    "ScrollerManager",
    { Scroller: CountingScroller },
  );
  const manager = new ScrollerManager(editor);
  editor.scrollerManager = manager;
  return {
    editor,
    manager,
    frames,
    flushFrames() {
      while (frames.size) {
        const [frameId, callback] = frames.entries().next().value;
        frames.delete(frameId);
        callback();
      }
    },
  };
}

function observerGlobals() {
  const mutationObservers = [];
  const resizeObservers = [];
  class ObserverStub {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      this.disconnected = false;
    }
    observe(target) {
      this.targets.add(target);
      this.disconnected = false;
    }
    unobserve(target) { this.targets.delete(target); }
    disconnect() {
      this.targets.clear();
      this.disconnected = true;
    }
    emit(entries = []) { this.callback(entries); }
  }
  class MutationObserverStub extends ObserverStub {
    constructor(callback) {
      super(callback);
      mutationObservers.push(this);
    }
  }
  class ResizeObserverStub extends ObserverStub {
    constructor(callback) {
      super(callback);
      resizeObservers.push(this);
    }
  }
  return { mutationObservers, resizeObservers, MutationObserver: MutationObserverStub, ResizeObserver: ResizeObserverStub };
}

test("ScrollerManager batches observer refresh callbacks into one frame", () => {
  const { manager, frames, flushFrames } = createHarness();
  const owner = {};
  let refreshCount = 0;
  for (let index = 0; index < 100; index += 1) {
    manager.scheduleObserverRefresh(owner, () => { refreshCount += 1; });
  }

  assert.equal(frames.size, 1);
  assert.equal(manager.observerRefreshCallbacks.size, 1);
  assert.equal(refreshCount, 0);
  flushFrames();
  assert.equal(refreshCount, 1);
  assert.equal(frames.size, 0);
  manager.destroyAll();
});

test("Markdown mutation and resize bursts coalesce while preserving new content metrics", () => {
  const observers = observerGlobals();
  const { editor, manager, frames, flushFrames } = createHarness();
  const viewport = {
    scrollTop: 100,
    clientHeight: 100,
    scrollHeight: 200,
    addEventListener() {},
    removeEventListener() {},
  };
  const content = {};
  const MarkdownViewScroller = loadGlobal(
    "src/js/scrollers/MarkdownView.Scroller.js",
    "MarkdownViewScroller",
    observers,
  );
  const view = new MarkdownViewScroller(editor, viewport, {}, content);
  const scroller = view.vScroller;
  const refreshBefore = scroller.refreshCount;
  const metricsBefore = scroller.metricReads;
  const mutationObserver = observers.mutationObservers[0];
  const resizeObserver = observers.resizeObservers[0];

  viewport.scrollHeight = 300;
  for (let index = 0; index < 50; index += 1) mutationObserver.emit();
  resizeObserver.emit([{ target: viewport }]);

  assert.equal(frames.size, 1);
  assert.equal(manager.observerRefreshCallbacks.size, 1);
  flushFrames();
  assert.equal(scroller.refreshCount, refreshBefore + 1);
  assert.equal(scroller.metricReads, metricsBefore + 1);
  assert.equal(scroller.ratio, 0.5);

  mutationObserver.emit();
  assert.equal(frames.size, 1);
  const beforeDestroy = scroller.refreshCount;
  view.destroy();
  assert.equal(manager.observerRefreshCallbacks.size, 0);
  assert.equal(frames.size, 0);
  flushFrames();
  assert.equal(scroller.refreshCount, beforeDestroy);
  manager.destroyAll();
});

test("suspended SidebarScroller ignores queued observer work until it resumes", () => {
  const observers = observerGlobals();
  const { editor, manager, frames } = createHarness();
  const menu = {
    scrollTop: 40,
    clientHeight: 100,
    scrollHeight: 300,
    addEventListener() {},
    removeEventListener() {},
  };
  const SidebarScroller = loadGlobal(
    "src/js/scrollers/Sidebar.Scroller.js",
    "SidebarScroller",
    observers,
  );
  const sidebar = new SidebarScroller(editor, {}, menu);
  sidebar.init();
  const scroller = sidebar.vScroller;
  const refreshBeforeSuspend = scroller.refreshCount;
  const metricsBeforeSuspend = scroller.metricReads;
  const mutationObserver = observers.mutationObservers[0];
  const resizeObserver = observers.resizeObservers[0];

  sidebar.suspend();
  mutationObserver.emit();
  resizeObserver.emit([{ target: menu }]);
  assert.equal(frames.size, 0);
  assert.equal(scroller.refreshCount, refreshBeforeSuspend);
  assert.equal(scroller.metricReads, metricsBeforeSuspend);

  sidebar.resume();
  assert.equal(scroller.refreshCount, refreshBeforeSuspend + 1);
  assert.equal(scroller.metricReads, metricsBeforeSuspend + 1);
  sidebar.destroy();
  manager.destroyAll();
});

test("Settings and picture observers use the shared refresh scheduler", () => {
  const observers = observerGlobals();
  const { editor, manager, frames, flushFrames } = createHarness();
  const settingsContent = {
    scrollTop: 0,
    clientHeight: 100,
    scrollHeight: 200,
  };
  const SettingsScroller = loadGlobal(
    "src/js/scrollers/Settings.Scroller.js",
    "SettingsScroller",
    observers,
  );
  const settings = new SettingsScroller(editor, {}, settingsContent);
  settings.init();
  const settingsNode = settings.vScroller;
  const settingsRefreshBefore = settingsNode.refreshCount;
  observers.mutationObservers.at(-1).emit();
  observers.resizeObservers.at(-1).emit([{ target: settingsContent }]);
  assert.equal(frames.size, 1);
  flushFrames();
  assert.equal(settingsNode.refreshCount, settingsRefreshBefore + 1);
  settings.destroy();

  const image = {};
  const viewport = {
    clientHeight: 100,
    clientWidth: 100,
    scrollHeight: 200,
    scrollWidth: 250,
    scrollTop: 50,
    scrollLeft: 25,
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => image,
  };
  const PictureViewScroller = loadGlobal(
    "src/js/scrollers/PictureView.Scroller.js",
    "PictureViewScroller",
    observers,
  );
  const picture = new PictureViewScroller(editor, viewport, {});
  const vertical = picture.vScroller;
  const horizontal = picture.hScroller;
  const pictureRefreshBefore = vertical.refreshCount + horizontal.refreshCount;
  observers.resizeObservers.at(-1).emit([
    { target: viewport },
    { target: image },
  ]);
  assert.equal(frames.size, 1);
  flushFrames();
  assert.equal(
    vertical.refreshCount + horizontal.refreshCount,
    pictureRefreshBefore + 2,
  );
  picture.destroy();
  manager.destroyAll();
});
