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
  let refreshCount = 0;
  const editor = {
    isOnInit: true,
    tabManager: {
      files: [],
      activeFile: null,
      refresh() {
        if (this.files.length === 0 && !editor.isOnInit) editor.reset();
      },
    },
    bottomBar: { refresh() {} },
    reset() { resetCount++; },
    refreshAll() {
      refreshCount++;
      this.tabManager.refresh();
    },
    api: {
      onLoadState(callback) { onLoadState = callback; },
      loadEditorState() { return Promise.resolve(null); },
    },
  };
  editor.events = new Events(editor);

  Editor.prototype.initLoadState.call(editor);
  await new Promise((resolve) => setImmediate(resolve));
  await onLoadState(null);

  assert.equal(refreshCount, 1);
  assert.equal(resetCount, 1);
  assert.equal(editor.isOnInit, false);
});
