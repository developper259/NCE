const assert = require("node:assert/strict");
const test = require("node:test");
const { createEditor, loadGlobal } = require("./helpers/runtime");

function searchEditor(text) {
  const { editor } = createEditor(text);
  const classes = { add() {}, remove() {}, contains() { return false; } };
  const input = { value: "", focus() {}, select() {}, blur() {} };
  editor.domManager.getElement = (selector) => {
    if (selector === ".editor-search-bar") return { classList: classes };
    if (selector === ".search-bar-input") return input;
    return { classList: classes, textContent: "" };
  };
  editor.selectOutput = { replaceChildren() {}, children: [] };
  const SearchController = loadGlobal("src/js/controller/SearchController.js", "SearchController", {
    addEvent() {},
    HTMLInputElement: function HTMLInputElement() {},
  });
  return { editor, search: new SearchController(editor) };
}

test("cursor normalizes rows and columns to document boundaries", () => {
  const { editor } = createEditor("ab\nlong");
  const CursorController = loadGlobal("src/js/controller/CursorController.js", "CursorController", {
    roundX: Math.round,
    roundY: Math.round,
    realColumnToViewColumn: (_line, column) => column,
    viewColumnToRealColumn: (_line, column) => column,
  });
  const cursor = new CursorController(editor);
  assert.equal(JSON.stringify(cursor.normalizePosition(0, -4)), JSON.stringify({ row: 1, column: 0 }));
  assert.equal(JSON.stringify(cursor.normalizePosition(99, 99)), JSON.stringify({ row: 2, column: 4 }));
  assert.equal(JSON.stringify(cursor.getPosition(2, 3)), JSON.stringify({ row: 2, column: 3 }));
});

test("search finds case-insensitive occurrences and cycles next/previous", () => {
  const { editor, search } = searchEditor("Hello hello\nworld hello");
  search.search("hello");
  assert.equal(search.results.length, 3);
  assert.equal(JSON.stringify(search.results[0]), JSON.stringify({ row: 1, column: 0, length: 5 }));
  search.currentIndex = -1;
  search.next();
  assert.equal(search.currentIndex, 0);
  search.next();
  assert.equal(search.currentIndex, 1);
  search.previous();
  assert.equal(search.currentIndex, 0);
  search.search("");
  assert.equal(search.results.length, 0);
});

test("search close clears results and closes the visible search bar", () => {
  const { search } = searchEditor("abc");
  search.isOpen = true;
  search.search("a");
  search.close();
  assert.equal(search.isOpen, false);
  assert.equal(search.results.length, 0);
});

test("file loading chooses complete incremental or chunked fallback mode", async () => {
  const FileLoader = loadGlobal("src/js/addon/FileLoader.js", "FileLoader", {
    LineNode: loadGlobal("src/js/types/Line.js", "LineNode"),
    window: {},
  });
  const calls = [];
  const editor = {
    api: {
      initializeFile: async () => ({
        success: true,
        totalLines: 1500,
        size: 50000,
        maxLineLength: 20,
        incrementalEligible: true,
        eol: "\n",
        lineEndings: [],
      }),
      getFileChunk: async (_path, start, count) => {
        calls.push({ start, count });
        return { success: true, lines: Array.from({ length: count }, (_, i) => `${start + i}`) };
      },
    },
  };
  const loader = new FileLoader(editor);
  const result = await loader.loadFile("small.js");
  assert.equal(result.initialLines.length, 1500);
  assert.deepEqual(calls, [{ start: 0, count: 1500 }]);

  editor.api.initializeFile = async () => ({ success: true, totalLines: 1500, size: 2 * 1024 * 1024, maxLineLength: 20, incrementalEligible: false });
  calls.length = 0;
  const fallback = await loader.loadFile("large.js");
  assert.equal(fallback.initialLines.length, 1000);
  assert.deepEqual(calls, [{ start: 0, count: 1000 }]);
});

test("bottom bar exposes loading and failure only for the active file", () => {
  const statusText = { innerText: "" };
  const status = { style: {}, querySelector: () => statusText };
  const elements = new Map([
    [".bottomBar-cursorPos", {}], [".bottomBar-cursor-status", { style: {} }],
    [".bottomBar-file-status", status], ["#language", { querySelector: () => null }], ["#config-space", null],
  ]);
  const BottomBar = loadGlobal("src/js/addon/BottomBar.js", "BottomBar", {
    getElement: (selector) => elements.get(selector), CONFIG_GET: () => 2,
  });
  const activeFile = { loadingState: { status: "loading" } };
  const editor = { tabManager: { activeFile }, highlightController: {} };
  const bar = new BottomBar(editor);
  assert.match(statusText.innerText, /Loading file/);
  assert.equal(status.style.display, "");
  activeFile.loadingState.status = "loaded";
  bar.refreshFileStatus();
  assert.equal(status.style.display, "none");
  activeFile.loadingState.status = "failed";
  bar.refreshFileStatus();
  assert.match(statusText.innerText, /failed/);
  editor.tabManager.activeFile = { loadingState: { status: "cancelled" } };
  bar.refreshFileStatus();
  assert.equal(status.style.display, "none");
});

test("language selector exposes technology logos with a neutral fallback", async () => {
  const elements = new Map([
    [".bottomBar-cursorPos", {}], [".bottomBar-cursor-status", { style: {} }],
    [".bottomBar-file-status", { style: {}, querySelector: () => ({ innerText: "" }) }],
    ["#language", { querySelector: () => ({ innerText: "" }) }],
    ["#config-space", { querySelector: () => ({ innerText: "" }) }],
  ]);
  let options;
  const editor = {
    tabManager: { activeFile: { language: "javascript" } },
    highlightController: {
      getSupportedLanguage: async () => ["javascript", "typescript", "json"],
      changeLanguage: async () => {},
    },
    quickPanel: { open(value) { options = value; } },
  };
  const BottomBar = loadGlobal("src/js/addon/BottomBar.js", "BottomBar", {
    getElement: (selector) => elements.get(selector), CONFIG_GET: () => 2,
  });
  const bar = new BottomBar(editor);
  await bar.openLanguage();
  assert.equal(options.items.find((item) => item.id === "javascript").icon,
    "fi fi-brands-js language-logo-javascript quick-panel-language-logo");
  assert.equal(options.items.find((item) => item.id === "typescript").icon,
    "fi fi-brands-typescript language-logo-typescript quick-panel-language-logo");
  assert.equal(options.items.find((item) => item.id === "json").icon,
    "fi fi-rr-code-simple quick-panel-language-logo");
});
