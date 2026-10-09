const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

function createHarness() {
  let timerId = 0;
  const timers = new Map();
  const cleared = [];
  const StatesManager = loadGlobal(
    "src/js/manager/StatesManager.js",
    "StatesManager",
    {
      setTimeout(callback, delay) {
        const id = ++timerId;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout(id) {
        cleared.push(id);
        timers.delete(id);
      },
    },
  );
  const saved = [];
  const editor = {
    fileExplorer: { rootPath: null },
    tabManager: null,
    sidebarManager: null,
    agentSidebar: null,
    bottomPanelManager: {
      getPanelState: () => ({
        visible: true,
        height: 315,
        maximized: false,
        activePanelId: "terminal",
        sessionId: "must-not-persist",
      }),
    },
    api: {
      saveEditorState: async (state) => {
        saved.push(JSON.parse(state));
        return true;
      },
    },
  };
  return { manager: new StatesManager(editor), saved, timers, cleared };
}

test("global state persists only the Bottom Panel UI and restores with validation", async () => {
  const { manager, saved, timers } = createHarness();
  const state = manager.getGlobalState();
  assert.deepEqual(JSON.parse(JSON.stringify(state.bottomPanel)), {
    visible: true,
    height: 315,
    maximized: false,
    activePanelId: "terminal",
  });
  assert.equal(Object.hasOwn(state.bottomPanel, "sessionId"), false, "session data must never persist");

  const safe = manager.sanitizeBottomPanelState(state.bottomPanel);
  assert.deepEqual(JSON.parse(JSON.stringify(safe)), {
    visible: true,
    height: 315,
    maximized: false,
    activePanelId: "terminal",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(manager.sanitizeBottomPanelState({
    visible: "yes",
    height: Number.POSITIVE_INFINITY,
    maximized: 1,
    activePanelId: "other-panel",
    sessions: ["old-process"],
  }))), {
    visible: false,
    height: 250,
    maximized: false,
    activePanelId: null,
  });
  assert.equal(manager.sanitizeBottomPanelState(null), null);

  manager.scheduleGlobalStateSave();
  manager.scheduleGlobalStateSave();
  assert.equal(timers.size, 1, "repeated panel changes are debounced");
  assert.equal([...timers.values()][0].delay, 300);
  const callback = [...timers.values()][0].callback;
  timers.clear();
  callback();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(saved.length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(saved[0].bottomPanel)),
    JSON.parse(JSON.stringify(safe)),
  );
  assert.equal(JSON.stringify(saved[0]).includes("must-not-persist"), false);
  assert.equal(JSON.stringify(saved[0]).includes("old-process"), false);
});
