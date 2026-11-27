const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobals } = require("./helpers/runtime");

/**
 * A DOM small enough to reason about but faithful enough to catch real bugs:
 * text nodes track their own data, so an append that rewrites the whole log
 * instead of appending would show up as a wrong string here.
 */
class FakeText {
  constructor(data) {
    this.data = String(data);
    this.parent = null;
  }
  appendData(text) {
    this.data += String(text);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.parent = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.title = "";
    this._text = "";
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.tabIndex = 0;
    this._classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this._classes.add(name)),
      remove: (...names) => names.forEach((name) => this._classes.delete(name)),
      contains: (name) => this._classes.has(name),
      toggle: (name, on) => (on ? this._classes.add(name) : this._classes.delete(name)),
    };
  }

  /**
   * textContent behaves as it does in a browser: setting it replaces the
   * children with a single text node, so renderedText sees it.
   */
  get textContent() {
    return this._text;
  }
  set textContent(value) {
    this._text = String(value);
    this.children = this._text ? [new FakeText(this._text)] : [];
  }

  get className() {
    return [...this._classes].join(" ");
  }
  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node && typeof node === "object") node.parent = this;
      this.children.push(node);
    }
  }
  appendChild(node) {
    this.append(node);
    return node;
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  focus() {
    this.document.activeElement = this;
  }
  click() {
    for (const listener of [...(this.listeners.get("click") || [])]) listener({ target: this });
  }

  /** Only the empty-state lookup is used by the view, but it must recurse. */
  querySelector(selector) {
    if (selector !== ".run-panel-empty") return null;
    const className = "run-panel-empty";
    const walk = (node) => {
      for (const child of node.children) {
        if (!(child instanceof FakeElement)) continue;
        if (child.classList.contains(className)) return child;
        const deeper = walk(child);
        if (deeper) return deeper;
      }
      return null;
    };
    return walk(this);
  }

  /** Flattened text, which is what the user actually reads. */
  get renderedText() {
    return this.children
      .map((child) => {
        if (child instanceof FakeText) return child.data;
        if (child instanceof FakeElement) return child.renderedText;
        return "";
      })
      .join("");
  }
}

function createDocument() {
  const document = { activeElement: null };
  document.createElement = (tagName) => {
    const element = new FakeElement(tagName);
    element.document = document;
    return element;
  };
  document.createTextNode = (data) => {
    const node = new FakeText(data);
    node.document = document;
    return node;
  };
  return document;
}

function fileNode(overrides = {}) {
  return {
    id: 1,
    name: "main.py",
    path: "/project/main.py",
    language: "python",
    isSaved: true,
    ...overrides,
  };
}

function setup({ file, root = "/project", api = {} } = {}) {
  const document = createDocument();
  const globals = loadGlobals(
    ["src/js/run/RunController.js", "src/js/run/RunPanel.js"],
    "RunPanel",
    { document, window: {} },
  );
  const editor = {
    api,
    fileExplorer: { rootPath: root },
    tabManager: { activeFile: file },
    openVersionManager() {
      editor.versionManagerOpened = (editor.versionManagerOpened || 0) + 1;
    },
  };
  return { editor, RunPanel: globals, document };
}

/** Drive the panel through a full run using a controllable fake API. */
function harness(options = {}) {
  const calls = [];
  let emit = null;
  const api = {
    onRunEvent(callback) {
      emit = callback;
      return () => { emit = null; };
    },
    async startRun(request) {
      calls.push(["start", request]);
      return { ok: true, runId: "run-1" };
    },
    async stopRun(runId) {
      calls.push(["stop", runId]);
      return true;
    },
    ...options.api,
  };
  const { editor, RunPanel } = setup({ ...options, api });
  const panel = new RunPanel(editor);
  return {
    panel,
    editor,
    calls,
    send: (event) => emit?.(event),
    get emitting() { return Boolean(emit); },
  };
}

// ---- target eligibility ---------------------------------------------------

test("a saved Python file is runnable with the python-script strategy", () => {
  const { RunPanel } = setup();
  const target = RunPanel.describeRunTarget(fileNode());
  assert.equal(target.runnable, true);
  assert.equal(target.strategy, "python-script");
  assert.equal(target.label, "Python");
});

test("JavaScript maps to node-script", () => {
  const { RunPanel } = setup();
  for (const name of ["a.js", "a.mjs", "a.cjs"]) {
    const target = RunPanel.describeRunTarget(
      fileNode({ name, language: "javascript" }),
    );
    assert.equal(target.runnable, true, name);
    assert.equal(target.strategy, "node-script");
  }
});

test("TypeScript is refused with an explanation, not offered", () => {
  const { RunPanel } = setup();
  const target = RunPanel.describeRunTarget(
    fileNode({ name: "a.ts", language: "typescript" }),
  );
  assert.equal(target.runnable, false);
  assert.match(target.reason, /build step/);
});

test("an unsaved file explains why it cannot run", () => {
  const { RunPanel } = setup();
  const target = RunPanel.describeRunTarget(fileNode({ isSaved: false }));
  assert.equal(target.runnable, false);
  assert.match(target.reason, /Save the file/);
});

test("an unsupported language is refused with a readable reason", () => {
  const { RunPanel } = setup();
  const target = RunPanel.describeRunTarget(fileNode({ name: "a.rb", language: "ruby" }));
  assert.equal(target.runnable, false);
  assert.match(target.reason, /not supported/);
});

test("a language whose extension does not match is refused", () => {
  const { RunPanel } = setup();
  const target = RunPanel.describeRunTarget(fileNode({ name: "notes.txt", language: "python" }));
  assert.equal(target.runnable, false);
  assert.match(target.reason, /\.py/);
});

test("no open file is refused", () => {
  const { RunPanel } = setup();
  assert.equal(RunPanel.describeRunTarget(null).runnable, false);
});

// ---- running --------------------------------------------------------------

test("running sends a path and a strategy, never a command line", async () => {
  const h = harness({ file: fileNode() });
  const result = await h.panel.run();

  assert.equal(result.success, true);
  assert.equal(h.calls.length, 1);
  const [kind, request] = h.calls[0];
  assert.equal(kind, "start");
  assert.equal(request.strategy, "python-script");
  assert.equal(request.target, "/project/main.py");
  assert.equal(request.projectRoot, "/project");
  assert.equal(request.workspaceRoot, "/project");
  // Nothing executable crosses the boundary.
  assert.equal(request.command, undefined);
  assert.equal(request.args, undefined);
  assert.equal(request.executable, undefined);
});

test("output streams in as events, not as one final blob", async () => {
  const h = harness({ file: fileNode() });
  await h.panel.run();

  h.send({ type: "state", runId: "run-1", state: "running" });
  h.send({ type: "output", runId: "run-1", stream: "stdout", text: "one\n" });
  h.send({ type: "output", runId: "run-1", stream: "stdout", text: "two\n" });

  assert.equal(h.panel.controller.state, "running");
  assert.match(h.panel.log.renderedText, /one/);
  assert.match(h.panel.log.renderedText, /two/);
});

test("stdout and stderr are visually distinct entries", async () => {
  const h = harness({ file: fileNode() });
  await h.panel.run();
  h.send({ type: "output", runId: "run-1", stream: "stdout", text: "ok\n" });
  h.send({ type: "output", runId: "run-1", stream: "stderr", text: "bad\n" });

  const kinds = h.panel.controller.entries.map((entry) => entry.kind);
  assert.equal(kinds.length, 2);
  assert.equal(kinds[0], "stdout");
  assert.equal(kinds[1], "stderr");
  const lines = h.panel.log.children.filter(
    (child) => child instanceof FakeElement && child.classList.contains("run-panel-line"),
  );
  assert.equal(lines.length, 2);
  assert.ok(lines[0].classList.contains("run-panel-line-stdout"));
  assert.ok(lines[1].classList.contains("run-panel-line-stderr"));
});

test("streamed output is appended, never duplicated", async () => {
  const h = harness({ file: fileNode() });
  await h.panel.run();
  h.send({ type: "state", runId: "run-1", state: "running" });
  // One entry, grown three times. A render that rewrote the entry instead of
  // appending the delta would show "aaabbbccc" here.
  h.send({ type: "output", runId: "run-1", stream: "stdout", text: "aaa" });
  h.send({ type: "output", runId: "run-1", stream: "stdout", text: "bbb" });
  h.send({ type: "output", runId: "run-1", stream: "stdout", text: "ccc" });

  assert.equal(h.panel.controller.entries.length, 1);
  assert.equal(h.panel.log.renderedText, "aaabbbccc");
});

test("a system message is marked as NCE talking, not the program", async () => {
  const h = harness({ file: fileNode() });
  await h.panel.run();
  h.send({ type: "system", runId: "run-1", text: "Runtime resolved." });
  const entry = h.panel.controller.entries[0];
  assert.equal(entry.kind, "system");
});

test("the runtime is shown once the main process reports it", async () => {
  const h = harness({ file: fileNode() });
  await h.panel.run();
  h.send({
    type: "runtime",
    runId: "run-1",
    executable: "/project/.venv/bin/python",
    version: "3.12.1",
    source: "project-venv",
  });
  assert.match(h.panel.infoRuntime.textContent, /3\.12\.1/);
  assert.match(h.panel.infoRuntime.textContent, /project venv/);
});

test("a successful run shows Finished and the exit code", async () => {
  const h = harness({ file: fileNode() });
  await h.panel.run();
  h.send({ type: "state", runId: "run-1", state: "running" });
  h.send({
    type: "exit",
    runId: "run-1",
    exitCode: 0,
    signal: null,
    durationMs: 120,
    cancelled: false,
    timedOut: false,
    truncated: false,
  });
  h.send({ type: "state", runId: "run-1", state: "success" });

  assert.equal(h.panel.status.textContent, "Finished");
  assert.equal(h.panel.status.dataset.state, "success");
  assert.match(h.panel.infoResult.textContent, /exit 0/);
  assert.match(h.panel.infoResult.textContent, /120 ms/);
});

test("a non-zero exit shows Failed and the code", async () => {
  const h = harness({ file: fileNode() });
  await h.panel.run();
  h.send({ type: "state", runId: "run-1", state: "running" });
  h.send({
    type: "exit",
    runId: "run-1",
    exitCode: 2,
    signal: null,
    durationMs: 40,
    cancelled: false,
    timedOut: false,
    truncated: false,
  });
  h.send({ type: "state", runId: "run-1", state: "error" });

  assert.equal(h.panel.status.textContent, "Failed");
  assert.match(h.panel.infoResult.textContent, /exit 2/);
  // A program that failed on its own gets no remedy button from NCE.
  assert.equal(h.panel.errorBlock.hidden, true);
});

test("a cancelled run reads Stopped, not Failed", async () => {
  const h = harness({ file: fileNode() });
  await h.panel.run();
  h.send({ type: "state", runId: "run-1", state: "running" });
  h.send({ type: "state", runId: "run-1", state: "stopping" });
  h.send({
    type: "exit",
    runId: "run-1",
    exitCode: null,
    signal: "SIGTERM",
    durationMs: 30,
    cancelled: true,
    timedOut: false,
    truncated: false,
  });
  h.send({ type: "state", runId: "run-1", state: "cancelled" });

  assert.equal(h.panel.status.textContent, "Stopped");
  assert.equal(h.panel.status.dataset.state, "cancelled");
  assert.equal(h.panel.errorBlock.hidden, true);
});

// ---- Stop -----------------------------------------------------------------

test("Stop is hidden until a run is live and returns after it ends", async () => {
  const h = harness({ file: fileNode() });
  assert.equal(h.panel.stopButton.hidden, true);

  await h.panel.run();
  assert.equal(h.panel.stopButton.hidden, false);

  h.send({ type: "state", runId: "run-1", state: "running" });
  assert.equal(h.panel.stopButton.hidden, false);

  h.send({ type: "state", runId: "run-1", state: "success" });
  assert.equal(h.panel.stopButton.hidden, true);
});

test("Stop targets the run id the main process assigned", async () => {
  const h = harness({ file: fileNode() });
  await h.panel.run();
  h.send({ type: "state", runId: "run-1", state: "running" });

  const stopped = await h.panel.stop();
  assert.equal(stopped, true);
  assert.deepEqual(h.calls.at(-1), ["stop", "run-1"]);
});

test("Stop is not offered once the run has ended", async () => {
  const h = harness({ file: fileNode() });
  await h.panel.run();
  h.send({ type: "state", runId: "run-1", state: "success" });
  assert.equal(await h.panel.stop(), false);
});

test("a second run is refused while one is live", async () => {
  const h = harness({ file: fileNode() });
  await h.panel.run();
  h.send({ type: "state", runId: "run-1", state: "running" });
  const second = await h.panel.run();
  assert.equal(second.code, "ALREADY_RUNNING");
  assert.equal(h.calls.length, 1);
});

test("a rapid double click starts exactly one process", async () => {
  const h = harness({ file: fileNode() });
  const first = h.panel.run();
  const second = h.panel.run();
  const [a, b] = await Promise.all([first, second]);
  const starts = h.calls.filter(([kind]) => kind === "start");
  assert.equal(starts.length, 1);
  assert.ok(a.success || b.success);
  assert.ok(a.code === "ALREADY_RUNNING" || b.code === "ALREADY_RUNNING");
});

// ---- Clear ----------------------------------------------------------------

test("Clear empties the log without stopping the process", async () => {
  const h = harness({ file: fileNode() });
  await h.panel.run();
  h.send({ type: "state", runId: "run-1", state: "running" });
  h.send({ type: "output", runId: "run-1", stream: "stdout", text: "before\n" });

  h.panel.clearButton.click();

  assert.equal(h.panel.controller.entries.length, 0);
  assert.equal(h.panel.controller.state, "running");
  // No stop was issued.
  assert.equal(h.calls.filter(([kind]) => kind === "stop").length, 0);
});

test("output keeps arriving after Clear", async () => {
  const h = harness({ file: fileNode() });
  await h.panel.run();
  h.send({ type: "state", runId: "run-1", state: "running" });
  h.send({ type: "output", runId: "run-1", stream: "stdout", text: "before\n" });
  h.panel.clearButton.click();
  h.send({ type: "output", runId: "run-1", stream: "stdout", text: "after\n" });

  assert.match(h.panel.log.renderedText, /after/);
  assert.doesNotMatch(h.panel.log.renderedText, /before/);
});

// ---- Errors ---------------------------------------------------------------

test("a missing runtime offers the Version Manager, and it opens", async () => {
  const h = harness({ file: fileNode() });
  await h.panel.run();
  h.send({
    type: "error",
    runId: "run-1",
    code: "RUNTIME_UNAVAILABLE",
    title: "Cannot run main.py",
    message: "Python was not found on this machine.",
  });
  h.send({ type: "state", runId: "run-1", state: "error" });

  assert.equal(h.panel.errorBlock.hidden, false);
  assert.equal(h.panel.errorTitle.textContent, "Cannot run main.py");
  assert.match(h.panel.errorMessage.textContent, /not found on this machine/);

  const action = h.panel.errorActions.children[0];
  assert.equal(action.textContent, "Open Version Manager");
  action.click();
  assert.equal(h.editor.versionManagerOpened, 1);
});

test("an error with no remedy shows no button", async () => {
  const h = harness({ file: fileNode() });
  await h.panel.run();
  h.send({
    type: "error",
    runId: "run-1",
    code: "SPAWN_FAILED",
    title: "Cannot start the program",
    message: "EACCES: permission denied",
  });
  h.send({ type: "state", runId: "run-1", state: "error" });
  assert.equal(h.panel.errorActions.children.length, 0);
});

test("a refused start is reported in the panel, not swallowed", async () => {
  const h = harness({
    file: fileNode(),
    api: {
      async startRun() {
        return {
          ok: false,
          error: { code: "RUNTIME_UNAVAILABLE", message: "Cannot run main.py\u0000Python was not found." },
        };
      },
    },
  });
  const result = await h.panel.run();
  assert.equal(result.success, false);
  assert.equal(result.code, "RUNTIME_UNAVAILABLE");
  assert.equal(h.panel.controller.state, "error");
  assert.equal(h.panel.errorTitle.textContent, "Cannot run main.py");
  assert.match(h.panel.errorMessage.textContent, /Python was not found/);
});

test("a runner exception becomes a readable failure", async () => {
  const h = harness({
    file: fileNode(),
    api: {
      async startRun() {
        throw new Error("ipc exploded");
      },
    },
  });
  const result = await h.panel.run();
  assert.equal(result.success, false);
  assert.match(h.panel.errorMessage.textContent, /ipc exploded/);
});

// ---- Files ----------------------------------------------------------------

test("an unsaved file is saved before it runs", async () => {
  let saved = 0;
  const file = fileNode({ isSaved: false });
  const h = harness({
    file,
    api: {
      async startRun(request) {
        h.calls.push(["start", request]);
        return { ok: true, runId: "run-1" };
      },
    },
  });
  h.editor.tabManager.saveFileOnce = async (target) => {
    saved += 1;
    target.isSaved = true;
    return true;
  };

  const result = await h.panel.run();
  assert.equal(saved, 1);
  assert.equal(result.success, true);
});

test("a file that cannot be saved is not run", async () => {
  const file = fileNode({ isSaved: false });
  const h = harness({ file });
  h.editor.tabManager.saveFileOnce = async () => false;

  const result = await h.panel.run();
  assert.equal(result.success, false);
  assert.equal(result.code, "NOT_SAVED");
  assert.equal(h.calls.length, 0);
});

test("an unrunnable file never reaches the main process", async () => {
  const h = harness({ file: fileNode({ isSaved: false }) });
  h.editor.tabManager.saveFileOnce = async () => false;
  const result = await h.panel.run();
  assert.equal(result.success, false);
  assert.equal(h.calls.length, 0);
});

test("running without an open folder is refused before the request", async () => {
  const h = harness({ file: fileNode(), root: "" });
  const result = await h.panel.run();
  assert.equal(result.code, "NO_WORKSPACE");
  assert.equal(h.calls.length, 0);
});

test("a tab switch during a run does not disturb it", async () => {
  const h = harness({ file: fileNode() });
  await h.panel.run();
  h.send({ type: "state", runId: "run-1", state: "running" });
  h.send({ type: "output", runId: "run-1", stream: "stdout", text: "still here\n" });

  // The user opens another file.
  h.editor.tabManager.activeFile = fileNode({ id: 2, name: "other.js", language: "javascript" });

  assert.equal(h.panel.controller.state, "running");
  assert.equal(h.panel.controller.target.name, "main.py");
  assert.match(h.panel.log.renderedText, /still here/);
});

// ---- Scrolling ------------------------------------------------------------

test("the view follows new output while the user is at the bottom", async () => {
  const h = harness({ file: fileNode() });
  await h.panel.run();
  h.panel.log.scrollHeight = 500;
  h.panel.log.clientHeight = 200;
  h.panel.log.scrollTop = 300;

  h.panel.syncFollow();
  assert.equal(h.panel.following, true);
  assert.equal(h.panel.jumpButton.hidden, true);
});

test("the view stops following when the user scrolls up, and offers a way back", async () => {
  const h = harness({ file: fileNode() });
  await h.panel.run();
  h.panel.log.scrollHeight = 500;
  h.panel.log.clientHeight = 200;
  h.panel.log.scrollTop = 0;

  h.panel.syncFollow();
  assert.equal(h.panel.following, false);
  assert.equal(h.panel.jumpButton.hidden, false);

  h.panel.jumpButton.click();
  assert.equal(h.panel.following, true);
});

// ---- Empty state ----------------------------------------------------------

test("an idle panel says what it would run", () => {
  const { editor, RunPanel } = setup({ file: fileNode() });
  const panel = new RunPanel(editor);
  assert.match(panel.log.renderedText, /Press Run to execute main\.py/);
});

test("an idle panel explains an unrunnable file", () => {
  const { editor, RunPanel } = setup({ file: fileNode({ language: "ruby", name: "a.rb" }) });
  const panel = new RunPanel(editor);
  assert.match(panel.log.renderedText, /not supported/);
});

test("a run with no output still says so", async () => {
  const h = harness({ file: fileNode() });
  await h.panel.run();
  h.send({ type: "state", runId: "run-1", state: "success" });
  assert.match(h.panel.log.renderedText, /No output/);
});

// ---- Subscriptions --------------------------------------------------------

test("the panel subscribes once and unsubscribes on destroy", () => {
  let subscriptions = 0;
  let unsubscribed = 0;
  const { editor, RunPanel } = setup({
    file: fileNode(),
    api: {
      onRunEvent() {
        subscriptions += 1;
        return () => { unsubscribed += 1; };
      },
    },
  });
  const panel = new RunPanel(editor);
  panel.onOpen();
  panel.onActivate();
  assert.equal(subscriptions, 1);
  panel.destroy();
  assert.equal(unsubscribed, 1);
});
