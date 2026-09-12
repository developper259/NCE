const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { loadMain } = require("./helpers/main-runtime");

test("window chrome is integrated without forced fullscreen on every platform", () => {
  const { getWindowChromeConfig } = loadMain("dist/ts/Window.js", {
    electron: {},
    "./addon/FileManager": { FileManager: class {} },
    "./addon/Watcher": { Watcher: class {} },
    "./addon/Menu": { AppMenu: class {} },
    "./addon/ContextMenu": { ContextMenu: class {} },
    "./addon/WorkspaceSearch": { WorkspaceSearch: class {} },
    "./App": { App: class {} },
  });
  const mac = getWindowChromeConfig("darwin");
  const windows = getWindowChromeConfig("win32");
  const linux = getWindowChromeConfig("linux");
  assert.equal(mac.titleBarStyle, "hiddenInset");
  assert.equal(mac.titleBarOverlay, undefined);
  assert.equal(windows.titleBarStyle, "hidden");
  assert.equal(windows.titleBarOverlay.height, 35);
  assert.equal(linux.titleBarStyle, "hidden");
  assert.equal(linux.titleBarOverlay.height, 35);
  assert.equal("fullscreen" in windows, false);
});

test("native application menu is kept only on macOS", () => {
  function exercise(platform) {
    const installed = [];
    class Menu {
      constructor() { this.items = []; }
      append(item) { this.items.push(item); }
      static setApplicationMenu(value) {
        installed.push(value);
      }
    }
    class MenuItem {
      constructor(options) {
        Object.assign(this, options);
      }
    }
    const { AppMenu } = loadMain(
      "dist/ts/addon/Menu.js",
      {
        electron: { Menu, MenuItem, dialog: {} },
      },
      { process: { platform } },
    );
    new AppMenu({ webContents: {} }, { app: {} });
    return installed;
  }
  const macMenu = exercise("darwin")[0];
  assert.notEqual(macMenu, null);
  const macLabels = macMenu.items.flatMap((item) =>
    [item.label, ...(item.submenu ?? []).map((child) => child.label)],
  );
  assert.equal(macLabels.includes("Reload Window"), false);
  assert.equal(macLabels.includes("Toggle Developer Tools"), false);
  assert.equal(exercise("win32")[0], null);
  assert.equal(exercise("linux")[0], null);
});

test("window commands reject DevTools while reload, fullscreen and About remain available", async () => {
  const { Window } = loadMain("dist/ts/Window.js", {
    electron: {},
    "./addon/FileManager": { FileManager: class {} },
    "./addon/Watcher": { Watcher: class {} },
    "./addon/Menu": { AppMenu: class {} },
    "./addon/ContextMenu": { ContextMenu: class {} },
    "./addon/WorkspaceSearch": { WorkspaceSearch: class {} },
    "./App": { App: class {} },
  });
  let fullscreen = false;
  let aboutCalls = 0;
  let reloadCalls = 0;
  const win = new Window({});
  win.window = {
    isFullScreen: () => fullscreen,
    setFullScreen: (value) => { fullscreen = value; },
    webContents: { reload: () => { reloadCalls++; } },
  };
  win.appMenu = { showAbout: async () => { aboutCalls++; } };

  assert.equal(await win.executeWindowCommand("view.devtools"), false);
  assert.equal(await win.executeWindowCommand("view.fullscreen"), true);
  assert.equal(fullscreen, true);
  assert.equal(await win.executeWindowCommand("view.reload"), true);
  assert.equal(reloadCalls, 1);
  assert.equal(await win.executeWindowCommand("help.about"), true);
  assert.equal(aboutCalls, 1);
});

test("native macOS File menu exposes an IPC-backed Auto Save checkbox", () => {
  const sent = [];
  class Menu {
    constructor() { this.items = []; }
    append(item) { this.items.push(item); }
    getMenuItemById(id) {
      for (const top of this.items) {
        const match = top.submenu?.find?.((item) => item.id === id);
        if (match) return match;
      }
      return null;
    }
    static setApplicationMenu() {}
  }
  class MenuItem { constructor(options) { Object.assign(this, options); } }
  const { AppMenu } = loadMain("dist/ts/addon/Menu.js", {
    electron: { Menu, MenuItem, dialog: {} },
  }, { process: { platform: "darwin" } });
  const menu = new AppMenu(
    { webContents: { send: (...args) => sent.push(args) } },
    { app: { settings: { get: () => true } } },
  );
  assert.equal(menu.autoSaveItem.type, "checkbox");
  assert.equal(menu.autoSaveItem.checked, true);
  menu.setAutoSaveState(false);
  assert.equal(menu.autoSaveItem.checked, false);
  menu.autoSaveItem.click();
  assert.deepEqual(sent, [["auto-save-toggle-requested"]]);
});

for (const mode of [
  "not-ready",
  "destroyed",
  "timeout-cancel",
  "timeout-force",
  "approve",
  "cancel",
]) {
  test(`main quit handshake: ${mode}`, async () => {
    let timer,
      closed = 0,
      sent = 0;
    const { Window } = loadMain(
      "dist/ts/Window.js",
      {
        electron: {
          dialog: {
            showMessageBox: async () => ({
              response: mode === "timeout-force" ? 0 : 1,
            }),
          },
        },
      },
      {
        setTimeout: (cb) => {
          timer = cb;
          return 1;
        },
        clearTimeout() {},
      },
    );
    const win = new Window({});
    win.rendererReady = mode !== "not-ready";
    win.window = {
      close: () => closed++,
      webContents: {
        isDestroyed: () => mode === "destroyed",
        send: () => sent++,
      },
    };
    assert.equal(win.requestQuit(), true);
    if (["not-ready", "destroyed"].includes(mode)) {
      assert.equal(closed, 1);
      assert.equal(sent, 0);
      return;
    }
    assert.equal(win.requestQuit(), false);
    assert.equal(sent, 1);
    if (mode.startsWith("timeout")) {
      timer();
      await new Promise((r) => setImmediate(r));
      assert.equal(closed, mode === "timeout-force" ? 1 : 0);
    } else {
      win.clearQuitTimer();
      assert.equal(win.quitState, "idle");
    }
  });
}

test("before-quit does not stop NSH until renderer approves; shutdown runs once", async () => {
  const app = new EventEmitter();
  app.getVersion = () => "test";
  app.requestSingleInstanceLock = () => true;
  let stopped = 0,
    requests = 0,
    quits = 0;
  app.quit = () => {
    quits++;
    app.emit("before-quit", { preventDefault() {} });
  };
  const { App } = loadMain("dist/ts/App.js", {
    electron: { app },
    "./Window": {
      Window: class {
        constructor() {
          this.window = {};
          this.forceQuit = false;
        }
        requestQuit() {
          requests++;
        }
      },
    },
    "nsh/server": {
      NSHServer: class {
        getPort() {
          return 1;
        }
        async stop() {
          stopped++;
        }
      },
    },
  });
  const nce = new App();
  app.emit("before-quit", { preventDefault() {} });
  assert.equal(requests, 1);
  assert.equal(stopped, 0);
  nce.window.forceQuit = true;
  app.emit("before-quit", { preventDefault() {} });
  await new Promise((r) => setImmediate(r));
  assert.equal(stopped, 1);
  assert.equal(quits, 1);
});

test("watcher batches events, matches one committed own save and cleans up timers", async () => {
  const source = new EventEmitter();
  let closed = 0;
  source.close = async () => closed++;
  let timer,
    cancelled = 0;
  const sent = [],
    invalidated = [];
  const { Watcher } = loadMain(
    "dist/ts/addon/Watcher.js",
    {
      electron: {},
      chokidar: { watch: () => source },
      "node:fs/promises": { stat: async () => ({ isDirectory: () => true }) },
      "node:fs": { statSync: () => ({ dev: 1, ino: 2, size: 3, mtimeMs: 4 }) },
    },
    {
      setTimeout: (fn, delay) => {
        assert.ok(delay === 150 || delay === 5000);
        if (delay === 150) timer = fn;
        return 1;
      },
      clearTimeout: () => cancelled++,
    },
  );
  const watcher = new Watcher({
    webContents: { send: (...args) => sent.push(args) },
  });
  watcher.onChange = (p) => invalidated.push(p);
  await watcher.startWatching("/temporary");
  source.emit("all", "add", "/temporary/a");
  source.emit("all", "change", "/temporary/a");
  source.emit("all", "unlink", "/temporary/b");
  const token = watcher.beginOwnWrite("/temporary/saved");
  watcher.commitOwnWrite("/temporary/saved", token);
  source.emit("all", "change", "/temporary/saved");
  timer();
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1].length, 2);
  assert.equal(invalidated.length, 4);
  source.emit("all", "change", "/temporary/saved");
  timer();
  assert.equal(sent.length, 2);
  await watcher.stopWatching();
  assert.equal(closed, 1);
  assert.equal(watcher.isWatching(), false);
  assert.ok(cancelled);
});

test("watcher ignore rules are shared, explicit, and preserve workspace dotfiles", () => {
  const { isWatcherPathIgnored } = require("../dist/ts/addon/WatcherIgnore.js");
  for (const directory of ["node_modules", "dist", "build", "out", "coverage", ".next", ".cache", ".turbo", "release", ".git", ".svn", ".hg"])
    assert.equal(isWatcherPathIgnored(path.join("workspace", directory, "file.js")), true, directory);
  assert.equal(isWatcherPathIgnored(path.join("workspace", "broken.asar")), true);
  assert.equal(isWatcherPathIgnored(path.join("workspace", ".env")), false);
  assert.equal(isWatcherPathIgnored(path.join("workspace", ".vscode", "settings.json")), false);
  assert.equal(isWatcherPathIgnored(path.join("workspace", "normal.js")), false);
});

test("failed, expired, and concurrent own writes cannot hide a later external change", () => {
  let signature = { dev: 1, ino: 1, size: 10, mtimeMs: 10 };
  const { Watcher } = loadMain("dist/ts/addon/Watcher.js", {
    electron: {}, chokidar: {},
    "node:fs": { statSync: () => signature },
    "node:fs/promises": {},
  });
  const watcher = new Watcher({ webContents: { send() {} } });
  const failed = watcher.beginOwnWrite("/file");
  watcher.cancelOwnWrite("/file", failed);
  assert.equal(watcher.consumeOwnWrite("/file"), false);

  const expired = watcher.beginOwnWrite("/file");
  watcher.commitOwnWrite("/file", expired);
  watcher.ownWrites.get(path.normalize("/file"))[0].expiresAt = 0;
  assert.equal(watcher.consumeOwnWrite("/file"), false);

  const first = watcher.beginOwnWrite("/file");
  watcher.commitOwnWrite("/file", first);
  signature = { ...signature, size: 20, mtimeMs: 20 };
  const second = watcher.beginOwnWrite("/file");
  watcher.commitOwnWrite("/file", second);
  assert.equal(watcher.consumeOwnWrite("/file"), true);
  signature = { ...signature, size: 21, mtimeMs: 21 };
  assert.equal(watcher.consumeOwnWrite("/file"), false);
});

test("watcher stops and reports a deleted workspace root exactly once", async () => {
  const source = new EventEmitter();
  let closed = 0;
  source.close = async () => closed++;
  const sent = [];
  const { Watcher } = loadMain("dist/ts/addon/Watcher.js", {
    electron: {},
    chokidar: { watch: () => source },
    "node:fs/promises": { stat: async () => ({ isDirectory: () => true }) },
  });
  const watcher = new Watcher({
    webContents: { send: (...args) => sent.push(args) },
  });
  await watcher.startWatching("/temporary");
  source.emit("all", "unlinkDir", "/temporary");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, 1);
  assert.equal(watcher.isWatching(), false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1][0].event, "root-deleted");
  await watcher.startWatching("/new-workspace");
  assert.equal(watcher.isWatching(), true);
  assert.equal(watcher.getWatchedPath(), "/new-workspace");
  await watcher.stopWatching();
  assert.equal(closed, 2);
});

test("watcher falls back once for recoverable native errors and stays native for a new workspace", async () => {
  const sources = [];
  const options = [];
  const warnings = [];
  const errors = [];
  class FakePollingWatcher extends EventEmitter {
    constructor() { super(); sources.push(this); options.push({ usePolling: true }); }
    async close() {}
  }
  const { Watcher } = loadMain("dist/ts/addon/Watcher.js", {
    electron: {},
    chokidar: { watch: (_path, config) => {
      const source = new EventEmitter();
      source.close = async () => {};
      sources.push(source);
      options.push(config);
      return source;
    } },
    "./WatcherPolling": { PollingWatcher: FakePollingWatcher },
    "node:fs/promises": { stat: async () => ({ isDirectory: () => true }) },
  }, { console: { warn: (...args) => warnings.push(args), error: (...args) => errors.push(args) } });
  const watcher = new Watcher({ webContents: { send() {} } });
  const changed = [];
  watcher.onChange = (filePath) => changed.push(filePath);

  await watcher.startWatching("/temporary");
  assert.equal(options[0].usePolling, false);
  sources[0].emit("error", { code: "UNKNOWN" });
  sources[0].emit("error", { code: "EPERM" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sources.length, 2);
  assert.equal(options[1].usePolling, true);
  assert.equal(warnings.length, 1);
  for (let index = 0; index < 3; index++) {
    sources[1].emit("error", new Error("Invalid package C:\\temporary\\foo.asar"));
  }
  sources[1].emit("all", "change", "/temporary/normal.js");
  assert.deepEqual(changed, ["/temporary/normal.js"]);
  assert.equal(warnings.length, 2);
  sources[1].emit("error", { code: "EBUSY" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sources.length, 2);

  sources[1].emit("error", { code: "EIO" });
  assert.equal(errors.length, 1);
  await watcher.startWatching("/new-workspace");
  assert.equal(options[2].usePolling, false);
  await watcher.stopWatching();
});

test("polling ignores malformed ASAR files and continues reporting ordinary changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-polling-asar-"));
  const normal = path.join(root, "normal.js");
  const created = path.join(root, "new.js");
  const renamed = path.join(root, "test.js");
  const dotEnv = path.join(root, ".env");
  const ignoredDirectory = path.join(root, "node_modules");
  await fs.writeFile(normal, "const value = 1;\n");
  await fs.writeFile(path.join(root, "foo.asar"), Buffer.from([1, 2, 3, 4, 5]));
  await fs.writeFile(path.join(root, "FOO.ASAR"), Buffer.from([6, 7, 8]));
  await fs.mkdir(ignoredDirectory);
  const { PollingWatcher } = require("../dist/ts/addon/WatcherPolling.js");
  const watcher = new PollingWatcher(root);
  const events = [];
  watcher.on("all", (event, filePath) => events.push([event, filePath]));
  const waitForEvent = async (predicate) => {
    const deadline = Date.now() + 4000;
    while (!events.some(predicate) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(events.some(predicate));
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("polling watcher was not ready")), 5000);
      watcher.once("ready", () => { clearTimeout(timer); resolve(); });
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await fs.writeFile(normal, "const value = 22222;\n");
    await waitForEvent(([event, filePath]) => event === "change" && filePath === normal);
    await fs.writeFile(created, "export {};\n");
    await waitForEvent(([event, filePath]) => event === "add" && filePath === created);
    await fs.rename(normal, renamed);
    await waitForEvent(([, filePath]) => filePath === renamed);
    await fs.unlink(created);
    await waitForEvent(([event, filePath]) => event === "unlink" && filePath === created);
    assert.equal(events.some(([, filePath]) => /\.asar(?:[\\/]|$)/i.test(filePath)), false);
    await fs.writeFile(dotEnv, "VISIBLE=1\n");
    await waitForEvent(([event, filePath]) => event === "add" && filePath === dotEnv);
    await fs.writeFile(path.join(ignoredDirectory, "ignored.js"), "ignored\n");
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(events.some(([, filePath]) => filePath.includes("node_modules")), false);
  } finally {
    await watcher.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("malformed ASAR watcher errors are warned once per normalized path", async () => {
  const native = new EventEmitter();
  native.close = async () => {};
  const warnings = [];
  let polling;
  class FakePollingWatcher extends EventEmitter {
    constructor() { super(); polling = this; }
    async close() {}
  }
  const { Watcher } = loadMain("dist/ts/addon/Watcher.js", {
    electron: {}, chokidar: { watch: () => native },
    "./WatcherPolling": { PollingWatcher: FakePollingWatcher },
    "node:fs/promises": { stat: async () => ({ isDirectory: () => true }) },
  }, { console: { warn: (...args) => warnings.push(args), error() {} } });
  const watcher = new Watcher({ webContents: { send() {} } });
  await watcher.startWatching("C:\\workspace");
  for (let index = 0; index < 3; index++) {
    native.emit("error", new Error("Invalid package C:\\workspace\\foo.asar"));
  }
  await new Promise((resolve) => setImmediate(resolve));
  for (let index = 0; index < 3; index++) {
    polling.emit("error", new Error("Invalid package C:\\workspace\\bar.ASAR"));
  }
  assert.equal(warnings.length, 2);
  assert.equal(watcher.isWatching(), true);
  await watcher.stopWatching();
});

test("stopping or deleting the root while fallback is pending cannot resurrect the watcher", async () => {
  let releaseClose;
  const sources = [];
  const { Watcher } = loadMain("dist/ts/addon/Watcher.js", {
    electron: {},
    chokidar: { watch: () => {
      const source = new EventEmitter();
      source.close = () => new Promise((resolve) => { releaseClose = resolve; });
      sources.push(source);
      return source;
    } },
    "node:fs/promises": { stat: async () => ({ isDirectory: () => true }) },
  }, { console: { warn() {}, error() {} } });
  const watcher = new Watcher({ webContents: { send() {} } });

  await watcher.startWatching("/temporary");
  sources[0].emit("error", { code: "UNKNOWN" });
  const stopping = watcher.stopWatching();
  releaseClose();
  await stopping;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sources.length, 1);
  assert.equal(watcher.isWatching(), false);

  await watcher.startWatching("/temporary");
  sources[1].close = async () => {};
  sources[1].emit("all", "unlinkDir", "/temporary");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sources.length, 2);
  assert.equal(watcher.isWatching(), false);
});

test("a pending fallback from workspace A cannot replace workspace B", async () => {
  let releaseClose;
  const nativeSources = [];
  class FakePollingWatcher extends EventEmitter { async close() {} }
  const { Watcher } = loadMain("dist/ts/addon/Watcher.js", {
    electron: {},
    chokidar: { watch: () => {
      const source = new EventEmitter();
      source.close = nativeSources.length === 0
        ? () => new Promise((resolve) => { releaseClose = resolve; })
        : async () => {};
      nativeSources.push(source);
      return source;
    } },
    "./WatcherPolling": { PollingWatcher: FakePollingWatcher },
    "node:fs/promises": { stat: async () => ({ isDirectory: () => true }) },
  }, { console: { warn() {}, error() {} } });
  const watcher = new Watcher({ webContents: { send() {} } });
  await watcher.startWatching("/workspace-a");
  nativeSources[0].emit("error", { code: "UNKNOWN" });
  await watcher.startWatching("/workspace-b");
  assert.equal(watcher.getWatchedPath(), "/workspace-b");
  releaseClose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nativeSources.length, 2);
  assert.equal(watcher.getWatchedPath(), "/workspace-b");
  await watcher.stopWatching();
});

test("case-only rename rolls its temporary path back when commit fails", async () => {
  const renames = [];
  const promises = {
    stat: async () => ({ dev: 1, ino: 2, isDirectory: () => false }),
    rename: async (from, to) => {
      renames.push([from, to]);
      if (renames.length === 2) {
        const error = Error("denied");
        error.code = "EACCES";
        throw error;
      }
    },
  };
  const { FileManager } = loadMain("dist/ts/addon/FileManager.js", {
    electron: {},
    fs: { promises, existsSync: () => true },
    crypto: { randomUUID: () => "unique-id" },
  });
  const manager = new FileManager({});
  const oldPath = "/project/Controller.js";
  const expectedTemporaryPath = path.join(
    path.dirname(path.resolve(oldPath)),
    `.${path.basename(path.resolve(oldPath))}.nce-rename-unique-id`,
  );
  const originalError = console.error; console.error = () => {};
  let result;
  try { result = await manager.renameEntry(oldPath, "/project/controller.js"); }
  finally { console.error = originalError; }
  assert.equal(result.code, "PERMISSION_DENIED");
  assert.equal(renames.length, 3);
  assert.deepEqual(renames[0], [oldPath, expectedTemporaryPath]);
  assert.deepEqual(renames[2], [expectedTemporaryPath, oldPath]);
});

test("API keys use encrypted storage and are removed from editor state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-secrets-"));
  let available = true;
  const safeStorage = {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(s).map((b) => b ^ 0xa5),
    decryptString: (b) =>
      Buffer.from(b)
        .map((b) => b ^ 0xa5)
        .toString(),
  };
  const { FileManager } = loadMain("dist/ts/addon/FileManager.js", {
    electron: { app: { getPath: () => root }, safeStorage },
  });
  const manager = new FileManager({});
  try {
    assert.equal(await manager.setAgentApiKey("mock", "secret-for-test"), true);
    assert.equal(await manager.getAgentApiKey("mock"), "secret-for-test");
    assert.ok(
      !(
        await fs.readFile(path.join(root, "agent-secrets.json"), "utf8")
      ).includes("secret-for-test"),
    );
    await manager.saveState(
      JSON.stringify({ agent: { apiKeys: { mock: "secret-for-test" } } }),
    );
    assert.ok(
      !(await fs.readFile(path.join(root, "state.json"), "utf8")).includes(
        "secret-for-test",
      ),
    );
    available = false;
    assert.equal(await manager.setAgentApiKey("mock", "new"), false);
    assert.equal(await manager.getAgentApiKey("mock"), "");
    await fs.writeFile(path.join(root, "state.json"), "{broken");
    const originalError = console.error; console.error = () => {};
    try { assert.equal(await manager.loadState(), null); }
    finally { console.error = originalError; }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
