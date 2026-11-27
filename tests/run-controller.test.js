const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

function controller(options) {
  const RunController = loadGlobal("src/js/run/RunController.js", "RunController", {
    window: {},
  });
  return new RunController(options);
}

const S = {
  IDLE: "idle",
  RESOLVING: "resolving",
  STARTING: "starting",
  RUNNING: "running",
  STOPPING: "stopping",
  SUCCESS: "success",
  ERROR: "error",
  CANCELLED: "cancelled",
};

const target = { id: 1, name: "main.py", path: "/p/main.py", language: "python" };

test("a fresh controller is idle and offers nothing to stop", () => {
  const c = controller();
  assert.equal(c.state, S.IDLE);
  assert.equal(c.isLive, false);
  assert.equal(c.isTerminal, false);
  assert.equal(c.canStop, false);
  assert.equal(c.entries.length, 0);
});

test("begin clears the previous run and enters resolving", () => {
  const c = controller();
  c.begin(target, "run-1");
  assert.equal(c.state, S.RESOLVING);
  assert.equal(c.runId, "run-1");
  assert.equal(c.isLive, true);
  assert.equal(c.canStop, true);
  assert.equal(c.entries.length, 0);
});

test("the lifecycle walks resolving, starting, running, success", () => {
  const c = controller();
  c.begin(target, "run-1");
  c.apply({ type: "state", runId: "run-1", state: "starting" });
  assert.equal(c.state, S.STARTING);
  c.apply({ type: "state", runId: "run-1", state: "running" });
  assert.equal(c.state, S.RUNNING);
  c.apply({
    type: "exit",
    runId: "run-1",
    exitCode: 0,
    signal: null,
    durationMs: 120,
    cancelled: false,
    timedOut: false,
    truncated: false,
  });
  c.apply({ type: "state", runId: "run-1", state: "success" });
  assert.equal(c.state, S.SUCCESS);
  assert.equal(c.isLive, false);
  assert.equal(c.isTerminal, true);
  assert.equal(c.canStop, false);
  assert.equal(c.exit.exitCode, 0);
});

test("a non-zero exit ends in error, not success", () => {
  const c = controller();
  c.begin(target, "run-1");
  c.apply({ type: "state", runId: "run-1", state: "running" });
  c.apply({
    type: "exit",
    runId: "run-1",
    exitCode: 2,
    signal: null,
    durationMs: 40,
    cancelled: false,
    timedOut: false,
    truncated: false,
  });
  c.apply({ type: "state", runId: "run-1", state: "error" });
  assert.equal(c.state, S.ERROR);
  assert.match(c.describe(), /exited with code 2/);
});

test("stopping holds until the process really exits, then reads cancelled", () => {
  const c = controller();
  c.begin(target, "run-1");
  c.apply({ type: "state", runId: "run-1", state: "running" });
  c.apply({ type: "state", runId: "run-1", state: "stopping" });
  assert.equal(c.state, S.STOPPING);
  assert.equal(c.isStopping, true);
  // Stop is no longer offered while the stop is in flight.
  assert.equal(c.canStop, false);

  c.apply({
    type: "exit",
    runId: "run-1",
    exitCode: null,
    signal: "SIGTERM",
    durationMs: 90,
    cancelled: true,
    timedOut: false,
    truncated: false,
  });
  c.apply({ type: "state", runId: "run-1", state: "cancelled" });
  assert.equal(c.state, S.CANCELLED);
  assert.match(c.describe(), /was stopped/);
});

test("a cancelled run is never reported as an error", () => {
  const c = controller();
  c.begin(target, "run-1");
  c.apply({ type: "state", runId: "run-1", state: "running" });
  c.apply({ type: "state", runId: "run-1", state: "stopping" });
  c.apply({
    type: "exit",
    runId: "run-1",
    exitCode: null,
    signal: "SIGTERM",
    durationMs: 10,
    cancelled: true,
    timedOut: false,
    truncated: false,
  });
  c.apply({ type: "state", runId: "run-1", state: "cancelled" });
  assert.notEqual(c.state, S.ERROR);
});

test("a terminal state cannot be resurrected by a late event", () => {
  const c = controller();
  c.begin(target, "run-1");
  c.apply({ type: "state", runId: "run-1", state: "running" });
  c.apply({ type: "state", runId: "run-1", state: "success" });
  c.apply({ type: "state", runId: "run-1", state: "running" });
  assert.equal(c.state, S.SUCCESS);
});

test("events from a previous run are dropped", () => {
  const c = controller();
  c.begin(target, "run-2");
  const accepted = c.apply({
    type: "output",
    runId: "run-1",
    stream: "stdout",
    text: "stale\n",
  });
  assert.equal(accepted, false);
  assert.equal(c.entries.length, 0);
});

test("stdout and stderr stay distinct entries", () => {
  const c = controller();
  c.begin(target, "run-1");
  c.apply({ type: "output", runId: "run-1", stream: "stdout", text: "out\n" });
  c.apply({ type: "output", runId: "run-1", stream: "stderr", text: "err\n" });
  assert.equal(c.entries.length, 2);
  assert.equal(c.entries[0].kind, "stdout");
  assert.equal(c.entries[1].kind, "stderr");
});

test("consecutive chunks on one stream merge into a single entry", () => {
  const c = controller();
  c.begin(target, "run-1");
  c.apply({ type: "output", runId: "run-1", stream: "stdout", text: "a" });
  c.apply({ type: "output", runId: "run-1", stream: "stdout", text: "b" });
  c.apply({ type: "output", runId: "run-1", stream: "stdout", text: "c" });
  assert.equal(c.entries.length, 1);
  assert.equal(c.entries[0].text, "abc");
});

test("a system message never merges into program output", () => {
  const c = controller();
  c.begin(target, "run-1");
  c.apply({ type: "output", runId: "run-1", stream: "stdout", text: "hello\n" });
  c.apply({ type: "system", runId: "run-1", text: "Runtime resolved." });
  assert.equal(c.entries.length, 2);
  assert.equal(c.entries[1].kind, "system");
});

test("the runtime is recorded so the panel can name it", () => {
  const c = controller();
  c.begin(target, "run-1");
  c.apply({
    type: "runtime",
    runId: "run-1",
    executable: "/p/.venv/bin/python",
    version: "3.12.1",
    source: "project-venv",
  });
  assert.equal(c.runtime.executable, "/p/.venv/bin/python");
  assert.equal(c.runtime.version, "3.12.1");
  assert.equal(c.runtime.source, "project-venv");
});

test("an error event carries a title and message for the panel", () => {
  const c = controller();
  c.begin(target, "run-1");
  c.apply({
    type: "error",
    runId: "run-1",
    code: "RUNTIME_UNAVAILABLE",
    title: "Cannot run main.py",
    message: "Python was not found on this machine.",
  });
  assert.equal(c.error.code, "RUNTIME_UNAVAILABLE");
  assert.equal(c.error.title, "Cannot run main.py");
  assert.equal(c.entries[0].kind, "error");
});

test("clear empties the log but leaves the run untouched", () => {
  const c = controller();
  c.begin(target, "run-1");
  c.apply({ type: "state", runId: "run-1", state: "running" });
  c.apply({ type: "output", runId: "run-1", stream: "stdout", text: "x\n" });
  c.clear();
  assert.equal(c.entries.length, 0);
  assert.equal(c.state, S.RUNNING);
  assert.equal(c.runId, "run-1");
});

test("the log is capped so a chatty program cannot grow without bound", () => {
  const c = controller();
  c.begin(target, "run-1");
  // Alternate streams so each chunk is its own entry, then exceed the cap.
  for (let index = 0; index < 20050; index += 1) {
    c.apply({
      type: "output",
      runId: "run-1",
      stream: index % 2 === 0 ? "stdout" : "stderr",
      text: "x",
    });
  }
  assert.ok(c.entries.length <= 20000, `entries=${c.entries.length}`);
  assert.ok(c.droppedEntries > 0);
});

test("duration formatting is readable at every scale", () => {
  const RunController = loadGlobal("src/js/run/RunController.js", "RunController", {
    window: {},
  });
  assert.equal(RunController.formatDuration(12), "12 ms");
  assert.equal(RunController.formatDuration(1500), "1.50 s");
  assert.equal(RunController.formatDuration(65000), "1 min 5 s");
  assert.equal(RunController.formatDuration(-1), "");
  assert.equal(RunController.formatDuration(undefined), "");
});

test("onChange fires for state changes and onEntry for output", () => {
  let changes = 0;
  const entries = [];
  const c = controller({
    onChange: () => { changes += 1; },
    onEntry: (entry, kind) => entries.push([kind, entry.text]),
  });
  c.begin(target, "run-1");
  c.apply({ type: "output", runId: "run-1", stream: "stdout", text: "hi\n" });
  assert.ok(changes >= 1);
  assert.deepEqual(entries, [["stdout", "hi\n"]]);
});
