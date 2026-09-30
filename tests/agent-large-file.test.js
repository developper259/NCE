const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");
const AgentPath = loadGlobal("src/js/agent/utils/AgentPath.js", "AgentPath", {
  window: {},
});
const ActiveFileManager = loadGlobal(
  "src/js/agent/files/ActiveFileManager.js",
  "ActiveFileManager",
  { AgentPath, window: {} },
);

test("Agent reads a bounded Large File Mode range without materializing the document", async () => {
  const requests = [];
  const file = {
    id: 7,
    name: "huge.js",
    path: "/workspace/huge.js",
    largeFileMode: true,
    largeFileSize: 84_000_000,
    diskFingerprint: "84000000:1234",
    editVersion: 0,
    totalLines: 1000,
    lines: [{ getText() { return "initial"; } }],
    loadingState: { status: "loading", expectedTotalLines: 1000 },
    isLoaded: true,
  };
  const agent = {
    editor: {
      tabManager: { activeFile: file },
      lineController: { getContent() { assert.fail("full editor content read"); } },
      fileExplorer: { rootPath: "/workspace" },
    },
    api: {
      async getFileChunk(filePath, startLine, lineCount) {
        requests.push({ filePath, startLine, lineCount });
        return {
          success: true,
          lines: Array.from({ length: lineCount }, (_, index) => `line-${startLine + index + 1}`),
        };
      },
    },
    toolLimits: { read_file: { defaultLines: 200, outputCharacters: 4000 } },
    fileKnowledge: {
      checkRead: (_path, startLine, endLine) => ({ range: { startLine, endLine } }),
      recordRead() {},
      recordPartialSegment() {},
    },
    readFileContexts: new Map(),
    fileContextVersion: 0,
    toProjectRelativePath: (filePath) => filePath.replace("/workspace/", ""),
    getContentRevision() { assert.fail("full content revision calculated"); },
  };
  const manager = new ActiveFileManager(agent);
  const result = await manager.readActiveFile({ startLine: 500, endLine: 700 });
  assert.equal(result.success, true);
  assert.equal(result.startLine, 500);
  assert.equal(result.endLine, 699);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    filePath: "/workspace/huge.js",
    startLine: 499,
    lineCount: 200,
  });
  assert.match(result.content, /^line-500/);
  assert.match(result.content, /line-699$/);
});

test("Agent modifications to a Large File Mode active file return a clear error", async () => {
  const file = { largeFileMode: true, path: "/workspace/huge.js" };
  const agent = {
    editor: {
      tabManager: { activeFile: file },
      writerController: { replaceRange() { assert.fail("large file edit attempted"); } },
      lineController: {},
    },
    async waitForEditorReady() { return true; },
  };
  const result = await new ActiveFileManager(agent).modifyActiveFile({
    oldText: "before",
    newText: "after",
  });
  assert.equal(result.success, false);
  assert.equal(result.error.code, "LARGE_FILE_MODE_EDIT_UNSUPPORTED");
});

test("read_file routes an open Large File Mode tab to its bounded reader", async () => {
  const file = { path: "/workspace/huge.js", largeFileMode: true };
  const calls = [];
  const WorkspaceFileManager = loadGlobal(
    "src/js/agent/files/WorkspaceFileManager.js",
    "WorkspaceFileManager",
    { AgentPath, window: {} },
  );
  const agent = {
    editor: {
      fileExplorer: { rootPath: "/workspace" },
      tabManager: { getFileByPath: () => file },
    },
    activeFileManager: {
      async readLargeFile(...args) {
        calls.push(args);
        return { success: true, content: "bounded" };
      },
    },
    api: { async getFileContent() { assert.fail("whole-file API used"); } },
    resolveWorkspacePath: () => file.path,
  };
  agent.getWorkspaceFileTarget = () => ({
    valid: true,
    absolutePath: file.path,
    relativePath: "huge.js",
    parentPath: "/workspace",
    fileName: "huge.js",
  });
  const result = await new WorkspaceFileManager(agent).readFile("huge.js", {
    startLine: 500,
    endLine: 700,
  });
  assert.deepEqual(result, { success: true, content: "bounded" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [file, { startLine: 500, endLine: 700 }, "read_file"]);
});
