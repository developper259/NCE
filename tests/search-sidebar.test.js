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
