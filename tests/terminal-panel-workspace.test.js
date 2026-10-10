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
  panel.createTerminal = () => calls.push("new");
  panel.closeSession = (id) => calls.push(`close:${id}`);
  panel.activateSession = (id) => {
    state.activeSessionId = id;
    calls.push(`activate:${id}`);
  };

  assert.equal(panel.handleTabKeybinding("new_file"), true);
  assert.equal(panel.handleTabKeybinding("close_file"), true);
  assert.equal(panel.handleTabKeybinding("previous_tab"), true);
  assert.equal(panel.handleTabKeybinding("next_tab"), true);
  assert.equal(panel.handleTabKeybinding("close_all_file"), true);
  assert.equal(panel.handleTabKeybinding("save"), false);

  assert.deepEqual(calls, [
    "new",
    "close:pty-two",
    "activate:pty-one",
    "activate:pty-two",
    "close:pty-one",
    "close:pty-two",
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
