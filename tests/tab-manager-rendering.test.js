const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.id = "";
    this._className = "";
    this._textContent = "";
    this.classList = {
      contains: (name) => this._className.split(/\s+/).includes(name),
      add: (name) => {
        if (!this.classList.contains(name))
          this._className = `${this._className} ${name}`.trim();
      },
      remove: (name) => {
        this._className = this._className.split(/\s+/)
          .filter((value) => value && value !== name).join(" ");
      },
      toggle: (name, force) => {
        const shouldHave = force === undefined
          ? !this.classList.contains(name)
          : Boolean(force);
        if (shouldHave) this.classList.add(name);
        else this.classList.remove(name);
        return shouldHave;
      },
    };
  }

  get className() { return this._className; }
  set className(value) { this._className = String(value || ""); }
  get textContent() { return this._textContent; }
  set textContent(value) {
    this._textContent = String(value ?? "");
    this.children = [];
  }

  appendChild(child) {
    if (child.parentElement) child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, before) {
    if (child.parentElement) child.remove();
    const index = before ? this.children.indexOf(before) : -1;
    child.parentElement = this;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  replaceChild(next, previous) {
    const index = this.children.indexOf(previous);
    if (index < 0) throw new Error("Child to replace was not found");
    if (next.parentElement) next.remove();
    next.parentElement = this;
    previous.parentElement = null;
    this.children[index] = next;
    return previous;
  }

  remove() {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentElement = null;
  }
}

test("TabManager refresh preserves tab DOM identity and updates only changed state", () => {
  const ul = new FakeElement("ul");
  ul.replaceChildren = () => assert.fail("refresh must keep the existing tab list");
  const TabManager = loadGlobal(
    "src/js/manager/TabManager.js",
    "tabManager",
    {
      TAB_TYPES: { FILE: "file", SETTINGS: "settings", PICTURE: "picture", MARKDOWN: "markdown" },
      getElement: (selector) => selector === ".file-manager .files-ul" ? ul : null,
      document: { createElement: (tagName) => new FakeElement(tagName) },
    },
  );
  const a = { id: 1, type: "file", name: "a.js", dirty: false, isVisuallyDirty() { return this.dirty; } };
  const b = { id: 2, type: "file", name: "b.js", dirty: false, isVisuallyDirty() { return this.dirty; } };
  const editor = {
    api: { setActiveFileContext() {} },
    titleBar: { refresh() {} },
    isOnInit: false,
    isActive: true,
    reset() {},
    reactive() {},
  };
  const manager = Object.assign(Object.create(TabManager.prototype), {
    editor,
    tabs: [a, b],
    activeTab: a,
    tabElements: new Map(),
  });

  manager.refresh();
  const aEntry = manager.tabElements.get("1");
  const bEntry = manager.tabElements.get("2");
  assert.deepEqual(ul.children, [aEntry.element, bEntry.element]);
  assert.equal(aEntry.element.classList.contains("file-active"), true);
  assert.equal(bEntry.element.classList.contains("file-active"), false);

  manager.activeTab = b;
  manager.refresh();
  assert.equal(manager.tabElements.get("1").element, aEntry.element);
  assert.equal(manager.tabElements.get("2").element, bEntry.element);
  assert.equal(aEntry.element.classList.contains("file-active"), false);
  assert.equal(bEntry.element.classList.contains("file-active"), true);

  const titleElement = aEntry.title;
  a.name = "renamed.js";
  a.dirty = true;
  manager.refresh();
  assert.equal(aEntry.title, titleElement);
  assert.equal(titleElement.textContent, "renamed.js");
  assert.equal(aEntry.element.children[1], aEntry.closeControl);
  assert.equal(aEntry.closeControl.classList.contains("file-unsaved"), true);

  manager.tabs = [b, a];
  manager.refresh();
  assert.deepEqual(ul.children, [bEntry.element, aEntry.element]);

  manager.tabs = [a];
  manager.refresh();
  assert.equal(manager.tabElements.has("2"), false);
  assert.equal(bEntry.element.parentElement, null);
  assert.equal(manager.tabElements.get("1").element, aEntry.element);
});

test("TabManager refreshes only the changed tab dirty marker", () => {
  const ul = new FakeElement("ul");
  const visibilityRequests = [];
  const stateCalls = { contexts: 0, fullRefreshes: 0 };
  const TabManager = loadGlobal(
    "src/js/manager/TabManager.js",
    "tabManager",
    {
      TAB_TYPES: { FILE: "file", SETTINGS: "settings", PICTURE: "picture", MARKDOWN: "markdown" },
      getElement: (selector) => selector === ".file-manager .files-ul" ? ul : null,
      document: { createElement: (tagName) => new FakeElement(tagName) },
    },
  );
  const active = {
    id: 10,
    type: "file",
    name: "active.js",
    dirty: false,
    isVisuallyDirty() { return this.dirty; },
  };
  const other = {
    id: 11,
    type: "file",
    name: "other.js",
    dirty: false,
    isVisuallyDirty() { return this.dirty; },
  };
  const manager = Object.assign(Object.create(TabManager.prototype), {
    editor: {
      api: { setActiveFileContext() { stateCalls.contexts++; } },
      titleBar: { refresh() {} },
      isOnInit: false,
      isActive: true,
      reset() {},
      reactive() {},
    },
    tabs: [active, other],
    activeTab: active,
    tabElements: new Map(),
    tabScroller: {
      ensureElementVisible(element) { visibilityRequests.push(element); },
      refresh() { assert.fail("only the active tab visibility should be checked"); },
    },
  });

  manager.refresh();
  const activeEntry = manager.tabElements.get("10");
  const otherEntry = manager.tabElements.get("11");
  stateCalls.contexts = 0;
  manager.refresh = () => { stateCalls.fullRefreshes++; };
  manager.updateFileOBJ = () => assert.fail("dirty refresh must not update every tab");

  active.dirty = true;
  assert.equal(manager.refreshTabState(active), true);
  const dirtyControl = activeEntry.closeControl;
  assert.equal(dirtyControl.classList.contains("file-unsaved"), true);
  for (let index = 0; index < 99; index++)
    assert.equal(manager.refreshTabState(active), false);
  assert.equal(activeEntry.closeControl, dirtyControl);
  assert.equal(manager.tabElements.get("11"), otherEntry);
  assert.equal(stateCalls.contexts, 0);
  assert.equal(stateCalls.fullRefreshes, 0);
  assert.equal(visibilityRequests.length, 2);
});

test("TabManager batches dirty-state changes across tabs into one visibility refresh", () => {
  const ul = new FakeElement("ul");
  const visibilityRequests = [];
  const TabManager = loadGlobal(
    "src/js/manager/TabManager.js",
    "tabManager",
    {
      TAB_TYPES: { FILE: "file", SETTINGS: "settings", PICTURE: "picture", MARKDOWN: "markdown" },
      getElement: (selector) => selector === ".file-manager .files-ul" ? ul : null,
      document: { createElement: (tagName) => new FakeElement(tagName) },
    },
  );
  const files = [1, 2, 3].map((id) => ({
    id,
    type: "file",
    name: `${id}.js`,
    dirty: true,
    isVisuallyDirty() { return this.dirty; },
  }));
  const manager = Object.assign(Object.create(TabManager.prototype), {
    editor: {
      api: { setActiveFileContext() {} },
      titleBar: { refresh() {} },
      isOnInit: false,
      isActive: true,
      reset() {},
      reactive() {},
    },
    tabs: files,
    activeTab: files[1],
    tabElements: new Map(),
    tabScroller: {
      ensureElementVisible(element) { visibilityRequests.push(element); },
      refresh() { visibilityRequests.push("refresh"); },
    },
  });

  manager.refresh();
  visibilityRequests.length = 0;
  for (const file of files) file.dirty = false;

  assert.equal(manager.refreshTabStates(), true);
  assert.equal(manager.refreshTabStates(), false);
  assert.deepEqual(visibilityRequests, [manager.tabElements.get("2").element]);
  for (const file of files) {
    const entry = manager.tabElements.get(String(file.id));
    assert.equal(entry.dirty, false);
    assert.equal(entry.closeControl.classList.contains("file-saved"), true);
  }
});

test("TabManager hide and show do not toggle the tab-bar bottom divider", () => {
  const calls = [];
  const TabManager = loadGlobal(
    "src/js/manager/TabManager.js",
    "tabManager",
  );
  const manager = Object.assign(Object.create(TabManager.prototype), {
    tabsOBJ: {
      classList: {
        add: (name) => calls.push(["add", name]),
        remove: (name) => calls.push(["remove", name]),
      },
    },
  });

  manager.hide();
  manager.show();

  assert.deepEqual(calls, []);
});

test("TabManager delegates active-tab visibility to its tab scroller", () => {
  const ul = new FakeElement("ul");
  const visibilityRequests = [];
  let refreshes = 0;
  const TabManager = loadGlobal(
    "src/js/manager/TabManager.js",
    "tabManager",
    {
      TAB_TYPES: { FILE: "file", SETTINGS: "settings", PICTURE: "picture", MARKDOWN: "markdown" },
      getElement: (selector) => selector === ".file-manager .files-ul" ? ul : null,
      document: { createElement: (tagName) => new FakeElement(tagName) },
    },
  );
  const tabs = [0, 1, 2].map((id) => ({ id, type: "settings", name: `tab-${id}` }));
  const manager = Object.assign(Object.create(TabManager.prototype), {
    editor: {
      api: { setActiveFileContext() {} },
      titleBar: { refresh() {} },
      isOnInit: false,
      isActive: true,
      reset() {},
      reactive() {},
    },
    tabs,
    activeTab: tabs[0],
    tabElements: new Map(),
    tabScroller: {
      ensureElementVisible(element) { visibilityRequests.push(element); },
      refresh() { refreshes++; },
    },
  });

  manager.refresh();
  const firstElement = manager.tabElements.get("0").element;
  assert.deepEqual(visibilityRequests, [firstElement]);

  tabs[2].name = "renamed tab";
  manager.refresh();
  assert.equal(visibilityRequests.length, 1);
  assert.equal(refreshes, 1);

  manager.activeTab = tabs[2];
  manager.refresh();
  assert.equal(visibilityRequests.length, 2);
  assert.equal(visibilityRequests[1], manager.tabElements.get("2").element);

  manager.activeTab = tabs[0];
  manager.refresh();
  assert.equal(visibilityRequests.length, 3);
  assert.equal(visibilityRequests[2], firstElement);
});

test("TabManager rechecks active-tab visibility after preceding tabs are removed", () => {
  const ul = new FakeElement("ul");
  const visibilityRequests = [];
  const TabManager = loadGlobal(
    "src/js/manager/TabManager.js",
    "tabManager",
    {
      TAB_TYPES: { FILE: "file", SETTINGS: "settings", PICTURE: "picture", MARKDOWN: "markdown" },
      getElement: (selector) => selector === ".file-manager .files-ul" ? ul : null,
      document: { createElement: (tagName) => new FakeElement(tagName) },
    },
  );
  const tabs = [0, 1, 2].map((id) => ({ id, type: "settings", name: `tab-${id}` }));
  const manager = Object.assign(Object.create(TabManager.prototype), {
    editor: {
      api: { setActiveFileContext() {} },
      titleBar: { refresh() {} },
      isOnInit: false,
      isActive: true,
      reset() {},
      reactive() {},
    },
    tabs,
    activeTab: tabs[2],
    tabElements: new Map(),
    lastVisibleTab: tabs[2],
    tabScroller: {
      ensureElementVisible(element) { visibilityRequests.push(element); },
      refresh() {},
    },
  });

  manager.refresh();
  const activeElement = manager.tabElements.get("2").element;
  assert.deepEqual(visibilityRequests, [activeElement]);
  const activeTab = manager.activeTab;
  manager.tabs.shift();
  manager.refresh();

  assert.equal(manager.activeTab, activeTab);
  assert.deepEqual(visibilityRequests, [activeElement, activeElement]);
});

test("closing the last file tab resets the editor without a global refresh", async () => {
  const ul = new FakeElement("ul");
  const calls = { contexts: [], titles: 0, resets: 0, mainContent: 0, refreshAll: 0, closed: 0 };
  const getElement = (selector) => selector === ".file-manager .files-ul" ? ul : null;
  const document = { createElement: (tagName) => new FakeElement(tagName), addEventListener() {} };
  const Events = loadGlobal("src/js/core/Event.js", "Events", { document, window: {} });
  const TabManager = loadGlobal("src/js/manager/TabManager.js", "tabManager", {
    TAB_TYPES: { FILE: "file", SETTINGS: "settings", PICTURE: "picture", MARKDOWN: "markdown" },
    Events,
    getElement,
    document,
  });
  const editor = {
    isOnInit: false,
    isActive: true,
    api: { setActiveFileContext(active) { calls.contexts.push(active); } },
    titleBar: { refresh() { calls.titles++; } },
    bottomBar: { refresh() {} },
    statesManager: { save() {} },
    fileLoader: { async cancelLoading() {} },
    highlightController: { async closeFile() { calls.closed++; }, closeAllFiles() {} },
    fileExplorer: { activeFilePath: "/project/last.js" },
    searchController: { close() {} },
    emptyMenu: { refresh() {}, show() {} },
    lineController: { hide() {} },
    reset() { calls.resets++; },
    refreshMainContent() { calls.mainContent++; },
    refreshAll() { calls.refreshAll++; },
    setSelected() {},
  };
  editor.events = new Events(editor);
  const manager = new TabManager(editor);
  editor.tabManager = manager;
  const file = {
    id: 1,
    type: "file",
    name: "last.js",
    path: "/project/last.js",
    isSaved: true,
    contentGeneration: 0,
    isVisuallyDirty: () => false,
  };
  manager.tabs = [file];
  manager.activeTab = file;
  manager.refresh();
  calls.contexts.length = 0;
  calls.titles = 0;

  assert.equal(await manager.closeFile(file.id), true);

  assert.deepEqual(manager.tabs, []);
  assert.equal(manager.activeTab, null);
  assert.equal(manager.tabElements.size, 0);
  assert.equal(editor.fileExplorer.activeFilePath, null);
  assert.equal(calls.resets, 1);
  assert.equal(calls.mainContent, 1);
  assert.equal(calls.refreshAll, 0);
  assert.equal(calls.contexts.at(-1), false);
  assert.equal(calls.titles, 1);
  assert.equal(calls.closed, 2);
});

test("closing the last non-file tab clears active tab state through the fast path", async () => {
  const ul = new FakeElement("ul");
  const calls = { contexts: [], titles: 0, resets: 0, mainContent: 0, refreshAll: 0 };
  const getElement = (selector) => selector === ".file-manager .files-ul" ? ul : null;
  const document = { createElement: (tagName) => new FakeElement(tagName), addEventListener() {} };
  const Events = loadGlobal("src/js/core/Event.js", "Events", { document, window: {} });
  const TabManager = loadGlobal("src/js/manager/TabManager.js", "tabManager", {
    TAB_TYPES: { FILE: "file", SETTINGS: "settings", PICTURE: "picture", MARKDOWN: "markdown" },
    Events,
    getElement,
    document,
  });
  const editor = {
    isOnInit: false,
    isActive: true,
    api: { setActiveFileContext(active) { calls.contexts.push(active); } },
    titleBar: { refresh() { calls.titles++; } },
    bottomBar: { refresh() {} },
    statesManager: { save() {} },
    highlightController: { closeAllFiles() {} },
    fileExplorer: { activeFilePath: null },
    searchController: { close() {} },
    emptyMenu: { refresh() {}, show() {} },
    lineController: { hide() {} },
    reset() { calls.resets++; },
    refreshMainContent() { calls.mainContent++; },
    refreshAll() { calls.refreshAll++; },
    setSelected() {},
  };
  editor.events = new Events(editor);
  const manager = new TabManager(editor);
  editor.tabManager = manager;
  const settingsTab = { id: 1, type: "settings", name: "Settings" };
  manager.tabs = [settingsTab];
  manager.activeTab = settingsTab;
  manager.refresh();
  calls.contexts.length = 0;
  calls.titles = 0;

  assert.equal(await manager.closeTab(settingsTab), true);

  assert.deepEqual(manager.tabs, []);
  assert.equal(manager.activeTab, null);
  assert.equal(manager.tabElements.size, 0);
  assert.equal(calls.resets, 1);
  assert.equal(calls.mainContent, 1);
  assert.equal(calls.refreshAll, 0);
  assert.equal(calls.contexts.at(-1), false);
  assert.equal(calls.titles, 1);
});
