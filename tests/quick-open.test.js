const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

const NCEPath = {
  equals(left, right) { return String(left).replaceAll("\\", "/") === String(right).replaceAll("\\", "/"); },
};

function createQuickOpen({ rootPath = "/project", entries = [] } = {}) {
  const openCalls = [];
  const panelCalls = [];
  const panel = {
    session: null,
    input: { focusCalls: 0, focus() { this.focusCalls++; } },
    isOpen(id) { return this.session?.id === id; },
    open(options) { this.session = { id: options.id }; panelCalls.push(options); return true; },
  };
  const editor = {
    quickPanel: panel,
    fileExplorer: { rootPath },
    api: { async listProjectFiles() { return { success: true, entries }; } },
    tabManager: { openFileWithPath(filePath) { openCalls.push(filePath); } },
  };
  const QuickOpen = loadGlobal("src/js/quickPanel/QuickOpen.js", "QuickOpen", { NCEPath });
  return { manager: new QuickOpen(editor), editor, panel, panelCalls, openCalls };
}

test("Quick Open stays open without a project and shows an explicit message", () => {
  const { manager, panelCalls } = createQuickOpen({ rootPath: "" });
  assert.equal(manager.open(), true);
  assert.equal(panelCalls.length, 1);
  assert.equal(Array.isArray(panelCalls[0].items), true);
  assert.equal(panelCalls[0].items.length, 0);
  assert.equal(panelCalls[0].emptyMessage(""), "Open a project first.");
});

test("Quick Open filters case-insensitively, ranks filenames, and limits DOM results", async () => {
  const entries = [
    { name: "index-helper.js", path: "/project/src/index-helper.js", relativePath: "src/index-helper.js" },
    { name: "INDEX.js", path: "/project/src/INDEX.js", relativePath: "src/INDEX.js" },
    { name: "other.js", path: "/project/index/other.js", relativePath: "index/other.js" },
  ];
  const { manager, panelCalls } = createQuickOpen({ entries });
  manager.open();
  const items = await panelCalls[0].items();
  assert.equal(JSON.stringify(manager.filter(items, "index").map((item) => item.label)),
    JSON.stringify(["src/INDEX.js", "src/index-helper.js", "index/other.js"]));
  assert.equal(panelCalls[0].renderLimit, 100);
  assert.equal(panelCalls[0].emptyMessage("missing"), "No matching files.");
});

test("Quick Open caches one scan, invalidates on changes, and uses TabManager opening", async () => {
  const entry = { name: "App.js", path: "/project/App.js", relativePath: "App.js" };
  const fixture = createQuickOpen({ entries: [entry] });
  let scans = 0;
  fixture.editor.api.listProjectFiles = async () => { scans++; return { success: true, entries: [entry] }; };
  const first = await fixture.manager.getFiles("/project");
  await fixture.manager.getFiles("/project");
  assert.equal(scans, 1);
  fixture.manager.invalidate("/project");
  await fixture.manager.getFiles("/project");
  assert.equal(scans, 2);
  fixture.manager.open();
  fixture.panelCalls[0].onAccept(first[0]);
  assert.deepEqual(fixture.openCalls, ["/project/App.js"]);
  fixture.manager.open();
  assert.equal(fixture.panelCalls.length, 1);
  assert.equal(fixture.panel.input.focusCalls, 1);
});

test("Quick Open shortcut is registered through the central keybinding registry", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const config = fs.readFileSync(path.join(__dirname, "../src/config/User.js"), "utf8");
  const binding = fs.readFileSync(path.join(__dirname, "../src/js/addon/KeyBinding.js"), "utf8");
  assert.match(config, /action: "quick_open"[\s\S]*?key: "Mod\+P"/);
  assert.match(binding, /quick_open: this\.control_quick_open/);
});
