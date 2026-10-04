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
