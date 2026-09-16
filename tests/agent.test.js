const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createAgent } = require("./helpers/agent-runtime");
const { FileManager } = require("../dist/ts/addon/FileManager");
const { WorkspaceSearch } = require("../dist/ts/addon/WorkspaceSearch");
async function setup(fetchMock) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-agent-"));
  const manager = new FileManager({});
  const search = new WorkspaceSearch({});
  const files = new Map();
  const originalWriteFile = fs.writeFile.bind(fs);
  fs.writeFile = async (file, data, options) => {
    const result = await originalWriteFile(file, data, options);
    const absolute = path.resolve(file);
    const target = files.get(absolute);
    if (target && typeof data === "string") {
      target.lines = data
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((text) => ({
          text,
          getText() {
            return this.text;
          },
          diffState: null,
          diffSegments: [],
        }));
      target.totalLines = data.split(/\r?\n/).length;
      target.maxLineLength = 0;
      target.isSaved = true;
    }
    return result;
  };
  const editor = {
    autoSaveEnabled: false,
    getAutoSaveState() {
      return this.autoSaveEnabled === true;
    },
    fileExplorer: { rootPath: root },
    tabManager: {
      activeFile: null,
      files,
      getFileByPath(filePath) {
        return files.get(path.resolve(filePath)) || null;
      },
      async openFileWithPath(candidate) {
        const filePath = path.resolve(candidate);
        if (!files.has(filePath)) {
          const content = await fs.readFile(filePath, "utf8");
          const file = {
            id: 1,
            name: path.basename(filePath),
            path: filePath,
            lines: content
              .replace(/\r\n?/g, "\n")
              .split("\n")
              .map((text) => ({
                text,
                getText() {
                  return this.text;
                },
                diffState: null,
                diffSegments: [],
              })),
            totalLines: content.split(/\r?\n/).length,
            maxLineLength: 0,
            isSaved: true,
            autoSave: false,
            diffSnapshot: null,
            diffActive: false,
            diffRows: [],
            setIsSaved(value) {
              this.isSaved = value;
            },
          };
          files.set(filePath, file);
        }
        const file = files.get(filePath);
        this.activeFile = file;
        return file;
      },
      async setFocusFile(file) {
        this.activeFile = file;
      },
    },
    fileLoader: { async waitForFileLoaded() {} },
    lineController: {
      loadContent() {},
      refresh() {},
      markDirtyAll() {},
    },
    api: {
      agentFileOperation: manager.agentFileOperation.bind(manager),
      pathExists: async (p) => {
        try {
          await fs.stat(p);
          return true;
        } catch {
          return false;
        }
      },
      pathStatus: async (p) => {
        try {
          const stat = await fs.stat(p);
          return {
            exists: true,
            isDirectory: stat.isDirectory(),
            readable: true,
          };
        } catch (error) {
          return { exists: false, code: error.code };
        }
      },
      getFileContent: manager.getFileContent.bind(manager),
      getProjectMap: search.getProjectMap.bind(search),
      searchInFiles: search.search.bind(search),
      getFolderContent: manager.getFolderContent.bind(manager),
    },
  };
  return { root, editor, agent: createAgent(editor, fetchMock), manager };
}

async function setupEditable(content, { open = true, saved = true } = {}) {
  const fixture = await setup();
  const filePath = path.join(fixture.root, "editable.txt");
  await fs.writeFile(filePath, content);
  const makeLine = (text) => ({
    text,
    getText() {
      return this.text;
    },
    diffState: null,
    diffSegments: [],
  });
  const makeFile = (text, targetPath = filePath) => ({
    id: 17,
    name: "editable.txt",
    path: targetPath,
    lines: text.replace(/\r\n?/g, "\n").split("\n").map(makeLine),
    totalLines: text.split(/\r?\n/).length,
    maxLineLength: 0,
    isSaved: saved,
    editVersion: 0,
    saveQueue: Promise.resolve(true),
    enqueueSaveSnapshot(content, version, saveFile) {
      this.saveQueue = this.saveQueue.catch(() => false).then(async () => {
        if (version !== this.editVersion) return { saved: false, stale: true };
        const result = await saveFile(this.path, content);
        if (!result) {
          return { saved: false, error: Object.assign(new Error("Save failed"), { code: "SAVE_FAILED" }) };
        }
        if (version !== this.editVersion) {
          return { saved: false, stale: true, persisted: true };
        }
        this.setIsSaved(true);
        return { saved: true, result };
      });
      return this.saveQueue;
    },
    autoSave: false,
    diffSnapshot: null,
    diffActive: false,
    diffRows: [],
    setIsSaved(value) {
      this.isSaved = value;
    },
  });
  let currentFile = open ? makeFile(content) : null;
  fixture.editor.tabManager = {
    activeFile: currentFile,
    getFileByPath: (candidate) =>
      fixture.agent.samePath(candidate, currentFile?.path) ? currentFile : null,
    async openFileWithPath(candidate) {
      currentFile = makeFile(await fs.readFile(candidate, "utf8"), candidate);
      this.activeFile = currentFile;
      return currentFile;
    },
    async setFocusFile(file) {
      this.activeFile = file;
    },
  };
  fixture.editor.fileLoader = { async waitForFileLoaded() {} };
  fixture.editor.lineController = {
    loadContent() {},
    refresh() {},
    markDirtyAll() {},
  };
  fixture.getFile = () => currentFile;
  return fixture;
}

const CODE_TOOLS = [
  "create_file",
  "create_folder",
  "delete_file",
  "delete_folder",
  "get_changed_files",
  "get_diff",
  "get_project_map",
  "modify_file",
  "read_file",
  "rename_file",
  "search_code",
  "task_complete",
  "write_file_chunk",
];

const READ_TOOLS = ["get_project_map", "read_file", "search_code"];

test("delete_folder removes the directory and cleans only descendant tabs and read contexts", async () => {
  const { root, agent, editor } = await setup();
  try {
    agent.runChangeTracker.beginRun(1, root);
    const target = path.join(root, "tmp");
    const nested = path.join(target, "sub");
    const neighbor = path.join(root, "tmp2");
    await fs.mkdir(nested, { recursive: true });
    await fs.mkdir(neighbor);
    const inside = path.join(target, "a.js");
    const deep = path.join(nested, "b.js");
    const outside = path.join(neighbor, "c.js");
    for (const file of [inside, deep, outside]) await fs.writeFile(file, "content");
    const openFiles = [inside, deep, outside].map((file, id) => ({ id, path: file, isSaved: true }));
    const closed = [];
    const marked = [];
    editor.tabManager.files = openFiles;
    editor.tabManager.closeFile = async (id) => {
      closed.push(id);
      return id !== 1;
    };
    editor.tabManager.markFileAsDeleted = (file) => marked.push(file);
    for (const file of [inside, deep, outside]) agent.readFileContexts.set(file, {});
    let refreshed = null;
    editor.fileExplorer.refreshFolder = async (folder) => { refreshed = folder; };

    const result = await agent.executeToolCall({
      id: "delete-folder-regression",
      function: { name: "delete_folder", arguments: JSON.stringify({ path: "tmp" }) },
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.result.success, true);
    assert.equal(result.result.mutationOutcome, "APPLIED_AND_VERIFIED");
    assert.equal(await editor.api.pathExists(target), false);
    assert.deepEqual(closed, [0, 1]);
    assert.deepEqual(marked, [deep]);
    assert.equal(agent.readFileContexts.has(inside), false);
    assert.equal(agent.readFileContexts.has(deep), false);
    assert.equal(agent.readFileContexts.has(outside), true);
    assert.equal(await editor.api.pathExists(outside), true);
    assert.equal(agent.samePath(refreshed, root), true);
    assert.equal(agent.runChangeTracker.current.unresolvedFailures.size, 0);

    const rootDelete = await agent.deleteWorkspaceFolder({ path: root });
    assert.equal(rootDelete.success, false);
    assert.equal(rootDelete.mutationOutcome, "NOT_APPLIED");
    assert.equal(await editor.api.pathExists(root), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("delete_folder reconciles a filesystem error after deletion and reports cleanup warnings", async () => {
  const { root, agent, editor } = await setup();
  try {
    const target = path.join(root, "tmp");
    await fs.mkdir(target);
    const actualDelete = agent.api.deleteEntry;
    agent.api.deleteEntry = async (...args) => {
      await actualDelete(...args);
      throw new Error("response lost after deletion");
    };
    editor.fileExplorer.refreshFolder = async () => { throw new Error("refresh failed"); };
    const result = await agent.deleteWorkspaceFolder({ path: "tmp" });
    assert.equal(result.success, true);
    assert.equal(result.mutationOutcome, "APPLIED_AND_VERIFIED");
    assert.equal(await editor.api.pathExists(target), false);
    assert.deepEqual(Array.from(result.uiWarnings), [
      "filesystem_delete_reported_error_but_absence_verified",
      "explorer_refresh_failed",
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("create_folder, create_file, delete_folder leaves no unresolved tool failure", async () => {
  const { root, agent, editor } = await setup();
  try {
    agent.runChangeTracker.beginRun(1, root);
    const call = (id, name, args) => agent.executeToolCall({
      id,
      function: { name, arguments: JSON.stringify(args) },
    });
    assert.equal((await call("folder-create", "create_folder", { path: "tmp" })).success, true);
    assert.equal((await call("file-create", "create_file", { path: "tmp/test.js", content: "ok" })).success, true);
    const deleted = await call("folder-delete", "delete_folder", { path: "tmp" });
    assert.equal(deleted.success, true, JSON.stringify(deleted));
    assert.equal(deleted.result.mutationOutcome, "APPLIED_AND_VERIFIED");
    assert.equal(await editor.api.pathExists(path.join(root, "tmp")), false);
    assert.equal(agent.runChangeTracker.current.unresolvedFailures.size, 0);
    assert.equal(agent.runChangeTracker.current.changes.size, 0);
    const complete = await call("folder-complete", "task_complete", {
      summary: "Temporary folder removed.", validation: "Deletion verified.",
    });
    assert.equal(complete.success, true, JSON.stringify(complete));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Agent exposes the minimal public tool surface for read and code modes", async () => {
  const { root, agent } = await setup();
  try {
    assert.deepEqual([...agent.getAvailableToolNames()].sort(), CODE_TOOLS);
    assert.equal(agent.tools.size, CODE_TOOLS.length);
    for (const removed of [
      "get_editor_context",
      "get_cursor",
      "read_selection",
      "read_active_file",
      "search_active_file",
      "list_project_files",
      "search_project_files",
      "modify_active_file",
      "replace_text",
    ]) {
      assert.equal(agent.getTool(removed), undefined, removed);
    }

    agent.setConfig({ permissions: "read" });
    assert.deepEqual([...agent.getAvailableToolNames()].sort(), READ_TOOLS);
    assert.equal(agent.getTool("modify_file").readOnly, false);
    assert.equal(agent.getTool("delete_file").readOnly, false);
    assert.equal(agent.getTool("task_complete").codeOnly, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("delete_file removes only safe workspace files and refreshes project caches", async () => {
  const { root, agent, editor } = await setup();
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), "nce-delete-outside-"),
  );
  try {
    await fs.writeFile(path.join(root, "keep.txt"), "keep");
    await fs.writeFile(path.join(root, "delete.txt"), "delete");
    await fs.mkdir(path.join(root, "directory"));
    await fs.writeFile(path.join(outside, "outside.txt"), "outside");
    let invalidatedRoot = null;
    let refreshedFolder = null;
    editor.quickOpen = {
      invalidate: (value) => {
        invalidatedRoot = value;
      },
    };
    editor.fileExplorer.refreshFolder = async (value) => {
      refreshedFolder = value;
    };

    const firstMap = await agent.getProjectMap({});
    assert.match(firstMap.text, /delete\.txt/);
    const result = await agent.executeToolCall({
      id: "delete-safe-file",
      function: {
        name: "delete_file",
        arguments: JSON.stringify({ path: "delete.txt" }),
      },
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.result.path, "delete.txt");
    assert.equal(result.result.beforeContent, "delete");
    assert.equal(
      result.result.beforeRevision,
      agent.getContentRevision("delete"),
    );
    assert.deepEqual(JSON.parse(JSON.stringify(result.result.verification)), {
      verified: true,
      kind: "absence",
      exists: false,
    });
    assert.equal(result.result.mutationOutcome, "APPLIED_AND_VERIFIED");
    assert.equal(
      await editor.api.pathExists(path.join(root, "delete.txt")),
      false,
    );
    assert.equal(
      await fs.readFile(path.join(root, "keep.txt"), "utf8"),
      "keep",
    );
    assert.doesNotMatch((await agent.getProjectMap({})).text, /delete\.txt/);
    assert.equal(
      (await agent.getTool("search_code").execute({ query: "delete" }))
        .totalMatches,
      0,
    );
    assert.equal(agent.samePath(invalidatedRoot, root), true);
    assert.equal(agent.samePath(refreshedFolder, root), true);

    assert.equal(
      (await agent.deleteWorkspaceFile({ path: "missing.txt" })).error.code,
      "FILE_NOT_FOUND",
    );
    assert.equal(
      (await agent.deleteWorkspaceFile({ path: "directory" })).error.code,
      "NOT_A_FILE",
    );
    for (const unsafe of [
      "../outside.txt",
      "../../etc/passwd",
      path.join(outside, "outside.txt"),
    ]) {
      assert.equal(
        (await agent.deleteWorkspaceFile({ path: unsafe })).success,
        false,
        unsafe,
      );
    }
    assert.equal(
      await fs.readFile(path.join(outside, "outside.txt"), "utf8"),
      "outside",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("delete_file rejects escaped symlinks and dirty tabs, then closes a clean open tab", async () => {
  const { root, agent, editor } = await setup();
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), "nce-delete-symlink-"),
  );
  try {
    const outsideFile = path.join(outside, "outside.txt");
    await fs.writeFile(outsideFile, "outside");
    await fs.symlink(
      outsideFile,
      path.join(root, "escape.txt"),
      process.platform === "win32" ? "file" : undefined,
    );
    const escaped = await agent.deleteWorkspaceFile({ path: "escape.txt" });
    assert.equal(escaped.success, false);
    assert.equal(escaped.error.code, "OUTSIDE_WORKSPACE");
    assert.equal(await fs.readFile(outsideFile, "utf8"), "outside");

    const openPath = path.join(root, "open.txt");
    await fs.writeFile(openPath, "disk");
    const openFile = { id: 7, path: openPath, isSaved: false };
    editor.tabManager.activeFile = openFile;
    editor.tabManager.getFileByPath = (candidate) =>
      agent.samePath(candidate, openPath) ? openFile : null;
    let closeCalls = 0;
    editor.tabManager.closeFile = async (id) => {
      closeCalls++;
      assert.equal(id, openFile.id);
      editor.tabManager.activeFile = null;
      editor.tabManager.getFileByPath = () => null;
      return true;
    };
    const dirty = await agent.deleteWorkspaceFile({ path: "open.txt" });
    assert.equal(dirty.error.code, "DIRTY_FILE");
    assert.equal(await fs.readFile(openPath, "utf8"), "disk");
    assert.equal(closeCalls, 0);

    openFile.isSaved = true;
    editor.tabManager.getFileByPath = (candidate) =>
      agent.samePath(candidate, openPath) ? openFile : null;
    const clean = await agent.deleteWorkspaceFile({ path: "open.txt" });
    assert.equal(clean.success, true, JSON.stringify(clean));
    assert.equal(closeCalls, 1);
    assert.equal(editor.tabManager.activeFile, null);
    assert.equal(await editor.api.pathExists(openPath), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("RunChangeTracker invalidates stale review gates when the change journal moves", async () => {
  const { root, agent, editor } = await setup();
  try {
    agent.runChangeTracker.beginRun(1, root);
    const first = {
      success: true,
      path: "alpha.txt",
      beforeText: "old",
      afterText: "new",
      previousRevision: "r0",
      revision: "r1",
    };
    agent.runChangeTracker.recordModify(first);
    agent.runChangeTracker.markReviewChangedFiles();
    agent.runChangeTracker.markReviewDiff();

    const second = {
      success: true,
      path: "alpha.txt",
      beforeText: "new",
      afterText: "newer",
      previousRevision: "r1",
      revision: "r2",
    };
    agent.runChangeTracker.recordModify(second);

    const validation = agent.validateTaskComplete({});
    assert.equal(validation.success, false);
    assert.equal(validation.error.code, "CHANGES_NOT_REVIEWED");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Agent supports a real end-to-end workflow chain from inspection to review and completion", async () => {
  const { root, agent } = await setup();
  try {
    await fs.writeFile(path.join(root, "alpha.txt"), "alpha\n", "utf8");
    await fs.writeFile(path.join(root, "beta.txt"), "beta\n", "utf8");

    agent.runChangeTracker.beginRun(1, root);

    const projectMap = await agent.executeToolCall({
      id: "scenario-project-map",
      function: {
        name: "get_project_map",
        arguments: JSON.stringify({ path: "" }),
      },
    });
    assert.equal(projectMap.success, true);

    const search = await agent.executeToolCall({
      id: "scenario-search",
      function: {
        name: "search_code",
        arguments: JSON.stringify({ query: "alpha", offset: 0, limit: 10 }),
      },
    });
    assert.equal(search.success, true);

    const read = await agent.executeToolCall({
      id: "scenario-read",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "alpha.txt",
          startLine: 1,
          endLine: 50,
        }),
      },
    });
    assert.equal(read.success, true);
    assert.equal(read.result.path, "alpha.txt");

    const firstModify = await agent.executeToolCall({
      id: "scenario-modify-1",
      function: {
        name: "modify_file",
        arguments: JSON.stringify({
          path: "alpha.txt",
          oldText: "alpha",
          newText: "beta",
          revision: read.result.revision,
        }),
      },
    });
    assert.equal(firstModify.success, true);

    const secondModify = await agent.executeToolCall({
      id: "scenario-modify-2",
      function: {
        name: "modify_file",
        arguments: JSON.stringify({
          path: "alpha.txt",
          oldText: "beta",
          newText: "gamma",
          revision: firstModify.result.revision,
        }),
      },
    });
    assert.equal(secondModify.success, true);

    const changedFiles = await agent.executeToolCall({
      id: "scenario-changed-files",
      function: {
        name: "get_changed_files",
        arguments: JSON.stringify({}),
      },
    });
    assert.equal(changedFiles.success, true);
    assert.equal(changedFiles.result.files.length >= 1, true);

    const diff = await agent.executeToolCall({
      id: "scenario-diff",
      function: {
        name: "get_diff",
        arguments: JSON.stringify({ path: "alpha.txt" }),
      },
    });
    assert.equal(diff.success, true);
    assert.match(diff.result.diff, /--- a\/alpha.txt/);

    const complete = await agent.executeToolCall({
      id: "scenario-complete",
      function: {
        name: "task_complete",
        arguments: JSON.stringify({
          summary: "Scenario completed.",
          validation: "Read, search, edit, diff and review confirmed.",
        }),
      },
    });
    assert.equal(complete.success, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("get_diff reports currentFileChangedSinceAgentEdit when the user mutates the file after the agent write", async () => {
  const { root, agent } = await setup();
  try {
    await fs.writeFile(path.join(root, "alpha.txt"), "alpha\n", "utf8");
    agent.runChangeTracker.beginRun(1, root);

    const read = await agent.executeToolCall({
      id: "edit-detect-read",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "alpha.txt",
          startLine: 1,
          endLine: 50,
        }),
      },
    });
    assert.equal(read.success, true);

    const firstModify = await agent.executeToolCall({
      id: "edit-detect-modify",
      function: {
        name: "modify_file",
        arguments: JSON.stringify({
          path: "alpha.txt",
          oldText: "alpha",
          newText: "beta",
          revision: read.result.revision,
        }),
      },
    });
    assert.equal(firstModify.success, true);

    await fs.writeFile(path.join(root, "alpha.txt"), "gamma\n", "utf8");

    const diff = await agent.executeToolCall({
      id: "edit-detect-diff",
      function: {
        name: "get_diff",
        arguments: JSON.stringify({ path: "alpha.txt" }),
      },
    });
    assert.equal(diff.success, true);
    assert.equal(diff.result.currentFileChangedSinceAgentEdit, true);
    assert.match(diff.result.diff, /--- a\/alpha.txt/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Agent rejects stale revisions and blocks task completion when runs are aborted or workspaces drift", async () => {
  const { root, agent } = await setup();
  try {
    await fs.writeFile(path.join(root, "alpha.txt"), "alpha\n", "utf8");
    agent.runChangeTracker.beginRun(1, root);

    const read = await agent.executeToolCall({
      id: "stale-read",
      function: {
        name: "read_file",
        arguments: JSON.stringify({
          path: "alpha.txt",
          startLine: 1,
          endLine: 50,
        }),
      },
    });
    assert.equal(read.success, true);

    const firstModify = await agent.executeToolCall({
      id: "stale-modify",
      function: {
        name: "modify_file",
        arguments: JSON.stringify({
          path: "alpha.txt",
          oldText: "alpha",
          newText: "beta",
          revision: read.result.revision,
        }),
      },
    });
    assert.equal(firstModify.success, true);

    const stale = await agent.executeToolCall({
      id: "stale-revision-attempt",
      function: {
        name: "modify_file",
        arguments: JSON.stringify({
          path: "alpha.txt",
          oldText: "beta",
          newText: "gamma",
          revision: "wrong-revision",
        }),
      },
    });
    assert.equal(stale.success, false);
    assert.equal(stale.error.code, "STALE_REVISION");

    agent.runChangeTracker.setRunStatus("aborted");
    const aborted = agent.validateTaskComplete({});
    assert.equal(aborted.success, false);
    assert.equal(aborted.error.code, "RUN_ABORTED");

    const driftedRoot = path.join(root, "drift");
    agent.runChangeTracker.beginRun(2, driftedRoot);
    agent.runChangeTracker.current.status = "running";
    const amidDrift = agent.validateTaskComplete({});
    assert.equal(amidDrift.success, false);
    assert.equal(amidDrift.error.code, "WORKSPACE_CHANGED");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Agent run journal preserves create then rename semantics without breaking diff review", async () => {
  const { root, agent } = await setup();
  try {
    await fs.writeFile(path.join(root, "alpha.txt"), "alpha\n", "utf8");
    agent.runChangeTracker.beginRun(1, root);

    agent.runChangeTracker.recordCreate({
      success: true,
      path: "alpha.txt",
      content: "alpha\n",
      revision: "r-create",
      verification: { revision: "r-create", content: "alpha\n" },
    });

    agent.runChangeTracker.recordRename({
      success: true,
      oldPath: "alpha.txt",
      newPath: "renamed.txt",
      verification: { revision: "r-rename" },
    });

    const journal = agent.runChangeTracker.getChangedFiles({});
    assert.equal(journal.success, true);
    assert.equal(journal.files.length, 1);
    // A file created and renamed within one run is still a net creation.
    assert.equal(journal.files[0].status, "created");
    assert.equal(journal.files[0].path, "renamed.txt");

    const diff = agent.runChangeTracker.getDiff({ path: "renamed.txt" });
    assert.equal(diff.success, true);
    assert.match(diff.diff, /renamed.txt/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("AgentPath.samePath normalizes slash/backslash without changing POSIX case semantics", async () => {
  const { agent } = await setup();
  assert.equal(agent.samePath("C:\\Temp\\foo.txt", "C:/Temp/foo.txt"), true);
  assert.equal(agent.samePath("/tmp/Foo", "/tmp/foo"), false);
});

test("ResponseBudgetEstimator provides a bounded local estimate without extra AI calls", async () => {
  const { root, agent } = await setup();
  try {
    const budget = agent.responseBudgetEstimator.estimateResponseBudget({
      agent,
      model: {
        contextWindow: 128000,
        maxOutputTokens: 16384,
      },
      runtimeState: {
        kind: "normal-edit",
        lastTool: "modify_file",
        largeWriteActive: false,
      },
      previousUsage: [],
      modelHint: null,
    });
    assert.equal(budget.success, true);
    assert.equal(typeof budget.estimatedResponseTokens, "number");
    assert.equal(typeof budget.reservedForResponseTokens, "number");
    assert.equal(typeof budget.effectiveMaxOutputTokens, "number");
    assert.equal(
      budget.reservedForResponseTokens >= budget.estimatedResponseTokens,
      true,
    );
    assert.equal(
      budget.reservedForResponseTokens <= budget.effectiveMaxOutputTokens,
      true,
    );
    assert.equal(agent.getTool("read_file").readOnly, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Agent public project, search, read and completion tools remain functional", async () => {
  const { root, agent } = await setup();
  try {
    await fs.writeFile(path.join(root, "sample.js"), "const needle = true;\n");
    const map = await agent.getTool("get_project_map").execute({});
    assert.equal(map.success, true);
    assert.match(map.text, /sample\.js/);

    const search = await agent
      .getTool("search_code")
      .execute({ query: "needle" });
    assert.equal(search.totalMatches, 1);
    const read = await agent
      .getTool("read_file")
      .execute({ path: "sample.js" });
    assert.equal(read.success, true);
    assert.match(read.content, /needle/);

    const completion = await agent
      .getTool("task_complete")
      .execute({ summary: "done" });
    assert.equal(completion.taskCompleteRequested, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("modify_file uses explicit revisions for immediate and repeated edits", async () => {
  const fixture = await setupEditable("alpha beta gamma");
  const { root, agent } = fixture;
  try {
    const read = await agent.readFile("editable.txt");
    const first = await agent.modifyFile({
      path: "editable.txt",
      revision: read.revision,
      oldText: "alpha",
      newText: "one",
    });
    assert.equal(first.success, true, JSON.stringify(first));
    assert.equal(first.previousRevision, read.revision);
    const second = await agent.modifyFile({
      path: "editable.txt",
      revision: first.revision,
      oldText: "beta",
      newText: "two",
    });
    const third = await agent.modifyFile({
      path: "editable.txt",
      revision: second.revision,
      oldText: "gamma",
      newText: "three",
    });
    assert.equal(third.success, true, JSON.stringify(third));
    assert.equal(
      fixture
        .getFile()
        .lines.map((line) => line.getText())
        .join("\n"),
      "one two three",
    );
    const expectedPath = path.join(root, "editable.txt");
    const contextEntry = [...agent.readFileContexts.entries()].find(
      ([candidate]) => agent.samePath(candidate, expectedPath),
    )?.[1];
    assert.ok(contextEntry);
    assert.equal(contextEntry.revision, third.revision);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("modify_file autosave accepts equivalent path separators and rejects failed or different save paths", async () => {
  for (const outcome of ["equivalent", "different", "failed"]) {
    const fixture = await setupEditable("alpha beta");
    const { root, agent } = fixture;
    try {
      fixture.editor.autoSaveEnabled = true;
      let saveCalls = 0;
      agent.api.saveFile = async (candidate, content) => {
        saveCalls++;
        assert.equal(
          agent.samePath(candidate, path.join(root, "editable.txt")),
          true,
        );
        assert.equal(content, "one beta");
        if (outcome === "failed") return undefined;
        if (outcome === "different") return path.join(root, "different.txt");
        await fs.writeFile(candidate, content);
        return candidate.replace(/\//g, "\\");
      };
      const read = await agent.readFile("editable.txt");
      const result = await agent.modifyFile({
        path: "editable.txt",
        revision: read.revision,
        oldText: "alpha",
        newText: "one",
      });
      assert.equal(saveCalls, 1);
      if (outcome === "equivalent") {
        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(result.previousRevision, read.revision);
        assert.equal(
          await fs.readFile(path.join(root, "editable.txt"), "utf8"),
          "one beta",
        );
      } else {
        assert.equal(result.success, true);
        assert.equal(result.mutationOutcome, "APPLIED_BUT_UNCERTAIN");
        assert.equal(result.persistence.saved, false);
        assert.equal(result.persistence.error.code, "SAVE_FAILED");
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test("modify_file rejects stale revisions and recovers after reading the changed buffer", async () => {
  const fixture = await setupEditable("before");
  const { root, agent } = fixture;
  try {
    const read = await agent.readFile("editable.txt");
    fixture.getFile().lines = [
      { getText: () => "user change", diffState: null, diffSegments: [] },
    ];
    fixture.getFile().isSaved = false;
    const stale = await agent.modifyFile({
      path: "editable.txt",
      revision: read.revision,
      oldText: "before",
      newText: "agent change",
    });
    assert.equal(stale.error.code, "STALE_REVISION");
    assert.equal(fixture.getFile().lines[0].getText(), "user change");

    const reread = await agent.readFile("editable.txt");
    const recovered = await agent.modifyFile({
      path: "editable.txt",
      revision: reread.revision,
      oldText: "user change",
      newText: "user + agent",
    });
    assert.equal(recovered.success, true, JSON.stringify(recovered));
    assert.equal(fixture.getFile().lines[0].getText(), "user + agent");
    assert.equal(fixture.getFile().isSaved, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("modify_file persists a file that was initially closed when Auto Save is on", async () => {
  const fixture = await setupEditable("before", { open: false });
  const { root, agent, editor } = fixture;
  editor.autoSaveEnabled = true;
  try {
    const read = await agent.readFile("editable.txt");
    const result = await agent.modifyFile({
      path: "editable.txt",
      revision: read.revision,
      oldText: "before",
      newText: "after",
    });
    assert.equal(result.mutationOutcome, "APPLIED_AND_VERIFIED", JSON.stringify(result));
    assert.equal(result.persistence.saved, true);
    assert.equal(await fs.readFile(path.join(root, "editable.txt"), "utf8"), "after");
    assert.equal(fixture.getFile().isSaved, true);
    assert.equal(fixture.getFile().lines.map((line) => line.getText()).join("\n"), "after");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("create_file followed by modify_file keeps editor and filesystem in sync", async () => {
  const fixture = await setup();
  const { root, agent, editor } = fixture;
  editor.autoSaveEnabled = true;
  try {
    const created = await agent.executeToolCall({
      id: "generated-create",
      function: { name: "create_file", arguments: JSON.stringify({ path: "generated.js", content: "A" }) },
    });
    assert.equal(created.result.mutationOutcome, "APPLIED_AND_VERIFIED", JSON.stringify(created));
    const read = await agent.readFile("generated.js");
    const modified = await agent.modifyFile({
      path: "generated.js",
      revision: read.revision,
      oldText: "A",
      newText: "B",
    });
    assert.equal(modified.mutationOutcome, "APPLIED_AND_VERIFIED", JSON.stringify(modified));
    assert.equal(modified.verification.content, "B");
    assert.equal(await fs.readFile(path.join(root, "generated.js"), "utf8"), "B");
    assert.equal(editor.tabManager.getFileByPath(path.join(root, "generated.js")).isSaved, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("modify_file reports uncertain persistence and stays dirty when Auto Save save fails", async () => {
  const fixture = await setupEditable("before");
  const { agent, editor } = fixture;
  editor.autoSaveEnabled = true;
  agent.api.saveFile = async () => undefined;
  try {
    const read = await agent.readFile("editable.txt");
    const result = await agent.modifyFile({
      path: "editable.txt",
      revision: read.revision,
      oldText: "before",
      newText: "after",
    });
    assert.equal(result.mutationOutcome, "APPLIED_BUT_UNCERTAIN");
    assert.equal(result.persistence.saved, false);
    assert.equal(result.persistence.error.code, "SAVE_FAILED");
    assert.equal(fixture.getFile().isSaved, false);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("an older Agent save cannot mark a newer user edit as saved", async () => {
  const fixture = await setupEditable("before");
  const { agent, editor } = fixture;
  editor.autoSaveEnabled = true;
  let releaseSave;
  agent.api.saveFile = () => new Promise((resolve) => { releaseSave = resolve; });
  try {
    const read = await agent.readFile("editable.txt");
    const pending = agent.modifyFile({
      path: "editable.txt",
      revision: read.revision,
      oldText: "before",
      newText: "agent",
    });
    await new Promise((resolve) => setImmediate(resolve));
    const file = fixture.getFile();
    file.editVersion += 1;
    file.setIsSaved(false);
    releaseSave(path.join(fixture.root, "editable.txt"));
    const result = await pending;
    assert.equal(result.mutationOutcome, "APPLIED_BUT_UNCERTAIN");
    assert.equal(result.persistence.error.code, "CONCURRENT_EDIT");
    assert.equal(file.isSaved, false);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("queued Agent snapshots skip stale work and persist the latest version", async () => {
  const fixture = await setupEditable("before");
  const file = fixture.getFile();
  const writes = [];
  let releaseFirst;
  const firstStarted = new Promise((resolve) => {
    fixture.editor.api.saveFile = async (filePath, content) => {
      writes.push(content);
      if (content === "agent-a") {
        resolve();
        await new Promise((release) => { releaseFirst = release; });
      }
      await fs.writeFile(filePath, content);
      return filePath;
    };
  });
  try {
    file.editVersion = 1;
    const first = file.enqueueSaveSnapshot("agent-a", 1, fixture.editor.api.saveFile);
    await firstStarted;
    file.editVersion = 2;
    const second = file.enqueueSaveSnapshot("agent-b", 2, fixture.editor.api.saveFile);
    releaseFirst();
    const results = await Promise.all([first, second]);
    assert.equal(results[0].stale, true);
    assert.equal(results[1].saved, true);
    assert.deepEqual(writes, ["agent-a", "agent-b"]);
    assert.equal(await fs.readFile(file.path, "utf8"), "agent-b");
    assert.equal(file.isSaved, true);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("modify_file keeps a closed file dirty when Auto Save is off", async () => {
  const fixture = await setupEditable("before", { open: false });
  const { agent, editor } = fixture;
  editor.autoSaveEnabled = false;
  let saveCalls = 0;
  agent.api.saveFile = async () => {
    saveCalls += 1;
    return path.join(fixture.root, "editable.txt");
  };
  try {
    const read = await agent.readFile("editable.txt");
    const result = await agent.modifyFile({
      path: "editable.txt",
      revision: read.revision,
      oldText: "before",
      newText: "after",
    });
    assert.equal(result.mutationOutcome, "APPLIED_AND_VERIFIED");
    assert.equal(result.persistence.saved, false);
    assert.equal(saveCalls, 0);
    assert.equal(fixture.getFile().isSaved, false);
    assert.equal(await fs.readFile(path.join(fixture.root, "editable.txt"), "utf8"), "before");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("Agent multi-line edits synchronize NSH before refresh and permit new-revision reads", async () => {
  const initial = Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n");
  const expanded = Array.from({ length: 80 }, (_, i) => `expanded-${i}`).join("\n");
  const shortened = Array.from({ length: 5 }, (_, i) => `short-${i}`).join("\n");
  const fixture = await setupEditable(initial);
  const { root, agent, editor } = fixture;
  try {
    agent.runChangeTracker.beginRun(1, root);
    const synchronized = [];
    editor.highlightController = {
      async syncDocumentFromEditor(file, previousText) {
        synchronized.push([previousText.split("\n").length, file.lines.length]);
      },
    };
    const firstRead = await agent.readFile("editable.txt", { startLine: 1, endLine: 40 });
    const modify = (id, revision, oldText, newText) => agent.executeToolCall({
      id,
      function: { name: "modify_file", arguments: JSON.stringify({
        path: "editable.txt", revision, oldText, newText,
      }) },
    });
    const first = await modify("grow", firstRead.revision, initial, expanded);
    assert.equal(first.success, true, JSON.stringify(first));
    const second = await modify("shrink", first.result.revision, expanded, shortened);
    assert.equal(second.success, true, JSON.stringify(second));
    assert.deepEqual(synchronized, [[40, 80], [80, 5]]);
    const current = await agent.readFile("editable.txt", { startLine: 1, endLine: 5 });
    assert.equal(current.revision, second.result.revision);
    agent.contextManager.updateModelFileVisibility([
      { role: "assistant", tool_calls: [{ id: "current", type: "function", function: {
        name: "read_file", arguments: JSON.stringify({ path: "editable.txt" }),
      } }] },
      { role: "tool", tool_call_id: "current", content: JSON.stringify({ success: true, result: current }) },
    ]);
    const duplicate = await agent.readFile("editable.txt", { startLine: 1, endLine: 5 });
    assert.equal(duplicate.readDecision, "REPEATED_REDUNDANT_READ");
    assert.equal(Object.hasOwn(duplicate, "content"), false);
    const third = await modify("change-again", current.revision, shortened, "latest");
    assert.equal(third.success, true, JSON.stringify(third));
    const fresh = await agent.readFile("editable.txt", { startLine: 1, endLine: 1 });
    assert.equal(fresh.content, "latest");
    assert.equal(fresh.revision, third.result.revision);
    const call = (id, name, args) => agent.executeToolCall({
      id, function: { name, arguments: JSON.stringify(args) },
    });
    assert.equal((await call("review-changes", "get_changed_files", {})).success, true);
    assert.equal((await call("review-diff", "get_diff", { path: "editable.txt" })).success, true);
    assert.equal((await call("review-complete", "task_complete", {
      summary: "Edits complete.", validation: "Changes reviewed.",
    })).success, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("modify_file separates revision validation from exact and ambiguous matching", async () => {
  const fixture = await setupEditable("same\nmiddle\nsame");
  const { root, agent } = fixture;
  try {
    const read = await agent.readFile("editable.txt");
    const missingRevision = await agent.modifyFile({
      path: "editable.txt",
      oldText: "middle",
      newText: "center",
    });
    assert.equal(missingRevision.error.code, "REVISION_REQUIRED");
    const missing = await agent.modifyFile({
      path: "editable.txt",
      revision: read.revision,
      oldText: "absent",
      newText: "value",
    });
    assert.equal(missing.error.code, "OLD_TEXT_NOT_FOUND");
    const ambiguous = await agent.modifyFile({
      path: "editable.txt",
      revision: read.revision,
      oldText: "same",
      newText: "value",
    });
    assert.equal(ambiguous.error.code, "AMBIGUOUS_MATCH");
    assert.equal(
      fixture
        .getFile()
        .lines.map((line) => line.getText())
        .join("\n"),
      "same\nmiddle\nsame",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("partial and truncated reads do not become hidden write preconditions", async () => {
  const longPrefix = "x".repeat(5000);
  const fixture = await setupEditable(`${longPrefix}\ntarget\ntail`);
  const { root, agent } = fixture;
  try {
    const partial = await agent.readFile("editable.txt", {
      startLine: 2,
      endLine: 2,
    });
    const partialEdit = await agent.modifyFile({
      path: "editable.txt",
      revision: partial.revision,
      oldText: "target",
      newText: "changed",
    });
    assert.equal(partialEdit.success, true, JSON.stringify(partialEdit));

    const full = await agent.readFile("editable.txt", {
      startLine: 1,
      endLine: 3,
    });
    assert.equal(full.truncated, true);
    assert.doesNotMatch(full.content, /tail/);
    const outsideVisiblePrefix = await agent.modifyFile({
      path: "editable.txt",
      revision: full.revision,
      oldText: "tail",
      newText: "done",
    });
    assert.equal(
      outsideVisiblePrefix.success,
      true,
      JSON.stringify(outsideVisiblePrefix),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("closed CRLF files and newly created files follow the same revision chain", async () => {
  const fixture = await setupEditable("first\r\nsecond", { open: false });
  const { root, agent } = fixture;
  try {
    const read = await agent.readFile("editable.txt");
    const crlfEdit = await agent.modifyFile({
      path: "editable.txt",
      revision: read.revision,
      oldText: "first\nsecond",
      newText: "first\nupdated",
    });
    assert.equal(crlfEdit.success, true, JSON.stringify(crlfEdit));

    const created = await agent.createWorkspaceFile({
      path: "created.txt",
      content: "created value",
    });
    const createdEdit = await agent.modifyFile({
      path: "created.txt",
      revision: created.revision,
      oldText: "created",
      newText: "updated",
    });
    assert.equal(createdEdit.success, true, JSON.stringify(createdEdit));
    assert.equal(createdEdit.previousRevision, created.revision);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("create_file overwrite requires the explicit revision of existing content", async () => {
  const { root, agent } = await setup();
  try {
    await fs.writeFile(path.join(root, "existing.txt"), "known");
    const refused = await agent.createWorkspaceFile({
      path: "existing.txt",
      content: "replacement",
      overwrite: true,
    });
    assert.equal(refused.error.code, "REVISION_REQUIRED");
    assert.equal(
      await fs.readFile(path.join(root, "existing.txt"), "utf8"),
      "known",
    );

    const read = await agent.readFile("existing.txt");
    const overwritten = await agent.createWorkspaceFile({
      path: "existing.txt",
      content: "replacement",
      overwrite: true,
      revision: read.revision,
    });
    assert.equal(overwritten.success, true, JSON.stringify(overwritten));
    assert.equal(
      await fs.readFile(path.join(root, "existing.txt"), "utf8"),
      "replacement",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("write guards reject stopped runs and workspace changes before mutation", async () => {
  const { root, agent, editor } = await setup();
  const otherRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "nce-other-workspace-"),
  );
  try {
    agent.runId = 4;
    agent.runConfig = { permissions: "code", workspaceRoot: root };
    agent.stopRequested = true;
    const stopped = await agent.executeToolCall(
      {
        function: { name: "create_file", arguments: '{"path":"blocked.txt"}' },
      },
      { runId: 4 },
    );
    assert.equal(stopped.error.code, "RUN_ABORTED");
    assert.equal(
      await editor.api.pathExists(path.join(root, "blocked.txt")),
      false,
    );

    agent.stopRequested = false;
    editor.fileExplorer.rootPath = otherRoot;
    const switched = await agent.executeToolCall(
      {
        function: { name: "create_file", arguments: '{"path":"blocked.txt"}' },
      },
      { runId: 4 },
    );
    assert.equal(switched.error.code, "WORKSPACE_CHANGED");
    assert.equal(
      await editor.api.pathExists(path.join(otherRoot, "blocked.txt")),
      false,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(otherRoot, { recursive: true, force: true });
  }
});

test("Agent create/chunk/rename use actual temporary files and verify revisions", async () => {
  const { root, agent } = await setup();
  try {
    const created = await agent.createWorkspaceFile({
      path: "a.txt",
      content: "first",
    });
    assert.equal(created.success, true, JSON.stringify(created));
    assert.equal(created.verification.verified, true);
    const bad = await agent.writeWorkspaceFileChunk({
      path: "a.txt",
      content: "\nsecond",
      expectedRevision: "wrong",
    });
    assert.equal(bad.error.code, "STALE_REVISION");
    const appended = await agent.writeWorkspaceFileChunk({
      path: "a.txt",
      content: "\nsecond",
      expectedRevision: created.revision,
    });
    assert.equal(appended.success, true, JSON.stringify(appended));
    assert.equal(appended.verification.verified, true);
    assert.equal(
      await fs.readFile(path.join(root, "a.txt"), "utf8"),
      "first\nsecond",
    );
    const renamed = await agent.renameWorkspaceFile({
      path: "a.txt",
      newPath: "b.txt",
    });
    assert.equal(renamed.success, true, JSON.stringify(renamed));
    assert.equal(
      await fs.readFile(path.join(root, "b.txt"), "utf8"),
      "first\nsecond",
    );
    const map = await agent.getProjectMap({});
    assert.equal(map.success, true);
    assert.match(map.text, /b.txt/);
    await fs.writeFile(
      path.join(root, "broken.asar"),
      Buffer.from("invalid\0archive"),
    );
    assert.equal(
      (await agent.readFile("broken.asar")).error.code,
      "BINARY_FILE",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Agent rejects traversal, Windows escapes, dirty overwrite and write payload overflow", async () => {
  const { root, agent, editor } = await setup();
  try {
    for (const p of [
      "../outside.txt",
      "..\\outside.txt",
      "/outside.txt",
      "C:\\outside.txt",
    ]) {
      assert.equal(
        (await agent.createWorkspaceFile({ path: p, content: "bad" })).success,
        false,
      );
    }
    assert.equal(
      agent.resolveWorkspacePath("..\\outside.txt", "C:\\project"),
      null,
    );
    await fs.writeFile(path.join(root, "dirty.txt"), "disk");
    editor.tabManager.getFileByPath = () => ({ isSaved: false });
    assert.equal(
      (
        await agent.createWorkspaceFile({
          path: "dirty.txt",
          content: "overwrite",
          overwrite: true,
        })
      ).error.code,
      "PERMISSION_DENIED",
    );
    assert.equal(
      (
        await agent.writeWorkspaceFileChunk({
          path: "dirty.txt",
          content: "x",
          expectedRevision: "a",
        })
      ).error.code,
      "PERMISSION_DENIED",
    );
    assert.equal(
      agent.toolExecutor.validateFileWritePayload("create_file", {
        content: "x".repeat(10001),
      }).valid,
      false,
    );
    assert.throws(() => agent.registerTool("invalid", {}));
    assert.ok(agent.getTool("create_file"));
    assert.equal(
      agent.validateTool(agent.getTool("write_file_chunk"), {}).valid,
      false,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("main Agent file boundary rejects a symlink to a different temporary directory", async () => {
  const { root, manager } = await setup();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "nce-outside-"));
  try {
    await fs.symlink(
      outside,
      path.join(root, "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = await manager.agentFileOperation(root, "createFile", [
      path.join(root, "link"),
      "escape.txt",
      "bad",
    ]);
    assert.equal(result.success, false);
    assert.equal(result.code, "OUTSIDE_WORKSPACE");
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("ModelClient performs only mocked transport and strips API key from bridge config", async () => {
  let request;
  const agent = createAgent({
    api: {
      aiChat: async (data) => {
        request = data;
        return {
          choices: [{ message: { role: "assistant", content: "mock answer" } }],
        };
      },
    },
  });
  agent.messages = [{ role: "user", content: "test" }];
  agent.contextCompaction.logMetrics = false;
  const result = await agent.requestSingleModel(new AbortController(), {
    provider: {
      id: "mock",
      baseURL: "https://invalid.example",
      apiKey: "test-key",
    },
    model: "mock",
    supportsTools: false,
  });
  assert.equal(result.choices[0].message.content, "mock answer");
  assert.equal(request.provider.apiKey, undefined);
  const config = agent.createRunConfig({ runId: 3, sessionId: "session" });
  assert.equal(config.runId, 3);
  assert.equal(config.sessionId, "session");
  const state = agent.createLargeWriteRuntimeState({
    largeFileWriting: { maxChunkCharacters: 4000 },
  });
  assert.equal(state.maxChunkChars, 4000);
  assert.equal(state.state, "IDLE");
  await assert.rejects(agent.agentRunner.execute(""), /obligatoire/);
  assert.equal((await agent.activeFileManager.readActiveFile()).success, false);
});

test("ModelClient applies optional provider and session headers consistently", async () => {
  const requests = [];
  const fetchMock = async (_url, request) => {
    requests.push(request);
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { role: "assistant", content: "ok" } }] };
      },
    };
  };
  const fixture = await setup(fetchMock);
  try {
    fixture.agent.messages = [{ role: "user", content: "test" }];
    fixture.agent.contextCompaction.logMetrics = false;
    await fixture.agent.requestSingleModel(new AbortController(), {
      provider: {
        id: "optional",
        baseURL: "https://invalid.example",
        apiKey: "secret-key",
        requestHeaders: {
          "User-Agent": "nce-agent/0.1.0",
          "X-Count": 7,
          "X-Empty": null,
        },
        sessionHeader: "x-session-id",
      },
      model: "optional-model",
      sessionId: "session-123",
      supportsTools: false,
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers["User-Agent"], "nce-agent/0.1.0");
    assert.equal(requests[0].headers["X-Count"], "7");
    assert.equal(requests[0].headers["X-Empty"], undefined);
    assert.equal(requests[0].headers.Authorization, "Bearer secret-key");
    assert.equal(requests[0].headers["x-session-id"], "session-123");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("ModelClient keeps optional headers absent and bridge sessions separate from API keys", async () => {
  let request;
  const fixture = await setup();
  try {
    fixture.agent.api.aiChat = async (data) => {
      request = data;
      return {
        choices: [{ message: { role: "assistant", content: "ok" } }],
      };
    };
    fixture.agent.messages = [{ role: "user", content: "test" }];
    fixture.agent.contextCompaction.logMetrics = false;
    await fixture.agent.requestSingleModel(new AbortController(), {
      provider: {
        id: "plain",
        baseURL: "https://invalid.example",
        apiKey: "secret-key",
      },
      model: "plain-model",
      sessionId: "session-456",
      supportsTools: false,
    });

    assert.equal(request.provider.apiKey, undefined);
    assert.equal(request.provider.requestHeaders, undefined);
    assert.equal(request.provider.sessionHeader, undefined);
    assert.equal(request.sessionId, "session-456");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
