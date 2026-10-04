const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

function createEventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, handler, options) {
      const handlers = listeners.get(type) || [];
      handlers.push({ handler, options });
      listeners.set(type, handlers);
    },
    dispatch(type, event = {}) {
      for (const { handler } of listeners.get(type) || []) handler(event);
    },
    count(type) {
      return listeners.get(type)?.length || 0;
    },
  };
}

test("Events init binds native handlers once and resyncs focus safely", () => {
  const document = createEventTarget();
  const window = createEventTarget();
  document.visibilityState = "hidden";
  const Events = loadGlobal("src/js/core/Event.js", "Events", {
    document,
    window,
    requestAnimationFrame(callback) {
      callback();
    },
  });
  let focusResyncs = 0;
  const editor = {
    tabManager: {
      scheduleFocusResync() {
        focusResyncs++;
      },
    },
    onClick() {},
  };
  const events = new Events(editor);

  assert.equal(document.count("click"), 0);
  assert.equal(window.count("resize"), 0);
  events.init();
  events.init();

  assert.equal(document.count("click"), 1);
  assert.equal(document.count("contextmenu"), 1);
  assert.equal(document.listeners.get("contextmenu")[0].options, true);
  assert.equal(document.count("visibilitychange"), 1);
  assert.equal(window.count("resize"), 1);
  assert.equal(window.count("focus"), 1);

  window.dispatch("focus");
  document.dispatch("visibilitychange");
  assert.equal(focusResyncs, 1);

  document.visibilityState = "visible";
  document.dispatch("visibilitychange");
  assert.equal(focusResyncs, 2);
});

test("Events routes input, tab, and editor context menus from one root listener", () => {
  const document = createEventTarget();
  const window = createEventTarget();
  const calls = [];
  const tabElement = { id: "17" };
  const file = {
    path: "/workspace/main.js",
    hasPath() { return true; },
  };
  const editor = {
    contextMenuManager: {
      openContextMenu(...args) {
        calls.push(args);
      },
    },
    tabManager: {
      activeFile: file,
      onContextMenu(element) {
        calls.push(["tab", element]);
        return true;
      },
    },
    selectController: {
      hasActiveSelection() { return true; },
      getSelectedText() { return "selected"; },
    },
    fileExplorer: { rootPath: "/workspace" },
  };
  const Events = loadGlobal("src/js/core/Event.js", "Events", {
    document,
    window,
    requestAnimationFrame(callback) { callback(); },
  });
  const events = new Events(editor);
  const createContextEvent = (selectors) => ({
    target: {
      closest(selector) {
        return selectors[selector] || null;
      },
    },
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  });

  const input = {};
  const inputEvent = createContextEvent({
    "input:not([type='button']):not([type='submit']):not([type='reset']):not([type='checkbox']):not([type='radio']):not([type='range']):not([type='color']):not([type='file']), textarea, select, [contenteditable='true'], [contenteditable='']": input,
  });
  events.onContextMenu(inputEvent);
  assert.equal(calls[0][0], "input");
  assert.equal(calls[0][1], input);
  assert.equal(inputEvent.prevented, true);
  assert.equal(inputEvent.stopped, true);

  const tabEvent = createContextEvent({ ".file-manager .file-el": tabElement });
  events.onContextMenu(tabEvent);
  assert.equal(calls[1][0], "tab");
  assert.equal(calls[1][1], tabElement);
  assert.equal(tabEvent.prevented, true);
  assert.equal(tabEvent.stopped, true);

  const outputEvent = createContextEvent({ ".editor-output": {} });
  events.onContextMenu(outputEvent);
  assert.equal(calls[2][0], "output");
  assert.equal(calls[2][1].isFile, true);
  assert.equal(calls[2][1].file, file);
  assert.equal(calls[2][1].filePath, "/workspace/main.js");
  assert.equal(calls[2][1].rootPath, "/workspace");
  assert.equal(calls[2][1].selectedText, "selected");
  assert.equal(outputEvent.prevented, true);
  assert.equal(outputEvent.stopped, true);
});

test("TabManager resolves delegated context menus from current tab identity", () => {
  const TabManager = loadGlobal("src/js/manager/TabManager.js", "tabManager");
  const file = { id: 17 };
  const opened = [];
  const manager = Object.assign(Object.create(TabManager.prototype), {
    tabs: [file],
    editor: {
      contextMenuManager: {
        openContextMenu(...args) { opened.push(args); },
      },
    },
  });

  assert.equal(manager.onContextMenu({ id: "17" }), true);
  assert.deepEqual(opened, [["tab", file]]);
  assert.equal(manager.onContextMenu({ id: "18" }), false);
  assert.equal(opened.length, 1);
});
