const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

const NCEPath = loadGlobal("src/js/core/Path.js", "NCEPath");

function loadFileExplorer(windowApi = {}, confirmImpl = () => true, runtime = {}) {
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
    ...runtime,
  });
}

class TestElement {
  constructor(document, tagName = "div") {
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.parentElement = null;
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.open = false;
    this.isConnected = false;
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      child.isConnected = this.isConnected;
      this.children.push(child);
    }
  }

  appendChild(child) {
    this.append(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type, callback) {
    if (typeof callback !== "function") return;
    const callbacks = this.listeners.get(type) || new Set();
    callbacks.add(callback);
    this.listeners.set(type, callbacks);
  }

  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback);
  }

  dispatch(type, extra = {}) {
    const event = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...extra,
    };
    for (const callback of this.listeners.get(type) || []) callback(event);
    return event;
  }

  click() {
    if (!this.disabled) this.dispatch("click");
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  showModal() {
    if (!this.isConnected || this.open) throw new Error("Dialog cannot open");
    this.open = true;
  }

  close() {
    this.open = false;
    this.dispatch("close");
  }

  remove() {
    this.parentElement?.children.splice(
      this.parentElement.children.indexOf(this),
      1,
    );
    this.isConnected = false;
    this.parentElement = null;
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (selector === "[hidden]" && node.hidden) return node;
      if (selector === '[aria-hidden="true"]' && node.getAttribute("aria-hidden") === "true") return node;
      if (selector === "dialog:not([open])" && node.tagName === "DIALOG" && !node.open) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelector(selector) {
    const matches = (node) => selector.startsWith("#")
      ? node.id === selector.slice(1)
      : selector.startsWith(".")
        ? node.className.split(/\s+/).includes(selector.slice(1))
        : false;
    const visit = (node) => {
      for (const child of node.children) {
        if (matches(child)) return child;
        const nested = visit(child);
        if (nested) return nested;
      }
      return null;
    };
    return visit(this);
  }
}

class TestDocument {
  constructor() {
    this.body = new TestElement(this, "body");
    this.body.isConnected = true;
    this.activeElement = this.body;
  }

  createElement(tagName) {
    return new TestElement(this, tagName);
  }

  querySelectorAll() {
    return [];
  }
}

function deleteExplorerFixture({
  confirmDelete = true,
  persistSetting = async () => true,
  deleteResults = [{ success: true }],
  prepareFilesForDeletion = async () => true,
  file = { name: "example.js", path: "/project/example.js", type: "file" },
  rootPath = "/project",
} = {}) {
  const document = new TestDocument();
  const settings = { "files.confirmDelete": confirmDelete };
  const settingWrites = [];
  const deleteCalls = [];
  const prepareCalls = [];
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
      document,
      SETTINGS_GET(key) { return settings[key]; },
      async SETTINGS_SET(key, value) {
        settingWrites.push([key, value]);
        const saved = await persistSetting(key, value);
        if (saved) settings[key] = value;
        return saved;
      },
      alert(message) { alerts.push(message); },
      requestAnimationFrame(callback) { callback(); },
      setTimeout,
      clearTimeout,
      console: { error() {}, warn() {} },
      buildFileContextMenu() {},
      buildFolderContextMenu() {},
      buildBackgroundContextMenu() {},
      buildProjectContextMenu() {},
    },
  );
  const explorer = Object.create(FileExplorer.prototype);
  const projectHeader = document.createElement("button");
  document.body.append(projectHeader);
  Object.assign(explorer, {
    rootPath,
    workspaceSwitching: false,
    deleteWorkspaceGeneration: 0,
    deleteExplorerDestroyed: false,
    pendingDeleteOperation: null,
    deleteDialog: null,
    deleteDialogTitle: null,
    deleteDialogMessage: null,
    deleteDialogCheckboxLabel: null,
    deleteDialogCheckbox: null,
    deleteDialogCancelButton: null,
    deleteDialogDeleteButton: null,
    deleteDialogSession: null,
    deleteDialogFocusGeneration: 0,
    projectHeader,
    refreshFolderCalls: [],
    fileOperations: {
      async delete(path, force) {
        deleteCalls.push([path, force]);
        return deleteResults.shift() || { success: true };
      },
    },
    editor: {
      tabManager: {
        async prepareFilesForDeletion(path) {
          prepareCalls.push(path);
          return prepareFilesForDeletion(path);
        },
        markFileAsDeleted(path) { deleteCalls.push(["marked", path]); },
      },
      quickPanel: { isOpen: () => false },
    },
    async refreshFolder(path) { this.refreshFolderCalls.push(path); },
    onDeleteDialogCancel: (event) => {
      event.preventDefault();
      explorer.finishDeleteConfirmation({ confirmed: false, dontAskAgain: false });
    },
    onDeleteDialogClose: () => explorer.completeDeleteConfirmation(),
    onDeleteDialogClick: (event) => {
      if (event.target === explorer.deleteDialog)
        explorer.finishDeleteConfirmation({ confirmed: false, dontAskAgain: false });
    },
    onDeleteDialogCancelClick: () => {
      explorer.finishDeleteConfirmation({ confirmed: false, dontAskAgain: false });
    },
    onDeleteDialogDeleteClick: () => {
      explorer.finishDeleteConfirmation({
        confirmed: true,
        dontAskAgain: explorer.deleteDialogCheckbox?.checked === true,
      });
    },
    onDeleteWindowPageHide: () => {
      explorer.deleteExplorerDestroyed = true;
      explorer.invalidateDeleteContext({ restoreFocus: false });
    },
  });
  return {
    explorer,
    file,
    document,
    settings,
    settingWrites,
    deleteCalls,
    prepareCalls,
    alerts,
  };
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

test("delete confirmation defaults to safe Cancel and restores focus", async () => {
  const fixture = deleteExplorerFixture();
  fixture.explorer.projectHeader.focus();
  const operation = fixture.explorer.deleteEntry(fixture.file);
  const dialog = fixture.explorer.deleteDialog;
  assert.equal(dialog.open, true);
  assert.equal(fixture.explorer.deleteDialogTitle.textContent, "Delete file?");
  assert.equal(
    fixture.explorer.deleteDialogMessage.textContent,
    'Are you sure you want to permanently delete "example.js"?',
  );
  assert.equal(fixture.explorer.deleteDialogCheckbox.checked, false);
  assert.equal(fixture.explorer.deleteDialogCancelButton.textContent, "Cancel");
  assert.equal(fixture.explorer.deleteDialogDeleteButton.textContent, "Delete");
  assert.equal(fixture.document.activeElement, fixture.explorer.deleteDialogCancelButton);

  fixture.explorer.deleteDialogCancelButton.click();
  assert.equal(await operation, false);
  assert.deepEqual(fixture.deleteCalls, []);
  assert.deepEqual(fixture.settingWrites, []);
  assert.equal(fixture.document.activeElement, fixture.explorer.projectHeader);
});

test("confirmed file deletion prepares unsaved buffers and deletes once", async () => {
  const fixture = deleteExplorerFixture();
  const operation = fixture.explorer.deleteEntry(fixture.file);
  fixture.explorer.deleteDialogDeleteButton.click();
  assert.equal(await operation, true);
  assert.deepEqual(fixture.prepareCalls, [fixture.file.path]);
  assert.deepEqual(fixture.deleteCalls, [
    [fixture.file.path, false],
    ["marked", fixture.file.path],
  ]);
  assert.deepEqual(fixture.explorer.refreshFolderCalls, ["/project"]);
});

test("checking Don't ask again and cancelling does not change settings", async () => {
  const fixture = deleteExplorerFixture();
  const operation = fixture.explorer.deleteEntry(fixture.file);
  fixture.explorer.deleteDialogCheckbox.checked = true;
  fixture.explorer.deleteDialogCancelButton.click();
  assert.equal(await operation, false);
  assert.deepEqual(fixture.settingWrites, []);
  assert.equal(fixture.settings["files.confirmDelete"], true);
  assert.deepEqual(fixture.deleteCalls, []);
});

test("checking Don't ask again saves the preference before deleting", async () => {
  const fixture = deleteExplorerFixture();
  const operation = fixture.explorer.deleteEntry(fixture.file);
  fixture.explorer.deleteDialogCheckbox.checked = true;
  fixture.explorer.deleteDialogDeleteButton.click();
  assert.equal(await operation, true);
  assert.deepEqual(fixture.settingWrites, [["files.confirmDelete", false]]);
  assert.equal(fixture.settings["files.confirmDelete"], false);
  assert.deepEqual(fixture.deleteCalls.slice(0, 1), [[fixture.file.path, false]]);
});

test("a failed preference write keeps future confirmations enabled but honors Delete", async () => {
  const fixture = deleteExplorerFixture({ persistSetting: async () => false });
  const operation = fixture.explorer.deleteEntry(fixture.file);
  fixture.explorer.deleteDialogCheckbox.checked = true;
  fixture.explorer.deleteDialogDeleteButton.click();
  assert.equal(await operation, true);
  assert.equal(fixture.settings["files.confirmDelete"], true);
  assert.deepEqual(fixture.settingWrites, [["files.confirmDelete", false]]);
  assert.equal(fixture.deleteCalls.some(([path]) => path === fixture.file.path), true);
});

test("disabled ordinary confirmation still protects unsaved files", async () => {
  const fixture = deleteExplorerFixture({
    confirmDelete: false,
    prepareFilesForDeletion: async () => false,
  });
  assert.equal(await fixture.explorer.deleteEntry(fixture.file), false);
  assert.equal(fixture.explorer.deleteDialog, null);
  assert.deepEqual(fixture.prepareCalls, [fixture.file.path]);
  assert.deepEqual(fixture.deleteCalls, []);
});

test("non-empty folders always require a second recursive confirmation", async () => {
  const file = { name: "components", path: "/project/components", type: "folder" };
  const fixture = deleteExplorerFixture({
    confirmDelete: false,
    file,
    deleteResults: [
      { success: false, code: "FOLDER_NOT_EMPTY" },
      { success: true },
    ],
  });
  const operation = fixture.explorer.deleteEntry(file);
  await new Promise(setImmediate);
  assert.equal(fixture.explorer.deleteDialog.open, true);
  assert.equal(fixture.explorer.deleteDialogTitle.textContent, "Delete folder?");
  assert.match(fixture.explorer.deleteDialogMessage.textContent, /all files and subfolders inside it/);
  assert.equal(fixture.explorer.deleteDialogCheckboxLabel.hidden, true);
  fixture.explorer.deleteDialogDeleteButton.click();
  assert.equal(await operation, true);
  assert.deepEqual(fixture.deleteCalls, [
    [file.path, false],
    [file.path, true],
    ["marked", file.path],
  ]);
  assert.deepEqual(fixture.prepareCalls, [file.path]);
});

test("ordinary and recursive folder confirmations are shown one at a time", async () => {
  const file = { name: "components", path: "/project/components", type: "folder" };
  const fixture = deleteExplorerFixture({
    file,
    deleteResults: [
      { success: false, code: "FOLDER_NOT_EMPTY" },
      { success: true },
    ],
  });
  const operation = fixture.explorer.deleteEntry(file);
  const dialog = fixture.explorer.deleteDialog;
  const bodyDialogCount = () =>
    fixture.document.body.children.filter((child) => child.tagName === "DIALOG").length;
  assert.equal(dialog.open, true);
  assert.equal(fixture.explorer.deleteDialogCheckboxLabel.hidden, false);
  fixture.explorer.deleteDialogDeleteButton.click();
  await new Promise(setImmediate);
  assert.equal(fixture.explorer.deleteDialog, dialog);
  assert.equal(dialog.open, true);
  assert.match(fixture.explorer.deleteDialogMessage.textContent, /all files and subfolders inside it/);
  assert.equal(fixture.explorer.deleteDialogCheckboxLabel.hidden, true);
  assert.equal(bodyDialogCount(), 1);
  fixture.explorer.deleteDialogDeleteButton.click();
  assert.equal(await operation, true);
  assert.equal(dialog.open, false);
});

test("cancelling recursive folder deletion never calls delete with force", async () => {
  const file = { name: "components", path: "/project/components", type: "folder" };
  const fixture = deleteExplorerFixture({
    confirmDelete: false,
    file,
    deleteResults: [{ success: false, code: "FOLDER_NOT_EMPTY" }],
  });
  const operation = fixture.explorer.deleteEntry(file);
  await new Promise(setImmediate);
  fixture.explorer.deleteDialogCancelButton.click();
  assert.equal(await operation, false);
  assert.deepEqual(fixture.deleteCalls, [[file.path, false]]);
});

test("double clicks and concurrent delete requests cannot duplicate a deletion", async () => {
  const fixture = deleteExplorerFixture();
  const operation = fixture.explorer.deleteEntry(fixture.file);
  const duplicate = fixture.explorer.deleteEntry(fixture.file);
  const other = fixture.explorer.deleteEntry({
    name: "other.js",
    path: "/project/other.js",
    type: "file",
  });
  assert.equal(duplicate, operation);
  assert.equal(await other, false);
  fixture.explorer.deleteDialogDeleteButton.click();
  fixture.explorer.deleteDialogDeleteButton.click();
  assert.equal(await operation, true);
  assert.equal(fixture.deleteCalls.filter(([path]) => path === fixture.file.path).length, 1);
});

test("Escape cancels and workspace changes invalidate an open confirmation", async () => {
  const fixture = deleteExplorerFixture();
  const operation = fixture.explorer.deleteEntry(fixture.file);
  const escape = fixture.explorer.deleteDialog.dispatch("cancel");
  assert.equal(escape.defaultPrevented, true);
  assert.equal(await operation, false);

  const second = fixture.explorer.deleteEntry(fixture.file);
  fixture.explorer.invalidateDeleteContext();
  assert.equal(await second, false);
  assert.deepEqual(fixture.deleteCalls, []);
  assert.equal(fixture.explorer.deleteDialog.open, false);

  const reopened = fixture.explorer.deleteEntry(fixture.file);
  assert.equal(fixture.explorer.deleteDialog.open, true);
  fixture.explorer.deleteDialogCancelButton.click();
  assert.equal(await reopened, false);
});

test("root paths are never offered for deletion and missing entries fail quietly", async () => {
  const fixture = deleteExplorerFixture({
    deleteResults: [{ success: false, code: "SOURCE_NOT_FOUND" }],
  });
  assert.equal(await fixture.explorer.deleteEntry({
    name: "project",
    path: "/project",
    type: "folder",
  }), false);
  const operation = fixture.explorer.deleteEntry(fixture.file);
  fixture.explorer.deleteDialogDeleteButton.click();
  assert.equal(await operation, false);
  assert.deepEqual(fixture.alerts, []);
});

test("symlink entries use non-recursive deletion", async () => {
  const symlink = { name: "linked-folder", path: "/project/linked-folder", type: "file" };
  const fixture = deleteExplorerFixture({ file: symlink });
  const operation = fixture.explorer.deleteEntry(symlink);
  fixture.explorer.deleteDialogDeleteButton.click();
  assert.equal(await operation, true);
  assert.deepEqual(fixture.deleteCalls.slice(0, 1), [[symlink.path, false]]);
});

test("window page hide cancels a pending confirmation", async () => {
  const fixture = deleteExplorerFixture();
  const operation = fixture.explorer.deleteEntry(fixture.file);
  fixture.explorer.onDeleteWindowPageHide();
  assert.equal(await operation, false);
  assert.equal(fixture.explorer.deleteDialog.open, false);
  assert.deepEqual(fixture.deleteCalls, []);
});

test("permission and filesystem failures are reported without recursive retry", async () => {
  const file = { name: "components", path: "/project/components", type: "folder" };
  const fixture = deleteExplorerFixture({
    file,
    deleteResults: [
      { success: false, code: "FOLDER_NOT_EMPTY" },
      { success: false, code: "PERMISSION_DENIED", error: "Permission denied." },
    ],
  });
  const operation = fixture.explorer.deleteEntry(file);
  fixture.explorer.deleteDialogDeleteButton.click();
  await new Promise(setImmediate);
  fixture.explorer.deleteDialogDeleteButton.click();
  assert.equal(await operation, false);
  assert.deepEqual(fixture.deleteCalls, [[file.path, false], [file.path, true]]);
  assert.deepEqual(fixture.alerts, ["Permission denied."]);
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
  assert.equal(explorer.editingState, null);
  assert.deepEqual(placeholders, []);
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

test("creation errors keep the new entry editor active", async () => {
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
        return { success: false, code: "PERMISSION_DENIED", error: "Denied" };
      },
    },
    refresh() {},
  });

  await explorer.startCreateEntry("/project", "file");
  const placeholder = placeholders[0];
  await explorer.commitEdit("new.js", placeholder);
  assert.equal(explorer.editingState.status, "editing");
  assert.deepEqual(placeholders, [placeholder]);
  assert.deepEqual(alerts, ["Denied"]);
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

test("filesystem changes are handled without initializing the Agent runtime", async () => {
  const FileExplorer = loadFileExplorer();
  const calls = { reload: [], deleted: [], invalidations: [], loads: [], refreshes: 0 };
  const editor = {
    agent: null,
    ensureAgent() { assert.fail("filesystem updates must not initialize Agent"); },
    quickOpen: { invalidate(root) { calls.invalidations.push(root); } },
    tabManager: {
      reloadFileFromDisk(path) { calls.reload.push(path); },
      markFileAsDeleted(path) { calls.deleted.push(path); },
    },
  };
  const explorer = Object.assign(Object.create(FileExplorer.prototype), {
    rootPath: "/workspace",
    files: [],
    editingState: null,
    editor,
    async loadFiles(...args) { calls.loads.push(args); },
    refresh() { calls.refreshes++; },
  });

  await explorer.handleFileSystemChanges([
    { event: "change", filePath: "/workspace/edited.js", dirPath: "/workspace" },
    { event: "change", filePath: "/workspace/src/app.js", dirPath: "/workspace/src" },
  ]);

  assert.equal(editor.agent, null);
  assert.deepEqual(calls.reload, ["/workspace/edited.js", "/workspace/src/app.js"]);
  assert.equal(calls.loads.length, 0);
  assert.equal(calls.refreshes, 0);
  assert.deepEqual(calls.invalidations, ["/workspace"]);

  await explorer.handleFileSystemChanges([
    { event: "add", filePath: "/workspace/new.js", dirPath: "/workspace" },
    { event: "unlink", filePath: "/workspace/deleted.js", dirPath: "/workspace" },
  ]);

  assert.deepEqual(calls.deleted, ["/workspace/deleted.js"]);
  assert.equal(calls.loads.length, 1);
  assert.deepEqual(calls.loads[0][0], new Set());
  assert.equal(calls.loads[0][1].preserveExpandedContents, true);
  assert.equal(calls.refreshes, 1);
  assert.deepEqual(calls.invalidations, ["/workspace", "/workspace"]);
});

test("root-only tree refresh preserves loaded descendants without rereading them", async () => {
  const root = "/workspace";
  const reads = [];
  const FileExplorer = loadFileExplorer({
    async getFolderContent(folderPath) {
      reads.push(folderPath);
      return [
        { name: "src", type: "folder", path: `${root}/src` },
        { name: "new.js", type: "file", path: `${root}/new.js` },
      ];
    },
  });
  const oldChild = { name: "app.js", type: "file", path: `${root}/src/app.js` };
  const expandedFolder = {
    name: "src",
    type: "folder",
    path: `${root}/src`,
    expanded: true,
    children: [oldChild],
  };
  const explorer = Object.assign(Object.create(FileExplorer.prototype), {
    rootPath: root,
    files: [expandedFolder],
    staleFolderPaths: new Set(),
    fileOperations: {
      async pathStatus() { return { exists: true, isDirectory: true }; },
    },
    editor: {
      quickOpen: { invalidate() {} },
      tabManager: { markFileAsDeleted() {}, reloadFileFromDisk() {} },
    },
    refresh() {},
  });

  await explorer.handleFileSystemChanges([
    { event: "add", filePath: `${root}/new.js`, dirPath: root },
    { event: "addDir", filePath: `${root}/assets`, dirPath: root },
    { event: "unlinkDir", filePath: `${root}/old-folder`, dirPath: root },
  ]);

  assert.deepEqual(reads, [root]);
  assert.equal(explorer.files.length, 2);
  assert.equal(explorer.files[0].expanded, true);
  assert.equal(explorer.files[0].children[0], oldChild);
  assert.equal(explorer.files[1].name, "new.js");
});

test("index reconciliation refreshes only directories with structural differences", async () => {
  const FileExplorer = loadFileExplorer();
  const refreshedFolders = [];
  const explorer = Object.assign(Object.create(FileExplorer.prototype), {
    rootPath: "/workspace",
    files: [],
    staleFolderPaths: new Set(),
    editingState: null,
    editor: {
      quickOpen: { invalidate() {} },
      tabManager: { reloadFileFromDisk() {}, markFileAsDeleted() {} },
    },
    async refreshFolderIfLoaded(dirPath) {
      refreshedFolders.push(dirPath);
      return true;
    },
    refresh() {},
  });

  await explorer.handleFileSystemChanges([
    { event: "index-reconciled", filePath: "/workspace", changedDirectories: [] },
  ]);
  assert.deepEqual(refreshedFolders, []);

  await explorer.handleFileSystemChanges([
    {
      event: "index-reconciled",
      filePath: "/workspace",
      changedDirectories: ["/workspace/src/components"],
    },
  ]);
  assert.deepEqual(refreshedFolders, ["/workspace/src/components"]);
});

test("watcher refreshes an expanded folder and defers a collapsed folder until expansion", async () => {
  const reads = [];
  const api = {
    async getFolderContent(folderPath) {
      reads.push(folderPath);
      return [{
        name: `fresh-${NCEPath.basename(folderPath)}.js`,
        type: "file",
        path: `${folderPath}/fresh-${NCEPath.basename(folderPath)}.js`,
      }];
    },
  };
  const FileExplorer = loadFileExplorer(api);
  const expanded = {
    name: "src",
    type: "folder",
    path: "/workspace/src",
    expanded: true,
    children: [{ name: "old.js", type: "file", path: "/workspace/src/old.js" }],
  };
  const deletedFiles = [];
  const collapsed = {
    name: "lib",
    type: "folder",
    path: "/workspace/lib",
    expanded: false,
    children: [{ name: "old.js", type: "file", path: "/workspace/lib/old.js" }],
  };
  let refreshes = 0;
  const explorer = Object.assign(Object.create(FileExplorer.prototype), {
    rootPath: "/workspace",
    isLoaded: true,
    files: [expanded, collapsed],
    staleFolderPaths: new Set(),
    editingState: null,
    editor: {
      quickOpen: { invalidate() {} },
      tabManager: {
        reloadFileFromDisk() {},
        markFileAsDeleted(filePath) { deletedFiles.push(filePath); },
      },
    },
    refresh() { refreshes++; },
  });

  await explorer.handleFileSystemChanges([
    { event: "add", filePath: "/workspace/src/new.js", dirPath: "/workspace/src" },
    { event: "addDir", filePath: "/workspace/src/generated", dirPath: "/workspace/src" },
    { event: "unlinkDir", filePath: "/workspace/src/removed", dirPath: "/workspace/src" },
    { event: "unlink", filePath: "/workspace/src/deleted.js", dirPath: "/workspace/src" },
    { event: "add", filePath: "/workspace/lib/new.js", dirPath: "/workspace/lib" },
  ]);
  assert.deepEqual(reads, ["/workspace/src"]);
  assert.deepEqual(deletedFiles, ["/workspace/src/removed", "/workspace/src/deleted.js"]);
  assert.equal(expanded.children[0].name, "fresh-src.js");
  assert.equal(
    explorer.staleFolderPaths.has(NCEPath.comparisonKey("/workspace/lib")),
    true,
  );
  assert.equal(refreshes, 1);

  await explorer.toggleFolder("/workspace/lib");
  assert.deepEqual(reads, ["/workspace/src", "/workspace/lib"]);
  assert.equal(collapsed.children[0].name, "fresh-lib.js");
  assert.equal(
    explorer.staleFolderPaths.has(NCEPath.comparisonKey("/workspace/lib")),
    false,
  );
  assert.equal(refreshes, 2);
});

test("workspace restoration can defer the initial File Explorer refresh", async () => {
  const FileExplorer = loadFileExplorer({
    async startWatching() {},
  });
  const explorer = Object.create(FileExplorer.prototype);
  let refreshes = 0;
  Object.assign(explorer, {
    rootPath: "",
    files: [],
    fileOperations: {
      async pathStatus() { return { exists: true, isDirectory: true }; },
    },
    async loadFiles() { this.isLoaded = true; return true; },
    refresh() { refreshes++; },
    editor: { events: { callEvent() {} } },
  });

  assert.equal(await explorer.loadProject("/project", { deferRefresh: true }), true);
  assert.equal(explorer.isLoaded, true);
  assert.equal(refreshes, 0);

  assert.equal(await explorer.loadProject("/project"), true);
  assert.equal(refreshes, 1);
});

test("restoring the File Explorer sidebar skips its normal reload hook", async () => {
  const reads = [];
  const FileExplorer = loadFileExplorer({
    async getFolderContent(folderPath) {
      reads.push(folderPath);
      return [];
    },
  });
  const explorer = Object.create(FileExplorer.prototype);
  let refreshes = 0;
  Object.assign(explorer, {
    rootPath: "/project",
    files: [],
    isLoaded: false,
    isStale: false,
    staleFolderPaths: new Set(),
    fileOperations: {
      async pathStatus() { return { exists: true, isDirectory: true }; },
    },
    refresh() { refreshes++; },
  });

  await explorer.onOpen({ restoring: true });
  assert.deepEqual(reads, []);
  assert.equal(refreshes, 0);

  await explorer.onOpen();
  assert.deepEqual(reads, ["/project"]);
  assert.equal(explorer.isLoaded, true);
  assert.equal(refreshes, 1);

  // Closing and reopening resumes the existing model without reading the root again.
  await explorer.onOpen();
  assert.deepEqual(reads, ["/project"]);
  assert.equal(refreshes, 2);

  explorer.isStale = true;
  await explorer.onOpen();
  assert.deepEqual(reads, ["/project", "/project"]);
  assert.equal(explorer.isStale, false);
  assert.equal(refreshes, 3);
});

test("File Explorer close and reopen reuses the tree built for the active workspace", async () => {
  const reads = [];
  const FileExplorer = loadFileExplorer({
    async getFolderContent(folderPath) {
      reads.push(folderPath);
      return [{ name: "file.js", type: "file", path: `${folderPath}/file.js` }];
    },
  });
  const explorer = Object.assign(Object.create(FileExplorer.prototype), {
    rootPath: "/project",
    files: [],
    isLoaded: false,
    isStale: false,
    staleFolderPaths: new Set(),
    fileOperations: {
      async pathStatus() { return { exists: true, isDirectory: true }; },
    },
    refresh() {},
  });

  await explorer.loadFiles();
  await explorer.onOpen();
  explorer.isOpen = false;
  await explorer.onOpen();

  assert.deepEqual(reads, ["/project"]);
  assert.equal(explorer.isLoaded, true);
});

test("explicit File Explorer refresh reloads the root and restored expanded folders", async () => {
  const reads = [];
  const FileExplorer = loadFileExplorer({
    async getFolderContent(folderPath) {
      reads.push(folderPath);
      if (folderPath === "/project")
        return [{ name: "src", type: "folder", path: "/project/src" }];
      return [{ name: "index.js", type: "file", path: `${folderPath}/index.js` }];
    },
  });
  const explorer = Object.assign(Object.create(FileExplorer.prototype), {
    rootPath: "/project",
    files: [{
      name: "src",
      type: "folder",
      path: "/project/src",
      expanded: true,
      children: [{ name: "old.js", type: "file", path: "/project/src/old.js" }],
    }],
    isLoaded: true,
    isStale: false,
    staleFolderPaths: new Set(),
    fileOperations: {
      async pathStatus() { return { exists: true, isDirectory: true }; },
    },
    refresh() {},
  });

  await explorer.refreshFolder("/project");
  assert.deepEqual(reads, ["/project", "/project/src"]);
  assert.equal(explorer.files[0].children[0].name, "index.js");
  assert.equal(explorer.isLoaded, true);
  assert.equal(explorer.isStale, false);
});

test("switching workspaces loads the new tree once and keeps it on sidebar reopen", async () => {
  const reads = [];
  const api = {
    async startWatching() {},
    async stopWatching() {},
    async getFolderContent(folderPath) {
      reads.push(folderPath);
      return [{ name: "file.js", type: "file", path: `${folderPath}/file.js` }];
    },
  };
  const FileExplorer = loadFileExplorer(api);
  const editor = {
    api: { async addRecentFolder() {} },
    tabManager: {
      async prepareForQuit() { return true; },
      async closeFiles() { return true; },
    },
    searchSidebar: { resetWorkspace() {} },
    quickOpen: { invalidate() {} },
    agentSidebar: { manualContextManager: { handleWorkspaceChanged() {} } },
    statesManager: {
      persistenceSuspended: false,
      noWorkspaceState: null,
      lastWorkspace: null,
      getNoWorkspaceState() { return {}; },
      async saveWorkspaceState() { return true; },
      async loadWorkspaceState() {},
      async saveGlobalState() { return true; },
    },
    events: { callEvent() {} },
  };
  const explorer = Object.assign(Object.create(FileExplorer.prototype), {
    rootPath: "",
    projectName: "",
    files: [],
    isLoaded: false,
    isStale: false,
    staleFolderPaths: new Set(),
    workspaceSwitching: false,
    editingState: null,
    fileOperations: {
      async pathStatus() { return { exists: true, isDirectory: true }; },
    },
    editor,
    refresh() {},
  });

  assert.equal(await explorer.requestWorkspaceSwitch("/first"), true);
  await explorer.onOpen();
  assert.equal(await explorer.requestWorkspaceSwitch("/second"), true);
  await explorer.onOpen();

  assert.deepEqual(reads, ["/first", "/second"]);
  assert.equal(explorer.rootPath, "/second");
  assert.equal(explorer.files[0].path, "/second/file.js");
  assert.equal(explorer.isLoaded, true);
});

test("workspace UI restoration never reopens the project", async () => {
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
  assert.equal(attempts, 0);
});

test("large workspace mode displays its cause and clears across workspace switches", () => {
  const FileExplorer = loadFileExplorer();
  let refreshedDialogStats = 0;
  let dialogCloses = 0;
  const badge = {
    hidden: true,
    textContent: "",
    title: "",
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
  };
  const explorer = Object.assign(Object.create(FileExplorer.prototype), {
    rootPath: "/project-a",
    workspaceModeBadge: badge,
    workspaceIndexStats: null,
    largeWorkspaceMode: false,
    workspaceModeDialog: {
      open: true,
      close() {
        dialogCloses++;
        this.open = false;
      },
    },
    updateWorkspaceModeDialogStats() { refreshedDialogStats++; },
  });
  const largeStats = {
    root: "/project-a",
    ready: true,
    fileCount: 18000,
    directoryCount: 2400,
    totalIndexedBytes: 3 * 1024 ** 3,
    pressureScore: 3.9,
    largeWorkspaceMode: true,
    generatedAt: 1,
  };

  assert.equal(explorer.applyWorkspaceIndexStats(largeStats), true);
  assert.equal(badge.hidden, false);
  assert.match(badge.textContent, /LARGE WORKSPACE MODE/);
  assert.match(badge.title, /18,000 files/);
  assert.match(badge.title, /all editor features remain available/i);
  assert.equal(refreshedDialogStats, 1);
  assert.equal(explorer.formatIndexedSize(3 * 1024 ** 3), "3.0 GiB");

  explorer.rootPath = "/project-b";
  assert.equal(explorer.applyWorkspaceIndexStats(largeStats), false);
  explorer.clearWorkspaceIndexStats();
  assert.equal(badge.hidden, true);
  assert.equal(badge.textContent, "");
  assert.equal(dialogCloses, 1);
  assert.equal(explorer.workspaceModeDialog.open, false);
});

test("workspace dialog restores focus after native close and ignores a stale restore after reopen", () => {
  const frames = new Map();
  let nextFrameId = 1;
  const document = {
    body: { tagName: "BODY" },
    activeElement: null,
    modals: [],
    querySelectorAll() {
      return this.modals.filter((modal) =>
        modal.tagName !== "DIALOG" || modal.open === true,
      );
    },
  };
  const FileExplorer = loadFileExplorer({}, () => true, {
    document,
    requestAnimationFrame(callback) {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    },
  });
  const badge = {
    isConnected: true,
    hidden: true,
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    closest() { return null; },
  };
  const header = {
    isConnected: true,
    hidden: false,
    closest() { return null; },
    focus() { document.activeElement = this; },
  };
  const closeButton = {
    isConnected: true,
    hidden: false,
    focus() { document.activeElement = this; },
  };
  const dialog = {
    tagName: "DIALOG",
    open: false,
    getAttribute() { return "true"; },
    showModal() { this.open = true; },
    querySelector() { return closeButton; },
  };
  document.modals = [dialog];
  const explorer = Object.assign(Object.create(FileExplorer.prototype), {
    editor: { quickPanel: { isOpen: () => false } },
    largeWorkspaceMode: true,
    workspaceIndexStats: { fileCount: 18000 },
    workspaceModeBadge: badge,
    workspaceModeDialog: dialog,
    workspaceModeDialogPreviousFocus: badge,
    workspaceModeFocusGeneration: 0,
    projectHeader: header,
    updateWorkspaceModeDialogStats() {},
  });
  document.activeElement = document.body;

  explorer.restoreWorkspaceModeDialogFocus();
  assert.equal(document.activeElement, document.body);
  const [restoreId] = frames.keys();
  const restore = frames.get(restoreId);
  frames.delete(restoreId);
  restore();
  assert.equal(document.activeElement, header);

  document.activeElement = badge;
  explorer.workspaceModeDialogPreviousFocus = badge;
  explorer.restoreWorkspaceModeDialogFocus();
  const [staleRestoreId] = frames.keys();
  const staleRestore = frames.get(staleRestoreId);
  frames.delete(staleRestoreId);
  explorer.showWorkspaceModeDialog();
  assert.equal(document.activeElement, closeButton);
  const reopenedFocus = explorer.workspaceModeDialogPreviousFocus;
  explorer.restoreWorkspaceModeDialogFocus();
  assert.equal(explorer.workspaceModeDialogPreviousFocus, reopenedFocus);
  staleRestore();
  assert.equal(dialog.open, true);
  assert.equal(document.activeElement, closeButton);

  dialog.open = false;
  document.activeElement = document.body;
  explorer.restoreWorkspaceModeDialogFocus();
  const [finalRestoreId] = frames.keys();
  const finalRestore = frames.get(finalRestoreId);
  frames.delete(finalRestoreId);
  finalRestore();
  assert.equal(document.activeElement, header);
});
