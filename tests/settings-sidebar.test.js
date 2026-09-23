const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

const root = path.resolve(__dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

const loadEditorClass = () =>
  loadGlobal("src/js/main/Editor.js", "Editor", {
    document: { addEventListener() {} },
    window: {},
  });

test("sidebar Settings uses an accessible two-action menu", () => {
  const sidebar = read("src/js/manager/SidebarManager.js");
  const css = read("src/css/sidebar.css");

  assert.match(sidebar, /sidebar-settings-container/);
  assert.match(sidebar, /Open Settings UI/);
  assert.match(sidebar, /Open Settings JSON/);
  assert.match(sidebar, /aria-haspopup/, "Settings exposes menu semantics");
  assert.match(sidebar, /aria-expanded/);
  assert.match(
    sidebar,
    /closest\("\.sidebar-tab-icon\[data-menu-id\]"\)/,
    "Settings must not enter the regular sidebar menu delegation",
  );
  assert.match(css, /\.sidebar-settings-menu[\s\S]*?left:\s*100%/);
  assert.match(css, /\.sidebar-settings-menu[\s\S]*?bottom:\s*0/);
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
  assert.match(windowSource, /ipcMain\.handle\("Settings:getPath",[\s\S]*?this\.app\.settings\.settingsPath/);
  assert.doesNotMatch(preload, /require\("(?:fs|path)"\)/);
});

test("settings changes refresh the open settings JSON tab", () => {
  const editor = read("src/js/main/Editor.js");
  const windowSource = read("src/ts/Window.ts");

  assert.match(editor, /refreshSettingsJsonTab/);
  assert.match(editor, /reloadFileFromDisk\(settingsPath\)/);
  assert.match(windowSource, /settings-changed.*this\.app\.settings\.getAll\(\)/s);
});
