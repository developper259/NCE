const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

class FakeClassList {
  constructor() {
    this.values = new Set();
  }
  add(...values) {
    for (const value of values) this.values.add(value);
  }
  remove(...values) {
    for (const value of values) this.values.delete(value);
  }
  contains(value) {
    return this.values.has(value);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.textContent = "";
  }
  append(...children) {
    for (const child of children) this.appendChild(child);
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || [])
      listener({ stopPropagation() {}, preventDefault() {}, ...event });
  }
  click() {
    this.dispatch("click");
  }
}

test("BottomBar reports real problem counts and opens the Problems panel", () => {
  const document = { createElement: (tagName) => new FakeElement(tagName) };
  const left = new FakeElement("section");
  const terminal = new FakeElement("button");
  left.appendChild(terminal);
  const elements = new Map([[".bottomBar .left", left]]);
  const opened = [];
  const editor = {
    tabManager: { activeFile: null, activeTab: null },
    fileExplorer: {},
    lspController: {
      getProblemCounts: () => ({ errors: 1, warnings: 0, infos: 0 }),
      showProblems: () => {
        opened.push(true);
        return true;
      },
    },
  };
  const BottomBar = loadGlobal(
    "src/js/addon/BottomBar.js",
    "BottomBar",
    {
      getElement: (selector) => elements.get(selector) || null,
      document,
      SETTINGS_GET: () => 2,
    },
  );
  const bar = new BottomBar(editor);

  assert.equal(left.children.length, 3);
  assert.equal(left.children[0], terminal);
  assert.equal(left.children[1], bar.gitBranchIndicator);
  assert.equal(left.children[2], bar.problemIndicators);
  assert.equal(bar.gitBranchIndicator.hidden, true);
  assert.equal(bar.problemIndicators.tagName, "div");
  assert.equal(bar.problemIndicators.getAttribute("role"), "button");
  assert.equal(bar.problemIndicators.tabIndex, 0);
  assert.equal(
    bar.problemIndicators.getAttribute("aria-label"),
    "1 error, 0 warnings. Open Problems panel.",
  );
  assert.equal(bar.problemIndicators.children.length, 2);
  assert.equal(bar.problemPairs.errors.children[0], bar.problemCounts.errors);
  assert.equal(bar.problemPairs.warnings.children[0], bar.problemCounts.warnings);
  assert.equal(bar.problemCounts.errors.textContent, "1");
  assert.equal(bar.problemCounts.warnings.textContent, "0");
  assert.equal(bar.problemPairs.errors.dataset.count, "1");
  assert.equal(bar.problemPairs.warnings.dataset.count, "0");
  assert.equal(
    bar.problemPairs.errors.children[1].className,
    "fi fi-rr-cross-circle",
  );
  assert.equal(
    bar.problemPairs.warnings.children[1].className,
    "fi fi-rr-triangle-warning",
  );

  bar.problemIndicators.click();
  bar.problemIndicators.dispatch("keydown", { key: "Enter" });
  assert.deepEqual(opened, [true, true]);

  bar.refreshProblemCounts({ errors: 0, warnings: 3 });
  assert.equal(bar.problemCounts.errors.textContent, "0");
  assert.equal(bar.problemCounts.warnings.textContent, "3");
  assert.equal(bar.problemPairs.errors.dataset.count, "0");
  assert.equal(bar.problemPairs.warnings.dataset.count, "3");
  assert.equal(bar.problemIndicators.dataset.errors, "0");
  assert.equal(bar.problemIndicators.dataset.warnings, "3");
  assert.equal(
    bar.problemIndicators.getAttribute("aria-label"),
    "0 errors, 3 warnings. Open Problems panel.",
  );
});
