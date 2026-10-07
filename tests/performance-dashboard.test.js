const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

class FakeElement {
  constructor(tagName, document) {
    this.tagName = tagName;
    this.document = document;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = false;
    this.textContent = "";
    this.isConnected = true;
  }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  focus() { this.document.activeElement = this; }
  remove() {
    this.isConnected = false;
    this.document.body.children = this.document.body.children.filter((child) => child !== this);
  }
  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener({ target: this, ...event });
  }
}

function createDocument() {
  const document = { activeElement: null, created: 0 };
  document.createElement = (tagName) => {
    document.created += 1;
    return new FakeElement(tagName, document);
  };
  document.body = new FakeElement("body", document);
  return document;
}

function descendants(node) {
  return [node, ...(node.children || []).flatMap(descendants)];
}

function loadDashboard(document) {
  return loadGlobal("src/js/view/PerformanceDashboard.js", "PerformanceDashboard", {
    document,
    window: {},
    TextEncoder,
  });
}

function metricsFixture() {
  const entries = Array.from({ length: 500 }, (_, sequence) => ({
    sequence: sequence + 1,
    type: "mark",
    name: "renderer.core.loaded",
    at: sequence,
  }));
  let snapshotCalls = 0;
  let resets = 0;
  let currentCounters = { "layout.frames": 4, "autosave.persistedWrites": 2 };
  return {
    api: {
      snapshot() {
        snapshotCalls += 1;
        return {
          version: 1,
          capacity: 500,
          eventCount: entries.length,
          counters: currentCounters,
          entries,
          measures: {},
        };
      },
      reset() {
        resets += 1;
        currentCounters = {};
        entries.length = 0;
        return true;
      },
    },
    get snapshotCalls() { return snapshotCalls; },
    get resets() { return resets; },
  };
}

test("Performance dashboard stays uncreated and idle until first open", () => {
  const document = createDocument();
  const fixture = metricsFixture();
  const editor = { performanceMetrics: fixture.api };
  const Dashboard = loadDashboard(document);
  const dashboard = new Dashboard(editor);

  assert.equal(document.created, 0);
  assert.equal(fixture.snapshotCalls, 0);
  assert.equal(dashboard.host, null);

  assert.equal(dashboard.show(), true);
  assert.ok(document.created > 0);
  assert.equal(document.body.children.length, 1);
  assert.equal(fixture.snapshotCalls, 1);
  assert.equal(dashboard.host.hidden, false);
  assert.equal(descendants(dashboard.output).some((element) =>
    element.textContent === "4"), true);

  dashboard.hide();
  assert.equal(dashboard.host.hidden, true);
  assert.equal(fixture.snapshotCalls, 1);
  dashboard.destroy();
  assert.equal(document.body.children.length, 0);
});

test("Performance dashboard resets and copies a bounded content-free report", async () => {
  const document = createDocument();
  const fixture = metricsFixture();
  let copied = "";
  const editor = {
    performanceMetrics: fixture.api,
    api: { async writeClipboardText(value) { copied = value; return true; } },
  };
  const Dashboard = loadDashboard(document);
  const dashboard = new Dashboard(editor);
  dashboard.show();

  assert.equal(await dashboard.copyReport(), true);
  const report = JSON.parse(copied);
  assert.equal(report.eventCount, 500);
  assert.equal(copied.includes("/Users/"), false);
  assert.equal(copied.includes("secret content"), false);
  const payloadBytes = new TextEncoder().encode(copied).length;
  assert.ok(payloadBytes > 20000);
  assert.ok(payloadBytes < 100000);

  assert.equal(dashboard.reset(), true);
  assert.equal(fixture.resets, 1);
  assert.match(dashboard.status.textContent, /reset/i);

  dashboard.destroy();
});

test("Developer: Performance is registered in Command Palette and opens the lazy editor view", async () => {
  let panelOptions;
  let opened = 0;
  const KeyBinding = loadGlobal("src/js/addon/KeyBinding.js", "KeyBinding", {
    USERCONFIG_KEYBINDING: [],
    CONFIG_KEYBINDING_DISPLAY: (key) => key,
  });
  const editor = {
    tabManager: { activeFile: null },
    quickPanel: { isOpen: () => false, open(options) { panelOptions = options; } },
    openPerformanceDashboard() { opened += 1; return true; },
  };
  const keyBinding = new KeyBinding(editor);
  keyBinding.control_open_command();
  const command = panelOptions.items.find((item) => item.id === "developer-performance");
  assert.equal(command.label, "Developer: Performance");
  assert.equal(command.data.performanceDashboard, true);
  assert.equal(await keyBinding.executeCommandItem(command), true);
  assert.equal(opened, 1);
});

test("Editor creates one PerformanceDashboard instance only when the command opens it", () => {
  let constructed = 0;
  class DashboardStub {
    constructor(editor) { this.editor = editor; constructed += 1; }
    show() { return true; }
  }
  const Editor = loadGlobal("src/js/main/Editor.js", "Editor", {
    document: { addEventListener() {} },
    window: {},
    PerformanceDashboard: DashboardStub,
  });
  const editor = Object.create(Editor.prototype);
  editor._performanceDashboard = null;

  assert.equal(editor._performanceDashboard, null);
  assert.equal(constructed, 0);
  assert.equal(editor.openPerformanceDashboard(), true);
  assert.equal(constructed, 1);
  assert.equal(editor.getPerformanceDashboard(), editor._performanceDashboard);
  assert.equal(constructed, 1);
});
