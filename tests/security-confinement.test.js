const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { PathAccess } = require("../dist/ts/manager/PathAccess.js");
const { WindowSessionStore } = require("../dist/ts/manager/WindowSessionStore.js");
const { Window } = require("../dist/ts/Window.js");
const { FileManager } = require("../dist/ts/addon/FileManager.js");
const { NceWorkspaceStorage } = require("../dist/ts/addon/NceWorkspaceStorage.js");
const { WorkspaceSearch } = require("../dist/ts/addon/WorkspaceSearch.js");
const { loadMain } = require("./helpers/main-runtime");

async function tempRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("PathAccess confines reads to the active workspace and explicit grants", async () => {
  const root = await tempRoot("nce-path-access-");
  const outside = await tempRoot("nce-path-outside-");
  try {
    const insideFile = path.join(root, "inside.txt");
    const outsideFile = path.join(outside, "outside.txt");
    await fs.writeFile(insideFile, "inside");
    await fs.writeFile(outsideFile, "outside");
    const access = new PathAccess(() => root);

    assert.equal(await access.isAuthorized(insideFile), true);
    assert.equal(await access.isAuthorized(outsideFile), false);
    assert.equal(await access.isAuthorized(path.join(root, "..", "escape.txt")), false);

    await access.authorizeFile(outsideFile);
    assert.equal(await access.isAuthorized(outsideFile), true);

    const pending = path.join(outside, "future.txt");
    assert.equal(await access.isAuthorized(pending, { allowMissing: true }), false);
    await access.authorizeFile(pending, { allowMissing: true });
    assert.equal(await access.isAuthorized(pending, { allowMissing: true }), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("PathAccess rejects symlink escapes from an authorized workspace", {
  skip: process.platform === "win32",
}, async () => {
  const root = await tempRoot("nce-path-links-");
  const outside = await tempRoot("nce-path-links-outside-");
  try {
    const secret = path.join(outside, "secret.txt");
    await fs.writeFile(secret, "secret");
    const link = path.join(root, "secret.txt");
    await fs.symlink(secret, link);
    const access = new PathAccess(() => root);
    assert.equal(await access.isAuthorized(link), false);
    assert.equal(await access.isAuthorized(secret), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("FileManager only reads and writes authorized workspace paths", async () => {
  const root = await tempRoot("nce-file-confine-");
  const outside = await tempRoot("nce-file-confine-outside-");
  try {
    const insideFile = path.join(root, "inside.txt");
    const outsideFile = path.join(outside, "outside.txt");
    await fs.writeFile(insideFile, "inside");
    await fs.writeFile(outsideFile, "outside");
    const window = {
      pathAccess: new PathAccess(() => root),
      watcher: {
        getWatchedPath: () => root,
        beginOwnWrite: () => null,
        commitOwnWrite() {},
        cancelOwnWrite() {},
      },
      reloadSettingsFromDisk: async () => {},
    };
    const manager = new FileManager(window, async () => {}, { handle() {} });
    assert.deepEqual(await manager.getFileContent([insideFile, outsideFile]), {
      [insideFile]: "inside",
    });
    assert.equal(await manager.saveFile(outsideFile, "overwritten"), undefined);
    assert.equal(await fs.readFile(outsideFile, "utf8"), "outside");
    assert.equal(await manager.saveFile(insideFile, "saved"), insideFile);
    assert.equal(await fs.readFile(insideFile, "utf8"), "saved");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

for (const saveAs of [false, true]) {
  test(`session restart restores only main-approved external files (${saveAs ? "Save As" : "open"})`, async () => {
    const root = await tempRoot("nce-file-session-");
    try {
      const target = path.join(root, "external.js");
      const denied = path.join(root, "denied.js");
      const content = "const value = 1;";
      await fs.writeFile(denied, "not authorized");
      if (!saveAs) await fs.writeFile(target, content);
      const store = new WindowSessionStore(path.join(root, "profile"));
      await store.initialize();
      const session = store.create();
      const other = store.create();
      const window = new Window({ windowSessionStore: store }, { session });
      window.reloadSettingsFromDisk = async () => false;
      const manager = new FileManager(window, async () => {}, { handle() {} });
      assert.equal(await window.pathAccess.isAuthorized(target, { allowMissing: true }), false);
      await window.pathAccess.authorizeFile(target, { allowMissing: saveAs });
      if (saveAs) assert.equal(await manager.saveFile(target, content), target);
      const state = {
        version: 2,
        lastWorkspace: null,
        authorizedFiles: [denied],
        noWorkspaceState: { tabManager: { tabs: [
          { id: 1, type: "file", path: target },
          { id: 2, type: "file", path: denied },
        ] } },
      };
      assert.equal(await manager.saveState(JSON.stringify(state)), true);
      await store.flush();

      const reopened = new WindowSessionStore(path.join(root, "profile"));
      await reopened.initialize();
      const restored = new Window({ windowSessionStore: reopened }, { session: reopened.get(session.id) });
      const reader = new FileManager(restored, async () => {}, { handle() {} });
      assert.deepEqual(await reader.loadState(), state);
      assert.equal((await reader.initializeFile(target)).success, true);
      assert.deepEqual(await reader.getFileContent([target, denied]), { [target]: content });
      assert.equal((await reader.initializeFile(denied)).errorCode, "OUTSIDE_WORKSPACE");
      assert.equal(await reader.saveFile(path.join(root, "unapproved.js"), content), undefined);
      assert.equal(await reader.saveState(JSON.stringify(state)), true);
      assert.deepEqual(reopened.get(session.id).authorizedFiles, window.pathAccess.getAuthorizedFiles());
      const otherWindow = new Window({ windowSessionStore: reopened }, { session: reopened.get(other.id) });
      assert.equal(await otherWindow.pathAccess.isAuthorized(target), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test("restored file grants do not follow a replaced file symlink", {
  skip: process.platform === "win32",
}, async () => {
  const root = await tempRoot("nce-file-grant-link-");
  try {
    const target = path.join(root, "approved.txt");
    const denied = path.join(root, "denied.txt");
    await fs.writeFile(target, "approved");
    await fs.writeFile(denied, "denied");
    const access = new PathAccess(() => null);
    await access.authorizeFile(target);
    const grants = access.getAuthorizedFiles();
    await fs.unlink(target);
    await fs.symlink(denied, target);
    const restored = new PathAccess(() => null, process.platform, grants);
    assert.equal(await restored.isAuthorized(target), false);
    assert.equal(await restored.isAuthorized(denied), false);
    await fs.unlink(target);
    await fs.writeFile(target, "approved again");
    assert.equal(await restored.isAuthorized(target), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("NceWorkspaceStorage refuses a symlinked .nce directory", {
  skip: process.platform === "win32",
}, async () => {
  const root = await tempRoot("nce-storage-root-");
  const outside = await tempRoot("nce-storage-outside-");
  try {
    await fs.symlink(outside, path.join(root, ".nce"), "dir");
    const storage = new NceWorkspaceStorage(root);
    await assert.rejects(() => storage.ensureStructure(), /real directories/);
    assert.equal((await fs.readdir(outside)).length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("Watcher refuses a workspace that was not authorized", async () => {
  const root = await tempRoot("nce-watcher-deny-");
  try {
    const { Watcher } = loadMain("dist/ts/addon/Watcher.js", {
      electron: { BrowserWindow: class {}, ipcMain: { handle() {} } },
    });
    const watcher = new Watcher({}, { handle() {} }, {
      isWorkspaceAllowed: async () => false,
    });
    await assert.rejects(
      () => watcher.startWatching(root),
      (error) => error.code === "WORKSPACE_NOT_AUTHORIZED",
    );
    assert.equal(watcher.getWatchedPath(), "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("WorkspaceSearch rejects a root other than the active workspace", async () => {
  const active = await tempRoot("nce-search-active-");
  const other = await tempRoot("nce-search-other-");
  const handlers = new Map();
  try {
    const search = new WorkspaceSearch({
      watcher: { getWatchedPath: () => active },
    }, { handle: (channel, handler) => handlers.set(channel, handler) });
    let storagePrepared = false;
    search.ensureWorkspaceStorage = async () => { storagePrepared = true; };
    search.handleIPC();
    const result = await handlers.get("WorkspaceSearch:search")(
      {},
      other,
      "needle",
      {},
    );
    assert.equal(storagePrepared, false);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
      results: [],
      totalMatches: 0,
      filesSearched: 0,
      offset: 0,
      limit: 50,
      hasMore: false,
    });
  } finally {
    await fs.rm(active, { recursive: true, force: true });
    await fs.rm(other, { recursive: true, force: true });
  }
});
