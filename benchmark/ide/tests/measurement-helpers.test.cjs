const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const {
  resolveWorkspacePath,
  validateFixtureManifest,
  resetWorkspaceStateDirectories,
  waitForFileFullyLoaded,
  logicalDocumentLength,
  validateLogicalSelectAll,
  summarizeFrameIntervals,
  classifyWorkspaceFailure,
  horizontalScrollFixture,
  workspaceRootEntryCount,
  cleanupWorkspaceState,
} = require("../runner/measurement-helpers.cjs");

test("waitForFileFullyLoaded waits for all chunks even if isLoaded only describes the initial file object", async () => {
  let resolveLoad;
  const completion = new Promise((resolve) => { resolveLoad = resolve; });
  const file = {
    path: "/fixtures/large.txt",
    isLoaded: true,
    totalLines: 1000,
    lines: Array.from({ length: 1000 }, () => "line"),
    loadingState: { status: "loading", isFullyLoaded: false, loadedLineCount: 1000, expectedTotalLines: 100000, loadedBytes: 84000 },
    editor: { fileLoader: { waitForFileLoaded: () => completion } },
  };
  const resultPromise = waitForFileFullyLoaded({ file, getActiveFile: () => file, expectedPath: file.path, expectedLines: 100000, expectedBytes: 8400000, timeoutMs: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(file.loadingState.status, "loading");
  file.lines = Array.from({ length: 100000 }, () => "line");
  file.totalLines = 100000;
  file.loadingState.loadedLineCount = 100000;
  file.loadingState.status = "loaded";
  file.loadingState.isFullyLoaded = true;
  resolveLoad();
  assert.deepEqual(await resultPromise, { loadedLines: 100000, expectedLines: 100000, loadingState: "loaded" });
});

test("file-load failures report expected/current counts, bytes, active path and loader state", async () => {
  const file = {
    path: "/fixtures/large.txt", isLoaded: true, totalLines: 2000, lines: [],
    loadingState: { status: "loading", loadedLineCount: 2000, expectedTotalLines: 100000, loadedBytes: 168000 },
    editor: { fileLoader: { waitForFileLoaded: () => new Promise(() => {}) } },
  };
  await assert.rejects(
    waitForFileFullyLoaded({ file, expectedPath: file.path, expectedLines: 100000, expectedBytes: 8400000, timeoutMs: 5 }),
    /FILE_FULL_LOAD_FAILED: FILE_LOAD_TIMEOUT: path=\/fixtures\/large\.txt; expected lines=100000; current lines=2000; expected bytes=8400000; current bytes=168000; chunks=2000\/100000; loading state=loading/,
  );
  await assert.rejects(waitForFileFullyLoaded({ file, expectedPath: "/wrong.txt", timeoutMs: 5 }), /FILE_PATH_MISMATCH/);
});

test("file-load failures include the underlying NCE error code and message", async () => {
  const loadError = Object.assign(new Error("File is too large to be opened"), { code: "FILE_TOO_LARGE" });
  const file = {
    path: "/fixtures/oversized.txt", isLoaded: true, totalLines: 0, lines: [],
    loadingState: { status: "failed", loadedLineCount: 0, expectedTotalLines: 0, error: loadError },
    editor: { fileLoader: { waitForFileLoaded: async () => { throw new Error("File loading failed; save refused"); } } },
  };
  await assert.rejects(
    waitForFileFullyLoaded({ file, expectedPath: file.path, expectedLines: 500000, expectedBytes: 42000000 }),
    /FILE_TOO_LARGE: File is too large to be opened/,
  );
});

test("fixture manifests use portable paths and validate file and workspace contents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nce-fixture-manifest-"));
  try {
    fs.mkdirSync(path.join(root, "files"));
    fs.writeFileSync(path.join(root, "files", "one.txt"), "one\ntwo\n", "utf8");
    fs.mkdirSync(path.join(root, "workspaces", "small", "folder"), { recursive: true });
    fs.writeFileSync(path.join(root, "workspaces", "small", "folder", "item.txt"), "item\n", "utf8");
    fs.mkdirSync(path.join(root, "workspaces", "small", ".nce", "cache"), { recursive: true });
    fs.writeFileSync(path.join(root, "workspaces", "small", ".nce", "workspace.json"), "{}", "utf8");
    const manifest = {
      files: { one: { path: "files/one.txt", bytes: 8, lines: 2, maxLineLength: 3 } },
      workspaces: [{ name: "small", path: "workspaces/small", files: 1, folders: 1, entries: 2, rootEntries: 1 }],
    };
    assert.deepEqual(resolveWorkspacePath(manifest, "small", root), path.join(root, "workspaces", "small"));
    assert.deepEqual(validateFixtureManifest(root, manifest), { files: 1, workspaces: 1 });
    assert.throws(() => resolveWorkspacePath({ workspaces: [{ name: "small", path: "../escape" }] }, "small", root), /outside the fixture root/);
    assert.throws(() => validateFixtureManifest(root, { files: { one: { path: path.join(root, "files", "one.txt"), bytes: 8, lines: 2, maxLineLength: 3 } } }), /portable relative path/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace classification separates invalid path, watcher, and initial folder load failures", () => {
  assert.equal(classifyWorkspaceFailure({ pathStatus: { exists: false } }), "WORKSPACE_PATH_INVALID");
  assert.equal(classifyWorkspaceFailure({ pathStatus: { exists: true, isDirectory: true }, watcherStarted: false }), "WATCHER_START_FAILED");
  assert.equal(classifyWorkspaceFailure({ pathStatus: { exists: true, isDirectory: true }, watcherStarted: true, initialFolderLoadCompleted: false }), "INITIAL_FOLDER_LOAD_FAILED");
  assert.equal(classifyWorkspaceFailure({ pathStatus: { exists: true, isDirectory: true }, watcherStarted: true, initialFolderLoadCompleted: true, initialFolderEntryCount: 1 }), "OTHER");
});

test("workspace explorer counts exclude NCE's internal .nce state while preserving user entries", () => {
  assert.equal(workspaceRootEntryCount([{ name: "group-001" }, { name: "group-002" }, { name: ".nce" }]), 2);
});

test("generated workspace reuse clears only NCE-managed .nce state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nce-workspace-cleanup-"));
  try {
    const workspaceRoot = path.join(root, "workspaces", "small");
    fs.mkdirSync(path.join(workspaceRoot, ".nce", "cache"), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, ".nce", "workspace.json"), "{}", "utf8");
    fs.writeFileSync(path.join(workspaceRoot, "fixture.txt"), "fixture", "utf8");
    const result = resetWorkspaceStateDirectories(root, { workspaces: [{ name: "small", path: "workspaces/small" }] });
    assert.deepEqual(result.workspacesReset, ["small"]);
    assert.equal(fs.existsSync(path.join(workspaceRoot, ".nce")), false);
    assert.equal(fs.existsSync(path.join(workspaceRoot, "fixture.txt")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace cleanup awaits invalidation and watcher shutdown in order", async () => {
  const calls = [];
  const result = await cleanupWorkspaceState({ rootPath: "/workspace", isLoaded: true, invalidateWorkspace: async () => calls.push("invalidate") }, { stopWatching: async () => calls.push("stop") });
  assert.deepEqual(calls, ["invalidate", "stop"]);
  assert.deepEqual(result, { rootPath: "/workspace", isLoaded: true });
});

test("Select All uses logical ranges without materializing text and preserves each final-newline shape", () => {
  const source = `${fs.readFileSync(path.resolve(__dirname, "../../../src/js/controller/SelectController.js"), "utf8")}\nglobalThis.SelectController = SelectController;`;
  const context = { Events: { ON_SELECT: "onSelect" } };
  vm.runInNewContext(source, context);
  const cases = [
    { lines: ["one"], hasFinalNewline: false, expectedText: "one" },
    { lines: ["one"], hasFinalNewline: true, expectedText: "one\n" },
    { lines: ["a", "bc"], hasFinalNewline: false, expectedText: "a\nbc" },
    { lines: ["one", ""], hasFinalNewline: true, expectedText: "one\n\n" },
  ];
  for (const item of cases) {
    const file = {
      lines: item.lines.map((text) => ({ getText: () => text })),
      hasFinalNewline: item.hasFinalNewline,
      _selectedLines: new Map(), _selectionRange: null, _selectionTextCache: null, containsSelected: "",
    };
    const editor = {
      tabManager: { activeFile: file },
      lineController: { lines: file.lines },
      selectOutput: null,
      cursorController: { setCursorPosition() {} },
      events: { callEvent() {} },
    };
    const controller = Object.create(context.SelectController.prototype);
    controller.editor = editor;
    let getSelectedTextCalls = 0;
    const originalGetSelectedText = controller.getSelectedText;
    controller.getSelectedText = function(...args) { getSelectedTextCalls += 1; return originalGetSelectedText.apply(this, args); };
    controller.selectAll(false);
    assert.equal(getSelectedTextCalls, 0, "selectAll must keep selected text lazy");
    const selection = controller.getLogicalSelection();
    const selectedLength = controller.getSelectionLength();
    assert.equal(logicalDocumentLength(item.lines, item.hasFinalNewline), item.expectedText.length);
    assert.equal(selectedLength, item.expectedText.length);
    assert.equal(selection.includesFinalNewline, item.hasFinalNewline);
    assert.equal(controller.getSelectedText(), item.expectedText);
    assert.equal(getSelectedTextCalls, 1, "text materializes only when explicitly requested");
    assert.doesNotThrow(() => validateLogicalSelectAll({ selection, selectedLength, lines: item.lines, hasFinalNewline: item.hasFinalNewline }));
  }
});

test("frame statistics keep undersampled percentiles null and full profile uses a one-million-column line", () => {
  const small = summarizeFrameIntervals([10, 20, 30]);
  assert.equal(small.frameIntervalP50Ms, 20);
  assert.equal(small.frameIntervalP95Ms, null);
  assert.equal(small.frameIntervalP99Ms, null);
  assert.equal(summarizeFrameIntervals(Array.from({ length: 100 }, (_, index) => index + 1)).frameIntervalP99Ms, 99);
  assert.equal(horizontalScrollFixture("quick"), "long-line-100k");
  assert.equal(horizontalScrollFixture("standard"), "long-line-1m");
  assert.equal(horizontalScrollFixture("full"), "long-line-1m");
});
