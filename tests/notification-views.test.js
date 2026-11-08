const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

const quietConsole = { ...console, warn() {}, error() {} };

function selectorMatches(element, selector) {
  if (!selector) return false;
  if (selector.startsWith(".")) return element.classList.contains(selector.slice(1));
  return element.tagName.toLowerCase() === selector.toLowerCase();
}

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
    this.values = new Set();
  }
  sync() {
    this.owner._className = [...this.values].join(" ");
  }
  set(value) {
    this.values = new Set(String(value || "").split(/\s+/).filter(Boolean));
    this.sync();
  }
  add(...names) {
    for (const name of names) if (name) this.values.add(name);
    this.sync();
  }
  remove(...names) {
    for (const name of names) this.values.delete(name);
    this.sync();
  }
  toggle(name, force) {
    const next = force === undefined ? !this.values.has(name) : Boolean(force);
    if (next) this.values.add(name);
    else this.values.delete(name);
    this.sync();
    return next;
  }
  contains(name) {
    return this.values.has(name);
  }
}

class FakeElement {
  constructor(document, tagName) {
    this.ownerDocument = document;
    this.tagName = tagName;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
    this.hidden = false;
    this.disabled = false;
    this.tabIndex = 0;
    this.type = "";
    this.title = "";
    this.scrollTop = 0;
    this._textContent = "";
    this._className = "";
    this._innerHTML = "";
  }

  get className() {
    return this._className;
  }

  set className(value) {
    this._className = String(value || "");
    this.classList.set(value);
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value ?? "");
    this.children = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value ?? "");
  }

  get isConnected() {
    let node = this;
    while (node) {
      if (node === this.ownerDocument.body) return true;
      node = node.parentNode;
    }
    return false;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  appendChild(node) {
    if (!node) return node;
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  replaceChildren(...nodes) {
    for (const child of [...this.children]) child.parentNode = null;
    this.children = [];
    for (const node of nodes) this.appendChild(node);
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (selectorMatches(current, selector)) return current;
      current = current.parentNode;
    }
    return null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  }

  dispatch(type, event = {}) {
    const normalized = {
      target: this,
      preventDefault() {},
      stopPropagation() {},
      stopImmediatePropagation() {},
      ...event,
    };
    if (!normalized.target) normalized.target = this;
    for (const listener of [...(this.listeners.get(type) || [])])
      listener(normalized);
    return normalized;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement(this, "body");
    this.activeElement = this.body;
    this.listeners = new Map();
    this.selectors = new Map();
  }

  createElement(tagName) {
    return new FakeElement(this, tagName);
  }

  querySelector(selector) {
    return this.selectors.get(selector) || null;
  }

  setSelector(selector, element) {
    this.selectors.set(selector, element);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  }

  dispatch(type, event = {}) {
    const normalized = {
      target: this.body,
      preventDefault() {},
      stopPropagation() {},
      ...event,
    };
    if (!normalized.target) normalized.target = this.body;
    for (const listener of [...(this.listeners.get(type) || [])])
      listener(normalized);
    return normalized;
  }
}

let activeDocument = null;
const documentProxy = {
  get body() { return activeDocument.body; },
  get activeElement() { return activeDocument.activeElement; },
  set activeElement(value) { activeDocument.activeElement = value; },
  createElement(tagName) { return activeDocument.createElement(tagName); },
  querySelector(selector) { return activeDocument.querySelector(selector); },
  addEventListener(...args) { return activeDocument.addEventListener(...args); },
  removeEventListener(...args) { return activeDocument.removeEventListener(...args); },
};

const NotificationManager = loadGlobal(
  "src/js/manager/NotificationManager.js",
  "NotificationManager",
  { console: quietConsole },
);
const NotificationToastView = loadGlobal(
  "src/js/notifications/NotificationToastView.js",
  "NotificationToastView",
  { document: documentProxy, console: quietConsole },
);
const NotificationCenterView = loadGlobal(
  "src/js/notifications/NotificationCenterView.js",
  "NotificationCenterView",
  { document: documentProxy, console: quietConsole },
);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createStorage() {
  const data = new Map();
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
  };
}

function setup(options = {}) {
  const document = new FakeDocument();
  const bellHost = new FakeElement(document, "div");
  document.setSelector(".nce-titlebar-drag-space", bellHost);
  activeDocument = document;
  const managerOptions = {
    storage: createStorage(),
    minDurationMs: 1,
    durations: options.durations || {},
  };
  if (options.now) managerOptions.now = options.now;
  const manager = new NotificationManager(managerOptions);
  const toast = new NotificationToastView({}, manager, { exitDuration: 0 });
  const center = new NotificationCenterView({}, manager, { now: options.now });
  return { document, bellHost, manager, toast, center };
}

function teardown(context) {
  context.center.destroy();
  context.toast.destroy();
  context.manager.destroy();
}

function findAllByClass(root, className, results = []) {
  if (root.classList?.contains(className)) results.push(root);
  for (const child of root.children || [])
    findAllByClass(child, className, results);
  return results;
}

function findByClass(root, className) {
  return findAllByClass(root, className)[0] || null;
}

function toastById(context, id) {
  return [...context.toast.elements.entries()]
    .find(([candidate]) => candidate === id)?.[1] || null;
}

function itemById(context, id) {
  return context.center.focusables.find(
    (item) => item.dataset.notificationId === id,
  ) || null;
}

test("NotificationToastView renders the four types with their icons", () => {
  const context = setup();
  try {
    context.manager.success("Saved", "Done.", { duration: 10000 });
    context.manager.error("Failed", "Nope.", { duration: 10000 });
    context.manager.warning("Careful", "Slow.", { duration: 10000 });
    context.manager.info("Info", "FYI.", { duration: 10000 });
    assert.equal(context.toast.container.children.length, 4);

    const expected = [
      ["success", "fi-rr-check"],
      ["error", "fi-rr-cross-circle"],
      ["warning", "fi-rr-triangle-warning"],
      ["info", "fi-rr-info"],
    ];
    const toasts = context.toast.container.children;
    for (let index = 0; index < expected.length; index += 1) {
      const [type, icon] = expected[index];
      assert.equal(toasts[index].dataset.type, type);
      const glyph = findByClass(toasts[index], "nce-toast-icon").children[0];
      assert.equal(glyph.className.includes(icon), true);
    }
    assert.equal(findByClass(toasts[0], "nce-toast-title").textContent, "Saved");
    assert.equal(findByClass(toasts[0], "nce-toast-message").textContent, "Done.");
  } finally {
    teardown(context);
  }
});

test("NotificationToastView closes a toast without removing its history", () => {
  const context = setup();
  try {
    const created = context.manager.success("Saved", "", { duration: 10000 });
    const element = toastById(context, created.id);
    findByClass(element, "nce-toast-close").dispatch("click");
    assert.equal(context.manager.getToasts().length, 0);
    assert.equal(context.manager.getNotifications().length, 1);
    assert.equal(context.toast.container.children.length, 0);
    assert.equal(context.toast.elements.size, 0);
  } finally {
    teardown(context);
  }
});

test("NotificationToastView follows automatic expiration and persistence", async () => {
  const context = setup({ durations: { success: 20, error: 20 } });
  try {
    context.manager.success("Temporary");
    context.manager.error("Persistent", "", { persistent: true });
    assert.equal(context.toast.container.children.length, 2);
    await delay(70);
    assert.equal(context.manager.getToasts().length, 1);
    assert.equal(context.toast.container.children.length, 1);
    assert.equal(
      context.toast.container.children[0].dataset.type,
      "error",
      "the persistent toast remains",
    );
    assert.equal(context.manager.getNotifications().length, 2);
  } finally {
    teardown(context);
  }
});

test("NotificationToastView pauses the countdown while hovered", async () => {
  const context = setup({ durations: { info: 60 } });
  try {
    context.manager.info("Hover me");
    const element = context.toast.container.children[0];
    element.dispatch("pointerenter");
    await delay(100);
    assert.equal(context.manager.getToasts().length, 1);
    element.dispatch("pointerleave");
    await delay(140);
    assert.equal(context.manager.getToasts().length, 0);
    assert.equal(context.manager.getNotifications().length, 1);
  } finally {
    teardown(context);
  }
});

test("NotificationToastView runs actions and reports action failures", async () => {
  const context = setup();
  try {
    let calls = 0;
    const created = context.manager.success("Action", "", {
      duration: 10000,
      actions: [{ label: "Retry", action: async () => { calls += 1; } }],
    });
    const element = toastById(context, created.id);
    findByClass(element, "nce-toast-action").dispatch("click");
    await delay(0);
    assert.equal(calls, 1);
    assert.equal(context.manager.getNotifications()[0].read, true);
    assert.equal(context.manager.getToasts().length, 0);

    const failing = context.manager.error("Broken", "", {
      duration: 10000,
      actions: [{ label: "Fail", action: async () => { throw new Error("boom"); } }],
    });
    const failingElement = toastById(context, failing.id);
    findByClass(failingElement, "nce-toast-action").dispatch("click");
    await delay(0);
    assert.equal(context.manager.getToasts().length, 1);
    const error = findByClass(failingElement, "nce-toast-error");
    assert.equal(error.hidden, false);
    assert.match(error.textContent, /action failed/i);
    assert.equal(findByClass(failingElement, "nce-toast-action").disabled, false);
  } finally {
    teardown(context);
  }
});

test("NotificationToastView stays synchronized with manager removals", () => {
  const context = setup();
  try {
    const first = context.manager.info("First", "", { duration: 10000 });
    const second = context.manager.info("Second", "", { duration: 10000 });
    assert.equal(context.toast.container.children.length, 2);
    context.manager.remove(first.id);
    assert.equal(context.toast.container.children.length, 1);
    context.manager.dismiss(second.id);
    assert.equal(context.toast.container.children.length, 0);
    assert.equal(context.manager.getNotifications().length, 1);
  } finally {
    teardown(context);
  }
});

test("NotificationToastView unsubscribes and removes its host on destroy", () => {
  const context = setup();
  try {
    context.manager.info("First");
    const container = context.toast.container;
    context.toast.destroy();
    assert.equal(container.parentNode, null);
    assert.equal(context.toast.elements.size, 0);
    context.manager.info("Second");
    assert.equal(context.manager.getNotifications().length, 2);
  } finally {
    context.center.destroy();
    context.manager.destroy();
  }
});

test("NotificationCenterView keeps the unread badge in sync", () => {
  const context = setup();
  try {
    assert.equal(context.center.badge.hidden, true);
    const first = context.manager.success("One");
    assert.equal(context.center.badge.hidden, false);
    assert.equal(context.center.badge.textContent, "1");
    context.manager.error("Two");
    context.manager.info("Three");
    assert.equal(context.center.badge.textContent, "3");
    context.manager.markAsRead(first.id);
    assert.equal(context.center.badge.textContent, "2");
    context.manager.markAllAsRead();
    assert.equal(context.center.badge.hidden, true);
    assert.equal(
      context.center.bellButton.getAttribute("aria-label"),
      "Notifications",
    );
  } finally {
    teardown(context);
  }
});

test("NotificationCenterView opens newest first and closes with Escape", () => {
  let now = 1000;
  const context = setup({ now: () => now });
  try {
    const first = context.manager.info("First");
    now = 2000;
    const second = context.manager.info("Second");
    assert.equal(context.center.open(), true);
    assert.equal(context.center.isOpen, true);
    assert.equal(
      context.center.element.classList.contains("is-open"),
      true,
    );
    assert.equal(
      context.center.element.getAttribute("aria-hidden"),
      "false",
    );
    assert.equal(
      context.center.bellButton.getAttribute("aria-expanded"),
      "true",
    );
    assert.deepEqual(
      context.center.list.children.map((item) => item.dataset.notificationId),
      [second.id, first.id],
    );
    context.document.dispatch("keydown", { key: "Escape" });
    assert.equal(context.center.isOpen, false);
    assert.equal(
      context.center.element.getAttribute("aria-hidden"),
      "true",
    );
    assert.equal(
      context.center.bellButton.getAttribute("aria-expanded"),
      "false",
    );
  } finally {
    teardown(context);
  }
});

test("NotificationCenterView shows an empty state without notifications", () => {
  const context = setup();
  try {
    context.center.open();
    assert.equal(context.center.list.children.length, 0);
    assert.equal(context.center.empty.hidden, false);
    assert.equal(context.center.empty.textContent, "No notifications");
    assert.equal(context.center.markAllButton.disabled, true);
    assert.equal(context.center.clearButton.disabled, true);
  } finally {
    teardown(context);
  }
});

test("NotificationCenterView marks one or all notifications as read", () => {
  const context = setup();
  try {
    const first = context.manager.info("First");
    const second = context.manager.info("Second");
    context.center.open();
    const newest = itemById(context, second.id);
    newest.dispatch("click");
    assert.equal(context.manager.getUnreadCount(), 1);
    assert.equal(itemById(context, second.id).dataset.read, "true");
    assert.equal(context.center.badge.textContent, "1");

    context.center.markAllButton.dispatch("click");
    assert.equal(context.manager.getUnreadCount(), 0);
    assert.equal(context.center.badge.hidden, true);
    assert.equal(itemById(context, first.id).dataset.read, "true");
    assert.equal(context.center.markAllButton.disabled, true);
  } finally {
    teardown(context);
  }
});

test("NotificationCenterView removes one notification and clears the history", () => {
  const context = setup();
  try {
    context.manager.info("First");
    const second = context.manager.info("Second");
    context.center.open();
    const item = itemById(context, second.id);
    const controls = findAllByClass(item, "nce-notification-item-control");
    controls[controls.length - 1].dispatch("click");
    assert.equal(context.manager.getNotifications().length, 1);
    assert.equal(itemById(context, second.id), null);

    context.center.clearButton.dispatch("click");
    assert.equal(context.manager.getNotifications().length, 0);
    assert.equal(context.center.list.children.length, 0);
    assert.equal(context.center.empty.hidden, false);
  } finally {
    teardown(context);
  }
});

test("NotificationCenterView keeps history entries after their toast closes", () => {
  const context = setup();
  try {
    const created = context.manager.info("History", "", { duration: 10000 });
    context.center.open();
    context.manager.dismiss(created.id);
    assert.equal(context.manager.getToasts().length, 0);
    assert.equal(itemById(context, created.id) !== null, true);
  } finally {
    teardown(context);
  }
});

test("NotificationCenterView restores persisted history after a restart", () => {
  const storage = createStorage();
  const firstDocument = new FakeDocument();
  firstDocument.setSelector(
    ".nce-titlebar-drag-space",
    new FakeElement(firstDocument, "div"),
  );
  activeDocument = firstDocument;
  const firstManager = new NotificationManager({ storage, minDurationMs: 1 });
  const created = firstManager.success("Persisted", "From last session.");
  firstManager.markAsRead(created.id);
  firstManager.destroy();

  const secondDocument = new FakeDocument();
  secondDocument.setSelector(
    ".nce-titlebar-drag-space",
    new FakeElement(secondDocument, "div"),
  );
  activeDocument = secondDocument;
  const secondManager = new NotificationManager({ storage });
  const secondCenter = new NotificationCenterView({}, secondManager, {});
  try {
    secondCenter.open();
    assert.equal(secondCenter.list.children.length, 1);
    assert.equal(
      findByClass(secondCenter.list.children[0], "nce-notification-item-title")
        .textContent,
      "Persisted",
    );
    assert.equal(secondCenter.badge.hidden, true, "read state is restored");
    assert.equal(
      secondManager.getToasts().length,
      0,
      "restored history does not reopen old toasts",
    );
  } finally {
    secondCenter.destroy();
    secondManager.destroy();
  }
});

test("NotificationCenterView executes contextual actions and reports failures", async () => {
  const context = setup();
  try {
    let calls = 0;
    const created = context.manager.info("Action", "", {
      duration: 10000,
      actions: [{ label: "Retry", action: async () => { calls += 1; } }],
    });
    context.center.open();
    findByClass(itemById(context, created.id), "nce-notification-action")
      .dispatch("click");
    await delay(0);
    assert.equal(calls, 1);
    assert.equal(
      context.manager.getNotifications().find((item) => item.id === created.id).read,
      true,
    );
    assert.equal(itemById(context, created.id) !== null, true);
    assert.equal(context.center.actionErrors.size, 0);

    const failing = context.manager.error("Broken", "", {
      duration: 10000,
      actions: [{ label: "Fail", action: async () => { throw new Error("boom"); } }],
    });
    findByClass(itemById(context, failing.id), "nce-notification-action")
      .dispatch("click");
    await delay(0);
    const error = findByClass(
      itemById(context, failing.id),
      "nce-notification-item-error",
    );
    assert.equal(error.hidden, false);
    assert.match(error.textContent, /action failed/i);
    assert.equal(context.manager.getNotifications().length, 2);
  } finally {
    teardown(context);
  }
});

test("NotificationCenterView closes on outside clicks but not inside", () => {
  const context = setup();
  try {
    context.center.open();
    context.document.dispatch("pointerdown", {
      target: context.center.element,
    });
    assert.equal(context.center.isOpen, true);
    context.document.dispatch("pointerdown", { target: context.document.body });
    assert.equal(context.center.isOpen, false);
  } finally {
    teardown(context);
  }
});

test("NotificationCenterView navigates notifications with arrow keys", () => {
  const context = setup();
  try {
    const first = context.manager.info("First");
    const second = context.manager.info("Second");
    context.center.open();
    context.document.dispatch("keydown", { key: "ArrowDown" });
    assert.equal(context.document.activeElement, itemById(context, second.id));
    context.document.dispatch("keydown", { key: "ArrowDown" });
    assert.equal(context.document.activeElement, itemById(context, first.id));
    context.document.dispatch("keydown", { key: "ArrowUp" });
    assert.equal(context.document.activeElement, itemById(context, second.id));
  } finally {
    teardown(context);
  }
});

test("NotificationCenterView removes its listeners and DOM on destroy", () => {
  const context = setup();
  try {
    context.manager.info("First");
    context.center.destroy();
    assert.equal(context.bellHost.children.length, 0);
    assert.equal(context.document.listeners.get("keydown")?.length || 0, 0);
    assert.equal(context.document.listeners.get("pointerdown")?.length || 0, 0);
    context.manager.info("Second");
    assert.equal(context.manager.getNotifications().length, 2);
  } finally {
    context.toast.destroy();
    context.manager.destroy();
  }
});

test("NotificationCenterView formats relative timestamps", () => {
  const now = 10_000_000;
  assert.equal(NotificationCenterView.formatTimestamp(now - 30_000, now), "Just now");
  assert.equal(NotificationCenterView.formatTimestamp(now - 5 * 60_000, now), "5m ago");
  assert.equal(NotificationCenterView.formatTimestamp(now - 2 * 3_600_000, now), "2h ago");
  assert.equal(NotificationCenterView.formatTimestamp(now - 2 * 86_400_000, now), "2d ago");
  assert.match(
    NotificationCenterView.formatTimestamp(now - 30 * 86_400_000, now),
    /\d/,
  );
});
