const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

const root = path.resolve(__dirname, "..");

class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.className = "";
    this.children = [];
    this.attributes = {};
    this._text = "";
  }
  set textContent(value) { this._text = String(value); }
  get textContent() { return this._text || this.children.map((child) => child.textContent).join(" "); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
}

const document = { createElement: (tag) => new FakeNode(tag) };

class FakeSidebar {
  constructor(id, title, icon, position, editor) {
    this.id = id;
    this.title = title;
    this.icon = icon;
    this.position = position;
    this.editor = editor;
    this.isOpen = false;
    this.refreshes = 0;
  }
  refresh() { this.refreshes += 1; }
}

const LazyAgentSidebar = loadGlobal(
  "src/js/main/LazyAgentSidebar.js",
  "LazyAgentSidebar",
  { Sidebar: FakeSidebar, document },
);

function collect(node, predicate, matches = []) {
  if (predicate(node)) matches.push(node);
  for (const child of node.children || []) collect(child, predicate, matches);
  return matches;
}

const byClass = (node, className) =>
  collect(node, (child) => String(child.className).split(/\s+/).includes(className));

function createSidebar(ensureLoaded = async () => ({})) {
  const sidebar = new LazyAgentSidebar({ ensureAgentSidebar: ensureLoaded });
  sidebar.ensureLoaded = ensureLoaded;
  return sidebar;
}

test("Lazy Agent sidebar renders a structural ghost shell while loading", () => {
  const sidebar = createSidebar();
  const shell = sidebar.render();
  assert.match(shell.className, /agent-sidebar-container/);
  assert.match(shell.className, /agent-lazy-shell/);
  assert.equal(shell.getAttribute("role"), "status");
  assert.equal(shell.getAttribute("aria-live"), "polite");
  assert.equal(shell.getAttribute("aria-label"), "Chargement de l'Agent");
  assert.equal(byClass(shell, "agent-sidebar-header")[0].textContent, "AGENT");
  assert.equal(byClass(shell, "agent-lazy-line-tab").length, 1);
  assert.equal(byClass(shell, "agent-lazy-add").length, 1);
  const bubbles = byClass(shell, "agent-lazy-bubble");
  assert.equal(bubbles.length, 3);
  assert.equal(byClass(shell, "agent-lazy-bubble-agent").length, 2);
  assert.equal(byClass(shell, "agent-lazy-bubble-user").length, 1);
  assert.ok(byClass(shell, "agent-lazy-line").length >= 8);
  const composer = byClass(shell, "agent-lazy-composer")[0];
  assert.equal(composer.getAttribute("aria-hidden"), "true");
  assert.equal(byClass(composer, "agent-sidebar-input-wrapper").length, 1);
  assert.equal(byClass(composer, "agent-lazy-send").length, 1);
  assert.equal(byClass(shell, "agent-sidebar-input").length, 0, "the shell must not create a fake textarea");
  assert.doesNotMatch(shell.textContent, /Loading Agent|Chargement de l'Agent/);
});

test("Lazy Agent sidebar shows a native state card when loading fails", () => {
  const sidebar = createSidebar();
  sidebar.loadingError = new Error("chunk failed");
  const view = sidebar.render();
  const card = byClass(view, "agent-state-card")[0];
  assert.ok(card, "the failure must use the shared state card");
  assert.match(card.className, /agent-state-error/);
  assert.equal(card.getAttribute("role"), "alert");
  assert.match(card.textContent, /L'Agent n'a pas pu être chargé/);
  assert.match(card.textContent, /Fermez puis rouvrez le panneau pour réessayer/);
  assert.equal(byClass(view, "agent-state-button").length, 0, "no fake retry button");
  assert.equal(byClass(view, "agent-lazy-bubble").length, 0);
});

test("Opening the lazy sidebar clears the previous failure and re-attempts the load", async () => {
  let attempts = 0;
  const sidebar = createSidebar(async () => {
    attempts += 1;
    throw new Error("still failing");
  });
  sidebar.loadingError = new Error("old failure");
  await sidebar.onOpen();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(attempts, 1);
  assert.ok(sidebar.loadingError, "the new failure is kept for the error state");
  assert.equal(sidebar.refreshes, 1, "the menu is refreshed to show the error state");
});

test("Lazy shell styles use theme tokens, shimmer, and reduced motion", () => {
  const css = fs.readFileSync(path.join(root, "src/css/sidebar/agent.css"), "utf8");
  const lazy = fs.readFileSync(path.join(root, "src/js/main/LazyAgentSidebar.js"), "utf8");
  assert.match(css, /\.agent-lazy-line\s*\{[\s\S]*?linear-gradient\([\s\S]*?var\(--bg-hover-alt\)/);
  assert.match(css, /animation:\s*agent-lazy-shimmer/);
  assert.match(css, /@keyframes agent-lazy-shimmer/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.agent-lazy-line\s*\{\s*animation:\s*none/);
  assert.match(css, /\.agent-lazy-bubble-user\s*\{[\s\S]*?var\(--bg-tertiary\)/);
  assert.doesNotMatch(lazy, /AgentStatePresenter/, "the core shell cannot depend on the lazy agent bundle");
});
