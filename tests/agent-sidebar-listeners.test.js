const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

class ListenerTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, handler) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(handler);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  listenerCount() {
    return [...this.listeners.values()].reduce((count, handlers) => count + handlers.size, 0);
  }
}

test("Agent global listeners stay stable across reopen and input area reconstruction", () => {
  const document = new ListenerTarget();
  const window = new ListenerTarget();
  const AgentSidebar = loadGlobal(
    "src/js/sidebar/Agent.Sidebar.js",
    "AgentSidebar",
    { Sidebar: class Sidebar {}, document, window },
  );
  const sidebar = Object.assign(Object.create(AgentSidebar.prototype), {
    globalListeners: new Map(),
    globalListenersActive: false,
    ensureInitialized() {},
    refresh() {},
    scheduleRestoredBottomScroll() {},
    focusInput() {},
    stopAgentWorkTicker() {},
    sessionInfoOpen: false,
    sessionInfoPopover: null,
    messagesElement: null,
    messagesScroller: null,
    messageWindowStates: new Map(),
    editor: { sidebarManager: { rightScroller: null } },
  });
  const registerSidebarListeners = () => {
    sidebar.registerGlobalListener("approval", document, "click", () => {});
    sidebar.registerGlobalListener("reasoning", document, "click", () => {});
    sidebar.registerGlobalListener("context-escape", document, "keydown", () => {});
    sidebar.registerGlobalListener("context-outside", document, "click", () => {});
    sidebar.registerGlobalListener("model-outside", document, "click", () => {});
  };
  const openSessionInfo = () => {
    sidebar.sessionInfoOpen = true;
    sidebar.sessionInfoPopover = {
      classList: { add() {} },
      style: {},
      remove() {},
    };
    sidebar.registerGlobalListener("session-info-outside-click", document, "click", () => {});
    sidebar.registerGlobalListener("session-info-escape", document, "keydown", () => {});
    sidebar.registerGlobalListener("session-info-resize", window, "resize", () => {});
  };

  registerSidebarListeners();
  for (let cycle = 0; cycle < 3; cycle += 1) {
    sidebar.onOpen();
    assert.equal(document.listenerCount(), 5);
    assert.equal(window.listenerCount(), 0);

    // renderInputArea replaces a keyed handler when it rebuilds its controls.
    sidebar.registerGlobalListener("context-outside", document, "click", () => {});
    assert.equal(document.listenerCount(), 5);

    openSessionInfo();
    assert.equal(document.listenerCount(), 7);
    assert.equal(window.listenerCount(), 1);
    sidebar.closeSessionInfo();
    assert.equal(document.listenerCount(), 5);
    assert.equal(window.listenerCount(), 0);

    sidebar.onClose();
    assert.equal(document.listenerCount(), 0);
    assert.equal(window.listenerCount(), 0);
  }

  sidebar.onOpen();
  assert.equal(document.listenerCount(), 5);
  sidebar.destroy();
  assert.equal(document.listenerCount(), 0);
  assert.equal(window.listenerCount(), 0);
  assert.equal(sidebar.globalListeners.size, 0);

  const source = fs.readFileSync(
    path.join(__dirname, "../src/js/sidebar/Agent.Sidebar.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /document\.addEventListener\(/);
  assert.doesNotMatch(source, /window\.addEventListener\(/);
});

test("Agent cancels scheduled animation frames on close and destroy", () => {
  const frames = new Map();
  const cancelledFrames = [];
  let nextFrameId = 1;
  const AgentSidebar = loadGlobal(
    "src/js/sidebar/Agent.Sidebar.js",
    "AgentSidebar",
    {
      Sidebar: class Sidebar {},
      requestAnimationFrame(callback) {
        const id = nextFrameId++;
        frames.set(id, callback);
        return id;
      },
      cancelAnimationFrame(id) {
        cancelledFrames.push(id);
        frames.delete(id);
      },
    },
  );
  const sidebar = Object.assign(Object.create(AgentSidebar.prototype), {
    globalListeners: new Map(),
    globalListenersActive: false,
    pendingAnimationFrames: new Set(),
    scrollBottomFrame: null,
    stopAgentWorkTicker() {},
    closeSessionInfo() {},
    removeGlobalListeners() {},
    sessionInfoPopover: null,
    messagesElement: null,
    messagesScroller: null,
    messageWindowStates: new Map(),
    editor: { sidebarManager: { rightScroller: null } },
  });

  const first = sidebar.scheduleSidebarAnimationFrame(() => {});
  const second = sidebar.scheduleSidebarAnimationFrame(() => {});
  sidebar.onClose();
  assert.deepEqual(cancelledFrames, [first, second]);
  assert.equal(sidebar.pendingAnimationFrames.size, 0);
  assert.equal(frames.size, 0);

  const third = sidebar.scheduleSidebarAnimationFrame(() => {});
  sidebar.destroy();
  assert.equal(cancelledFrames.at(-1), third);
  assert.equal(sidebar.pendingAnimationFrames.size, 0);
  assert.equal(frames.size, 0);

  const source = fs.readFileSync(
    path.join(__dirname, "../src/js/sidebar/Agent.Sidebar.js"),
    "utf8",
  );
  assert.equal([...source.matchAll(/requestAnimationFrame\(/g)].length, 1);
});
