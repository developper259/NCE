const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src/js/terminal/TerminalPanel.js"), "utf8")
  .replace(/^export class TerminalPanel/m, "class TerminalPanel");
const context = vm.createContext({ console, Map, Set, Promise, URL, setTimeout, clearTimeout });
vm.runInContext(`${source}\nthis.TerminalPanel = TerminalPanel;`, context);
const TerminalPanel = context.TerminalPanel;

class ElementStub {
  constructor() {
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = { toggle() {} };
    this.dataset = {};
    this.hidden = false;
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
}

function makePanel() {
  const panel = Object.create(TerminalPanel.prototype);
  Object.assign(panel, {
    workspaceSessions: new Map(),
    sessionIndex: new Map(),
    pendingOutput: new Map(),
    closedSessionIds: new Set(),
    currentWorkspaceKey: "no-workspace",
    currentWorkspaceRoot: null,
    workspaceGeneration: 0,
    destroyed: false,
    frame: null,
    editor: {
      bottomPanelManager: {
        visible: true,
        closePanelCalls: 0,
        closePanel() { this.closePanelCalls++; },
      },
      statesManager: { saves: [], scheduleBottomPanelStateSave(key) { this.saves.push(key); } },
      api: {
        closes: [],
        closeTerminalSession(id, key) { this.closes.push([id, key]); return Promise.resolve({ success: true }); },
      },
    },
    renderTabs() {},
    showActive() {},
    clearTerminalActions() {},
    clearStatus() {},
    closeActionsMenu() {},
    scheduleFit() {},
    disposeRecord(record) { record.disposed = true; },
  });
  return panel;
}

function record(id, workspaceKey, baseLabel, customLabel = null) {
  return {
    id,
    internalId: id,
    workspaceKey,
    baseLabel,
    customLabel,
    duplicateIndex: null,
    displayLabel: baseLabel,
    cwd: "/secret/workspace",
    commandHistory: ["secret command"],
    terminal: { output: "secret output" },
    exited: false,
    disposed: false,
    wrapper: { hidden: false },
  };
}

function contextMenuEvent(target) {
  return {
    target,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };
}

test("terminal edit shortcuts copy, cut, paste, and select terminal content", async () => {
  const panel = makePanel();
  const state = panel.currentState;
  const clipboardWrites = [];
  const pasted = [];
  let selectedText = "selected terminal output";
  let selectAllCalls = 0;
  const terminalRecord = record("terminal-edit-shortcuts", "no-workspace", "zsh");
  terminalRecord.terminal = {
    output: "terminal output remains unchanged",
    getSelection: () => selectedText,
    selectAll() { selectAllCalls++; },
    paste(text) { pasted.push(text); },
    focus() {},
  };
  state.sessions.set(terminalRecord.id, terminalRecord);
  state.activeSessionId = terminalRecord.id;
  panel.editor.api.writeClipboardText = async (text) => clipboardWrites.push(text);
  panel.editor.api.readClipboardText = async () => "clipboard paste";

  assert.equal(panel.handleKeybinding("copy"), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(clipboardWrites, ["selected terminal output"]);

  assert.equal(panel.handleKeybinding("cut"), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(clipboardWrites, [
    "selected terminal output",
    "selected terminal output",
  ]);
  assert.equal(terminalRecord.terminal.output, "terminal output remains unchanged");

  assert.equal(panel.handleKeybinding("paste"), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pasted, ["clipboard paste"]);

  assert.equal(panel.handleKeybinding("select_all"), true);
  assert.equal(selectAllCalls, 1);

  selectedText = "";
  assert.equal(panel.handleKeybinding("copy"), false);
});

test("Shift+Arrow extends terminal selection and sends plain arrows to move the shell caret", () => {
  const panel = makePanel();
  const state = panel.currentState;
  const selections = [];
  const inputs = [];
  let clearCalls = 0;
  const activeBuffer = {
    baseY: 0,
    cursorY: 1,
    cursorX: 5,
    length: 4,
    wrapPending: false,
  };
  const terminalRecord = record("terminal-shift-selection", "no-workspace", "zsh");
  terminalRecord.terminal = {
    cols: 8,
    modes: { applicationCursorKeysMode: false },
    buffer: { active: activeBuffer },
    select(...args) { selections.push(args); },
    clearSelection() { clearCalls++; },
    input(data) { inputs.push(data); },
  };
  state.sessions.set(terminalRecord.id, terminalRecord);
  state.activeSessionId = terminalRecord.id;

  assert.equal(panel.handleShiftArrow("ArrowLeft"), true);
  assert.deepEqual(selections.at(-1), [4, 1, 1]);
  assert.equal(panel.handleShiftArrow("ArrowLeft"), true);
  assert.deepEqual(selections.at(-1), [3, 1, 2]);
  assert.equal(panel.handleShiftArrow("ArrowRight"), true);
  assert.deepEqual(selections.at(-1), [4, 1, 1]);

  panel.resetKeyboardSelection();
  assert.equal(panel.handleShiftArrow("ArrowUp"), true);
  assert.deepEqual(selections.at(-1), [5, 0, 8]);
  assert.equal(panel.handleShiftArrow("ArrowDown"), true);
  assert.equal(clearCalls, 1);
  assert.deepEqual(inputs, ["\u001b[D", "\u001b[D", "\u001b[C", "\u001b[A", "\u001b[B"]);
});

test("new terminal instances disable cursor blinking and forward each input event once", async () => {
  const panel = makePanel();
  const writes = [];
  let terminalInstance;

  class TerminalStub {
    constructor(options) {
      this.options = options;
      this.cols = 80;
      this.rows = 24;
      this.subscriptions = [];
      terminalInstance = this;
    }
    loadAddon() {}
    open() {}
    onData(listener) {
      this.onDataListener = listener;
      const subscription = { dispose() {} };
      this.subscriptions.push(subscription);
      return subscription;
    }
    onResize(listener) {
      this.onResizeListener = listener;
      const subscription = { dispose() {} };
      this.subscriptions.push(subscription);
      return subscription;
    }
    focus() {}
  }

  Object.assign(panel, {
    Terminal: TerminalStub,
    FitAddon: class {},
    WebLinksAddon: class {},
    view: new ElementStub(),
    getXtermTheme: () => ({ background: "#101010" }),
    fitRecord: async () => true,
    isActive: () => true,
    recomputeLabels() {},
    allocateDuplicateIndex: () => null,
    createBaseLabel: () => "zsh — project",
    notifyWorkspaceChanged() {},
  });
  panel.editor.bottomPanelManager.visible = false;
  panel.editor.api = {
    getTerminalWorkspaceScope: async () => ({ workspaceKey: "no-workspace" }),
    createTerminalSession: async () => ({
      success: true,
      sessionId: "session-one",
      workspaceKey: "no-workspace",
      shell: "zsh",
      cwd: "/workspace",
    }),
    writeTerminalSession: async (...args) => writes.push(args),
  };
  context.document = {
    activeElement: null,
    createElement: () => new ElementStub(),
  };

  const session = await panel.createTerminal({ focus: false, returnRecord: true });
  assert.equal(session.terminal.options.cursorBlink, false);

  terminalInstance.onDataListener("echo hello world ");
  await Promise.resolve();

  assert.deepEqual(writes, [
    ["session-one", "no-workspace", "echo hello world "],
  ]);
});

test("runtime tab registries, selection and persisted metadata stay isolated per workspace", () => {
  const panel = makePanel();
  const a = panel.getWorkspaceState("/canonical/a", "/projects/a");
  a.sessions.set("pty-a", record("pty-a", "/canonical/a", "zsh — a"));
  a.activeSessionId = "pty-a";
  const b = panel.getWorkspaceState("/canonical/b", "/projects/b");
  b.sessions.set("pty-b", record("pty-b", "/canonical/b", "zsh — b"));
  b.activeSessionId = "pty-b";

  panel.activateWorkspace("/canonical/a", "/projects/a");
  assert.deepEqual([...panel.sessions.keys()], ["pty-a"]);
  assert.deepEqual(JSON.parse(JSON.stringify(panel.getPersistedState())), {
    version: 1,
    activeTabIndex: 0,
    tabs: [{ baseLabel: "zsh — a", customLabel: null, duplicateIndex: null }],
  });
  assert.equal(JSON.stringify(panel.getPersistedState()).includes("pty-a"), false);
  assert.equal(JSON.stringify(panel.getPersistedState()).includes("secret"), false);

  panel.activateWorkspace("/canonical/b", "/projects/b");
  assert.deepEqual([...panel.sessions.keys()], ["pty-b"]);
  panel.activateWorkspace("/canonical/a", "/projects/a");
  assert.deepEqual([...panel.sessions.keys()], ["pty-a"]);
  assert.equal(panel.activeSessionId, "pty-a");
  assert.notEqual(panel.getWorkspaceState("no-workspace"), a);
});

test("persisted tabs restore as metadata without reusing PTY identifiers", () => {
  const panel = makePanel();
  panel.activateWorkspace("/canonical/project", "/project", {
    activeTabIndex: 1,
    tabs: [
      { baseLabel: "zsh — project", customLabel: null, duplicateIndex: null, sessionId: "old-uuid" },
      { baseLabel: "zsh — project", customLabel: null, duplicateIndex: 1, command: "npm start" },
    ],
  });
  const state = panel.currentState;
  assert.deepEqual(JSON.parse(JSON.stringify(state.pendingRestoreTabs)), [
    { baseLabel: "zsh — project", customLabel: null, duplicateIndex: null },
    { baseLabel: "zsh — project", customLabel: null, duplicateIndex: 1 },
  ]);
  assert.equal(state.sessions.size, 0);
  assert.equal(JSON.stringify(panel.getPersistedState()).includes("old-uuid"), false);
  assert.equal(JSON.stringify(panel.getPersistedState()).includes("npm start"), false);
});

test("duplicate labels keep a stable unsuffixed primary and allocate the first free positive index", () => {
  const panel = makePanel();
  const state = panel.getWorkspaceState("/a");
  const first = record("first", "/a", "zsh — project");
  state.sessions.set(first.id, first);
  first.duplicateIndex = panel.allocateDuplicateIndex(first, state);
  panel.recomputeLabels(state);
  assert.equal(first.displayLabel, "zsh — project");

  const second = record("second", "/a", "zsh — project");
  state.sessions.set(second.id, second);
  second.duplicateIndex = panel.allocateDuplicateIndex(second, state);
  panel.recomputeLabels(state);
  assert.deepEqual([first.displayLabel, second.displayLabel], ["zsh — project", "zsh — project (1)"]);

  const third = record("third", "/a", "zsh — project");
  state.sessions.set(third.id, third);
  third.duplicateIndex = panel.allocateDuplicateIndex(third, state);
  panel.recomputeLabels(state);
  assert.deepEqual([first.displayLabel, second.displayLabel, third.displayLabel], [
    "zsh — project", "zsh — project (1)", "zsh — project (2)",
  ]);

  state.sessions.delete(second.id);
  panel.recomputeLabels(state);
  assert.deepEqual([first.displayLabel, third.displayLabel], ["zsh — project", "zsh — project (2)"]);

  const fourth = record("fourth", "/a", "zsh — project");
  state.sessions.set(fourth.id, fourth);
  fourth.duplicateIndex = panel.allocateDuplicateIndex(fourth, state);
  panel.recomputeLabels(state);
  assert.equal(fourth.displayLabel, "zsh — project (1)");

  state.sessions.delete(first.id);
  state.sessions.delete(fourth.id);
  state.sessions.delete(third.id);
  state.sessions.set(third.id, third);
  panel.normalizeSingletonDuplicateIndices(state, "zsh — project");
  panel.recomputeLabels(state);
  assert.equal(third.displayLabel, "zsh — project");
});

test("custom names retain their value and collision suffixes stay workspace scoped", () => {
  const panel = makePanel();
  const a = panel.getWorkspaceState("/a");
  const first = record("first", "/a", "zsh — project", "Development");
  a.sessions.set(first.id, first);
  first.duplicateIndex = panel.allocateDuplicateIndex(first, a);
  const second = record("second", "/a", "npm — project", "Development");
  a.sessions.set(second.id, second);
  second.duplicateIndex = panel.allocateDuplicateIndex(second, a);
  panel.recomputeLabels(a);
  assert.deepEqual([first.customLabel, first.displayLabel, second.customLabel, second.displayLabel], [
    "Development", "Development", "Development", "Development (1)",
  ]);

  const b = panel.getWorkspaceState("/b");
  const otherWorkspace = record("other", "/b", "zsh — project");
  b.sessions.set(otherWorkspace.id, otherWorkspace);
  otherWorkspace.duplicateIndex = panel.allocateDuplicateIndex(otherWorkspace, b);
  panel.recomputeLabels(b);
  assert.equal(otherWorkspace.displayLabel, "zsh — project");
  assert.equal(JSON.parse(JSON.stringify(panel.getPersistedState("/a"))).tabs[1].duplicateIndex, 1);
});

test("open requests share one lazy first-terminal creation promise", async () => {
  const panel = makePanel();
  panel.activateWorkspace("no-workspace", null);
  const state = panel.currentState;
  let finish;
  let creates = 0;
  panel.restoreOrCreateInitialSessions = () => {
    creates++;
    return new Promise((resolve) => { finish = resolve; });
  };
  panel.onOpen();
  panel.onOpen();
  assert.equal(creates, 1);
  finish(true);
  await state.initialOpenPromise;
  assert.equal(state.sessions.size, 0, "the single creation attempt is coalesced");
});

test("tab management shortcuts operate on the active workspace's terminal sessions", () => {
  const panel = makePanel();
  const state = panel.getWorkspaceState("no-workspace");
  state.sessions.set("pty-one", record("pty-one", "no-workspace", "zsh — one"));
  state.sessions.set("pty-two", record("pty-two", "no-workspace", "zsh — two"));
  state.activeSessionId = "pty-two";
  const calls = [];
  panel.createTerminal = () => {
    calls.push("new");
    return Promise.resolve(true);
  };
  panel.closeSession = (id, options) => calls.push(`close:${id}:${options?.focusTerminal === true}`);
  panel.activateSession = (id, options) => {
    state.activeSessionId = id;
    calls.push(`activate:${id}:${options?.focusTerminal === true}`);
  };

  assert.equal(panel.handleTabKeybinding("new_file"), true);
  assert.equal(panel.handleTabKeybinding("close_file"), true);
  assert.equal(panel.handleTabKeybinding("previous_tab"), true);
  assert.equal(panel.handleTabKeybinding("next_tab"), true);
  assert.equal(panel.handleTabKeybinding("close_all_file"), true);
  assert.equal(panel.handleTabKeybinding("save"), false);

  assert.deepEqual(calls, [
    "new",
    "close:pty-two:true",
    "activate:pty-one:true",
    "activate:pty-two:true",
    "close:pty-one:false",
    "close:pty-two:false",
  ]);
});

test("session tab manager is shown only when at least two sessions are open", () => {
  context.document = { createElement: () => new ElementStub() };
  const panel = makePanel();
  const state = panel.currentState;
  const onlySession = record("only-session", state.workspaceKey, "zsh — project");
  onlySession.wrapper = { id: "terminal-view-only-session" };
  state.sessions.set(onlySession.id, onlySession);
  state.activeSessionId = onlySession.id;
  panel.tabsElement = new ElementStub();
  panel.tabsList = new ElementStub();
  panel.renderTabs = TerminalPanel.prototype.renderTabs;
  panel.showActive = () => {};

  panel.renderTabs();

  assert.equal(panel.tabsElement.hidden, true);
  assert.equal(panel.tabsList.hidden, true);
  assert.equal(panel.tabsList.children.length, 0);

  const secondSession = record("second-session", state.workspaceKey, "zsh — project 2");
  secondSession.wrapper = { id: "terminal-view-second-session" };
  state.sessions.set(secondSession.id, secondSession);
  panel.renderTabs();

  assert.equal(panel.tabsElement.hidden, false);
  assert.equal(panel.tabsList.hidden, false);
  assert.equal(panel.tabsList.children.length, 2);
  assert.equal(panel.tabsList.children[0].dataset.sessionId, "only-session");
  assert.equal(panel.tabsList.children[1].dataset.sessionId, "second-session");
  assert.equal(panel.tabsList.children[0].children[0].attributes.get("aria-selected"), "true");

  let activation = null;
  panel.activateSession = (id, options) => { activation = { id, options }; };
  panel.tabsList.children[1].children[0].listeners.get("click")();
  assert.equal(activation.id, "second-session");
  assert.equal(activation.options.focusTerminal, true);
});

test("selecting a terminal session tab returns keyboard focus to xterm", () => {
  const panel = makePanel();
  const state = panel.currentState;
  let terminalFocusCalls = 0;
  let tabFocusCalls = 0;
  let fitFocus = null;
  for (const id of ["first-session", "second-session"]) {
    const session = record(id, state.workspaceKey, id);
    session.terminal.focus = () => { terminalFocusCalls++; };
    state.sessions.set(id, session);
  }
  state.activeSessionId = "first-session";
  panel.tabsList = {
    contains: () => true,
    querySelectorAll: () => [{ focus() { tabFocusCalls++; } }],
  };
  panel.showActive = () => {};
  panel.scheduleFit = (options) => { fitFocus = options.focus; };
  context.document = {
    activeElement: { getAttribute: () => "tab" },
  };

  panel.activateSession("second-session", { focusTerminal: true });

  assert.equal(panel.activeSessionId, "second-session");
  assert.equal(terminalFocusCalls, 1);
  assert.equal(tabFocusCalls, 0);
  assert.equal(fitFocus, false);
});

test("next, previous and close shortcuts keep focus in the active terminal", async () => {
  const panel = makePanel();
  const state = panel.currentState;
  const focusCalls = new Map();
  for (const id of ["first-session", "second-session"]) {
    const session = record(id, state.workspaceKey, id);
    focusCalls.set(id, 0);
    session.terminal.focus = () => focusCalls.set(id, focusCalls.get(id) + 1);
    state.sessions.set(id, session);
  }
  state.activeSessionId = "first-session";
  panel.tabsList = { contains: () => false };
  panel.renderTabs = () => {};
  panel.showActive = () => {};
  panel.scheduleFit = () => {};
  panel.activateSession = TerminalPanel.prototype.activateSession;
  panel.closeSession = TerminalPanel.prototype.closeSession;
  context.document = { activeElement: {} };

  panel.handleTabKeybinding("next_tab");
  assert.equal(panel.activeSessionId, "second-session");
  assert.equal(focusCalls.get("second-session"), 1);

  panel.handleTabKeybinding("previous_tab");
  assert.equal(panel.activeSessionId, "first-session");
  assert.equal(focusCalls.get("first-session"), 1);

  panel.activeSessionId = "second-session";
  panel.handleTabKeybinding("close_file");
  assert.equal(panel.activeSessionId, "first-session");
  assert.equal(focusCalls.get("first-session"), 2);
  await Promise.resolve();
});

test("new terminal shortcut restores focus after the session is created", async () => {
  const panel = makePanel();
  const state = panel.currentState;
  let focusCalls = 0;
  const active = record("active-session", state.workspaceKey, "zsh — project");
  active.terminal.focus = () => { focusCalls++; };
  state.sessions.set(active.id, active);
  state.activeSessionId = active.id;
  panel.createTerminal = () => Promise.resolve(true);

  panel.handleTabKeybinding("new_file");
  await Promise.resolve();

  assert.equal(focusCalls, 1);
});

test("only the active workspace can close one of its terminal sessions", async () => {
  const panel = makePanel();
  const a = panel.getWorkspaceState("/a");
  const aRecord = record("pty-a", "/a", "zsh — a");
  a.sessions.set(aRecord.id, aRecord);
  a.activeSessionId = aRecord.id;
  const b = panel.getWorkspaceState("/b");
  const bRecord = record("pty-b", "/b", "zsh — b");
  b.sessions.set(bRecord.id, bRecord);
  b.activeSessionId = bRecord.id;
  panel.activateWorkspace("/b", "/projects/b");

  assert.equal(await panel.closeSession("pty-a"), false);
  assert.equal(panel.editor.api.closes.length, 0);
  assert.equal(await panel.closeSession("pty-b"), true);
  assert.deepEqual(panel.editor.api.closes, [["pty-b", "/b"]]);
  assert.equal(a.sessions.has("pty-a"), true);
  assert.equal(b.sessions.size, 0);
  assert.equal(panel.editor.bottomPanelManager.closePanelCalls, 1);
});

test("terminal sessions only resolve inside the active workspace", () => {
  const panel = makePanel();
  const local = record("local", "no-workspace", "zsh");
  const remote = record("remote", "/other", "zsh");
  panel.currentState.sessions.set(local.id, local);
  panel.currentState.sessions.set(remote.id, remote);

  assert.equal(panel.getSession("local"), local);
  assert.equal(panel.getSession("remote"), null);
  assert.equal(panel.getSession("missing"), null);
  assert.equal(panel.getSession(null), null);
  assert.equal(panel.getSession(undefined), null);
});

test("closing other terminals keeps the requested session active", () => {
  const panel = makePanel();
  const state = panel.currentState;
  const closed = [];
  for (const id of ["one", "two", "three"]) {
    state.sessions.set(id, record(id, state.workspaceKey, "zsh"));
  }
  panel.activateSession = (id) => {
    state.activeSessionId = id;
    return true;
  };
  panel.closeSession = (id) => {
    closed.push(id);
    return Promise.resolve(true);
  };

  assert.equal(panel.closeOtherSessions("two"), true);
  assert.equal(state.activeSessionId, "two");
  assert.deepEqual(closed, ["one", "three"]);
  assert.equal(panel.closeOtherSessions("missing"), false);
  assert.deepEqual(closed, ["one", "three"]);
});

test("right-clicking a terminal tab opens the tab menu for that session", () => {
  const panel = makePanel();
  const state = panel.currentState;
  const session = record("one", state.workspaceKey, "zsh");
  state.sessions.set(session.id, session);
  state.activeSessionId = session.id;
  const opened = [];
  let closedMenus = 0;
  const tab = { dataset: { sessionId: "one" } };
  const target = {
    closest(selector) { return selector === ".terminal-tab" ? tab : null; },
  };
  panel.tabsList = { contains: (node) => node === target || node === tab };
  panel.view = { contains: () => false };
  panel.actionsContainer = { contains: () => false };
  panel.editor.contextMenuManager = {
    openContextMenu(...args) { opened.push(args); },
  };
  panel.closeActionsMenu = () => { closedMenus++; };

  const event = contextMenuEvent(target);
  assert.equal(panel.handleContextMenu(event), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(opened)),
    [["terminal-tab", { id: "one" }]],
  );
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(closedMenus, 1);
});

test("right-clicking terminal output opens the terminal menu for the active session", () => {
  const panel = makePanel();
  const state = panel.currentState;
  const session = record("one", state.workspaceKey, "zsh");
  state.sessions.set(session.id, session);
  state.activeSessionId = session.id;
  const opened = [];
  const target = { closest: () => null };
  panel.tabsList = { contains: () => false };
  panel.view = { contains: (node) => node === target };
  panel.actionsContainer = { contains: () => false };
  panel.editor.contextMenuManager = {
    openContextMenu(...args) { opened.push(args); },
  };
  panel.closeActionsMenu = () => {};

  const event = contextMenuEvent(target);
  assert.equal(panel.handleContextMenu(event), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(opened)),
    [["terminal", { id: "one" }]],
  );
  assert.equal(event.prevented, true);

  state.activeSessionId = null;
  assert.equal(panel.handleContextMenu(contextMenuEvent(target)), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(opened.at(-1))),
    ["terminal", { id: null }],
  );
});

test("terminal context menus ignore controls, unknown tabs and foreign workspaces", () => {
  const panel = makePanel();
  const state = panel.currentState;
  state.sessions.set("local", record("local", state.workspaceKey, "zsh"));
  const opened = [];
  panel.editor.contextMenuManager = {
    openContextMenu(...args) { opened.push(args); },
  };
  panel.closeActionsMenu = () => {};
  const actionTarget = { closest: () => null };
  panel.actionsContainer = { contains: (node) => node === actionTarget };
  panel.tabsList = { contains: () => false };
  panel.view = { contains: () => false };

  const actionEvent = contextMenuEvent(actionTarget);
  assert.equal(panel.handleContextMenu(actionEvent), false);
  assert.equal(actionEvent.prevented, false);

  const outsideEvent = contextMenuEvent({ closest: () => null });
  assert.equal(panel.handleContextMenu(outsideEvent), false);
  assert.equal(outsideEvent.prevented, false);

  const remoteTab = { dataset: { sessionId: "remote" } };
  const remoteTarget = {
    closest(selector) { return selector === ".terminal-tab" ? remoteTab : null; },
  };
  panel.tabsList = {
    contains: (node) => node === remoteTarget || node === remoteTab,
  };
  const remoteEvent = contextMenuEvent(remoteTarget);
  assert.equal(panel.handleContextMenu(remoteEvent), false);
  assert.equal(remoteEvent.prevented, false);

  const renameInput = {
    closest(selector) {
      if (selector.includes("input")) return renameInput;
      if (selector === ".terminal-tab") return remoteTab;
      return null;
    },
  };
  panel.tabsList = {
    contains: (node) => node === renameInput || node === remoteTab,
  };
  const renameEvent = contextMenuEvent(renameInput);
  assert.equal(panel.handleContextMenu(renameEvent), false);
  assert.equal(renameEvent.prevented, false);
  assert.deepEqual(opened, []);
});

test("renaming a terminal from its context menu resolves the current tab button", () => {
  const panel = makePanel();
  const state = panel.currentState;
  const session = record("one", state.workspaceKey, "zsh — project");
  state.sessions.set(session.id, session);
  const input = {
    dataset: {},
    value: "",
    addEventListener() {},
    focus() {},
    select() {},
    setAttribute() {},
  };
  const button = {
    replacedWith: null,
    replaceWith(node) { this.replacedWith = node; },
  };
  let selector = null;
  panel.tabsList = {
    querySelector(value) { selector = value; return button; },
  };
  context.document = { createElement: () => input };

  assert.equal(panel.renameSession("one"), true);
  assert.equal(selector, "#terminal-tab-one");
  assert.equal(button.replacedWith, input);
  assert.equal(input.value, "zsh — project");
  assert.equal(panel.renameSession("missing"), false);
});
