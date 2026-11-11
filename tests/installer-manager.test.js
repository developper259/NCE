"use strict";

const assert = require("node:assert");
const { promises: fs, readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { InstallerManager } = require("../dist/ts/manager/InstallerManager.js");
const { makeTarGz, serve, sha256, staticRoute, tempDir } = require("./helpers/installer.js");

const NODE = process.execPath;
const root = path.resolve(__dirname, "..");

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

function createSender() {
  const sent = [];
  let announce = null;
  return {
    sent,
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    send(channel, payload) {
      sent.push({ channel, payload });
      announce?.();
    },
    next() { return new Promise((resolve) => { announce = resolve; }); },
  };
}

async function fixture() {
  const dir = await tempDir("nce-installer-manager-");
  const file = path.join(dir, "tool.tar.gz");
  await makeTarGz([
    { name: "bin/", type: "directory" },
    { name: "bin/tool", data: "#!/bin/sh\nexit 0\n", mode: 0o755 },
  ], file);
  const body = await fs.readFile(file);
  return { dir, body, checksum: sha256(body) };
}

function definitionFor(url, checksum, id = "tool") {
  return {
    id,
    name: "Tool",
    version: "1.0.0",
    platforms: {
      [process.platform]: {
        [process.arch]: {
          download: { url, checksum, checksumAlgorithm: "sha256" },
          archive: { format: "tar.gz" },
          executable: "bin/tool",
        },
      },
    },
    verification: { executable: NODE, args: ["--version"] },
  };
}

test("InstallerManager installs a package and streams progress to its window", async () => {
  const userDataPath = await tempDir();
  const archive = await fixture();
  const server = await serve({ "/tool.tar.gz": staticRoute(archive.body) });
  try {
    const definition = definitionFor(`${server.origin}/tool.tar.gz`, archive.checksum);
    const manager = new InstallerManager({ userDataPath, registry: { tool: definition } });
    const ipc = createRegistrar();
    manager.handleIPC(ipc);
    assert.deepEqual([...ipc.handlers.keys()], ["Installer:install", "Installer:cancel"]);

    const sender = createSender();
    const result = await ipc.handlers.get("Installer:install")({ sender }, { packageId: "tool" });
    assert.equal(result.success, true);
    assert.equal(result.executable, path.join(userDataPath, "tools", "tool", "1.0.0", "bin", "tool"));
    assert.ok(sender.sent.length > 0, "the requesting window receives progress");
    assert.ok(sender.sent.every((message) => message.channel === "Installer:progress"));
    assert.ok(sender.sent.every((message) => message.payload.packageId === "tool"));
    assert.ok(sender.sent.some((message) => message.payload.percent === 100));
    assert.equal(sender.sent[sender.sent.length - 1].payload.step, "complete");

    const again = await ipc.handlers.get("Installer:install")({ sender }, { packageId: "tool" });
    assert.equal(again.alreadyInstalled, true);
    assert.equal(again.executable, result.executable);
  } finally {
    await server.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
    await fs.rm(archive.dir, { recursive: true, force: true });
  }
});

test("InstallerManager rejects malformed payloads and skips destroyed windows", async () => {
  const userDataPath = await tempDir();
  const archive = await fixture();
  const server = await serve({ "/tool.tar.gz": staticRoute(archive.body) });
  try {
    const url = `${server.origin}/tool.tar.gz`;
    const manager = new InstallerManager({
      userDataPath,
      registry: {
        tool: definitionFor(url, archive.checksum),
        other: definitionFor(url, archive.checksum, "other"),
      },
    });
    const ipc = createRegistrar();
    manager.handleIPC(ipc);
    const install = ipc.handlers.get("Installer:install");
    const sender = createSender();

    for (const payload of [undefined, null, {}, { packageId: 42 }, { packageId: "missing" }]) {
      const result = await install({ sender }, payload);
      assert.equal(result.success, false);
      assert.equal(result.code, "PACKAGE_NOT_FOUND");
    }
    assert.equal(sender.sent.length, 0, "a rejected package reports no progress");

    sender.destroyed = true;
    const result = await install({ sender }, { packageId: "other" });
    assert.equal(result.success, true);
    assert.equal(sender.sent.length, 0, "a destroyed window is never sent progress");
  } finally {
    await server.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
    await fs.rm(archive.dir, { recursive: true, force: true });
  }
});

test("InstallerManager cancels a running install and shares one busy guard", async () => {
  const userDataPath = await tempDir();
  const archive = await fixture();
  const server = await serve({
    "/tool.tar.gz": (_req, res) => {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": archive.body.length + 1024,
      });
      res.write(archive.body.subarray(0, 16));
    },
  });
  try {
    const manager = new InstallerManager({
      userDataPath,
      registry: { tool: definitionFor(`${server.origin}/tool.tar.gz`, archive.checksum) },
    });
    const ipc = createRegistrar();
    manager.handleIPC(ipc);
    const install = ipc.handlers.get("Installer:install");
    const first = createSender();
    const second = createSender();
    const started = first.next();
    const running = install({ sender: first }, { packageId: "tool" });
    await started;

    const busy = await install({ sender: second }, { packageId: "tool" });
    assert.equal(busy.success, false);
    assert.equal(busy.code, "INSTALL_BUSY", "another window cannot install concurrently");

    assert.equal(await ipc.handlers.get("Installer:cancel")({ sender: second }), true);
    const result = await running;
    assert.equal(result.success, false);
    assert.equal(result.code, "CANCELLED");
    assert.deepEqual(await fs.readdir(path.join(userDataPath, "tools")), [], "staging is cleaned up");
  } finally {
    await server.close();
    await fs.rm(userDataPath, { recursive: true, force: true });
    await fs.rm(archive.dir, { recursive: true, force: true });
  }
});

test("Installer IPC is wired into the app, the window and the preload", () => {
  const app = readFileSync(path.join(root, "src/ts/App.ts"), "utf8");
  const window = readFileSync(path.join(root, "src/ts/Window.ts"), "utf8");
  const preload = readFileSync(path.join(root, "src/js/main/Preload.js"), "utf8");
  assert.match(app, /import \{ InstallerManager \} from "\.\/manager\/InstallerManager";/);
  assert.match(app, /this\.installer = new InstallerManager\(\{ userDataPath: userData \}\);/);
  assert.match(window, /this\.app\.installer\?\.handleIPC\(this\.ipc\);/);
  assert.match(preload, /installer: \{/);
  assert.match(preload, /ipcRenderer\.invoke\("Installer:install", \{ packageId \}\)/);
  assert.match(preload, /ipcRenderer\.invoke\("Installer:cancel"\)/);
  assert.match(preload, /ipcRenderer\.on\("Installer:progress", listener\)/);
  assert.match(preload, /ipcRenderer\.removeListener\("Installer:progress", listener\)/);
});