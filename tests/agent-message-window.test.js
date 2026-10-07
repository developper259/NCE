const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

class FakeClassList {
  constructor(element) {
    this.element = element;
  }

  values() {
    return new Set(this.element.className.split(/\s+/).filter(Boolean));
  }

  add(...values) {
    const next = this.values();
    values.forEach((value) => next.add(value));
    this.element.className = [...next].join(" ");
  }

  remove(...values) {
    const next = this.values();
    values.forEach((value) => next.delete(value));
    this.element.className = [...next].join(" ");
  }

  contains(value) {
    return this.values().has(value);
  }

  toggle(value, force) {
    const enabled = force === undefined ? !this.contains(value) : force;
    if (enabled) this.add(value);
    else this.remove(value);
    return enabled;
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.parentElement = null;
    this.className = "";
    this.classList = new FakeClassList(this);
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.style = {};
    this.textContent = "";
    this.hidden = false;
    this.scrollTop = 0;
    this.clientHeight = 0;
  }

  get isConnected() {
    let node = this;
    while (node.parentElement) node = node.parentElement;
    return node.connected === true;
  }

  get offsetHeight() {
    return this.classList.contains("agent-sidebar-message-window-control") ? 20 : 20;
  }

  get scrollHeight() {
    return this.children.reduce((height, child) => height + child.offsetHeight + 10, 8);
  }

  appendChild(child) {
    if (child.parentElement) child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }

  insertBefore(child, reference) {
    if (child.parentElement) child.remove();
    const index = reference ? this.children.indexOf(reference) : -1;
    child.parentElement = this;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    children.forEach((child) => this.appendChild(child));
  }

  remove() {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    parent.children = parent.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  replaceWith(next) {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    const index = parent.children.indexOf(this);
    next.parentElement = parent;
    parent.children[index] = next;
    this.parentElement = null;
  }

  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }

  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((entry) => entry !== callback));
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  matches(selector) {
    if (!selector.startsWith(".")) return false;
    return this.classList.contains(selector.slice(1));
  }

  querySelectorAll(selector) {
    const result = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  getBoundingClientRect() {
    if (!this.parentElement) return { top: 0, bottom: this.offsetHeight };
    const parent = this.parentElement;
    let offset = 4;
    for (const sibling of parent.children) {
      if (sibling === this) break;
      offset += sibling.offsetHeight + 10;
    }
    const top = parent.getBoundingClientRect().top + offset - parent.scrollTop;
    return { top, bottom: top + this.offsetHeight };
  }
}

const copiedMessages = [];
const destroyedMarkdown = [];
const markdownUpdates = [];
const markdownRenderer = {
  render(content, element) { element.textContent = content; },
  update(content, element, options = {}) {
    element.textContent = content;
    markdownUpdates.push(content);
    options.onRendered?.();
  },
  destroy(element) { destroyedMarkdown.push(element); },
};
const document = {
  body: new FakeElement("body"),
  createElement: (tagName) => new FakeElement(tagName),
};
const navigator = {
  clipboard: { async writeText(value) { copiedMessages.push(value); } },
};
const AgentSidebar = loadGlobal("src/js/sidebar/Agent.Sidebar.js", "AgentSidebar", {
  Sidebar: class Sidebar {},
  MarkdownRenderer: { MODES: { STRICT: "strict" } },
  document,
  navigator,
  setTimeout: () => 1,
  clearTimeout() {},
  requestAnimationFrame: (callback) => { callback(); return 1; },
  cancelAnimationFrame() {},
});

function fixture(count = 500, id = "conversation-a") {
  const session = {
    id,
    messages: Array.from({ length: count }, (_, index) => ({
      role: index % 2 ? "agent" : "user",
      content: `Message ${index}`,
      timestamp: "10:00",
    })),
    segments: [],
    queue: [],
    isGenerating: false,
    runId: null,
  };
  const sidebar = Object.create(AgentSidebar.prototype);
  sidebar.sessions = [session];
  sidebar.activeSessionId = id;
  sidebar.messageWindowStates = new Map();
  sidebar.messageElements = new WeakMap();
  sidebar.activityElements = new WeakMap();
  sidebar.activityItemElements = new Map();
  sidebar.workLogElements = new WeakMap();
  sidebar.messageWindowControls = null;
  sidebar.markdownRenderer = markdownRenderer;
  sidebar.editor = { contextMenuManager: { openContextMenu() {} } };
  sidebar.stopAgentWorkTicker = () => {};
  sidebar.syncAgentWorkTicker = () => {};
  sidebar.updateReasoningControl = () => {};
  sidebar.scheduleConversationSave = () => {};
  sidebar.formatTime = () => "10:01";
  sidebar.messagesScroller = { updateMetrics() {}, refresh() {} };
  sidebar.scrollMessagesToBottom = () => {};
  const container = new FakeElement("div");
  container.connected = true;
  container.clientHeight = 200;
  sidebar.messagesElement = container;
  return { sidebar, session, container };
}

function messageRows(container) {
  return container.children.filter((child) =>
    child.dataset.agentMessageIndex !== undefined,
  );
}

function buttonFor(container, direction) {
  return container.children.find((child) =>
    child.dataset.agentWindowAction === direction,
  ) || null;
}

function elementCount(root) {
  return root.children.reduce((count, child) => count + 1 + elementCount(child), 0);
}

function click(button) {
  assert.ok(button, "expected message window control");
  for (const handler of button.listeners.get("click") || [])
    handler({ preventDefault() {}, stopPropagation() {} });
}

test("500-message conversations mount a bounded recent DOM window with copy actions", async () => {
  const { sidebar, session, container } = fixture();
  const unwindowed = new FakeElement("div");
  for (const message of session.messages)
    unwindowed.appendChild(sidebar.createMessageElement(message));
  assert.equal(elementCount(unwindowed), 3500);

  sidebar.renderMessages(container);

  assert.equal(messageRows(container).length, 80);
  assert.equal(messageRows(container)[0].dataset.agentMessageIndex, "420");
  assert.equal(elementCount(container), 561);
  assert.ok(buttonFor(container, "older"));
  const copyButton = messageRows(container)[79].querySelector(".agent-sidebar-copy-button");
  const copyHandler = copyButton.listeners.get("click")[0];
  await copyHandler({ stopPropagation() {} });
  assert.equal(copiedMessages.at(-1), "Message 499");
});

test("loading older chunks preserves the anchor and caps mounted message rows", () => {
  const { sidebar, session, container } = fixture();
  sidebar.renderMessages(container);
  const anchor = messageRows(container)[0];
  container.scrollTop = 12;
  const beforeTop = anchor.getBoundingClientRect().top;

  click(buttonFor(container, "older"));
  assert.equal(messageRows(container).length, 120);
  assert.equal(anchor.isConnected, true);
  assert.equal(anchor.getBoundingClientRect().top, beforeTop);

  click(buttonFor(container, "older"));
  assert.equal(messageRows(container).length, 160);
  click(buttonFor(container, "older"));
  assert.equal(messageRows(container).length, 160);
  assert.equal(messageRows(container)[0].dataset.agentMessageIndex, "300");
  assert.ok(buttonFor(container, "newer"));
  assert.equal(elementCount(container), 1122);
  assert.ok(destroyedMarkdown.length >= 20);
  assert.equal(session.messages.length, 500);
});

test("message windows survive session switches and restored conversations show their newest chunk", () => {
  const { sidebar, session: first, container } = fixture();
  sidebar.renderMessages(container);
  click(buttonFor(container, "older"));
  sidebar.handleMessagesScroll();
  const firstScrollTop = container.scrollTop;

  const second = {
    id: "conversation-b",
    messages: Array.from({ length: 10 }, (_, index) => ({
      role: "user", content: `Second ${index}`, timestamp: "10:00",
    })),
    segments: [],
    queue: [],
    isGenerating: false,
    runId: null,
  };
  sidebar.sessions.push(second);
  sidebar.activeSessionId = second.id;
  sidebar.updateView({ renderTabs: false, renderChanges: false });
  assert.equal(messageRows(container).length, 10);
  assert.equal(container.scrollTop, container.scrollHeight);

  sidebar.activeSessionId = first.id;
  sidebar.updateView({ renderTabs: false, renderChanges: false });
  assert.equal(messageRows(container).length, 120);
  assert.equal(messageRows(container)[0].dataset.agentMessageIndex, "380");
  assert.equal(container.scrollTop, firstScrollTop);

  const restored = sidebar.rehydratePersistedSession({
    id: "restored-conversation",
    messages: Array.from({ length: 500 }, (_, index) => ({
      role: "user", content: `Restored ${index}`,
    })),
  });
  sidebar.sessions = [restored];
  sidebar.activeSessionId = restored.id;
  sidebar.renderMessages(container);
  assert.equal(restored.messages.length, 500);
  assert.equal(messageRows(container).length, 80);
  assert.equal(messageRows(container)[0]._agentConversationMessage.content, "Restored 420");
});

test("streaming updates stay visible at the latest window and remain available when scrolled away", () => {
  const { sidebar, session, container } = fixture();
  sidebar.renderMessages(container);
  container.scrollTop = container.scrollHeight - container.clientHeight;
  session.isGenerating = true;
  session.runId = 1;
  sidebar.handleAgentToken("live", {
    sessionId: session.id,
    runId: 1,
    contentMode: "delta",
  });

  assert.equal(session.streamingMessage.content, "live");
  assert.equal(messageRows(container).length, 80);
  const streamedRow = messageRows(container).at(-1);
  assert.equal(streamedRow._agentConversationMessage, session.streamingMessage);
  sidebar.handleAgentToken(" update", {
    sessionId: session.id,
    runId: 1,
    contentMode: "delta",
  });
  assert.equal(session.streamingMessage.content, "live update");
  assert.equal(markdownUpdates.at(-1), "live update");
  assert.equal(messageRows(container).at(-1), streamedRow);

  container.scrollTop = 0;
  sidebar.handleMessagesScroll();
  session.runId = 2;
  session.currentSegment = null;
  sidebar.handleAgentToken("offscreen", {
    sessionId: session.id,
    runId: 2,
    contentMode: "delta",
  });
  assert.equal(session.messages.at(-1).content, "offscreen");
  assert.equal(messageRows(container).length, 80);
  assert.ok(buttonFor(container, "newer"));
  assert.equal(messageRows(container).some((row) =>
    row._agentConversationMessage === session.messages.at(-1),
  ), false);

  click(buttonFor(container, "newer"));
  assert.ok(messageRows(container).some((row) =>
    row._agentConversationMessage === session.messages.at(-1),
  ));
  assert.equal(session.messages.length, 502);
});
