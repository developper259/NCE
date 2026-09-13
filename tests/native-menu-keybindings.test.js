const test = require("node:test");
const assert = require("node:assert/strict");

const { loadMain } = require("./helpers/main-runtime");
const {
  toElectronAccelerator,
} = require("../dist/ts/keybindings/ElectronAccelerator.js");

function createMenuHarness(overrides = {}) {
  const installed = [];

  class Menu {
    constructor() {
      this.items = [];
    }

    append(item) {
      this.items.push(item);
    }

    getMenuItemById(id) {
      for (const topLevel of this.items) {
        const item = topLevel.submenu?.find?.((child) => child.id === id);
        if (item) return item;
      }
      return null;
    }

    static setApplicationMenu(menu) {
      installed.push(menu);
    }
  }

  class MenuItem {
    constructor(options) {
      Object.assign(this, options);
    }
  }

  const values = new Map([
    ["files.autoSave", false],
    ["keybindings.new_file", "Mod+N"],
    ["keybindings.open_file", "Mod+O"],
    ["keybindings.quick_open", "Mod+P"],
    ["keybindings.go_to_line", "Mod+G"],
    ["keybindings.open_folder", "Mod+Shift+O"],
    ["keybindings.save", "Mod+S"],
    ["keybindings.close_file", "Mod+W"],
    ["keybindings.close_all_file", "Mod+Shift+W"],
    ["keybindings.undo", "Mod+Z"],
    ["keybindings.redo", "Mod+Y"],
    ["keybindings.cut", "Mod+X"],
    ["keybindings.copy", "Mod+C"],
    ["keybindings.paste", "Mod+V"],
    ["keybindings.find", "Mod+F"],
    ["keybindings.delete_line", "Mod+Shift+K"],
    ["keybindings.select_all", "Mod+A"],
    ["keybindings.toggle_file_explorer", "Mod+B"],
    ["keybindings.toggle_search", "Mod+Shift+F"],
    ["keybindings.toggle_agent", "Mod+L"],
    ["keybindings.open_settings", null],
    ["keybindings.quit_app", "Mod+Q"],
    ["keybindings.reload_window", "Mod+R"],
    ["keybindings.open_command", "Mod+Shift+P"],
    ...Object.entries(overrides),
  ]);

  const { AppMenu } = loadMain(
    "dist/ts/addon/Menu.js",
    { electron: { Menu, MenuItem, dialog: {} } },
    { process: { platform: "darwin" } },
  );
  const appMenu = new AppMenu(
    { webContents: { send() {} } },
    { app: { settings: { get: (key) => values.get(key) } } },
  );

  function item(label) {
    for (const topLevel of appMenu.menu.items) {
      const found = topLevel.submenu?.find?.((child) => child.label === label);
      if (found) return found;
    }
    throw new Error(`Missing native menu item: ${label}`);
  }

  return { appMenu, installed, item, values };
}

test("NCE shortcuts convert to Electron accelerators through one normalizer", () => {
  assert.equal(toElectronAccelerator("Mod+F"), "CommandOrControl+F");
  assert.equal(
    toElectronAccelerator("Mod+Shift+P"),
    "CommandOrControl+Shift+P",
  );
  assert.equal(
    toElectronAccelerator("Mod+Alt+X"),
    "CommandOrControl+Alt+X",
  );
  assert.equal(toElectronAccelerator("Ctrl+Alt+X"), "Control+Alt+X");
  assert.equal(toElectronAccelerator("Mod+^", "darwin"), undefined);
  assert.equal(
    toElectronAccelerator("Mod+^", "win32"),
    "CommandOrControl+^",
  );
  assert.equal(toElectronAccelerator("Mod+Shift+¨"), undefined);
  assert.equal(toElectronAccelerator("Hyper+X"), undefined);
  assert.equal(toElectronAccelerator(null), undefined);
});

test("native menu rebuilds from current keybindings and preserves static items", () => {
  const { appMenu, installed, item, values } = createMenuHarness({
    "files.autoSave": true,
  });

  assert.equal(item("Find").accelerator, "CommandOrControl+F");
  assert.equal(
    item("Command Palette").accelerator,
    "CommandOrControl+Shift+P",
  );
  assert.equal(item("File Explorer").accelerator, "CommandOrControl+B");
  assert.equal(item("Quick Open...").accelerator, "CommandOrControl+P");
  assert.equal(item("Go to Line...").accelerator, "CommandOrControl+G");
  assert.equal(item("Agent").accelerator, "CommandOrControl+L");
  assert.equal(item("Settings...").accelerator, undefined);
  assert.equal(item("Quit NCE").accelerator, "CommandOrControl+Q");
  assert.equal(item("Reload Window").accelerator, "CommandOrControl+R");
  assert.equal(item("Save As...").accelerator, "CommandOrControl+Shift+S");
  assert.equal(appMenu.autoSaveItem.checked, true);
  assert.equal(item("Find").enabled, false);
  assert.equal(item("Go to Line...").enabled, false);
  assert.equal(item("Delete Line").enabled, false);

  appMenu.setFileActionsEnabled(true);
  assert.equal(item("Find").enabled, true);
  assert.equal(item("Go to Line...").enabled, true);
  assert.equal(item("Delete Line").enabled, true);

  values.set("keybindings.find", "Mod+L");
  values.set("keybindings.open_command", "Mod+Alt+P");
  values.set("keybindings.save", "Mod+Alt+S");
  appMenu.refreshKeybindings();

  assert.equal(item("Find").accelerator, "CommandOrControl+L");
  assert.notEqual(item("Find").accelerator, "CommandOrControl+F");
  assert.equal(
    item("Command Palette").accelerator,
    "CommandOrControl+Alt+P",
  );
  assert.equal(item("Save").accelerator, "CommandOrControl+Alt+S");
  assert.equal(appMenu.autoSaveItem.checked, true);
  assert.equal(item("Find").enabled, true);

  values.set("keybindings.find", null);
  appMenu.refreshKeybindings();
  assert.equal(item("Find").label, "Find");
  assert.equal(item("Find").accelerator, undefined);

  values.set("keybindings.find", "Mod+F");
  appMenu.refreshKeybindings();
  assert.equal(item("Find").accelerator, "CommandOrControl+F");
  let findCalls = 0;
  appMenu.find = () => findCalls++;
  item("Find").click();
  assert.equal(findCalls, 1);
  assert.equal(installed.length, 4);
  assert.equal(installed.at(-1), appMenu.menu);
  assert.equal(
    appMenu.menu.items.filter((entry) => entry.label === "Edit").length,
    1,
  );
});

test("Window refreshes the native menu only after a persisted keybinding change", async () => {
  const savedKeys = [];
  let refreshes = 0;
  let autoSaveUpdates = 0;
  const fileContextUpdates = [];
  const { Window } = loadMain("dist/ts/Window.js", {
    electron: {},
    "./addon/FileManager": { FileManager: class {} },
    "./addon/Watcher": { Watcher: class {} },
    "./addon/Menu": { AppMenu: class {} },
    "./addon/ContextMenu": { ContextMenu: class {} },
    "./addon/WorkspaceSearch": { WorkspaceSearch: class {} },
    "./App": { App: class {} },
  });
  const window = new Window({
    settings: {
      set: async (key, value) => {
        savedKeys.push(key);
        return !(key === "keybindings.find" && value === "Mod+P");
      },
    },
  });
  window.appMenu = {
    refreshKeybindings: () => refreshes++,
    setAutoSaveState: () => autoSaveUpdates++,
    setFileActionsEnabled: (enabled) => fileContextUpdates.push(enabled),
  };

  assert.equal(await window.setSetting("keybindings.find", "Mod+L"), true);
  assert.equal(refreshes, 1);
  assert.equal(await window.setSetting("keybindings.find", "Mod+P"), false);
  assert.equal(refreshes, 1);
  assert.equal(await window.setSetting("editor.tabWidth", 4), true);
  assert.equal(refreshes, 1);
  assert.equal(await window.setSetting("files.autoSave", true), true);
  assert.equal(autoSaveUpdates, 1);
  assert.deepEqual(savedKeys, [
    "keybindings.find",
    "keybindings.find",
    "editor.tabWidth",
    "files.autoSave",
  ]);
  assert.equal(window.setActiveFileContext(true), true);
  assert.equal(window.setActiveFileContext(false), true);
  assert.equal(window.setActiveFileContext("false"), false);
  assert.deepEqual(fileContextUpdates, [true, false]);
});
