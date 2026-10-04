const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

function fixture() {
  const frames = [];
  const calls = { left: 0, right: 0, editorResize: 0 };
  const classSet = () => {
    const classes = new Set();
    return {
      add(value) { classes.add(value); },
      remove(value) { classes.delete(value); },
      contains(value) { return classes.has(value); },
    };
  };
  const mainSection = { classList: classSet() };
  const sidebars = { left: { classList: classSet() }, right: { classList: classSet() } };
  const SidebarManager = loadGlobal(
    "src/js/manager/SidebarManager.js",
    "SidebarManager",
    { requestAnimationFrame(callback) { frames.push(callback); } },
  );
  const manager = Object.assign(Object.create(SidebarManager.prototype), {
    leftSidebar: sidebars.left,
    rightSidebar: sidebars.right,
    leftScroller: { refresh() { calls.left++; } },
    rightScroller: { refresh() { calls.right++; } },
    editor: {
      domManager: {
        getElement(selector) {
          return selector === ".main-section" ? mainSection : null;
        },
        invalidateSidebarMetrics() {},
      },
      sidebarResizer: { updateResizerVisibility() {} },
      lineController: { resizeWidth() { calls.editorResize++; } },
    },
    syncEditorLayout() {},
  });
  return {
    manager,
    calls,
    flushFrame() { frames.shift()?.(); },
  };
}

test("opening and closing a sidebar refreshes only that side's scroller", () => {
  for (const position of ["left", "right"]) {
    const { manager, calls, flushFrame } = fixture();
    manager.openSidebar(position);
    flushFrame();
    assert.deepEqual(calls, {
      left: position === "left" ? 1 : 0,
      right: position === "right" ? 1 : 0,
      editorResize: 1,
    });

    manager.closeSidebar(position);
    flushFrame();
    assert.deepEqual(calls, {
      left: position === "left" ? 2 : 0,
      right: position === "right" ? 2 : 0,
      editorResize: 2,
    });
  }
});
