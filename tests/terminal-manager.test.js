const assert = require("node:assert/strict");
const test = require("node:test");
const {
  TerminalManager,
  classifyPtySpawnFailure,
  inspectPtySpawnHelper,
  resolveTerminalShell,
} = require("../dist/ts/terminal/TerminalManager.js");
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

function fixture({ workspace = "/workspace with accents/é", access = async () => {}, spawn, logger = { error() {} }, platform = "linux" } = {}) {
  let activeWorkspace = workspace;
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
    platform,
    env: { PATH: "/bin", SHELL: "/test shell/zsh", HOME: "/home/test" },
    homeDir: "/home/test",
    getWorkspacePath: () => activeWorkspace,
    getShellSetting: () => "/configured shell/Terminal",
    fs: fakeFs,
    logger,
    spawn: spawn || ((shell, args, options) => {
      const child = new FakePty();
      ptys.push({ shell, args, options, child });
      return child;
    }),
  });
  return {
    owner, attacker, ptys, manager, fakeFs,
    setWorkspace(value) { activeWorkspace = value; },
  };
}

async function create(f) {
  const scope = await f.manager.getWorkspaceScope();
  return f.manager.create({ sender: f.owner }, {
    cols: 100, rows: 32, workspaceKey: scope.workspaceKey,
  });
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
  assert.equal(result.workspaceKey, await f.manager.getWorkspaceScope().then((scope) => scope.workspaceKey));
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

test("TerminalManager supports repeated create, kill, and create without stale sessions", async () => {
  const f = fixture();
  const ids = new Set();
  for (let index = 0; index < 20; index++) {
    const created = await create(f);
    assert.equal(created.success, true, `create ${index}`);
    assert.equal(ids.has(created.sessionId), false, "a closed PTY ID is never reused");
    ids.add(created.sessionId);
    const child = f.ptys[index].child;

    assert.deepEqual(f.manager.close(
      { sender: f.owner }, created.sessionId, created.workspaceKey,
    ), { success: true });
    assert.equal(child.kills, 1, "each PTY is killed once");
    assert.equal(child.dataListeners.size, 0, "data subscriptions are released");
    assert.equal(child.exitListeners.size, 0, "late exit callbacks are detached");
    assert.equal(f.manager.sessions.size, 0, "closed sessions are removed from the manager");
    assert.equal(f.manager.close(
      { sender: f.owner }, created.sessionId, created.workspaceKey,
    ).error.code, "SESSION_UNAVAILABLE");
    assert.equal(child.kills, 1, "a repeated close never kills the same PTY again");
    child.emitExit(0);
    assert.equal(f.manager.sessions.size, 0, "a late exit cannot restore a removed session");
  }
  assert.equal(ids.size, 20);
  assert.equal(f.ptys.length, 20);
  assert.equal(f.manager.pendingCreates.size, 0);
});

test("closing an owner cancels pending PTY creation and releases its reservation", async () => {
  const f = fixture({ workspace: "/projects/pending" });
  const scope = await f.manager.getWorkspaceScope();
  let releaseRealpath;
  const gate = new Promise((resolve) => { releaseRealpath = resolve; });
  f.fakeFs.realpath = async (value) => {
    if (value === "/projects/pending") await gate;
    return value;
  };

  const pending = f.manager.create({ sender: f.owner }, {
    cols: 80, rows: 24, workspaceKey: scope.workspaceKey,
  });
  assert.equal(f.manager.pendingCreates.get(f.owner), 1);
  f.manager.closeForOwner(f.owner);
  releaseRealpath();

  assert.equal((await pending).error.code, "CREATE_CANCELLED");
  assert.equal(f.ptys.length, 0, "cancelled work never spawns a PTY");
  assert.equal(f.manager.sessions.size, 0);
  assert.equal(f.manager.pendingCreates.size, 0);

  assert.equal((await create(f)).success, true, "the manager remains usable after cancellation");
  f.manager.closeAll();
  assert.equal(f.manager.sessions.size, 0);
});

test("a failed spawn can be retried without a stale ID or pending reservation", async () => {
  const f = fixture();
  let attempts = 0;
  f.manager.spawnPty = (shell, args, options) => {
    attempts++;
    if (attempts === 1) throw new Error("posix_spawnp failed.");
    const child = new FakePty();
    f.ptys.push({ shell, args, options, child });
    return child;
  };

  const failed = await create(f);
  assert.equal(failed.error.code, "PTY_SPAWN_FAILED");
  assert.equal(f.manager.pendingCreates.size, 0);
  assert.equal(f.manager.sessions.size, 0);

  const retried = await create(f);
  assert.equal(retried.success, true);
  assert.equal(retried.sessionId, f.manager.sessions.keys().next().value);
  assert.equal(f.manager.pendingCreates.size, 0);
  f.manager.closeAll();
});

test("an unusable resolved working directory fails before native spawn", async () => {
  const f = fixture({ workspace: "/workspace that disappeared" });
  f.fakeFs.stat = async () => ({ isDirectory: () => false });

  const result = await create(f);
  assert.equal(result.error.code, "INVALID_CWD");
  assert.match(result.error.message, /working folder is unavailable/i);
  assert.equal(f.ptys.length, 0);
  assert.equal(f.manager.pendingCreates.size, 0);
});

test("PTY spawn errors are classified from established evidence and logged without environment values", async () => {
  const logs = [];
  const f = fixture({
    logger: { error: (...values) => logs.push(values) },
    spawn: () => { throw new Error("posix_spawn failed: Too many open files"); },
  });
  const result = await create(f);
  assert.equal(result.error.code, "PTY_RESOURCE_EXHAUSTED");
  assert.match(result.error.message, /system cannot allocate/i);
  assert.equal(f.manager.pendingCreates.size, 0);
  assert.equal(f.manager.sessions.size, 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], "[Terminal] Failed to create PTY session");
  assert.equal(logs[0][1].cause.message, "posix_spawn failed: Too many open files");
  assert.equal(logs[0][1].cwd, "/workspace with accents/é");
  assert.equal(logs[0][1].shellExecutable, "/configured shell/Terminal");
  assert.equal(logs[0][1].activeSessions, 0);
  assert.equal(logs[0][1].pendingCreates, 1);
  assert.equal("env" in logs[0][1], false);
  assert.equal("PATH" in logs[0][1], false);

  assert.equal(classifyPtySpawnFailure(new Error("posix_spawnp failed."), null), "PTY_SPAWN_FAILED");
  assert.equal(classifyPtySpawnFailure(new Error("Argument list too long"), null), "PTY_SPAWN_FAILED");
});

test("macOS spawn-helper diagnostics distinguish missing and non-executable helpers", () => {
  const nonExecutable = inspectPtySpawnHelper("darwin", "arm64", {
    existsSync: (file) => file.endsWith("/prebuilds/darwin-arm64/pty.node"),
    statSync: () => ({ mode: 0o100644 }),
    accessSync: () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); },
  });
  assert.equal(nonExecutable.status, "not-executable");
  assert.equal(nonExecutable.permissions, "644");
  assert.match(nonExecutable.path, /prebuilds\/darwin-arm64\/spawn-helper$/);
  assert.equal(classifyPtySpawnFailure(new Error("posix_spawnp failed."), nonExecutable), "PTY_HELPER_NOT_EXECUTABLE");

  const missingHelper = inspectPtySpawnHelper("darwin", "arm64", {
    existsSync: (file) => file.endsWith("/prebuilds/darwin-arm64/pty.node"),
    statSync: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    accessSync: () => { throw Error("missing"); },
  });
  assert.equal(missingHelper.status, "unavailable");
  assert.equal(classifyPtySpawnFailure(new Error("posix_spawnp failed."), missingHelper), "PTY_HELPER_UNAVAILABLE");

  const missing = inspectPtySpawnHelper("darwin", "x64", {
    existsSync: () => false,
    statSync: () => { throw Error("missing"); },
    accessSync: () => { throw Error("missing"); },
  });
  assert.equal(missing.status, "unavailable");
  assert.equal(classifyPtySpawnFailure(new Error("posix_spawnp failed."), missing), "PTY_HELPER_UNAVAILABLE");
  assert.equal(inspectPtySpawnHelper("linux", "x64").status, "not-applicable");
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

test("terminal sessions retain an immutable canonical workspace owner across switches", async () => {
  const f = fixture({ workspace: "/projects/a" });
  const first = await create(f);
  f.setWorkspace("/projects/b");
  const second = await create(f);
  assert.notEqual(first.workspaceKey, second.workspaceKey);
  assert.deepEqual(f.manager.write(
    { sender: f.owner }, first.sessionId, first.workspaceKey, "echo a\r",
  ), { success: true });
  assert.equal(f.manager.write(
    { sender: f.owner }, first.sessionId, second.workspaceKey, "echo leaked\r",
  ).error.code, "SESSION_UNAVAILABLE");
  assert.equal(f.ptys[0].options.cwd, "/projects/a");
  assert.equal(f.ptys[1].options.cwd, "/projects/b");
  assert.equal(f.manager.close({ sender: f.owner }, first.sessionId, second.workspaceKey).success, false);
  assert.equal(f.manager.close({ sender: f.owner }, first.sessionId, first.workspaceKey).success, true);
});

test("workspace scope keys resolve symlinks and normalize Windows casing", async () => {
  const posix = fixture({ workspace: "/alias/project" });
  posix.fakeFs.realpath = async (value) => value === "/alias/project"
    ? "/real/project" : value;
  assert.equal((await posix.manager.getWorkspaceScope()).workspaceKey, "/real/project");

  const owner = new FakeWebContents();
  const windows = new TerminalManager({
    owner,
    platform: "win32",
    env: {},
    homeDir: "C:\\Users\\Test",
    getWorkspacePath: () => "C:\\Work\\Alias",
    getShellSetting: () => "",
    fs: {
      access: async () => {},
      realpath: async (value) => value.toLowerCase().includes("work")
        ? "C:\\Work\\Canonical" : value,
      stat: async () => ({ isDirectory: () => true }),
    },
    spawn: () => new FakePty(),
    logger: { error() {} },
  });
  const scope = await windows.getWorkspaceScope();
  assert.equal(scope.workspaceKey, "c:\\work\\canonical");
  assert.equal(scope.workspacePath, "C:\\Work\\Alias");
});

test("No Workspace has an isolated identity and cannot silently adopt a later project", async () => {
  const f = fixture({ workspace: null });
  const home = await create(f);
  assert.equal(home.workspaceKey, "no-workspace");
  assert.equal(f.ptys[0].options.cwd, "/home/test");
  f.setWorkspace("/projects/new");
  const project = await create(f);
  assert.notEqual(project.workspaceKey, home.workspaceKey);
  assert.equal(f.ptys[1].options.cwd, "/projects/new");
});

test("a create request captures its workspace before asynchronous shell setup", async () => {
  const f = fixture({ workspace: "/projects/a" });
  const scopeA = await f.manager.getWorkspaceScope();
  let releaseRealpath;
  const realpathGate = new Promise((resolve) => { releaseRealpath = resolve; });
  f.fakeFs.realpath = async (value) => {
    if (value === "/projects/a") await realpathGate;
    return value;
  };
  const pending = f.manager.create({ sender: f.owner }, {
    cols: 80, rows: 24, workspaceKey: scopeA.workspaceKey,
  });
  f.setWorkspace("/projects/b");
  releaseRealpath();
  const result = await pending;
  assert.equal(result.success, true);
  assert.equal(result.workspaceKey, scopeA.workspaceKey);
  assert.equal(f.ptys[0].options.cwd, "/projects/a");
});

test("TerminalManager limits concurrent session creation and isolates session ownership", async () => {
  const f = fixture();
  const pending = Array.from({ length: terminalLimits.maxSessions + 2 }, () => create(f));
  const results = await Promise.all(pending);
  assert.equal(results.filter((item) => item.success).length, terminalLimits.maxSessions);
  assert.equal(results.filter((item) => item.error?.code === "SESSION_LIMIT").length, 2);
  assert.equal(f.ptys.length, terminalLimits.maxSessions);
  const first = results.find((item) => item.success);
  assert.equal(f.manager.write({ sender: f.attacker }, first.sessionId, first.workspaceKey, "echo nope" ).error.code, "UNAUTHORIZED");
  assert.equal(f.manager.write({ sender: f.owner }, first.sessionId, first.workspaceKey, "x".repeat(terminalLimits.maxWriteBytes + 1)).error.code, "INVALID_INPUT");
  assert.equal(f.manager.resize({ sender: f.owner }, first.sessionId, first.workspaceKey, 0, 24).error.code, "INVALID_SIZE");
  assert.deepEqual(f.manager.resize({ sender: f.owner }, first.sessionId, first.workspaceKey, 132, 42), { success: true });
  assert.deepEqual(f.ptys[0].child.resizes, [[132, 42]]);
  assert.deepEqual(f.manager.write({ sender: f.owner }, first.sessionId, first.workspaceKey, "echo ok\r"), { success: true });
  assert.equal(f.manager.write({ sender: f.owner }, first.sessionId, "another-workspace", "echo leaked\r").error.code, "SESSION_UNAVAILABLE");
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
  assert.equal(f.manager.ack({ sender: f.owner }, result.sessionId, result.workspaceKey, output.sequence + 1).error.code, "STALE_ACK");

  const reconstructed = [output.data];
  while (true) {
    const acked = f.manager.ack({ sender: f.owner }, result.sessionId, result.workspaceKey, output.sequence);
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
    f.manager.ack({ sender: f.owner }, result.sessionId, result.workspaceKey, current.sequence);
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
    f.manager.ack({ sender: f.owner }, result.sessionId, result.workspaceKey, output.sequence);
    output = f.owner.take("Terminal:output");
  }
  assert.equal(chunks.join(""), expected);
  assert.deepEqual(f.owner.take("Terminal:exit"), {
    sessionId: result.sessionId, workspaceKey: result.workspaceKey, exitCode: 0, signal: null,
  });
});

test("TerminalSession stops safely on output overflow, reports exit, and cleans up idempotently", async () => {
  const f = fixture();
  const result = await create(f);
  const child = f.ptys[0].child;
  child.emitData("x".repeat(terminalLimits.maxOutputBytes + 1));
  assert.equal(f.owner.take("Terminal:error").error.code, "OUTPUT_LIMIT");
  assert.equal(child.kills, 1);
  assert.equal(f.manager.write({ sender: f.owner }, result.sessionId, result.workspaceKey, "still running" ).error.code, "SESSION_EXITED");
  assert.deepEqual(f.manager.close({ sender: f.owner }, result.sessionId, result.workspaceKey), { success: true });
  assert.equal(f.manager.close({ sender: f.owner }, result.sessionId, result.workspaceKey).error.code, "SESSION_UNAVAILABLE");
  assert.equal(child.kills, 1, "close after overflow is idempotent");

  const next = await create(f);
  const nextChild = f.ptys[1].child;
  nextChild.emitExit(7, 2);
  assert.deepEqual(f.owner.take("Terminal:exit"), {
    sessionId: next.sessionId, workspaceKey: next.workspaceKey, exitCode: 7, signal: 2,
  });
  assert.equal(f.manager.write({ sender: f.owner }, next.sessionId, next.workspaceKey, "no" ).error.code, "SESSION_EXITED");
  f.owner.destroyed = true;
  f.manager.closeForOwner(f.owner);
  assert.equal(nextChild.kills, 0, "an exited process is not killed again");
});

test("TerminalManager closes all sessions belonging to a reloaded or destroyed window", async () => {
  const f = fixture();
  const first = await create(f);
  const second = await create(f);
  assert.equal(f.manager.close({ sender: f.owner }, first.sessionId, first.workspaceKey).success, true);
  assert.equal(f.ptys[0].child.kills, 1);
  f.manager.closeForOwner(f.owner);
  f.manager.closeForOwner(f.owner);
  assert.equal(f.ptys[1].child.kills, 1);
  assert.equal(f.manager.write({ sender: f.owner }, second.sessionId, second.workspaceKey, "no").error.code, "SESSION_UNAVAILABLE");
});
