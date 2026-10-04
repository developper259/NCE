const assert = require("node:assert/strict");
const test = require("node:test");
const { FastDOMNode, loadGlobal } = require("./helpers/runtime");

test("DOMManager caches sidebar widths until the affected side is invalidated", () => {
  const widths = { left: 350, right: 280 };
  const reads = { left: 0, right: 0 };
  const sidebars = {};
  for (const side of ["left", "right"]) {
    sidebars[`.sidebar-${side}`] = {
      style: {},
      getBoundingClientRect() {
        reads[side]++;
        const width = widths[side];
        return { left: 0, top: 0, width, height: 400, right: width, bottom: 400 };
      },
    };
  }
  const document = {
    documentElement: { style: {} },
    querySelector(selector) { return sidebars[selector] || null; },
  };
  const window = { innerWidth: 1200, innerHeight: 800 };
  const DOMManager = loadGlobal("src/js/manager/DOMManager.js", "DOMManager", {
    document,
    window,
    FastDOMNode,
  });
  const manager = new DOMManager({});

  assert.equal(manager.getSidebarWidth("left"), 350);
  assert.equal(manager.getSidebarWidth("left"), 350);
  assert.deepEqual(reads, { left: 1, right: 0 });

  widths.left = 410;
  manager.invalidateSidebarMetrics("left");
  assert.equal(manager.getSidebarWidth("left"), 410);
  assert.equal(manager.getSidebarWidth("right"), 280);
  assert.deepEqual(reads, { left: 2, right: 1 });
});

test("DOMManager element metrics include both horizontal and vertical scroll offsets", () => {
  const DOMManager = loadGlobal("src/js/manager/DOMManager.js", "DOMManager");
  const manager = Object.create(DOMManager.prototype);
  const metrics = manager.measureElement({
    clientWidth: 120,
    clientHeight: 80,
    scrollWidth: 300,
    scrollHeight: 160,
    scrollLeft: 45,
    scrollTop: 20,
    getBoundingClientRect() {
      return { left: 5, top: 8, width: 120, height: 80, right: 125, bottom: 88 };
    },
  });

  assert.equal(metrics.scrollLeft, 45);
  assert.equal(metrics.scrollTop, 20);
  assert.equal(manager.measureElement(null).scrollLeft, 0);
});

test("SidebarManager uses DOMManager metrics for an open sidebar", () => {
  const SidebarManager = loadGlobal(
    "src/js/manager/SidebarManager.js",
    "SidebarManager",
  );
  const calls = [];
  const manager = Object.assign(Object.create(SidebarManager.prototype), {
    leftSidebar: { classList: { contains: (name) => name === "open" } },
    rightSidebar: { classList: { contains: () => false } },
    width: 350,
    editor: {
      domManager: {
        getSidebarWidth(side) { calls.push(side); return 410; },
      },
    },
  });

  assert.equal(manager.getOpenSidebarWidth("left"), 410);
  assert.equal(manager.getOpenSidebarWidth("right"), 0);
  assert.deepEqual(calls, ["left"]);
});
