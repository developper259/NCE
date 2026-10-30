const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  createNodeWorker,
  createUtilityWorker,
  forkWorker,
} = require("../dist/ts/addon/WorkerProcess.js");

async function waitFor(read, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for a worker message.");
}

test("workers exchange messages through the plain Node fallback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-worker-node-"));
  const script = path.join(root, "worker.js");
  await fs.writeFile(script, [
    'process.on("message", (message) => {',
    '  process.send({ echo: message, runAsNode: process.env.ELECTRON_RUN_AS_NODE });',
    "});",
    'process.send({ type: "ready" });',
  ].join("\n"));
  const worker = forkWorker(script);
  try {
    const messages = [];
    worker.onMessage((message) => messages.push(message));
    await waitFor(() => messages.find((message) => message.type === "ready"));
    worker.postMessage({ ping: 1 });
    const echo = await waitFor(() => messages.find((message) => message.echo));
    assert.deepEqual(echo.echo, { ping: 1 });
    assert.equal(echo.runAsNode, "1");
    assert.equal(worker.exited, false);
  } finally {
    worker.kill();
  }
  await fs.rm(root, { recursive: true, force: true });
});

class FakeUtilityProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 4242;
    this.sent = [];
    this.killed = false;
  }
  postMessage(message) {
    this.sent.push(message);
  }
  kill() {
    this.killed = true;
    this.emit("exit", 0);
    return true;
  }
}

test("utility workers drop RunAsNode and use parentPort IPC", () => {
  const child = new FakeUtilityProcess();
  let forkCall = null;
  const utilityProcess = {
    fork(modulePath, args, options) {
      forkCall = { modulePath, args, options };
      return child;
    },
  };
  const worker = createUtilityWorker(
    utilityProcess,
    "/app.asar/dist/ts/addon/WorkerParentPort.js",
    ["foreground"],
    { CUSTOM_FLAG: "1", ELECTRON_RUN_AS_NODE: "1" },
  );
  assert.equal(forkCall.modulePath, "/app.asar/dist/ts/addon/WorkerParentPort.js");
  assert.deepEqual(forkCall.args, ["foreground"]);
  assert.equal(forkCall.options.stdio, "ignore");
  assert.equal(forkCall.options.env.CUSTOM_FLAG, "1");
  assert.equal("ELECTRON_RUN_AS_NODE" in forkCall.options.env, false);
  assert.equal(worker.pid, 4242);

  const messages = [];
  const exits = [];
  worker.onMessage((message) => messages.push(message));
  const unsubscribe = worker.onExit((code) => exits.push(code));
  worker.postMessage({ type: "execute" });
  child.emit("message", { type: "ready" });
  assert.deepEqual(child.sent, [{ type: "execute" }]);
  assert.deepEqual(messages, [{ type: "ready" }]);

  child.emit("exit", 0);
  assert.deepEqual(exits, [0]);
  assert.equal(worker.exited, true);
  unsubscribe();
  child.emit("exit", 0);
  assert.deepEqual(exits, [0], "unsubscribed exit listeners stop firing");
  worker.kill();
  assert.equal(child.killed, true);
});

test("utility postMessage failures surface through the error callback", () => {
  const child = new FakeUtilityProcess();
  child.postMessage = () => { throw new Error("channel closed"); };
  const worker = createUtilityWorker({ fork: () => child }, "/worker.js");
  const errors = [];
  worker.postMessage({ type: "close" }, (error) => errors.push(error.message));
  assert.deepEqual(errors, ["channel closed"]);
});

test("Node worker send failures reach the error callback after exit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-worker-exit-"));
  const script = path.join(root, "worker.js");
  await fs.writeFile(script, 'process.send({ type: "ready" });');
  const worker = createNodeWorker(script);
  const messages = [];
  worker.onMessage((message) => messages.push(message));
  try {
    await waitFor(() => messages.find((message) => message.type === "ready"));
    await waitFor(() => worker.exited, 5000);
    const errors = [];
    worker.postMessage({ late: true }, (error) => errors.push(error.message));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /closed/i);
  } finally {
    worker.kill();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("polling and regex workers run through the shared worker factory", async () => {
  const addon = path.join(__dirname, "..", "src", "ts", "addon");
  for (const [file, workerScript] of [
    ["WatcherPolling.ts", "WatcherPollingWorker.js"],
    ["WorkspaceRegexExecutor.ts", "WorkspaceRegexWorker.js"],
  ]) {
    const source = await fs.readFile(path.join(addon, file), "utf8");
    assert.match(source, /forkWorker/);
    assert.doesNotMatch(source, /ELECTRON_RUN_AS_NODE/);
    assert.doesNotMatch(source, /from "node:child_process"/);
    assert.match(source, new RegExp(workerScript.replace(".", "\\.")));
  }
  const workerSource = await fs.readFile(
    path.join(addon, "WatcherPollingWorker.ts"),
    "utf8",
  );
  assert.match(workerSource, /WorkerParentPort/);
  const packageCheck = await fs.readFile(
    path.join(__dirname, "..", "scripts", "check-package.js"),
    "utf8",
  );
  for (const packaged of [
    "WatcherPollingWorker.js",
    "WorkspaceRegexWorker.js",
    "WorkerParentPort.js",
  ]) assert.match(packageCheck, new RegExp(packaged.replace(".", "\\.")));
});
