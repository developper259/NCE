const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

const NCEPath = loadGlobal("src/js/core/Path.js", "NCEPath");
const ManualContextManager = loadGlobal(
  "src/js/agent/context/ManualContextManager.js",
  "ManualContextManager",
  { NCEPath },
);

function setup() {
  const rootPath = "/Users/test/private/NCE";
  const session = { id: "session-a", manualContext: [] };
  const sidebar = {
    sessions: [session],
    renderManualContext() { this.rendered = true; },
    agent: { contextWindow: 32000, estimateTokens(value) { return Math.ceil(JSON.stringify(value).length / 4); } },
  };
  const file = {
    name: "a.js", path: `${rootPath}/src/a.js`, language: "javascript", isLoaded: true,
    serializeContent() { return "unsaved buffer"; },
  };
  const editor = {
    fileExplorer: { rootPath },
    tabManager: { activeFile: file, getFileByPath: (path) => path === file.path ? file : null },
    api: { async getFileContent() { throw new Error("should use open buffer"); } },
  };
  sidebar.editor = editor;
  const manager = new ManualContextManager(sidebar);
  return { manager, sidebar, editor, session, file, rootPath };
}

test("manual file descriptors are per session, deduplicated, and traversal-safe", () => {
  const { manager, session, rootPath } = setup();
  assert.equal(manager.addFile(session, { workspaceRoot: rootPath, relativePath: "src/a.js", name: "a.js" }), true);
  assert.equal(manager.addFile(session, { workspaceRoot: rootPath, relativePath: "src/a.js", name: "a.js" }), false);
  assert.equal(manager.addFile(session, { workspaceRoot: rootPath, relativePath: "../outside", name: "bad" }), false);
  assert.equal(session.manualContext.length, 1);
  assert.equal(session.manualContext[0].absolutePath, `${rootPath}/src/a.js`);
});

test("manual context resolves fresh open buffer content without leaking absolute paths", async () => {
  const { manager, session } = setup();
  manager.addFile(session, { workspaceRoot: manager.workspaceRoot(), relativePath: "src/a.js", name: "a.js", language: "javascript" });
  const payload = await manager.resolveSessionContext(session);
  assert.equal(payload.items[0].content, "unsaved buffer");
  assert.equal(payload.items[0].path, "src/a.js");
  assert.equal(JSON.stringify(payload).includes("/Users/test/private/NCE"), false);
});

test("sending consumes input chips while preserving the captured prompt context", async () => {
  const { manager, session, rootPath } = setup();
  manager.addFile(session, { workspaceRoot: rootPath, relativePath: "src/a.js", name: "a.js" });
  const sentItems = manager.takeItems(session);
  assert.equal(session.manualContext.length, 0);
  const payload = await manager.resolveSessionContext(session, sentItems);
  assert.equal(payload.items[0].content, "unsaved buffer");
});

test("closed files use the existing file API and binary files are marked unavailable", async () => {
  const { manager, session, rootPath, editor } = setup();
  editor.tabManager.getFileByPath = () => null;
  let binary = false;
  editor.api.getProjectMap = async () => ({ success: true, entries: [
    { type: "file", path: "src/a.js", binary },
  ] });
  editor.api.getFileContent = async ([path]) => ({ [path]: "disk content" });
  manager.addFile(session, { workspaceRoot: rootPath, relativePath: "src/a.js", name: "a.js" });
  assert.equal((await manager.resolveSessionContext(session)).items[0].content, "disk content");
  binary = true;
  const unavailable = (await manager.resolveSessionContext(session)).items[0];
  assert.equal(unavailable.unavailable, true);
  assert.equal(unavailable.contentIncluded, false);
});

test("selection contexts snapshot selected content and range", () => {
  const { manager, session, editor } = setup();
  editor.selectController = {
    getSelectedText: () => "const original = true;",
    getLogicalSelection: () => ({ startRow: 4, startColumn: 2, endRow: 4, endColumn: 25 }),
  };
  assert.equal(manager.addSelection(session), true);
  editor.selectController.getSelectedText = () => "changed later";
  assert.equal(session.manualContext[0].content, "const original = true;");
  assert.equal(JSON.stringify(session.manualContext[0].range), JSON.stringify({
    startLine: 4, startColumn: 2, endLine: 4, endColumn: 25,
  }));
});

test("folder contexts include map paths without reading file contents", async () => {
  const { manager, session, editor, rootPath } = setup();
  manager.addFolder(session, "src");
  editor.api.getProjectMap = async (_root, _target, options) => {
    assert.equal(options.maxDepth, 6);
    assert.equal(options.maxFiles, 300);
    return { success: true, truncated: false, entries: [
      { type: "file", relativePath: "a.js", path: "src/a.js" },
      { type: "directory", relativePath: "nested", path: "src/nested" },
    ] };
  };
  const payload = await manager.resolveSessionContext(session);
  assert.equal(JSON.stringify(payload.items[0].entries), JSON.stringify([
    { type: "file", path: "src/a.js" },
    { type: "directory", path: "src/nested" },
  ]));
  assert.equal(JSON.stringify(payload).includes("/Users/test/private/NCE"), false);
  assert.equal(rootPath, manager.workspaceRoot());
});

test("workspace changes remove stale manual items in every conversation", () => {
  const { manager, session, sidebar, rootPath } = setup();
  manager.addFile(session, { workspaceRoot: rootPath, relativePath: "src/a.js", name: "a.js" });
  const other = { id: "session-b", manualContext: [{ workspaceRoot: "/project/old", type: "file" }] };
  sidebar.sessions.push(other);
  manager.handleWorkspaceChanged("/project/new");
  assert.equal(session.manualContext.length, 0);
  assert.equal(other.manualContext.length, 0);
  assert.equal(sidebar.rendered, true);
});

test("large manual attachments are truncated and later items fall back to metadata", async () => {
  const { manager, session, rootPath, editor } = setup();
  const files = ["src/a.js", "src/b.js", "src/c.js"];
  editor.tabManager.getFileByPath = () => null;
  editor.api.getProjectMap = async (_root, parent) => ({ success: true, entries: files
    .filter((path) => path.startsWith(parent.endsWith("src") ? "src/" : ""))
    .map((path) => ({ type: "file", path, binary: false })) });
  editor.api.getFileContent = async ([path]) => ({ [path]: "x".repeat(50000) });
  for (const path of files) manager.addFile(session, {
    workspaceRoot: rootPath, relativePath: path, name: path.split("/").pop(),
  });
  const payload = await manager.resolveSessionContext(session);
  assert.equal(payload.items.some((item) => item.truncated === true), true);
  assert.equal(payload.items.some((item) => item.contentIncluded === false || item.truncated === true), true);
  assert.equal(manager.estimateTokens(payload) <= payload.budgetTokens + 100, true);
});
