const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadGlobal, root } = require("./helpers/runtime");

function setup() {
  const calls = [];
  const sessions = new Map();
  const panel = {
    sessions,
    getSession(id) {
      return sessions.get(id) || null;
    },
    isActive(record) {
      return record?.active === true;
    },
    runAction(action) {
      calls.push(["run", action]);
    },
    createTerminal() {
      calls.push(["create"]);
    },
    closeSession(id) {
      calls.push(["close", id]);
    },
    closeOtherSessions(id) {
      calls.push(["closeOthers", id]);
    },
    closeAllSessions() {
      calls.push(["closeAll"]);
    },
    renameSession(id, button = null) {
      calls.push(button ? ["rename", id, button] : ["rename", id]);
    },
  };
  const bindings = {
    select_all: "Mod+A",
    copy: "Mod+C",
    paste: "Mod+V",
    new_terminal: "Mod+Shift+J",
    close_file: "Mod+W",
  };
  const builders = loadGlobal(
    "src/js/contextMenu/Terminal.ContextMenu.js",
    "({ buildTerminalContextMenu, buildTerminalTabContextMenu })",
    {
      CONFIG_KEYBINDING_GET_ACTION: (action) => ({ key: bindings[action] }),
    },
  );
  const editor = { terminalPanel: panel };
  return {
    calls,
    sessions,
    panel,
    editor,
    builders,
    menu: builders.buildTerminalContextMenu(editor),
    tabMenu: builders.buildTerminalTabContextMenu(editor),
  };
}

function session(id, overrides = {}) {
  return {
    id,
    active: false,
    terminal: { getSelection: () => "" },
    ...overrides,
  };
}

test("terminal context menu exposes clipboard, clear and lifecycle actions in order", () => {
  const { menu } = setup();
  assert.deepEqual(Object.keys(menu), [
    "selectAll",
    "copy",
    "paste",
    "sep1",
    "clear",
    "sep2",
    "newTerminal",
    "close",
  ]);
});

test("terminal tab context menu exposes rename and close variants in order", () => {
  const { tabMenu } = setup();
  assert.deepEqual(Object.keys(tabMenu), [
    "newTerminal",
    "rename",
    "sep1",
    "close",
    "closeOthers",
    "closeAll",
  ]);
});

test("terminal body actions follow the active session and selection state", () => {
  const { menu, sessions } = setup();
  const active = session("active", { active: true });
  const idle = session("idle");
  sessions.set(active.id, active);
  sessions.set(idle.id, idle);

  assert.equal(menu.selectAll.enabled({ id: "active" }), true);
  assert.equal(menu.copy.enabled({ id: "active" }), false);
  assert.equal(menu.paste.enabled({ id: "active" }), true);
  assert.equal(menu.clear.enabled({ id: "active" }), true);
  assert.equal(menu.selectAll.enabled({ id: "idle" }), false);
  assert.equal(menu.paste.enabled({ id: "missing" }), false);
  assert.equal(menu.close.enabled({ id: "idle" }), true);

  active.terminal.getSelection = () => "npm test";
  assert.equal(menu.copy.enabled({ id: "active" }), true);
});

test("terminal body callbacks operate on the active terminal", () => {
  const { menu, sessions, calls } = setup();
  const active = session("active", { active: true });
  sessions.set(active.id, active);

  menu.selectAll.callback({ id: "active" });
  menu.copy.callback({ id: "active" });
  menu.paste.callback({ id: "active" });
  menu.clear.callback({ id: "active" });
  menu.newTerminal.callback();
  menu.close.callback({ id: "active" });
  menu.close.callback({ id: "missing" });

  assert.deepEqual(calls, [
    ["run", "select-all"],
    ["run", "copy"],
    ["run", "paste"],
    ["run", "clear"],
    ["create"],
    ["close", "active"],
  ]);
});

test("terminal tab actions follow session count and session identity", () => {
  const { tabMenu, sessions } = setup();
  const one = session("one", { active: true });
  sessions.set(one.id, one);

  assert.equal(tabMenu.newTerminal.enabled(), true);
  assert.equal(tabMenu.rename.enabled({ id: "one" }), true);
  assert.equal(tabMenu.close.enabled({ id: "one" }), true);
  assert.equal(tabMenu.closeOthers.enabled({ id: "one" }), false);
  assert.equal(tabMenu.closeAll.enabled(), true);
  assert.equal(tabMenu.rename.enabled({ id: "missing" }), false);
  assert.equal(tabMenu.close.enabled({ id: "missing" }), false);

  sessions.set("two", session("two"));
  assert.equal(tabMenu.closeOthers.enabled({ id: "one" }), true);

  sessions.clear();
  assert.equal(tabMenu.closeAll.enabled(), false);
});

test("terminal tab callbacks target the right-clicked tab", () => {
  const { tabMenu, sessions, calls } = setup();
  sessions.set("one", session("one", { active: true }));
  sessions.set("two", session("two"));

  tabMenu.newTerminal.callback();
  tabMenu.rename.callback({ id: "two" });
  tabMenu.close.callback({ id: "two" });
  tabMenu.closeOthers.callback({ id: "two" });
  tabMenu.closeAll.callback();
  tabMenu.close.callback({ id: "missing" });

  assert.deepEqual(calls, [
    ["create"],
    ["rename", "two"],
    ["close", "two"],
    ["closeOthers", "two"],
    ["closeAll"],
  ]);
});

test("terminal context menu shortcuts reuse configurable keybindings", () => {
  const { menu, tabMenu } = setup();
  assert.equal(menu.selectAll.keys(), "CommandOrControl+A");
  assert.equal(menu.copy.keys(), "CommandOrControl+C");
  assert.equal(menu.paste.keys(), "CommandOrControl+V");
  assert.equal(menu.newTerminal.keys(), "CommandOrControl+Shift+J");
  assert.equal(menu.close.keys(), "CommandOrControl+W");
  assert.equal(tabMenu.newTerminal.keys(), "CommandOrControl+Shift+J");
  assert.equal(tabMenu.close.keys(), "CommandOrControl+W");
});

test("terminal context menus stay inert without a terminal panel", () => {
  const { editor, menu, tabMenu } = (() => {
    const builders = loadGlobal(
      "src/js/contextMenu/Terminal.ContextMenu.js",
      "({ buildTerminalContextMenu, buildTerminalTabContextMenu })",
      { CONFIG_KEYBINDING_GET_ACTION: () => null },
    );
    const target = { terminalPanel: null };
    return {
      editor: target,
      menu: builders.buildTerminalContextMenu(target),
      tabMenu: builders.buildTerminalTabContextMenu(target),
    };
  })();

  assert.equal(editor.terminalPanel, null);
  assert.equal(menu.newTerminal.enabled(), false);
  assert.equal(menu.selectAll.enabled({ id: "active" }), false);
  assert.equal(menu.close.enabled({ id: "active" }), false);
  assert.equal(tabMenu.newTerminal.enabled(), false);
  assert.equal(tabMenu.closeAll.enabled(), false);
  assert.equal(menu.copy.keys(), null);
  assert.doesNotThrow(() => {
    menu.copy.callback();
    menu.close.callback({ id: "active" });
    tabMenu.closeAll.callback();
  });
});

test("terminal body callbacks stay scoped to the right-clicked session", () => {
  const { menu, sessions, calls } = setup();
  sessions.set("active", session("active", { active: true }));
  sessions.set("idle", session("idle"));

  menu.selectAll.callback({ id: "idle" });
  menu.copy.callback({ id: "idle" });
  menu.paste.callback(null);
  menu.clear.callback({ id: "missing" });
  assert.deepEqual(calls, []);

  menu.selectAll.callback({ id: "active" });
  assert.deepEqual(calls, [["run", "select-all"]]);
});

test("ContextMenuManager exposes terminal actions as native menu items", async () => {
  const { editor, sessions, calls, builders } = setup();
  sessions.set("active", session("active", { active: true }));
  let listener = null;
  const payloads = [];
  const window = {
    api: {
      onContextMenuTriggered(callback) { listener = callback; },
      async openContextMenu(actions) { payloads.push(actions); },
    },
  };
  const ContextMenuManager = loadGlobal(
    "src/js/manager/ContextMenuManager.js",
    "ContextMenuManager",
    { window },
  );
  const manager = new ContextMenuManager();
  manager.setMenu("terminal", builders.buildTerminalContextMenu(editor));
  manager.setMenu("terminal-tab", builders.buildTerminalTabContextMenu(editor));
  const summarize = (payload) => Array.from(payload, (item) =>
    item.type === "separator" ? "separator" : [item.name, item.enabled]);

  await manager.openContextMenu("terminal", { id: "active" });
  assert.deepEqual(summarize(payloads[0]), [
    ["Select All", true],
    ["Copy Selection", false],
    ["Paste", true],
    "separator",
    ["Clear Terminal", true],
    "separator",
    ["New Terminal", true],
    ["Close Terminal", true],
  ]);
  assert.equal(payloads[0][0].keys, "CommandOrControl+A");
  assert.equal(payloads[0][6].keys, "CommandOrControl+Shift+J");

  listener("Copy Selection");
  assert.deepEqual(calls, []);

  await manager.openContextMenu("terminal", { id: "active" });
  listener("Select All");
  assert.deepEqual(calls, [["run", "select-all"]]);

  calls.length = 0;
  await manager.openContextMenu("terminal-tab", { id: "active" });
  assert.deepEqual(summarize(payloads[2]), [
    ["New Terminal", true],
    ["Rename", true],
    "separator",
    ["Close", true],
    ["Close Others", false],
    ["Close All", true],
  ]);
  listener("Rename");
  assert.deepEqual(calls, [["rename", "active"]]);
});

test("terminal context menus are registered in the core renderer bundle", () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(root, "src/js/main/renderer-scripts.json"),
    "utf8",
  ));
  const scriptIndex = manifest.indexOf("js/contextMenu/Terminal.ContextMenu.js");
  assert.notEqual(scriptIndex, -1);
  assert.ok(scriptIndex < manifest.indexOf("js/main/Editor.js"));

  const editor = fs.readFileSync(path.join(root, "src/js/main/Editor.js"), "utf8");
  assert.match(editor, /"terminal",\s*buildTerminalContextMenu\(this\)/);
  assert.match(editor, /"terminal-tab",\s*buildTerminalTabContextMenu\(this\)/);
});
