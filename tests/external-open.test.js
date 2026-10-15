const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { loadMain } = require("./helpers/main-runtime");
const { ExternalOpenCoordinator, MAX_EXTERNAL_OPEN_PATHS } = require("../dist/ts/manager/ExternalOpenCoordinator.js");

function makeWindow(id, { deliver } = {}) {
  const state = { destroyed: false, deliveries: [], notices: [] };
  const window = {
    id,
    state,
    window: {
      isDestroyed: () => state.destroyed,
      webContents: { isDestroyed: () => state.destroyed },
    },
    async deliverExternalFiles(paths) {
      state.deliveries.push([...paths]);
      if (deliver) return deliver(paths, state);
      return { openedPaths: [...paths], failures: [] };
    },
    notifyExternalOpenResult(result) { state.notices.push(result); },
  };
  return window;
}

function makeWindowManager(windows = [], { limit = 8 } = {}) {
  const byId = new Map(windows.map((window) => [window.id, window]));
  let activeId = windows[0]?.id || null;
  const openedFolders = [];
  const focusedIds = [];
  const manager = {
    windows: byId,
    openedFolders,
    focusedIds,
    getFocusedWindow: () => byId.get(activeId) || null,
    getAllWindows: () => [...byId.values()],
    focusWindow(id) {
      if (!byId.has(id)) return false;
      activeId = id;
      focusedIds.push(id);
      return true;
    },
    createEmptyWindow() {
      if (byId.size >= limit) return null;
      const window = makeWindow(`created-${byId.size}`);
      byId.set(window.id, window);
      activeId = window.id;
      return window;
    },
    async openWorkspaceInNewWindow(folderPath) {
      openedFolders.push(folderPath);
      const existing = [...byId.values()].find((window) => window.workspacePath === folderPath);
      if (existing) {
        activeId = existing.id;
        return true;
      }
      if (byId.size >= limit) return false;
      const window = makeWindow(`folder-${byId.size}`);
      window.workspacePath = folderPath;
      byId.set(window.id, window);
      activeId = window.id;
      return true;
    },
  };
  return manager;
}

async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-external-open-é-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "fichier avec espaces - 東京.js");
  const folder = path.join(root, "Projet été");
  await fs.writeFile(file, "const opened = true;\n", "utf8");
  await fs.mkdir(folder);
  return { root, file, folder };
}

test("native drop routes files to its captured WebContents window and folders through the workspace manager", async (t) => {
  const { file, folder, root } = await makeFixture(t);
  const windowA = makeWindow("a");
  const windowB = makeWindow("b");
  const windowC = makeWindow("c");
  const manager = makeWindowManager([windowA, windowB, windowC]);
  manager.focusWindow(windowC.id);
  const coordinator = new ExternalOpenCoordinator(manager);
  coordinator.start();
  const secondFile = path.join(root, "second file.js");
  await fs.writeFile(secondFile, "const second = true;\n", "utf8");

  const result = await coordinator.enqueueDrop([
    file,
    secondFile,
    file,
    folder,
    path.join(root, "removed.js"),
    "relative.js",
  ], windowB);

  assert.equal(result.openedFiles, 2, "unique files open once while duplicate paths are ignored");
  assert.equal(result.openedFolders, 1);
  assert.equal(result.failures.length, 2, "a missing path and relative drop path fail independently");
  assert.deepEqual(windowA.state.deliveries, []);
  assert.deepEqual(windowB.state.deliveries, [[await fs.realpath(file), await fs.realpath(secondFile)]]);
  assert.deepEqual(windowC.state.deliveries, []);
  assert.deepEqual(manager.openedFolders, [await fs.realpath(folder)]);
  assert.ok(manager.focusedIds.includes(windowB.id), "the receiver was focused for the file open before folder windows were opened");
  coordinator.dispose();
});

test("system opens wait for restore, choose the focused window once, and process batches in order", async (t) => {
  const { root } = await makeFixture(t);
  const first = path.join(root, "first.txt");
  const second = path.join(root, "second.txt");
  await Promise.all([fs.writeFile(first, "first"), fs.writeFile(second, "second")]);
  const firstWindow = makeWindow("first-window");
  const focusedWindow = makeWindow("focused-window");
  const manager = makeWindowManager([firstWindow, focusedWindow]);
  manager.focusWindow(focusedWindow.id);
  const coordinator = new ExternalOpenCoordinator(manager);

  let settled = false;
  const firstRequest = coordinator.enqueueSystemPaths([first], root).then((result) => {
    settled = true;
    return result;
  });
  const secondRequest = coordinator.enqueueSystemPaths([second], root);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false, "no external path is delivered before the restore barrier opens");
  coordinator.start();

  assert.equal((await firstRequest).openedFiles, 1);
  assert.equal((await secondRequest).openedFiles, 1);
  assert.deepEqual(focusedWindow.state.deliveries, [[await fs.realpath(first)], [await fs.realpath(second)]]);
  assert.deepEqual(firstWindow.state.deliveries, []);
  coordinator.dispose();
});

test("system directory requests reuse an open workspace and respect the window limit", async (t) => {
  const { root, folder } = await makeFixture(t);
  const otherFolder = path.join(root, "autre-projet");
  await fs.mkdir(otherFolder);
  const existing = makeWindow("existing");
  existing.workspacePath = await fs.realpath(folder);
  const manager = makeWindowManager([existing]);
  const coordinator = new ExternalOpenCoordinator(manager);
  coordinator.start();

  const result = await coordinator.enqueueSystemPaths([folder, otherFolder, otherFolder]);
  assert.equal(result.openedFolders, 2);
  assert.equal(result.failures.length, 0);
  assert.equal(manager.getAllWindows().length, 2, "duplicate folder input opens only one new workspace window");
  assert.deepEqual(manager.openedFolders, [await fs.realpath(folder), await fs.realpath(otherFolder)]);

  const limitedManager = makeWindowManager(
    Array.from({ length: 8 }, (_, index) => makeWindow(`limit-${index}`)),
  );
  const limitedCoordinator = new ExternalOpenCoordinator(limitedManager);
  limitedCoordinator.start();
  const limited = await limitedCoordinator.enqueueSystemPaths([otherFolder]);
  assert.equal(limited.openedFolders, 0);
  assert.equal(limited.failures[0].code, "FOLDER_OPEN_FAILED");
  assert.equal(limitedManager.getAllWindows().length, 8);
  coordinator.dispose();
  limitedCoordinator.dispose();
});

test("a captured drop target that closes while queued is never rerouted to another window", async (t) => {
  const { file } = await makeFixture(t);
  const target = makeWindow("drop-target");
  const other = makeWindow("other");
  const manager = makeWindowManager([target, other]);
  manager.focusWindow(other.id);
  const coordinator = new ExternalOpenCoordinator(manager);
  const request = coordinator.enqueueDrop([file], target);
  target.state.destroyed = true;
  coordinator.start();

  const result = await request;
  assert.equal(result.openedFiles, 0);
  assert.equal(result.failures[0].code, "WINDOW_UNAVAILABLE");
  assert.deepEqual(other.state.deliveries, []);
  coordinator.dispose();
});

test("invalid arguments and oversized batches fail without opening a window", async (t) => {
  const { root } = await makeFixture(t);
  const manager = makeWindowManager();
  const coordinator = new ExternalOpenCoordinator(manager);
  coordinator.start();
  const invalid = await coordinator.enqueueSystemPaths(["", "https://example.test/file", path.join(root, "missing")]);
  assert.equal(invalid.openedFiles, 0);
  assert.equal(invalid.failures.length, 3);
  assert.equal(manager.getAllWindows()[0].state.notices.length, 1,
    "all-invalid system opens create/focus one window and report the failures");
  const oversized = await coordinator.enqueueSystemPaths(Array(MAX_EXTERNAL_OPEN_PATHS + 1).fill(path.join(root, "missing")));
  assert.equal(oversized.failures[0].code, "TOO_MANY_PATHS");
  coordinator.dispose();
});

test("App captures macOS open-file before the lock and queues startup and second-instance paths", async (t) => {
  const { root, file, folder } = await makeFixture(t);
  const startupFile = path.join(root, "startup file.js");
  const startupUriFile = path.join(root, "fichier URI été.js");
  const secondFile = path.join(root, "second instance.js");
  await Promise.all([
    fs.writeFile(startupFile, "startup"),
    fs.writeFile(startupUriFile, "startup URI"),
    fs.writeFile(secondFile, "second"),
  ]);
  const app = new EventEmitter();
  app.isPackaged = true;
  app.getAppPath = () => root;
  app.getPath = () => path.join(root, "profile");
  app.getVersion = () => "test";
  app.quit = () => {};
  const calls = [];
  let lockOpenFilePrevented = false;
  app.requestSingleInstanceLock = () => {
    assert.equal(app.listenerCount("open-file"), 1, "macOS listener is registered before requesting the lock");
    app.emit("open-file", { preventDefault() { lockOpenFilePrevented = true; } }, file);
    return true;
  };

  class FakeExternalOpenCoordinator {
    constructor() { this.requests = []; }
    enqueueSystemPaths(paths, cwd) {
      this.requests.push({ paths: [...paths], cwd });
      calls.push(["enqueue", [...paths], cwd]);
      return Promise.resolve({ success: true, openedFiles: 0, openedFolders: 0, failures: [] });
    }
    enqueueDrop() { throw new Error("not expected in this App test"); }
    start() { calls.push(["start"]); }
    dispose() {}
  }
  class FakeWindowManager {
    constructor() { this.windows = []; }
    async restoreSessions() { calls.push(["restore"]); }
    getAllWindows() { return this.windows; }
    getFocusedWindow() { return null; }
    createEmptyWindow() { calls.push(["create-empty"]); }
    dispose() {}
  }
  class FakeIpcRouter { dispose() {} }
  class FakeSessionStore { async initialize() {} }
  class FakeManager { async initialize() {} async flush() { return true; } }
  class FakeNshServer { async start() { return 1234; } async stop() {} getPort() { return 1234; } }
  const mockProcess = {
    platform: process.platform,
    isPackaged: true,
    execPath: "/fake/NCE",
    env: {},
    cwd: () => root,
    argv: ["/fake/NCE", startupFile, "--user-data-dir", root, "--enable-logging", folder, pathToFileURL(startupUriFile).href, "https://example.test/file"],
  };
  const { App } = loadMain("dist/ts/App.js", {
    electron: { app, BrowserWindow: { getFocusedWindow: () => null }, dialog: {} },
    "./Window": { Window: class {} },
    "nsh/server": { NSHServer: FakeNshServer },
    "./manager/IpcRouter": { IpcRouter: FakeIpcRouter },
    "./manager/WindowManager": { WindowManager: FakeWindowManager },
    "./manager/WindowSessionStore": { WindowSessionStore: FakeSessionStore },
    "./manager/SettingsManager": { SettingsManager: FakeManager },
    "./manager/RecentFoldersManager": { RecentFoldersManager: FakeManager },
    "./manager/AgentConversationStore": { AgentConversationStore: FakeManager },
    "./manager/AgentSecretStore": { AgentSecretStore: FakeManager },
    "./manager/ExternalOpenCoordinator": { ExternalOpenCoordinator: FakeExternalOpenCoordinator },
  }, { process: mockProcess });

  const runtime = new App();
  assert.equal(lockOpenFilePrevented, true);
  assert.deepEqual(runtime.externalOpenCoordinator.requests.slice(0, 2), [
    { paths: [startupFile, folder, startupUriFile], cwd: root },
    { paths: [file], cwd: root },
  ], "startup flags and their values are filtered while early document opens are retained");

  app.emit("open-file", { preventDefault() {} }, secondFile);
  assert.deepEqual(runtime.externalOpenCoordinator.requests[2], {
    paths: [secondFile], cwd: root,
  }, "additional macOS document events are queued while NCE is already running");

  app.emit("ready");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.findIndex(([step]) => step === "start") > calls.findIndex(([step]) => step === "restore"),
    "external path delivery starts after session restoration");

  const secondWorkingDirectory = path.join(root, "working directory");
  const secondFolder = path.join(root, "second folder");
  await fs.mkdir(secondWorkingDirectory);
  await fs.mkdir(secondFolder);
  app.emit("second-instance", {}, ["/fake/NCE", secondFile, "--enable-logging", secondFolder], secondWorkingDirectory);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runtime.externalOpenCoordinator.requests.at(-1), {
    paths: [secondFile, secondFolder],
    cwd: secondWorkingDirectory,
  });

  app.isPackaged = false;
  app.emit("second-instance", {}, ["/fake/Electron", "/project/dist/main.js", secondFile], secondWorkingDirectory);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runtime.externalOpenCoordinator.requests.at(-1), {
    paths: [secondFile],
    cwd: secondWorkingDirectory,
  }, "development second-instance requests omit the Electron entry script");
});
