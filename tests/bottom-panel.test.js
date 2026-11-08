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
    body: { style: {} },
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

test("Bottom Panel removes the redundant title and only exposes multi-view navigation", () => {
  const html = read("src/html/index.html");
  assert.match(html, /class="bottom-panel-views" role="tablist"/);
  const header = html.match(/<header class="bottom-panel-header">([\s\S]*?)<\/header>/)?.[1] || "";
  assert.doesNotMatch(header, /bottom-panel-title|<h2/i);
  assert.equal(header.replace(/<[^>]*>/g, "").trim(), "", "the header has no static label");
  assert.doesNotMatch(read("src/css/bottomPanel.css"), /bottom-panel-title/);
  assert.match(html, /class="bottom-panel-views" role="tablist"[^>]*hidden><\/nav>/);
  assert.match(read("src/js/manager/BottomPanelManager.js"), /panels\.length > 1/);
  assert.match(html, /class="[^"]*bottom-panel-kill[^"]*"[^>]*aria-label="Kill Active Terminal"/);
  assert.match(html, /bottom-panel-terminal-actions-slot/);
  const terminalCss = read("src/css/bottomPanel.css");
  const sessionStrip = terminalCss.match(/\.terminal-tabs\s*\{([^}]+)\}/)?.[1] || "";
  assert.match(sessionStrip, /background:\s*var\(--terminal-surface\)/);
  assert.doesNotMatch(sessionStrip, /border-bottom/);
  assert.match(terminalCss, /\.terminal-tab:hover\s*\{[^}]*background:\s*var\(--bg-hover\)/s);
  assert.match(read("src/js/terminal/TerminalPanel.js"), /read\("--terminal-surface"/);
  assert.match(read("src/js/terminal/TerminalPanel.js"), /read\("--terminal-ansi-bright-white"/);
  const terminalCssVars = read("src/css/var.css");
  assert.match(terminalCssVars, /--terminal-ansi-red:/);
  assert.match(terminalCssVars, /:root\[data-theme="light"\][\s\S]*--terminal-ansi-bright-red:/);
  assert.doesNotMatch(html, /bottom-panel-maximize|Maximize Bottom Panel|Restore Bottom Panel/);
  assert.match(read("src/css/bottomPanel.css"), /prefers-reduced-motion:\s*reduce/);
  assert.match(html, /class="nce-panel-resizer bottom-panel-resize-handle"/);
  assert.match(read("src/js/addon/SidebarResizer.js"), /className = "nce-panel-resizer sidebar-resizer/);
  const sharedResizerCss = read("src/css/sidebar.css");
  assert.match(sharedResizerCss, /\.nce-panel-resizer\s*\{[^}]*transition:\s*background-color 0\.2s/s);
  assert.match(sharedResizerCss, /\.nce-panel-resizer:hover\s*\{[^}]*background-color:\s*var\(--border-accent\)/s);
  assert.match(sharedResizerCss, /\.sidebar-resizer\s*\{[^}]*width:\s*4px/s);
  assert.match(read("src/css/bottomPanel.css"), /\.bottom-panel-resize-handle\s*\{[^}]*height:\s*4px/s);
});

test("Terminal clips its layers and replaces xterm's native scrollbar with the NCE scroller", () => {
  const css = read("src/css/bottomPanel.css");
  const viewport = css.match(/\.terminal-instance \.xterm \.xterm-viewport\s*\{([^}]+)\}/)?.[1] || "";
  assert.match(viewport, /overflow:\s*hidden/);
  assert.match(viewport, /scrollbar-width:\s*none/);
  assert.match(viewport, /-ms-overflow-style:\s*none/);
  assert.match(
    css,
    /\.terminal-instance \.xterm \.xterm-viewport::-webkit-scrollbar\s*\{[^}]*display:\s*none/s,
  );
  assert.match(css, /\.terminal-panel\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.terminal-view\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.terminal-instance\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.terminal-instance \.xterm\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.terminal-panel \*\s*\{[^}]*scrollbar-width:\s*none/s);
  assert.match(
    css,
    /\.terminal-panel \*::-webkit-scrollbar\s*\{[^}]*display:\s*none/s,
  );
  assert.match(
    css,
    /\.terminal-instance \.xterm \.xterm-scrollable-element > \.scrollbar\s*\{[^}]*display:\s*none/s,
    "xterm's native scrollbar must be hidden in favor of the NCE scroller",
  );
});

test("editor overlays do not duplicate the border above the bottom panel", () => {
  const html = read("src/html/index.html");
  for (const host of ["settings-view-host", "picture-view-host", "markdown-view-host"]) {
    const tag = html.match(new RegExp(`<div class="[^"]*${host}[^"]*"`))?.[0] || "";
    assert.ok(tag, `${host} is present`);
    assert.doesNotMatch(tag, /box-bottom/, `${host} must not add a second bottom border`);
  }
  const panel = read("src/css/bottomPanel.css").match(/\.bottom-panel\s*\{([^}]+)\}/)?.[1] || "";
  assert.match(panel, /border-top:\s*1px solid var\(--border-primary\)/);
});

test("sidebar selector does not duplicate the window left border", () => {
  const css = read("src/css/titlebar.css");
  assert.match(
    css,
    /\.main-section > \.sidebar-tab-selector,\s*\.main-section > \.sidebar-left\s*\{[^}]*border-left:\s*0/s,
  );
  const html = read("src/html/index.html");
  const selector = html.match(/<div class="[^"]*sidebar-tab-selector[^"]*"/)?.[0] || "";
  assert.ok(selector, "sidebar selector is present");
  assert.doesNotMatch(selector, /box-left/, "sidebar selector must not reintroduce box-left");
});

test("Bottom Panel resizer keeps pointer capture through drag and releases it on completion", () => {
  const { manager, calls } = createManagerHarness();
  manager.visible = true;
  let captured = null;
  let released = null;
  const target = {
    setPointerCapture(id) { captured = id; },
    hasPointerCapture(id) { return captured === id; },
    releasePointerCapture(id) { released = id; captured = null; },
  };
  let prevented = 0;
  assert.equal(manager.startResize({
    button: 0,
    pointerId: 7,
    clientY: 200,
    currentTarget: target,
    preventDefault() { prevented++; },
  }), true);
  assert.equal(captured, 7);
  assert.equal(manager.moveResize({ pointerId: 7, clientY: 180, preventDefault() { prevented++; } }), true);
  assert.equal(manager.height, 270);
  assert.equal(manager.finishResize({ pointerId: 7 }), true);
  assert.equal(released, 7);
  assert.equal(manager.drag, null);
  assert.ok(prevented >= 2);
  assert.ok(calls.some(([name]) => name === "layout"));
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
  assert.doesNotMatch(
    read("src/css/bottomBar.css"),
    /\.bottomBar-terminal-toggle\[aria-expanded="true"\]/,
    "the active Terminal never paints a status-bar highlight",
  );
});

test("the terminal toggle reports expansion only while Terminal is the active panel", () => {
  const BottomPanelManager = loadGlobal("src/js/manager/BottomPanelManager.js", "BottomPanelManager", {
    document: { createElement: () => ({ addEventListener() {} }) },
    window: {},
  });
  const toggleButton = new ElementStub();
  const manager = Object.assign(Object.create(BottomPanelManager.prototype), {
    panels: new Map(),
    activePanelId: "terminal",
    visible: true,
    height: 250,
    preferredHeight: 250,
    viewNavigation: null,
    newButton: null,
    killButton: null,
    terminalActionsSlot: null,
    contentElement: null,
    toggleButton,
    resizeHandle: null,
  });
  manager.registerPanel({ id: "terminal", title: "Terminal", createView() {} });
  manager.registerPanel({ id: "problems", title: "Problems", createView() {} });
  manager.activePanelId = "terminal";
  manager.visible = true;
  manager.syncControls();
  assert.equal(toggleButton.getAttribute("aria-expanded"), "true");

  manager.activePanelId = "problems";
  manager.syncControls();
  assert.equal(toggleButton.getAttribute("aria-expanded"), "false");

  manager.visible = false;
  manager.activePanelId = "terminal";
  manager.syncControls();
  assert.equal(toggleButton.getAttribute("aria-expanded"), "false");
});

test("the kill control only appears for killable panels", () => {
  const BottomPanelManager = loadGlobal("src/js/manager/BottomPanelManager.js", "BottomPanelManager", {
    document: { createElement: () => ({ addEventListener() {} }) },
    window: {},
  });
  const killButton = new ElementStub();
  const manager = Object.assign(Object.create(BottomPanelManager.prototype), {
    panels: new Map(),
    activePanelId: "problems",
    visible: true,
    height: 250,
    preferredHeight: 250,
    viewNavigation: null,
    newButton: null,
    killButton,
    terminalActionsSlot: null,
    contentElement: null,
    toggleButton: null,
    resizeHandle: null,
  });
  manager.registerPanel({ id: "problems", title: "Problems", createView() {} });
  manager.syncControls();
  assert.equal(killButton.hidden, true);
  assert.equal(killButton.disabled, true);

  manager.panels.set("terminal", {
    id: "terminal",
    title: "Terminal",
    createView() {},
    onKill() {},
    canKill: () => true,
  });
  manager.activePanelId = "terminal";
  manager.syncControls();
  assert.equal(killButton.hidden, false);
  assert.equal(killButton.disabled, false);

  manager.panels.get("terminal").canKill = () => false;
  manager.syncControls();
  assert.equal(killButton.hidden, true);
  assert.equal(killButton.disabled, true);
});
