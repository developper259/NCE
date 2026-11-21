"use strict";

// Minimal DOM harness for Version Manager renderer tests (checkbox-aware).
class FakeElement {
  constructor(tagName, document) {
    this.tagName = tagName;
    this.document = document;
    this.children = [];
    this.parent = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.textContent = "";
    this.isConnected = true;
    this._classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this._classes.add(name)),
      remove: (...names) => names.forEach((name) => this._classes.delete(name)),
      toggle: (name, force) => {
        const want = force === undefined ? !this._classes.has(name) : Boolean(force);
        if (want) this._classes.add(name); else this._classes.delete(name);
        return want;
      },
      contains: (name) => this._classes.has(name),
    };
  }
  get className() { return [...this._classes].join(" "); }
  set className(value) { this._classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  append(...children) {
    for (const child of flatten(children)) { child.parent = this; this.children.push(child); }
  }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...children);
  }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false; }
  focus() { this.document.activeElement = this; }
  dispatch(type, event = {}) {
    const payload = { target: this, defaultPrevented: false, preventDefault() {}, stopPropagation() {}, ...event };
    let node = this;
    while (node) {
      for (const listener of [...(node.listeners.get(type) || [])]) listener(payload);
      node = node.parent;
    }
    return payload;
  }
  click() { return this.dispatch("click"); }
}

function flatten(children) {
  const out = [];
  for (const child of children) {
    if (child?.isFragment) out.push(...child.children);
    else out.push(child);
  }
  return out;
}

function createDocument() {
  const document = { activeElement: null, created: 0 };
  document.createElement = (tagName) => { document.created += 1; return new FakeElement(tagName, document); };
  document.createDocumentFragment = () => {
    const fragment = new FakeElement("#fragment", document);
    fragment.isFragment = true;
    return fragment;
  };
  document.body = new FakeElement("body", document);
  return document;
}

function walk(node, predicate, out = []) {
  if (predicate(node)) out.push(node);
  for (const child of node.children || []) walk(child, predicate, out);
  return out;
}

function byFocusKey(root, key) {
  return walk(root, (node) => node.dataset?.focusKey === key)[0] || null;
}

module.exports = { FakeElement, createDocument, walk, byFocusKey };
