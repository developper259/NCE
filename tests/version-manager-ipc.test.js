"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { promises: fs, readFileSync } = require("node:fs");
const path = require("node:path");

const { tempDir } = require("./helpers/installer.js");
const {
  serveGitFixture,
  createVersionManager,
  memorySettings,
} = require("./helpers/version-manager.js");

const root = path.resolve(__dirname, "..");
const posixSkip = process.platform === "win32" ? "POSIX shell-script Git fixture" : false;

function createRegistrar() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, listener) {
      if (handlers.has(channel)) throw new Error(`Duplicate channel: ${channel}`);
      handlers.set(channel, listener);
    },
  };
}

const CHANNELS = [
  "VersionManager:state",
  "VersionManager:refresh",
  "VersionManager:install",
  "VersionManager:uninstall",
  "VersionManager:verify",
  "VersionManager:cancel",
  "VersionManager:languages",
  "VersionManager:language-view",
  "VersionManager:apply-components",
];

test("VersionManager IPC drives the full lifecycle across windows and broadcasts events", { skip: posixSkip }, async () => {
  const userDataPath = await tempDir("nce-vm-ipc-");
  const fixture = await serveGitFixture();
  const settings = memorySettings();
  const messages = [];
  const { versionManager } = createVersionManager(userDataPath, {
    distribution: fixture.distribution,
    settings,
    broadcast: (channel, payload) => messages.push({ channel, payload }),
  });
  const windowA = createRegistrar();
  const windowB = createRegistrar();
  try {
    await versionManager.initialize();
    versionManager.handleIPC(windowA);
    versionManager.handleIPC(windowB);
    assert.deepEqual([...windowA.handlers.keys()], CHANNELS);
    assert.deepEqual([...windowB.handlers.keys()], CHANNELS);
    const sender = { isDestroyed: () => false, send: () => {} };
    const call = (ipc, channel, payload) => ipc.handlers.get(channel)({ sender }, payload);

    const initial = await call(windowA, "VersionManager:state");
    assert.equal(initial.packages.length, 1);
    assert.equal(initial.packages[0].id, "git");
    assert.equal(initial.packages[0].state, "not-installed");

    // Window B installs; window A observes the new inventory.
    const installed = await call(windowB, "VersionManager:install", { packageId: "git" });
    assert.equal(installed.success, true, installed.error);
    const afterInstall = await call(windowA, "VersionManager:state");
    assert.equal(afterInstall.packages[0].state, "installed");
    const record = afterInstall.packages[0].installations[0];
    assert.equal(record.provenance, "managed");
    assert.equal(settings.get("git.path"), record.executable);

    const verified = await call(windowA, "VersionManager:verify", { installationId: record.id });
    assert.equal(verified.success, true);
    assert.equal(verified.installation.state, "installed");

    const refreshed = await call(windowB, "VersionManager:refresh");
    assert.equal(refreshed.packages[0].state, "installed");

    const removed = await call(windowB, "VersionManager:uninstall", { installationId: record.id });
    assert.equal(removed.success, true, removed.error);
    const afterUninstall = await call(windowA, "VersionManager:state");
    assert.equal(afterUninstall.packages[0].state, "not-installed");
    assert.equal(settings.get("git.path"), "");
    assert.equal(await call(windowA, "VersionManager:cancel", { packageId: "git" }), false);

    // Every lifecycle event is broadcast on the dedicated channel.
    assert.ok(messages.length > 0);
    assert.ok(messages.every((message) => message.channel === "VersionManager:event"));
    const operations = messages.filter((message) => message.payload.type === "operation").map((message) => message.payload.operation);
    assert.ok(operations.every((operation) => operation.packageId === "git"));
    assert.ok(operations.some((operation) => operation.kind === "install" && operation.state === "running"));
    assert.ok(operations.some((operation) => operation.kind === "install" && operation.state === "completed"));
    assert.ok(operations.some((operation) => operation.kind === "uninstall" && operation.state === "completed"));
    assert.ok(messages.some((message) => message.payload.type === "inventory-changed"));

    // dispose() detaches the broadcast subscription.
    versionManager.dispose();
    const count = messages.length;
    await call(windowA, "VersionManager:refresh");
    assert.equal(messages.length, count);
  } finally {
    versionManager.dispose();
    await fixture.server.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
    await fs.rm(fixture.dir, { recursive: true, force: true });
  }
});

test("VersionManager IPC rejects malformed payloads without touching disk or settings", async () => {
  const userDataPath = await tempDir("nce-vm-ipc-invalid-");
  const sentinelDir = path.join(userDataPath, "tools", "git", "keep");
  await fs.mkdir(sentinelDir, { recursive: true });
  await fs.writeFile(path.join(sentinelDir, "marker.txt"), "keep\n");
  const settings = memorySettings();
  const messages = [];
  const { versionManager } = createVersionManager(userDataPath, {
    settings,
    broadcast: (channel, payload) => messages.push({ channel, payload }),
  });
  const ipc = createRegistrar();
  try {
    await versionManager.initialize();
    versionManager.handleIPC(ipc);
    const sender = { isDestroyed: () => false, send: () => {} };
    const call = (channel, payload) => ipc.handlers.get(channel)({ sender }, payload);

    const invalidPackagePayloads = [
      undefined, null, {}, { packageId: 42 }, { packageId: "" },
      { packageId: "../evil" }, { packageId: "a/b" }, { packageId: "git\0" },
    ];
    for (const payload of invalidPackagePayloads) {
      const result = await call("VersionManager:install", payload);
      assert.equal(result.success, false);
      assert.equal(result.code, "PACKAGE_NOT_FOUND");
      assert.equal(await call("VersionManager:cancel", payload), false);
    }

    const invalidInstallationPayloads = [
      undefined, null, {}, { installationId: 42 }, { installationId: "" },
      { installationId: "../../etc" }, { installationId: "a/b" },
    ];
    for (const payload of invalidInstallationPayloads) {
      const uninstalled = await call("VersionManager:uninstall", payload);
      assert.equal(uninstalled.success, false);
      assert.equal(uninstalled.code, "INSTALLATION_NOT_FOUND");
      const verified = await call("VersionManager:verify", payload);
      assert.equal(verified.success, false);
      assert.equal(verified.installation, undefined);
    }

    // Well-formed but unknown identifiers are rejected by the manager itself.
    assert.equal((await call("VersionManager:install", { packageId: "missing" })).code, "PACKAGE_NOT_FOUND");
    assert.equal((await call("VersionManager:uninstall", { installationId: "deadbeef" })).code, "INSTALLATION_NOT_FOUND");
    assert.equal((await call("VersionManager:verify", { installationId: "deadbeef" })).code, "INSTALLATION_NOT_FOUND");

    assert.equal(messages.length, 0, "rejected payloads emit no lifecycle events");
    assert.deepEqual(settings.writes, []);
    assert.equal(await fs.readFile(path.join(sentinelDir, "marker.txt"), "utf8"), "keep\n");
  } finally {
    versionManager.dispose();
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
});

test("VersionManager IPC is wired into the app, the window and the preload", () => {
  const app = readFileSync(path.join(root, "src/ts/App.ts"), "utf8");
  const window = readFileSync(path.join(root, "src/ts/Window.ts"), "utf8");
  const preload = readFileSync(path.join(root, "src/js/main/Preload.js"), "utf8");
  const installerManager = readFileSync(path.join(root, "src/ts/manager/InstallerManager.ts"), "utf8");

  assert.match(app, /import \{ VersionManager \} from "\.\/manager\/VersionManager";/);
  assert.match(app, /this\.versionManager = new VersionManager\(\{/);
  // One shared Installer: the Version Manager and the Git sidebar share the busy guard.
  assert.match(app, /installer: this\.installer\.getInstaller\(\),/);
  assert.match(installerManager, /getInstaller\(\): Installer/);
  // Settings writes broadcast so GitManager/gitSidebar re-resolve immediately.
  assert.match(app, /this\.broadcastToWindows\("settings-changed", this\.settings\.getAll\(\)\);/);
  assert.match(app, /broadcast: \(channel, payload\) => this\.broadcastToWindows\(channel, payload\),/);
  assert.match(app, /await this\.versionManager\.initialize\(\);/);
  assert.match(app, /this\.versionManager\?\.dispose\(\);/);
  assert.match(window, /this\.app\.versionManager\?\.handleIPC\(this\.ipc\);/);

  assert.match(preload, /versionManager: \{/);
  assert.match(preload, /ipcRenderer\.invoke\("VersionManager:state"\)/);
  assert.match(preload, /ipcRenderer\.invoke\("VersionManager:refresh"\)/);
  assert.match(preload, /ipcRenderer\.invoke\("VersionManager:install", \{ packageId \}\)/);
  assert.match(preload, /ipcRenderer\.invoke\("VersionManager:uninstall", \{ installationId \}\)/);
  assert.match(preload, /ipcRenderer\.invoke\("VersionManager:verify", \{ installationId \}\)/);
  assert.match(preload, /ipcRenderer\.invoke\("VersionManager:cancel", \{ packageId \}\)/);
  assert.match(preload, /ipcRenderer\.on\("VersionManager:event", listener\)/);
  assert.match(preload, /ipcRenderer\.removeListener\("VersionManager:event", listener\)/);
  // The raw ipcRenderer object is never exposed to the renderer.
  assert.doesNotMatch(preload, /exposeInMainWorld\(\s*["']ipcRenderer/);
});