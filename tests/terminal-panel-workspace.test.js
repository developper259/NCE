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
    tabs: [{ baseLabel: "zsh — a", customLabel: null }],
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
      { baseLabel: "zsh — project", customLabel: null, sessionId: "old-uuid" },
      { baseLabel: "npm — project", customLabel: "Dev server", command: "npm start" },
    ],
  });
  const state = panel.currentState;
  assert.deepEqual(JSON.parse(JSON.stringify(state.pendingRestoreTabs)), [
    { baseLabel: "zsh — project", customLabel: null },
    { baseLabel: "npm — project", customLabel: "Dev server" },
  ]);
  assert.equal(state.sessions.size, 0);
  assert.equal(JSON.stringify(panel.getPersistedState()).includes("old-uuid"), false);
  assert.equal(JSON.stringify(panel.getPersistedState()).includes("npm start"), false);
});

test("smart labels omit suffixes for single tabs and recalculate after duplicate close", () => {
  const panel = makePanel();
  const state = panel.getWorkspaceState("/a");
  const first = record("first", "/a", "zsh — project");
  const second = record("second", "/a", "zsh — project");
  state.sessions.set(first.id, first);
  state.sessions.set(second.id, second);
  panel.recomputeLabels(state);
  assert.deepEqual([first.displayLabel, second.displayLabel], [
    "zsh — project (1)", "zsh — project (2)",
  ]);
  state.sessions.delete(second.id);
  panel.recomputeLabels(state);
  assert.equal(first.displayLabel, "zsh — project");

  first.customLabel = "Python REPL";
  const renamed = record("renamed", "/a", "python — project", "Build output");
  state.sessions.set(renamed.id, renamed);
  panel.recomputeLabels(state);
  assert.deepEqual([first.displayLabel, renamed.displayLabel], ["Python REPL", "Build output"]);
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
