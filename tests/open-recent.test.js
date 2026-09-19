const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { loadGlobal } = require("./helpers/runtime");
const {
  RecentFoldersManager,
  RECENT_FOLDERS_LIMIT,
} = require("../dist/ts/manager/RecentFoldersManager.js");

const NCEPath = loadGlobal("src/js/core/Path.js", "NCEPath");

function loadFileExplorer() {
  return loadGlobal("src/js/sidebar/FileExplorer.Sidebar.js", "FileExplorer", {
    Sidebar: class {},
    FileOperations: class {},
    NCEPath,
    Events: { ON_OPEN_PROJECT: "open", ON_CLOSE_PROJECT: "close" },
    window: { api: {} },
    buildFileContextMenu() {},
    buildFolderContextMenu() {},
    buildBackgroundContextMenu() {},
    buildProjectContextMenu() {},
  });
}

test("recent folders are persistent, deduplicated MRU entries with a limit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-recents-"));
  try {
    const manager = new RecentFoldersManager(root, "linux");
    await manager.initialize();
    await manager.add("/projects/NCE");
    await manager.add("/projects/NSH");
    await manager.add("/projects/NCE/");
    assert.deepEqual(manager.getAll(), ["/projects/NCE", "/projects/NSH"]);

    for (let index = 0; index < RECENT_FOLDERS_LIMIT + 3; index++)
      await manager.add(`/projects/project-${index}`);
    assert.equal(manager.getAll().length, RECENT_FOLDERS_LIMIT);
    assert.equal(manager.getAll()[0], "/projects/project-12");

    const restarted = new RecentFoldersManager(root, "linux");
    assert.deepEqual(await restarted.initialize(), manager.getAll());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Windows recent paths compare case-insensitively across separators", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-recents-win-"));
  try {
    const manager = new RecentFoldersManager(root, "win32");
    await manager.initialize();
    await manager.add("C:\\Projects\\NCE");
    await manager.add("c:/projects/nce/");
    assert.equal(manager.getAll().length, 1);
    assert.equal(manager.getAll()[0].toLowerCase(), "c:\\projects\\nce");
    assert.equal(NCEPath.equals("C:\\Projects\\NCE", "c:/projects/nce/"), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function workspaceFixture({
  closeResult = true,
  targetExists = true,
  stateSaveResult = true,
} = {}) {
  const FileExplorer = loadFileExplorer();
  const calls = [];
  const tabs = [
    { id: 1, type: "file", isSaved: false },
    { id: 2, type: "settings" },
  ];
  const tabManager = {
    tabs,
    activeTab: tabs[1],
    activeFile: null,
    async prepareForQuit() {
      calls.push("dirty-flow");
      return closeResult;
    },
    async closeFiles({ skipPrepare } = {}) {
      assert.equal(skipPrepare, true);
      this.tabs.length = 0;
      this.activeTab = null;
      this.activeFile = null;
      return true;
    },
  };
  const explorer = Object.create(FileExplorer.prototype);
  Object.assign(explorer, {
    rootPath: "/projects/A",
    workspaceSwitching: false,
    fileOperations: {
      pathStatus: async () => ({
        exists: targetExists,
        isDirectory: targetExists,
        code: targetExists ? undefined : "SOURCE_NOT_FOUND",
      }),
    },
    editor: {
      tabManager,
      searchSidebar: { resetWorkspace: () => calls.push("reset-search") },
      statesManager: {
        noWorkspaceState: null,
        getNoWorkspaceState: () => ({ tabs: [...tabManager.tabs] }),
        saveWorkspaceState: async (root) => {
          calls.push(`save-workspace:${root}:${tabManager.tabs.length}`);
          return stateSaveResult;
        },
        loadWorkspaceState: async (root) => calls.push(`restore:${root}`),
        saveGlobalState: async () => { calls.push("save-global"); return true; },
      },
      api: {
        addRecentFolder: async (folder) => calls.push(`add:${folder}`),
        removeRecentFolder: async (folder) => calls.push(`remove:${folder}`),
      },
    },
    async closeProject() {
      calls.push("close-workspace");
      this.rootPath = "";
    },
    async loadProject(folder) {
      calls.push(`load:${folder}`);
      this.rootPath = folder;
      return true;
    },
  });
  return { explorer, tabManager, calls };
}

test("workspace switch clears every old tab and persists only the new workspace", async () => {
  const { explorer, tabManager, calls } = workspaceFixture();
  assert.equal(await explorer.requestWorkspaceSwitch("/projects/B"), true);
  assert.equal(explorer.rootPath, "/projects/B");
  assert.deepEqual(tabManager.tabs, []);
  assert.equal(tabManager.activeTab, null);
  assert.equal(tabManager.activeFile, null);
  assert.deepEqual(calls, [
    "dirty-flow",
    "save-workspace:/projects/A:2",
    "reset-search",
    "close-workspace",
    "load:/projects/B",
    "restore:/projects/B",
    "save-global",
    "add:/projects/B",
  ]);
});

test("Cancel keeps the current workspace, tabs and recent history unchanged", async () => {
  const { explorer, tabManager, calls } = workspaceFixture({ closeResult: false });
  const originalTabs = [...tabManager.tabs];
  assert.equal(await explorer.requestWorkspaceSwitch("/projects/B"), false);
  assert.equal(explorer.rootPath, "/projects/A");
  assert.deepEqual(tabManager.tabs, originalTabs);
  assert.deepEqual(calls, ["dirty-flow"]);
});

test("a failed workspace snapshot aborts the switch before any state is cleared", async () => {
  const { explorer, tabManager, calls } = workspaceFixture({
    stateSaveResult: false,
  });
  const originalTabs = [...tabManager.tabs];

  assert.equal(await explorer.requestWorkspaceSwitch("/projects/B"), false);
  assert.equal(explorer.rootPath, "/projects/A");
  assert.deepEqual(tabManager.tabs, originalTabs);
  assert.equal(tabManager.activeTab, originalTabs[1]);
  assert.deepEqual(calls, [
    "dirty-flow",
    "save-workspace:/projects/A:2",
  ]);
});

test("the active workspace is promoted without resetting tabs or services", async () => {
  const { explorer, tabManager, calls } = workspaceFixture();
  const originalTabs = [...tabManager.tabs];
  assert.equal(await explorer.requestWorkspaceSwitch("/projects/A/"), true);
  assert.deepEqual(tabManager.tabs, originalTabs);
  assert.deepEqual(calls, ["add:/projects/A/"]);
});

test("a missing recent is removed before any current state changes", async () => {
  const { explorer, tabManager, calls } = workspaceFixture({ targetExists: false });
  const originalTabs = [...tabManager.tabs];
  assert.equal(
    await explorer.requestWorkspaceSwitch("/projects/missing", {
      fromRecent: true,
    }),
    false,
  );
  assert.equal(explorer.rootPath, "/projects/A");
  assert.deepEqual(tabManager.tabs, originalTabs);
  assert.deepEqual(calls, ["remove:/projects/missing"]);
});

test("an unreadable recent keeps the current workspace intact", async () => {
  const { explorer, tabManager, calls } = workspaceFixture();
  explorer.fileOperations.pathStatus = async () => ({
    exists: true,
    isDirectory: true,
    readable: false,
    code: "EACCES",
  });
  const originalTabs = [...tabManager.tabs];

  assert.equal(
    await explorer.requestWorkspaceSwitch("/projects/private", {
      fromRecent: true,
    }),
    false,
  );
  assert.equal(explorer.rootPath, "/projects/A");
  assert.deepEqual(tabManager.tabs, originalTabs);
  assert.deepEqual(calls, []);
});

test("Clear Recently Opened changes only the dedicated history", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-recents-clear-"));
  try {
    const manager = new RecentFoldersManager(root);
    await manager.initialize();
    await manager.add("/projects/A");
    const currentSession = { workspace: "/projects/A", tabs: [1, 2] };
    await manager.clear();
    assert.deepEqual(manager.getAll(), []);
    assert.deepEqual(currentSession, { workspace: "/projects/A", tabs: [1, 2] });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a failed recent-folder write leaves the published MRU unchanged", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-recents-failure-"));
  try {
    const manager = new RecentFoldersManager(root);
    await manager.initialize();
    assert.equal(await manager.add(path.join(root, "workspace-a")), true);
    const previous = manager.getAll();
    manager.writeSnapshot = async () => false;

    assert.equal(await manager.add(path.join(root, "workspace-b")), false);
    assert.deepEqual(manager.getAll(), previous);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
