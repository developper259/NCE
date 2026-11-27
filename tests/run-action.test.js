const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobals } = require("./helpers/runtime");

/**
 * The Run control in the tab strip.
 *
 * What matters here is that the control tells the truth: it is enabled only
 * when the file can really run, it becomes Stop only while a process is live,
 * and one click means one run.
 */

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
    this._classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this._classes.add(name)),
      remove: (...names) => names.forEach((name) => this._classes.delete(name)),
      contains: (name) => this._classes.has(name),
    };
  }

  get parentElement() {
    return this.parent;
  }

  get className() {
    return [...this._classes].join(" ");
  }
  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  /** Mirrors the DOM: insert the node directly after `reference`. */
  insertBefore(node, reference) {
    const index = this.children.indexOf(reference);
    if (index === -1) {
      this.append(node);
      return node;
    }
    node.parent = this;
    this.children.splice(index, 0, node);
    return node;
  }

  get textContent() {
    return this._text;
  }
  set textContent(value) {
    this._text = String(value);
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node && typeof node === "object") node.parent = this;
      this.children.push(node);
    }
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
  click() {
    for (const listener of [...(this.listeners.get("click") || [])]) listener({ target: this });
  }
}

function createDocument() {
  const document = { activeElement: null };
  document.createElement = (tagName) => {
    const element = new FakeElement(tagName);
    element.document = document;
    return element;
  };
  document.createTextNode = (data) => ({ data: String(data) });
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

/**
 * Build a RunAction over a stub panel whose controller state the test drives.
 */
function setup({ file, panelState = {}, api = {} } = {}) {
  const document = createDocument();
  const RunAction = loadGlobals(
    ["src/js/run/RunController.js", "src/js/run/RunPanel.js", "src/js/run/RunAction.js"],
    "RunAction",
    { document, window: {} },
  );

  const calls = [];
  const controller = {
    isStopping: panelState.isStopping === true,
    canStop: panelState.canStop === true,
  };
  const panel = {
    controller,
    async run() {
      calls.push(["run"]);
      return { success: true };
    },
    async stop() {
      calls.push(["stop"]);
      return true;
    },
  };

  const editor = {
    api,
    tabManager: { activeFile: file },
    runPanel: panel,
    bottomPanelManager: {
      async openPanel(id) {
        calls.push(["openPanel", id]);
        return true;
      },
    },
  };

  const action = new RunAction(editor);
  return { action, editor, calls, controller, panel };
}

// ---- enabled / disabled ---------------------------------------------------

test("Run is enabled for a saved Python file", () => {
  const { action } = setup({ file: fileNode() });
  assert.equal(action.button.disabled, false);
  assert.equal(action.element.dataset.mode, "run");
  assert.equal(action.label.textContent, "Run");
});

test("Run is disabled with a reason for TypeScript", () => {
  const { action } = setup({ file: fileNode({ name: "a.ts", language: "typescript" }) });
  assert.equal(action.button.disabled, true);
  assert.equal(action.element.dataset.mode, "disabled");
  assert.match(action.button.title, /build step/);
});

test("Run is disabled for an unsupported language", () => {
  const { action } = setup({ file: fileNode({ name: "a.rb", language: "ruby" }) });
  assert.equal(action.button.disabled, true);
  assert.match(action.button.title, /not supported/);
});

test("Run is disabled when no file is open", () => {
  const { action } = setup({ file: null });
  assert.equal(action.button.disabled, true);
  assert.match(action.button.title, /Open a file/);
});

test("Run is disabled for an unsaved file, and says why", () => {
  const { action } = setup({ file: fileNode({ isSaved: false }) });
  assert.equal(action.button.disabled, true);
  assert.match(action.button.title, /Save the file/);
});

test("the button carries an accessible label in every state", () => {
  const enabled = setup({ file: fileNode() });
  assert.equal(enabled.action.button.getAttribute("aria-label"), "Run main.py");

  const disabled = setup({ file: fileNode({ language: "ruby", name: "a.rb" }) });
  assert.match(disabled.action.button.getAttribute("aria-label"), /not supported/);

  const stopping = setup({ file: fileNode(), panelState: { isStopping: true } });
  assert.match(stopping.action.button.getAttribute("aria-label"), /Waiting/);
});

// ---- Run / Stop -----------------------------------------------------------

test("Run opens the Output panel before starting", async () => {
  const { action, calls } = setup({ file: fileNode() });
  await action.onClick();
  assert.deepEqual(calls[0], ["openPanel", "run"]);
  assert.deepEqual(calls[1], ["run"]);
});

test("the control becomes Stop while a process is live", () => {
  const { action, controller } = setup({ file: fileNode(), panelState: { canStop: true } });
  assert.equal(action.element.dataset.mode, "stop");
  assert.equal(action.label.textContent, "Stop");
  assert.equal(action.button.disabled, false);
  assert.equal(action.icon.dataset.icon, "stop");
  assert.equal(controller.canStop, true);
});

test("Stop is not shown when the process has ended", () => {
  const { action } = setup({ file: fileNode(), panelState: { canStop: false } });
  assert.equal(action.element.dataset.mode, "run");
  assert.equal(action.label.textContent, "Run");
});

test("clicking Stop stops the run and does not start another", async () => {
  const { action, calls } = setup({ file: fileNode(), panelState: { canStop: true } });
  await action.onClick();
  assert.deepEqual(calls, [["stop"]]);
});

test("a stopping run cannot be clicked into a second stop", async () => {
  const { action, calls } = setup({ file: fileNode(), panelState: { isStopping: true } });
  assert.equal(action.button.disabled, true);
  await action.onClick();
  assert.equal(calls.length, 0);
});

test("a disabled control does nothing when clicked", async () => {
  const { action, calls } = setup({ file: fileNode({ language: "ruby", name: "a.rb" }) });
  await action.onClick();
  assert.equal(calls.length, 0);
});

test("refresh follows the active file", () => {
  const { action, editor } = setup({ file: fileNode() });
  assert.equal(action.button.disabled, false);

  editor.tabManager.activeFile = fileNode({ name: "a.ts", language: "typescript" });
  action.refresh();
  assert.equal(action.button.disabled, true);

  editor.tabManager.activeFile = fileNode({ name: "b.js", language: "javascript" });
  action.refresh();
  assert.equal(action.button.disabled, false);
});

test("the control mounts at the end of the tab strip", () => {
  const document = createDocument();
  const parent = new FakeElement("div");
  const strip = new FakeElement("div");
  strip.className = "file-manager";
  parent.append(strip);
  document.querySelector = (selector) => (selector === ".file-manager" ? strip : null);

  const RunAction = loadGlobals(
    ["src/js/run/RunController.js", "src/js/run/RunPanel.js", "src/js/run/RunAction.js"],
    "RunAction",
    { document, window: {} },
  );
  const action = new RunAction({ tabManager: { activeFile: fileNode() } });
  assert.equal(action.mount(), true);
  assert.equal(parent.children[1], action.element);
});
