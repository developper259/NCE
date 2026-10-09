const assert = require("node:assert/strict");
const test = require("node:test");
const { TerminalManager, resolveTerminalShell } = require("../dist/ts/terminal/TerminalManager.js");
const { normalizeTerminalLink, terminalLimits } = require("../dist/ts/terminal/TerminalTypes.js");
const nodePtyEntry = require.resolve("node-pty");

class FakeWebContents {
  constructor() {
    this.destroyed = false;
    this.messages = [];
  }
  isDestroyed() { return this.destroyed; }
  send(channel, payload) { this.messages.push({ channel, payload }); }
  take(channel) {
    const index = this.messages.findIndex((message) => message.channel === channel);
    if (index < 0) return null;
    return this.messages.splice(index, 1)[0].payload;
  }
}

class FakePty {
  constructor() {
    this.writes = [];
    this.resizes = [];
    this.pauses = 0;
    this.resumes = 0;
    this.kills = 0;
    this.dataListeners = new Set();
    this.exitListeners = new Set();
  }
  onData(listener) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }
  onExit(listener) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }
  write(data) { this.writes.push(data); }
  resize(cols, rows) { this.resizes.push([cols, rows]); }
  pause() { this.pauses += 1; }
  resume() { this.resumes += 1; }
  kill() { this.kills += 1; }
  emitData(data) { for (const listener of this.dataListeners) listener(data); }
  emitExit(exitCode = 0, signal = undefined) {
    for (const listener of this.exitListeners) listener({ exitCode, signal });
  }
}

function fixture({ workspace = "/workspace with accents/é", access = async () => {}, spawn } = {}) {
  const owner = new FakeWebContents();
  const attacker = new FakeWebContents();
  const ptys = [];
  const fakeFs = {
    access,
    realpath: async (value) => value,
    stat: async () => ({ isDirectory: () => true }),
  };
  const manager = new TerminalManager({
    owner,
    platform: process.platform,
    env: { PATH: "/bin", SHELL: "/test shell/zsh", HOME: "/home/test" },
    homeDir: "/home/test",
    getWorkspacePath: () => workspace,
    getShellSetting: () => "/configured shell/Terminal",
    fs: fakeFs,
    logger: { error() {} },
    spawn: spawn || ((shell, args, options) => {
      const child = new FakePty();
      ptys.push({ shell, args, options, child });
      return child;
    }),
  });
  return { owner, attacker, ptys, manager, fakeFs };
}

async function create(f) {
  return f.manager.create({ sender: f.owner }, { cols: 100, rows: 32 });
}

test("loading Window's terminal manager does not load the native PTY module", () => {
  assert.equal(require.cache[nodePtyEntry], undefined);
  const f = fixture();
  assert.equal(require.cache[nodePtyEntry], undefined);
  assert.equal(f.manager.closeAll(), undefined);
  assert.equal(require.cache[nodePtyEntry], undefined);
});

test("TerminalManager validates creation and starts a real PTY in the verified workspace", async () => {
  const f = fixture();
  const result = await create(f);
  assert.equal(result.success, true);
  assert.match(result.sessionId, /^[0-9a-f-]{36}$/i);
  assert.equal(result.shell, "Terminal");
  assert.equal(f.ptys.length, 1);
  assert.equal(f.ptys[0].shell, "/configured shell/Terminal");
  assert.deepEqual(f.ptys[0].args, []);
  assert.equal(f.ptys[0].options.cwd, "/workspace with accents/é");
  assert.equal(f.ptys[0].options.name, "xterm-256color");
  assert.deepEqual([f.ptys[0].options.cols, f.ptys[0].options.rows], [100, 32]);
  assert.equal(f.ptys[0].options.env.TERM, "xterm-256color");
  assert.equal("ELECTRON_RUN_AS_NODE" in f.ptys[0].options.env, false);

  assert.equal((await f.manager.create({ sender: f.attacker }, { cols: 100, rows: 32 })).error.code, "UNAUTHORIZED");
  assert.equal((await f.manager.create({ sender: f.owner }, { cols: 1, rows: 32 })).error.code, "INVALID_SIZE");
  assert.equal(f.ptys.length, 1);
});

test("TerminalManager resolves the configured executable and falls back to an available platform shell", async () => {
  const calls = [];
  const shell = await resolveTerminalShell("/path containing spaces/pwsh.exe", {
    platform: "win32",
    env: { PATH: "C:/Windows/System32", PATHEXT: ".EXE;.CMD" },
    fs: { access: async (file) => { calls.push(file); if (file.endsWith("pwsh.exe")) return; throw Error("missing"); } },
  });
  assert.equal(shell.name, "pwsh.exe");
  assert.equal(calls.length, 1, "an explicit executable extension is not doubled");

  const fallback = await resolveTerminalShell("", {
    platform: "linux",
    env: { SHELL: "/missing/shell", PATH: "/usr/bin" },
    fs: { access: async (file) => { if (file === "/bin/bash") return; throw Error("missing"); } },
  });
  assert.equal(fallback.path, "/bin/bash");
  await assert.rejects(
    resolveTerminalShell("/missing shell", {
      platform: "linux", env: { PATH: "" }, fs: { access: async () => { throw Error("missing"); } },
    }),
    { code: "SHELL_NOT_FOUND" },
  );
});

test("terminal links allow only explicit safe web protocols", () => {
  assert.equal(normalizeTerminalLink("https://example.com/path?q=one"), "https://example.com/path?q=one");
  assert.equal(normalizeTerminalLink("http://localhost:3000"), "http://localhost:3000/");
  for (const value of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,hi",
    "https://user:password@example.com/",
    "https://example.com/\nmalicious",
    `https://example.com/${"x".repeat(2050)}`,
    null,
  ]) assert.equal(normalizeTerminalLink(value), null, String(value));
});

test("TerminalManager verifies the workspace directory and falls back to home", async () => {
  const f = fixture({ workspace: "/deleted-workspace" });
  f.fakeFs.realpath = async (value) => {
    if (value === "/deleted-workspace") return value;
    return value;
  };
  f.fakeFs.stat = async (value) => ({ isDirectory: () => value !== "/deleted-workspace" });
  const result = await create(f);
  assert.equal(result.success, true);
  assert.equal(f.ptys[0].options.cwd, "/home/test");
});

test("TerminalManager limits concurrent session creation and isolates session ownership", async () => {
  const f = fixture();
  const pending = Array.from({ length: terminalLimits.maxSessions + 2 }, () => create(f));
  const results = await Promise.all(pending);
  assert.equal(results.filter((item) => item.success).length, terminalLimits.maxSessions);
  assert.equal(results.filter((item) => item.error?.code === "SESSION_LIMIT").length, 2);
  assert.equal(f.ptys.length, terminalLimits.maxSessions);
  const first = results.find((item) => item.success);
  assert.equal(f.manager.write({ sender: f.attacker }, first.sessionId, "echo nope" ).error.code, "UNAUTHORIZED");
  assert.equal(f.manager.write({ sender: f.owner }, first.sessionId, "x".repeat(terminalLimits.maxWriteBytes + 1)).error.code, "INVALID_INPUT");
  assert.equal(f.manager.resize({ sender: f.owner }, first.sessionId, 0, 24).error.code, "INVALID_SIZE");
  assert.deepEqual(f.manager.resize({ sender: f.owner }, first.sessionId, 132, 42), { success: true });
  assert.deepEqual(f.ptys[0].child.resizes, [[132, 42]]);
  assert.deepEqual(f.manager.write({ sender: f.owner }, first.sessionId, "echo ok\r"), { success: true });
  assert.deepEqual(f.ptys[0].child.writes, ["echo ok\r"]);
});

test("TerminalSession batches UTF-8 output in order and applies acknowledgement backpressure", async () => {
  const f = fixture();
  const result = await create(f);
  const child = f.ptys[0].child;
  const data = `${"a".repeat(terminalLimits.outputChunkBytes - 1)}🙂${"é".repeat(24_000)}`;
  child.emitData(data);
  let output = f.owner.take("Terminal:output");
  assert.ok(output);
  assert.ok(Buffer.byteLength(output.data, "utf8") <= terminalLimits.outputChunkBytes);
  assert.equal(f.manager.ack({ sender: f.owner }, result.sessionId, output.sequence + 1).error.code, "STALE_ACK");

  const reconstructed = [output.data];
  while (true) {
    const acked = f.manager.ack({ sender: f.owner }, result.sessionId, output.sequence);
    assert.deepEqual(acked, { success: true });
    output = f.owner.take("Terminal:output");
    if (!output) break;
    reconstructed.push(output.data);
    assert.ok(Buffer.byteLength(output.data, "utf8") <= terminalLimits.outputChunkBytes);
  }
  assert.equal(reconstructed.join(""), data);

  child.emitData("x".repeat(terminalLimits.outputPauseBytes + 32));
  assert.equal(child.pauses, 1);
  let current = f.owner.take("Terminal:output");
  while (current) {
    f.manager.ack({ sender: f.owner }, result.sessionId, current.sequence);
    current = f.owner.take("Terminal:output");
  }
  assert.equal(child.resumes, 1);
});

test("TerminalSession drains buffered PTY output before publishing the exit event", async () => {
  const f = fixture();
  const result = await create(f);
  const child = f.ptys[0].child;
  const expected = "f".repeat(terminalLimits.outputChunkBytes * 2 + 7);
  child.emitData(expected);
  child.emitExit(0);

  let output = f.owner.take("Terminal:output");
  const chunks = [];
  while (output) {
    chunks.push(output.data);
    assert.equal(f.owner.take("Terminal:exit"), null, "exit waits until every output chunk is acknowledged");
    f.manager.ack({ sender: f.owner }, result.sessionId, output.sequence);
    output = f.owner.take("Terminal:output");
  }
  assert.equal(chunks.join(""), expected);
  assert.deepEqual(f.owner.take("Terminal:exit"), {
    sessionId: result.sessionId, exitCode: 0, signal: null,
  });
});

test("TerminalSession stops safely on output overflow, reports exit, and cleans up idempotently", async () => {
  const f = fixture();
  const result = await create(f);
  const child = f.ptys[0].child;
  child.emitData("x".repeat(terminalLimits.maxOutputBytes + 1));
  assert.equal(f.owner.take("Terminal:error").error.code, "OUTPUT_LIMIT");
  assert.equal(child.kills, 1);
  assert.equal(f.manager.write({ sender: f.owner }, result.sessionId, "still running" ).error.code, "SESSION_EXITED");
  assert.deepEqual(f.manager.close({ sender: f.owner }, result.sessionId), { success: true });
  assert.equal(f.manager.close({ sender: f.owner }, result.sessionId).error.code, "SESSION_UNAVAILABLE");
  assert.equal(child.kills, 1, "close after overflow is idempotent");

  const next = await create(f);
  const nextChild = f.ptys[1].child;
  nextChild.emitExit(7, 2);
  assert.deepEqual(f.owner.take("Terminal:exit"), {
    sessionId: next.sessionId, exitCode: 7, signal: 2,
  });
  assert.equal(f.manager.write({ sender: f.owner }, next.sessionId, "no" ).error.code, "SESSION_EXITED");
  f.owner.destroyed = true;
  f.manager.closeForOwner(f.owner);
  assert.equal(nextChild.kills, 0, "an exited process is not killed again");
});

test("TerminalManager closes all sessions belonging to a reloaded or destroyed window", async () => {
  const f = fixture();
  const first = await create(f);
  const second = await create(f);
  assert.equal(f.manager.close({ sender: f.owner }, first.sessionId).success, true);
  assert.equal(f.ptys[0].child.kills, 1);
  f.manager.closeForOwner(f.owner);
  f.manager.closeForOwner(f.owner);
  assert.equal(f.ptys[1].child.kills, 1);
  assert.equal(f.manager.write({ sender: f.owner }, second.sessionId, "no").error.code, "SESSION_UNAVAILABLE");
});
