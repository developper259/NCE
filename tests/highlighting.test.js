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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function enableIncrementalDocument(h, editor, file, lines) {
  file.lines = lines.map((text) => new LineNode(text));
  editor.lineController.lines = file.lines;
  file.incrementalEligible = true;
  file.language = "javascript";
  h.documentModes.set(file.id, "incremental");
  h.documentEpochs.set(file.id, 0);
  const documentId = h.getDocumentId(file);
  return documentId;
}

function applyRemoteUpdate(documents, data) {
  const document = documents.get(data.documentId);
  assert.ok(document, `missing NSH document ${data.documentId}`);
  const lines = document.code.split("\n");
  lines.splice(data.startLine, data.deletedLines, ...data.insertedLines);
  document.code = lines.join("\n");
}

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

test("incremental NSH applies distant batch updates in adjusted document order", async () => {
  const { editor, file, h, calls } = setup();
  file.incrementalEligible = true;
  file.language = "javascript";
  h.documentModes.set(file.id, "incremental");
  h.documentEpochs.set(file.id, 0);
  editor.highlightController = h;
  h.nshClient = {
    async request(type, data) {
      calls.push({ type, ...data });
      return { lines: [] };
    },
  };
  h.handleChange({ nshUpdates: [
    { startLine: 1, deletedLines: 1, insertedLines: ["new-a", "new-b"] },
    { startLine: 4, deletedLines: 2, insertedLines: ["new-c"] },
  ] });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const updates = calls.filter((call) => call.type === "updateDocument");
  assert.deepEqual(updates.map((call) => call.startLine), [1, 5]);
  assert.deepEqual(updates.map((call) => call.deletedLines), [1, 2]);
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

test("pending old range is discarded when a 100-line document shrinks to 20", async () => {
  const { editor, file, h, documents } = setup();
  file.lines = Array.from({ length: 100 }, (_, i) => new LineNode(`old ${i}`));
  editor.lineController.lines = file.lines;
  await h.openFile(file);
  h.lastLoadedRanges.clear();
  const original = h.nshClient.request.bind(h.nshClient);
  let release;
  let requested;
  h.nshClient.request = async (type, data) => {
    if (type === "getDocumentLines" && !requested) {
      requested = data;
      return new Promise((resolve, reject) => { release = () => reject(new Error("line range is outside the document")); });
    }
    if (type === "updateDocument") {
      documents.get(data.documentId).code = data.insertedLines.join("\n");
      return { lines: [] };
    }
    return original(type, data);
  };
  const pending = h.loadVisibleDocumentLines(file);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(requested);
  file.lines = Array.from({ length: 20 }, (_, i) => new LineNode(`new ${i}`));
  editor.lineController.lines = file.lines;
  const sync = h.syncDocumentFromEditor(file, 100);
  release();
  await Promise.all([pending, sync]);
  assert.equal(documents.get(h.getDocumentId(file)).code.split("\n").length, 20);
  assert.equal(file.lines.length, 20);
});

test("new visible range waits for worker update when document grows from 20 to 100", async () => {
  const { editor, file, h, documents } = setup();
  file.lines = Array.from({ length: 20 }, (_, i) => new LineNode(`old ${i}`));
  editor.lineController.lines = file.lines;
  await h.openFile(file);
  let release;
  let rangeCalls = 0;
  const original = h.nshClient.request.bind(h.nshClient);
  h.nshClient.request = async (type, data) => {
    if (type === "updateDocument") {
      await new Promise((resolve) => { release = resolve; });
      documents.get(data.documentId).code = data.insertedLines.join("\n");
      return { lines: [] };
    }
    if (type === "getDocumentLines") rangeCalls++;
    return original(type, data);
  };
  file.lines = Array.from({ length: 100 }, (_, i) => new LineNode(`new ${i}`));
  editor.lineController.lines = file.lines;
  const sync = h.syncDocumentFromEditor(file, 20);
  const visible = h.loadVisibleDocumentLines(file);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rangeCalls, 0);
  release();
  await Promise.all([sync, visible]);
  assert.equal(rangeCalls, 1);
  assert.equal(documents.get(h.getDocumentId(file)).code.split("\n").length, 100);
});

test("late response from an older document revision cannot color the new lines", async () => {
  const { editor, file, h } = setup();
  await h.openFile(file);
  h.lastLoadedRanges.clear();
  let release;
  const original = h.nshClient.request.bind(h.nshClient);
  h.nshClient.request = (type, data) => {
    if (type === "getDocumentLines") return new Promise((resolve) => { release = resolve; });
    if (type === "updateDocument") return Promise.resolve({ lines: [] });
    return original(type, data);
  };
  const old = h.loadVisibleDocumentLines(file);
  await new Promise((resolve) => setImmediate(resolve));
  file.lines = [new LineNode("new revision")];
  editor.lineController.lines = file.lines;
  const sync = h.syncDocumentFromEditor(file, 1);
  release({ lines: [{ text: "new revision", tokens: [{ value: "stale" }] }] });
  await Promise.all([old, sync]);
  assert.equal(file.lines[0].getTokens(), null);
});

test("successive document replacements keep only the newest visible revision", async () => {
  const { editor, file, h, documents } = setup();
  await h.openFile(file);
  const original = h.nshClient.request.bind(h.nshClient);
  h.nshClient.request = async (type, data) => {
    if (type === "updateDocument") {
      documents.get(data.documentId).code = data.insertedLines.join("\n");
      return { lines: [] };
    }
    return original(type, data);
  };
  file.lines = Array.from({ length: 80 }, (_, i) => new LineNode(`middle ${i}`));
  editor.lineController.lines = file.lines;
  const first = h.syncDocumentFromEditor(file, 1);
  file.lines = Array.from({ length: 5 }, (_, i) => new LineNode(`final ${i}`));
  editor.lineController.lines = file.lines;
  const second = h.syncDocumentFromEditor(file, 80);
  await Promise.all([first, second]);
  await h.loadVisibleDocumentLines(file);
  assert.equal(documents.get(h.getDocumentId(file)).code, file.lines.map((line) => line.getText()).join("\n"));
  assert.equal(file.lines[0].getTokens()[0].value, "final 0");
});

test("stale responses do not cancel later mutations in an accepted NSH batch", async () => {
  const { editor, file, h, calls, documents } = setup();
  const originalLines = ["0", "1", "2", "3", "4", "5", "6"];
  const documentId = enableIncrementalDocument(h, editor, file, originalLines);
  documents.set(documentId, { code: originalLines.join("\n"), language: "javascript" });
  const firstStarted = deferred();
  const releaseFirst = deferred();
  let updateCount = 0;
  h.nshClient.request = async (type, data) => {
    calls.push({ type, ...data });
    if (type === "updateDocument") {
      updateCount++;
      if (updateCount === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      applyRemoteUpdate(documents, data);
      return { lines: [] };
    }
    if (type === "closeDocument") documents.delete(data.documentId);
    if (type === "openDocument")
      documents.set(data.documentId, { code: data.code, language: data.language });
    return {};
  };

  file.lines = ["A", "A+", "1", "C", "3", "4", "E", "E+", "6"].map(
    (text) => new LineNode(text),
  );
  editor.lineController.lines = file.lines;
  h.handleChange({ nshUpdates: [
    { startLine: 0, deletedLines: 1, insertedLines: ["A", "A+"] },
    { startLine: 2, deletedLines: 1, insertedLines: ["C"] },
    { startLine: 5, deletedLines: 1, insertedLines: ["E", "E+"] },
  ] });
  await firstStarted.promise;

  file.lines = ["A", "B", "1", "C", "3", "4", "E", "E+", "6"].map(
    (text) => new LineNode(text),
  );
  editor.lineController.lines = file.lines;
  h.handleChange({ nshUpdate: {
    startLine: 1,
    deletedLines: 1,
    insertedLines: ["B"],
  } });
  const allQueuedUpdates = h.documentQueues.get(file.id);
  releaseFirst.resolve();
  await allQueuedUpdates;

  assert.deepEqual(
    calls.filter((call) => call.type === "updateDocument").map((call) => call.startLine),
    [0, 3, 6, 1],
  );
  assert.equal(documents.get(documentId).code, file.lines.map((line) => line.getText()).join("\n"));
});

test("an intermediate NSH mutation failure resynchronizes before queued deltas", async () => {
  const { editor, file, h, calls, documents } = setup();
  const oldId = enableIncrementalDocument(h, editor, file, ["before", "middle", "after"]);
  documents.set(oldId, { code: "before\nmiddle\nafter", language: "javascript" });
  file.lines = ["new first", "new second", "new third"].map(
    (text) => new LineNode(text),
  );
  editor.lineController.lines = file.lines;
  let updates = 0;
  h.nshClient.request = async (type, data) => {
    calls.push({ type, ...data });
    if (type === "updateDocument") {
      updates++;
      throw new Error("worker lost its document");
    }
    if (type === "closeDocument") documents.delete(data.documentId);
    if (type === "openDocument")
      documents.set(data.documentId, { code: data.code, language: data.language });
    return {};
  };

  h.handleChange({ nshUpdates: [
    { startLine: 0, deletedLines: 1, insertedLines: ["new first"] },
    { startLine: 2, deletedLines: 1, insertedLines: ["new third"] },
  ] });
  await h.documentQueues.get(file.id);

  const currentId = h.getDocumentId(file);
  assert.equal(updates, 1);
  assert.notEqual(currentId, oldId);
  assert.equal(documents.get(currentId).code, "new first\nnew second\nnew third");
  assert.equal(h.documentModes.get(file.id), "incremental");
});

test("closing a file during a batch stops its stale tail and ignores its response", async () => {
  const { editor, file, h, calls, documents } = setup();
  const documentId = enableIncrementalDocument(h, editor, file, ["old", "tail"]);
  documents.set(documentId, { code: "old\ntail", language: "javascript" });
  file.lines = [new LineNode("new"), new LineNode("tail")];
  editor.lineController.lines = file.lines;
  const started = deferred();
  const release = deferred();
  let updates = 0;
  h.nshClient.request = async (type, data) => {
    calls.push({ type, ...data });
    if (type === "updateDocument") {
      updates++;
      started.resolve();
      await release.promise;
      applyRemoteUpdate(documents, data);
      return { lines: [{ text: "new", tokens: [{ value: "stale" }] }] };
    }
    if (type === "closeDocument") documents.delete(data.documentId);
    return {};
  };

  h.handleChange({ nshUpdates: [
    { startLine: 0, deletedLines: 1, insertedLines: ["new"] },
    { startLine: 1, deletedLines: 1, insertedLines: ["tail changed"] },
  ] });
  await started.promise;
  const closing = h.closeFile(file);
  release.resolve();
  await closing;

  assert.equal(updates, 1);
  assert.equal(documents.has(documentId), false);
  assert.equal(file.lines[0].getTokens(), null);
});

test("worker restart serializes a fresh open ahead of later document changes", async () => {
  const { editor, file, h, calls, documents } = setup();
  const oldId = enableIncrementalDocument(h, editor, file, ["old", "tail"]);
  documents.set(oldId, { code: "old\ntail", language: "javascript" });
  file.lines = [new LineNode("snapshot"), new LineNode("tail")];
  editor.lineController.lines = file.lines;
  const updateStarted = deferred();
  const releaseUpdate = deferred();
  const reopenStarted = deferred();
  let updateCount = 0;
  h.nshClient.request = async (type, data) => {
    calls.push({ type, ...data });
    if (type === "updateDocument") {
      updateCount++;
      if (updateCount === 1) {
        updateStarted.resolve();
        await releaseUpdate.promise;
        throw new Error("worker restarted");
      }
      applyRemoteUpdate(documents, data);
      return { lines: [] };
    }
    if (type === "openDocument") {
      documents.set(data.documentId, { code: data.code, language: data.language });
      reopenStarted.resolve();
    }
    return {};
  };

  h.handleChange({ nshUpdate: {
    startLine: 0, deletedLines: 1, insertedLines: ["snapshot"],
  } });
  await updateStarted.promise;
  documents.clear();
  h.handleSessionReset();
  file.lines = [new LineNode("snapshot"), new LineNode("final")];
  editor.lineController.lines = file.lines;
  h.handleChange({ nshUpdate: {
    startLine: 1, deletedLines: 1, insertedLines: ["final"],
  } });
  releaseUpdate.resolve();
  await reopenStarted.promise;
  await h.documentQueues.get(file.id);

  const currentId = h.getDocumentId(file);
  assert.notEqual(currentId, oldId);
  assert.equal(updateCount, 2);
  assert.equal(documents.get(currentId).code, "snapshot\nfinal");
  assert.deepEqual(
    calls.filter((call) => call.type === "openDocument").map((call) => call.code),
    ["snapshot\ntail"],
  );
});

test("parallel document queues let one file update while another NSH request waits", async () => {
  const { editor, file, h, documents } = setup();
  const aId = enableIncrementalDocument(h, editor, file, ["a"]);
  documents.set(aId, { code: "a", language: "javascript" });
  const b = new FileNode(editor, 2, "b.js", "/b.js");
  const bId = enableIncrementalDocument(h, editor, b, ["b"]);
  editor.tabManager.files.push(b);
  documents.set(bId, { code: "b", language: "javascript" });
  const aStarted = deferred();
  const releaseA = deferred();
  const bCompleted = deferred();
  h.nshClient.request = async (type, data) => {
    if (type !== "updateDocument") return {};
    if (data.documentId === aId) {
      aStarted.resolve();
      await releaseA.promise;
    } else {
      bCompleted.resolve();
    }
    applyRemoteUpdate(documents, data);
    return { lines: [] };
  };

  file.lines = [new LineNode("A")];
  editor.lineController.lines = file.lines;
  h.handleChange({ nshUpdate: {
    startLine: 0, deletedLines: 1, insertedLines: ["A"],
  } });
  await aStarted.promise;
  editor.tabManager.activeFile = b;
  editor.lineController.lines = b.lines;
  b.lines = [new LineNode("B")];
  editor.lineController.lines = b.lines;
  h.handleChange({ nshUpdate: {
    startLine: 0, deletedLines: 1, insertedLines: ["B"],
  } });
  await bCompleted.promise;
  assert.equal(documents.get(bId).code, "B");
  releaseA.resolve();
  await Promise.all([h.documentQueues.get(file.id), h.documentQueues.get(b.id)]);
  assert.equal(documents.get(aId).code, "A");
});

test("Agent document synchronization sends only changed lines near the end", async () => {
  const { editor, file, h, documents } = setup();
  file.lines = Array.from({ length: 100 }, (_, i) => new LineNode(`line ${i}`));
  editor.lineController.lines = file.lines;
  await h.openFile(file);
  const before = file.lines.map((line) => line.getText()).join("\n");
  const updates = [];
  const original = h.nshClient.request.bind(h.nshClient);
  h.nshClient.request = async (type, data) => {
    if (type === "updateDocument") {
      updates.push(data);
      const document = documents.get(data.documentId);
      const lines = document.code.split("\n");
      lines.splice(data.startLine, data.deletedLines, ...data.insertedLines);
      document.code = lines.join("\n");
      return { lines: [] };
    }
    return original(type, data);
  };
  file.lines[98] = new LineNode("changed near end");
  editor.lineController.lines = file.lines;
  await h.syncDocumentFromEditor(file, before);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].startLine, 98);
  assert.equal(updates[0].deletedLines, 1);
  assert.deepEqual(updates[0].insertedLines, ["changed near end"]);
  assert.equal(documents.get(h.getDocumentId(file)).code.split("\n")[98], "changed near end");
});

test("genuine NSH range failures remain observable", async () => {
  const { file, h } = setup();
  await h.openFile(file);
  h.lastLoadedRanges.clear();
  h.nshClient.request = async () => { throw new Error("NSH unavailable"); };
  await assert.rejects(h.loadVisibleDocumentLines(file), /NSH unavailable/);
});

test("Large File Mode skips NSH per file and leaves normal-file highlighting active", async () => {
  const { editor, file, h, calls } = setup();
  file.largeFileMode = true;
  file.largeFileSize = 84_000_000;
  await h.openFile(file);
  h.refreshForVerticalScroll([0]);
  await h.refresh();
  assert.equal(h.documentModes.get(file.id), "large-file");
  assert.equal(calls.some((call) => [
    "openDocument", "highlightLine", "getDocumentLines",
  ].includes(call.type)), false);

  const small = new FileNode(editor, 2, "small.js", "/small.js");
  small.lines = [new LineNode("const small = 1;")];
  small.language = "javascript";
  small.incrementalEligible = true;
  small.isLoaded = true;
  editor.tabManager.files.push(small);
  editor.tabManager.activeFile = small;
  editor.lineController.lines = small.lines;
  await h.openFile(small);
  assert.ok(calls.some((call) => call.type === "openDocument"));

  editor.tabManager.activeFile = file;
  editor.lineController.lines = file.lines;
  await h.openFile(file);
  assert.equal(calls.filter((call) => [
    "openDocument", "highlightLine", "getDocumentLines",
  ].includes(call.type)).length, 2);
  editor.tabManager.activeFile = small;
  await h.openFile(small);
  assert.equal(calls.some((call) => call.type === "openDocument" && call.language === "javascript"), true);
});
