const test = require("node:test");
const assert = require("node:assert/strict");
const { loadGlobal } = require("./helpers/runtime");

const NCEPath = loadGlobal("src/js/core/Path.js", "NCEPath");
const TAB_TYPES = { FILE: "file", SETTINGS: "settings" };
class SettingsTab {
  constructor(id) { this.id = id; this.type = TAB_TYPES.SETTINGS; }
}
class FileNode {
  constructor(editor, id, name, path) {
    Object.assign(this, {
      editor, id, name, path, type: TAB_TYPES.FILE,
      row: 0, column: 0, offsetX: 0, offsetY: 0, startIndex: 0,
      maxLineLength: 0, totalLines: 0, _selectedLines: new Map(),
    });
  }
}
const StatesManager = loadGlobal(
  "src/js/manager/StatesManager.js",
  "StatesManager",
  { NCEPath, TAB_TYPES, SettingsTab, FileNode },
);

function fixture(root = "/projects/A") {
  const files = new Set([`${root}/src/a.js`, `${root}/src/b.js`]);
  const tabManager = {
    tabs: [], activeTab: null, idCounter: 0,
    get activeFile() { return this.activeTab?.type === "file" ? this.activeTab : null; },
    async setFocusFile(tab) { this.activeTab = tab; },
    async setFocusTab(tab) { this.activeTab = tab; },
    refresh() {},
  };
  const saved = new Map();
  const editor = {
    tabManager,
    sidebarManager: null,
    agentSidebar: {
      getConfigState: () => ({ currentProviderId: "global", currentModel: "x" }),
      async loadConfigState(value) { this.loaded = value; },
    },
    fileExplorer: {
      rootPath: root, projectExpanded: true,
      activeFilePath: `${root}/src/b.js`,
      files: [], fileOperations: {
        async pathStatus(path) { return { exists: files.has(NCEPath.normalize(path)), isDirectory: false }; },
      },
      getExpandedPaths: () => new Set([`${root}/src`, `${root}/src/components`]),
      async restoreExpandedFolders(_files, expanded) { this.restoredExpanded = expanded; },
      refresh() {},
    },
    api: {
      async saveEditorState(json) { editor.global = JSON.parse(json); return true; },
      async saveWorkspaceState(target, state) { saved.set(target, structuredClone(state)); return true; },
      async loadWorkspaceState(target) { return structuredClone(saved.get(target) || null); },
    },
  };
  return { editor, manager: new StatesManager(editor), saved, files };
}

test("workspace snapshots contain relative paths and no rootPath", () => {
  const { editor, manager } = fixture();
  const a = new FileNode(editor, 1, "a.js", "/projects/A/src/a.js");
  const settings = new SettingsTab(2);
  editor.tabManager.tabs = [a, settings];
  editor.tabManager.activeTab = a;
  const state = manager.getWorkspaceState("/projects/A");
  assert.equal(state.version, 1);
  assert.equal(state.tabManager.tabs[0].path, "src/a.js");
  assert.deepEqual(Array.from(state.fileExplorer.expandedPaths), ["src", "src/components"]);
  assert.equal(state.fileExplorer.activeFilePath, "src/b.js");
  assert.equal("rootPath" in state.fileExplorer, false);
  assert.equal(JSON.stringify(state).includes("/projects/A"), false);
  assert.equal(manager.toWorkspaceRelative("C:\\Work\\A\\src\\a.js", "c:/work/a"), "src/a.js");
});

test("workspace restore skips missing and unsafe files and falls back active tab", async () => {
  const { editor, manager } = fixture();
  await manager.restoreWorkspaceState({
    version: 1,
    tabManager: {
      activeTab: { id: 2 },
      tabs: [
        { id: 1, type: "file", name: "a.js", path: "src/a.js" },
        { id: 2, type: "file", name: "missing.js", path: "src/missing.js" },
        { id: 3, type: "file", name: "escape", path: "../../secret" },
      ],
    },
    fileExplorer: { expandedPaths: ["src", "../../outside"] },
  }, "/projects/A");
  assert.deepEqual(Array.from(editor.tabManager.tabs, (tab) => tab.id), [1]);
  assert.equal(editor.tabManager.activeTab.id, 1);
  assert.deepEqual([...editor.fileExplorer.restoredExpanded], ["/projects/A/src"]);
});

test("legacy migration separates global config and relative workspace UI once", async () => {
  const { editor, manager, saved } = fixture();
  const legacy = {
    agent: { currentProviderId: "legacy", currentModel: "m" },
    tabManager: {
      activeFile: { id: 1 },
      files: [{ id: 1, type: "file", name: "a.js", path: "/projects/A/src/a.js" }],
    },
    sidebar: { leftOpen: true },
    fileExplorer: {
      rootPath: "/projects/A", activeFilePath: "/projects/A/src/a.js",
      expandedPaths: ["/projects/A/src"],
    },
  };
  const migrated = await manager.migrateLegacyState(legacy);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.lastWorkspace, "/projects/A");
  assert.equal(migrated.agent.currentProviderId, "legacy");
  assert.equal("tabManager" in migrated, false);
  assert.equal(saved.get("/projects/A").tabManager.tabs[0].path, "src/a.js");
  assert.equal(editor.global.version, 2);
});

test("no-workspace state and workspace state remain independent", async () => {
  const { editor, manager, saved } = fixture();
  editor.fileExplorer.rootPath = "";
  editor.tabManager.tabs = [new SettingsTab(7)];
  editor.tabManager.activeTab = editor.tabManager.tabs[0];
  manager.noWorkspaceState = manager.getNoWorkspaceState();

  editor.fileExplorer.rootPath = "/projects/A";
  editor.tabManager.tabs = [new FileNode(editor, 1, "a.js", "/projects/A/src/a.js")];
  editor.tabManager.activeTab = editor.tabManager.tabs[0];
  await manager.saveWorkspaceState("/projects/A");
  await manager.restoreNoWorkspaceState(manager.noWorkspaceState);
  assert.deepEqual(Array.from(editor.tabManager.tabs, (tab) => tab.type), ["settings"]);
  assert.deepEqual(saved.get("/projects/A").tabManager.tabs.map((tab) => tab.path), ["src/a.js"]);
});

test("unknown workspace versions fall back without restoring tabs", async () => {
  const { editor, manager, saved } = fixture();
  saved.set("/projects/A", { version: 999, tabManager: { tabs: [{ id: 1 }] } });
  const originalWarn = console.warn;
  console.warn = () => {};
  try { await manager.loadWorkspaceState("/projects/A"); }
  finally { console.warn = originalWarn; }
  assert.equal(editor.tabManager.tabs.length, 0);
});
