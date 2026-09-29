const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

const HighlightController = loadGlobal(
  "src/js/controller/HighlightController.js",
  "HighlightController",
  { NSHClient: class {} },
);

function makeController({ language = "javascript", incremental = true, tokens = [] } = {}) {
  const line = {
    getTokens: () => tokens,
    getText: () => "const answer = 42;",
  };
  const file = { id: 1, language, lines: [line] };
  const editor = {
    tabManager: { activeFile: file },
    lineController: { lines: file.lines },
  };
  const controller = Object.create(HighlightController.prototype);
  controller.editor = editor;
  controller.documentModes = new Map(incremental ? [[file.id, "incremental"]] : []);
  controller.dirtyLines = new Set();
  controller.rangeLoads = 0;
  controller.refreshCalls = 0;
  controller.loadVisibleDocumentLines = () => {
    controller.rangeLoads += 1;
    return Promise.resolve();
  };
  controller.refresh = () => { controller.refreshCalls += 1; };
  return { controller, file };
}

test("vertical scroll with warm line tokens does not reload token ranges", () => {
  const { controller } = makeController({ tokens: [{ value: "cached" }] });

  controller.refreshForVerticalScroll([0, 0]);

  assert.equal(controller.rangeLoads, 0);
  assert.equal(controller.refreshCalls, 0);
});

test("vertical scroll requests a range only when an entering line has no tokens", () => {
  const { controller } = makeController({ tokens: null });

  controller.refreshForVerticalScroll([0]);

  assert.equal(controller.rangeLoads, 1);
  assert.equal(controller.refreshCalls, 0);
});

test("line-mode highlighting queues only the uncached entering line", () => {
  const { controller } = makeController({ incremental: false, tokens: null });

  controller.refreshForVerticalScroll([0]);

  assert.deepEqual([...controller.dirtyLines], [0]);
  assert.equal(controller.refreshCalls, 1);
  assert.equal(controller.rangeLoads, 0);
});

test("plain text scroll never queues highlighting", () => {
  const { controller } = makeController({ language: "plaintext", incremental: false, tokens: null });

  controller.refreshForVerticalScroll([0]);

  assert.equal(controller.rangeLoads, 0);
  assert.equal(controller.refreshCalls, 0);
});
