const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = { setProperty() {} };
    this.className = "";
    this.classList = {
      add: (...names) => { this.className = [...new Set(`${this.className} ${names.join(" ")}`.trim().split(/\s+/))].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(" "); },
      toggle: (name, force) => {
        const present = this.className.split(/\s+/).includes(name);
        const add = force === undefined ? !present : Boolean(force);
        if (add && !present) this.classList.add(name);
        if (!add && present) this.classList.remove(name);
        return add;
      },
    };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text ?? this.children.map((child) => child.textContent).join(""); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  replaceChildren(...children) { this.children = []; this._text = ""; this.append(...children); }
  insertBefore(child, before) {
    const index = this.children.indexOf(before);
    if (index < 0) return this.appendChild(child);
    this.children.splice(index, 0, child); child.parentElement = this; return child;
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((entry) => entry !== this);
  }
  replaceWith(next) {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    const index = siblings.indexOf(this);
    if (index >= 0) { siblings[index] = next; next.parentElement = this.parentElement; }
  }
  addEventListener() {}
  get isConnected() { return Boolean(this.parentElement); }
}

const source = fs.readFileSync(path.join(__dirname, "../src/js/sidebar/Agent.Sidebar.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../src/css/sidebar/agent.css"), "utf8");
const clearedIntervals = [];
const context = {
  Sidebar: class {},
  document: { createElement: (tag) => new FakeElement(tag), removeEventListener() {} },
  setInterval: (callback, delay) => ({ callback, delay, id: Math.random() }),
  clearInterval: (timer) => clearedIntervals.push(timer),
};
vm.runInNewContext(`${source}\nglobalThis.AgentSidebar = AgentSidebar; globalThis.formatAgentWorkDuration = formatAgentWorkDuration;`, context);
const { AgentSidebar } = context;

function createSidebar(session) {
  session.messages ||= [];
  session.segments ||= [];
  const sidebar = Object.create(AgentSidebar.prototype);
  sidebar.getSession = (id) => id === session.id ? session : null;
  sidebar.getActiveSession = () => session;
  sidebar.activeSessionId = session.id;
  sidebar.isOpen = true;
  sidebar.workLogElements = new WeakMap();
  sidebar.activityElements = new WeakMap();
  sidebar.activityItemElements = new Map();
  sidebar.activityItems = new Map();
  sidebar.pendingActivityItems = new Map();
  sidebar.deferredReadItems = new Map();
  sidebar.agentWorkTicker = null;
  sidebar.agentWorkTickerSessionId = null;
  sidebar._activityItemCounter = 0;
  return sidebar;
}

function item(toolName, title, extra = {}) {
  return { id: `${toolName}-${Math.random()}`, toolName, type: toolName === "search_code" ? "search" : toolName === "read_file" ? "read" : "edit", title, status: "success", args: {}, ...extra };
}

function findByClass(element, className) {
  if (element.className?.split(/\s+/).includes(className)) return element;
  for (const child of element.children || []) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return null;
}

test("duration formatter follows the compact seconds, minutes, and hours formats", () => {
  const format = context.formatAgentWorkDuration;
  assert.deepEqual([0, 999, 12_000, 59_000, 60_000, 68_000, 4 * 60_000 + 18_000, 3_599_000, 3_600_000, 3_720_000].map(format), ["0s", "0s", "12s", "59s", "1m 00s", "1m 08s", "4m 18s", "59m 59s", "1h 00m", "1h 02m"]);
});

test("consecutive operations aggregate only within their adjacent phase", () => {
  const session = { id: "s1", isGenerating: false, workState: null };
  const sidebar = createSidebar(session);
  const group = { items: [
    item("search_code", 'Searched workspace for "foo"', { args: { query: "foo" } }),
    item("search_code", 'Searched workspace for "bar"', { args: { query: "bar" } }),
    item("read_file", "Read app.js", { detail: "lines 4–8", args: { path: "app.js" } }),
    item("search_code", 'Searched workspace for "baz"', { args: { query: "baz" } }),
  ] };
  const groups = sidebar.getActivityNodeGroups(group);
  assert.deepEqual(JSON.parse(JSON.stringify(groups.map((entry) => [entry.category, entry.items.length]))), [["search", 2], ["read", 1], ["search", 1]]);
  assert.deepEqual(JSON.parse(JSON.stringify(groups.map((entry) => sidebar.getActivityNodeChildren(entry).map((child) => child.label)))), [["\"foo\"", "\"bar\""], ["lines 4–8"], ["\"baz\""]]);
});

test("read and mutation trees retain ranges and only show real per-file diff stats", () => {
  const session = { id: "s1", isGenerating: false, workState: null };
  const sidebar = createSidebar(session);
  const reads = { category: "read", items: [
    item("read_file", "Read a.js", { detail: "lines 1–87" }),
    item("read_file", "Read b.js", { detail: "lines 12–24" }),
  ] };
  assert.equal(sidebar.getActivityNodeChildren(reads)[0].detail, "lines 1–87");
  assert.equal(sidebar.getActivityNodeChildren(reads)[1].detail, "lines 12–24");
  const edits = { category: "mutation", items: [
    item("modify_file", "Modified a.js", { args: { path: "a.js" }, diffStats: { additions: 4, deletions: 1 } }),
    item("modify_file", "Modified a.js", { args: { path: "a.js" }, diffStats: { additions: 2, deletions: 3 } }),
    item("create_file", "Created b.js", { args: { path: "b.js" } }),
  ] };
  const children = sidebar.getActivityNodeChildren(edits);
  assert.deepEqual(JSON.parse(JSON.stringify(children.map((child) => child.label))), ["Edited a.js", "Created b.js"]);
  assert.deepEqual(JSON.parse(JSON.stringify(children[0].stats)), { additions: 6, deletions: 4 });
  assert.equal(children[1].stats, null);
});

test("tests, review, and model events keep outcome and phase order in the tree model", () => {
  const session = { id: "s1", isGenerating: false, workState: null };
  const sidebar = createSidebar(session);
  const group = { items: [
    item("run_tests", "Tests failed · tests.js", { type: "verify", status: "error", detail: "2 failed", args: { path: "tests.js" } }),
    item("get_changed_files", "Reviewed changes", { type: "review", detail: "2 changed files", diffStats: { additions: 8, deletions: 3 } }),
    item("get_diff", "Reviewed diff", { type: "review", detail: "More changes to review" }),
    item("model_status", "Retried model request", { type: "model", modelEventKind: "retry", detail: "Rate limited · attempt 2" }),
    item("model_status", "Switched model", { type: "model", modelEventKind: "fallback", detail: "Model A → Model B" }),
  ] };
  const nodes = sidebar.getActivityNodeGroups(group);
  assert.deepEqual(JSON.parse(JSON.stringify(nodes.map((node) => [node.category, node.items.length]))), [["tests", 1], ["review", 2], ["model", 1], ["model", 1]]);
  assert.equal(sidebar.getActivityNodeChildren(nodes[0])[0].detail, "2 failed");
  const reviewChildren = sidebar.getActivityNodeChildren(nodes[1]);
  assert.equal(reviewChildren.length, 1);
  assert.equal(reviewChildren[0].label, "2 files");
  assert.equal(reviewChildren[0].action, "review");
});

test("pending approvals stay in the visible work tree and retain enabled controls", () => {
  const session = { id: "s1", isGenerating: true, runId: 4, workState: { runId: 4, startedAt: Date.now() - 1000 } };
  const sidebar = createSidebar(session);
  const group = { sessionId: "s1", runId: 4, status: "running", startedAt: session.workState.startedAt, items: [
    { id: "approval:a1", type: "approval", status: "pending", title: "Run npm test", detail: "Allow the test command?", approvalId: "a1" },
  ] };
  const row = sidebar.createActivityElement(group);
  const card = findByClass(row, "agent-approval-card");
  assert.ok(card);
  assert.equal(card.getAttribute?.("aria-disabled") ?? card.attributes.get("aria-disabled"), "false");
  assert.equal(row.children.some((child) => child.tagName === "BUTTON"), false);
  assert.doesNotMatch(row.className, /collapsed/);
});

test("running and completed headers use the requested DOM and activity trees remain visible", () => {
  const session = { id: "s1", isGenerating: true, runId: 1, workState: { runId: 1, startedAt: Date.now() - 12_000, finishedAt: null } };
  const sidebar = createSidebar(session);
  const group = { id: "g", sessionId: "s1", runId: 1, status: "running", startedAt: session.workState.startedAt, items: [
    item("search_code", 'Searched workspace for "manualContext"', { args: { query: "manualContext" } }),
  ] };
  const row = sidebar.createActivityElement(group);
  const header = row.children[0];
  assert.match(header.className, /agent-work-header-running/);
  assert.equal(header.children[0].className, "agent-working-word");
  assert.equal(header.children[0].children.length, 8);
  assert.equal(header.children[1].className, "agent-work-duration");
  assert.equal(row.children[1].tagName, "UL");
  assert.equal(row.children[1].children[0].tagName, "LI");
  assert.equal(row.children[1].children[0].children[1].tagName, "UL");
  assert.equal(row.children[1].children[0].children[1].children[0].textContent.includes('"manualContext"'), true);
  assert.doesNotMatch(row.className, /collapsed/);
  assert.doesNotMatch(css, /\.agent-activity-details-toggle|\.agent-sidebar-run-status-details/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /animation-delay:\s*calc\(var\(--char-index\)\s*\*\s*68ms\)/);
});

test("rehydrated activity without a sessionId resolves its owning session safely", () => {
  const session = { id: "restored", isGenerating: false, workState: null };
  const sidebar = createSidebar(session);
  sidebar.sessions = [session];
  const group = { runId: 8, status: "success", startedAt: 1_000, finishedAt: 3_000, items: [] };
  session.messages.push(group);
  const row = sidebar.createActivityElement(group);
  assert.equal(group.sessionId, session.id);
  assert.equal(row.children[0].children[0].textContent, "Worked for");
  assert.equal(row.children[0].children[1].textContent, "2s");
});

test("historical work headers use stored timestamps and the live ticker is cleaned up", () => {
  const historical = { id: "old", isGenerating: false, workState: null };
  const sidebar = createSidebar(historical);
  const group = { runId: 3, status: "success", startedAt: 1_000, finishedAt: 42_000 };
  const header = sidebar.createWorkHeader(historical, group);
  assert.equal(header.children[0].textContent, "Worked for");
  assert.equal(header.children[1].textContent, "41s");

  const live = { id: "live", runId: 4, isGenerating: true, workState: null };
  const liveSidebar = createSidebar(live);
  liveSidebar.startAgentWork(live, 4);
  assert.equal(liveSidebar.agentWorkTicker.delay, 1000);
  liveSidebar.finishAgentWork(live, 4, "cancelled");
  assert.equal(live.workState.status, "cancelled");
  assert.equal(liveSidebar.agentWorkTicker, null);
});

test("a run with no observed activity keeps its completed working row", () => {
  const session = { id: "plain", runId: 7, isGenerating: true, workState: null };
  const sidebar = createSidebar(session);
  sidebar.messagesElement = new FakeElement("div");
  sidebar.startAgentWork(session, 7);
  assert.equal(sidebar.messagesElement.children.length, 1);
  assert.equal(sidebar.messagesElement.children[0].children[0].children[0].className, "agent-working-word");
  sidebar.finishActivityGroup({ sessionId: session.id, runId: 7 }, "success");
  assert.equal(sidebar.messagesElement.children.length, 1);
  assert.equal(sidebar.messagesElement.children[0].children[0].children[0].textContent, "Worked for");
  assert.equal(sidebar.agentWorkTicker, null);
});

test("the first activity fills its prompt's working row without creating a duplicate", () => {
  const session = { id: "active", runId: 9, isGenerating: true, workState: null };
  const sidebar = createSidebar(session);
  sidebar.messagesElement = new FakeElement("div");
  sidebar.removeEmptyState = () => {};
  sidebar.shouldAutoScrollMessages = () => false;
  sidebar.startAgentWork(session, 9);
  const temporaryRow = sidebar.messagesElement.children[0];
  sidebar.startActivityItem("search_code", { query: "activity" }, { sessionId: "active", runId: 9, toolCallId: "search-1" });
  assert.equal(sidebar.messagesElement.children.length, 1);
  assert.equal(sidebar.messagesElement.children[0], temporaryRow);
  assert.match(sidebar.messagesElement.children[0].className, /agent-work-log/);
  assert.equal(sidebar.messagesElement.children[0].children.some((child) => child.className === "agent-work-tree"), true);
  sidebar.stopAgentWorkTicker();
});

test("switching to a background run recomputes its wall-clock duration immediately", () => {
  const a = { id: "a", runId: 1, isGenerating: true, workState: { runId: 1, startedAt: Date.now() - 5000 } };
  const b = { id: "b", runId: 2, isGenerating: true, workState: { runId: 2, startedAt: Date.now() - 68_000 } };
  b.messages = [];
  b.segments = [];
  const sidebar = createSidebar(a);
  const headerA = sidebar.createWorkHeader(a);
  const headerB = sidebar.createWorkHeader(b);
  sidebar.workLogElements.get(a).row = new FakeElement("div");
  sidebar.workLogElements.get(b).row = new FakeElement("div");
  let active = a;
  sidebar.getActiveSession = () => active;
  sidebar.syncAgentWorkTicker();
  assert.equal(sidebar.agentWorkTickerSessionId, "a");
  active = b;
  sidebar.syncAgentWorkTicker();
  assert.equal(sidebar.agentWorkTickerSessionId, "b");
  assert.equal(headerB.children[1].textContent, "1m 08s");
  assert.equal(clearedIntervals.length > 0, true);
  sidebar.destroy();
  assert.equal(sidebar.agentWorkTicker, null);
  assert.equal(headerA.children[1].textContent.length > 0, true);
});
