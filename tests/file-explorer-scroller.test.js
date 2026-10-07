const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const { FastDOMNode, loadGlobal } = require("./helpers/runtime");

const FileExplorerScroller = loadGlobal(
  "src/js/scrollers/FileExplorer.Scroller.js", "FileExplorerScroller",
  { ResizeObserver: undefined },
);

function fixture(height, total = 10000) {
  const frames = [];
  let transformWrites = 0;
  const layerStyle = { value: "" };
  Object.defineProperty(layerStyle, "transform", {
    get() { return this.value; },
    set(value) { transformWrites++; this.value = value; },
  });
  const layer = { style: layerStyle };
  const viewport = { addEventListener() {}, removeEventListener() {} };
  const rendered = [];
  const explorer = {
    constructor: { ROW_HEIGHT: 22 },
    visibleRows: Array.from({ length: total }, (_, index) => ({ file: { path: String(index) }, depth: 0 })),
    renderVirtualRows(start, count) { rendered.push({ start, count }); },
  };
  const editor = {
    sidebarManager: {},
    domManager: {
      fastNodes: new WeakMap(),
      wrapFastNode(node) {
        if (!node?.style) return null;
        let fast = this.fastNodes.get(node);
        if (!fast) {
          fast = new FastDOMNode(node);
          this.fastNodes.set(node, fast);
        }
        return fast;
      },
      getElementMetrics() { return { clientHeight: height }; },
      requestFrame(callback) { frames.push(callback); return frames.length; },
    },
  };
  const scroller = new FileExplorerScroller(editor, explorer);
  scroller.attach(viewport, layer);
  scroller.needsMeasure = true;
  const flush = () => { while (frames.length) frames.shift()(); };
  scroller.update();
  return { scroller, explorer, layer, rendered, flush, transformWrites: () => transformWrites, setHeight(value) { height = value; } };
}

test("render window follows viewport height, including a fractional row", () => {
  for (const [height, visible, rendered] of [[220, 10, 11], [440, 20, 21], [880, 40, 41], [1320, 60, 61]]) {
    const item = fixture(height, 20000);
    assert.equal(item.scroller.maxViewRows, visible);
    assert.equal(item.scroller.renderedRowCount, rendered);
    assert.deepEqual(item.rendered.at(-1), { start: 0, count: rendered });
  }
});

test("scroll ratio, pixel fraction, collapse clamp and resize preserve a valid window", () => {
  const item = fixture(440, 10000);
  item.scroller.setScrollTop(33);
  item.flush();
  assert.equal(item.scroller.startIndex, 1);
  assert.equal(item.scroller.offsetY, 11);
  assert.equal(item.layer.style.transform, "translate3d(0, -11px, 0)");
  const writesAfterScroll = item.transformWrites();
  item.scroller.update();
  assert.equal(item.transformWrites(), writesAfterScroll);
  item.scroller.setScrollRatio(0.5);
  item.flush();
  assert.ok(item.scroller.startIndex > 1 && item.scroller.startIndex < 9980);
  item.scroller.setScrollRatio(1);
  item.flush();
  assert.equal(item.scroller.startIndex, 9980);
  assert.equal(item.rendered.at(-1).count, 20);
  item.explorer.visibleRows.length = 3;
  item.scroller.invalidateRows();
  item.flush();
  assert.equal(item.scroller.startIndex, 0);
  assert.equal(item.scroller.scrollTop, 0);
  assert.equal(item.rendered.at(-1).count, 3);
  item.explorer.visibleRows.length = 10000;
  item.setHeight(880);
  item.scroller.refresh();
  item.flush();
  assert.equal(item.scroller.renderedRowCount, 41);
  item.setHeight(450);
  item.scroller.refresh();
  item.flush();
  item.scroller.setScrollRatio(1);
  item.flush();
  assert.equal(item.scroller.startIndex, 9979);
  assert.equal(item.scroller.offsetY, 12);
  assert.equal(item.rendered.at(-1).count, 21);
});

test("flattened tree excludes closed descendants and collapsed project", () => {
  const FileExplorer = loadGlobal("src/js/sidebar/FileExplorer.Sidebar.js", "FileExplorer", {
    Sidebar: class {}, FileOperations: class {}, window: { api: {} },
  });
  const explorer = Object.create(FileExplorer.prototype);
  explorer.rootPath = "/root";
  explorer.projectExpanded = true;
  explorer.files = [
    { name: "src", type: "folder", expanded: true, children: [
      { name: "js", type: "folder", expanded: true, children: [
        { name: "a.js", type: "file" }, { name: "b.js", type: "file" },
      ] },
      { name: "css", type: "folder", expanded: false, children: [
        { name: "hidden.css", type: "file" },
      ] },
    ] },
    { name: "README", type: "file" },
  ];
  assert.deepEqual(Array.from(explorer.rebuildVisibleRows(), row => [row.file.name, row.depth]), [
    ["src", 0], ["js", 1], ["a.js", 2], ["b.js", 2], ["css", 1], ["README", 0],
  ]);
  explorer.projectExpanded = false;
  assert.equal(explorer.rebuildVisibleRows().length, 0);
});

test("row height remains synchronized with CSS", () => {
  const css = fs.readFileSync("src/css/sidebar/fileExplorer.css", "utf8");
  assert.match(css, /--file-explorer-row-height:\s*22px/);
});

test("File Explorer keeps one shell, viewport, layer and delegated listener set", async () => {
  const created = [];
  class Element {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.dataset = {};
      this.style = {};
      this.listeners = new Map();
      this.attributes = new Map();
      this.replaceChildrenCount = 0;
      this.classList = {
        values: new Set(),
        add: (...values) => values.forEach((value) => this.classList.values.add(value)),
        remove: (...values) => values.forEach((value) => this.classList.values.delete(value)),
        contains: (value) => this.classList.values.has(value),
        toggle: (value, force) => {
          const enabled = force === undefined ? !this.classList.values.has(value) : force;
          if (enabled) this.classList.values.add(value);
          else this.classList.values.delete(value);
          return enabled;
        },
      };
      created.push(this);
    }
    set className(value) { this._className = value; }
    get className() { return this._className || ""; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    appendChild(child) {
      if (child.parentNode) child.parentNode.children.splice(child.parentNode.children.indexOf(child), 1);
      this.children.push(child);
      child.parentNode = this;
      return child;
    }
    replaceChildren(...children) {
      this.replaceChildrenCount += 1;
      for (const child of this.children) child.parentNode = null;
      this.children = [];
      for (const child of children) this.appendChild(child);
    }
    addEventListener(type, listener) {
      const handlers = this.listeners.get(type) || [];
      handlers.push(listener);
      this.listeners.set(type, handlers);
    }
  }
  const document = { createElement: (tagName) => new Element(tagName) };
  const NCEPath = loadGlobal("src/js/core/Path.js", "NCEPath");
  const FileExplorer = loadGlobal("src/js/sidebar/FileExplorer.Sidebar.js", "FileExplorer", {
    Sidebar: class {}, FileOperations: class {}, NCEPath, document,
    window: { api: {} },
  });
  const explorer = Object.create(FileExplorer.prototype);
  const host = new Element("menu");
  const virtualCalls = [];
  Object.assign(explorer, {
    activeFilePath: null,
    projectName: "project",
    projectExpanded: true,
    files: [{
      name: "src", type: "folder", path: "/project/src", expanded: false,
      children: [{ name: "a.js", type: "file", path: "/project/src/a.js" }],
    }],
    rootPath: "/project",
    pendingScrollTop: 0,
    isOpen: true,
    element: host,
    virtualScroller: {
      scrollTop: 0,
      attach(viewport, layer) { virtualCalls.push(["attach", viewport, layer]); },
      invalidateRows() { virtualCalls.push(["invalidate"]); },
    },
    editor: {
      tabManager: { getFileByPath: () => true },
      domManager: { wrapFastNode: (node) => ({ node }) },
      contextMenuManager: { openContextMenu() {} },
    },
  });

  explorer.refresh();
  const shell = explorer.shell;
  const viewport = explorer.treeViewport;
  const layer = explorer.treeLayer;
  const header = explorer.projectHeader;
  const button = explorer.openFolderButton;
  const nodeCount = created.length;
  assert.equal(nodeCount - 1, 10, "the Explorer shell is built from ten DOM nodes");
  const listenerCounts = [
    header.listeners.get("click").length,
    header.listeners.get("contextmenu").length,
    viewport.listeners.get("click").length,
    viewport.listeners.get("contextmenu").length,
    button.listeners.get("click").length,
  ];
  assert.equal(host.children[0], shell);
  assert.deepEqual(listenerCounts, [1, 1, 1, 2, 1]);

  header.listeners.get("click")[0]();
  assert.equal(explorer.treeViewport, viewport);
  assert.equal(viewport.hidden, true);
  header.listeners.get("click")[0]();
  await explorer.toggleFolder("/project/src");
  assert.equal(explorer.visibleRows.length, 2);

  explorer.files[0].name = "renamed";
  explorer.refresh();
  explorer.files.push({ name: "created.js", type: "file", path: "/project/created.js" });
  explorer.refresh();
  explorer.files.pop();
  explorer.refresh();
  explorer.rootPath = "/next";
  explorer.projectName = "next";
  explorer.files = [];
  explorer.refresh();
  assert.equal(explorer.treeEmptyMessage.textContent, "Folder empty");
  explorer.rootPath = "";
  explorer.projectName = "";
  explorer.refresh();
  assert.equal(explorer.treeEmptyMessage.textContent, "You have not yet opened a folder.");

  assert.equal(explorer.shell, shell);
  assert.equal(explorer.treeViewport, viewport);
  assert.equal(explorer.treeLayer, layer);
  assert.equal(host.children[0], shell);
  assert.equal(host.replaceChildrenCount, 1);
  assert.equal(created.length, nodeCount);
  assert.deepEqual([
    header.listeners.get("click").length,
    header.listeners.get("contextmenu").length,
    viewport.listeners.get("click").length,
    viewport.listeners.get("contextmenu").length,
    button.listeners.get("click").length,
  ], listenerCounts);
  assert.ok(virtualCalls.filter(([name]) => name === "invalidate").length >= 7);
});

test("SidebarManager does not replace an unchanged File Explorer shell", () => {
  class Node {}
  const SidebarManager = loadGlobal(
    "src/js/manager/SidebarManager.js",
    "SidebarManager",
    { Node, USERCONFIG_SIDEBAR_MENUS: [] },
  );
  const content = new Node();
  const container = {
    classList: { toggle() {} },
    childNodes: [],
    firstChild: null,
    replaceChildrenCount: 0,
    replaceChildren(node) {
      this.replaceChildrenCount += 1;
      if (this.firstChild) this.firstChild.parentNode = null;
      this.firstChild = node;
      this.childNodes = [node];
      node.parentNode = this;
    },
  };
  const manager = Object.create(SidebarManager.prototype);
  Object.assign(manager, {
    leftMenuContainer: container,
    leftScroller: null,
    editor: { fileExplorer: { virtualScroller: { suspend() {}, attach() {}, resume() {} } } },
  });
  let renders = 0;
  const menu = {
    id: "file-explorer",
    position: "left",
    render() {
      renders += 1;
      return content;
    },
  };
  manager.renderMenuContent(menu);
  manager.renderMenuContent(menu);
  assert.equal(renders, 2);
  assert.equal(container.replaceChildrenCount, 1);
  assert.equal(container.firstChild, content);
});

test("twenty thousand visible files mount only viewport rows", () => {
  const element = () => {
    const node = {
      nodeType: 1,
      children: [],
      dataset: {},
      style: { setProperty(name, value) { this[name] = String(value); }, removeProperty(name) { delete this[name]; } },
      classList: {
        values: new Set(),
        add(name) { this.values.add(name); },
        remove(name) { this.values.delete(name); },
        [Symbol.iterator]() { return this.values[Symbol.iterator](); },
      },
      _className: "",
      appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
      replaceChildren(...children) {
        this.children = children.flatMap((child) => child?.nodeType === 11 ? child.children : [child]);
      },
      setAttribute(name, value) { this.attributes.set(name, value); },
      removeAttribute(name) { this.attributes.delete(name); },
      attributes: new Map(),
      firstChild: null,
    };
    Object.defineProperty(node, "className", {
      get() { return this._className; },
      set(value) {
        this._className = value;
        this.classList.values = new Set(String(value).split(/\s+/).filter(Boolean));
      },
    });
    Object.defineProperty(node, "firstChild", { get() { return this.children[0] || null; } });
    return node;
  };
  const fastNodeCache = new WeakMap();
  const wrapFastNode = (node) => {
    let fast = fastNodeCache.get(node);
    if (!fast) { fast = new FastDOMNode(node); fastNodeCache.set(node, fast); }
    return fast;
  };
  const FileExplorer = loadGlobal("src/js/sidebar/FileExplorer.Sidebar.js", "FileExplorer", {
    Sidebar: class {}, FileOperations: class {}, window: { api: {} },
    document: { createElement: element, createDocumentFragment() { const fragment = element(); fragment.nodeType = 11; return fragment; } },
    FastDOMNode,
    USERCONFIG_FILE_ICONS: { default: "icon" },
  });
  const explorer = Object.create(FileExplorer.prototype);
  explorer.activeFilePath = null;
  explorer.treeLayer = element();
  explorer.treeLayerFast = wrapFastNode(explorer.treeLayer);
  explorer.editor = { domManager: {
    createFastElement(tagName) { return new FastDOMNode(element(tagName)); },
    wrapFastNode,
    createElement: element,
    createFragment() { const fragment = element(); fragment.nodeType = 11; return fragment; },
    replaceChildren(parent, fragment) { parent.replaceChildren(fragment); },
  } };
  explorer.visibleRows = Array.from({ length: 20000 }, (_, i) => ({
    file: { name: `${i}.txt`, type: "file", path: `/root/${i}.txt` }, depth: 0,
  }));
  const viewport = { addEventListener() {}, removeEventListener() {} };
  let height = 440;
  const frames = [];
  const fastNodes = new WeakMap();
  const domManager = {
    getElementMetrics: () => ({ clientHeight: height }),
    requestFrame(callback) { frames.push(callback); return frames.length; },
    wrapFastNode(node) {
      let fast = fastNodes.get(node);
      if (!fast) { fast = new FastDOMNode(node); fastNodes.set(node, fast); }
      return fast;
    },
  };
  const scroller = new FileExplorerScroller({
    sidebarManager: {},
    domManager,
  }, explorer);
  scroller.attach(viewport, explorer.treeLayer);
  scroller.needsMeasure = true;
  scroller.update();
  assert.equal(explorer.treeLayer.children.length, 21);
  height = 1320;
  scroller.needsMeasure = true;
  scroller.update();
  assert.equal(explorer.treeLayer.children.length, 61);
});

test("left scroll ownership switches between Explorer and Search", () => {
  class Node {}
  const SidebarManager = loadGlobal("src/js/manager/SidebarManager.js", "SidebarManager", { Node });
  const calls = [];
  const generic = { suspend() { calls.push("generic suspend"); }, resume() { calls.push("generic resume"); } };
  const virtual = {
    attach() { calls.push("virtual attach"); },
    resume() { calls.push("virtual resume"); },
    suspend() { calls.push("virtual suspend"); },
  };
  const container = {
    classList: { toggle() {} },
    replaceChildren() {},
    scrollTop: 100,
  };
  const manager = Object.create(SidebarManager.prototype);
  Object.assign(manager, {
    leftMenuContainer: container, leftScroller: generic,
    editor: { fileExplorer: { virtualScroller: virtual, treeViewport: {}, treeLayer: {} } },
  });
  manager.renderMenuContent({ position: "left", id: "file-explorer", render: () => new Node() });
  assert.deepEqual(calls, ["generic suspend", "virtual attach", "virtual resume"]);
  assert.equal(container.scrollTop, 0);
  calls.length = 0;
  manager.renderMenuContent({ position: "left", id: "search", render: () => new Node() });
  assert.deepEqual(calls, ["virtual suspend", "generic resume"]);
});

test("active file updates mounted rows without rebuilding the sidebar", () => {
  const FileExplorer = loadGlobal("src/js/sidebar/FileExplorer.Sidebar.js", "FileExplorer", {
    Sidebar: class {}, FileOperations: class {}, window: { api: {} },
  });
  const classes = () => ({ values: new Set(), add(value) { this.values.add(value); }, remove(value) { this.values.delete(value); } });
  const rows = [
    { dataset: { path: "/root/old" }, classList: classes(), style: {} },
    { dataset: { path: "/root/new" }, classList: classes(), style: {} },
  ];
  rows[0].classList.add("active-file");
  const explorer = Object.create(FileExplorer.prototype);
  explorer.rootPath = "/root";
  explorer.activeFilePath = "/root/old";
  explorer.treeLayer = {};
  explorer.editor = { domManager: {
    getElements: () => rows,
    wrapFastNode(item) {
      return { toggleClass(name, enabled) { enabled ? item.classList.add(name) : item.classList.remove(name); } };
    },
  } };
  explorer.refresh = () => assert.fail("full refresh called");
  explorer.setActiveFile("/root/new");
  assert.equal(rows[0].classList.values.has("active-file"), false);
  assert.equal(rows[1].classList.values.has("active-file"), true);
});

test("workspace pixel scroll restores after the viewport is measured", () => {
  const FileExplorer = loadGlobal("src/js/sidebar/FileExplorer.Sidebar.js", "FileExplorer", {
    Sidebar: class {}, FileOperations: class {}, window: { api: {} },
  });
  const item = fixture(440);
  const explorer = Object.create(FileExplorer.prototype);
  explorer.virtualScroller = item.scroller;
  explorer.restoreScrollState({ scrollTop: 1234 });
  item.flush();
  assert.equal(item.scroller.startIndex, 56);
  assert.equal(item.scroller.offsetY, 2);
  assert.equal(explorer.pendingScrollTop, 1234);
});
