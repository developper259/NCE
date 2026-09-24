const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { loadGlobal } = require("./helpers/runtime");

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

test("the command palette hides file commands outside a file tab", () => {
  let panelOptions;
  const KeyBinding = loadGlobal("src/js/addon/KeyBinding.js", "KeyBinding", {
    USERCONFIG_KEYBINDING: [
      { action: "open_command", key: "Meta+Shift+P", in_editor: false },
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
    ["select-color-theme", "open-settings-json", "quick_open", "toggle_search"],
  );
});

test("the command palette exposes settings categories", () => {
  let panelOptions;
  const KeyBinding = loadGlobal("src/js/addon/KeyBinding.js", "KeyBinding", {
    USERCONFIG_KEYBINDING: [],
    CONFIG_KEYBINDING_DISPLAY: (key) => key,
  });
  const editor = {
    tabManager: { activeFile: null },
    settingsView: {
      getSettings: () => [
        { category: "Editor" },
        { category: "Files" },
        { category: "Shortcuts" },
      ],
    },
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
