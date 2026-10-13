const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { loadMain } = require("./helpers/main-runtime");

function makeSafeStorage({ available = true, backend = "os_crypt", failEncrypt = false } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString(value) {
      if (failEncrypt) throw new Error("encryption failed");
      return Buffer.from(`nce-encrypted:${value}`);
    },
    decryptString(value) {
      const decoded = Buffer.from(value).toString();
      if (!decoded.startsWith("nce-encrypted:")) throw new Error("invalid encrypted value");
      return decoded.slice("nce-encrypted:".length);
    },
  };
}

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
      agent: { apiKeys: { provider: "secret", second_provider: "second-secret" }, hiddenModels: [] },
    };
    await fs.writeFile(path.join(root, "state.json"), JSON.stringify(legacy));
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`encrypted:${value}`),
      decryptString: (value) => Buffer.from(value).toString().replace(/^encrypted:/, ""),
    };
    const { AgentSecretStore } = loadMain("dist/ts/manager/AgentSecretStore.js", {
      electron: { safeStorage },
    });
    const secrets = new AgentSecretStore(root, safeStorage);
    const { WindowSessionStore } = loadMain("dist/ts/manager/WindowSessionStore.js");
    const store = new WindowSessionStore(root, process.platform, secrets);
    const migrated = await store.initialize();
    assert.equal(migrated.length, 1);
    assert.equal(migrated[0].workspacePath, legacy.lastWorkspace);
    assert.equal(JSON.stringify(migrated[0].rendererState.noWorkspaceState), JSON.stringify(legacy.noWorkspaceState));
    assert.equal(migrated[0].rendererState.agent.apiKeys, undefined);
    assert.equal(await secrets.get("provider"), "secret");
    assert.equal(await secrets.get("second_provider"), "second-secret");
    assert.equal((await fs.readFile(path.join(root, "state.json"), "utf8")).includes("secret"), false);
    assert.equal((await fs.readFile(path.join(root, "window-sessions.json"), "utf8")).includes("secret"), false);

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

    const reopened = new WindowSessionStore(root, process.platform, secrets);
    const restored = await reopened.initialize();
    assert.equal(restored.length, 2);
    assert.equal(JSON.stringify(reopened.get(first.id).rendererState), JSON.stringify(firstState));
    assert.equal(JSON.stringify(reopened.get(second.id).rendererState), JSON.stringify(secondState));
    assert.equal(await fs.readFile(path.join(root, "state.json"), "utf8").then((text) => text.includes("secret")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("legacy credential migration is idempotent, preserves secure conflicts, and sanitizes old session files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-agent-key-migration-"));
  const safeStorage = makeSafeStorage();
  const { AgentSecretStore } = loadMain("dist/ts/manager/AgentSecretStore.js", {
    electron: { safeStorage },
  });
  const { WindowSessionStore } = loadMain("dist/ts/manager/WindowSessionStore.js");
  try {
    const secrets = new AgentSecretStore(root, safeStorage);
    assert.equal(await secrets.set("provider", "already-secure"), true);
    const legacy = {
      lastWorkspace: null,
      titleBar: { recent: ["kept"] },
      agent: { apiKeys: { provider: "legacy-conflict", second: "second-key" }, hiddenModels: ["m"] },
    };
    await fs.writeFile(path.join(root, "state.json"), JSON.stringify(legacy));
    let sessions = new WindowSessionStore(root, process.platform, secrets);
    const first = await sessions.initialize();
    assert.equal(await secrets.get("provider"), "already-secure", "existing encrypted values take precedence");
    assert.equal(await secrets.get("second"), "second-key");
    assert.equal(JSON.stringify(first[0].rendererState.titleBar), JSON.stringify(legacy.titleBar));
    assert.equal(JSON.stringify(first[0].rendererState.agent.hiddenModels), JSON.stringify(["m"]));
    assert.equal(first[0].rendererState.agent.apiKeys, undefined);
    assert.equal((await fs.readFile(path.join(root, "state.json"), "utf8")).includes("legacy-conflict"), false);
    assert.equal((await fs.readFile(path.join(root, "window-sessions.json"), "utf8")).includes("second-key"), false);

    sessions = new WindowSessionStore(root, process.platform, secrets);
    await sessions.initialize();
    assert.equal(await secrets.get("second"), "second-key", "restarting migration leaves credentials unchanged");

    const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nce-session-key-migration-"));
    try {
      await fs.writeFile(path.join(sessionRoot, "window-sessions.json"), JSON.stringify({
        version: 1,
        lastActiveSessionId: "session-a",
        sessions: [{
          id: "session-a", workspacePath: null, bounds: null, maximized: false,
          lastActiveAt: 1,
          rendererState: { agent: { apiKeys: { other: "session-legacy-key" }, hiddenModels: [] }, untouched: true },
        }],
      }));
      const sessionSecrets = new AgentSecretStore(sessionRoot, safeStorage);
      const fromSession = new WindowSessionStore(sessionRoot, process.platform, sessionSecrets);
      const restored = await fromSession.initialize();
      assert.equal(await sessionSecrets.get("other"), "session-legacy-key");
      assert.equal(restored[0].rendererState.agent.apiKeys, undefined);
      assert.equal((await fs.readFile(path.join(sessionRoot, "window-sessions.json"), "utf8")).includes("session-legacy-key"), false);
    } finally {
      await fs.rm(sessionRoot, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("credential migration failures retain the only plaintext source and never expose it to sessions", async () => {
  const { AgentSecretStore } = loadMain("dist/ts/manager/AgentSecretStore.js");
  const { WindowSessionStore } = loadMain("dist/ts/manager/WindowSessionStore.js");
  const cases = [
    ["encryption unavailable", makeSafeStorage({ available: false }), undefined],
    ["insecure backend", makeSafeStorage({ backend: "basic_text" }), undefined],
    ["encryption throws", makeSafeStorage({ failEncrypt: true }), undefined],
    ["secret rename fails", makeSafeStorage(), "rename"],
    ["invalid structure", makeSafeStorage(), undefined, { provider: { raw: "secret-invalid structure" } }],
  ];
  for (const [label, safeStorage, failingOperation, legacyKeys] of cases) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-agent-key-failure-"));
    try {
      const secret = `secret-${label}`;
      const legacy = { editor: { tabs: ["preserve"] }, agent: { apiKeys: legacyKeys || { provider: secret } } };
      const legacyText = JSON.stringify(legacy);
      await fs.writeFile(path.join(root, "state.json"), legacyText);
      const injectedFs = Object.create(fs);
      if (failingOperation === "rename") injectedFs.rename = async () => { throw new Error("disk unavailable"); };
      const secrets = new AgentSecretStore(root, safeStorage, injectedFs);
      const warnings = [];
      const { WindowSessionStore: InstrumentedStore } = loadMain("dist/ts/manager/WindowSessionStore.js", {}, {
        console: { warn: (...args) => warnings.push(args), error() {} },
      });
      const sessions = new InstrumentedStore(root, process.platform, secrets);
      const restored = await sessions.initialize();
      assert.equal(restored[0].rendererState.agent.apiKeys, undefined, label);
      assert.equal(JSON.stringify(restored[0].rendererState.editor), JSON.stringify(legacy.editor), label);
      assert.equal(await fs.readFile(path.join(root, "state.json"), "utf8"), legacyText, label);
      assert.equal((await fs.readFile(path.join(root, "window-sessions.json"), "utf8")).includes("secret-"), false, label);
      assert.equal(warnings.flat().join(" ").includes("secret-"), false, label);
      assert.equal(await secrets.get("provider"), "", label);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test("interrupted and concurrent credential migration retries without losing provider updates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-agent-key-retry-"));
  let available = false;
  const safeStorage = makeSafeStorage();
  safeStorage.isEncryptionAvailable = () => available;
  const { AgentSecretStore } = loadMain("dist/ts/manager/AgentSecretStore.js", {
    electron: { safeStorage },
  });
  const { WindowSessionStore } = loadMain("dist/ts/manager/WindowSessionStore.js");
  try {
    const legacyText = JSON.stringify({ agent: { apiKeys: { provider: "retry-key" } }, keep: 7 });
    await fs.writeFile(path.join(root, "state.json"), legacyText);
    const firstSecrets = new AgentSecretStore(root, safeStorage);
    await new WindowSessionStore(root, process.platform, firstSecrets).initialize();
    assert.equal(await fs.readFile(path.join(root, "state.json"), "utf8"), legacyText);

    available = true;
    const retrySecrets = new AgentSecretStore(root, safeStorage);
    const retried = new WindowSessionStore(root, process.platform, retrySecrets);
    await retried.initialize();
    assert.equal(await retrySecrets.get("provider"), "retry-key");
    assert.equal((await fs.readFile(path.join(root, "state.json"), "utf8")).includes("retry-key"), false);

    const concurrent = new AgentSecretStore(root, safeStorage);
    const results = await Promise.all([
      concurrent.migrateLegacyApiKeys({ alpha: "alpha-key" }),
      concurrent.migrateLegacyApiKeys({ beta: "beta-key" }),
      concurrent.migrateLegacyApiKeys({ alpha: "alpha-key" }),
    ]);
    assert.ok(results.every((result) => result.success));
    assert.equal(await concurrent.get("alpha"), "alpha-key");
    assert.equal(await concurrent.get("beta"), "beta-key");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("corrupt legacy JSON is preserved without leaking a parse error or secret into renderer state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-corrupt-legacy-state-"));
  const corrupt = '{"agent":{"apiKeys":{"provider":"recoverable-secret"},';
  await fs.writeFile(path.join(root, "state.json"), corrupt);
  const warnings = [];
  const { WindowSessionStore } = loadMain("dist/ts/manager/WindowSessionStore.js", {}, {
    console: { warn: (...args) => warnings.push(args), error() {} },
  });
  try {
    const sessions = new WindowSessionStore(root);
    const restored = await sessions.initialize();
    assert.equal(restored[0].rendererState, null);
    assert.equal(await fs.readFile(path.join(root, "state.json"), "utf8"), corrupt);
    assert.equal(warnings.flat().join(" ").includes("recoverable-secret"), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("window-session metadata coalesces focus writes and flushes the newest ordered snapshot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-session-coalescing-"));
  let writes = 0;
  const countedFs = Object.create(fs);
  countedFs.open = async (file, ...args) => {
    if (String(file).includes("window-sessions.json.")) writes++;
    return fs.open(file, ...args);
  };
  const { WindowSessionStore } = loadMain("dist/ts/manager/WindowSessionStore.js");
  try {
    const store = new WindowSessionStore(root, process.platform, undefined, countedFs);
    const initial = await store.initialize();
    const ids = [initial[0].id];
    for (let index = 1; index < 8; index++) ids.push(store.create({}).id);
    for (let index = 0; index < 500; index++) store.markActive(ids[index % ids.length]);
    assert.equal(await store.flush(), true);
    assert.equal(writes, 2, "500 focus changes collapse into one session-file write");
    const finalId = ids[(499) % ids.length];
    assert.equal(store.getLastActiveSessionId(), finalId);

    const firstState = { version: 2, lastWorkspace: null, value: "older" };
    const latestState = { version: 2, lastWorkspace: null, value: "newest" };
    const firstSave = store.saveRendererState(finalId, JSON.stringify(firstState));
    const secondSave = store.saveRendererState(finalId, JSON.stringify(latestState));
    assert.deepEqual(await Promise.all([firstSave, secondSave]), [true, true]);
    assert.equal((await store.flush()), true);

    const reopened = new WindowSessionStore(root);
    await reopened.initialize();
    assert.equal(JSON.stringify(reopened.get(finalId).rendererState), JSON.stringify(latestState));
    assert.equal(reopened.getLastActiveSessionId(), finalId);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("failed session replacement is observable and a later flush safely retries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-session-flush-retry-"));
  let failRename = false;
  const retryFs = Object.create(fs);
  retryFs.rename = async (...args) => {
    if (failRename) throw new Error("rename failed");
    return fs.rename(...args);
  };
  const { WindowSessionStore } = loadMain("dist/ts/manager/WindowSessionStore.js");
  try {
    const store = new WindowSessionStore(root, process.platform, undefined, retryFs);
    const [session] = await store.initialize();
    const initialFile = await fs.readFile(store.storePath, "utf8");
    failRename = true;
    store.update(session.id, { lastActiveAt: session.lastActiveAt + 100 });
    assert.equal(await store.flush(), false);
    assert.equal(await fs.readFile(store.storePath, "utf8"), initialFile, "failed temp replacement leaves the prior file intact");
    failRename = false;
    store.update(session.id, { lastActiveAt: session.lastActiveAt + 200 });
    assert.equal(await store.flush(), true);
    const written = JSON.parse(await fs.readFile(store.storePath, "utf8"));
    assert.equal(written.sessions[0].lastActiveAt, session.lastActiveAt + 200);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("window restore bounds require a usable title area and clamp disconnected or oversized geometry", () => {
  const primary = { workArea: { x: 0, y: 0, width: 1440, height: 900 } };
  const loadManager = (displays, primaryDisplay = displays[0]) => loadMain(
    "dist/ts/manager/WindowManager.js",
    {
      electron: {
        BrowserWindow: {}, dialog: {},
        screen: { getAllDisplays: () => displays, getPrimaryDisplay: () => primaryDisplay },
      },
      "../Window": { Window: class {} },
      "../addon/Menu": { AppMenu: { installWindowlessMenu() {} } },
      "./IpcRouter": { IpcRouter: class {} },
      "./WindowSessionStore": { WindowSessionStore: class {} },
    },
  );
  const { WindowManager, workspaceComparisonKey } = loadManager([primary]);
  assert.equal(
    JSON.stringify(WindowManager.getRestoreBounds({ x: -20, y: 12, width: 900, height: 700 })),
    JSON.stringify({ x: -20, y: 12, width: 900, height: 700 }),
    "a small off-screen edge keeps a fully usable title area in place",
  );
  const fivePixels = WindowManager.getRestoreBounds({ x: 1435, y: 12, width: 900, height: 700 });
  assert.ok(fivePixels.x < 1435, "five visible title-bar pixels are not accepted");
  const disconnected = WindowManager.getRestoreBounds({ x: 4000, y: -900, width: 1100, height: 720 });
  assert.ok(disconnected.x >= 0 && disconnected.x + disconnected.width <= 1440);
  assert.ok(disconnected.y >= 0 && disconnected.y + 35 <= 900);
  const oversized = WindowManager.getRestoreBounds({ x: -300, y: -400, width: 2000, height: 1500 });
  assert.equal(JSON.stringify(oversized), JSON.stringify({ x: 0, y: 0, width: 1440, height: 900 }));

  const negativeMonitor = { workArea: { x: -1920, y: 0, width: 1920, height: 1080 } };
  const dual = loadManager([negativeMonitor, primary]);
  assert.equal(
    JSON.stringify(dual.WindowManager.getRestoreBounds({ x: -1800, y: 60, width: 1000, height: 760 })),
    JSON.stringify({ x: -1800, y: 60, width: 1000, height: 760 }),
  );
  const rightMonitor = { workArea: { x: 1440, y: 0, width: 1280, height: 1024 } };
  const split = loadManager([primary, rightMonitor]).WindowManager
    .getRestoreBounds({ x: 1300, y: 40, width: 400, height: 700 });
  assert.equal(JSON.stringify(split), JSON.stringify({ x: 1300, y: 40, width: 400, height: 700 }), "useful multi-display placement is preserved");

  const tiny = { workArea: { x: -100, y: 20, width: 500, height: 300 } };
  const smallBounds = loadManager([tiny]).WindowManager.getRestoreBounds({ x: -100, y: 20, width: 900, height: 600 });
  assert.equal(JSON.stringify(smallBounds), JSON.stringify({ x: -100, y: 20, width: 500, height: 300 }));
  assert.equal(workspaceComparisonKey("C:\\Projects\\NCE", "win32"),
    workspaceComparisonKey("c:/projects/nce/", "win32"));
  assert.equal(WindowManager.getRestoreBounds(null).width, 1100);
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
    const owner = outcomes[0].success ? a : b;
    const other = owner === a ? b : a;
    const firstReservation = outcomes[0].success ? outcomes[0] : outcomes[1];
    assert.equal(manager.findWindowByWorkspace(root)?.id, owner.id);
    assert.equal(manager.commitWorkspace(owner.id, root, firstReservation.token), true);
    const project2 = path.join(root, "project-2");
    const project3 = path.join(root, "project-3");
    const project4 = path.join(root, "project-4");
    await Promise.all([project2, project3, project4].map((folder) => fs.mkdir(folder)));

    const secondReservation = await manager.reserveWorkspace(owner.id, project2);
    assert.equal(secondReservation.success, true);
    manager.releaseWorkspace(owner.id, root, false);
    assert.equal(manager.findWindowByWorkspace(project2)?.id, owner.id, "releasing the old path retains the tentative new reservation");
    assert.equal(manager.findWindowByWorkspace(root), null);
    assert.equal(manager.commitWorkspace(owner.id, secondReservation.path, secondReservation.token), true);
    assert.equal(owner.workspacePath, secondReservation.path);
    assert.equal(manager.findWindowByWorkspace(project2)?.id, owner.id);
    assert.equal(manager.findWindowByWorkspace(root), null);

    const conflict = await manager.reserveWorkspace(other.id, project2);
    assert.equal(conflict.success, false);
    assert.equal(conflict.existingWindowId, owner.id);
    assert.equal(manager.findWindowByWorkspace(project2)?.id, owner.id);

    const pending3 = await manager.reserveWorkspace(owner.id, project3);
    const pending4 = await manager.reserveWorkspace(owner.id, project4);
    manager.releaseWorkspace(owner.id, project3, false, pending3.token);
    assert.equal(manager.findWindowByWorkspace(project3), null, "a stale reservation is discarded");
    assert.equal(manager.findWindowByWorkspace(project4)?.id, owner.id);
    manager.releaseWorkspace(owner.id, project4, false, pending4.token);
    assert.equal(manager.findWindowByWorkspace(project4), null);

    const alias = path.join(root, "project-3-alias");
    await fs.symlink(project3, alias, "dir");
    const aliasReservation = await manager.reserveWorkspace(owner.id, alias);
    assert.equal(aliasReservation.success, true);
    assert.equal(manager.commitWorkspace(owner.id, aliasReservation.path, aliasReservation.token), true);
    assert.equal(manager.findWindowByWorkspace(alias)?.id, owner.id);
    manager.releaseWorkspace(owner.id, alias);
    assert.equal(manager.findWindowByWorkspace(project3), null, "symlink release resolves to canonical ownership");

    const rootReservation = await manager.reserveWorkspace(other.id, root);
    assert.equal(rootReservation.success, true);
    assert.equal(manager.commitWorkspace(other.id, root, rootReservation.token), true);
    const count = manager.getAllWindows().length;
    assert.equal(await manager.openWorkspaceInNewWindow(root), true);
    assert.equal(manager.getAllWindows().length, count);

    const otherBrowserWindow = other.window;
    const otherSender = otherBrowserWindow.webContents;
    otherBrowserWindow.destroy();
    assert.equal(manager.getAllWindows().length, 1);
    assert.equal(manager.getWindowByWebContents(otherSender), null);

    const duringClose = await manager.reserveWorkspace(owner.id, project4);
    owner.window.destroy();
    assert.equal(manager.commitWorkspace(owner.id, project4, duringClose.token), false);
    assert.equal(manager.findWindowByWorkspace(project4), null, "closing the window invalidates an in-flight reservation");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  assert.ok(manager.createEmptyWindow());
  failCreate = true;
  assert.equal(manager.createEmptyWindow(), null);
  assert.equal(manager.getAllWindows().length, 1);
  for (let index = 0; index < 7; index++) assert.ok(manager.createEmptyWindow());
  assert.equal(manager.getAllWindows().length, 8);
  assert.equal(manager.createEmptyWindow(), null);
});
