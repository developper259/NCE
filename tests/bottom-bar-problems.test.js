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
  click() {
    for (const listener of this.listeners.get("click") || [])
      listener({ stopPropagation() {}, preventDefault() {} });
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

  assert.equal(left.children.length, 2);
  assert.equal(left.children[0], terminal);
  assert.equal(left.children[1], bar.problemIndicators);
  assert.equal(bar.problemIndicators.getAttribute("role"), "group");
  assert.equal(bar.problemErrorButton.dataset.count, "1");
  assert.equal(bar.problemErrorButton.children[0].textContent, "1");
  assert.equal(
    bar.problemErrorButton.children[1].className,
    "fi fi-rr-cross-circle",
  );
  assert.equal(bar.problemWarningButton.dataset.count, "0");
  assert.equal(bar.problemWarningButton.children[0].textContent, "0");
  assert.equal(
    bar.problemWarningButton.children[1].className,
    "fi fi-rr-triangle-warning",
  );
  assert.equal(
    bar.problemErrorButton.getAttribute("aria-label"),
    "1 error. Open Problems panel.",
  );
  bar.problemErrorButton.click();
  assert.deepEqual(opened, [true]);

  bar.refreshProblemCounts({ errors: 0, warnings: 3 });
  assert.equal(bar.problemErrorButton.dataset.count, "0");
  assert.equal(bar.problemWarningButton.dataset.count, "3");
  assert.equal(
    bar.problemWarningButton.getAttribute("aria-label"),
    "3 warnings. Open Problems panel.",
  );
});
