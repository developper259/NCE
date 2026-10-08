const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { FastDOMNode, loadGlobal, root } = require("./helpers/runtime");

function createElement(nodeType = 1) {
  const styleWrites = new Map();
  const style = {
    variables: new Map(),
    setProperty(name, value) {
      styleWrites.set(name, (styleWrites.get(name) || 0) + 1);
      this.variables.set(name, value);
    },
    removeProperty(name) {
      styleWrites.set(name, (styleWrites.get(name) || 0) + 1);
      this.variables.delete(name);
    },
  };
  for (const name of ["transform", "width", "height", "top", "left", "right", "bottom", "display", "visibility", "opacity", "color", "pointerEvents", "transition"]) {
    let value = "";
    Object.defineProperty(style, name, {
      get() { return value; },
      set(next) {
        styleWrites.set(name, (styleWrites.get(name) || 0) + 1);
        value = String(next);
      },
    });
  }

  const attributes = new Map();
  const attributeWrites = new Map();
  const datasetWrites = new Map();
  const propertyWrites = new Map();
  const node = {
    nodeType,
    style,
    styleWrites,
    attributes,
    attributeWrites,
    datasetWrites,
    propertyWrites,
    dataset: {},
    children: [],
    removed: false,
    classList: {
      values: new Set(),
      add(name) { this.values.add(name); },
      remove(name) { this.values.delete(name); },
      contains(name) { return this.values.has(name); },
      [Symbol.iterator]() { return this.values[Symbol.iterator](); },
    },
    setAttribute(name, value) {
      attributeWrites.set(name, (attributeWrites.get(name) || 0) + 1);
      attributes.set(name, String(value));
      if (name === "data-path" || name === "data-index") {
        const key = name.slice(5);
        const current = datasetWrites.get(key);
        datasetWrites.set(key, { value: String(value), count: current?.count || 0 });
      }
    },
    removeAttribute(name) {
      attributeWrites.set(name, (attributeWrites.get(name) || 0) + 1);
      attributes.delete(name);
      if (name === "data-path" || name === "data-index") datasetWrites.delete(name.slice(5));
    },
    appendChild(child) {
      if (child.nodeType === 11) this.children.push(...child.children);
      else this.children.push(child);
      return child;
    },
    append(...children) { children.forEach((child) => this.appendChild(child)); },
    replaceChildren(...children) {
      this.children = children.flatMap((child) => child.nodeType === 11 ? child.children : [child]);
    },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    blur() {},
    remove() { this.removed = true; },
  };
  for (const [key, attributeName] of [["path", "data-path"], ["index", "data-index"]]) {
    Object.defineProperty(node.dataset, key, {
      get() { return datasetWrites.get(key)?.value; },
      set(value) {
        datasetWrites.set(key, { value: String(value), count: (datasetWrites.get(key)?.count || 0) + 1 });
        attributes.set(attributeName, String(value));
      },
      configurable: true,
    });
  }
  Object.defineProperty(node, "className", {
    get() { return this._className || ""; },
    set(value) {
      this.propertyWrites.set("className", (this.propertyWrites.get("className") || 0) + 1);
      this._className = String(value);
      this.classList.values = new Set(this._className.split(/\s+/).filter(Boolean));
    },
  });
  for (const name of ["hidden", "title", "value", "checked", "disabled", "tabIndex", "type", "placeholder", "autocomplete", "spellcheck", "scrollTop"]) {
    let value = name === "hidden" || name === "checked" || name === "disabled" || name === "spellcheck" ? false : "";
    Object.defineProperty(node, name, {
      get() { return value; },
      set(next) {
        propertyWrites.set(name, (propertyWrites.get(name) || 0) + 1);
        value = next;
        if (name === "hidden") {
          if (next) attributes.set("hidden", "");
          else attributes.delete("hidden");
        }
      },
    });
  }
  Object.defineProperty(node, "textContent", {
    get() { return this._textContent || ""; },
    set(value) {
      propertyWrites.set("textContent", (propertyWrites.get("textContent") || 0) + 1);
      this._textContent = String(value);
      this.children = [];
    },
  });
  Object.defineProperty(node, "firstChild", { get() { return this.children[0] || null; } });
  for (const name of ["clientHeight", "clientWidth", "offsetHeight", "offsetWidth", "getBoundingClientRect"]) {
    Object.defineProperty(node, name, { get() { throw new Error(`layout read: ${name}`); } });
  }
  return node;
}

test("FastDOMNode caches repeated writes across generic and specialized style setters", () => {
  const dom = createElement();
  const fast = new FastDOMNode(dom);
  assert.equal(fast.setTransform("translate3d(0, 0, 0)"), true);
  for (let i = 0; i < 10000; i++) fast.setStyle("transform", "translate3d(0, 0, 0)");
  assert.equal(fast.setTransform("translate3d(0, 0, 0)"), false);
  assert.equal(dom.styleWrites.get("transform"), 1);

  assert.equal(fast.setHeight(22), true);
  for (let i = 0; i < 10000; i++) fast.setHeight(22);
  assert.equal(dom.styleWrites.get("height"), 1);
  assert.equal(dom.style.height, "22px");
  assert.equal(fast.setWidth("50%"), true);
  assert.equal(fast.setWidth("50%"), false);
  assert.equal(dom.style.width, "50%");
  assert.equal(FastDOMNode.toPixels(null), "");
  assert.equal(FastDOMNode.toPixels(0), "0px");
  assert.equal(fast.setWidth(-5), true);
  assert.equal(dom.style.width, "0px");
  assert.equal(fast.setWidth(Number.NaN), false);
  assert.equal(dom.style.width, "0px");
  assert.equal(fast.setOpacity(0.5), true);
  assert.equal(fast.setOpacity(0.5), false);
  assert.equal(dom.style.opacity, "0.5");
});

test("className and incremental class APIs share one cache", () => {
  const dom = createElement();
  const fast = new FastDOMNode(dom);
  assert.equal(fast.setClassName("a b"), true);
  assert.equal(fast.setClassName("a b"), false);
  assert.equal(fast.addClass("c"), true);
  assert.equal(fast.addClass("c"), false);
  assert.equal(fast.toggleClass("b", false), true);
  assert.equal(fast.toggleClass("b", false), false);
  assert.equal(fast.hasClass("a"), true);
  assert.equal(dom.className, "a c");
  assert.equal(dom.propertyWrites.get("className"), 3);
});

test("attributes, booleans, ARIA, dataset, CSS variables, text and hidden state are cached", () => {
  const dom = createElement();
  const fast = new FastDOMNode(dom);
  assert.equal(fast.setAttribute("role", "button"), true);
  assert.equal(fast.setAttribute("role", "button"), false);
  assert.equal(fast.setBooleanAttribute("disabled", true), true);
  assert.equal(dom.attributes.get("disabled"), "");
  assert.equal(fast.setBooleanAttribute("disabled", false), true);
  assert.equal(dom.attributes.has("disabled"), false);
  assert.equal(fast.setAria("expanded", true), true);
  assert.equal(dom.attributes.get("aria-expanded"), "true");
  assert.equal(fast.setAria("aria-expanded", false), true);
  assert.equal(dom.attributes.get("aria-expanded"), "false");
  assert.equal(fast.setAria("expanded", null), true);
  assert.equal(dom.attributes.has("aria-expanded"), false);

  assert.equal(fast.setDataset("path", "/workspace/file.js"), true);
  assert.equal(fast.setDataset("path", "/workspace/file.js"), false);
  assert.equal(dom.dataset.path, "/workspace/file.js");
  assert.equal(fast.setDataset("index", 12), true);
  assert.equal(dom.dataset.index, "12");
  assert.equal(fast.setAttribute("data-index", 12), false);
  assert.equal(fast.setAttribute("data-path", "/changed"), true);
  assert.equal(dom.dataset.path, "/changed");
  assert.equal(fast.setDataset("path", "/changed"), false);
  assert.equal(fast.removeDataset("path"), true);
  assert.equal(fast.removeDataset("path"), false);

  assert.equal(fast.setCSSVariable("--depth", 3), true);
  assert.equal(fast.setCSSVariable("--depth", 3), false);
  assert.equal(dom.style.variables.get("--depth"), "3");
  assert.equal(fast.setCSSVariable("--depth", null), true);
  assert.equal(fast.setCSSVariable("--depth", null), false);

  assert.equal(fast.setTextContent("hello"), true);
  for (let i = 0; i < 10000; i++) fast.setTextContent("hello");
  assert.equal(dom.propertyWrites.get("textContent"), 1);
  assert.equal(fast.setTextContent(null), true);
  assert.equal(dom.textContent, "");
  assert.equal(fast.setHidden(true), true);
  assert.equal(fast.setHidden(true), false);
  assert.equal(fast.setAttribute("hidden", ""), false);
  assert.equal(fast.setHidden(false), true);
  assert.equal(dom.hidden, false);

  assert.equal(fast.setTitle("NCE"), true);
  assert.equal(fast.setAttribute("title", "NCE"), true);
  assert.equal(fast.setTitle("NCE"), false);
  assert.equal(fast.removeAttribute("title"), true);
  assert.equal(dom.attributes.has("title"), false);
});

test("children methods unwrap wrappers, support fragments and skip identical replacements", () => {
  const parent = createElement();
  const raw = createElement();
  const fast = new FastDOMNode(parent);
  const fastChild = new FastDOMNode(createElement());
  assert.equal(fast.appendChild(fastChild), fastChild.domNode);
  fast.append(raw);
  assert.equal(parent.children[0], fastChild.domNode);
  assert.equal(parent.children[1], raw);

  assert.equal(fast.replaceChildren(fastChild, raw), true);
  assert.equal(fast.replaceChildren(fastChild.domNode, raw), false);
  const fragment = createElement(11);
  fragment.children.push(createElement());
  assert.equal(fast.replaceChildren(fragment), true);
  assert.equal(parent.children.length, 1);
  assert.equal(fast.removeChildren(), true);
  assert.equal(fast.removeChildren(), false);

  const managedParent = new FastDOMNode(createElement());
  const managedChild = new FastDOMNode(createElement());
  managedParent.replaceChildren(managedChild);
  assert.equal(managedParent.replaceChildren(managedChild), false);
  managedChild.remove();
  assert.equal(managedParent._children, FastDOMNode.UNKNOWN);
});

test("invalidateCache allows a managed style to be re-applied after an external mutation", () => {
  const dom = createElement();
  const fast = new FastDOMNode(dom);
  fast.setTransform("A");
  dom.style.transform = "B";
  fast.invalidateCache();
  assert.equal(fast.setTransform("A"), true);
  assert.equal(dom.style.transform, "A");
  assert.equal(dom.styleWrites.get("transform"), 3);
});

test("constructor and write hot paths do not read layout", () => {
  const fast = new FastDOMNode(createElement());
  fast.setTransform("none");
  fast.setHeight(22);
  fast.setTextContent("safe");
});

test("DOMManager caches wrapper identity and creates explicitly wrapped elements", () => {
  const document = {
    documentElement: createElement(),
    createElement() { return createElement(); },
    createTextNode(text) { return { nodeType: 3, textContent: text }; },
  };
  const DOMManager = loadGlobal("src/js/manager/DOMManager.js", "DOMManager", {
    FastDOMNode,
    document,
    window: {},
  });
  const manager = new DOMManager({});
  const element = createElement();
  const first = manager.wrapFastNode(element);
  assert.equal(manager.wrapFastNode(element), first);
  assert.equal(manager.wrapFastNode(null), null);
  const created = manager.createFastElement("div");
  assert.ok(created instanceof FastDOMNode);
  assert.equal(created.domNode.nodeType, 1);
  assert.equal(manager.wrapFastNode(created.domNode), created);
  assert.equal(manager.createTextNode("hello").textContent, "hello");
  assert.equal(manager.createElement("div").nodeType, 1);
});

test("renderer manifest loads FastDOMNode before DOMManager", () => {
  const scripts = JSON.parse(
    fs.readFileSync(path.join(root, "src/js/main/renderer-scripts.json"), "utf8"),
  );
  assert.ok(
    scripts.indexOf("js/types/FastDOMNode.js") <
      scripts.indexOf("js/manager/DOMManager.js"),
  );
});

test("Output transform layers skip repeated height and transform mutations", () => {
  const LineController = loadGlobal("src/js/controller/LineController.js", "LineController", {
    OutputScroller: class {}, SETTINGS_GET: () => 4, getOccurrence: () => 0,
  });
  const layers = [createElement(), createElement(), createElement(), createElement()];
  const controller = Object.create(LineController.prototype);
  controller.editor = {
    output: layers[0], lineNumberOutput: layers[1], selectOutput: layers[2], searchOutput: layers[3],
    posY: 22,
    domManager: { getLineHeight: () => 22 },
    tabManager: { activeFile: { offsetY: 4 } },
  };
  ["outputFast", "lineNumberFast", "selectOutputFast", "searchOutputFast"]
    .forEach((property, index) => { controller[property] = new FastDOMNode(layers[index]); });
  controller.outputHeight = 198;
  controller.offsetY = 4;

  controller.applyOutputTransform();
  controller.applyOutputTransform();
  for (const [index, layer] of layers.entries()) {
    assert.equal(layer.style.height, index === 1 ? "219px" : "220px");
    assert.equal(layer.style.transform, "translate(0px, -4px)");
    assert.equal(layer.styleWrites.get("height"), 1);
    assert.equal(layer.styleWrites.get("transform"), 1);
  }
});

test("Scroller thumb size and position use cached FastDOMNode setters", () => {
  const Scroller = loadGlobal("src/js/types/Scroller.js", "Scroller", {
    document: { createElement: () => createElement(), addEventListener() {}, removeEventListener() {} },
  });
  const wrappers = new WeakMap();
  const domManager = {
    wrapFastNode(node) {
      let fast = wrappers.get(node);
      if (!fast) { fast = new FastDOMNode(node); wrappers.set(node, fast); }
      return fast;
    },
    getElementMetrics(node) {
      if (node === scroller.scrollerOBJ) return { clientHeight: 200, clientWidth: 200 };
      if (node === scroller.itemOBJ) return { clientHeight: 20, clientWidth: 20 };
      return { clientHeight: 200, clientWidth: 200 };
    },
  };
  const editor = {
    domManager,
    scrollerManager: { VERTICAL_TYPE: 0, HORIZONTAL_TYPE: 1 },
    sidebarResizer: null,
  };
  const scroller = new Scroller(editor);
  scroller.parentOBJ = createElement();
  scroller.type = 0;
  scroller.isBody = false;
  scroller.calcIsActive = () => true;
  scroller.calculProp = () => 50;
  scroller.init();
  scroller.refreshMetrics();
  scroller.refresh();
  const thumbStyle = scroller.itemOBJ.style;
  assert.equal(thumbStyle.height, "100px");
  const heightWrites = thumbStyleWrites(scroller.itemOBJ, "height");
  assert.equal(heightWrites, 2);
  scroller.refresh();
  assert.equal(thumbStyleWrites(scroller.itemOBJ, "height"), heightWrites);
  scroller.setScrollRatio(0.5);
  scroller.writeThumbPosition(scroller.readThumbMetrics());
  const topWrites = thumbStyleWrites(scroller.itemOBJ, "top");
  scroller.writeThumbPosition(scroller.readThumbMetrics());
  assert.equal(thumbStyle.top, "50px");
  assert.equal(thumbStyleWrites(scroller.itemOBJ, "top"), topWrites);
  scroller.destroy();
});

function thumbStyleWrites(node, property) {
  return node.styleWrites.get(property) || 0;
}
