const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { FastDOMNode, loadGlobal } = require("./helpers/runtime");

const rendererScripts = JSON.parse(fs.readFileSync(
  "src/js/main/renderer-scripts.json",
  "utf8",
));

class FakeResizeObserver {
  constructor(callback) { this.callback = callback; this.targets = new Set(); }
  observe(target) { this.targets.add(target); }
  unobserve(target) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  trigger() { this.callback(); }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.style = {};
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.disabled = false;
    this.hidden = false;
    this.value = "";
    this.type = "";
    this._className = "";
    this._textContent = "";
    this.classList = {
      add: (...names) => {
        const classes = new Set(this._className.split(/\s+/).filter(Boolean));
        for (const name of names) classes.add(name);
        this.className = [...classes].join(" ");
      },
      remove: (...names) => {
        const classes = new Set(this._className.split(/\s+/).filter(Boolean));
        for (const name of names) classes.delete(name);
        this.className = [...classes].join(" ");
      },
      contains: (name) => this._className.split(/\s+/).includes(name),
    };
  }

  get className() { return this._className; }
  set className(value) { this._className = String(value || ""); }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }

  append(...children) { for (const child of children) this.appendChild(child); }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, nextChild) {
    if (child === nextChild) return child;
    child.remove();
    const index = nextChild ? this.children.indexOf(nextChild) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    child.parentElement = this;
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentElement = null;
    return child;
  }
  remove() { this.parentElement?.removeChild(this); }
  contains(node) {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }
  closest(selector) {
    let current = this;
    while (current) {
      if (selector.includes("quick-panel-item") &&
        current.classList.contains("quick-panel-item")) return current;
      current = current.parentElement;
    }
    return null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  removeEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    this.listeners.set(name, listeners.filter((candidate) => candidate !== listener));
  }
  focus() {}
  blur() {}
  setSelectionRange() {}
  set textContent(value) {
    this._textContent = String(value ?? "");
    for (const child of this.children) child.parentElement = null;
    this.children = [];
  }
  get textContent() { return this._textContent; }
}

function makeDocument() {
  const host = new FakeElement("div");
  const created = [];
  return {
    host,
    created,
    activeElement: null,
    querySelector(selector) {
      assert.equal(selector, ".quick-panel-host");
      return host;
    },
    createElement(tagName) {
      const element = new FakeElement(tagName);
      created.push(element);
      return element;
    },
  };
}

function makeEnvironment({ viewportHeight = 360 } = {}) {
  const frames = new Map();
  const scrollers = [];
  let nextFrameId = 1;
  let globalRefreshes = 0;
  let height = viewportHeight;
  const document = makeDocument();
  const window = {
    api: { platform: "linux" },
    getComputedStyle: () => ({
      getPropertyValue: (name) => name === "--quick-panel-row-height" ? "30px" : "",
    }),
  };
  const domManager = {
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
    getElementMetrics(node) {
      return { clientHeight: node.className === "quick-panel-list" ? height : 0 };
    },
    requestFrame(callback) {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame(id) { frames.delete(id); },
  };
  const scrollerManager = {
    VERTICAL_TYPE: 0,
    HORIZONTAL_TYPE: 1,
    scrollers,
    createScroller(parent, type, isBody, options) {
      return {
        parentOBJ: parent,
        type,
        isBody,
        options,
        active: true,
        setActive(value) { this.active = value; },
        setScrollRatio(value) {
          this.scrollRatio = Math.max(0, Math.min(1, value));
          this.targetScrollRatio = this.scrollRatio;
        },
        refreshMetrics() { this.metricsRefreshed = true; },
        refresh() {
          this.setActive(this.calcIsActive());
          this.proportion = this.calculProp();
          this.writeThumbPosition(this.readThumbMetrics());
        },
        readThumbMetrics() { return { maxScroll: 100 }; },
        writeThumbPosition() { this.thumbRatio = this.scrollRatio; },
        destroy() {
          this.wheelTarget?.removeEventListener("wheel", this._onWheel);
        },
      };
    },
    addScroller(scroller) {
      scrollers.push(scroller);
      scroller.wheelTarget?.addEventListener("wheel", scroller._onWheel);
      this.refreshAll();
    },
    refreshAll() {
      globalRefreshes += 1;
      for (const scroller of scrollers) scroller.refresh();
    },
  };
  const editor = {
    domManager,
    scrollerManager,
    output: { focus() {} },
    setSelected() {},
  };
  return {
    editor,
    document,
    window,
    frames,
    scrollers,
    flushFrames() {
      while (frames.size) {
        const [id, callback] = frames.entries().next().value;
        frames.delete(id);
        callback();
      }
    },
    get globalRefreshes() { return globalRefreshes; },
    setViewportHeight(value) { height = value; },
  };
}

const QuickPanelScroller = loadGlobal(
  "src/js/scrollers/QuickPanel.Scroller.js",
  "QuickPanelScroller",
  { ResizeObserver: FakeResizeObserver, window: { getComputedStyle: () => ({ getPropertyValue: () => "30px" }) } },
);

function makeVirtualFixture(options = {}) {
  const env = makeEnvironment(options);
  const viewport = new FakeElement("div");
  viewport.className = "quick-panel-list";
  const layer = new FakeElement("div");
  layer.className = "quick-panel-list-layer";
  viewport.appendChild(layer);
  const quickPanel = {
    hoveredItem: null,
    session: { visibleItems: [], selectedIndex: 0, options: {} },
    clearHoveredItem(row) {
      row.classList.remove("is-hovered");
      if (this.hoveredItem === row) this.hoveredItem = null;
    },
    createVirtualRow(entry, itemCount) {
      const row = new FakeElement(entry.type === "item" ? "button" : "div");
      if (entry.type === "separator") {
        row.className = "quick-panel-separator";
        row.setAttribute("role", "separator");
      } else if (entry.type === "section") {
        row.className = "quick-panel-group-label";
        row.textContent = entry.section;
        row.setAttribute("role", "presentation");
      } else {
        const item = this.session.visibleItems[entry.itemIndex];
        row.className = "quick-panel-item";
        row.dataset.itemIndex = String(entry.itemIndex);
        row.dataset.itemId = String(item.id);
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(entry.itemIndex === this.session.selectedIndex));
        row.setAttribute("aria-posinset", String(entry.itemIndex + 1));
        row.setAttribute("aria-setsize", String(itemCount));
      }
      return row;
    },
  };
  const scroller = new QuickPanelScroller(env.editor, quickPanel);
  scroller.attach(viewport, layer);
  const setItems = (items) => {
    quickPanel.session.visibleItems = items;
    scroller.setItems(items);
  };
  return {
    ...env,
    viewport,
    layer,
    quickPanel,
    scroller,
    setItems,
    rows: () => layer.children.filter((node) => node.classList.contains("quick-panel-item")),
  };
}

test("QuickPanelScroller is registered after Scroller and uses the CSS row height", () => {
  const scrollerIndex = rendererScripts.indexOf("js/types/Scroller.js");
  const quickPanelScrollerIndex = rendererScripts.indexOf("js/scrollers/QuickPanel.Scroller.js");
  const editorIndex = rendererScripts.indexOf("js/main/Editor.js");
  const css = fs.readFileSync("src/css/quickPanel.css", "utf8");

  assert.ok(quickPanelScrollerIndex > scrollerIndex);
  assert.ok(quickPanelScrollerIndex < editorIndex);
  assert.match(css, /--quick-panel-row-height:\s*30px/);
  assert.doesNotMatch(css, /quick-panel-list::-webkit-scrollbar|scrollbar-width/);
});

test("fixed rows virtualize 50,000 results with a small overscanned DOM", () => {
  const fixture = makeVirtualFixture();
  fixture.setItems(Array.from({ length: 50000 }, (_, index) => ({
    id: String(index), label: `Item ${index}`,
  })));
  fixture.scroller.resume();
  fixture.flushFrames();

  assert.equal(fixture.scroller.vScroller.type, fixture.editor.scrollerManager.VERTICAL_TYPE);
  assert.equal(fixture.scroller.rowHeight, 30);
  assert.equal(fixture.scroller.totalVirtualHeight, 50000 * 30);
  assert.equal(fixture.scroller.vScroller.active, true);
  assert.equal(fixture.scroller.endIndex, 12);
  assert.equal(fixture.scroller.renderEnd - fixture.scroller.renderStart, 16);
  assert.equal(fixture.rows().length, 16);

  fixture.scroller.setScrollY(250000);
  fixture.flushFrames();
  assert.equal(fixture.scroller.startIndex, 8333);
  assert.equal(fixture.scroller.renderStart, 8329);
  assert.equal(fixture.layer.style.transform, "translate3d(0, -250000px, 0)");
  assert.ok(fixture.rows().length < 50);

  fixture.scroller.setScrollY(Infinity);
  assert.equal(fixture.scroller.scrollY, 0);
  fixture.scroller.setScrollY(-20);
  assert.equal(fixture.scroller.scrollY, 0);
  fixture.scroller.setScrollY(Number.MAX_SAFE_INTEGER);
  assert.equal(fixture.scroller.scrollY, fixture.scroller.getMaxScrollY());
  fixture.flushFrames();
  assert.equal(fixture.rows().at(-1).dataset.itemIndex, "49999");
  assert.ok(fixture.rows().length < 50);
});

test("short result lists disable the thumb and section decorations use fixed virtual slots", () => {
  const fixture = makeVirtualFixture();
  fixture.setItems([
    { id: "a", label: "A", section: "Recent" },
    { id: "b", label: "B", section: "Recent" },
    { id: "c", label: "C", separatorBefore: true },
  ]);
  fixture.scroller.resume();
  fixture.flushFrames();

  assert.equal(fixture.scroller.entries.length, 5);
  assert.equal(fixture.scroller.totalVirtualHeight, 5 * 30);
  assert.equal(fixture.scroller.vScroller.active, false);
  assert.deepEqual(fixture.layer.children.map((row) => row.className), [
    "quick-panel-group-label",
    "quick-panel-item",
    "quick-panel-item",
    "quick-panel-separator",
    "quick-panel-item",
  ]);
});

test("ensureIndexVisible, wheel deltas, thumb ratios, and resize stay synchronized", () => {
  const fixture = makeVirtualFixture();
  fixture.setItems(Array.from({ length: 100 }, (_, index) => ({ id: `${index}`, label: `${index}` })));
  fixture.scroller.resume();
  fixture.flushFrames();

  assert.equal(fixture.scroller.ensureIndexVisible(5), false);
  assert.equal(fixture.frames.size, 0);
  assert.equal(fixture.scroller.ensureIndexVisible(50), true);
  fixture.flushFrames();
  assert.ok(fixture.scroller.scrollY > 0);
  assert.ok(50 >= fixture.scroller.startIndex && 50 < fixture.scroller.endIndex);

  const wheel = (deltaY, deltaMode = 0) => {
    let prevented = false;
    let stopped = false;
    fixture.scroller.handleWheel({
      deltaX: 0, deltaY, deltaMode, shiftKey: false,
      preventDefault() { prevented = true; },
      stopPropagation() { stopped = true; },
    });
    return { prevented, stopped };
  };
  const beforePixelWheel = fixture.scroller.scrollY;
  assert.deepEqual(wheel(18), { prevented: true, stopped: true });
  fixture.flushFrames();
  assert.equal(fixture.scroller.scrollY, beforePixelWheel + 18);

  const beforeLineWheel = fixture.scroller.scrollY;
  wheel(2, 1);
  fixture.flushFrames();
  assert.equal(fixture.scroller.scrollY, beforeLineWheel + 60);

  const beforePageWheel = fixture.scroller.scrollY;
  wheel(1, 2);
  fixture.flushFrames();
  assert.equal(fixture.scroller.scrollY, beforePageWheel + 360);

  fixture.scroller.vScroller.onScroll(0.5);
  fixture.flushFrames();
  assert.equal(fixture.scroller.scrollY, fixture.scroller.getMaxScrollY() / 2);
  assert.equal(fixture.scroller.vScroller.thumbRatio, 0.5);

  fixture.setViewportHeight(600);
  fixture.scroller.refresh();
  fixture.flushFrames();
  assert.equal(fixture.scroller.viewportHeight, 600);
  assert.equal(fixture.scroller.vScroller.proportion, 20);
  fixture.scroller.setScrollY(Number.MAX_SAFE_INTEGER);
  fixture.flushFrames();
  const bottom = fixture.scroller.scrollY;
  fixture.setViewportHeight(900);
  fixture.scroller.refresh();
  fixture.flushFrames();
  assert.ok(fixture.scroller.scrollY <= bottom);
});

test("QuickPanel keeps its input outside the virtual viewport and navigates large results", async () => {
  const env = makeEnvironment();
  const QuickPanel = loadGlobal("src/js/types/QuickPanel.js", "QuickPanel", {
    document: env.document,
    window: env.window,
    QuickPanelScroller,
  });
  const accepted = [];
  const panel = new QuickPanel(env.editor);

  assert.equal(panel.initialized, false);
  assert.equal(env.document.created.length, 0);
  panel.open({
    id: "large-quick-panel",
    mode: "pick",
    items: Array.from({ length: 50000 }, (_, index) => ({
      id: String(index), label: `Item ${index}`,
    })),
    onAccept: (item) => accepted.push(item),
    transitionDuration: 1,
  });
  await new Promise((resolve) => setImmediate(resolve));
  env.flushFrames();

  const input = panel.input;
  const inputParent = input.parentElement;
  assert.equal(panel.list.contains(input), false);
  assert.equal(inputParent, panel.panel);
  assert.ok(panel.resultsScroller.renderedRows.size < 50);
  assert.ok(panel.listLayer.children.filter((row) => row.className === "quick-panel-item").length < 50);

  panel.handleKeyDown({ key: "End", preventDefault() {}, stopPropagation() {} });
  env.flushFrames();
  assert.equal(panel.session.selectedIndex, 49999);
  assert.equal(panel.resultsScroller.scrollY, panel.resultsScroller.getMaxScrollY());
  const lastRow = panel.listLayer.children.find((row) => row.dataset.itemIndex === "49999");
  assert.equal(lastRow.getAttribute("aria-selected"), "true");
  assert.equal(input.parentElement, inputParent);
  assert.equal(input.style.top || "", "");

  panel.handleKeyDown({ key: "Home", preventDefault() {}, stopPropagation() {} });
  env.flushFrames();
  assert.equal(panel.resultsScroller.scrollY, 0);
  assert.equal(panel.session.selectedIndex, 0);

  panel.input.value = "item 40000";
  panel.session.options.reloadOnInput = false;
  panel.handleInput();
  env.flushFrames();
  assert.equal(panel.session.visibleItems.length, 1);
  assert.equal(panel.resultsScroller.scrollY, 0);
  assert.deepEqual(accepted, []);

  const refreshCount = env.globalRefreshes;
  const row = panel.listLayer.children.find((node) => node.className === "quick-panel-item");
  assert.equal(row.listeners.size, 0);
  panel.handleItemPointerOverEvent({ target: row, relatedTarget: null });
  assert.equal(panel.session.selectedIndex, 0);
  panel.handleItemClick({
    target: row,
    preventDefault() {},
    stopPropagation() {},
  });
  assert.equal(accepted[0].id, "40000");
  assert.equal(input.parentElement, inputParent);
  assert.equal(env.globalRefreshes, refreshCount);
  assert.equal(panel.resultsScroller.active, false);
});

test("QuickPanel close suspends work, reopen resumes it, and explicit renderLimit stays functional", async () => {
  const env = makeEnvironment();
  const QuickPanel = loadGlobal("src/js/types/QuickPanel.js", "QuickPanel", {
    document: env.document,
    window: env.window,
    QuickPanelScroller,
  });
  const panel = new QuickPanel(env.editor);
  const items = Array.from({ length: 100 }, (_, index) => ({ id: `${index}`, label: `${index}` }));
  panel.open({ id: "limited", mode: "pick", items, renderLimit: 3, transitionDuration: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  env.flushFrames();
  assert.equal(panel.session.visibleItems.length, 3);

  panel.close({ restoreFocus: false });
  assert.equal(panel.resultsScroller.active, false);
  assert.equal(env.frames.size, 0);
  panel.open({ id: "reopened", mode: "pick", items, transitionDuration: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  env.flushFrames();
  assert.equal(panel.resultsScroller.active, true);
  assert.equal(panel.resultsScroller.entries.length, 100);
  panel.close({ restoreFocus: false });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(panel.listLayer.children.length, 0);
});
