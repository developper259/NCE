const test = require("node:test");
const assert = require("node:assert/strict");
const { loadGlobal } = require("./helpers/runtime");
const LineNode = loadGlobal("src/js/types/Line.js", "LineNode");
const FileNode = loadGlobal("src/js/types/Tab.js", "FileNode", { LineNode });
const NCEPath = loadGlobal("src/js/core/Path.js", "NCEPath");
const Writer = loadGlobal(
  "src/js/controller/WriterController.js",
  "WriterController",
  {
    LineNode,
    Events: { ON_CHANGE: "change" },
  },
);
function setup() {
  const calls = [],
    documents = new Map();
  class Client {
    async request(type, data) {
      calls.push({ type, ...data });
      if (type === "detectLanguage")
        return {
          language:
            { js: "javascript", ts: "typescript", cpp: "cpp" }[
              data.fileName.split(".").pop()
            ] || "plaintext",
        };
      if (type === "openDocument")
        documents.set(data.documentId, {
          code: data.code,
          language: data.language,
        });
      if (type === "closeDocument") documents.delete(data.documentId);
      if (type === "getDocumentLines")
        return {
          lines: (documents.get(data.documentId)?.code || "")
            .split("\n")
            .map((text) => ({
              text,
              tokens: [
                { value: text, type: documents.get(data.documentId)?.language || "plaintext" },
              ],
            })),
        };
      return {};
    }
  }
  const Highlight = loadGlobal(
    "src/js/controller/HighlightController.js",
    "HighlightController",
    { NSHClient: Client },
  );
  const editor = {
    lineController: {
      startIndex: 0,
      maxViewLines: 10,
      lines: [],
      refresh() {},
    },
    tabManager: { files: [], refresh() {} },
    fileExplorer: { setActiveFile() {} },
  };
  const h = (editor.highlightController = new Highlight(editor));
  h.reset = () => {};
  const file = new FileNode(editor, 1, "a.js", "/a.js");
  file.lines = [new LineNode("const a = 1;")];
  file.language = "javascript";
  file.incrementalEligible = true;
  file.isLoaded = true;
  editor.tabManager.activeFile = file;
  editor.tabManager.files = [file];
  editor.lineController.lines = file.lines;
  return { editor, file, h, calls, documents };
}
for (const [from, to, expected] of [
  ["txt", "js", "javascript"],
  ["js", "ts", "typescript"],
  ["ts", "txt", "plaintext"],
  ["txt", "cpp", "cpp"],
]) {
  test(`Save As ${from} to ${to} recreates syntax language`, async () => {
    const { editor, file, h, calls, documents } = setup();
    file.name = `a.${from}`;
    file.language = await h.detectLanguage(file.name);
    await h.openFile(file);
    const oldId = h.documentIds.get(file.id);
    editor.fileLoader = { waitForFileLoaded: async () => {} };
    editor.tabManager.selectNewFile = async () => `/a.${to}`;
    editor.api = { saveFile: async () => true };
    assert.equal(await file.saveAs(), true);
    assert.equal(file.language, expected);
    if (oldId) {
      assert.equal(documents.has(oldId), false);
      assert.ok(
        calls.some((c) => c.type === "closeDocument" && c.documentId === oldId),
      );
    }
    if (expected !== "plaintext")
      assert.equal(file.lines[0].getTokens()[0].type, expected);
  });
}

test("external reload invalidates old syntax document and opens the new buffer", async () => {
  const { editor, file, h, calls, documents } = setup();
  await h.openFile(file);
  const oldId = h.getDocumentId(file);
  const Tab = loadGlobal("src/js/manager/TabManager.js", "tabManager", {
    NCEPath,
  });
  Object.setPrototypeOf(editor.tabManager, Tab.prototype);
  editor.tabManager.editor = editor;
  editor.fileLoader = { cancelLoading() {} };
  editor.scrollerManager = { refreshAll() {} };
  editor.lineController.markDirtyAll = () => {};
  file.loadContent = async () => {
    file.lines = [new LineNode('const b = "hello";')];
    file.syntaxMetrics = null;
    editor.lineController.lines = file.lines;
  };
  await editor.tabManager.reloadFileFromDisk(file.path);
  assert.equal(documents.has(oldId), false);
  assert.equal(documents.get(h.getDocumentId(file)).code, 'const b = "hello";');
  assert.equal(file.lines[0].getTokens()[0].value, 'const b = "hello";');
});

test("rename extension recreates NSH document and updates active explorer path", async () => {
  const { editor, file, h, documents } = setup();
  await h.openFile(file);
  const oldId = h.getDocumentId(file);
  const Tab = loadGlobal("src/js/manager/TabManager.js", "tabManager", {
    NCEPath,
  });
  Object.setPrototypeOf(editor.tabManager, Tab.prototype);
  editor.tabManager.editor = editor;
  await editor.tabManager.updateFilePath("/a.js", "/a.ts");
  assert.equal(file.language, "typescript");
  assert.equal(documents.has(oldId), false);
  assert.equal(file.lines[0].getTokens()[0].type, "typescript");
});

test("stale text response is ignored and document updates are ordered", async () => {
  const { file, h } = setup();
  h.applyCachedLines(file, [{ text: "old", tokens: [{ value: "old" }] }]);
  assert.equal(file.lines[0].getTokens(), null);
  const order = [];
  let release;
  const first = h.queueDocumentRequest(file, async () => {
    order.push("A");
    await new Promise((r) => {
      release = r;
    });
  });
  const second = h.queueDocumentRequest(file, async () => order.push("B"));
  const third = h.queueDocumentRequest(file, async () => order.push("C"));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ["A"]);
  release();
  await Promise.all([first, second, third]);
  assert.deepEqual(order, ["A", "B", "C"]);
});

test("reconnect reopens active document, invalidates ranges, leaves inactive documents lazy", async () => {
  const { editor, file, h, calls } = setup();
  await h.openFile(file);
  h.lastLoadedRanges.set(file.id, "0:1");
  const inactive = new FileNode(editor, 2, "b.js", "/b.js");
  editor.tabManager.files.push(inactive);
  h.documentModes.set(2, "incremental");
  h.handleSessionReset();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.documentModes.has(2), false);
  assert.equal(h.lastLoadedRanges.size, 0);
  assert.equal(calls.filter((c) => c.type === "openDocument").length, 2);
});

test("incremental edits queue updateDocument before visible ranges", async () => {
  const { editor, file, h, calls } = setup();
  file.incrementalEligible = true;
  file.language = "javascript";
  h.documentModes.set(file.id, "incremental");
  h.documentEpochs.set(file.id, 0);
  editor.highlightController = h;
  editor.events = {};
  editor.lineController.markDirtyFrom = () => {};
  editor.cursorController = {
    row: 1,
    column: 0,
    setCursorPosition(row, column) {
      this.row = row;
      this.column = column;
    },
  };
  editor.selectController = {
    hasActiveSelection: () => false,
    unSelectAll() {},
    setSelection() {},
  };
  editor.events.callEvent = (name, payload) => {
    if (name === "change") h.handleChange(payload);
  };
  editor.lineController.refresh = () => h.refresh();
  editor.writerController = new Writer(editor);

  editor.writerController.applyRangeEdit(
    { row: 1, column: 0 },
    { row: 1, column: 0 },
    "new\n",
  );
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const updateIndex = calls.findIndex((call) => call.type === "updateDocument");
  const rangeIndex = calls.findIndex(
    (call) => call.type === "getDocumentLines",
  );
  assert.ok(updateIndex >= 0);
  assert.ok(rangeIndex > updateIndex);
});

test("visible range recovery clamps stale viewport and retries once", async () => {
  const { editor, file, h, calls } = setup();
  file.incrementalEligible = true;
  file.language = "javascript";
  h.documentModes.set(file.id, "incremental");
  h.documentEpochs.set(file.id, 0);
  file.lines = Array.from(
    { length: 50 },
    (_, index) => new LineNode(`line ${index}`),
  );
  editor.lineController.lines = file.lines;
  editor.lineController.startIndex = 450;
  let attempts = 0;
  const ranges = [];
  h.nshClient.request = async (type, data) => {
    if (type !== "getDocumentLines") return {};
    attempts++;
    ranges.push({ startLine: data.startLine, endLine: data.endLine });
    if (attempts === 1) throw new Error("line range is outside the document");
    return { lines: [] };
  };

  await h.loadVisibleDocumentLines(file);

  assert.equal(editor.lineController.startIndex, 49);
  assert.equal(attempts, 2);
  assert.deepEqual(ranges, [
    { startLine: 49, endLine: 50 },
    { startLine: 49, endLine: 50 },
  ]);
});
