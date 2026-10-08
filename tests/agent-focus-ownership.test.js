const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

function createAgentSidebar() {
  const frames = new Map();
  let nextFrameId = 1;
  let quickPanelOpen = false;
  const body = { tagName: "BODY" };
  const quickPanelInput = { className: "quick-panel-input" };
  const document = {
    activeElement: body,
    modals: [],
    listeners: new Map(),
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    },
    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    },
    querySelectorAll() {
      return this.modals.filter((modal) =>
        modal.tagName !== "DIALOG" || modal.open === true,
      );
    },
    dispatch(type, event) {
      for (const listener of this.listeners.get(type) || []) listener(event);
    },
  };
  const AgentSidebar = loadGlobal(
    "src/js/sidebar/Agent.Sidebar.js",
    "AgentSidebar",
    {
      Sidebar: class Sidebar {},
      document,
      requestAnimationFrame(callback) {
        const id = nextFrameId++;
        frames.set(id, callback);
        return id;
      },
      cancelAnimationFrame(id) { frames.delete(id); },
    },
  );
  const sidebar = Object.assign(Object.create(AgentSidebar.prototype), {
    editor: { quickPanel: { isOpen: () => quickPanelOpen } },
    isOpen: true,
    inputElement: {
      isConnected: true,
      focusCalls: 0,
      focus() {
        this.focusCalls += 1;
        document.activeElement = this;
        document.dispatch("focusin", { target: this });
      },
    },
    pendingAnimationFrames: new Set(),
    focusInputGeneration: 0,
    focusOwnershipGeneration: 0,
    globalListeners: new Map(),
    globalListenersActive: false,
    sessionInfoPopover: null,
    ensureInitialized() {},
    refresh() {},
    scheduleRestoredBottomScroll() {},
    stopAgentWorkTicker() {},
    closeSessionInfo() {},
  });

  return {
    body,
    document,
    frames,
    quickPanelInput,
    setQuickPanelOpen(value) { quickPanelOpen = value; },
    sidebar,
  };
}

function runFrame(frames, id) {
  const callback = frames.get(id);
  assert.equal(typeof callback, "function");
  frames.delete(id);
  callback();
}

test("Agent's scheduled focus yields to a Quick Panel focus change", () => {
  const { body, document, frames, quickPanelInput, setQuickPanelOpen, sidebar } =
    createAgentSidebar();
  sidebar.onOpen();
  const [frameId] = frames.keys();

  setQuickPanelOpen(true);
  document.activeElement = quickPanelInput;
  document.dispatch("focusin", { target: quickPanelInput });
  setQuickPanelOpen(false);
  document.activeElement = body;
  document.dispatch("focusin", { target: body });
  runFrame(frames, frameId);

  assert.equal(sidebar.inputElement.focusCalls, 0);
  assert.equal(document.activeElement, body);
});

test("Agent focuses on open when no modal or newer focus owner is active", () => {
  const { document, frames, sidebar } = createAgentSidebar();
  document.modals = [{ tagName: "DIALOG", open: false }];
  sidebar.onOpen();
  const [frameId] = frames.keys();

  runFrame(frames, frameId);

  assert.equal(sidebar.inputElement.focusCalls, 1);
  assert.equal(document.activeElement, sidebar.inputElement);
});

test("closing Agent invalidates its pending focus before a later reopen", () => {
  const { document, frames, sidebar } = createAgentSidebar();
  sidebar.onOpen();
  const [staleFrameId] = frames.keys();
  const staleCallback = frames.get(staleFrameId);

  sidebar.isOpen = false;
  sidebar.onClose();
  staleCallback();
  assert.equal(sidebar.inputElement.focusCalls, 0);

  sidebar.isOpen = true;
  sidebar.onOpen();
  const [reopenFrameId] = frames.keys();
  runFrame(frames, reopenFrameId);

  assert.equal(sidebar.inputElement.focusCalls, 1);
  assert.equal(document.activeElement, sidebar.inputElement);
});

test("Agent does not move focus while another modal remains active", () => {
  const { document, frames, sidebar } = createAgentSidebar();
  const modal = {
    open: false,
    hidden: false,
    getAttribute() { return null; },
    closest() { return null; },
  };
  document.modals = [modal];
  sidebar.onOpen();
  const [frameId] = frames.keys();

  runFrame(frames, frameId);

  assert.equal(sidebar.inputElement.focusCalls, 0);
});
