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
      append() {}
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
  assert.notEqual(exercise("darwin")[0], null);
  assert.equal(exercise("win32")[0], null);
  assert.equal(exercise("linux")[0], null);
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

test("watcher batches events, ignores own save and cleans up timers", async () => {
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
    },
    {
      setTimeout: (fn, delay) => {
        assert.equal(delay, 150);
        timer = fn;
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
  watcher.ignoreNextChange("/temporary/saved");
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
  const result = await manager.renameEntry(oldPath, "/project/controller.js");
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
    assert.equal(await manager.loadState(), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
