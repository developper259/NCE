const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

/** Minimal element good enough for the Run panel's DOM usage. */
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
    this.textContent = "";
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.tabIndex = 0;
    this._classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this._classes.add(name)),
      remove: (...names) => names.forEach((name) => this._classes.delete(name)),
      contains: (name) => this._classes.has(name),
    };
  }

  get className() { return [...this._classes].join(" "); }
  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  append(...children) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  appendChild(child) {
    this.append(child);
    return child;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }

  focus() { this.document.activeElement = this; }

  click() {
    for (const listener of [...(this.listeners.get("click") || [])]) {
      listener({ target: this });
    }
  }
}

function createDocument() {
  const document = { activeElement: null };
  document.createElement = (tagName) => {
    const element = new FakeElement(tagName);
    element.document = document;
    return element;
  };
  return document;
}

function setup({ file, root = "/project", api } = {}) {
  const document = createDocument();
  const RunPanel = loadGlobal("src/js/run/RunPanel.js", "RunPanel", { document });
  const editor = {
    api: api || {},
    fileExplorer: { rootPath: root },
    tabManager: { activeFile: file },
  };
  return { editor, RunPanel, document };
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

test("a saved Python file is runnable with the python-script strategy", () => {
  const { RunPanel } = setup();
  const target = RunPanel.describeRunTarget(fileNode());
  assert.equal(target.runnable, true);
  assert.equal(target.strategy, "python-script");
  assert.equal(target.language, "python");
});

test("JavaScript and TypeScript map to the node-script strategy", () => {
  const { RunPanel } = setup();
  assert.equal(RunPanel.describeRunTarget(fileNode({ name: "a.js", language: "javascript" })).strategy, "node-script");
  assert.equal(RunPanel.describeRunTarget(fileNode({ name: "a.ts", language: "typescript" })).strategy, "node-script");
  assert.equal(RunPanel.describeRunTarget(fileNode({ name: "a.mjs", language: "javascript" })).runnable, true);
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

test("running sends a validated request and renders stdout", async () => {
  const calls = [];
  const file = fileNode();
  const { editor, RunPanel } = setup({
    file,
    api: {
      async runAgentProcess(request) {
        calls.push(request);
        return { success: true, exitCode: 0, stdout: "hello\n", stderr: "", durationMs: 12 };
      },
    },
  });
  const panel = new RunPanel(editor);
  const result = await panel.run();

  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].strategy, "python-script");
  assert.equal(calls[0].target, "/project/main.py");
  assert.equal(calls[0].workspaceRoot, "/project");
  assert.equal(calls[0].projectRoot, "/project");
  assert.equal(typeof calls[0].requestId, "string");
  assert.equal(panel.output.textContent, "hello\n");
  assert.equal(panel.summary.dataset.state, "success");
});

test("a non-zero exit code is reported with the code", async () => {
  const { editor, RunPanel } = setup({
    file: fileNode(),
    api: {
      async runAgentProcess() {
        return { success: false, exitCode: 2, stdout: "", stderr: "boom\n", durationMs: 5 };
      },
    },
  });
  const panel = new RunPanel(editor);
  await panel.run();
  assert.match(panel.summary.textContent, /exited with code 2/);
  assert.equal(panel.summary.dataset.state, "failed");
  assert.equal(panel.output.textContent, "boom\n");
});

test("a missing runtime is explained in user terms", async () => {
  const { editor, RunPanel } = setup({
    file: fileNode(),
    api: {
      async runAgentProcess() {
        return { success: false, error: { code: "RUNTIME_UNAVAILABLE", message: "The required runtime is unavailable." } };
      },
    },
  });
  const panel = new RunPanel(editor);
  await panel.run();
  assert.match(panel.summary.textContent, /Python is not available/);
  assert.match(panel.summary.textContent, /Version Manager/);
  assert.equal(panel.summary.dataset.state, "failed");
});

test("a file outside the workspace is explained", async () => {
  const { editor, RunPanel } = setup({
    file: fileNode(),
    api: {
      async runAgentProcess() {
        return { success: false, error: { code: "OUTSIDE_WORKSPACE", message: "outside" } };
      },
    },
  });
  const panel = new RunPanel(editor);
  await panel.run();
  assert.match(panel.summary.textContent, /outside the open folder/);
});

test("a file that cannot run never reaches the main process", async () => {
  let called = 0;
  const { editor, RunPanel } = setup({
    file: fileNode({ isSaved: false }),
    api: { async runAgentProcess() { called += 1; return {}; } },
  });
  const panel = new RunPanel(editor);
  const result = await panel.run();
  assert.equal(result.success, false);
  assert.equal(result.code, "NOT_RUNNABLE");
  assert.equal(called, 0);
  assert.match(panel.summary.textContent, /Save the file/);
});

test("running without an open folder is refused before the request", async () => {
  let called = 0;
  const { editor, RunPanel } = setup({
    file: fileNode(),
    root: "",
    api: { async runAgentProcess() { called += 1; return {}; } },
  });
  const panel = new RunPanel(editor);
  const result = await panel.run();
  assert.equal(result.code, "NO_WORKSPACE");
  assert.equal(called, 0);
});

test("a second run is refused while one is in flight", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { editor, RunPanel } = setup({
    file: fileNode(),
    api: { runAgentProcess: () => pending },
  });
  const panel = new RunPanel(editor);
  const first = panel.run();
  const second = await panel.run();
  assert.equal(second.code, "ALREADY_RUNNING");
  release({ success: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 });
  await first;
});

test("stop cancels the request that is actually running", async () => {
  const cancelled = [];
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { editor, RunPanel } = setup({
    file: fileNode(),
    api: {
      runAgentProcess: () => pending,
      async cancelAgentProcess(requestId) {
        cancelled.push(requestId);
        return true;
      },
    },
  });
  const panel = new RunPanel(editor);
  const running = panel.run();
  await Promise.resolve();
  const stopped = await panel.stop();
  assert.equal(stopped, true);
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0], panel.requestId);
  release({ success: false, exitCode: null, stdout: "", stderr: "", durationMs: 1 });
  await running;
});

test("the stop button is only visible while a run is in flight", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { editor, RunPanel } = setup({
    file: fileNode(),
    api: { runAgentProcess: () => pending },
  });
  const panel = new RunPanel(editor);
  assert.equal(panel.stopButton.hidden, true);
  const running = panel.run();
  await Promise.resolve();
  assert.equal(panel.stopButton.hidden, false);
  release({ success: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 });
  await running;
  assert.equal(panel.stopButton.hidden, true);
});

test("a runner exception becomes a readable failure instead of an unhandled rejection", async () => {
  const { editor, RunPanel } = setup({
    file: fileNode(),
    api: {
      async runAgentProcess() { throw new Error("ipc exploded"); },
    },
  });
  const panel = new RunPanel(editor);
  const result = await panel.run();
  assert.equal(result.success, false);
  assert.equal(result.error.code, "RUN_FAILED");
  assert.match(panel.summary.textContent, /ipc exploded/);
});

test("an empty run still shows something rather than a blank panel", async () => {
  const { editor, RunPanel } = setup({
    file: fileNode(),
    api: {
      async runAgentProcess() {
        return { success: true, exitCode: 0, stdout: "", stderr: "", durationMs: 3 };
      },
    },
  });
  const panel = new RunPanel(editor);
  await panel.run();
  assert.equal(panel.output.textContent, "(no output)");
});
