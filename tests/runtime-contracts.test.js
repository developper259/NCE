const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("Windows packaging icon contains a 256px frame", () => {
  const icon = fs.readFileSync(path.join(root, "assets/logo/NCE/dark-logo.ico"));
  assert.equal(icon.readUInt16LE(0), 0, "ICO reserved field");
  assert.equal(icon.readUInt16LE(2), 1, "ICO image type");
  const count = icon.readUInt16LE(4);
  assert.ok(count > 0, "ICO must contain at least one frame");

  const frames = Array.from({ length: count }, (_, index) => {
    const offset = 6 + index * 16;
    return {
      width: icon[offset] || 256,
      height: icon[offset + 1] || 256,
      bits: icon.readUInt16LE(offset + 6),
    };
  });
  assert.ok(
    frames.some(({ width, height, bits }) =>
      width >= 256 && height >= 256 && bits === 32),
    `Expected a 256x256 32-bit frame, got ${JSON.stringify(frames)}`,
  );
});

test("NSHClient configures, resolves requests, rejects session loss, and disposes", async () => {
  const messages = [];
  class FakeWorker {
    constructor() { this.onmessage = null; this.onerror = null; this.terminated = false; }
    postMessage(message) { messages.push(message); }
    terminate() { this.terminated = true; }
  }
  const NSHClient = loadGlobal("src/js/highlight/NSHClient.js", "NSHClient", { Worker: FakeWorker });
  const client = new NSHClient({ api: { getNshEndpoint: async () => ({ host: "127.0.0.1", port: 3210 }) } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages[0].taskName, "configure");
  client.worker.onmessage({ data: { taskId: messages[0].taskId, result: true } });
  await client.connect();
  assert.equal(client.state, "ready");

  const request = client.request("supportedLanguages");
  await new Promise((resolve) => setImmediate(resolve));
  const pendingMessage = messages.at(-1);
  client.worker.onmessage({ data: { taskId: pendingMessage.taskId, result: { languages: ["javascript"] } } });
  assert.deepEqual(await request, { languages: ["javascript"] });

  const lost = client.request("highlight");
  await new Promise((resolve) => setImmediate(resolve));
  client.worker.onmessage({ data: { type: "sessionLost" } });
  await assert.rejects(lost, /session lost/);
  client.dispose();
  assert.equal(client.state, "disposed");
  assert.equal(client.worker.terminated, true);
  await assert.rejects(client.request("highlight"), /disposed/);
});

test("NSHClient initial connection failure can be retried", async () => {
  let available = false;
  const messages = [];
  class FakeWorker {
    postMessage(message) { messages.push(message); }
    terminate() {}
  }
  const NSHClient = loadGlobal("src/js/highlight/NSHClient.js", "NSHClient", { Worker: FakeWorker });
  const client = new NSHClient({ api: { getNshEndpoint: async () => available ? { host: "127.0.0.1", port: 1 } : null } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.state, "disconnected");
  available = true;
  const retry = client.connect();
  await new Promise((resolve) => setImmediate(resolve));
  const configure = messages.at(-1);
  client.worker.onmessage({ data: { taskId: configure.taskId, result: true } });
  await retry;
  assert.equal(client.state, "ready");
  client.dispose();
});

test("worker and client source contain timeout and reconnect cleanup paths", () => {
  const worker = read("src/js/worker/highlight.worker.js");
  const client = read("src/js/highlight/NSHClient.js");
  assert.match(worker, /requestTimeoutMs/);
  assert.match(worker, /pendingRequests\.delete\(requestId\)/);
  assert.match(worker, /reconnectDelay/);
  assert.match(client, /state = "reconnecting"/);
  assert.match(client, /rejectPending\(new Error\("NSH session lost"\)\)/);
  assert.match(client, /worker\.terminate\(\)/);
});

test("startup state restore awaits the File Explorer project", () => {
  const states = read("src/js/manager/StatesManager.js");
  assert.match(states, /await this\.loadFileExplorerState\(state\.fileExplorer\)/);
  assert.match(states, /await fileExplorer\.loadProject\(explorerState\.rootPath\)/);
});

test("Watcher batches events and can retarget a recreated BrowserWindow", () => {
  const watcher = read("src/ts/addon/Watcher.ts");
  assert.match(watcher, /setWindow\(window: BrowserWindow\)/);
  assert.match(watcher, /pendingEvents\.set/);
  assert.match(watcher, /setTimeout\(\(\) => this\.flushEvents\(\), 150\)/);
  assert.match(watcher, /file-system-change/);
});

test("critical renderer components and build assets are registered", () => {
  const html = read("src/html/index.html");
  const requiredScripts = [
    "controller/WriterController.js",
    "controller/HistoryController.js",
    "controller/CursorController.js",
    "controller/SelectController.js",
    "controller/SmartTypingController.js",
    "manager/QuickPanelManager.js",
    "manager/StatesManager.js",
    "addon/MarkdownRenderer.js",
    "sidebar/FileExplorer.Sidebar.js",
    "sidebar/Search.Sidebar.js",
    "sidebar/Agent.Sidebar.js",
  ];
  for (const script of requiredScripts) {
    assert.match(html, new RegExp(`js/${script.replaceAll("/", "\\/")}`));
    assert.equal(fs.existsSync(path.join(root, "src/js", script)), true, script);
  }
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(packageJson.scripts.typecheck, "tsc --noEmit");
  assert.match(packageJson.scripts.test, /node --test/);
});
