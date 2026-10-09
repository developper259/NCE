const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { FastDOMNode, loadGlobal } = require("./helpers/runtime");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

class ElementStub {
  constructor(height = 0) {
    this.clientHeight = height;
    this.style = { values: {}, setProperty(name, value) { this.values[name] = value; } };
    this.attributes = new Map();
    this.children = [];
    this.listeners = new Map();
    this.hidden = false;
    this.isConnected = true;
    this.className = "";
    this.disabled = false;
    this.parentElement = null;
  }
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || new Set();
    callbacks.add(callback);
    this.listeners.set(type, callbacks);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  closest() { return null; }
  focus() { this.focused = true; }
}

function createManagerHarness() {
  const calls = [];
  const document = {
    activeElement: new ElementStub(),
    documentElement: new ElementStub(),
    createElement() { return new ElementStub(); },
  };
  const mainSection = new ElementStub(700);
  const domManager = {
    getElement(selector) { return selector === ".main-section" ? mainSection : null; },
    getWindowHeight() { return 800; },
    scheduleLayout(options) { calls.push(["layout", options]); },
  };
  const Manager = loadGlobal("src/js/manager/BottomPanelManager.js", "BottomPanelManager", {
    document,
    window: { innerHeight: 800 },
  });
  const manager = Object.assign(Object.create(Manager.prototype), {
    editor: { domManager, statesManager: { scheduleGlobalStateSave() { calls.push(["persist"]); } } },
    panels: new Map(),
    activePanelId: null,
    visible: false,
    height: 250,
    preferredHeight: 250,
    workspaceKey: "no-workspace",
    workspaceRoot: null,
    workspaceSnapshots: new Map(),
    focusBeforeOpen: null,
    drag: null,
    activationGeneration: 0,
    destroyed: false,
    root: new ElementStub(),
    resizeHandle: new ElementStub(),
    titleElement: new ElementStub(),
    contentElement: new ElementStub(),
    newButton: new ElementStub(),
    viewNavigation: null,
    killButton: new ElementStub(),
    closeButton: new ElementStub(),
    toggleButton: new ElementStub(),
  });
  manager.root.querySelector = () => null;
  manager.syncControls = () => calls.push(["sync"]);
  manager.scheduleLayout = () => calls.push(["layout"]);
  manager.showLoadingState = () => calls.push(["loading"]);
  manager.notifyStateChanged = () => calls.push(["persist"]);
  return { calls, document, manager };
}

test("Bottom Panel loads a registered view once and activates it once", async () => {
  const { manager } = createManagerHarness();
  let finishCreate;
  let creates = 0;
  let opened = 0;
  let activated = 0;
  const view = {
    element: new ElementStub(),
    onOpen() { opened++; },
    onActivate() { activated++; },
  };
  manager.registerPanel({
    id: "terminal",
    title: "Terminal",
    createView() {
      creates++;
      return new Promise((resolve) => { finishCreate = resolve; });
    },
  });

  const first = manager.openPanel("terminal");
  const concurrent = manager.openPanel("terminal");
  assert.equal(creates, 1);
  finishCreate(view);
  assert.deepEqual(await Promise.all([first, concurrent]), [false, true]);
  assert.equal(opened, 1);
  assert.equal(activated, 1);
  assert.equal(manager.visible, true);
  assert.deepEqual(manager.contentElement.children, [view.element]);
});

test("panel visibility preserves the view and resizing stays within live layout bounds", async () => {
  const { manager } = createManagerHarness();
  let opens = 0;
  let deactivations = 0;
  const view = {
    element: new ElementStub(),
    onOpen() { opens++; },
    onDeactivate() { deactivations++; },
  };
  manager.registerPanel({
    id: "terminal",
    title: "Terminal",
    createView: async () => view,
  });

  assert.equal(await manager.openPanel("terminal"), true);
  assert.equal(manager.closePanel(), true);
  assert.equal(manager.panels.get("terminal").view, view);
  assert.equal(await manager.openPanel("terminal"), true);
  assert.equal(opens, 2);
  assert.equal(deactivations, 1);

  assert.equal(manager.resize(1000), true);
  assert.equal(manager.height, 522);
  assert.equal("maximize" in manager, false);
  assert.equal("restore" in manager, false);
  assert.equal(manager.closePanel(), true);
  assert.equal(manager.visible, false);
});

test("restored panel state is validated and does not restore a PTY session", () => {
  const { manager } = createManagerHarness();
  manager.registerPanel({
    id: "terminal",
    title: "Terminal",
    createView: async () => ({ element: new ElementStub() }),
  });

  assert.deepEqual(JSON.parse(JSON.stringify(manager.restoreState({
    visible: false,
    height: 50_000,
    maximized: true,
    activePanelId: "unregistered",
  }))), {
    visible: false,
    height: 1200,
    activePanelId: "terminal",
    terminal: { version: 1, activeTabIndex: 0, tabs: [] },
  });
  assert.equal(manager.maximized, undefined, "stale maximize metadata is ignored");
  assert.equal(manager.panels.get("terminal").view, null);
});

test("Bottom Panel UI contains navigation and kill controls with no maximize action", () => {
  const html = read("src/html/index.html");
  assert.match(html, /class="bottom-panel-views" role="tablist"/);
  assert.match(html, /class="[^"]*bottom-panel-kill[^"]*"[^>]*aria-label="Kill Active Terminal"/);
  assert.doesNotMatch(html, /bottom-panel-maximize|Maximize Bottom Panel|Restore Bottom Panel/);
  assert.match(read("src/css/bottomPanel.css"), /\.bottom-panel-resize-handle:hover::after[^]*--border-accent/);
  assert.match(read("src/css/bottomPanel.css"), /prefers-reduced-motion:\s*reduce/);
});

test("DOMManager coalesces Bottom Panel geometry and refreshes editor metrics", () => {
  const frames = [];
  const calls = [];
  const DOMManager = loadGlobal("src/js/manager/DOMManager.js", "DOMManager", {
    document: { documentElement: { style: {} } },
    window: { innerWidth: 1200, innerHeight: 800 },
    FastDOMNode,
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    cancelAnimationFrame() {},
  });
  const manager = Object.create(DOMManager.prototype);
  manager.layoutFrame = null;
  manager.pendingLayout = manager.createLayoutState();
  manager.editor = {
    bottomPanelManager: {
      onViewportResize() { calls.push("constrain"); },
      applyLayout() { calls.push("apply-panel-geometry"); },
      onLayoutResize() { calls.push("fit-terminal"); },
    },
    lineController: { resize(options) { calls.push(["resize-lines", options]); } },
    scrollerManager: { refreshActive() { calls.push("refresh-active-scroller"); } },
  };
  manager.measureElements = () => calls.push("measure");
  manager.calculate = () => calls.push("calculate");
  manager.apply = () => calls.push("apply");

  manager.scheduleLayout({ bottomPanel: true });
  manager.scheduleLayout({ bottomPanel: true });
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    "constrain",
    "apply-panel-geometry",
    "measure",
    "calculate",
    "apply",
    ["resize-lines", { deferScrollerRefresh: true }],
    "refresh-active-scroller",
    "fit-terminal",
  ]);
});

test("Bottom Panel reduces editor and sidebar bounds above the BottomBar", () => {
  const css = read("src/css/titlebar.css");
  assert.match(css, /\.main-section > \.editor\s*\{[^}]*bottom:\s*calc\(var\(--bottombar-height\) \+ var\(--bottom-panel-height, 0px\)\)[^}]*isolation:\s*isolate/s);
  assert.match(css, /\.main-section > \.sidebar-tab-selector,[\s\S]*?bottom:\s*var\(--bottombar-height\)/);
  assert.match(read("src/css/bottomPanel.css"), /bottom:\s*var\(--bottombar-height\)/);
  assert.match(read("src/css/bottomBar.css"), /z-index:\s*5/);
});
