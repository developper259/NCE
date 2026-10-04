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
  assert.equal(document.count("input"), 1);
  assert.equal(document.count("keydown"), 1);
  assert.equal(document.count("compositionstart"), 1);
  assert.equal(document.count("compositionend"), 1);
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

test("Events delegates search actions before the editor click handler", () => {
  const calls = [];
  const closeButton = {
    classList: { contains: (name) => name === "search-bar-close" },
  };
  const input = {};
  const replaceInput = {};
  const editor = {
    onClick() { calls.push("editor-click"); },
    searchController: {
      input,
      replaceInput,
      onCloseClick() { calls.push("search-close"); },
      onInput() { calls.push("search-input"); },
      saveActiveTabState() { calls.push("save-search-state"); },
    },
  };
  const Events = loadGlobal("src/js/core/Event.js", "Events", {
    document: createEventTarget(),
    window: createEventTarget(),
    requestAnimationFrame(callback) { callback(); },
  });
  const events = new Events(editor);
  const clickEvent = {
    target: {
      classList: { contains() { return false; } },
      closest(selector) {
        return selector.includes(".search-bar-close") ? closeButton : null;
      },
    },
  };

  events.onClick(clickEvent);
  assert.deepEqual(calls, ["search-close", "editor-click"]);

  events.onInput({ target: input });
  events.onInput({ target: replaceInput });
  events.onInput({ target: {} });
  assert.deepEqual(calls.slice(2), ["search-input", "save-search-state"]);
});

test("Events routes lazy Quick Panel input, keyboard, click, and context actions", () => {
  const document = createEventTarget();
  const window = createEventTarget();
  const calls = [];
  const input = {};
  const quickPanel = {
    input,
    handleItemClick(event) {
      if (!event.panelItem) return false;
      calls.push("panel-item");
      return true;
    },
    handleBackdropClick() { calls.push("panel-backdrop"); },
    handleInputEvent(event) {
      if (event.target !== input) return false;
      calls.push("panel-input");
      return true;
    },
    handleKeyDownEvent() { calls.push("panel-keydown"); },
    handleContextMenu() { calls.push("panel-contextmenu"); return true; },
  };
  const editor = {
    quickPanel,
    onClick() { calls.push("editor-click"); },
  };
  const Events = loadGlobal("src/js/core/Event.js", "Events", {
    document,
    window,
    requestAnimationFrame(callback) { callback(); },
  });
  const events = new Events(editor);
  events.init();

  const clickEvent = {
    panelItem: true,
    target: {
      classList: { contains() { return false; } },
      closest() { return null; },
    },
  };
  events.onClick(clickEvent);
  assert.deepEqual(calls, ["panel-item"]);

  events.onInput({ target: input });
  document.dispatch("keydown", { target: input });
  document.dispatch("contextmenu", { target: {} });
  assert.deepEqual(calls, [
    "panel-item", "panel-input", "panel-keydown", "panel-contextmenu",
  ]);

  events.onClick({
    panelItem: false,
    target: {
      classList: { contains() { return false; } },
      closest() { return null; },
    },
  });
  assert.equal(calls.at(-2), "editor-click");
  assert.equal(calls.at(-1), "panel-backdrop");
});

test("Events sends unhandled keyboard and composition input to KeyBindingManager", () => {
  const document = createEventTarget();
  const calls = [];
  const editor = {
    quickPanel: { handleKeyDownEvent() { return false; } },
    keyBindingManager: {
      onKey(event) { calls.push(["keydown", event.key]); },
      onCompositionStart() { calls.push(["compositionstart"]); },
      onCompositionEnd(event) { calls.push(["compositionend", event.data]); },
    },
  };
  const Events = loadGlobal("src/js/core/Event.js", "Events", {
    document,
    window: createEventTarget(),
  });
  new Events(editor).init();

  document.dispatch("keydown", { key: "a" });
  document.dispatch("compositionstart", {});
  document.dispatch("compositionend", { data: "é" });

  assert.deepEqual(calls, [
    ["keydown", "a"], ["compositionstart"], ["compositionend", "é"],
  ]);
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
