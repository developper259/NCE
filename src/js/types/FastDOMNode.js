/**
 * FastDOMNode centralizes cached DOM writes. Layout reads belong to DOMManager.
 * Managed nodes use FastDOMNode as their single writer so its caches stay valid.
 * It intentionally exposes no innerHTML API; pass Nodes and text instead.
 */
class FastDOMNode {
  constructor(domNode) {
    if (!domNode || typeof domNode !== "object" || !domNode.style) {
      throw new TypeError("FastDOMNode requires a DOM Element");
    }

    this._domNode = domNode;
    this._styles = new Map();
    this._cssVariables = new Map();
    this._attributes = new Map();
    this._datasets = new Map();
    this._properties = new Map();
    this._className = FastDOMNode.UNKNOWN;
    this._classSet = null;
    this._textContent = FastDOMNode.UNKNOWN;
    this._children = FastDOMNode.UNKNOWN;
    this._childWrappers = null;
    this._managedParent = null;
  }

  get domNode() {
    return this._domNode;
  }

  static toPixels(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "number") {
      return Number.isFinite(value) ? `${value}px` : null;
    }
    return String(value);
  }

  static unwrap(value) {
    return value instanceof FastDOMNode ? value.domNode : value;
  }

  _setStyle(name, value) {
    if (name.startsWith("--")) return this.setCSSVariable(name, value);
    if (value === null || value === undefined) return this.removeStyle(name);

    const normalized = String(value);
    if (this._styles.get(name) === normalized) return false;
    this._styles.set(name, normalized);
    this._domNode.style[name] = normalized;
    return true;
  }

  setStyle(name, value) {
    // Use camelCase CSSStyleDeclaration names (for example pointerEvents).
    return this._setStyle(name, value);
  }

  removeStyle(name) {
    if (name.startsWith("--")) return this.removeCSSVariable(name);
    if (this._styles.get(name) === "") return false;
    this._styles.set(name, "");
    this._domNode.style[name] = "";
    return true;
  }

  setCSSVariable(name, value) {
    if (typeof name !== "string" || !name.startsWith("--")) {
      throw new TypeError("CSS custom property names must start with --");
    }
    if (value === null || value === undefined) return this.removeCSSVariable(name);

    const normalized = String(value);
    if (this._cssVariables.get(name) === normalized) return false;
    this._cssVariables.set(name, normalized);
    this._domNode.style.setProperty(name, normalized);
    return true;
  }

  removeCSSVariable(name) {
    if (this._cssVariables.get(name) === "") return false;
    this._cssVariables.set(name, "");
    this._domNode.style.removeProperty(name);
    return true;
  }

  _setDimension(name, value) {
    let normalized = FastDOMNode.toPixels(value);
    if (normalized === null) return false;
    if (typeof value === "number" && value < 0) normalized = "0px";
    return this._setStyle(name, normalized);
  }

  setWidth(value) { return this._setDimension("width", value); }
  setHeight(value) { return this._setDimension("height", value); }
  setTop(value) { return this._setDimension("top", value); }
  setLeft(value) { return this._setDimension("left", value); }
  setRight(value) { return this._setDimension("right", value); }
  setBottom(value) { return this._setDimension("bottom", value); }

  setTransform(value) { return this._setStyle("transform", value); }
  setDisplay(value) { return this._setStyle("display", value); }
  setVisibility(value) { return this._setStyle("visibility", value); }

  setOpacity(value) {
    if (value === null || value === undefined) return this.removeStyle("opacity");
    if (typeof value === "number" && !Number.isFinite(value)) return false;
    return this._setStyle("opacity", value);
  }

  setHidden(value) {
    return this.setProperty("hidden", Boolean(value));
  }

  setClassName(value) {
    const normalized = value === null || value === undefined ? "" : String(value);
    if (this._className === normalized) return false;
    this._className = normalized;
    this._classSet = new Set(normalized.split(/\s+/).filter(Boolean));
    this._attributes.delete("class");
    this._properties.delete("className");
    this._domNode.className = normalized;
    return true;
  }

  _getClassSet() {
    if (!this._classSet) {
      this._classSet = new Set(Array.from(this._domNode.classList));
      this._className = Array.from(this._classSet).join(" ");
    }
    return this._classSet;
  }

  _writeClassSet() {
    const value = Array.from(this._classSet).join(" ");
    if (this._className === value) return false;
    this._className = value;
    this._domNode.className = value;
    return true;
  }

  addClass(name) {
    this._validateClassName(name);
    const classes = this._getClassSet();
    if (classes.has(name)) return false;
    classes.add(name);
    return this._writeClassSet();
  }

  removeClass(name) {
    this._validateClassName(name);
    const classes = this._getClassSet();
    if (!classes.delete(name)) return false;
    return this._writeClassSet();
  }

  toggleClass(name, enabled) {
    this._validateClassName(name);
    if (enabled === undefined) enabled = !this.hasClass(name);
    return enabled ? this.addClass(name) : this.removeClass(name);
  }

  hasClass(name) {
    this._validateClassName(name);
    return this._getClassSet().has(name);
  }

  _validateClassName(name) {
    if (typeof name !== "string" || !name || /\s/.test(name)) {
      throw new TypeError("A class operation requires one non-empty class name");
    }
  }

  setAttribute(name, value) {
    if (name === "class" || name === "title") {
      if (value === null || value === undefined) return this.removeAttribute(name);
      const normalized = String(value);
      if (this._attributes.get(name) === normalized) return false;
      this._attributes.set(name, normalized);
      if (name === "class") {
        this._className = normalized;
        this._classSet = new Set(normalized.split(/\s+/).filter(Boolean));
        this._properties.delete("className");
      } else {
        this._properties.set("title", normalized);
      }
      this._domNode.setAttribute(name, normalized);
      return true;
    }
    if (name === "hidden") return this.setHidden(value !== null && value !== undefined);
    if (value === null || value === undefined) return this.removeAttribute(name);

    const normalized = String(value);
    if (this._attributes.get(name) === normalized) return false;
    this._attributes.set(name, normalized);
    const datasetName = this._datasetNameFromAttribute(name);
    if (datasetName !== null) this._datasets.set(datasetName, normalized);
    this._properties.delete(name);
    this._domNode.setAttribute(name, normalized);
    return true;
  }

  removeAttribute(name) {
    if (name === "class") {
      if (this._attributes.get(name) === FastDOMNode.REMOVED) return false;
      this._attributes.set(name, FastDOMNode.REMOVED);
      this._className = "";
      this._classSet = new Set();
      this._domNode.removeAttribute(name);
      return true;
    }
    if (name === "title") {
      if (this._attributes.get(name) === FastDOMNode.REMOVED) return false;
      this._attributes.set(name, FastDOMNode.REMOVED);
      this._properties.set("title", "");
      this._domNode.removeAttribute(name);
      return true;
    }
    if (name === "hidden") return this.setHidden(false);
    if (this._attributes.get(name) === FastDOMNode.REMOVED) return false;
    this._attributes.set(name, FastDOMNode.REMOVED);
    const datasetName = this._datasetNameFromAttribute(name);
    if (datasetName !== null) this._datasets.set(datasetName, FastDOMNode.REMOVED);
    this._properties.delete(name);
    this._domNode.removeAttribute(name);
    return true;
  }

  setBooleanAttribute(name, enabled) {
    return Boolean(enabled) ? this.setAttribute(name, "") : this.removeAttribute(name);
  }

  setAria(name, value) {
    const attribute = name.startsWith("aria-") ? name : `aria-${name}`;
    if (value === null || value === undefined) return this.removeAttribute(attribute);
    return this.setAttribute(attribute, typeof value === "boolean" ? String(value) : value);
  }

  setTitle(value) {
    const normalized = value === null || value === undefined ? "" : String(value);
    if (this._properties.has("title") && this._properties.get("title") === normalized) return false;
    this._properties.set("title", normalized);
    this._attributes.delete("title");
    this._domNode.title = normalized;
    return true;
  }

  setTextContent(value) {
    const normalized = value === null || value === undefined ? "" : String(value);
    if (this._textContent === normalized) return false;
    this._clearChildWrapperParents();
    this._textContent = normalized;
    this._children = FastDOMNode.UNKNOWN;
    this._domNode.textContent = normalized;
    return true;
  }

  setDataset(name, value) {
    if (value === null || value === undefined) return this.removeDataset(name);
    const normalized = String(value);
    if (this._datasets.get(name) === normalized) return false;
    this._datasets.set(name, normalized);
    this._attributes.set(this._datasetAttributeName(name), normalized);
    this._domNode.dataset[name] = normalized;
    return true;
  }

  removeDataset(name) {
    if (this._datasets.get(name) === FastDOMNode.REMOVED) return false;
    this._datasets.set(name, FastDOMNode.REMOVED);
    this._attributes.set(this._datasetAttributeName(name), FastDOMNode.REMOVED);
    delete this._domNode.dataset[name];
    return true;
  }

  setProperty(name, value) {
    if (name === "className") return this.setClassName(value);
    if (name === "title") return this.setTitle(value);
    if (name === "hidden") value = Boolean(value);
    if (this._properties.has(name) && this._properties.get(name) === value) return false;
    this._properties.set(name, value);
    this._attributes.delete(name);
    this._domNode[name] = value;
    return true;
  }

  _datasetAttributeName(name) {
    return `data-${String(name).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
  }

  _datasetNameFromAttribute(name) {
    if (!name.startsWith("data-")) return null;
    return name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
  }

  _unwrapChildren(children) {
    return children.map((child) => FastDOMNode.unwrap(child));
  }

  _clearChildWrapperParents() {
    if (!this._childWrappers) return;
    const childWrappers = this._childWrappers;
    this._childWrappers = null;
    for (const child of childWrappers.values()) {
      if (child._managedParent === this) child._managedParent = null;
    }
  }

  _adoptChildWrappers(children) {
    for (const child of children) {
      if (!(child instanceof FastDOMNode)) continue;
      this._childWrappers ||= new Map();
      if (child._managedParent && child._managedParent !== this) {
        child._managedParent._children = FastDOMNode.UNKNOWN;
        child._managedParent._childWrappers.delete(child.domNode);
      }
      child._managedParent = this;
      this._childWrappers.set(child.domNode, child);
    }
  }

  appendChild(child) {
    const node = FastDOMNode.unwrap(child);
    this._adoptChildWrappers([child]);
    this._children = FastDOMNode.UNKNOWN;
    this._textContent = FastDOMNode.UNKNOWN;
    return this._domNode.appendChild(node);
  }

  append(...children) {
    const nodes = this._unwrapChildren(children);
    this._adoptChildWrappers(children);
    this._children = FastDOMNode.UNKNOWN;
    this._textContent = FastDOMNode.UNKNOWN;
    this._domNode.append(...nodes);
  }

  replaceChildren(...children) {
    const nodes = this._unwrapChildren(children);
    const hasFragment = nodes.some((node) => node?.nodeType === 11);
    if (!hasFragment && this._children !== FastDOMNode.UNKNOWN &&
      this._children.length === nodes.length &&
      this._children.every((node, index) => node === nodes[index])) return false;
    this._clearChildWrapperParents();
    this._adoptChildWrappers(children);
    this._domNode.replaceChildren(...nodes);
    this._children = hasFragment ? FastDOMNode.UNKNOWN : nodes.slice();
    this._textContent = nodes.length === 0 ? "" : FastDOMNode.UNKNOWN;
    return true;
  }

  removeChildren() {
    if (this._children !== FastDOMNode.UNKNOWN && this._children.length === 0) return false;
    if (!this._domNode.firstChild) {
      this._clearChildWrapperParents();
      this._children = [];
      return false;
    }
    this._clearChildWrapperParents();
    this._domNode.replaceChildren();
    this._children = [];
    this._textContent = "";
    return true;
  }

  replaceWith(...siblings) {
    const nodes = this._unwrapChildren(siblings);
    const parent = this._managedParent;
    if (parent) {
      parent._children = FastDOMNode.UNKNOWN;
      parent._childWrappers?.delete(this.domNode);
      this._managedParent = null;
      parent._adoptChildWrappers(siblings);
    }
    this._domNode.replaceWith(...nodes);
  }

  remove() {
    if (this._managedParent) {
      this._managedParent._children = FastDOMNode.UNKNOWN;
      this._managedParent._childWrappers.delete(this.domNode);
      this._managedParent = null;
    }
    this._children = FastDOMNode.UNKNOWN;
    this._domNode.remove();
  }

  addEventListener(...args) { return this._domNode.addEventListener(...args); }
  removeEventListener(...args) { return this._domNode.removeEventListener(...args); }
  focus(...args) { return this._domNode.focus(...args); }
  blur(...args) { return this._domNode.blur(...args); }

  invalidateCache() {
    this._styles.clear();
    this._cssVariables.clear();
    this._attributes.clear();
    this._datasets.clear();
    this._properties.clear();
    this._className = FastDOMNode.UNKNOWN;
    this._classSet = null;
    this._textContent = FastDOMNode.UNKNOWN;
    this._children = FastDOMNode.UNKNOWN;
    this._clearChildWrapperParents();
  }
}

FastDOMNode.UNKNOWN = Symbol("FastDOMNode.UNKNOWN");
FastDOMNode.REMOVED = Symbol("FastDOMNode.REMOVED");
