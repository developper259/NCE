const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

class FakeElement {
  constructor({ clientWidth = 0, scrollWidth = clientWidth } = {}) {
    this.clientWidth = clientWidth;
    this.scrollWidth = scrollWidth;
    this.offsetWidth = clientWidth;
    this.offsetLeft = 0;
    this._scrollLeft = 0;
    this.scrollWrites = [];
    this.children = [];
    this.listeners = new Map();
  }

  get scrollLeft() { return this._scrollLeft; }
  set scrollLeft(value) {
    this.scrollWrites.push(value);
    this._scrollLeft = value;
  }

  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }

  removeEventListener(name) {
    this.listeners.delete(name);
  }

  dispatch(name) {
    this.listeners.get(name)?.({ target: this });
  }
}

class FakeScroller {
  constructor(parent, type, options = {}) {
    this.parentOBJ = parent;
    this.type = type;
    this.options = options;
    this.refreshCount = 0;
    this.refreshMetricsCount = 0;
    this.thumbSyncCount = 0;
    this.thumbWidth = 0;
    this.thumbLeft = 0;
    this.scrollRatio = 0;
    this.targetScrollRatio = 0;
  }

  init() {}

  refreshMetrics() {
    this.refreshMetricsCount++;
    this.scrollerOBJWidth = this.parentOBJ.clientWidth;
  }

  setScrollRatio(ratio) {
    const clamped = Math.max(0, Math.min(Number(ratio) || 0, 1));
    this.scrollRatio = clamped;
    this.targetScrollRatio = clamped;
  }

  syncThumbPosition() {
    this.thumbSyncCount++;
    this.thumbLeft = this.scrollRatio * Math.max(0, this.scrollerOBJWidth - this.thumbWidth);
  }

  refresh() {
    this.refreshCount++;
    this.onBeforeRefresh?.();
    this.active = this.calcIsActive();
    if (!this.active) return;
    this.proportion = this.calculProp();
    this.thumbWidth = Math.max(this.proportion * this.parentOBJ.clientWidth / 100, 20);
    this.syncThumbPosition();
  }
}

function createFixture({ clientWidth = 200, scrollWidth = 500, scrollLeft = 0 } = {}) {
  const container = new FakeElement({ clientWidth });
  const content = new FakeElement({ clientWidth, scrollWidth });
  content.scrollLeft = scrollLeft;
  content.scrollWrites.length = 0;
  const created = [];
  const editor = {
    isOnInit: true,
    domManager: {
      getElement(selector) {
        if (selector === ".file-manager") return container;
        if (selector === ".file-manager .files-ul") return content;
        return null;
      },
      getElementMetrics(element) {
        return {
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          scrollLeft: element.scrollLeft,
        };
      },
    },
    scrollerManager: {
      HORIZONTAL_TYPE: 1,
      createScroller(parent, type, isBody, options) {
        const scroller = new FakeScroller(parent, type, options);
        scroller.isBody = isBody;
        created.push({ parent, type, isBody, options, scroller });
        return scroller;
      },
      addScroller(scroller) { scroller.init(); },
    },
    refreshAllCalls: 0,
    refreshAll() { this.refreshAllCalls++; },
  };
  const TabManagerScroller = loadGlobal(
    "src/js/scrollers/TabManager.Scroller.js",
    "TabManagerScroller",
  );
  const component = new TabManagerScroller(editor, {});
  component.init();
  return { editor, component, container, content, created, scroller: component.hScroller };
}

test("TabManagerScroller is in the renderer manifest and initializes after ScrollerManager", async () => {
  const manifest = JSON.parse(await fs.readFile("src/js/main/renderer-scripts.json", "utf8"));
  const editorSource = await fs.readFile("src/js/main/Editor.js", "utf8");
  const scrollerTypeIndex = manifest.indexOf("js/types/Scroller.js");
  const tabScrollerIndex = manifest.indexOf("js/scrollers/TabManager.Scroller.js");
  const managerIndex = editorSource.indexOf("this.scrollerManager = new ScrollerManager(this)");
  const initIndex = editorSource.indexOf("this.tabManager.initScroller()");

  assert.ok(scrollerTypeIndex >= 0);
  assert.ok(tabScrollerIndex > scrollerTypeIndex);
  assert.ok(managerIndex >= 0 && initIndex > managerIndex);
});

test("TabManagerScroller creates one compact horizontal NCE Scroller on the fixed container", () => {
  const { component, container, content, created } = createFixture();

  assert.equal(created.length, 1);
  assert.equal(created[0].parent, container);
  assert.equal(created[0].type, 1);
  assert.equal(created[0].isBody, false);
  assert.equal(created[0].options.compact, true);
  assert.equal(component.container, container);
  assert.equal(component.content, content);
  assert.equal(component.hScroller.wheelTarget, container);
});

test("Scroller compact mode defaults off and its active thumb appears on hover", () => {
  const Scroller = loadGlobal("src/js/types/Scroller.js", "Scroller");
  const normal = new Scroller({});
  const compact = new Scroller({ scrollerManager: { HORIZONTAL_TYPE: 1, VERTICAL_TYPE: 0 } }, { compact: true });
  assert.equal(normal.compact, false);
  assert.equal(compact.compact, true);

  const classes = new Set();
  const makeNode = () => ({
    style: {},
    listeners: new Map(),
    children: [],
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    removeEventListener(name) { this.listeners.delete(name); },
    appendChild(child) { this.children.push(child); child.parentElement = this; },
  });
  const parent = makeNode();
  let initialized = null;
  const document = {
    createElement: makeNode,
    addEventListener() {},
    removeEventListener() {},
  };
  const editor = {
    scrollerManager: { HORIZONTAL_TYPE: 1, VERTICAL_TYPE: 0 },
    domManager: {
      wrapFastNode(node) {
        return {
          setClassName(value) { node.className = value; },
          toggleClass(name, enabled) {
            if (enabled) classes.add(name);
            else classes.delete(name);
          },
          addClass(name) { classes.add(name); },
          setStyle(name, value) { node.style[name] = value; },
          setOpacity(value) { node.style.opacity = String(value); },
          setProperty(name, value) { node[name] = value; },
          appendChild(child) { node.appendChild(child.domNode || child); },
          setWidth(value) { node.style.width = `${value}px`; },
          setHeight(value) { node.style.height = `${value}px`; },
          setTop(value) { node.style.top = `${value}px`; },
          setLeft(value) { node.style.left = `${value}px`; },
          remove() {},
        };
      },
      getElementMetrics(element) {
        if (element === parent) {
          return { clientWidth: 200, clientHeight: 10, left: 0, top: 0 };
        }
        if (element === initialized?.scrollerOBJ) {
          return { clientWidth: 200, clientHeight: 6, left: 0, top: 0 };
        }
        return { clientWidth: 50, clientHeight: 6, left: 0, top: 0 };
      },
    },
  };
  const DOMScroller = loadGlobal(
    "src/js/types/Scroller.js",
    "Scroller",
    { document },
  );
  initialized = new DOMScroller(editor, { compact: true });
  initialized.parentOBJ = parent;
  initialized.type = editor.scrollerManager.HORIZONTAL_TYPE;
  initialized.calcIsActive = () => true;
  initialized.calculProp = () => 25;

  initialized.init();
  initialized.refreshMetrics();
  initialized.refresh();
  assert.ok(classes.has("page-scroller-compact"));
  assert.ok(!classes.has("page-scroller-inactive"));
  assert.equal(initialized.scrollerOBJ.style.opacity, "0");
  assert.equal(initialized.itemOBJ.listeners.has("mousedown"), true);
  parent.listeners.get("mouseenter")();
  assert.equal(initialized.scrollerOBJ.style.opacity, "1");
});

test("compact CSS reduces the matching orientation and keeps normal scroller sizes", async () => {
  const css = await fs.readFile("src/css/scroller.css", "utf8");
  assert.match(css, /\.page-scroller-vertical\s*\{[^}]*width:\s*10px/s);
  assert.match(css, /\.page-scroller-horizontal\s*\{[^}]*height:\s*10px/s);
  assert.match(css, /\.page-scroller-compact\.page-scroller-vertical\s*\{[^}]*width:\s*6px/s);
  assert.match(css, /\.page-scroller-compact\.page-scroller-horizontal\s*\{[^}]*height:\s*6px/s);
  assert.doesNotMatch(css, /\.page-scroller-compact\.page-scroller-vertical\s*\{[^}]*height:/s);
  assert.doesNotMatch(css, /\.page-scroller-compact\.page-scroller-horizontal\s*\{[^}]*width:/s);
});

test("tab scroller activates only on overflow and calculates the visible width proportion", () => {
  const { component, content, scroller } = createFixture({ clientWidth: 200, scrollWidth: 200 });
  assert.equal(scroller.calcIsActive(), false);
  assert.equal(scroller.calculProp(), 100);

  content.scrollWidth = 500;
  component.refresh();
  assert.equal(scroller.calcIsActive(), true);
  assert.equal(scroller.calculProp(), 40);
});

test("custom thumb movement changes only the tab list scrollLeft", () => {
  const { editor, content, scroller } = createFixture({ clientWidth: 200, scrollWidth: 500 });
  scroller.onScroll(0.5);

  assert.equal(content.scrollLeft, 150);
  assert.deepEqual(content.scrollWrites, [150]);
  assert.equal(editor.refreshAllCalls, 0);
});

test("wheel input over the tab scroller reaches the list through its scroll callback", () => {
  const { editor, component, container, content } = createFixture({
    clientWidth: 200,
    scrollWidth: 500,
  });
  const Scroller = loadGlobal("src/js/types/Scroller.js", "Scroller");
  const wheelScroller = new Scroller(editor);
  Object.assign(wheelScroller, {
    type: editor.scrollerManager.HORIZONTAL_TYPE,
    wheelTarget: container,
    scrollerOBJ: {},
    scrollerOBJWidth: 200,
    itemOBJWidth: 50,
    onScroll: (ratio) => component.applyScrollRatio(ratio),
    scheduleScrollRender() {},
    readThumbMetrics: () => ({ isVertical: false, maxScroll: 150 }),
    writeThumbPosition() {},
  });
  component.hScroller = wheelScroller;
  container.addEventListener("wheel", wheelScroller._onWheel, { passive: false });

  let prevented = false;
  let stopped = false;
  container.listeners.get("wheel")({
    deltaX: 120,
    deltaY: 0,
    shiftKey: false,
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; },
  });

  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(wheelScroller.targetScrollRatio, 0.3);

  wheelScroller.renderScrollFrame();
  assert.equal(content.scrollLeft, 90);
});

test("horizontal thumb dragging applies the pointer offset and clamps both ends", () => {
  const Scroller = loadGlobal("src/js/types/Scroller.js", "Scroller");
  const track = {};
  const editor = {
    scrollerManager: { HORIZONTAL_TYPE: 1, VERTICAL_TYPE: 0 },
    domManager: { getElementMetrics: () => ({ left: 20, top: 30 }) },
  };
  const scroller = new Scroller(editor);
  const scheduled = [];
  Object.assign(scroller, {
    type: editor.scrollerManager.HORIZONTAL_TYPE,
    active: true,
    isDragging: true,
    scrollerOBJ: track,
    scrollerOBJWidth: 100,
    itemOBJWidth: 20,
    dragOffset: 5,
    scheduleScrollRender() { scheduled.push(this.targetScrollRatio); },
  });

  scroller.handleMouseMove({ clientX: 65 });
  assert.equal(scroller.targetScrollRatio, 0.5);
  assert.deepEqual(scheduled, [0.5]);

  scroller.handleMouseMove({ clientX: -100 });
  assert.equal(scroller.targetScrollRatio, 0);
  scroller.handleMouseMove({ clientX: 500 });
  assert.equal(scroller.targetScrollRatio, 1);
  assert.deepEqual(scheduled, [0.5, 0, 1]);
});

test("vertical thumb dragging applies the pointer offset and clamps both ends", () => {
  const Scroller = loadGlobal("src/js/types/Scroller.js", "Scroller");
  const track = {};
  const editor = {
    scrollerManager: { HORIZONTAL_TYPE: 1, VERTICAL_TYPE: 0 },
    domManager: { getElementMetrics: () => ({ left: 20, top: 30 }) },
  };
  const scroller = new Scroller(editor);
  const scheduled = [];
  Object.assign(scroller, {
    type: editor.scrollerManager.VERTICAL_TYPE,
    active: true,
    isDragging: true,
    scrollerOBJ: track,
    scrollerOBJHeight: 100,
    itemOBJHeight: 20,
    dragOffset: 10,
    scheduleScrollRender() { scheduled.push(this.targetScrollRatio); },
  });

  scroller.handleMouseMove({ clientY: 60 });
  assert.equal(scroller.targetScrollRatio, 0.25);
  assert.deepEqual(scheduled, [0.25]);

  scroller.handleMouseMove({ clientY: -100 });
  assert.equal(scroller.targetScrollRatio, 0);
  scroller.handleMouseMove({ clientY: 500 });
  assert.equal(scroller.targetScrollRatio, 1);
  assert.deepEqual(scheduled, [0.25, 0, 1]);
});

test("inactive and non-dragging scrollers ignore pointer movement", () => {
  const Scroller = loadGlobal("src/js/types/Scroller.js", "Scroller");
  const editor = {
    scrollerManager: { HORIZONTAL_TYPE: 1, VERTICAL_TYPE: 0 },
    domManager: { getElementMetrics: () => ({ left: 0, top: 0 }) },
  };
  const scroller = new Scroller(editor);
  let scheduleCount = 0;
  Object.assign(scroller, {
    type: editor.scrollerManager.HORIZONTAL_TYPE,
    scrollerOBJ: {},
    scrollerOBJWidth: 100,
    itemOBJWidth: 20,
    scheduleScrollRender() { scheduleCount++; },
  });

  scroller.isDragging = true;
  scroller.active = false;
  scroller.handleMouseMove({ clientX: 50 });
  scroller.active = true;
  scroller.isDragging = false;
  scroller.handleMouseMove({ clientX: 50 });

  assert.equal(scheduleCount, 0);
  assert.equal(scroller.targetScrollRatio, 0);
});

test("a deterministic thumb drag updates the tab list through its scroll callback", () => {
  const { editor, component, content } = createFixture({ clientWidth: 200, scrollWidth: 500 });
  editor.domManager.getElementMetrics = () => ({ left: 0, top: 0 });
  const Scroller = loadGlobal("src/js/types/Scroller.js", "Scroller");
  const dragScroller = new Scroller(editor);
  Object.assign(dragScroller, {
    type: editor.scrollerManager.HORIZONTAL_TYPE,
    active: true,
    isDragging: true,
    scrollerOBJ: {},
    scrollerOBJWidth: 100,
    itemOBJWidth: 20,
    dragOffset: 10,
    onScroll: (ratio) => component.applyScrollRatio(ratio),
    scheduleScrollRender() {},
    readThumbMetrics: () => ({ isVertical: false, maxScroll: 80 }),
    writeThumbPosition() {},
  });
  component.hScroller = dragScroller;

  dragScroller.handleMouseMove({ clientX: 50 });
  dragScroller.renderScrollFrame();

  assert.equal(dragScroller.scrollRatio, 0.5);
  assert.equal(content.scrollLeft, 150);
});

test("native horizontal scrolling synchronizes ratio and moves the custom thumb", () => {
  const { content, scroller } = createFixture({ clientWidth: 200, scrollWidth: 500 });
  let customScrollCalls = 0;
  scroller.onScroll = () => { customScrollCalls++; };
  content.scrollLeft = 100;
  content.dispatch("scroll");

  assert.equal(scroller.scrollRatio, 1 / 3);
  assert.equal(scroller.thumbLeft, (scroller.scrollerOBJWidth - scroller.thumbWidth) / 3);
  assert.equal(scroller.thumbSyncCount > 0, true);
  assert.equal(customScrollCalls, 0);
});

test("ensuring an offscreen active tab scrolls it into view and syncs the thumb", () => {
  const { component, content, scroller } = createFixture({ clientWidth: 200, scrollWidth: 500 });
  const activeTab = { offsetLeft: 400, offsetWidth: 100 };

  assert.equal(component.ensureElementVisible(activeTab), true);
  assert.equal(content.scrollLeft, 300);
  assert.equal(scroller.scrollRatio, 1);
  assert.equal(scroller.thumbLeft, scroller.scrollerOBJWidth - scroller.thumbWidth);
});

test("an already visible active tab causes no native scroll write", () => {
  const { component, content } = createFixture({ clientWidth: 200, scrollWidth: 500, scrollLeft: 100 });
  const visibleTab = { offsetLeft: 150, offsetWidth: 40 };

  component.ensureElementVisible(visibleTab);

  assert.deepEqual(content.scrollWrites, []);
  assert.equal(content.scrollLeft, 100);
});

test("resizing the tab viewport recalculates the thumb without rebuilding tabs", () => {
  const { component, container, content, scroller } = createFixture({ clientWidth: 100, scrollWidth: 500 });
  const tabs = [{ id: "a" }, { id: "b" }];
  content.children = tabs;

  assert.equal(scroller.proportion, 20);
  container.clientWidth = 200;
  content.clientWidth = 200;
  component.refresh();

  assert.equal(scroller.proportion, 40);
  assert.deepEqual(content.children, tabs);
});

test("resizing preserves native scrollLeft and recalculates its thumb ratio", () => {
  const { component, container, content, scroller } = createFixture({
    clientWidth: 100,
    scrollWidth: 500,
    scrollLeft: 200,
  });
  assert.equal(scroller.scrollRatio, 0.5);

  container.clientWidth = 200;
  content.clientWidth = 200;
  component.refresh();

  assert.equal(content.scrollLeft, 200);
  assert.equal(scroller.scrollRatio, 2 / 3);
  assert.equal(scroller.proportion, 40);
});

test("right sidebar layout resizes the measured tab viewport on the next frame", () => {
  const viewportWidth = 1000;
  const { editor, component, container, content, scroller } = createFixture({
    clientWidth: 952,
    scrollWidth: 1200,
  });
  const frames = [];
  const classes = () => {
    const values = new Set();
    return {
      add(value) { values.add(value); },
      remove(value) { values.delete(value); },
      contains(value) { return values.has(value); },
    };
  };
  const mainSection = { classList: classes() };
  const sidebars = {
    left: { classList: classes() },
    right: { classList: classes() },
  };
  const editorElement = { style: {} };
  const originalGetElement = editor.domManager.getElement.bind(editor.domManager);
  editor.domManager.getElement = (selector) => {
    if (selector === ".main-section") return mainSection;
    if (selector === ".sidebar-left") return sidebars.left;
    if (selector === ".sidebar-right") return sidebars.right;
    return originalGetElement(selector);
  };
  Object.assign(editor.domManager, {
    apply() {},
    calculate() {},
    getSidebarWidth(side) { return side === "left" ? 300 : 250; },
    invalidateSidebarMetrics() {},
    measureElements() {},
  });
  container.style = {};
  editor.editorOBJ = editorElement;
  editor.fileManagerOBJ = container;
  editor.lineController = { resizeWidth() {} };
  editor.sidebarResizer = { updateResizerVisibility() {} };
  editor.tabManager = { tabScroller: component };
  const tabs = [{ id: "first" }, { id: "second" }];
  content.children = tabs;

  const applyLayout = () => {
    const left = Number.parseFloat(container.style.left) || 0;
    const right = Number.parseFloat(container.style.right) || 0;
    const availableWidth = viewportWidth - left - right;
    container.clientWidth = availableWidth;
    content.clientWidth = availableWidth;
  };
  const SidebarManager = loadGlobal(
    "src/js/manager/SidebarManager.js",
    "SidebarManager",
    {
      requestAnimationFrame(callback) {
        frames.push(() => {
          applyLayout();
          callback();
        });
      },
    },
  );
  const manager = Object.assign(Object.create(SidebarManager.prototype), {
    editor,
    leftSidebar: sidebars.left,
    rightSidebar: sidebars.right,
    selectorWidth: 48,
    width: 350,
  });
  editor.sidebarManager = manager;
  const initialRefreshCount = scroller.refreshCount;

  manager.openSidebar("right");
  assert.equal(container.style.right, "250px");
  assert.equal(component.clientWidth, 952);
  assert.equal(scroller.refreshCount, initialRefreshCount);
  frames.shift()();

  assert.equal(content.clientWidth, 702);
  assert.equal(component.clientWidth, 702);
  assert.equal(scroller.scrollerOBJWidth, 702);
  assert.ok(Math.abs(scroller.proportion - 58.5) < 0.001);
  assert.ok(Math.abs(scroller.thumbWidth - 410.67) < 0.01);
  assert.equal(scroller.active, true);
  assert.deepEqual(content.children, tabs);

  manager.closeSidebar("right");
  frames.shift()();

  assert.equal(container.style.right, "0px");
  assert.equal(content.clientWidth, 952);
  assert.equal(component.clientWidth, 952);
  assert.equal(scroller.scrollerOBJWidth, 952);
  assert.ok(Math.abs(scroller.proportion - 79.333) < 0.001);
  assert.ok(Math.abs(scroller.thumbWidth - (952 * 952) / 1200) < 0.01);
  assert.deepEqual(content.children, tabs);
});

test("tab cycling remains implemented independently of horizontal scrolling", async () => {
  const TabManager = loadGlobal("src/js/manager/TabManager.js", "tabManager");
  const tabs = [{ id: 1 }, { id: 2 }];
  const manager = Object.assign(Object.create(TabManager.prototype), {
    tabs,
    activeTab: tabs[0],
    setFocusTab: async function (tab) { this.activeTab = tab; },
  });

  assert.equal(await manager.cycleTab(1), true);
  assert.equal(manager.activeTab, tabs[1]);
  assert.equal(await manager.cycleTab(-1), true);
  assert.equal(manager.activeTab, tabs[0]);
});

test("output keeps its editor offset while generic and vertical scrollers stay unaffected", async () => {
  const css = await fs.readFile("src/css/scroller.css", "utf8");
  const outputSource = await fs.readFile("src/js/scrollers/Output.Scroller.js", "utf8");
  const tabCSS = css.match(/\.editor\s*>\s*\.page-scroller-horizontal\s*\{[^}]*\}/s)?.[0] || "";

  assert.match(css, /\.page-scroller-horizontal\s*\{[^}]*left:\s*0;[^}]*width:\s*100%/s);
  assert.match(tabCSS, /left:\s*var\(--nce-output-x,\s*50px\)/);
  assert.match(tabCSS, /width:\s*calc\(100%\s*-\s*var\(--nce-output-x,\s*50px\)\)/);
  assert.match(outputSource, /createScroller\(\s*this\.editor\.editorOBJ,\s*this\.editor\.scrollerManager\.HORIZONTAL_TYPE,\s*false/s);
  assert.match(css, /\.page-scroller-compact\.page-scroller-vertical\s*\{[^}]*width:\s*6px/s);
  assert.doesNotMatch(css, /^\.page-scroller-vertical\s*\{[^}]*width:\s*6px/sm);
});

test("ScrollerManager accepts compact options and preserves existing three-argument calls", () => {
  const constructions = [];
  class ScrollerStub {
    constructor(editor, options) {
      constructions.push({ editor, options });
    }
  }
  const ScrollerManager = loadGlobal(
    "src/js/manager/ScrollerManager.js",
    "ScrollerManager",
    { Scroller: ScrollerStub },
  );
  const editor = {};
  const manager = new ScrollerManager(editor);
  const parent = {};

  manager.createScroller(parent, manager.HORIZONTAL_TYPE, false, { compact: true });
  manager.createScroller(parent, manager.VERTICAL_TYPE, false);

  assert.equal(constructions.length, 2);
  assert.equal(constructions[0].editor, editor);
  assert.equal(constructions[0].options.compact, true);
  assert.equal(constructions[1].editor, editor);
  assert.deepEqual(Object.keys(constructions[1].options), []);
});
