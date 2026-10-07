const assert = require("node:assert/strict");
const test = require("node:test");
const { FastDOMNode, loadGlobal } = require("./helpers/runtime");

function createHarness() {
  const frames = [];
  const calls = [];
  const DOMManager = loadGlobal("src/js/manager/DOMManager.js", "DOMManager", {
    document: { documentElement: { style: {} } },
    window: { innerWidth: 1200, innerHeight: 800 },
    FastDOMNode,
    requestAnimationFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    cancelAnimationFrame() {},
  });
  const manager = Object.create(DOMManager.prototype);
  manager.layoutFrame = null;
  manager.pendingLayout = manager.createLayoutState();
  manager.editor = {
    sidebarManager: {
      syncEditorLayout(...args) { calls.push(["prepare-sidebar", ...args]); },
      refreshLayout(...args) { calls.push(["refresh-sidebar", ...args]); },
    },
    lineController: {
      resize() { calls.push(["resize-lines"]); },
      resizeWidth() { calls.push(["resize-line-width"]); },
    },
    scrollerManager: { refreshAll() { calls.push(["refresh-scrollers"]); } },
    tabManager: {
      tabScroller: {
        refresh(...args) { calls.push(["refresh-tabs", ...args]); },
      },
    },
    quickPanel: {
      resultsScroller: { refresh() { calls.push(["refresh-quick-panel"]); } },
    },
  };
  manager.measureWindow = () => calls.push(["measure-window"]);
  manager.measureElements = () => calls.push(["measure-elements"]);
  manager.calculate = () => calls.push(["calculate"]);
  manager.apply = () => calls.push(["apply"]);
  return {
    calls,
    frames,
    manager,
    flushFrame() { frames.shift()?.(); },
  };
}

test("ten synchronous window resizes share one read-calculate-write frame", () => {
  const harness = createHarness();

  for (let index = 0; index < 10; index += 1) harness.manager.resize();

  assert.equal(harness.frames.length, 1);
  assert.deepEqual(harness.calls, []);
  harness.flushFrame();

  assert.deepEqual(harness.calls.map(([name]) => name), [
    "measure-window",
    "prepare-sidebar",
    "measure-elements",
    "calculate",
    "apply",
    "resize-lines",
    "refresh-scrollers",
  ]);
  assert.equal(harness.frames.length, 0);
});

test("sidebar changes and style-only updates coalesce and refresh one affected layout", () => {
  const harness = createHarness();
  harness.manager.scheduleLayout({ sidebar: true, sidebarPosition: "left" });
  harness.manager.scheduleLayout({ sidebar: true, sidebarPosition: "right" });
  harness.manager.scheduleApply();

  assert.equal(harness.frames.length, 1);
  harness.flushFrame();

  assert.deepEqual(harness.calls.map(([name]) => name), [
    "measure-elements",
    "calculate",
    "apply",
    "refresh-sidebar",
  ]);
  assert.deepEqual(harness.calls.at(-1), ["refresh-sidebar", null]);
  assert.equal(harness.frames.length, 0);
});

test("SidebarManager coalesces width writes and refreshes the affected sidebar once", () => {
  const harness = createHarness();
  const SidebarManager = loadGlobal(
    "src/js/manager/SidebarManager.js",
    "SidebarManager",
  );
  const classes = new Set(["open"]);
  const editor = harness.manager.editor;
  const leftSidebar = {
    classList: {
      contains(name) { return classes.has(name); },
    },
    style: {},
  };
  editor.editorOBJ = { style: {} };
  editor.fileManagerOBJ = { style: {} };
  editor.sidebarResizer = {
    setEffectiveWidth(side, width) {
      leftSidebar.style.width = `${width}px`;
      return true;
    },
    updateResizerPositions() {},
  };
  const sidebar = Object.assign(Object.create(SidebarManager.prototype), {
    editor,
    leftSidebar,
    rightSidebar: null,
    selectorWidth: 48,
    getEffectiveSidebarWidths() {
      return { left: nextWidth, right: 0 };
    },
    getOpenSidebarWidth(side) {
      return side === "left" ? nextWidth : 0;
    },
  });
  let nextWidth = 300;
  editor.domManager = harness.manager;
  editor.sidebarManager = sidebar;
  sidebar.leftScroller = { refresh() { harness.calls.push(["refresh-left"]); } };

  sidebar.syncEditorLayout("left");
  nextWidth = 320;
  sidebar.syncEditorLayout("left");
  sidebar.scheduleSidebarRefresh("left");
  harness.manager.scheduleApply();

  assert.equal(harness.frames.length, 1);
  assert.equal(leftSidebar.style.width, "320px");
  assert.equal(editor.editorOBJ.style.left, "368px");
  assert.equal(editor.fileManagerOBJ.style.left, "368px");
  harness.flushFrame();

  assert.deepEqual(harness.calls.map(([name]) => name), [
    "measure-elements",
    "calculate",
    "apply",
    "resize-line-width",
    "refresh-tabs",
    "refresh-left",
  ]);
  assert.equal(harness.frames.length, 0);
});

test("style-only layout updates skip DOM reads and do not schedule a follow-up frame", () => {
  const harness = createHarness();
  harness.manager.scheduleApply();
  assert.equal(harness.frames.length, 1);
  harness.flushFrame();

  assert.deepEqual(harness.calls, [["apply"]]);
  assert.equal(harness.frames.length, 0);
});

test("setting the existing line number width does not queue another layout frame", () => {
  const harness = createHarness();
  harness.manager.lineNumbers = { width: 40 };
  harness.manager.output = { x: 50, width: 1150 };
  harness.manager.editorDimensions = { width: 1200 };

  harness.manager.setLineNumberWidth(40);

  assert.equal(harness.frames.length, 0);
  assert.equal(harness.manager.output.x, 50);
  assert.equal(harness.manager.output.width, 1150);

  harness.manager.setLineNumberWidth(50);
  assert.equal(harness.frames.length, 1);
  harness.flushFrame();
  assert.equal(harness.calls.filter(([name]) => name === "apply").length, 1);
  assert.equal(harness.frames.length, 0);
});

test("Events routes resize bursts through DOMManager's coalescing scheduler", () => {
  const harness = createHarness();
  const Events = loadGlobal("src/js/core/Event.js", "Events", {
    document: { addEventListener() {} },
    window: { addEventListener() {} },
    requestAnimationFrame() { throw new Error("resize must use the shared scheduler"); },
  });
  const events = new Events({ domManager: harness.manager });

  for (let index = 0; index < 10; index += 1) events.onResize();

  assert.equal(harness.frames.length, 1);
  harness.flushFrame();
  assert.equal(harness.calls.filter(([name]) => name === "measure-window").length, 1);
  assert.equal(harness.calls.filter(([name]) => name === "measure-elements").length, 1);
  assert.equal(harness.calls.filter(([name]) => name === "apply").length, 1);
  assert.equal(harness.frames.length, 0);
});
