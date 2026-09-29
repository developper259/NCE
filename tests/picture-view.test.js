const test = require("node:test");
const assert = require("node:assert/strict");
const { loadGlobal } = require("./helpers/runtime");

const NCEPath = loadGlobal("src/js/core/Path.js", "NCEPath");
const revokedUrls = [];
let nextUrl = 0;
const objectURLApi = {
  createObjectURL: () => `blob:test-${++nextUrl}`,
  revokeObjectURL: (url) => revokedUrls.push(url),
};
const PictureViewScroller = loadGlobal(
  "src/js/scrollers/PictureView.Scroller.js",
  "PictureViewScroller",
);
const PictureView = loadGlobal("src/js/view/PictureView.js", "PictureView", {
  NCEPath,
  URL: objectURLApi,
  Blob,
  TAB_TYPES: { PICTURE: "picture" },
  PictureViewScroller,
});

test("raster routing is case insensitive and leaves SVG as text", () => {
  for (const file of ["foo.png", "IMAGE.PNG", "photo.JpEg", "icon.ico", "photo.webp", "photo.gif", "photo.bmp"])
    assert.equal(PictureView.isSupportedPath(file), true, file);
  for (const file of ["icon.svg", "program.exe", "no-extension"])
    assert.equal(PictureView.isSupportedPath(file), false, file);
});

test("PictureView ignores stale loads and revokes replaced object URLs", async () => {
  const listeners = new Map();
  const node = () => ({
    hidden: false, textContent: "", dataset: {}, style: {}, classList: { toggle() {} },
    addEventListener(name, fn) { listeners.set(`${this.key || "node"}:${name}`, fn); },
    removeAttribute() {}, querySelector() { return null; },
  });
  const host = node();
  const image = Object.assign(node(), { key: "image", naturalWidth: 120, naturalHeight: 60 });
  const status = node(), viewport = node();
  const map = new Map([
    [".picture-view-image", image], [".picture-view-status", status],
    [".picture-view-viewport", viewport],
  ]);
  host.querySelector = (selector) => map.get(selector) || null;
  const requests = new Map();
  const editor = {
    domManager: { getElement: () => host },
    api: { readImageFile: (path) => new Promise((resolve) => requests.set(path, resolve)) },
    tabManager: { activeTab: null },
  };
  revokedUrls.length = 0;
  try {
    const view = new PictureView(editor);
    const a = view.load("a.png");
    const b = view.load("b.png");
    requests.get("b.png")({ success: true, mimeType: "image/png", data: new Uint8Array([1]) });
    await b;
    const urlB = view.objectUrl;
    requests.get("a.png")({ success: true, mimeType: "image/png", data: new Uint8Array([2]) });
    await a;
    assert.equal(view.objectUrl, urlB);
    assert.equal(image.src, urlB);
    const load = listeners.get("image:load");
    load();
    assert.equal(status.dataset.state, "loaded");
    const c = view.load("c.png");
    assert.ok(revokedUrls.includes(urlB));
    requests.get("c.png")({ success: false, code: "SOURCE_NOT_FOUND" });
    await c;
    view.clear();
    assert.equal(view.objectUrl, null);
  } finally {
    // URLs are test-local and do not alter the process global.
  }
});

test("PictureView creates vertical and horizontal NCE scrollers only for overflow", () => {
  const image = { style: {}, classList: { toggle() {} }, addEventListener() {}, removeAttribute() {} };
  const status = { hidden: true, dataset: {}, textContent: "" };
  const viewport = {
    clientHeight: 100, clientWidth: 100, scrollHeight: 120, scrollWidth: 160,
    scrollTop: 10, scrollLeft: 30, addEventListener() {}, querySelector: () => image,
  };
  const host = {
    hidden: true,
    querySelector(selector) {
      return {
        ".picture-view-image": image,
        ".picture-view-status": status,
        ".picture-view-viewport": viewport,
      }[selector] || null;
    },
  };
  const instances = [];
  const editor = {
    domManager: { getElement: () => host }, api: {}, tabManager: { activeTab: null },
    scrollerManager: {
      VERTICAL_TYPE: 0, HORIZONTAL_TYPE: 1,
      createScroller(parent, type) {
        const scroller = {
          parent, type, setScrollRatio(value) { this.scrollRatio = value; },
          refreshMetrics() {}, refresh() {},
        };
        instances.push(scroller);
        return scroller;
      },
      addScroller() {},
    },
  };
  const view = new PictureView(editor);
  assert.equal(instances.length, 2);
  assert.equal(instances[0].parent, host);
  view.scroller.setZoomed(true);
  assert.equal(instances[0].calcIsActive(), true);
  assert.equal(instances[1].calcIsActive(), true);
  assert.ok(instances[0].calculProp() < 100);
  instances[0].onScroll(1);
  instances[1].onScroll(1);
  assert.equal(view.viewport.scrollTop, 20);
  assert.equal(view.viewport.scrollLeft, 60);
  viewport.scrollHeight = viewport.clientHeight;
  viewport.scrollWidth = viewport.clientWidth;
  view.scroller.refresh();
  assert.equal(instances[0].calcIsActive(), false);
  assert.equal(instances[1].calcIsActive(), false);
  view.zoom = 300;
  viewport.scrollLeft = 40;
  viewport.scrollTop = 25;
  view.clear();
  assert.equal(view.zoom, "fit");
  assert.equal(viewport.scrollLeft, 0);
  assert.equal(viewport.scrollTop, 0);
  assert.equal(instances[0].calcIsActive(), false);
  assert.equal(instances[1].calcIsActive(), false);
});

test("Ctrl-wheel zoom changes scale gently while anchoring the image at the pointer", () => {
  const viewport = {
    clientHeight: 100, clientWidth: 100, scrollTop: 0, scrollLeft: 0,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    addEventListener() {},
  };
  const image = {
    naturalWidth: 200, naturalHeight: 100, style: { width: "auto" },
    classList: { toggle() {} }, addEventListener() {}, removeAttribute() {},
    getBoundingClientRect() {
      const width = this.style.width === "auto" ? 100 : Number.parseFloat(this.style.width);
      const height = width / 2;
      return {
        left: width <= 100 ? (100 - width) / 2 : -viewport.scrollLeft,
        top: height <= 100 ? (100 - height) / 2 : -viewport.scrollTop,
        width, height,
      };
    },
  };
  Object.defineProperty(viewport, "scrollWidth", { get: () => Math.max(100, image.getBoundingClientRect().width) });
  Object.defineProperty(viewport, "scrollHeight", { get: () => Math.max(100, image.getBoundingClientRect().height) });
  const status = { hidden: true, dataset: {}, textContent: "" };
  const content = { classList: { toggle(name, enabled) { this[name] = enabled; } } };
  const host = { querySelector: (selector) => ({
    ".picture-view-image": image,
    ".picture-view-status": status,
    ".picture-view-viewport": viewport,
    ".picture-view-content": content,
  }[selector] || null) };
  const view = new PictureView({ domManager: { getElement: () => host }, tabManager: { activeTab: null } });
  view.zoomAtPoint(-1, 75, 50);
  assert.ok(view.zoom > 50 && view.zoom < 51);
  view.zoom = "fit";
  view.applyZoom();
  view.zoomAtPoint(-100, 75, 50);
  assert.ok(view.zoom > 90 && view.zoom < 92);
  assert.equal(content.classList.zoomed, true);
  const imageRect = image.getBoundingClientRect();
  assert.ok(Math.abs(imageRect.left + imageRect.width * 0.75 - 75) < 0.01);
  assert.ok(Math.abs(imageRect.top + imageRect.height * 0.5 - 50) < 0.01);
  const firstZoom = view.zoom;
  view.zoomAtPoint(20, 75, 50);
  assert.ok(view.zoom < firstZoom && firstZoom - view.zoom < 20);
  view.zoomAtPoint(-10000, 75, 50);
  assert.equal(view.zoom, PictureView.MAX_ZOOM);
  const maxWidth = image.style.width;
  view.zoomAtPoint(-500, 75, 50);
  assert.equal(view.zoom, PictureView.MAX_ZOOM);
  assert.equal(image.style.width, maxWidth);
  view.zoomAtPoint(10000, 75, 50);
  assert.equal(view.zoom, "fit");
});

test("TabManager routes supported paths to a deduplicated picture tab outside files", async () => {
  const TabScript = require("node:fs").readFileSync(require("node:path").join(__dirname, "../src/js/types/Tab.js"), "utf8");
  const TabContext = { NCEPath, LineNode: class {}, console };
  const vm = require("node:vm");
  vm.createContext(TabContext);
  vm.runInContext(`${TabScript}; this.result = { TAB_TYPES, PictureTab, FileNode };`, TabContext);
  const { TAB_TYPES, PictureTab, FileNode } = TabContext.result;
  const TabManager = loadGlobal("src/js/manager/TabManager.js", "tabManager", {
    TAB_TYPES, PictureTab, FileNode, PictureView, NCEPath, Events: {}, getElement: () => null,
  });
  const editor = {
    isOnInit: true,
    fileExplorer: { activeFilePath: null, setActiveFile(path) { this.activeFilePath = path; }, fileOperations: { async pathStatus() { return { exists: true, isDirectory: false, size: 1, mtimeMs: 2 }; } } },
    searchController: { close() {} }, refreshMainContent() {},
  };
  const manager = new TabManager(editor);
  const first = await manager.openFileWithPath("/project/logo.PNG");
  const second = await manager.openFileWithPath("\\project\\logo.PNG");
  assert.equal(first, second);
  assert.equal(first.type, TAB_TYPES.PICTURE);
  assert.equal(manager.activeTab, first);
  assert.equal(manager.activeFile, null);
  assert.equal(Array.from(manager.files).length, 0);
  assert.equal(manager.tabs.length, 1);
  assert.equal(PictureView.isSupportedPath("/project/vector.svg"), false);
});
