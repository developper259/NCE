const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

test("TabManager construction keeps state without rendering an empty tab list", () => {
  const queriedElements = [];
  let activeFileContextUpdates = 0;
  const TabManager = loadGlobal("src/js/manager/TabManager.js", "tabManager", {
    getElement(selector) {
      queriedElements.push(selector);
      return null;
    },
  });

  const manager = new TabManager({
    isOnInit: true,
    api: {
      setActiveFileContext() {
        activeFileContextUpdates++;
      },
    },
  });

  assert.equal(manager.tabs.length, 0);
  assert.equal(manager.activeTab, null);
  assert.deepEqual(queriedElements, [".file-manager"]);
  assert.equal(activeFileContextUpdates, 0);
});

test("empty startup applies one reset when state is absent from both load channels", async () => {
  const document = { addEventListener() {} };
  const window = {};
  const Events = loadGlobal("src/js/core/Event.js", "Events", {
    document,
    window,
  });
  const Editor = loadGlobal("src/js/main/Editor.js", "Editor", {
    document,
    window,
    Events,
  });
  let onLoadState;
  let resetCount = 0;
  let startupCommitCount = 0;
  let refreshAllCount = 0;
  let bottomBarRefreshCount = 0;
  const editor = Object.assign(Object.create(Editor.prototype), {
    isOnInit: true,
    tabManager: {
      files: [],
      activeFile: null,
      refresh() {
        if (this.files.length === 0 && !editor.isOnInit) editor.reset();
      },
    },
    bottomBar: { refresh() { bottomBarRefreshCount++; } },
    reset() { resetCount++; },
    refreshMainContent() {},
    commitStartupState() {
      startupCommitCount++;
      Editor.prototype.commitStartupState.call(this);
    },
    refreshAll() { refreshAllCount++; },
    api: {
      onLoadState(callback) { onLoadState = callback; },
      loadEditorState() { return Promise.resolve(null); },
    },
  });
  editor.events = new Events(editor);

  Editor.prototype.initLoadState.call(editor);
  await new Promise((resolve) => setImmediate(resolve));
  await onLoadState(null);

  assert.equal(startupCommitCount, 1);
  assert.equal(refreshAllCount, 0);
  assert.equal(resetCount, 1);
  assert.equal(bottomBarRefreshCount, 1);
  assert.equal(editor.isOnInit, false);
});

test("startup commit updates only components needed for the active editor", () => {
  const Editor = loadGlobal("src/js/main/Editor.js", "Editor", {
    document: { addEventListener() {} },
    window: {},
  });
  const calls = [];
  const editor = Object.assign(Object.create(Editor.prototype), {
    isOnRefresh: false,
    tabManager: {
      activeFile: {},
      refresh() { calls.push("tabs"); },
    },
    refreshMainContent() { calls.push("main-content"); },
    cursorController: { updateCaretPosition() { calls.push("caret"); } },
    lineController: {
      refresh(force) { calls.push(`lines:${force}`); },
      restoreScroll() { calls.push("line-scroll"); },
    },
    scrollerManager: { refreshAll() { calls.push("scrollers"); } },
    refreshAll() { calls.push("global-refresh"); },
  });

  editor.commitStartupState();

  assert.deepEqual(calls, [
    "tabs", "main-content", "caret", "lines:true", "line-scroll",
    "scrollers",
  ]);
  assert.equal(editor.isOnRefresh, false);
});

test("SettingsView initializes only when a Settings tab becomes active", () => {
  let constructions = 0;
  let shows = 0;
  let hides = 0;
  class FakeSettingsView {
    constructor() { constructions++; }
    show() { shows++; }
    hide() { hides++; }
  }
  const Editor = loadGlobal("src/js/main/Editor.js", "Editor", {
    document: { addEventListener() {} },
    window: {},
    SettingsView: FakeSettingsView,
    TAB_TYPES: { SETTINGS: "settings", PICTURE: "picture", MARKDOWN: "markdown" },
  });
  const editor = Object.assign(Object.create(Editor.prototype), {
    _settingsView: null,
    editorOBJ: { classList: { toggle() {} } },
    tabManager: { activeTab: { type: "file" }, activeFile: {} },
    pictureView: { hide() {} },
    markdownView: { hide() {} },
    bottomBar: { hide() {}, show() {} },
    cursorController: { disable() {} },
    setSelected() {},
  });

  editor.refreshMainContent();
  assert.equal(constructions, 0);

  editor.tabManager.activeTab = { type: "settings" };
  editor.tabManager.activeFile = null;
  editor.refreshMainContent();
  assert.equal(constructions, 1);
  assert.equal(shows, 1);
  assert.equal(editor.getSettingsView(), editor.getSettingsView());
  assert.equal(constructions, 1);

  editor.tabManager.activeTab = { type: "file" };
  editor.tabManager.activeFile = {};
  editor.refreshMainContent();
  assert.equal(hides, 1);
  assert.equal(constructions, 1);
});

test("startup sidebar refresh keeps selector state without repainting active content", () => {
  const SidebarManager = loadGlobal(
    "src/js/manager/SidebarManager.js",
    "SidebarManager",
  );
  let selectorRenders = 0;
  let menuRenders = 0;
  const manager = Object.assign(Object.create(SidebarManager.prototype), {
    activeMenu: { id: "search" },
    renderTabSelector() { selectorRenders++; },
    renderMenuContent() { menuRenders++; },
  });

  manager.refreshAll({ renderActiveMenu: false });
  assert.equal(selectorRenders, 1);
  assert.equal(menuRenders, 0);

  manager.refreshAll();
  assert.equal(selectorRenders, 2);
  assert.equal(menuRenders, 1);
});
