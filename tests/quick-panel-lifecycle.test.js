const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.classList = {
      add() {},
      remove() {},
    };
    this.hidden = false;
    this.value = "";
    this.type = "";
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
  focus() {}
  setSelectionRange() {}
}

test("QuickPanel creates its DOM on first open and delegates native events", () => {
  let hostQueries = 0;
  const created = [];
  const host = new FakeElement("div");
  const document = {
    activeElement: null,
    querySelector(selector) {
      assert.equal(selector, ".quick-panel-host");
      hostQueries++;
      return host;
    },
    createElement(tagName) {
      const element = new FakeElement(tagName);
      created.push(element);
      return element;
    },
  };
  const QuickPanel = loadGlobal("src/js/types/QuickPanel.js", "QuickPanel", {
    document,
  });
  const panel = new QuickPanel({});

  assert.equal(panel.initialized, false);
  assert.equal(hostQueries, 0);
  assert.equal(created.length, 0);

  assert.equal(panel.open({ id: "smoke", mode: "input", value: "query" }), true);
  assert.equal(panel.initialized, true);
  assert.equal(hostQueries, 1);
  assert.equal(created.length, 7);
  assert.equal(panel.list.children[0].className, "quick-panel-list-layer");
  assert.equal(host.children.length, 1);
  const directListenerCount = [...created, host].reduce((count, element) =>
    count + [...element.listeners.values()].reduce(
      (total, listeners) => total + listeners.length,
      0,
    ),
  0);
  assert.equal(directListenerCount, 0);

  assert.equal(panel.init(), true);
  assert.equal(hostQueries, 1);
  assert.equal(created.length, 7);
});

test("QuickPanel keeps its panel id until the close fade-out completes", () => {
  let scheduled = null;
  const QuickPanel = loadGlobal("src/js/types/QuickPanel.js", "QuickPanel", {
    setTimeout(callback, delay) { scheduled = { callback, delay }; return 1; },
    clearTimeout() { scheduled = null; },
  });
  const panel = Object.create(QuickPanel.prototype);
  panel.session = { options: {} };
  panel.previousFocus = null;
  panel.requestGeneration = 0;
  panel.hoveredItem = null;
  panel.closeCleanupTimer = null;
  panel.host = { classList: { remove() {}, add() {} }, setAttribute() {} };
  panel.panel = { dataset: { panelId: "git-branch-picker" } };
  panel.input = { value: "", type: "text", blur() {} };
  panel.list = { style: {} };
  panel.empty = { textContent: "" };
  panel.error = { textContent: "" };
  panel.resultsScroller = { suspend() {}, clear() {} };
  panel.editor = {};

  assert.equal(panel.close({ restoreFocus: false }), true);
  // The host is still fading out, so the per-panel styling must survive: clearing
  // panelId now would revert the branch icons to the default accent (blue) color.
  assert.equal(panel.panel.dataset.panelId, "git-branch-picker");
  assert.ok(scheduled, "a cleanup timer is scheduled for the fade-out");
  assert.equal(scheduled.delay, 160);

  scheduled.callback();
  assert.equal(panel.panel.dataset.panelId, undefined);
  assert.equal(panel.closeCleanupTimer, null);
});

test("QuickPanel reopening cancels the pending panel id cleanup", () => {
  let scheduled = null;
  const QuickPanel = loadGlobal("src/js/types/QuickPanel.js", "QuickPanel", {
    document: { activeElement: null },
    setTimeout(callback, delay) { scheduled = { callback, delay }; return 1; },
    clearTimeout() { scheduled = null; },
  });
  const panel = Object.create(QuickPanel.prototype);
  panel.editor = {};
  panel.initialized = true;
  panel.closeCleanupTimer = null;
  panel.requestGeneration = 0;
  panel.hoveredItem = null;
  panel.previousFocus = null;
  panel.host = { classList: { remove() {}, add() {} }, setAttribute() {} };
  panel.panel = { dataset: { panelId: "git-branch-picker" } };
  panel.title = { textContent: "", hidden: false };
  panel.input = {
    type: "text", placeholder: "", value: "",
    setAttribute() {}, focus() {}, setSelectionRange() {}, blur() {},
  };
  panel.list = { hidden: false, style: {} };
  panel.empty = { hidden: false, textContent: "" };
  panel.error = { hidden: false, textContent: "" };
  panel.resultsScroller = { resume() {}, suspend() {}, setItems() {}, clear() {} };
  panel.session = { options: {} };

  panel.close({ restoreFocus: false });
  assert.ok(scheduled, "close schedules the fade-out cleanup");
  const staleCleanup = scheduled.callback;

  // Reopen with a different panel before the fade-out finishes.
  assert.equal(panel.open({ id: "command-palette", mode: "input" }), true);
  assert.equal(scheduled, null, "open cancels the pending cleanup timer");
  assert.equal(panel.closeCleanupTimer, null);
  assert.equal(panel.panel.dataset.panelId, "command-palette");

  // Even if the stale callback ran, the active session guard must keep the new id.
  staleCleanup();
  assert.equal(panel.panel.dataset.panelId, "command-palette");
});
