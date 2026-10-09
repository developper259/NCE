const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");
const NCEPath = loadGlobal("src/js/core/Path.js", "NCEPath");

function createHarness(rootPath = null) {
  let timerId = 0;
  const timers = new Map();
  const saves = [];
  const StatesManager = loadGlobal(
    "src/js/manager/StatesManager.js",
    "StatesManager",
    {
      setTimeout(callback, delay) {
        const id = ++timerId;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout(id) { timers.delete(id); },
      NCEPath,
    },
  );
  const panelState = {
    visible: true,
    height: 315,
    maximized: true,
    activePanelId: "terminal",
    terminal: {
      version: 1,
      activeTabIndex: 1,
      tabs: [
        { baseLabel: "zsh — project", customLabel: null },
        { baseLabel: "zsh — project", customLabel: "Development" },
      ],
      sessionId: "must-not-persist",
    },
    sessionId: "must-not-persist",
  };
  const manager = Object.assign(Object.create(StatesManager.prototype), {
    editor: {
      fileExplorer: { rootPath },
      tabManager: null,
      sidebarManager: null,
      agentSidebar: null,
      bottomPanelManager: {
        workspaceKey: rootPath ? "/workspace" : "no-workspace",
        getPanelState: () => panelState,
        getWorkspacePanelState: () => panelState,
        getWorkspaceRoot: () => rootPath,
      },
      api: {
        async saveEditorState(serialized) { saves.push({ global: JSON.parse(serialized) }); return true; },
        async loadWorkspaceState() { return { version: 1, tabManager: null }; },
        async saveWorkspaceState(root, state) { saves.push({ root, state }); return true; },
      },
    },
    globalVersion: 2,
    workspaceVersion: 2,
    lastWorkspace: rootPath,
    noWorkspaceState: null,
    persistenceSuspended: false,
    globalSaveTimer: null,
    workspaceRoots: new Map(rootPath ? [["/workspace", rootPath]] : []),
    bottomPanelSaveTimers: new Map(),
    workspaceSaveQueues: new Map(),
    legacyBottomPanelState: null,
    workspaceLimits: Object.freeze({
      tabs: 256, expandedPaths: 2048, selectedLines: 2048, pathLength: 4096,
      nameLength: 256, menuIdLength: 128, numeric: 10_000_000,
    }),
  });
  return { manager, timers, saves, panelState };
}

test("Bottom Panel metadata is workspace scoped and excludes runtime identifiers", () => {
  const { manager } = createHarness("/workspace");
  const workspace = manager.getWorkspaceState("/workspace");
  assert.deepEqual(JSON.parse(JSON.stringify(workspace.bottomPanel)), {
    visible: true,
    height: 315,
    activePanelId: "terminal",
    terminal: {
      version: 1,
      activeTabIndex: 1,
      tabs: [
        { baseLabel: "zsh — project", customLabel: null },
        { baseLabel: "zsh — project", customLabel: "Development" },
      ],
    },
  });
  assert.equal("bottomPanel" in manager.getGlobalState(), false);
  assert.equal(JSON.stringify(workspace).includes("must-not-persist"), false);
  assert.equal(JSON.stringify(workspace).includes("maximized"), false);
});

test("No Workspace stores its own panel state in global state", () => {
  const { manager } = createHarness();
  const global = manager.getGlobalState();
  assert.equal("bottomPanel" in global, false);
  assert.deepEqual(global.noWorkspaceState.bottomPanel, manager.getBottomPanelState("no-workspace"));
});

test("workspace version 1 and stale maximized fields sanitize into the current schema", () => {
  const { manager } = createHarness();
  const safe = manager.sanitizeWorkspaceState({
    version: 1,
    bottomPanel: {
      visible: true,
      height: 320,
      maximized: true,
      activePanelId: "terminal",
      terminal: {
        activeTabIndex: 8,
        tabs: [
          { baseLabel: "shell", customLabel: "Dev", sessionId: "old-session" },
          { baseLabel: "bad\0label", customLabel: null },
        ],
      },
    },
  });
  assert.equal(safe.version, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(safe.bottomPanel)), {
    visible: true,
    height: 320,
    activePanelId: "terminal",
    terminal: {
      version: 1,
      activeTabIndex: 0,
      tabs: [{ baseLabel: "shell", customLabel: "Dev" }],
    },
  });
  assert.equal(JSON.stringify(safe).includes("sessionId"), false);
  assert.equal(JSON.stringify(safe).includes("maximized"), false);
});

test("panel metadata saves are debounced and patch the inactive workspace without replacing other state", async () => {
  const { manager, timers, saves } = createHarness("/workspace");
  manager.editor.bottomPanelManager.getWorkspacePanelState = () => ({
    visible: false,
    height: 300,
    activePanelId: "terminal",
    terminal: { version: 1, activeTabIndex: 0, tabs: [] },
  });
  manager.scheduleBottomPanelStateSave("/workspace");
  manager.scheduleBottomPanelStateSave("/workspace");
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 300);
  [...timers.values()][0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saves.length, 1);
  assert.equal(saves[0].root, "/workspace");
  assert.equal(saves[0].state.version, 2);
  assert.deepEqual(saves[0].state.bottomPanel.terminal.tabs, []);
});

test("a full workspace save cancels the pending panel debounce and persists its latest visibility", async () => {
  const { manager, timers, saves } = createHarness("/workspace");
  manager.scheduleBottomPanelStateSave("/workspace");
  assert.equal(timers.size, 1);

  assert.equal(await manager.saveWorkspaceState("/workspace"), true);
  assert.equal(timers.size, 0);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].state.bottomPanel.visible, true);
});
