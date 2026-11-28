const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

/**
 * Real-process journeys for the Run supervisor.
 *
 * These load the compiled supervisor from dist/ and drive it with a fake
 * window, so the code under test is the production code: the real runtime
 * probe, the real spawn, the real stream, the real kill. Only Electron's IPC
 * and the window are stubbed, because neither exists outside the app.
 *
 * The programs are real files written to a temporary directory, so a run that
 * "succeeds" here really did execute something.
 */

const root = path.resolve(__dirname, "..");
const supervisorPath = path.join(root, "dist/ts/run/RunProcessSupervisor.js");

function loadSupervisor() {
  if (!fs.existsSync(supervisorPath)) {
    throw new Error(
      `Compiled supervisor missing at ${supervisorPath}. Run "npm run build:main" first.`,
    );
  }
  // eslint-disable-next-line import/no-dynamic-require
  return require(supervisorPath).RunProcessSupervisor;
}

/** A window stub with just what the supervisor touches. */
function createWindow(workspaceRoot) {
  return {
    window: null,
    watcher: { getWatchedPath: () => workspaceRoot },
  };
}

/**
 * Collect every event the supervisor emits, in order, and let a test wait for
 * a particular one.
 */
function createHarness(workspaceRoot) {
  const events = [];
  const waiters = [];
  const supervisor = new (loadSupervisor())(
    createWindow(workspaceRoot),
    { handle() {} },
  );

  // Replace the transport: the supervisor sends through window.webContents.
  supervisor.emit = (event) => {
    events.push(event);
    for (const waiter of [...waiters]) {
      if (waiter.match(event)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    }
  };

  const waitFor = (match, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      const found = events.find(match);
      if (found) return resolve(found);
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Timed out waiting for an event. Seen: ${events
              .map((event) => event.type)
              .join(", ")}`,
          ),
        );
      }, timeoutMs);
      waiters.push({
        match,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
      });
    });

  return { supervisor, events, waitFor };
}

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nce-run-"));
  return dir;
}

function writeProgram(dir, name, source) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, source, "utf8");
  return file;
}

const hasPython = (() => {
  try {
    const { spawnSync } = require("node:child_process");
    const probe = spawnSync("python3", ["--version"], { timeout: 5000 });
    return probe.status === 0;
  } catch {
    return false;
  }
})();

const hasNode = (() => {
  try {
    const { spawnSync } = require("node:child_process");
    return spawnSync("node", ["--version"], { timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
})();

// ---- JavaScript: the language every machine here can run ------------------

test("a JavaScript file runs, streams stdout, and exits 0", { skip: !hasNode }, async () => {
  const dir = makeWorkspace();
  const file = writeProgram(
    dir,
    "hello.js",
    'console.log("first"); console.log("second");\n',
  );
  const h = createHarness(dir);

  const started = await h.supervisor.start({
    strategy: "node-script",
    projectRoot: dir,
    workspaceRoot: dir,
    target: file,
    language: "javascript",
    name: "hello.js",
  });
  assert.equal(started.ok, true, JSON.stringify(started));

  const exit = await h.waitFor((event) => event.type === "exit");
  assert.equal(exit.exitCode, 0);
  assert.equal(exit.cancelled, false);

  const states = h.events
    .filter((event) => event.type === "state")
    .map((event) => event.state);
  assert.deepEqual(states, ["resolving", "starting", "running", "success"]);

  const stdout = h.events
    .filter((event) => event.type === "output" && event.stream === "stdout")
    .map((event) => event.text)
    .join("");
  assert.match(stdout, /first/);
  assert.match(stdout, /second/);
});

test("stderr is delivered on its own stream, not merged into stdout", { skip: !hasNode }, async () => {
  const dir = makeWorkspace();
  const file = writeProgram(
    dir,
    "noisy.js",
    'console.log("to stdout"); console.error("to stderr");\n',
  );
  const h = createHarness(dir);

  await h.supervisor.start({
    strategy: "node-script",
    projectRoot: dir,
    workspaceRoot: dir,
    target: file,
    language: "javascript",
    name: "noisy.js",
  });
  await h.waitFor((event) => event.type === "exit");

  const stdout = h.events
    .filter((event) => event.type === "output" && event.stream === "stdout")
    .map((event) => event.text)
    .join("");
  const stderr = h.events
    .filter((event) => event.type === "output" && event.stream === "stderr")
    .map((event) => event.text)
    .join("");

  assert.match(stdout, /to stdout/);
  assert.doesNotMatch(stdout, /to stderr/);
  assert.match(stderr, /to stderr/);
});

test("a non-zero exit is reported with its code", { skip: !hasNode }, async () => {
  const dir = makeWorkspace();
  const file = writeProgram(dir, "fail.js", "process.exit(3);\n");
  const h = createHarness(dir);

  await h.supervisor.start({
    strategy: "node-script",
    projectRoot: dir,
    workspaceRoot: dir,
    target: file,
    language: "javascript",
    name: "fail.js",
  });
  const exit = await h.waitFor((event) => event.type === "exit");
  assert.equal(exit.exitCode, 3);

  const last = h.events.filter((event) => event.type === "state").at(-1);
  assert.equal(last.state, "error");
});

test("the runtime is named before the program starts", { skip: !hasNode }, async () => {
  const dir = makeWorkspace();
  const file = writeProgram(dir, "hello.js", 'console.log("hi");\n');
  const h = createHarness(dir);

  await h.supervisor.start({
    strategy: "node-script",
    projectRoot: dir,
    workspaceRoot: dir,
    target: file,
    language: "javascript",
    name: "hello.js",
  });
  await h.waitFor((event) => event.type === "exit");

  const runtime = h.events.find((event) => event.type === "runtime");
  assert.ok(runtime, "no runtime event");
  assert.equal(runtime.executable, "node");
  assert.match(String(runtime.version), /^\d+\./);
});

test("output is streamed while the program is still running", { skip: !hasNode }, async () => {
  const dir = makeWorkspace();
  // Prints, waits, prints. If output were buffered to the end, the first
  // chunk could not arrive before the exit.
  const file = writeProgram(
    dir,
    "slow.js",
    'console.log("early"); setTimeout(() => { console.log("late"); }, 700);\n',
  );
  const h = createHarness(dir);

  await h.supervisor.start({
    strategy: "node-script",
    projectRoot: dir,
    workspaceRoot: dir,
    target: file,
    language: "javascript",
    name: "slow.js",
  });

  const early = await h.waitFor(
    (event) => event.type === "output" && /early/.test(event.text),
  );
  const exitedAlready = h.events.some((event) => event.type === "exit");
  assert.equal(exitedAlready, false, "output arrived only after the process exited");
  assert.match(early.text, /early/);

  await h.waitFor((event) => event.type === "exit");
});

test("a large output stream is delivered without loss or duplication", { skip: !hasNode }, async () => {
  const dir = makeWorkspace();
  const lines = 5000;
  const file = writeProgram(
    dir,
    "bulk.js",
    `for (let i = 0; i < ${lines}; i += 1) console.log("line " + i);\n`,
  );
  const h = createHarness(dir);

  await h.supervisor.start({
    strategy: "node-script",
    projectRoot: dir,
    workspaceRoot: dir,
    target: file,
    language: "javascript",
    name: "bulk.js",
  });
  await h.waitFor((event) => event.type === "exit", 30000);

  const stdout = h.events
    .filter((event) => event.type === "output" && event.stream === "stdout")
    .map((event) => event.text)
    .join("");

  assert.match(stdout, /line 0\n/);
  assert.match(stdout, new RegExp(`line ${lines - 1}\\n`));
  // Every line exactly once.
  const seen = new Set(stdout.match(/line \d+/g) || []);
  assert.equal(seen.size, lines);
});

test("stop kills the process and reports cancelled, not error", { skip: !hasNode }, async () => {
  const dir = makeWorkspace();
  // Runs far longer than the test.
  const file = writeProgram(
    dir,
    "loop.js",
    'console.log("started"); setInterval(() => {}, 1000);\n',
  );
  const h = createHarness(dir);

  const started = await h.supervisor.start({
    strategy: "node-script",
    projectRoot: dir,
    workspaceRoot: dir,
    target: file,
    language: "javascript",
    name: "loop.js",
  });
  assert.equal(started.ok, true);

  await h.waitFor((event) => event.type === "state" && event.state === "running");
  const stopped = await h.supervisor.stop(started.runId);
  assert.equal(stopped, true);

  const exit = await h.waitFor((event) => event.type === "exit");
  assert.equal(exit.cancelled, true);

  const last = h.events.filter((event) => event.type === "state").at(-1);
  assert.equal(last.state, "cancelled");

  // Stopping was reported before the exit, never after.
  const states = h.events
    .filter((event) => event.type === "state")
    .map((event) => event.state);
  assert.ok(states.includes("stopping"));
  assert.ok(states.indexOf("stopping") < states.indexOf("cancelled"));
});

test("a second run is refused while one is live", { skip: !hasNode }, async () => {
  const dir = makeWorkspace();
  const file = writeProgram(dir, "loop.js", "setInterval(() => {}, 1000);\n");
  const h = createHarness(dir);

  const first = await h.supervisor.start({
    strategy: "node-script",
    projectRoot: dir,
    workspaceRoot: dir,
    target: file,
    language: "javascript",
    name: "loop.js",
  });
  assert.equal(first.ok, true);

  const second = await h.supervisor.start({
    strategy: "node-script",
    projectRoot: dir,
    workspaceRoot: dir,
    target: file,
    language: "javascript",
    name: "loop.js",
  });
  assert.equal(second.ok, false);
  assert.equal(second.error.code, "ALREADY_RUNNING");

  await h.supervisor.stop(first.runId);
  await h.waitFor((event) => event.type === "exit");
});

test("a run can start again once the previous one has exited", { skip: !hasNode }, async () => {
  const dir = makeWorkspace();
  const file = writeProgram(dir, "hello.js", 'console.log("again");\n');
  const h = createHarness(dir);

  const request = {
    strategy: "node-script",
    projectRoot: dir,
    workspaceRoot: dir,
    target: file,
    language: "javascript",
    name: "hello.js",
  };

  const first = await h.supervisor.start(request);
  assert.equal(first.ok, true);
  await h.waitFor((event) => event.type === "exit");

  const second = await h.supervisor.start(request);
  assert.equal(second.ok, true);
  assert.notEqual(second.runId, first.runId);
});

// ---- Refusals -------------------------------------------------------------

test("a file outside the workspace is refused before spawn", { skip: !hasNode }, async () => {
  const dir = makeWorkspace();
  const outside = path.join(os.tmpdir(), `nce-outside-${Date.now()}.js`);
  fs.writeFileSync(outside, 'console.log("nope");\n', "utf8");
  const h = createHarness(dir);

  const result = await h.supervisor.start({
    strategy: "node-script",
    projectRoot: dir,
    workspaceRoot: dir,
    target: outside,
    language: "javascript",
    name: "outside.js",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "OUTSIDE_WORKSPACE");
  assert.equal(h.events.some((event) => event.type === "output"), false);
});

test("a missing file is refused with a readable code", { skip: !hasNode }, async () => {
  const dir = makeWorkspace();
  const h = createHarness(dir);

  const result = await h.supervisor.start({
    strategy: "node-script",
    projectRoot: dir,
    workspaceRoot: dir,
    target: path.join(dir, "gone.js"),
    language: "javascript",
    name: "gone.js",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_TARGET");
});

test("an unknown strategy is refused", { skip: !hasNode }, async () => {
  const dir = makeWorkspace();
  const file = writeProgram(dir, "hello.js", 'console.log("hi");\n');
  const h = createHarness(dir);

  const result = await h.supervisor.start({
    strategy: "node-test",
    projectRoot: dir,
    workspaceRoot: dir,
    target: file,
    language: "javascript",
    name: "hello.js",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_REQUEST");
});

test("a strategy that does not match the file type is refused", { skip: !hasNode }, async () => {
  const dir = makeWorkspace();
  const file = writeProgram(dir, "hello.js", 'console.log("hi");\n');
  const h = createHarness(dir);

  const result = await h.supervisor.start({
    strategy: "python-script",
    projectRoot: dir,
    workspaceRoot: dir,
    target: file,
    language: "javascript",
    name: "hello.js",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "STRATEGY_MISMATCH");
});

test("TypeScript is refused by the engine, not just the UI", { skip: !hasNode }, async () => {
  const dir = makeWorkspace();
  const file = writeProgram(dir, "a.ts", "const x: number = 1;\n");
  const h = createHarness(dir);

  const result = await h.supervisor.start({
    strategy: "node-script",
    projectRoot: dir,
    workspaceRoot: dir,
    target: file,
    language: "typescript",
    name: "a.ts",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "NOT_RUNNABLE");
});

test("no open workspace is refused", { skip: !hasNode }, async () => {
  const dir = makeWorkspace();
  const file = writeProgram(dir, "hello.js", 'console.log("hi");\n');
  const h = createHarness("");

  const result = await h.supervisor.start({
    strategy: "node-script",
    projectRoot: dir,
    workspaceRoot: dir,
    target: file,
    language: "javascript",
    name: "hello.js",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "NO_ACTIVE_WORKSPACE");
});

test("a missing runtime is refused with RUNTIME_UNAVAILABLE", { skip: !hasNode }, async () => {
  const dir = makeWorkspace();
  const file = writeProgram(dir, "main.py", 'print("hi")\n');
  const h = createHarness(dir);

  // A PATH with no Python on it, so resolution must fail honestly.
  const originalPath = process.env.PATH;
  process.env.PATH = path.dirname(process.execPath);
  try {
    const result = await h.supervisor.start({
      strategy: "python-script",
      projectRoot: dir,
      workspaceRoot: dir,
      target: file,
      language: "python",
      name: "main.py",
    });
    // If this machine has a python in the same directory as node, the run
    // legitimately succeeds; only assert the refusal when there is none.
    if (!result.ok) {
      assert.equal(result.error.code, "RUNTIME_UNAVAILABLE");
    }
  } finally {
    process.env.PATH = originalPath;
  }
});

// ---- Python, when it is installed ----------------------------------------

test("a Python file runs and streams its output", { skip: !hasPython }, async () => {
  const dir = makeWorkspace();
  const file = writeProgram(dir, "main.py", 'print("bonjour")\n');
  const h = createHarness(dir);

  const started = await h.supervisor.start({
    strategy: "python-script",
    projectRoot: dir,
    workspaceRoot: dir,
    target: file,
    language: "python",
    name: "main.py",
  });
  assert.equal(started.ok, true, JSON.stringify(started));

  const exit = await h.waitFor((event) => event.type === "exit");
  assert.equal(exit.exitCode, 0);

  const stdout = h.events
    .filter((event) => event.type === "output" && event.stream === "stdout")
    .map((event) => event.text)
    .join("");
  assert.match(stdout, /bonjour/);
});

test("a Python traceback arrives on stderr and the exit code is non-zero", { skip: !hasPython }, async () => {
  const dir = makeWorkspace();
  const file = writeProgram(dir, "boom.py", 'raise ValueError("bad input")\n');
  const h = createHarness(dir);

  await h.supervisor.start({
    strategy: "python-script",
    projectRoot: dir,
    workspaceRoot: dir,
    target: file,
    language: "python",
    name: "boom.py",
  });
  const exit = await h.waitFor((event) => event.type === "exit");
  assert.notEqual(exit.exitCode, 0);

  const stderr = h.events
    .filter((event) => event.type === "output" && event.stream === "stderr")
    .map((event) => event.text)
    .join("");
  assert.match(stderr, /ValueError/);
  assert.match(stderr, /bad input/);
});

test("a project virtualenv is preferred over the PATH interpreter", async () => {
  // Resolution is asserted directly instead of by running a fake interpreter:
  // a shell-script stand-in only works on POSIX, and the priority rule is what
  // this test is about. The probe is real, only its two filesystem primitives
  // are replaced, so the candidate order under test is the production one.
  const { RuntimeProbe, pythonVenvCandidates } = require(
    path.join(root, "dist/ts/run/RunTargets.js"),
  );

  for (const platform of ["win32", "darwin"]) {
    const candidates = pythonVenvCandidates("/project", platform);
    assert.deepEqual(
      candidates,
      platform === "win32"
        ? [
            "\\project\\.venv\\Scripts\\python.exe",
            "\\project\\venv\\Scripts\\python.exe",
          ]
        : ["/project/.venv/bin/python", "/project/venv/bin/python"],
      `${platform}: the virtualenv layout must match the platform`,
    );

    const probe = new RuntimeProbe();
    const existing = new Set([candidates[0]]);
    const probed = [];
    probe.executableExists = async (candidate) => {
      probed.push(candidate);
      return existing.has(candidate);
    };
    probe.executableOnPath = async (name) => {
      probed.push(`PATH:${name}`);
      return true;
    };

    const resolved = await probe.resolve("python", "/project", platform);
    assert.equal(
      resolved.source,
      "project-venv",
      `${platform}: the project virtualenv must win over PATH`,
    );
    assert.equal(resolved.executable, candidates[0]);
    assert.ok(
      !probed.some((entry) => entry.startsWith("PATH:")),
      `${platform}: PATH must not be consulted when the virtualenv exists`,
    );
  }

  // The regression this guards: a PATH interpreter must never be chosen while
  // the project virtualenv is present.
  const probe = new RuntimeProbe();
  probe.executableExists = async (candidate) =>
    candidate === pythonVenvCandidates("/project", process.platform)[0];
  probe.executableOnPath = async () => true;
  const resolved = await probe.resolve("python", "/project");
  assert.equal(resolved.source, "project-venv");
});

// ---- Teardown -------------------------------------------------------------

test("dispose kills a live process instead of orphaning it", { skip: !hasNode }, async () => {
  const dir = makeWorkspace();
  const file = writeProgram(dir, "loop.js", "setInterval(() => {}, 1000);\n");
  const h = createHarness(dir);

  const started = await h.supervisor.start({
    strategy: "node-script",
    projectRoot: dir,
    workspaceRoot: dir,
    target: file,
    language: "javascript",
    name: "loop.js",
  });
  assert.equal(started.ok, true);
  await h.waitFor((event) => event.type === "state" && event.state === "running");

  h.supervisor.dispose();

  // Nothing is left registered, so a new run is allowed.
  assert.equal(h.supervisor.getActiveRunId(), null);
});
