const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { loadMain } = require("./helpers/main-runtime");

test("IPC router installs one Electron handler and routes by the real sender", async () => {
  const installed = new Map();
  const removals = [];
  const ipcMain = {
    handle(channel, listener) {
      assert.equal(installed.has(channel), false);
      installed.set(channel, listener);
    },
    removeHandler(channel) { removals.push(channel); installed.delete(channel); },
  };
  const { IpcRouter } = loadMain("dist/ts/manager/IpcRouter.js", {
    electron: { ipcMain },
  });
  const router = new IpcRouter(ipcMain);
  const a = { isDestroyed: () => false };
  const b = { isDestroyed: () => false };
  const unknown = { isDestroyed: () => false };
  const calls = [];
  router.forWindow("runtime-a").handle("FileManager:saveFile", (_event, value) => {
    calls.push(["a", value]);
    return "saved-a";
  });
  router.forWindow("runtime-b").handle("FileManager:saveFile", (_event, value) => {
    calls.push(["b", value]);
    return "saved-b";
  });
  router.attachWindow("runtime-a", a);
  router.attachWindow("runtime-b", b);

  const handler = installed.get("FileManager:saveFile");
  assert.equal(installed.size, 1);
  assert.equal(await handler({ sender: a }, "one"), "saved-a");
  assert.equal(await handler({ sender: b }, "two"), "saved-b");
  assert.equal(await handler({ sender: unknown }, "spoofed", "runtime-a"), undefined);
  assert.deepEqual(calls, [["a", "one"], ["b", "two"]]);

  router.detachWindow("runtime-a", a);
  assert.equal(await handler({ sender: a }, "late"), undefined);
  const destroyed = { isDestroyed: () => true };
  router.attachWindow("runtime-b", destroyed);
  assert.equal(await handler({ sender: destroyed }, "late"), undefined);
  router.dispose();
  assert.deepEqual(removals, ["FileManager:saveFile"]);
});

test("window sessions migrate state.json once and serialize independent window state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-window-state-"));
  try {
    const legacy = {
      version: 2,
      lastWorkspace: path.join(root, "legacy-project"),
      noWorkspaceState: { tabManager: { tabs: [] } },
      agent: { apiKeys: { provider: "secret" }, hiddenModels: [] },
    };
    await fs.writeFile(path.join(root, "state.json"), JSON.stringify(legacy));
    const { WindowSessionStore } = loadMain("dist/ts/manager/WindowSessionStore.js");
    const store = new WindowSessionStore(root);
    const migrated = await store.initialize();
    assert.equal(migrated.length, 1);
    assert.equal(migrated[0].workspacePath, legacy.lastWorkspace);
    assert.equal(JSON.stringify(migrated[0].rendererState.noWorkspaceState), JSON.stringify(legacy.noWorkspaceState));
    assert.equal(migrated[0].rendererState.agent.apiKeys, undefined);

    const second = store.create({ rendererState: { version: 2, lastWorkspace: null } });
    const first = migrated[0];
    const firstState = { version: 2, lastWorkspace: null, noWorkspaceState: { tabManager: { tabs: ["a"] } } };
    const secondState = { version: 2, lastWorkspace: null, noWorkspaceState: { tabManager: { tabs: ["b"] } } };
    const results = await Promise.all([
      store.saveRendererState(first.id, JSON.stringify(firstState)),
      store.saveRendererState(second.id, JSON.stringify(secondState)),
    ]);
    assert.deepEqual(results, [true, true]);
    assert.equal(JSON.stringify(store.get(first.id).rendererState), JSON.stringify(firstState));
    assert.equal(JSON.stringify(store.get(second.id).rendererState), JSON.stringify(secondState));
    await store.flush();

    const reopened = new WindowSessionStore(root);
    const restored = await reopened.initialize();
    assert.equal(restored.length, 2);
    assert.equal(JSON.stringify(reopened.get(first.id).rendererState), JSON.stringify(firstState));
    assert.equal(JSON.stringify(reopened.get(second.id).rendererState), JSON.stringify(secondState));
    assert.equal(await fs.readFile(path.join(root, "state.json"), "utf8").then((text) => text.includes("secret")), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("WindowManager creates independent windows, focuses workspace duplicates, and cleans ownership", async () => {
  const instances = [];
  let failCreate = false;
  class FakeBrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.minimized = false;
      this.sender = { isDestroyed: () => this.destroyed, send() {} };
      instances.push(this);
    }
    get webContents() {
      if (this.destroyed) throw new TypeError("Object has been destroyed");
      return this.sender;
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    show() {}
    focus() { FakeBrowserWindow.focused = this; this.emit("focus"); }
    getBounds() { return { x: 10, y: 10, width: 1100, height: 720 }; }
    getNormalBounds() { return this.getBounds(); }
    isMaximized() { return false; }
    destroy() { this.destroyed = true; this.emit("closed"); }
    close() { this.destroy(); }
  }
  FakeBrowserWindow.getFocusedWindow = () => FakeBrowserWindow.focused || null;

  class FakeSessionStore {
    records = new Map();
    create(input = {}) {
      const session = { id: `session-${this.records.size}`, workspacePath: null, bounds: null,
        maximized: false, rendererState: null, lastActiveAt: Date.now(), ...input };
      this.records.set(session.id, session);
      return session;
    }
    getAll() { return [...this.records.values()]; }
    getLastActiveSessionId() { return this.getAll().at(-1)?.id || null; }
    update(id, patch) { const current = this.records.get(id); if (!current) return false; Object.assign(current, patch); return true; }
    markActive(id) { this.update(id, { lastActiveAt: Date.now() }); }
    remove(id) { return this.records.delete(id); }
    flush() { return Promise.resolve(true); }
  }
  class FakeWindow {
    constructor(app, options) {
      this.app = app;
      this.id = options.id;
      this.sessionId = options.session.id;
      this.workspacePath = options.session.workspacePath;
      this.focusWhenReady = options.focusWhenReady;
      this.appMenu = { activate() {}, deactivate() {} };
      this.forceQuit = false;
      this.window = null;
    }
    create() {
      if (failCreate) { failCreate = false; throw new Error("create failed"); }
      this.window = new FakeBrowserWindow();
      this.app.windowManager.registerBrowserWindow(this, this.window);
    }
    setWorkspacePath(value) { this.workspacePath = value; }
    requestQuit() { return Promise.resolve(true); }
    dispose() {}
  }

  const { WindowManager } = loadMain("dist/ts/manager/WindowManager.js", {
    electron: {
      BrowserWindow: FakeBrowserWindow,
      dialog: { showMessageBox: async () => ({ response: 0 }) },
      screen: {
        getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
        getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1440, height: 900 } }],
      },
    },
    "../Window": { Window: FakeWindow },
    "../addon/Menu": { AppMenu: { installWindowlessMenu() {} } },
  });
  const sessions = new FakeSessionStore();
  const app = { isQuitting: false };
  const router = { forWindow: () => ({}), attachWindow() {}, detachWindow() {} };
  const manager = new WindowManager(app, router, sessions);
  app.windowManager = manager;

  const a = manager.createEmptyWindow();
  const b = manager.createEmptyWindow();
  assert.ok(a && b);
  assert.notEqual(a.id, b.id);
  assert.equal(manager.getAllWindows().length, 2);
  assert.equal(manager.getWindowByWebContents(a.window.webContents), a);
  assert.equal(manager.focusWindow(b.id), true);
  assert.equal(manager.getFocusedWindow(), b);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-workspace-reservation-"));
  try {
    const outcomes = await Promise.all([
      manager.reserveWorkspace(a.id, `${root}${path.sep}`),
      manager.reserveWorkspace(b.id, root),
    ]);
    assert.equal(outcomes.filter((result) => result.success).length, 1);
    assert.equal(manager.findWindowByWorkspace(root)?.id, outcomes[0].success ? a.id : b.id);
    const count = manager.getAllWindows().length;
    assert.equal(await manager.openWorkspaceInNewWindow(root), true);
    assert.equal(manager.getAllWindows().length, count);

    const other = manager.getAllWindows().find((window) => window.id !== manager.findWindowByWorkspace(root).id);
    const otherBrowserWindow = other.window;
    const otherSender = otherBrowserWindow.webContents;
    otherBrowserWindow.destroy();
    assert.equal(manager.getAllWindows().length, 1);
    assert.equal(manager.getWindowByWebContents(otherSender), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  failCreate = true;
  assert.equal(manager.createEmptyWindow(), null);
  assert.equal(manager.getAllWindows().length, 1);
  for (let index = 0; index < 7; index++) assert.ok(manager.createEmptyWindow());
  assert.equal(manager.getAllWindows().length, 8);
  assert.equal(manager.createEmptyWindow(), null);
});
