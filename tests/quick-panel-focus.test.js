const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

test("opening Quick Panel focuses its input while Agent is visible", () => {
  const agentInput = { className: "agent-sidebar-input" };
  const document = { activeElement: agentInput };
  const QuickPanel = loadGlobal(
    "src/js/types/QuickPanel.js",
    "QuickPanel",
    { document },
  );
  const panel = Object.assign(Object.create(QuickPanel.prototype), {
    editor: {},
    initialized: true,
    closeCleanupTimer: null,
    requestGeneration: 0,
    host: {
      classList: { add() {}, remove() {} },
      setAttribute() {},
    },
    panel: { dataset: {} },
    title: { textContent: "", hidden: false },
    input: {
      type: "text",
      placeholder: "",
      value: "",
      setAttribute() {},
      setSelectionRange() {},
      focus() { document.activeElement = this; },
    },
    list: { hidden: false },
    empty: { hidden: false },
    error: { hidden: false },
    resultsScroller: null,
    render() {},
    async loadItems() {},
  });

  assert.equal(panel.open({ id: "quick-open", mode: "pick", items: [] }), true);
  assert.equal(document.activeElement, panel.input);
});

test("closing Quick Panel releases its hidden input before restoring focus", () => {
  const QuickPanel = loadGlobal(
    "src/js/types/QuickPanel.js",
    "QuickPanel",
  );
  const calls = [];
  const panel = Object.create(QuickPanel.prototype);
  panel.session = { options: {} };
  panel.previousFocus = {
    isConnected: true,
    focus() { calls.push("restore"); },
  };
  panel.requestGeneration = 0;
  panel.hoveredItem = null;
  panel.host = {
    classList: { remove() {} },
    setAttribute() {},
  };
  panel.panel = { dataset: { panelId: "quick-open" } };
  panel.input = {
    value: "query",
    type: "text",
    blur() { calls.push("blur"); },
  };
  panel.list = { replaceChildren() {} };
  panel.empty = { textContent: "message" };
  panel.error = { textContent: "error" };
  panel.editor = { output: { focus() {} }, setSelected() {} };

  assert.equal(panel.close(), true);
  assert.deepEqual(calls, ["blur", "restore"]);
  assert.equal(panel.session, null);
});
