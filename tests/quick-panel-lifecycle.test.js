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
  assert.equal(created.length, 6);
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
  assert.equal(created.length, 6);
});
