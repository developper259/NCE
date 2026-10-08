const test = require("node:test");
const assert = require("node:assert/strict");
const { loadGlobal } = require("./helpers/runtime");

test("tab cycling wraps in both directions and handles a missing active tab", async () => {
  const TabManager = loadGlobal(
    "src/js/manager/TabManager.js",
    "tabManager",
    { TAB_TYPES: { FILE: "file" } },
  );
  const tabs = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const manager = Object.assign(Object.create(TabManager.prototype), {
    tabs,
    activeTab: tabs[2],
    setFocusTab: async function (tab) { this.activeTab = tab; },
  });

  assert.equal(await manager.cycleTab(1), true);
  assert.equal(manager.activeTab, tabs[0]);
  assert.equal(await manager.cycleTab(-1), true);
  assert.equal(manager.activeTab, tabs[2]);

  manager.activeTab = null;
  assert.equal(await manager.cycleTab(1), true);
  assert.equal(manager.activeTab, tabs[0]);
  manager.activeTab = null;
  assert.equal(await manager.cycleTab(-1), true);
  assert.equal(manager.activeTab, tabs[2]);
});

test("tab cycling is unavailable with fewer than two tabs", async () => {
  const TabManager = loadGlobal(
    "src/js/manager/TabManager.js",
    "tabManager",
    { TAB_TYPES: { FILE: "file" } },
  );
  const onlyTab = { id: 1 };
  const manager = Object.assign(Object.create(TabManager.prototype), {
    tabs: [onlyTab],
    activeTab: onlyTab,
    setFocusTab: async () => assert.fail("single-tab cycling must not focus"),
  });

  assert.equal(await manager.cycleTab(1), false);
  assert.equal(await manager.cycleTab(-1), false);
  assert.equal(await manager.cycleTab(0), false);
});

test("next and previous tab actions share the configured availability and dispatch", () => {
  const KeyBinding = loadGlobal("src/js/addon/KeyBinding.js", "KeyBinding");
  const calls = [];
  const tabs = [{ id: 1, type: "settings" }, { id: 2, type: "picture" }];
  const editor = {
    tabManager: {
      tabs,
      get canCycleTabs() { return this.tabs.length > 1; },
      cycleTab(direction) { calls.push(direction); },
    },
  };
  const keyBinding = new KeyBinding(editor);

  assert.equal(keyBinding.isActionEnabled("next_tab"), true);
  assert.equal(keyBinding.isActionEnabled("previous_tab"), true);
  keyBinding.exec({ action: "next_tab" }, {});
  keyBinding.exec({ action: "previous_tab" }, {});
  editor.tabManager.tabs.pop();
  assert.equal(keyBinding.isActionEnabled("next_tab"), false);
  assert.equal(keyBinding.isActionEnabled("previous_tab"), false);
  keyBinding.exec({ action: "next_tab" }, {});

  assert.deepEqual(calls, [1, -1]);
});

function createFocusHarness(tabs, { pathStatus } = {}) {
  const calls = { contexts: [], focusedPaths: [], refreshes: 0, refreshAlls: 0, viewTypes: [] };
  let manager;
  const editor = {
    api: {
      setActiveFileContext: (...context) => calls.contexts.push(context),
    },
    fileExplorer: {
      activeFilePath: null,
      setActiveFile(path) { this.activeFilePath = path; calls.focusedPaths.push(path); },
      fileOperations: pathStatus ? { pathStatus } : null,
    },
    searchController: {
      saveActiveTabState() {},
      restoreTabState() {},
      close() {},
    },
    lineController: { dirtyLines: new Set() },
    highlightController: {
      dirtyLines: new Set(),
      async openFile() {},
    },
    cursorController: { setCursorPosition() {} },
    isOnInit: false,
    refreshMainContent() { calls.viewTypes.push(manager.activeTab?.type || null); },
    refreshAll() {
      calls.refreshAlls++;
      manager.refresh();
    },
    events: { callEvent() {} },
  };
  const TabManager = loadGlobal(
    "src/js/manager/TabManager.js",
    "tabManager",
    { TAB_TYPES: { FILE: "file", SETTINGS: "settings", PICTURE: "picture", MARKDOWN: "markdown" } },
  );
  manager = Object.assign(Object.create(TabManager.prototype), {
    editor,
    tabs,
    activeTab: tabs[0] || null,
    activeTabListeners: new Set(),
    focusGeneration: 0,
    lastNativeTabContext: null,
    refresh() {
      calls.refreshes++;
      this.syncNativeTabContext();
    },
  });
  editor.tabManager = manager;
  return { manager, editor, calls };
}

test("mixed tab navigation preserves file and view state in visual order", async () => {
  const a = { id: 1, type: "file", name: "a.js", path: "/a.js", isLoaded: true, row: 2, column: 3 };
  const settings = { id: 2, type: "settings", name: "Settings" };
  const b = { id: 3, type: "file", name: "b.js", path: "/b.js", isLoaded: true, row: 1, column: 0 };
  const markdown = { id: 4, type: "markdown", name: "notes.md", path: "/notes.md" };
  const picture = { id: 5, type: "picture", name: "photo.png", path: "/photo.png" };
  const { manager, calls } = createFocusHarness([a, settings, b, markdown, picture]);

  assert.equal(manager.canCycleTabs, true);
  for (const expected of [settings, b, markdown, picture, a, picture]) {
    const direction = expected === picture && manager.activeTab === a ? -1 : 1;
    assert.equal(await manager.cycleTab(direction), true);
    assert.equal(manager.activeTab, expected);
    assert.equal(manager.activeFile, expected.type === "file" ? expected : null);
    assert.equal(calls.viewTypes.at(-1), expected.type);
  }
  assert.deepEqual(calls.contexts.slice(0, 3), [
    [false, true], [true, true], [false, true],
  ]);
  assert.equal(calls.focusedPaths.at(-1), "/photo.png");
});

test("two view tabs can cycle without any file tab", async () => {
  const settings = { id: 1, type: "settings", name: "Settings" };
  const picture = { id: 2, type: "picture", name: "photo.png", path: "/photo.png" };
  const { manager } = createFocusHarness([settings, picture]);
  const KeyBinding = loadGlobal("src/js/addon/KeyBinding.js", "KeyBinding");
  const keyBinding = new KeyBinding({ tabManager: manager });

  assert.equal(manager.activeFile, null);
  assert.equal(keyBinding.isActionEnabled("next_tab"), true);
  assert.equal(keyBinding.isActionEnabled("previous_tab"), true);
  await manager.cycleTab(-1);
  assert.equal(manager.activeTab, picture);
  await manager.cycleTab(1);
  assert.equal(manager.activeTab, settings);
});

test("stale picture focus completion cannot refresh over a newer file focus", async () => {
  let finishPathStatus;
  const picture = { id: 1, type: "picture", name: "photo.png", path: "/photo.png" };
  const file = { id: 2, type: "file", name: "later.js", path: "/later.js", isLoaded: true, row: 1, column: 0 };
  const { manager, calls } = createFocusHarness([picture, file], {
    pathStatus: () => new Promise((resolve) => { finishPathStatus = resolve; }),
  });

  const stalePictureFocus = manager.setFocusTab(picture);
  await Promise.resolve();
  await manager.setFocusTab(file);
  finishPathStatus({ exists: true, isDirectory: false, size: 1, mtimeMs: 1 });
  await stalePictureFocus;

  assert.equal(manager.activeTab, file);
  assert.equal(manager.activeFile, file);
  assert.deepEqual(calls.viewTypes, ["picture", "file"]);
  assert.equal(calls.refreshes, 1);
  assert.equal(calls.refreshAlls, 1);
});

test("tab bar uses a horizontal overflow scroller with non-shrinking tabs", async () => {
  const fs = require("node:fs/promises");
  const css = await fs.readFile("src/css/tabManager.css", "utf8");
  const scrollerCSS = await fs.readFile("src/css/scroller.css", "utf8");

  assert.match(css, /\.files-ul\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(css, /\.files-ul\s+\.file-el\s*\{[^}]*flex:\s*0\s+0\s+auto/s);
  assert.match(css, /\.files-ul::-webkit-scrollbar\s*\{\s*display:\s*none/s);
  assert.match(scrollerCSS, /\.page-scroller-horizontal\s*\{[^}]*left:\s*0;[^}]*width:\s*100%/s);
});
