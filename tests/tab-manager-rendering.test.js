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
