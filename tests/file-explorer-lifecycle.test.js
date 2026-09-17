const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

const NCEPath = loadGlobal("src/js/core/Path.js", "NCEPath");

function loadFileExplorer(windowApi = {}, confirmImpl = () => true) {
  return loadGlobal("src/js/sidebar/FileExplorer.Sidebar.js", "FileExplorer", {
    Sidebar: class {},
    FileOperations: class {},
    NCEPath,
    Events: { ON_OPEN_PROJECT: "open", ON_CLOSE_PROJECT: "close" },
    window: { api: windowApi },
    alert() {},
    confirm: confirmImpl,
    requestAnimationFrame(callback) {
      callback();
    },
    document: {
      createElement() {
        return {};
      },
    },
    buildFileContextMenu() {},
    buildFolderContextMenu() {},
    buildBackgroundContextMenu() {},
    buildProjectContextMenu() {},
  });
}

function explorerFixture(rename) {
  const FileExplorer = loadFileExplorer();
  const calls = { refresh: 0, refreshFolder: 0, updatePath: 0 };
  const explorer = Object.create(FileExplorer.prototype);
  Object.assign(explorer, {
    rootPath: "/project",
    projectName: "project",
    files: [],
    activeFilePath: null,
    isLoaded: true,
    clipboard: null,
    editingState: null,
    fileOperations: {
      rename,
      pathStatus: async () => ({ exists: true, isDirectory: true }),
    },
    refresh() {
      calls.refresh++;
    },
    async refreshFolder() {
      calls.refreshFolder++;
    },
    editor: {
      tabManager: {
        async updateFilePath() {
          calls.updatePath++;
        },
        markFileAsDeleted() {},
      },
      events: { callEvent() {} },
    },
  });
  return { explorer, calls };
}

test("non-empty folder deletion requires explicit force confirmation", async () => {
  const FileExplorer = loadFileExplorer();
  const calls = [];
  const confirmations = [true, true];
  const explorer = Object.create(
    loadFileExplorer({}, () => confirmations.shift()).prototype,
  );
  Object.assign(explorer, {
    fileOperations: {
      async delete(path, force) {
        calls.push([path, force]);
        return force
          ? { success: true }
          : { success: false, code: "FOLDER_NOT_EMPTY" };
      },
    },
    editor: {
      tabManager: {
        markFileAsDeleted() {},
        async prepareFilesForDeletion() {
          return true;
        },
      },
    },
    async refreshFolder() {},
  });
  await explorer.deleteEntry({
    name: "components",
    path: "/project/components",
    type: "folder",
  });
  assert.deepEqual(calls, [
    ["/project/components", false],
    ["/project/components", true],
  ]);
});

test("cancelling the force confirmation never retries deletion", async () => {
  const calls = [];
  const confirmations = [true, false];
  const explorer = Object.create(
    loadFileExplorer({}, () => confirmations.shift()).prototype,
  );
  Object.assign(explorer, {
    fileOperations: {
      async delete(path, force) {
        calls.push([path, force]);
        return { success: false, code: "FOLDER_NOT_EMPTY" };
      },
    },
    editor: { tabManager: { markFileAsDeleted() {} } },
    async refreshFolder() {},
  });
  await explorer.deleteEntry({
    name: "components",
    path: "/project/components",
    type: "folder",
  });
  assert.deepEqual(calls, [["/project/components", false]]);
});

test("inline rename recovers from invalid input and a later rename succeeds", async () => {
  let renameCalls = 0;
  const { explorer, calls } = explorerFixture(async () => {
    renameCalls++;
    return { success: true };
  });
  const first = { name: "a.js", path: "/project/a.js", type: "file" };
  explorer.startRename(first);
  let focused = 0;
  explorer.editingState.input = {
    focus() {
      focused++;
    },
    select() {},
  };
  await explorer.commitEdit("../bad", first);
  assert.equal(explorer.editingState.status, "editing");
  assert.equal(renameCalls, 0);
  assert.equal(focused, 1);

  explorer.cancelEdit();
  const second = { name: "b.js", path: "/project/b.js", type: "file" };
  explorer.startRename(second);
  await explorer.commitEdit("renamed.js", second);
  assert.equal(explorer.editingState, null);
  assert.equal(second.name, "renamed.js");
  assert.equal(renameCalls, 1);
  assert.equal(calls.updatePath, 1);
});

test("invalid file and folder creation keeps the editor active without a popup", async () => {
  const alerts = [];
  const FileExplorer = loadGlobal(
    "src/js/sidebar/FileExplorer.Sidebar.js",
    "FileExplorer",
    {
      Sidebar: class {},
      FileOperations: class {},
      NCEPath,
      Events: { ON_OPEN_PROJECT: "open", ON_CLOSE_PROJECT: "close" },
      window: { api: {} },
      alert(message) {
        alerts.push(message);
      },
      confirm: () => true,
      requestAnimationFrame(callback) {
        callback();
      },
      document: {
        createElement() {
          return {};
        },
      },
      buildFileContextMenu() {},
      buildFolderContextMenu() {},
      buildBackgroundContextMenu() {},
      buildProjectContextMenu() {},
    },
  );
  const explorer = Object.create(FileExplorer.prototype);
  const placeholders = [];
  Object.assign(explorer, {
    rootPath: "/project",
    files: placeholders,
    editingState: null,
    fileOperations: {
      async createFile() {
        return { success: false, error: "Invalid file name" };
      },
      async createFolder() {
        return { success: false, error: "Invalid folder name" };
      },
    },
    refresh() {},
  });

  await explorer.startCreateEntry("/project", "file");
  const filePlaceholder = placeholders[0];
  await explorer.commitEdit("bad/name", filePlaceholder);
  assert.equal(explorer.editingState.status, "editing");
  assert.equal(explorer.editingState.invalid, true);
  assert.deepEqual(placeholders, [filePlaceholder]);

  await explorer.startCreateEntry("/project", "folder");
  const folderPlaceholder = placeholders[0];
  await explorer.commitEdit("bad\\name", folderPlaceholder);
  assert.equal(explorer.editingState.status, "editing");
  assert.equal(explorer.editingState.invalid, true);
  assert.deepEqual(placeholders, [folderPlaceholder]);
  assert.deepEqual(alerts, []);

  await explorer.startCreateEntry("/project", "file");
  const emptyPlaceholder = placeholders[0];
  await explorer.commitEdit("", emptyPlaceholder);
  assert.equal(explorer.editingState.status, "editing");
  assert.equal(explorer.editingState.invalid, true);
  assert.deepEqual(placeholders, [emptyPlaceholder]);
  assert.deepEqual(alerts, []);
});

test("invalid rename marks the input and valid input clears the mark", async () => {
  const { explorer } = explorerFixture(async () => ({ success: true }));
  const target = { name: "a.js", path: "/project/a.js", type: "file" };
  const classes = new Set();
  const input = {
    classList: {
      add(value) {
        classes.add(value);
      },
      remove(value) {
        classes.delete(value);
      },
    },
    focus() {},
    select() {},
  };
  explorer.startRename(target);
  explorer.editingState.input = input;
  await explorer.commitEdit("../bad", target);
  assert.equal(explorer.editingState.status, "editing");
  assert.equal(classes.has("invalid"), true);
  explorer.editingState.invalid = false;
  input.classList.remove("invalid");
  await explorer.commitEdit("renamed.js", target);
  assert.equal(explorer.editingState, null);
});

test("Enter and blur share one committing guard", async () => {
  let resolveRename;
  let renameCalls = 0;
  const pending = new Promise((resolve) => {
    resolveRename = resolve;
  });
  const { explorer } = explorerFixture(async () => {
    renameCalls++;
    return pending;
  });
  const target = { name: "a.js", path: "/project/a.js", type: "file" };
  explorer.startRename(target);
  const enter = explorer.commitEdit("b.js", target);
  await explorer.commitEdit("b.js", target);
  assert.equal(renameCalls, 1);
  assert.equal(explorer.editingState.status, "committing");
  resolveRename({ success: true });
  await enter;
  assert.equal(explorer.editingState, null);
});

test("a source deleted during rename closes the session and refreshes", async () => {
  const { explorer, calls } = explorerFixture(async () => ({
    success: false,
    code: "SOURCE_NOT_FOUND",
  }));
  const target = { name: "gone.js", path: "/project/gone.js", type: "file" };
  explorer.startRename(target);
  await explorer.commitEdit("new.js", target);
  assert.equal(explorer.editingState, null);
  assert.equal(calls.refreshFolder, 1);
});

test("deleted workspace is invalidated and a new workspace can open", async () => {
  let stopped = 0;
  const api = {
    stopWatching: async () => {
      stopped++;
    },
    startWatching: async () => {},
    getFolderContent: async () => [],
  };
  const FileExplorer = loadFileExplorer(api);
  const explorer = Object.create(FileExplorer.prototype);
  let exists = false;
  Object.assign(explorer, {
    rootPath: "/deleted",
    projectName: "deleted",
    files: [{ name: "old", path: "/deleted/old", type: "file" }],
    activeFilePath: "/deleted/old",
    isLoaded: true,
    clipboard: {},
    editingState: null,
    fileOperations: {
      pathStatus: async () => ({
        exists,
        isDirectory: exists,
        code: exists ? undefined : "SOURCE_NOT_FOUND",
      }),
    },
    refresh() {},
    editor: {
      tabManager: { markFileAsDeleted() {} },
      events: { callEvent() {} },
    },
  });
  await explorer.handleFileSystemChanges([
    { event: "root-deleted", filePath: "/deleted", dirPath: "/" },
  ]);
  assert.equal(stopped, 1);
  assert.equal(explorer.rootPath, "");
  assert.equal(explorer.files.length, 0);

  exists = true;
  assert.equal(await explorer.loadProject("/new-project"), true);
  assert.equal(explorer.rootPath, "/new-project");
  assert.equal(explorer.projectName, "new-project");
});

test("state restoration skips a workspace that no longer exists", async () => {
  const StatesManager = loadGlobal(
    "src/js/manager/StatesManager.js",
    "StatesManager",
    { FileNode: class {}, window: { api: {} } },
  );
  let attempts = 0;
  const manager = Object.create(StatesManager.prototype);
  manager.editor = {
    fileExplorer: {
      projectExpanded: true,
      async loadProject() {
        attempts++;
        return false;
      },
    },
  };
  await manager.loadFileExplorerState({
    rootPath: "/missing",
    expandedPaths: ["/missing/sub"],
  });
  assert.equal(attempts, 1);
});
