const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

test("100 edit events refresh cursor state without rebuilding bottom bar or menu state", () => {
  const calls = {
    bottomFull: 0,
    cursor: 0,
    diff: 0,
    documentTitle: 0,
    highlight: 0,
    search: 0,
    titleFull: 0,
  };
  const file = { onChange() {} };
  const editor = {
    isOnInit: false,
    highlightController: { handleChange() { calls.highlight++; } },
    lineController: { recalculatePersistentDiff() { calls.diff++; } },
    searchController: { refresh() { calls.search++; } },
    tabManager: { activeFile: file },
    titleBar: {
      refreshDocumentTitle() { calls.documentTitle++; },
      refresh() { calls.titleFull++; },
    },
    bottomBar: {
      refreshCursorOBJ() { calls.cursor++; },
      refresh() { calls.bottomFull++; },
    },
  };
  const Events = loadGlobal("src/js/core/Event.js", "Events");
  const events = new Events(editor);

  for (let index = 0; index < 100; index++)
    events.callEvent(Events.ON_CHANGE, { action: "typing" });

  assert.deepEqual(calls, {
    bottomFull: 0,
    cursor: 100,
    diff: 100,
    documentTitle: 100,
    highlight: 100,
    search: 100,
    titleFull: 0,
  });
});

test("cursor and selection events update only the cursor status", () => {
  const calls = { cursor: 0, full: 0 };
  const Events = loadGlobal("src/js/core/Event.js", "Events");
  const events = new Events({
    bottomBar: {
      refreshCursorOBJ() { calls.cursor++; },
      refresh() { calls.full++; },
    },
  });

  events.callEvent(Events.CURSOR_CHANGE, { row: 2, column: 4 });
  events.callEvent(Events.ON_SELECT, { start: null, end: null });
  events.callEvent(Events.CURSOR_ENABLED);
  events.callEvent(Events.CURSOR_DISABLED);

  assert.deepEqual(calls, { cursor: 2, full: 0 });
});

test("FileNode requests targeted tab state refreshes instead of a tab list refresh", () => {
  const calls = { targeted: 0, full: 0 };
  const LineNode = loadGlobal("src/js/types/Line.js", "LineNode");
  const FileNode = loadGlobal("src/js/types/Tab.js", "FileNode", { LineNode });
  const editor = {
    getAutoSaveState: () => false,
    historyController: { isAtSavePoint: () => false },
    tabManager: {
      refreshTabState(file) {
        assert.equal(file, target);
        calls.targeted++;
      },
      refresh() { calls.full++; },
    },
  };
  const target = new FileNode(editor, 7, "active.js", "");
  target.scheduleAutoSave = () => {};

  for (let index = 0; index < 100; index++) target.onChange();

  assert.deepEqual(calls, { targeted: 100, full: 0 });
  assert.equal(target.isSaved, false);
});

test("TitleBar avoids repeating unchanged document title DOM writes", () => {
  let text = "";
  let titleAttribute = "";
  let textWrites = 0;
  let titleWrites = 0;
  const title = {};
  Object.defineProperties(title, {
    textContent: {
      get() { return text; },
      set(value) { textWrites++; text = String(value); },
    },
    title: {
      get() { return titleAttribute; },
      set(value) { titleWrites++; titleAttribute = String(value); },
    },
  });
  const file = {
    name: "active.js",
    isVisuallyDirty: () => true,
  };
  const TitleBar = loadGlobal("src/js/addon/TitleBar.js", "TitleBar", {
    TAB_TYPES: { PICTURE: "picture", MARKDOWN: "markdown" },
  });
  const titleBar = Object.assign(Object.create(TitleBar.prototype), {
    title,
    editor: {
      tabManager: { activeFile: file, activeTab: file },
      fileExplorer: { projectName: "workspace" },
    },
  });

  for (let index = 0; index < 100; index++) titleBar.refreshDocumentTitle();

  assert.equal(text, "● active.js · workspace");
  assert.equal(titleAttribute, "active.js · workspace");
  assert.equal(textWrites, 1);
  assert.equal(titleWrites, 1);
});

test("SearchController skips edit refreshes when its query is empty", () => {
  const SearchController = loadGlobal(
    "src/js/controller/SearchController.js",
    "SearchController",
  );
  const calls = [];
  const search = Object.assign(Object.create(SearchController.prototype), {
    isOpen: true,
    input: { value: "" },
    search(query) { calls.push(query); },
  });

  search.refresh();
  search.input.value = "needle";
  search.refresh();

  assert.deepEqual(calls, ["needle"]);
});

test("Auto Save policy changes refresh dirty markers and title only on transitions", () => {
  const calls = { dirtyTabs: 0, title: 0, checkbox: 0 };
  const Editor = loadGlobal("src/js/main/Editor.js", "Editor", {
    document: { addEventListener() {} },
    window: {},
  });
  const editor = Object.assign(Object.create(Editor.prototype), {
    autoSaveEnabled: false,
    titleBar: {
      refreshAutoSaveState() { calls.checkbox++; },
      refreshDocumentTitle() { calls.title++; },
    },
    tabManager: { refreshTabStates() { calls.dirtyTabs++; } },
  });

  editor.setAutoSaveState(true, { persist: false });
  editor.setAutoSaveState(true, { persist: false });
  editor.setAutoSaveState(false, { persist: false });

  assert.deepEqual(calls, { dirtyTabs: 2, title: 2, checkbox: 3 });
});
