const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

function classSet() {
  const classes = new Set();
  return {
    add(value) { classes.add(value); },
    remove(value) { classes.delete(value); },
    contains(value) { return classes.has(value); },
  };
}

function fixture({ leftWidth = 300, rightWidth = 250 } = {}) {
  const frames = [];
  const calls = {
    apply: 0,
    calculate: 0,
    caret: 0,
    editorResize: 0,
    invalidations: [],
    left: 0,
    measure: 0,
    right: 0,
    tabs: 0,
  };
  const mainSection = { classList: classSet() };
  const sidebars = {
    left: { classList: classSet(), style: {} },
    right: { classList: classSet(), style: {} },
  };
  const fileManager = { style: {} };
  const editorElement = { style: {} };
  const SidebarManager = loadGlobal(
    "src/js/manager/SidebarManager.js",
    "SidebarManager",
    { requestAnimationFrame(callback) { frames.push(callback); } },
  );
  const SidebarResizer = loadGlobal(
    "src/js/addon/SidebarResizer.js",
    "SidebarResizer",
  );
  const domManager = {
    sidebarResizer: { width: 48 },
    getElement(selector) {
      if (selector === ".main-section") return mainSection;
      if (selector === ".sidebar-left") return sidebars.left;
      if (selector === ".sidebar-right") return sidebars.right;
      return null;
    },
    getSidebarWidth(side) {
      const inlineWidth = Number.parseFloat(sidebars[side].style.width);
      if (Number.isFinite(inlineWidth)) return inlineWidth;
      return side === "left" ? leftWidth : rightWidth;
    },
    invalidateSidebarMetrics(side) { calls.invalidations.push(side); },
    measureElements() { calls.measure++; },
    calculate() { calls.calculate++; },
    apply() { calls.apply++; },
  };
  const editor = {
    cursorController: { updateCaretPosition() { calls.caret++; } },
    domManager,
    editorOBJ: editorElement,
    fileManagerOBJ: fileManager,
    lineController: { resizeWidth() { calls.editorResize++; } },
    tabManager: { tabScroller: { refresh() { calls.tabs++; } } },
  };
  const manager = Object.assign(Object.create(SidebarManager.prototype), {
    editor,
    leftSidebar: sidebars.left,
    rightSidebar: sidebars.right,
    leftScroller: { refresh() { calls.left++; } },
    rightScroller: { refresh() { calls.right++; } },
    selectorWidth: 48,
    width: 350,
  });
  const resizer = Object.assign(Object.create(SidebarResizer.prototype), {
    editor,
    leftResizer: { style: {} },
    rightResizer: { style: {} },
  });
  editor.sidebarManager = manager;
  editor.sidebarResizer = resizer;

  return {
    calls,
    editorElement,
    fileManager,
    frames,
    manager,
    resizer,
    sidebars,
    flushFrame() { frames.shift()?.(); },
    flushFrames() {
      while (frames.length > 0) frames.shift()();
    },
  };
}

function assertHorizontalBounds(fixtureValue, left, right) {
  const expected = { left: `${left}px`, right: `${right}px`, width: "" };
  assert.deepEqual(fixtureValue.fileManager.style, expected);
  assert.deepEqual(fixtureValue.editorElement.style, expected);
}

test("editor and tab manager share the bounds for every sidebar state", () => {
  const cases = [
    { leftOpen: false, rightOpen: false, left: 48, right: 0 },
    { leftOpen: true, rightOpen: false, left: 348, right: 0 },
    { leftOpen: false, rightOpen: true, left: 48, right: 250 },
    { leftOpen: true, rightOpen: true, left: 348, right: 250 },
  ];

  for (const current of cases) {
    const layout = fixture();
    if (current.leftOpen) layout.sidebars.left.classList.add("open");
    if (current.rightOpen) layout.sidebars.right.classList.add("open");

    layout.manager.syncEditorLayout();

    assertHorizontalBounds(layout, current.left, current.right);
  }
});

test("closing either sidebar restores only its own layout constraint", () => {
  const layout = fixture();
  layout.sidebars.left.classList.add("open");
  layout.sidebars.right.classList.add("open");
  layout.manager.syncEditorLayout();
  assertHorizontalBounds(layout, 348, 250);

  layout.manager.closeSidebar("right");
  assertHorizontalBounds(layout, 348, 0);

  layout.manager.openSidebar("right");
  layout.manager.closeSidebar("left");
  assertHorizontalBounds(layout, 48, 250);
});

test("SidebarResizer delegates layout and preserves the opposite constraint", () => {
  const layout = fixture();
  layout.sidebars.left.classList.add("open");
  layout.sidebars.right.classList.add("open");
  layout.manager.syncEditorLayout();
  let syncCount = 0;
  const syncEditorLayout = layout.manager.syncEditorLayout.bind(layout.manager);
  layout.manager.syncEditorLayout = () => {
    syncCount++;
    syncEditorLayout();
  };

  layout.resizer.applyWidth(400, "left");
  assert.equal(layout.sidebars.left.style.width, "400px");
  assertHorizontalBounds(layout, 448, 250);
  assert.equal(syncCount, 1);
  assert.equal(layout.calls.tabs, 0);
  layout.flushFrames();
  assert.equal(layout.calls.tabs, 1);

  layout.resizer.applyWidth(420, "right");
  assert.equal(layout.sidebars.right.style.width, "420px");
  assertHorizontalBounds(layout, 448, 420);
  assert.equal(syncCount, 2);
  assert.deepEqual(layout.calls.invalidations.slice(-2), ["left", "right"]);
  assert.equal(layout.calls.tabs, 1);
  layout.flushFrames();
  assert.equal(layout.calls.tabs, 2);
});

test("opening and closing a sidebar refreshes after layout on the next frame", () => {
  for (const position of ["left", "right"]) {
    const layout = fixture();
    layout.manager.openSidebar(position);
    assert.equal(layout.calls.tabs, 0);
    layout.flushFrame();
    assert.deepEqual(
      {
        editorResize: layout.calls.editorResize,
        left: layout.calls.left,
        right: layout.calls.right,
        tabs: layout.calls.tabs,
      },
      {
        editorResize: 1,
        left: position === "left" ? 1 : 0,
        right: position === "right" ? 1 : 0,
        tabs: 1,
      },
    );

    layout.manager.closeSidebar(position);
    assert.equal(layout.calls.tabs, 1);
    layout.flushFrame();
    assert.deepEqual(
      {
        editorResize: layout.calls.editorResize,
        left: layout.calls.left,
        right: layout.calls.right,
        tabs: layout.calls.tabs,
      },
      {
        editorResize: 2,
        left: position === "left" ? 2 : 0,
        right: position === "right" ? 2 : 0,
        tabs: 2,
      },
    );
  }
});
