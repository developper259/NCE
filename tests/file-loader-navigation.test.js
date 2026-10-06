const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

const LineNode = loadGlobal("src/js/types/Line.js", "LineNode");
const FileLoader = loadGlobal("src/js/addon/FileLoader.js", "FileLoader", {
  LineNode,
  window: {},
});

function createLoadingFile() {
  const editor = {
    api: {
      async getFileChunk(_path, start, count) {
        return {
          success: true,
          lines: Array.from({ length: count }, (_, index) => `line-${start + index + 1}`),
        };
      },
    },
    lineController: {
      appendLoadedLines(file, lines) {
        file.lines.push(...lines.map((line) => new LineNode(line)));
      },
    },
    tabManager: { activeFile: null },
  };
  const loader = new FileLoader(editor);
  const state = loader.getState("/workspace/large.txt");
  state.status = "loading";
  state.isLoading = true;
  state.expectedTotalLines = 10_000;
  state.loadedLineCount = 1_000;
  const file = {
    path: state.filePath,
    lines: Array.from({ length: 1_000 }, (_, index) => new LineNode(`line-${index + 1}`)),
    loadingState: state,
  };
  editor.tabManager.activeFile = file;
  return { editor, loader, state, file };
}

test("FileLoader waits for a requested line during progressive file loading", async () => {
  const { loader, state, file } = createLoadingFile();
  const pending = loader.waitForLineLoaded(file, 4501);
  let settled = false;
  pending.then(() => { settled = true; });

  for (let start = 1_000; start < 5_000; start += 1_000) {
    await loader.performChunkLoad(
      file,
      file.path,
      start,
      start + 1_000,
      state.expectedTotalLines,
      () => {},
      state,
    );
  }

  assert.equal(await pending, true);
  assert.equal(settled, true);
  assert.equal(state.loadedLineCount, 5_000);
  assert.equal(state.status, "loading");
  assert.equal(file.lines.length, 5_000);
  assert.equal(state.lineWaiters.size, 0);
});

test("FileLoader cancellation removes a pending line waiter", async () => {
  const { loader, state, file } = createLoadingFile();
  const controller = new AbortController();
  const pending = loader.waitForLineLoaded(file, 9_000, {
    signal: controller.signal,
  });
  assert.equal(state.lineWaiters.size, 1);

  const rejected = assert.rejects(pending, (error) => error.name === "AbortError");
  controller.abort();
  await rejected;

  assert.equal(state.lineWaiters.size, 0);
});
