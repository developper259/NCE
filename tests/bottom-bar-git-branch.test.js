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

function makeBranch(name, overrides = {}) {
  return {
    name,
    oid: name ? "a".repeat(40) : null,
    detached: !name,
    upstream: null,
    ahead: 0,
    behind: 0,
    ...overrides,
  };
}

function makeStatus(branch = makeBranch("main"), entries = []) {
  return {
    branch,
    hasCommits: true,
    entries,
    merging: false,
    rebasing: false,
  };
}

function createHarness({ root = "/workspace", getStatus } = {}) {
  const document = { createElement: (tagName) => new FakeElement(tagName) };
  const left = new FakeElement("section");
  const opened = [];
  const editor = {
    tabManager: { activeFile: null, activeTab: null },
    fileExplorer: { rootPath: root },
    lspController: { getProblemCounts: () => ({ errors: 0, warnings: 0 }) },
    api: { git: { getStatus } },
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

test("BottomBar renders the dirty star as a small superscript beside the branch name", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { bar } = createHarness();

  const label = bar.gitBranchIndicator.children.find(
    (child) => child.className === "bottomBar-git-branch-label",
  );
  assert.ok(label, "branch name and star share a positioned label");
  assert.equal(label.children[0], bar.gitBranchNameElement);
  assert.equal(label.children[1], bar.gitBranchDirtyElement);

  const css = fs.readFileSync(
    path.join(__dirname, "../src/css/bottomBar.css"),
    "utf8",
  );
  const rule = css.match(/\.bottomBar-git-branch-dirty\s*\{([^}]*)\}/)[1];
  assert.match(rule, /position:\s*absolute/);
  assert.match(rule, /top:\s*0/);
  assert.match(rule, /right:\s*0/);
  assert.match(rule, /font-size:\s*8px/);
});

test("BottomBar shows the current branch and opens Source Control", async () => {
  const { bar, opened } = createHarness({
    getStatus: async () => ({
      success: true,
      status: makeStatus(makeBranch("feature/status-bar")),
    }),
  });

  assert.equal(bar.gitBranchIndicator.hidden, true);
  assert.equal(bar.gitBranchDirtyElement.hidden, true);
  assert.equal(await bar.refreshGitBranch(), true);
  assert.equal(bar.gitBranchIndicator.hidden, false);
  assert.equal(bar.gitBranchDirtyElement.hidden, true);
  assert.equal(bar.gitBranchNameElement.textContent, "feature/status-bar");
  assert.equal(bar.gitBranchIndicator.dataset.branch, "feature/status-bar");
  assert.equal(bar.gitBranchIndicator.dataset.dirty, "false");
  assert.match(
    bar.gitBranchIndicator.getAttribute("aria-label"),
    /Git branch feature\/status-bar\. Open Source Control\./,
  );

  bar.gitBranchIndicator.click();
  assert.deepEqual(opened, ["git"]);
});

test("BottomBar stars the branch only while the repository has changes", async () => {
  let response = {
    success: true,
    status: makeStatus(makeBranch("main"), [
      { path: "src/app.js", index: null, worktree: "M" },
    ]),
  };
  const { bar } = createHarness({
    getStatus: async () => response,
  });

  assert.equal(await bar.refreshGitBranch(), true);
  assert.equal(bar.gitBranchIndicator.hidden, false);
  assert.equal(bar.gitBranchDirtyElement.hidden, false);
  assert.equal(bar.gitBranchDirtyElement.textContent, "*");
  assert.equal(bar.gitBranchIndicator.dataset.dirty, "true");
  assert.match(bar.gitBranchIndicator.title, /Uncommitted changes/);
  assert.match(
    bar.gitBranchIndicator.getAttribute("aria-label"),
    /Uncommitted changes/,
  );

  response = { success: true, status: makeStatus(makeBranch("main")) };
  assert.equal(await bar.refreshGitBranch(), true);
  assert.equal(bar.gitBranchDirtyElement.hidden, true);
  assert.equal(bar.gitBranchIndicator.dataset.dirty, "false");
  assert.doesNotMatch(bar.gitBranchIndicator.title, /Uncommitted changes/);
});

test("BottomBar labels a detached HEAD and hides without Git or a repository", async () => {
  let response = {
    success: true,
    status: makeStatus(makeBranch(null)),
  };
  const { bar } = createHarness({
    getStatus: async () => response,
  });

  assert.equal(await bar.refreshGitBranch(), true);
  assert.equal(bar.gitBranchIndicator.hidden, false);
  assert.equal(bar.gitBranchNameElement.textContent, "Detached HEAD");
  assert.equal(bar.gitBranchDirtyElement.hidden, true);

  response = { success: false, code: "NOT_A_REPOSITORY" };
  assert.equal(await bar.refreshGitBranch(), false);
  assert.equal(bar.gitBranchIndicator.hidden, true);
  assert.equal(bar.gitBranchDirtyElement.hidden, true);

  response = { success: false, code: "GIT_NOT_FOUND" };
  assert.equal(await bar.refreshGitBranch(), false);
  assert.equal(bar.gitBranchIndicator.hidden, true);
  assert.equal(bar.gitBranchDirtyElement.hidden, true);
});

test("BottomBar hides the branch without a workspace or Git API", async () => {
  const withoutWorkspace = createHarness({
    root: "",
    getStatus: async () => ({ success: true, status: makeStatus() }),
  });
  assert.equal(await withoutWorkspace.bar.refreshGitBranch(), false);
  assert.equal(withoutWorkspace.bar.gitBranchIndicator.hidden, true);

  const withoutApi = createHarness({ getStatus: undefined });
  assert.equal(await withoutApi.bar.refreshGitBranch(), false);
  assert.equal(withoutApi.bar.gitBranchIndicator.hidden, true);
});

test("BottomBar keeps the branch and its star during a transient Git failure", async () => {
  let response = {
    success: true,
    status: makeStatus(makeBranch("main"), [{ path: "src/app.js" }]),
  };
  const { bar } = createHarness({
    getStatus: async () => response,
  });

  assert.equal(await bar.refreshGitBranch(), true);
  assert.equal(bar.gitBranchDirtyElement.hidden, false);
  response = { success: false, code: "GIT_TIMEOUT" };
  assert.equal(await bar.refreshGitBranch(), false);
  assert.equal(bar.gitBranchIndicator.hidden, false);
  assert.equal(bar.gitBranchNameElement.textContent, "main");
  assert.equal(bar.gitBranchDirtyElement.hidden, false);
  assert.match(bar.gitBranchIndicator.title, /Out of date/);
});

test("BottomBar ignores a branch that resolves after the workspace changes", async () => {
  let resolveStatus;
  const { bar, editor } = createHarness({
    getStatus: () => new Promise((resolve) => {
      resolveStatus = resolve;
    }),
  });

  const pending = bar.refreshGitBranch();
  editor.fileExplorer.rootPath = "/workspace-b";
  resolveStatus({
    success: true,
    status: makeStatus(makeBranch("old-branch"), [{ path: "src/app.js" }]),
  });
  assert.equal(await pending, false);
  assert.equal(bar.gitBranchIndicator.hidden, true);
  assert.equal(bar.gitBranchDirtyElement.hidden, true);
  assert.equal(bar.gitBranch, null);
});
