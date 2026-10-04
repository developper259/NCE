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
  const editor = {
    tabManager: {
      tabs: [{ id: 1 }, { id: 2 }],
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

  assert.deepEqual(calls, [1, -1]);
});

test("tab bar uses a horizontal overflow scroller with non-shrinking tabs", async () => {
  const fs = require("node:fs/promises");
  const css = await fs.readFile("src/css/tabManager.css", "utf8");

  assert.match(css, /\.files-ul\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(css, /\.files-ul\s+\.file-el\s*\{[^}]*flex:\s*0\s+0\s+auto/s);
});
