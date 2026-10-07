const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { loadGlobal } = require("./helpers/runtime");

function createTabActionFixture(types) {
  const tabs = types.map((type, id) => ({ id: id + 1, type }));
  const activeTab = tabs.at(-1) || null;
  const calls = [];
  const tabManager = {
    tabs,
    activeTab,
    activeFile: activeTab?.type === "file" ? activeTab : null,
    closeActiveFile: () => calls.push(["close_file", activeTab]),
    closeFiles: () => calls.push(["close_all_file"]),
  };
  tabManager.keyBinding = new (loadGlobal(
    "src/js/addon/KeyBinding.js",
    "KeyBinding",
  ))({ tabManager });
  return { tabs, activeTab, calls, tabManager, keyBinding: tabManager.keyBinding };
}

function getTitleBarCloseItems(fixture) {
  const TitleBar = loadGlobal("src/js/addon/TitleBar.js", "TitleBar");
  const items = ["close_file", "close_all_file", "save", "unselect_all"].map((command) => ({
    dataset: { command, staticDisabled: "false" },
    disabled: false,
  }));
  const titleBar = Object.create(TitleBar.prototype);
  titleBar.editor = {
    tabManager: fixture.tabManager,
    keyBinding: fixture.keyBinding,
  };
  titleBar.root = {
    querySelectorAll: () => items,
    querySelector: () => null,
  };
  titleBar.refreshDisabledItems();
  return new Map(items.map((item) => [item.dataset.command, item.disabled]));
}

test("file editing commands do nothing when the active tab is not a file", async () => {
  const calls = [];
  const editor = {
    tabManager: {
      activeFile: null,
      closeActiveFile: () => calls.push("close-file"),
      closeFiles: () => calls.push("close-all-files"),
    },
    goToLine: { open: () => calls.push("go-to-line") },
    searchController: { toggle: () => calls.push("find") },
    historyController: {
      undo: () => calls.push("undo"),
      redo: () => calls.push("redo"),
    },
    lineController: { lines: [{}] },
    cursorController: { row: 1 },
    writerController: { deleteRange: () => calls.push("delete-line") },
    selectController: {
      containsSelected: "",
      hasActiveSelection: () => false,
      selectAll: () => calls.push("select-all"),
    },
    api: { quit: () => calls.push("quit") },
  };
  const KeyBinding = loadGlobal("src/js/addon/KeyBinding.js", "KeyBinding", {
    document: { hasFocus: () => true },
    navigator: {
      clipboard: {
        readText: async () => "text",
        writeText: async () => {},
      },
    },
  });
  const keyBinding = new KeyBinding(editor);

  keyBinding.control_go_to_line();
  await keyBinding.control_close_file();
  await keyBinding.control_close_all_file();
  keyBinding.control_find();
  keyBinding.control_delete_line();
  keyBinding.control_select_all();
  keyBinding.control_undo();
  keyBinding.control_redo();
  await keyBinding.control_copy();
  await keyBinding.control_paste();
  await keyBinding.control_cut();

  assert.deepEqual(calls, []);

  keyBinding.control_quit_app();
  assert.deepEqual(calls, ["quit"]);
});

test("active non-file tabs can be closed without enabling text commands", async () => {
  const calls = [];
  const KeyBinding = loadGlobal("src/js/addon/KeyBinding.js", "KeyBinding");
  const tab = { id: 1, type: "picture" };
  const keyBinding = new KeyBinding({
    tabManager: {
      tabs: [tab], activeTab: tab, activeFile: null,
      closeActiveFile: () => calls.push("close-tab"),
      closeFiles: () => calls.push("close-tabs"),
    },
  });
  await keyBinding.control_close_file();
  await keyBinding.control_close_all_file();
  assert.deepEqual(calls, ["close-tab", "close-tabs"]);
});

for (const [label, types] of [
  ["code", ["file"]],
  ["Markdown", ["markdown"]],
  ["image", ["picture"]],
  ["Settings", ["settings"]],
  ["mixed", ["file", "markdown"]],
  ["multiple non-code", ["settings", "picture"]],
]) {
  test(`close shortcuts and TitleBar actions are enabled for ${label} tabs`, () => {
    const fixture = createTabActionFixture(types);
    const titleBarDisabled = getTitleBarCloseItems(fixture);

    assert.equal(fixture.keyBinding.isActionEnabled("close_file"), true);
    assert.equal(fixture.keyBinding.isActionEnabled("close_all_file"), true);
    assert.equal(titleBarDisabled.get("close_file"), false);
    assert.equal(titleBarDisabled.get("close_all_file"), false);
    assert.equal(titleBarDisabled.get("save"), types.at(-1) !== "file");
    assert.equal(titleBarDisabled.get("unselect_all"), types.at(-1) !== "file");
  });
}

test("close shortcuts dispatch to the same active-tab and open-tabs actions", () => {
  const fixture = createTabActionFixture(["file", "settings", "picture"]);

  fixture.keyBinding.exec({ action: "close_file" }, {});
  fixture.keyBinding.exec({ action: "close_all_file" }, {});

  assert.deepEqual(fixture.calls, [
    ["close_file", fixture.activeTab],
    ["close_all_file"],
  ]);
});

test("close actions and TitleBar controls are disabled when no tabs are open", () => {
  const fixture = createTabActionFixture([]);
  const titleBarDisabled = getTitleBarCloseItems(fixture);

  fixture.keyBinding.exec({ action: "close_file" }, {});
  fixture.keyBinding.exec({ action: "close_all_file" }, {});

  assert.deepEqual(fixture.calls, []);
  assert.equal(titleBarDisabled.get("close_file"), true);
  assert.equal(titleBarDisabled.get("close_all_file"), true);
  assert.equal(titleBarDisabled.get("save"), true);
  assert.equal(titleBarDisabled.get("unselect_all"), true);
});

test("the command palette hides file commands outside a file tab", () => {
  let panelOptions;
  const KeyBinding = loadGlobal("src/js/addon/KeyBinding.js", "KeyBinding", {
    USERCONFIG_KEYBINDING: [
      { action: "open_command", key: "Meta+Shift+P", in_editor: false },
      { action: "save_as", key: "Meta+Shift+S", in_editor: false },
      { action: "quick_open", key: "Meta+P", in_editor: false },
      { action: "find", key: "Meta+F", in_editor: false },
      { action: "go_to_line", key: "Meta+G", in_editor: false },
      { action: "delete_line", key: "Meta+Shift+K", in_editor: false },
      { action: "toggle_search", key: "Meta+Shift+F", in_editor: false },
    ],
    CONFIG_KEYBINDING_DISPLAY: (key) => key,
  });
  const keyBinding = new KeyBinding({
    tabManager: { activeFile: null, prepareForQuit: async () => true },
    quickPanel: {
      isOpen: () => false,
      open: (options) => {
        panelOptions = options;
      },
    },
  });

  keyBinding.control_open_command();

  assert.deepEqual(
    [...panelOptions.items].map((item) => item.id),
    ["select-color-theme", "open-settings-json", "developer-performance", "quick_open", "toggle_search"],
  );
});

test("the command palette exposes Save As when a file is active", () => {
  let panelOptions;
  const KeyBinding = loadGlobal("src/js/addon/KeyBinding.js", "KeyBinding", {
    USERCONFIG_KEYBINDING: [
      { action: "open_command", key: "Meta+Shift+P", in_editor: false },
      { action: "save_as", key: "Mod+Shift+S", in_editor: false },
    ],
    CONFIG_KEYBINDING_DISPLAY: (key) => key,
  });
  const keyBinding = new KeyBinding({
    tabManager: { activeFile: { path: "/workspace/file.js" } },
    quickPanel: {
      isOpen: () => false,
      open: (options) => { panelOptions = options; },
    },
  });

  keyBinding.control_open_command();

  const saveAs = panelOptions.items.find((item) => item.id === "save_as");
  assert.equal(saveAs.label, "Save As");
  assert.equal(saveAs.shortcut, "Mod+Shift+S");
});

test("Save and Save As dispatch to separate file operations", () => {
  const calls = [];
  const KeyBinding = loadGlobal("src/js/addon/KeyBinding.js", "KeyBinding");
  const keyBinding = new KeyBinding({
    tabManager: {
      activeFile: {
        async save() { calls.push("save"); },
        async saveAs() { calls.push("save-as"); },
      },
    },
  });

  keyBinding.exec({ action: "save" }, { shiftKey: true });
  keyBinding.exec({ action: "save_as" }, {});

  assert.deepEqual(calls, ["save", "save-as"]);
});

test("the command palette exposes settings categories", () => {
  let panelOptions;
  const SettingsView = {
    getSettings: () => [
      { category: "Editor" },
      { category: "Files" },
      { category: "Shortcuts" },
    ],
  };
  const KeyBinding = loadGlobal("src/js/addon/KeyBinding.js", "KeyBinding", {
    SettingsView,
    USERCONFIG_KEYBINDING: [],
    CONFIG_KEYBINDING_DISPLAY: (key) => key,
  });
  const editor = {
    tabManager: { activeFile: null },
    get settingsView() { throw new Error("Settings view should stay lazy"); },
    quickPanel: {
      isOpen: () => false,
      open: (options) => { panelOptions = options; },
    },
  };
  const keyBinding = new KeyBinding(editor);
  keyBinding.control_open_command();

  assert.deepEqual([...panelOptions.items].map((item) => item.label), [
    "Select Color Theme",
    "Open Settings (JSON)",
    "Open Editor Settings (UI)",
    "Open Files Settings (UI)",
    "Open Shortcuts Settings (UI)",
    "Developer: Performance",
  ]);
});

test("Reload Window saves the current state before reloading", async () => {
  const calls = [];
  const KeyBinding = loadGlobal("src/js/addon/KeyBinding.js", "KeyBinding");
  const keyBinding = new KeyBinding({
    isOnInit: false,
    tabManager: { activeFile: null, prepareForQuit: async () => true },
    statesManager: {
      save: async () => {
        calls.push("save-state");
        return true;
      },
    },
    api: {
      appCommand: async (command) => {
        calls.push(command);
        return true;
      },
    },
  });

  assert.equal(await keyBinding.control_reload_window(), true);
  assert.deepEqual(calls, ["save-state", "view.reload"]);
});

test("Reload Window is cancelled when saving the state fails", async () => {
  const calls = [];
  const KeyBinding = loadGlobal("src/js/addon/KeyBinding.js", "KeyBinding");
  const keyBinding = new KeyBinding({
    isOnInit: false,
    tabManager: { activeFile: null, prepareForQuit: async () => true },
    statesManager: { save: async () => false },
    api: { appCommand: (command) => calls.push(command) },
  });

  assert.equal(await keyBinding.control_reload_window(), false);
  assert.deepEqual(calls, []);
});

test("Reload Window stops when the dirty-file flow is cancelled", async () => {
  const calls = [];
  const KeyBinding = loadGlobal("src/js/addon/KeyBinding.js", "KeyBinding");
  const keyBinding = new KeyBinding({
    isOnInit: false,
    tabManager: { activeFile: null, prepareForQuit: async () => false },
    statesManager: { save: async () => calls.push("save-state") },
    api: { appCommand: (command) => calls.push(command) },
  });

  assert.equal(await keyBinding.control_reload_window(), false);
  assert.deepEqual(calls, []);
});

test("Reload Window is unavailable while the editor is initializing", async () => {
  const calls = [];
  const KeyBinding = loadGlobal("src/js/addon/KeyBinding.js", "KeyBinding");
  const keyBinding = new KeyBinding({
    isOnInit: true,
    tabManager: { prepareForQuit: async () => calls.push("prepare-for-quit") },
    statesManager: { save: async () => calls.push("save-state") },
    api: { appCommand: (command) => calls.push(command) },
  });

  assert.equal(await keyBinding.control_reload_window(), false);
  assert.deepEqual(calls, []);
});

test("tab and titlebar propagate the active file context to both menus", () => {
  const root = path.resolve(__dirname, "..");
  const tabManager = fs.readFileSync(
    path.join(root, "src/js/manager/TabManager.js"),
    "utf8",
  );
  const titleBar = fs.readFileSync(
    path.join(root, "src/js/addon/TitleBar.js"),
    "utf8",
  );

  assert.match(
    tabManager,
    /setActiveFileContext\?\.\(Boolean\(this\.activeFile\)\)/,
  );
  assert.match(
    titleBar,
    /\["Go to Line\.\.\.", "go_to_line", \{ needsFile: true \}\]/,
  );
});
