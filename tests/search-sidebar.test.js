const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

let animationFrameRequests = 0;
const SearchSidebar = loadGlobal(
  "src/js/sidebar/Search.Sidebar.js",
  "SearchSidebar",
  {
    Sidebar: class {
      constructor(id, title, icon, side, editor) {
        this.id = id;
        this.title = title;
        this.icon = icon;
        this.side = side;
        this.editor = editor;
        this.isOpen = false;
      }
    },
    SearchResultsScroller: class {},
    NCEPath: { equals: (left, right) => left === right },
    USERCONFIG_FILE_ICONS: { default: "file" },
    AbortController,
    requestAnimationFrame(callback) {
      animationFrameRequests++;
      return setTimeout(callback, 0);
    },
  },
);

function createSearchSidebar() {
  const calls = [];
  const sidebar = new SearchSidebar({
    fileExplorer: { rootPath: "/workspace" },
    api: {
      async searchInFiles(...args) {
        calls.push(args);
        return { results: [], totalMatches: 0, filesSearched: 0, offset: 0 };
      },
    },
  });
  sidebar.isOpen = true;
  return { sidebar, calls };
}

function createReplacementSidebar({ replaceInFiles, searchInFiles, rootPath = "/workspace" } = {}) {
  const replacements = [];
  const searches = [];
  const sidebar = new SearchSidebar({
    fileExplorer: { rootPath },
    api: {
      async replaceInFiles(...args) {
        replacements.push(args);
        return replaceInFiles ? replaceInFiles(...args) : {
          success: true,
          filesChanged: 0,
          replacements: 0,
          skippedFiles: [],
          conflictedFiles: [],
          failedFiles: [],
        };
      },
      async searchInFiles(...args) {
        searches.push(args);
        return searchInFiles ? searchInFiles(...args) : {
          results: [],
          totalMatches: 0,
          filesSearched: 0,
          offset: 0,
        };
      },
    },
  });
  sidebar.isOpen = true;
  sidebar.query = "foo";
  sidebar.replaceInput = { value: "bar" };
  return { sidebar, replacements, searches };
}

function createNavigationSidebar({ openFileWithPath, waitForLineLoaded } = {}) {
  const calls = { opened: [], waits: [], scrolls: [], positions: [], carets: 0 };
  const file = { type: "file", path: "/workspace/result.js" };
  const focusListeners = new Set();
  const tabManager = {
    activeTab: file,
    async openFileWithPath(filePath) {
      calls.opened.push(filePath);
      return openFileWithPath ? openFileWithPath(file, tabManager) : file;
    },
    onActiveTabChange(listener) {
      focusListeners.add(listener);
      return () => focusListeners.delete(listener);
    },
    focus(tab) {
      this.activeTab = tab;
      for (const listener of focusListeners) listener(tab);
    },
  };
  const editor = {
    fileExplorer: { rootPath: "/workspace" },
    api: {},
    tabManager,
    fileLoader: {
      async waitForLineLoaded(target, line, options) {
        calls.waits.push({ target, line, signal: options.signal });
        return waitForLineLoaded
          ? waitForLineLoaded(target, line, options)
          : true;
      },
    },
    lineController: {
      getDisplayIndexForDocument(index) { return index + 5; },
      scrollTo(index) { calls.scrolls.push(index); },
    },
    cursorController: {
      setCursorPosition(...position) { calls.positions.push(position); },
      updateCaretPosition() { calls.carets++; },
    },
  };
  const sidebar = new SearchSidebar(editor);
  sidebar.isOpen = true;
  return { sidebar, tabManager, file, calls, focusListeners };
}

test("workspace search preserves leading and trailing query whitespace", async () => {
  const { sidebar, calls } = createSearchSidebar();
  sidebar.query = "  hello  ";

  await sidebar.runSearch();

  assert.equal(sidebar.query, "  hello  ");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "  hello  ");
});

test("Replace All reports partial results and identifies unsaved editor buffers", async () => {
  let replaceCall;
  const editor = {
    fileExplorer: { rootPath: "/workspace" },
    tabManager: {
      tabs: [
        { path: "/workspace/dirty.js", isSaved: false },
        { path: "/workspace/saved.js", isSaved: true },
      ],
    },
    api: {
      async replaceInFiles(...args) {
        replaceCall = args;
        return {
          success: false,
          filesChanged: 1,
          replacements: 4,
          skippedFiles: [{ path: "dirty.js", code: "DIRTY_EDITOR_BUFFER" }],
          conflictedFiles: [],
          failedFiles: [],
          cancelled: false,
        };
      },
      async searchInFiles() {
        return { results: [], totalMatches: 0, filesSearched: 0, offset: 0 };
      },
    },
  };
  const sidebar = new SearchSidebar(editor);
  sidebar.isOpen = true;
  sidebar.query = "needle";
  sidebar.replaceInput = { value: "changed" };

  await sidebar.replaceInFiles();

  assert.deepEqual(replaceCall[3].dirtyPaths, ["/workspace/dirty.js"]);
  assert.match(sidebar.replacementSummary, /4 replacements in 1 file/);
  assert.match(sidebar.replacementSummary, /DIRTY_EDITOR_BUFFER/);
});

test("Replace All accepts empty literal and regex replacements across files and refreshes search", async () => {
  for (const { query, useRegex } of [
    { query: "foo", useRegex: false },
    { query: "f.o", useRegex: true },
  ]) {
    const { sidebar, replacements, searches } = createReplacementSidebar({
      async replaceInFiles() {
        return {
          success: true,
          filesChanged: 2,
          replacements: 5,
          skippedFiles: [],
          conflictedFiles: [],
          failedFiles: [],
        };
      },
    });
    sidebar.query = query;
    sidebar.useRegex = useRegex;
    sidebar.replaceInput.value = "";

    await sidebar.replaceInFiles();

    assert.equal(replacements.length, 1);
    assert.equal(replacements[0][1], query);
    assert.equal(replacements[0][2], "");
    assert.equal(replacements[0][3].useRegex, useRegex);
    assert.equal(sidebar.replacementSummary, "Replace All complete: 5 replacements in 2 files · 0 skipped · 0 conflicts · 0 failures");
    assert.equal(searches.length, 1, "search results refresh after the replacement");
    assert.equal(sidebar.isReplacing, false);
  }
});

test("Replace All rejects missing query, unavailable replacement control, and invalid workspace", async () => {
  const cases = [
    ({ sidebar }) => { sidebar.query = ""; },
    ({ sidebar }) => { sidebar.replaceInput = null; },
    ({ sidebar }) => { sidebar.replaceInput = { value: null }; },
    ({ sidebar }) => { sidebar.editor.fileExplorer.rootPath = "  "; },
  ];
  for (const configure of cases) {
    const fixture = createReplacementSidebar();
    configure(fixture);
    await fixture.sidebar.replaceInFiles();
    assert.equal(fixture.replacements.length, 0);
  }
});

test("Replace All reports invalid regex failure and refreshes without repeating replacement", async () => {
  const { sidebar, replacements, searches } = createReplacementSidebar({
    async replaceInFiles() {
      return {
        success: false,
        error: "Invalid regular expression.",
        filesChanged: 0,
        replacements: 0,
        skippedFiles: [],
        conflictedFiles: [],
        failedFiles: [],
      };
    },
  });
  sidebar.query = "[";
  sidebar.useRegex = true;
  sidebar.replaceInput.value = "";

  await sidebar.replaceInFiles();

  assert.equal(replacements.length, 1);
  assert.equal(replacements[0][3].useRegex, true);
  assert.match(sidebar.replacementSummary, /Replace All incomplete/);
  assert.match(sidebar.replacementSummary, /Invalid regular expression/);
  assert.equal(searches.length, 1);
});

test("Replace All ignores a concurrent duplicate request", async () => {
  let finishReplacement;
  const replacementResult = new Promise((resolve) => { finishReplacement = resolve; });
  const { sidebar, replacements, searches } = createReplacementSidebar({
    replaceInFiles: () => replacementResult,
  });
  sidebar.replaceInput.value = "";

  const first = sidebar.replaceInFiles();
  await Promise.resolve();
  await sidebar.replaceInFiles();
  finishReplacement({
    success: true,
    filesChanged: 1,
    replacements: 1,
    skippedFiles: [],
    conflictedFiles: [],
    failedFiles: [],
  });
  await first;

  assert.equal(replacements.length, 1);
  assert.equal(searches.length, 1);
});

test("workspace search treats a whitespace-only query as empty without rewriting it", async () => {
  const { sidebar, calls } = createSearchSidebar();
  sidebar.query = "   ";

  await sidebar.runSearch();

  assert.equal(sidebar.query, "   ");
  assert.equal(calls.length, 0);
});

test("workspace search pages reuse their session and query replacement cancels it", async () => {
  const requests = [];
  const cancellations = [];
  const editor = {
    fileExplorer: { rootPath: "/workspace" },
    api: {
      async searchInFiles(...args) {
        requests.push(args);
        const offset = args[2].offset;
        return {
          results: [{ path: `/workspace/result-${offset}.js`, line: 1 }],
          totalMatches: 2,
          filesSearched: 1,
          offset,
          hasMore: offset === 0,
        };
      },
      cancelSearch(id) { cancellations.push(id); },
    },
  };
  const sidebar = new SearchSidebar(editor);
  sidebar.isOpen = true;
  sidebar.query = "first";
  sidebar.resultsPageSize = 1;

  await sidebar.runSearch();
  const firstSession = sidebar.activeSearchSessionId;
  await sidebar.loadMoreResults();

  assert.equal(requests.length, 2);
  assert.equal(requests[0][2].sessionId, firstSession);
  assert.equal(requests[1][2].sessionId, firstSession);
  assert.equal(requests[0][2].workspaceGeneration, sidebar.workspaceGeneration);
  assert.equal(requests[1][2].offset, 1);
  assert.equal(sidebar.results.length, 2);

  sidebar.query = "replacement";
  await sidebar.runSearch();
  assert.ok(cancellations.includes(firstSession));
  assert.notEqual(sidebar.activeSearchSessionId, firstSession);
  assert.equal(requests[2][2].sessionId, sidebar.activeSearchSessionId);
});

test("workspace search renders live batches, progress and ignores stale sessions", async () => {
  const listeners = new Set();
  const starts = [];
  const editor = {
    fileExplorer: { rootPath: "/workspace" },
    api: {
      onWorkspaceSearchEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async startWorkspaceSearch(...args) {
        starts.push(args);
        return { success: true, sessionId: args[2].sessionId };
      },
      cancelSearch() {},
    },
  };
  const sidebar = new SearchSidebar(editor);
  sidebar.isOpen = true;
  sidebar.query = "first";

  const firstRun = sidebar.runSearch();
  await new Promise((resolve) => setImmediate(resolve));
  const firstSession = starts[0][2].sessionId;
  const firstListener = [...listeners][0];
  firstListener({
    type: "batch",
    sessionId: firstSession,
    workspaceGeneration: sidebar.workspaceGeneration,
    results: [{ path: "/workspace/first.js", relativePath: "first.js", name: "first.js", line: 1, preview: "first", matchStart: 0, matchLength: 5 }],
    totalMatches: 1,
    filesSearched: 1,
    scannedFiles: 3,
  });
  assert.equal(sidebar.results.length, 1);
  assert.equal(sidebar.isSearching, true);
  assert.match(sidebar.getSummaryText(), /3 files scanned/);
  firstListener({
    type: "reset",
    sessionId: firstSession,
    workspaceGeneration: sidebar.workspaceGeneration,
    totalMatches: 0,
    filesSearched: 0,
    scannedFiles: 0,
  });
  assert.equal(sidebar.results.length, 0);
  assert.equal(sidebar.totalMatches, 0);
  assert.equal(sidebar.filesSearched, 0);
  assert.equal(sidebar.filesScanned, 0);
  assert.equal(sidebar.isSearching, true);
  firstListener({
    type: "batch",
    sessionId: firstSession,
    workspaceGeneration: sidebar.workspaceGeneration,
    results: [{ path: "/workspace/rechecked.js", relativePath: "rechecked.js", name: "rechecked.js", line: 1, preview: "current", matchStart: 0, matchLength: 7 }],
    totalMatches: 1,
    filesSearched: 1,
    scannedFiles: 4,
  });
  firstListener({
    type: "complete",
    sessionId: firstSession,
    workspaceGeneration: sidebar.workspaceGeneration,
    totalMatches: 2,
    filesSearched: 2,
    scannedFiles: 5,
  });
  await firstRun;
  assert.equal(sidebar.results[0].name, "rechecked.js");
  assert.equal(sidebar.hasMoreResults, true);
  assert.equal(sidebar.nextResultsOffset, 1);

  sidebar.query = "second";
  const secondRun = sidebar.runSearch();
  await new Promise((resolve) => setImmediate(resolve));
  const secondSession = starts[1][2].sessionId;
  const secondListener = [...listeners][0];
  firstListener({
    type: "batch",
    sessionId: firstSession,
    workspaceGeneration: sidebar.workspaceGeneration,
    results: [{ path: "/workspace/stale.js", name: "stale.js" }],
    totalMatches: 99,
    filesSearched: 99,
    scannedFiles: 99,
  });
  assert.equal(sidebar.results.length, 0);
  secondListener({
    type: "batch",
    sessionId: secondSession,
    workspaceGeneration: sidebar.workspaceGeneration,
    results: [{ path: "/workspace/current.js", name: "current.js" }],
    totalMatches: 1,
    filesSearched: 1,
    scannedFiles: 1,
  });
  secondListener({
    type: "complete",
    sessionId: secondSession,
    workspaceGeneration: sidebar.workspaceGeneration,
    totalMatches: 1,
    filesSearched: 1,
    scannedFiles: 1,
  });
  await secondRun;
  assert.equal(sidebar.results[0].name, "current.js");
  assert.equal(sidebar.totalMatches, 1);
});

test("workspace search ignores late results and errors after a replacement", async () => {
  const listeners = new Set();
  const starts = [];
  let rejectFirstStart;
  const editor = {
    fileExplorer: { rootPath: "/workspace" },
    api: {
      onWorkspaceSearchEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      startWorkspaceSearch(...args) {
        starts.push(args);
        if (starts.length === 1)
          return new Promise((_resolve, reject) => { rejectFirstStart = reject; });
        return Promise.resolve({ success: true, sessionId: args[2].sessionId });
      },
      cancelSearch() {},
    },
  };
  const sidebar = new SearchSidebar(editor);
  sidebar.isOpen = true;
  sidebar.query = "old";
  const oldRun = sidebar.runSearch();
  await new Promise((resolve) => setImmediate(resolve));

  sidebar.query = "new";
  const newRun = sidebar.runSearch();
  await new Promise((resolve) => setImmediate(resolve));
  const newSession = starts[1][2].sessionId;
  const currentListener = [...listeners][0];
  currentListener({
    type: "batch",
    sessionId: newSession,
    workspaceGeneration: sidebar.workspaceGeneration,
    results: [{ path: "/workspace/new.js", name: "new.js" }],
    totalMatches: 1,
    filesSearched: 1,
    scannedFiles: 1,
  });
  currentListener({
    type: "complete",
    sessionId: newSession,
    workspaceGeneration: sidebar.workspaceGeneration,
    totalMatches: 1,
    filesSearched: 1,
    scannedFiles: 1,
  });
  await newRun;
  rejectFirstStart(new Error("old search failed"));
  await oldRun;

  assert.equal(sidebar.results.length, 1);
  assert.equal(sidebar.results[0].name, "new.js");
});

test("search result navigation awaits opening and the requested progressive line", async () => {
  animationFrameRequests = 0;
  let openFile;
  let loadLine;
  const { sidebar, file, calls } = createNavigationSidebar({
    openFileWithPath: () => new Promise((resolve) => { openFile = resolve; }),
    waitForLineLoaded: () => new Promise((resolve) => { loadLine = resolve; }),
  });

  const navigation = sidebar.openResult({
    path: file.path,
    line: 4501,
    column: 7,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.opened, [file.path]);
  assert.equal(calls.waits.length, 0);
  assert.deepEqual(calls.scrolls, []);

  openFile(file);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.waits.length, 1);
  assert.equal(calls.waits[0].target, file);
  assert.equal(calls.waits[0].line, 4501);
  assert.deepEqual(calls.scrolls, []);

  loadLine(true);
  await navigation;

  assert.deepEqual(calls.scrolls, [4505]);
  assert.deepEqual(calls.positions, [[4501, 7]]);
  assert.equal(calls.carets, 1);
  assert.equal(animationFrameRequests, 0);
});

test("search result navigation reuses an already open file", async () => {
  const { sidebar, file, calls } = createNavigationSidebar();

  await sidebar.openResult({ path: file.path, line: 3, column: 2 });

  assert.deepEqual(calls.opened, [file.path]);
  assert.equal(calls.waits[0].target, file);
  assert.equal(calls.waits[0].line, 3);
  assert.deepEqual(calls.scrolls, [7]);
  assert.deepEqual(calls.positions, [[3, 2]]);
});

test("search result navigation aborts when the user focuses another tab", async () => {
  let rejectLine;
  const { sidebar, tabManager, file, calls, focusListeners } =
    createNavigationSidebar({
      waitForLineLoaded: (_target, _line, { signal }) =>
        new Promise((resolve, reject) => {
          rejectLine = reject;
          signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
          }, { once: true });
        }),
    });

  const navigation = sidebar.openResult({ path: file.path, line: 9000, column: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  const otherTab = { type: "settings" };
  tabManager.focus(otherTab);
  await navigation;

  assert.equal(calls.waits[0].signal.aborted, true);
  assert.deepEqual(calls.scrolls, []);
  assert.deepEqual(calls.positions, []);
  assert.equal(focusListeners.size, 0);
  assert.equal(typeof rejectLine, "function");
});

test("search result navigation ignores an open that finishes after its query is cancelled", async () => {
  let finishOpening;
  const { sidebar, file, calls } = createNavigationSidebar({
    openFileWithPath: () => new Promise((resolve) => { finishOpening = resolve; }),
  });

  const navigation = sidebar.openResult({ path: file.path, line: 100, column: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  sidebar.cancelResultNavigation();
  finishOpening(file);
  await navigation;

  assert.equal(calls.waits.length, 0);
  assert.deepEqual(calls.scrolls, []);
  assert.deepEqual(calls.positions, []);
});

test("search result navigation cancels a pending waiter when its query is replaced", async () => {
  const { sidebar, file, calls } = createNavigationSidebar({
    waitForLineLoaded: (_target, _line, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
        }, { once: true });
      }),
  });

  const navigation = sidebar.openResult({ path: file.path, line: 6000, column: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  sidebar.cancelResultNavigation();
  await navigation;

  assert.equal(calls.waits[0].signal.aborted, true);
  assert.deepEqual(calls.scrolls, []);
  assert.deepEqual(calls.positions, []);
});

const SAMPLE_RESULTS = [
  { path: "/w/a.js", name: "a.js", relativePath: "a.js", line: 1, preview: "sync", matchStart: 0, matchLength: 4 },
  { path: "/w/a.js", name: "a.js", relativePath: "a.js", line: 2, preview: "sync", matchStart: 0, matchLength: 4 },
  { path: "/w/b.js", name: "b.js", relativePath: "b.js", line: 5, preview: "sync", matchStart: 0, matchLength: 4 },
];

function createResultsSidebar(results = SAMPLE_RESULTS) {
  const { sidebar } = createSearchSidebar();
  sidebar.query = "sync";
  sidebar.results = results;
  const rendered = [];
  sidebar.resultsScroller = {
    setItems(items, options) { rendered.push({ items, options }); },
  };
  return { sidebar, rendered };
}

function createRecordingDom() {
  const make = (tag) => {
    const calls = { tag, className: "", classes: {}, attrs: {}, props: {}, dataset: {}, title: "", text: "", children: [], listeners: {} };
    const node = {
      domNode: { tag },
      _calls: calls,
      setClassName(value) { calls.className = value; return true; },
      toggleClass(name, on) { calls.classes[name] = on; return true; },
      setAttribute(name, value) { calls.attrs[name] = String(value); return true; },
      setProperty(name, value) { calls.props[name] = value; return true; },
      setDataset(name, value) { calls.dataset[name] = String(value); return true; },
      setTitle(value) { calls.title = String(value); return true; },
      setTextContent(value) { calls.text = String(value); return true; },
      append(...kids) { calls.children.push(...kids); },
      addEventListener(type, fn) { (calls.listeners[type] ||= []).push(fn); },
    };
    return node;
  };
  return { createFastElement: make };
}

test("result items group matches under collapsible file headers without a count badge", () => {
  const { sidebar } = createResultsSidebar();
  const items = sidebar.buildResultItems();

  assert.deepEqual([...items.map((item) => item.type)], ["header", "match", "match", "header", "match"]);
  const headers = items.filter((item) => item.type === "header");
  assert.deepEqual([...headers.map((header) => header.filePath)], ["/w/a.js", "/w/b.js"]);
  assert.ok(headers.every((header) => header.collapsed === false));
  assert.ok(headers.every((header) => !("count" in header)), "no per-file count badge");
});

test("collapsing a file hides its matches and expanding restores them", () => {
  const { sidebar, rendered } = createResultsSidebar();
  sidebar.renderResults();
  assert.equal(rendered.at(-1).items.filter((item) => item.type === "match").length, 3);

  sidebar.toggleFileCollapse("/w/a.js");
  assert.ok(sidebar.collapsedFiles.has("/w/a.js"));
  let items = rendered.at(-1).items;
  assert.equal(items.filter((item) => item.type === "match").length, 1);
  assert.equal(items.find((item) => item.type === "header" && item.filePath === "/w/a.js").collapsed, true);
  assert.equal(rendered.at(-1).options.resetScroll, false, "collapse preserves scroll position");

  sidebar.toggleFileCollapse("/w/a.js");
  assert.ok(!sidebar.collapsedFiles.has("/w/a.js"));
  items = rendered.at(-1).items;
  assert.equal(items.filter((item) => item.type === "match").length, 3);
  assert.equal(items.find((item) => item.type === "header" && item.filePath === "/w/a.js").collapsed, false);
});

test("renderResults skips an identical view but rebuilds when a group collapses", () => {
  const { sidebar, rendered } = createResultsSidebar();
  sidebar.renderResults();
  const count = rendered.length;
  sidebar.renderResults();
  assert.equal(rendered.length, count, "identical view is not rebuilt");
  sidebar.toggleFileCollapse("/w/b.js");
  assert.equal(rendered.length, count + 1, "collapse forces a rebuild");
});

test("a new search clears collapsed files", async () => {
  const { sidebar } = createResultsSidebar();
  sidebar.collapsedFiles.add("/w/a.js");
  sidebar.collapseVersion = 5;

  await sidebar.runSearch();

  assert.equal(sidebar.collapsedFiles.size, 0);
});

test("filter toggle reveals include/exclude inputs and marks the button active", () => {
  const { sidebar } = createSearchSidebar();
  sidebar.searchBox = { classList: { toggle() {} } };
  sidebar.includeInput = { hidden: true, focus() { this.focused = true; } };
  sidebar.excludeInput = { hidden: true };
  const state = {};
  sidebar.filterToggleButton = {
    classList: { toggle(name, on) { state[name] = on; } },
    setAttribute(name, value) { state[name] = value; },
    title: "",
  };

  sidebar.applyFiltersExpandedState();
  assert.equal(sidebar.includeInput.hidden, true);
  assert.equal(sidebar.excludeInput.hidden, true);
  assert.equal(state["aria-expanded"], "false");
  assert.equal(state["is-active"], false);

  sidebar.toggleFilters();
  assert.equal(sidebar.filtersExpanded, true);
  assert.equal(sidebar.includeInput.hidden, false);
  assert.equal(sidebar.excludeInput.hidden, false);
  assert.equal(sidebar.includeInput.focused, true);
  assert.equal(state["aria-expanded"], "true");
  assert.equal(state["is-active"], true);
  assert.equal(sidebar.filterToggleButton.title, "Hide filters");

  sidebar.toggleFilters();
  assert.equal(sidebar.filtersExpanded, false);
  assert.equal(sidebar.includeInput.hidden, true);
  assert.equal(state["is-active"], false);
  assert.equal(sidebar.filterToggleButton.title, "Show filters");
});

test("file header node is a collapsible button without a count badge", () => {
  const { sidebar } = createResultsSidebar();
  sidebar.editor.domManager = createRecordingDom();
  const header = sidebar.buildResultItems().find((item) => item.type === "header");

  const row = sidebar.createResultNode(header);
  const calls = row._calls;
  assert.equal(calls.className, "search-sidebar-file-header");
  assert.equal(calls.attrs.role, "button");
  assert.equal(calls.attrs["aria-expanded"], "true");
  assert.equal(calls.props.tabIndex, 0);
  assert.equal(calls.dataset.file, header.filePath);
  assert.equal(calls.children.length, 3, "caret + icon + name, no count");
  assert.match(calls.children[0]._calls.className, /search-sidebar-file-caret/);
  assert.match(calls.children[1]._calls.className, /search-sidebar-file-icon/);
  assert.equal(calls.children[2]._calls.className, "search-sidebar-file-name");
  assert.ok(calls.listeners.click?.length, "header wires a click toggle");
  assert.ok(calls.listeners.keydown?.length, "header wires a keyboard toggle");

  assert.equal(sidebar.collapsedFiles.size, 0);
  calls.listeners.click[0]();
  assert.ok(sidebar.collapsedFiles.has(header.filePath));
});

test("a collapsed file header reports aria-expanded false and the collapsed class", () => {
  const { sidebar } = createResultsSidebar();
  sidebar.editor.domManager = createRecordingDom();
  sidebar.collapsedFiles.add("/w/a.js");
  const header = sidebar.buildResultItems().find((item) => item.filePath === "/w/a.js");
  assert.equal(header.collapsed, true);

  const calls = sidebar.createResultNode(header)._calls;
  assert.equal(calls.attrs["aria-expanded"], "false");
  assert.equal(calls.classes["is-collapsed"], true);
});
