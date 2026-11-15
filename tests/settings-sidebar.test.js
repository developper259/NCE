const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");
const { loadMain } = require("./helpers/main-runtime");

const root = path.resolve(__dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

const loadEditorClass = () =>
  loadGlobal("src/js/main/Editor.js", "Editor", {
    document: { addEventListener() {} },
    window: {},
  });

test("sidebar Settings button opens the native menu anchored right of the icon", () => {
  const sidebar = read("src/js/manager/SidebarManager.js");
  const css = read("src/css/sidebar.css");
  const manifest = JSON.parse(read("src/js/main/renderer-scripts.json"));
  const editorSource = read("src/js/main/Editor.js");
  const preload = read("src/js/main/Preload.js");
  const manager = read("src/js/manager/ContextMenuManager.js");

  assert.match(sidebar, /sidebar-settings-container/);
  assert.match(
    sidebar,
    /openContextMenu\("sidebar-settings", null, \{/,
    "the Settings button opens the native settings menu with an anchor position",
  );
  assert.match(
    sidebar,
    /x: buttonRect\.right,/,
    "the menu left edge is snug against the Settings button right edge",
  );
  assert.match(
    sidebar,
    /y: iconRect\.bottom,/,
    "the menu bottom is anchored to the Settings icon bottom",
  );
  assert.match(
    sidebar,
    /verticalAlign: "bottom",/,
    "the anchor is a bottom edge, not a top edge",
  );
  assert.match(sidebar, /settingsButton\.getBoundingClientRect\(\)/);
  assert.match(sidebar, /settingsIcon\.getBoundingClientRect\(\)/);
  assert.match(sidebar, /aria-haspopup/, "Settings exposes menu semantics");
  assert.doesNotMatch(sidebar, /sidebar-settings-menu/, "no custom settings panel DOM");
  assert.doesNotMatch(sidebar, /toggleSettingsMenu|openSettingsMenu|closeSettingsMenu/);
  assert.doesNotMatch(css, /\.sidebar-settings-menu/, "no custom settings panel CSS");
  assert.match(
    sidebar,
    /closest\("\.sidebar-tab-icon\[data-menu-id\]"\)/,
    "Settings must not enter the regular sidebar menu delegation",
  );
  const builderIndex = manifest.indexOf("js/contextMenu/SidebarSettings.ContextMenu.js");
  assert.ok(builderIndex >= 0, "settings builder is bundled");
  assert.ok(
    builderIndex < manifest.indexOf("js/main/Editor.js"),
    "settings builder loads before Editor",
  );
  assert.match(
    editorSource,
    /setMenu\(\s*"sidebar-settings",\s*buildSidebarSettingsContextMenu\(this\)/,
    "Editor registers the native settings menu",
  );
  assert.match(
    manager,
    /openContextMenu\(name, context = null, position = null\)/,
    "the manager accepts an optional anchor position",
  );
  assert.match(
    manager,
    /window\.api\.openContextMenu\(payload, position\)/,
    "the manager forwards the anchor position to the native bridge",
  );
  assert.match(
    preload,
    /openContextMenu: \(actions, position\) =>\s*ipcRenderer\.invoke\("ContextMenu:show", actions, position\)/,
    "the preload bridge forwards the anchor position over IPC",
  );
});

test("buildSidebarSettingsContextMenu exposes both actions with a normalized shortcut", () => {
  const build = loadGlobal(
    "src/js/contextMenu/SidebarSettings.ContextMenu.js",
    "buildSidebarSettingsContextMenu",
    {
      CONFIG_KEYBINDING_GET_ACTION: (action) =>
        action === "open_settings" ? { key: "Mod+," } : null,
    },
  );
  const calls = [];
  const menu = build({
    openSettings: () => calls.push("ui"),
    openSettingsJson: () => calls.push("json"),
  });
  assert.deepEqual(Object.keys(menu), ["openSettingsUI", "openSettingsJSON"]);
  assert.equal(menu.openSettingsUI.name, "Open Settings UI");
  assert.equal(menu.openSettingsJSON.name, "Open Settings JSON");
  assert.equal(menu.openSettingsUI.keys(), "CommandOrControl+,");
  assert.equal(menu.openSettingsJSON.keys, undefined);
  menu.openSettingsUI.callback();
  menu.openSettingsJSON.callback();
  assert.deepEqual(calls, ["ui", "json"]);
});

test("ContextMenuManager sends the settings menu natively and routes its callbacks", async () => {
  const build = loadGlobal(
    "src/js/contextMenu/SidebarSettings.ContextMenu.js",
    "buildSidebarSettingsContextMenu",
    { CONFIG_KEYBINDING_GET_ACTION: () => ({ key: "Mod+," }) },
  );
  const sent = [];
  let trigger = null;
  const ContextMenuManager = loadGlobal(
    "src/js/manager/ContextMenuManager.js",
    "ContextMenuManager",
    {
      window: {
        api: {
          onContextMenuTriggered(callback) { trigger = callback; },
          async openContextMenu(payload, position) { sent.push({ payload, position }); },
        },
      },
    },
  );
  const calls = [];
  const manager = new ContextMenuManager({});
  manager.setMenu("sidebar-settings", build({
    openSettings: () => calls.push("ui"),
    openSettingsJson: () => calls.push("json"),
  }));
  await manager.openContextMenu("sidebar-settings", null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].position, null, "no anchor means the native cursor default");
  assert.deepEqual(
    JSON.parse(JSON.stringify(sent[0].payload)).map((item) => [item.name, item.enabled, item.keys]),
    [
      ["Open Settings UI", true, "CommandOrControl+,"],
      ["Open Settings JSON", true, null],
    ],
  );
  trigger("Open Settings JSON");
  assert.deepEqual(calls, ["json"]);

  await manager.openContextMenu("sidebar-settings", null, {
    x: 48,
    y: 664,
    verticalAlign: "bottom",
  });
  assert.equal(sent.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(sent[1].position)),
    { x: 48, y: 664, verticalAlign: "bottom" },
    "an explicit bottom anchor is forwarded verbatim to the native bridge",
  );
});

test("ContextMenu.openContext pops at the anchor coordinates, else the cursor", async () => {
  const popups = [];
  const sent = [];
  const handlers = new Map();
  let lastTemplate = null;
  class Menu {
    static buildFromTemplate(template) {
      lastTemplate = template;
      return { popup(options) { popups.push({ options, template }); } };
    }
  }
  const window = {
    webContents: { send: (...args) => sent.push(args) },
    setTitleBarOverlay() {},
  };
  const ipc = { handle: (channel, fn) => handlers.set(channel, fn) };
  const { ContextMenu } = loadMain(
    "dist/ts/addon/ContextMenu.js",
    {
      electron: { Menu, ipcMain: ipc, nativeTheme: {} },
      "../manager/TitleBarTheme": { TITLEBAR_OVERLAY_THEME: { dark: {}, light: {} } },
    },
    { process: { platform: "darwin" } },
  );
  const contextMenu = new ContextMenu(window, ipc);
  contextMenu.handleIPC();

  const actions = [
    { name: "Open Settings UI", keys: "CommandOrControl+,", enabled: true },
    { name: "Open Settings JSON", enabled: true },
  ];
  // darwin metrics: 8px chrome + two 22px rows.
  const menuHeight = 8 + 22 * 2;

  await contextMenu.openContext(actions);
  assert.equal(popups[0].options.window, window);
  assert.equal(popups[0].options.x, undefined, "no anchor keeps the native cursor default");
  assert.equal(popups[0].options.y, undefined);

  await contextMenu.openContext(actions, {
    x: 48.4,
    y: 663.5,
    verticalAlign: "bottom",
  });
  assert.equal(popups[1].options.x, 48, "anchor x is rounded to a window pixel");
  assert.equal(
    popups[1].options.y,
    Math.round(663.5 - menuHeight),
    "a bottom anchor lifts the popup top by the menu height",
  );

  await contextMenu.openContext(actions, { x: 52.4, y: 700.6 });
  assert.equal(popups[2].options.x, 52, "a top anchor rounds x");
  assert.equal(popups[2].options.y, 701, "a top anchor rounds y without lifting");

  await contextMenu.openContext(actions, { x: Number.NaN, y: 10 });
  assert.equal(popups[3].options.x, undefined, "an invalid anchor falls back to the cursor");
  assert.equal(popups[3].options.y, undefined);

  await handlers.get("ContextMenu:show")({}, actions, {
    x: 48,
    y: 664,
    verticalAlign: "bottom",
  });
  assert.equal(popups[4].options.x, 48, "the IPC channel forwards the renderer anchor");
  assert.equal(
    popups[4].options.y,
    664 - menuHeight,
    "the IPC channel honours bottom alignment",
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(lastTemplate)).map((item) => [
      item.label,
      item.accelerator ?? null,
      item.enabled,
    ]),
    [
      ["Open Settings UI", "CommandOrControl+,", true],
      ["Open Settings JSON", null, true],
    ],
  );
  lastTemplate[1].click();
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
    ["ContextMenu:triggered", "Open Settings JSON"],
  ]);
});

test("Editor.openSettingsJson opens the path returned by the API", async () => {
  const Editor = loadEditorClass();
  const calls = [];
  const editor = Object.create(Editor.prototype);
  editor.api = { getSettingsPath: async () => "/tmp/nce/settings.json" };
  editor.tabManager = {
    openFileWithPath(filePath) {
      calls.push(filePath);
      return "settings-file-tab";
    },
  };

  assert.equal(await editor.openSettingsJson(), "settings-file-tab");
  assert.deepEqual(calls, ["/tmp/nce/settings.json"]);
});

test("Editor.openSettingsJson does not open a tab without a settings path", async () => {
  const Editor = loadEditorClass();
  let opened = false;
  const editor = Object.create(Editor.prototype);
  editor.api = { getSettingsPath: async () => "" };
  editor.tabManager = {
    openFileWithPath() {
      opened = true;
    },
  };

  assert.equal(await editor.openSettingsJson(), null);
  assert.equal(opened, false);
});

test("settings path is exposed through a dedicated preload and IPC operation", () => {
  const preload = read("src/js/main/Preload.js");
  const windowSource = read("src/ts/Window.ts");

  assert.match(preload, /getSettingsPath:\s*\(\) => ipcRenderer\.invoke\("Settings:getPath"\)/);
  assert.match(windowSource, /this\.ipc\.handle\("Settings:getPath",[\s\S]*?this\.app\.settings\.settingsPath/);
  assert.doesNotMatch(preload, /require\("(?:fs|path)"\)/);
});

test("settings changes refresh the open settings JSON tab", () => {
  const editor = read("src/js/main/Editor.js");
  const windowSource = read("src/ts/Window.ts");

  assert.match(editor, /refreshSettingsJsonTab/);
  assert.match(editor, /reloadFileFromDisk\(settingsPath\)/);
  assert.match(windowSource, /const settings = this\.app\.settings\.getAll\?\.\(\)/);
  assert.match(windowSource, /broadcastToWindows\("settings-changed", settings\)/);
});
