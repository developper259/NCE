const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = "";
    this.hidden = false;
    this.title = "";
  }
  append(...children) {
    for (const child of children) this.appendChild(child);
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || [])
      listener({ stopPropagation() {}, preventDefault() {}, ...event });
  }
  click() {
    this.dispatch("click");
  }
}

function createHarness({ root = "/workspace", getCurrentBranch } = {}) {
  const document = { createElement: (tagName) => new FakeElement(tagName) };
  const left = new FakeElement("section");
  const opened = [];
  const editor = {
    tabManager: { activeFile: null, activeTab: null },
    fileExplorer: { rootPath: root },
    lspController: { getProblemCounts: () => ({ errors: 0, warnings: 0 }) },
    api: { git: { getCurrentBranch } },
    sidebarManager: {
      openMenu(menuId) {
        opened.push(menuId);
      },
    },
  };
  const BottomBar = loadGlobal("src/js/addon/BottomBar.js", "BottomBar", {
    getElement: (selector) => selector === ".bottomBar .left" ? left : null,
    document,
    SETTINGS_GET: () => 2,
  });
  const bar = new BottomBar(editor);
  return { bar, editor, left, opened };
}

test("BottomBar shows the current branch and opens Source Control", async () => {
  const { bar, opened } = createHarness({
    getCurrentBranch: async () => ({
      success: true,
      branch: "feature/status-bar",
    }),
  });

  assert.equal(bar.gitBranchIndicator.hidden, true);
  assert.equal(await bar.refreshGitBranch(), true);
  assert.equal(bar.gitBranchIndicator.hidden, false);
  assert.equal(bar.gitBranchNameElement.textContent, "feature/status-bar");
  assert.equal(bar.gitBranchIndicator.dataset.branch, "feature/status-bar");
  assert.match(
    bar.gitBranchIndicator.getAttribute("aria-label"),
    /Git branch feature\/status-bar\. Open Source Control\./,
  );

  bar.gitBranchIndicator.click();
  assert.deepEqual(opened, ["git"]);
});

test("BottomBar labels a detached HEAD and hides without Git or a repository", async () => {
  let response = { success: true, branch: null };
  const { bar } = createHarness({
    getCurrentBranch: async () => response,
  });

  assert.equal(await bar.refreshGitBranch(), true);
  assert.equal(bar.gitBranchIndicator.hidden, false);
  assert.equal(bar.gitBranchNameElement.textContent, "Detached HEAD");

  response = { success: false, code: "NOT_A_REPOSITORY" };
  assert.equal(await bar.refreshGitBranch(), false);
  assert.equal(bar.gitBranchIndicator.hidden, true);

  response = { success: false, code: "GIT_NOT_FOUND" };
  assert.equal(await bar.refreshGitBranch(), false);
  assert.equal(bar.gitBranchIndicator.hidden, true);
});

test("BottomBar hides the branch without a workspace or Git API", async () => {
  const withoutWorkspace = createHarness({
    root: "",
    getCurrentBranch: async () => ({ success: true, branch: "main" }),
  });
  assert.equal(await withoutWorkspace.bar.refreshGitBranch(), false);
  assert.equal(withoutWorkspace.bar.gitBranchIndicator.hidden, true);

  const withoutApi = createHarness({ getCurrentBranch: undefined });
  assert.equal(await withoutApi.bar.refreshGitBranch(), false);
  assert.equal(withoutApi.bar.gitBranchIndicator.hidden, true);
});

test("BottomBar keeps the branch during a transient Git failure", async () => {
  let response = { success: true, branch: "main" };
  const { bar } = createHarness({
    getCurrentBranch: async () => response,
  });

  assert.equal(await bar.refreshGitBranch(), true);
  response = { success: false, code: "GIT_TIMEOUT" };
  assert.equal(await bar.refreshGitBranch(), false);
  assert.equal(bar.gitBranchIndicator.hidden, false);
  assert.equal(bar.gitBranchNameElement.textContent, "main");
  assert.match(bar.gitBranchIndicator.title, /Out of date/);
});

test("BottomBar ignores a branch that resolves after the workspace changes", async () => {
  let resolveBranch;
  const { bar, editor } = createHarness({
    getCurrentBranch: () => new Promise((resolve) => {
      resolveBranch = resolve;
    }),
  });

  const pending = bar.refreshGitBranch();
  editor.fileExplorer.rootPath = "/workspace-b";
  resolveBranch({ success: true, branch: "old-branch" });
  assert.equal(await pending, false);
  assert.equal(bar.gitBranchIndicator.hidden, true);
  assert.equal(bar.gitBranch, null);
});
