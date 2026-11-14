const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

const root = path.resolve(__dirname, "..");

const Sidebar = class {
  constructor(id, title, icon, position, editor) {
    this.id = id;
    this.title = title;
    this.icon = icon;
    this.position = position;
    this.editor = editor;
    this.isOpen = false;
  }
};

class FakeScroller {
  constructor(editor, renderItem, onNearEnd) {
    this.editor = editor;
    this.renderItem = renderItem;
    this.onNearEnd = onNearEnd;
    this.items = [];
    this.lastOptions = null;
    this.attached = false;
    this.suspended = false;
    this.destroyed = false;
  }
  attach() { this.attached = true; }
  setItems(items, options) {
    this.items = items;
    this.lastOptions = options;
  }
  nearEnd() { this.onNearEnd?.(); }
  suspend() { this.suspended = true; }
  resume() { this.suspended = false; }
  destroy() { this.destroyed = true; }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = "";
    this.classList = {
      add: (...names) => {
        const classes = new Set(this.className.split(" ").filter(Boolean));
        for (const name of names) classes.add(name);
        this.className = [...classes].join(" ");
      },
      remove: (...names) => {
        const classes = new Set(this.className.split(" ").filter(Boolean));
        for (const name of names) classes.delete(name);
        this.className = [...classes].join(" ");
      },
      toggle: (name, force) => {
        const classes = new Set(this.className.split(" ").filter(Boolean));
        const enabled = force === undefined ? !classes.has(name) : force === true;
        if (enabled) classes.add(name);
        else classes.delete(name);
        this.className = [...classes].join(" ");
        return enabled;
      },
      contains: (name) => this.className.split(" ").includes(name),
    };
    this.textContent = "";
    this.title = "";
    this.hidden = false;
    this.disabled = false;
    this.tabIndex = -1;
    this.open = false;
    this.focused = false;
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
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || [])
      listener({ stopPropagation() {}, preventDefault() {}, target: this, ...event });
  }
  click() {
    this.dispatch("click");
  }
  focus() {
    this.focused = true;
  }
  showModal() {
    if (this.open) throw new Error("The dialog is already open.");
    this.open = true;
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.dispatch("close");
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  replaceChildren(...children) {
    this.children = children;
  }
  remove() {
    this.removed = true;
  }
  contains() {
    return false;
  }
}

const documentStub = {
  createElement: (tagName) => new FakeElement(tagName),
  createElementNS: (_namespace, tagName) => new FakeElement(tagName),
  body: new FakeElement("body"),
  activeElement: null,
};

const storageStub = {
  values: new Map(),
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
  setItem(key, value) { this.values.set(key, String(value)); },
  removeItem(key) { this.values.delete(key); },
  clear() { this.values.clear(); },
};

const GitSidebar = loadGlobal("src/js/sidebar/Git.Sidebar.js", "GitSidebar", {
  Sidebar,
  SearchResultsScroller: FakeScroller,
  document: documentStub,
  localStorage: storageStub,
  SETTINGS_SET: (key, value) => settingsSetHandler(key, value),
  NCEPath: {
    equals: (left, right) => left === right,
    basename: (value) => String(value || "").replace(/\\/g, "/").split("/").pop(),
  },
});

function makeCommit(hash, overrides = {}) {
  return {
    hash,
    author: "NCE Test",
    email: "nce@example.invalid",
    timestamp: 1_760_000_000,
    subject: `commit ${hash.slice(0, 7)}`,
    refs: [],
    ...overrides,
  };
}

function makeCommits(count) {
  return Array.from({ length: count }, (_unused, index) =>
    makeCommit(String(index + 1).padStart(40, "0")));
}

function makeEntry(relativePath, {
  index = null,
  worktree = null,
  kind = "modified",
  conflicted = false,
  originalPath = null,
} = {}) {
  return { path: relativePath, originalPath, index, worktree, conflicted, kind };
}

function makeStatus(entries, overrides = {}) {
  return {
    branch: {
      name: "main",
      oid: "a".repeat(40),
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      ...overrides.branch,
    },
    hasCommits: true,
    entries,
    merging: false,
    rebasing: false,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Sidebar objects live in a VM realm, so re-create them before strict comparison.
function stateActions(sidebar) {
  return { ...sidebar.getStateActions() };
}

const toPlain = (value) => JSON.parse(JSON.stringify(value));

// SETTINGS_SET is a renderer global, so it is routed to the fake editor under test.
let settingsSetHandler = async () => false;

function createSidebar(options = {}) {
  storageStub.clear();
  const responses = [...(options.responses || [])];
  const calls = {
    status: 0,
    init: 0,
    stage: [],
    stageAll: 0,
    unstage: [],
    unstageAll: 0,
    commit: [],
    discard: [],
    abort: [],
    log: [],
    commitDetail: [],
    commitVersions: [],
    compare: [],
    branches: 0,
    switchBranch: [],
    createBranch: [],
    quickPanel: [],
    clipboard: [],
    openDiff: [],
    openFile: [],
    versions: [],
    menus: [],
    notifications: [],
    dismissed: [],
    settings: [],
    setSetting: [],
    install: [],
    installCancel: 0,
    installListeners: [],
    installUnsubscribed: 0,
    remotes: 0,
    addRemote: [],
    setRemoteUrl: [],
    removeRemote: [],
    fetch: [],
    pull: [],
    push: [],
    clone: [],
    selectFolder: 0,
    workspaceSwitch: [],
    cancelNetwork: 0,
    networkListeners: [],
    networkUnsubscribed: 0,
    unsubscribed: false,
  };
  const rootPath = options.rootPath === undefined ? "/workspace" : options.rootPath;
  const editor = {
    fileExplorer: {
      rootPath,
      projectName: options.projectName || "workspace",
      async requestWorkspaceSwitch(folderPath, switchOptions) {
        calls.workspaceSwitch.push([folderPath, switchOptions]);
        if (typeof options.workspaceSwitchResult === "function")
          return options.workspaceSwitchResult(folderPath, switchOptions);
        return options.workspaceSwitchResult === undefined
          ? true
          : options.workspaceSwitchResult;
      },
    },
    api: {
      git: {
        async getStatus() {
          calls.status += 1;
          if (!responses.length)
            return { success: true, status: makeStatus(options.entries || []) };
          const next = responses.shift();
          return typeof next === "function" ? next() : next;
        },
        async init() {
          calls.init += 1;
          if (typeof options.initResult === "function") return options.initResult();
          return options.initResult || { success: true, root: rootPath };
        },
        async stageFile(filePath) {
          calls.stage.push(filePath);
          return typeof options.stageResult === "function"
            ? options.stageResult(filePath)
            : options.stageResult || { success: true, path: filePath };
        },
        async stageAll() {
          calls.stageAll += 1;
          return typeof options.stageAllResult === "function"
            ? options.stageAllResult()
            : options.stageAllResult || { success: true, staged: true };
        },
        async getFileVersions(filePath, versionOptions) {
          calls.versions.push([filePath, versionOptions]);
          if (typeof options.versionsResult === "function")
            return options.versionsResult(filePath, versionOptions);
          return options.versionsResult || {
            success: true,
            path: filePath,
            staged: versionOptions?.staged === true,
            oldContent: "old\n",
            newContent: "new\n",
            binary: false,
            tooLarge: false,
            untracked: false,
            deleted: false,
          };
        },
        async unstageFile(filePath) {
          calls.unstage.push(filePath);
          return options.unstageResult || { success: true, path: filePath };
        },
        async unstageAll() {
          calls.unstageAll += 1;
          return typeof options.unstageAllResult === "function"
            ? options.unstageAllResult()
            : options.unstageAllResult || { success: true, unstaged: true };
        },
        async commit(message) {
          calls.commit.push(message);
          return typeof options.commitResult === "function"
            ? options.commitResult(message)
            : options.commitResult || { success: true, hash: "1234567890abcdef", summary: message };
        },
        async getBranches() {
          calls.branches += 1;
          if (typeof options.branchesResult === "function")
            return options.branchesResult();
          return options.branchesResult || {
            success: true,
            branches: [
              { name: "main", current: true },
              { name: "develop", current: false },
            ],
            current: "main",
          };
        },
        async switchBranch(name) {
          calls.switchBranch.push(name);
          return typeof options.switchBranchResult === "function"
            ? options.switchBranchResult(name)
            : options.switchBranchResult || { success: true, branch: name };
        },
        async createBranch(name) {
          calls.createBranch.push(name);
          return typeof options.createBranchResult === "function"
            ? options.createBranchResult(name)
            : options.createBranchResult || { success: true, branch: name };
        },
        async getLog(logOptions) {
          calls.log.push(logOptions);
          if (typeof options.logResult === "function") return options.logResult(logOptions);
          if (options.logResult) return options.logResult;
          const all = options.commits || [];
          const limit = logOptions?.limit ?? GitSidebar.HISTORY_PAGE_SIZE;
          const skip = logOptions?.skip ?? 0;
          const commits = all.slice(skip, skip + limit);
          return {
            success: true,
            commits,
            limit,
            skip,
            hasMore: skip + commits.length < all.length,
          };
        },
        async getCommitDetail(hash) {
          calls.commitDetail.push(hash);
          if (typeof options.commitDetailResult === "function")
            return options.commitDetailResult(hash);
          if (options.commitDetailResult) return options.commitDetailResult;
          return {
            success: true,
            commit: makeCommit(hash),
            files: options.commitFiles || [
              { path: "src/app.js", originalPath: null, status: "modified" },
            ],
            truncated: options.commitTruncated === true,
          };
        },
        async getCommitFileVersions(hash, filePath, versionOptions) {
          calls.commitVersions.push([hash, filePath, versionOptions]);
          if (typeof options.commitVersionsResult === "function")
            return options.commitVersionsResult(hash, filePath, versionOptions);
          return options.commitVersionsResult || {
            success: true,
            path: filePath,
            staged: false,
            oldContent: "old\n",
            newContent: "new\n",
            binary: false,
            tooLarge: false,
            untracked: false,
            deleted: false,
          };
        },
        async compareCommits(base, target) {
          calls.compare.push([base, target]);
          if (typeof options.compareResult === "function")
            return options.compareResult(base, target);
          if (options.compareResult) return options.compareResult;
          return {
            success: true,
            base,
            target,
            files: options.compareFiles || [
              { path: "src/app.js", originalPath: null, status: "modified" },
            ],
            truncated: false,
          };
        },
        async discardChanges(entries) {
          calls.discard.push(entries);
          if (typeof options.discardResult === "function")
            return options.discardResult(entries);
          return options.discardResult || {
            success: true,
            discarded: entries.map((entry) => entry.path),
          };
        },
        async abortOperation(operation) {
          calls.abort.push(operation);
          if (typeof options.abortResult === "function")
            return options.abortResult(operation);
          return options.abortResult || { success: true, aborted: operation };
        },
        async getRemotes() {
          calls.remotes += 1;
          if (typeof options.remotesResult === "function")
            return options.remotesResult();
          return options.remotesResult || {
            success: true,
            remotes: options.remotes || [],
            defaultRemote: options.defaultRemote || null,
          };
        },
        async addRemote(name, url) {
          calls.addRemote.push([name, url]);
          if (typeof options.addRemoteResult === "function")
            return options.addRemoteResult(name, url);
          return options.addRemoteResult || { success: true, remote: name };
        },
        async setRemoteUrl(name, url, remoteOptions) {
          calls.setRemoteUrl.push([name, url, remoteOptions]);
          if (typeof options.setRemoteUrlResult === "function")
            return options.setRemoteUrlResult(name, url, remoteOptions);
          return options.setRemoteUrlResult || { success: true, remote: name };
        },
        async removeRemote(name) {
          calls.removeRemote.push(name);
          if (typeof options.removeRemoteResult === "function")
            return options.removeRemoteResult(name);
          return options.removeRemoteResult || { success: true, remote: name };
        },
        async fetch(fetchOptions) {
          calls.fetch.push(fetchOptions);
          if (typeof options.fetchResult === "function")
            return options.fetchResult(fetchOptions);
          return options.fetchResult || { success: true, remote: "origin", all: false };
        },
        async pull(pullOptions) {
          calls.pull.push(pullOptions);
          if (typeof options.pullResult === "function")
            return options.pullResult(pullOptions);
          return options.pullResult || {
            success: true,
            summary: "Updating abc..def",
            alreadyUpToDate: false,
          };
        },
        async push(pushOptions) {
          calls.push.push(pushOptions);
          if (typeof options.pushResult === "function")
            return options.pushResult(pushOptions);
          return options.pushResult || {
            success: true,
            remote: "origin",
            branch: "main",
            forced: false,
          };
        },
        async clone(cloneOptions) {
          calls.clone.push(cloneOptions);
          if (typeof options.cloneResult === "function")
            return options.cloneResult(cloneOptions);
          return options.cloneResult || {
            success: true,
            path: "/cloned/repo",
            folderName: "repo",
          };
        },
        async cancelNetworkOperation() {
          calls.cancelNetwork += 1;
          return true;
        },
        onNetworkProgress(listener) {
          calls.networkListeners.push(listener);
          return () => { calls.networkUnsubscribed += 1; };
        },
      },
      installer: options.installer === null ? undefined : {
        async install(packageId) {
          calls.install.push(packageId);
          if (typeof options.installResult === "function")
            return options.installResult(packageId);
          return options.installResult || {
            success: true,
            packageId,
            version: "2.56.1",
            executable: "/userData/tools/git/2.56.1/bin/git",
            installDir: "/userData/tools/git/2.56.1",
          };
        },
        async cancel() { calls.installCancel += 1; },
        onProgress(listener) {
          calls.installListeners.push(listener);
          return () => { calls.installUnsubscribed += 1; };
        },
      },
      writeClipboardText(text) { calls.clipboard.push(text); },
      async selectFolder() {
        calls.selectFolder += 1;
        if (typeof options.selectFolderResult === "function")
          return options.selectFolderResult();
        return options.selectFolderResult === undefined
          ? "/chosen/destination"
          : options.selectFolderResult;
      },
      onFileSystemChange(handler) {
        calls.fileSystemHandler = handler;
        return () => { calls.unsubscribed = true; };
      },
    },
    tabManager: {
      tabs: [],
      async openGitDiff(options) {
        calls.openDiff.push(options);
        return { type: "git-diff" };
      },
      async openFileWithPath(filePath) {
        calls.openFile.push(filePath);
        return { type: "file" };
      },
    },
    async openSettings(category) {
      calls.settings.push(category);
      return { type: "settings" };
    },
    contextMenuManager: {
      openContextMenu(name, context) { calls.menus.push([name, context]); },
    },
    quickPanel: {
      open(config) {
        calls.quickPanel.push(config);
        return true;
      },
    },
    domManager: {},
    notificationManager: {
      notify(options) {
        calls.notifications.push(options);
        return { id: `notification-${calls.notifications.length}`, ...options };
      },
      dismiss(id) {
        calls.dismissed.push(id);
        return true;
      },
    },
  };
  settingsSetHandler = async (key, value) => {
    calls.setSetting.push([key, value]);
    return options.setSettingResult !== false;
  };
  const sidebar = new GitSidebar(editor);
  sidebar.isOpen = options.isOpen !== false;
  return { sidebar, calls, editor };
}

const stagedEntry = makeEntry("src/app.js", { index: "A", kind: "added" });
const modifiedEntry = makeEntry("src/app.js", { worktree: "M", kind: "modified" });
const untrackedEntry = makeEntry("notes.md", { worktree: "?", kind: "untracked" });

test("GitSidebar counts staged and unstaged changes from normalized status", async () => {
  const { sidebar } = createSidebar({
    entries: [stagedEntry, makeEntry("lib/b.js", { worktree: "M" }), untrackedEntry],
  });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(sidebar.getBranchName(), "main");
    const { staged, changes, items, collapsed } = sidebar.describeStatus();
    assert.equal(staged.length, 1);
    assert.equal(changes.length, 2);
    const sections = items.filter((item) => item.type === "section");
    assert.equal(
      sections.map((item) => `${item.section}:${item.count}`).join("|"),
      "changes:2|staged:1",
      "expanded sections stack in the list; the collapsed history moves to the bar",
    );
    assert.deepEqual(
      toPlain(collapsed.map((item) => `${item.section}:${item.count}`)),
      ["history:0"],
      "the collapsed history section is described separately for the pinned bar",
    );
    assert.equal(items.filter((item) => item.type === "entry").length, 3);
    assert.equal(sidebar.fileScroller.items.length, items.length);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar keeps staged and unstaged changes of one file in both sections", async () => {
  const mixed = makeEntry("src/app.js", { index: "M", worktree: "M" });
  const stagedOnly = makeEntry("src/new.js", { index: "A", kind: "added" });
  const { sidebar } = createSidebar({ entries: [mixed, stagedOnly] });
  try {
    await sidebar.refresh({ reason: "open" });
    const { staged, changes } = sidebar.getSections();
    assert.deepEqual(staged.map((entry) => entry.path), ["src/app.js", "src/new.js"]);
    assert.deepEqual(changes.map((entry) => entry.path), ["src/app.js"]);
    assert.equal(sidebar.stagedCount(), 2);
    assert.equal(GitSidebar.statusLetter(mixed, true), "M");
    assert.equal(GitSidebar.statusLetter(mixed, false), "M");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar stages and unstages through GitManager paths inside the workspace", async () => {
  const entry = makeEntry("src/app.js", { worktree: "M" });
  const { sidebar, calls } = createSidebar({ entries: [entry] });
  try {
    await sidebar.refresh({ reason: "open" });
    const before = calls.status;
    assert.equal(await sidebar.toggleStage(entry, false), true);
    assert.deepEqual(calls.stage, ["/workspace/src/app.js"]);
    assert.ok(calls.status > before, "a successful stage refreshes the status");
    assert.match(sidebar.getCommitStatusText(), /Staged src\/app\.js/);
    assert.equal(await sidebar.toggleStage(entry, true), true);
    assert.deepEqual(calls.unstage, ["/workspace/src/app.js"]);
    assert.match(sidebar.getCommitStatusText(), /Unstaged src\/app\.js/);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar stages every change at once and reports the count", async () => {
  const changes = [
    makeEntry("src/a.js", { worktree: "M" }),
    makeEntry("src/b.js", { worktree: "?", kind: "untracked" }),
  ];
  const staged = [
    makeEntry("src/a.js", { index: "M" }),
    makeEntry("src/b.js", { index: "A", kind: "added" }),
  ];
  const { sidebar, calls } = createSidebar({
    responses: [
      { success: true, status: makeStatus(changes) },
      { success: true, status: makeStatus(staged) },
    ],
  });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(await sidebar.stageAllChanges(), true);
    assert.equal(calls.stageAll, 1);
    assert.equal(calls.status, 2, "a successful Stage All refreshes the status");
    assert.equal(sidebar.getCommitStatusText(), "Staged 2 changes");
    assert.equal(sidebar.getSections().changes.length, 0);
    assert.equal(sidebar.getSections().staged.length, 2);
    sidebar.commitMessage = "feat: bulk stage";
    assert.equal(sidebar.canCommit(), true);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar ignores Stage All when nothing is unstaged", async () => {
  const clean = createSidebar({ entries: [] });
  try {
    await clean.sidebar.refresh({ reason: "open" });
    assert.equal(await clean.sidebar.stageAllChanges(), false);
    assert.equal(clean.calls.stageAll, 0);
  } finally {
    clean.sidebar.destroy();
  }

  const stagedOnly = createSidebar({ entries: [stagedEntry] });
  try {
    await stagedOnly.sidebar.refresh({ reason: "open" });
    assert.equal(await stagedOnly.sidebar.stageAllChanges(), false);
    assert.equal(stagedOnly.calls.stageAll, 0);
  } finally {
    stagedOnly.sidebar.destroy();
  }
});

test("GitSidebar prevents overlapping Stage All operations", async () => {
  const pending = deferred();
  const { sidebar, calls } = createSidebar({
    entries: [modifiedEntry, untrackedEntry],
    stageAllResult: () => pending.promise,
  });
  try {
    await sidebar.refresh({ reason: "open" });
    const first = sidebar.stageAllChanges();
    assert.equal(await sidebar.stageAllChanges(), false);
    assert.equal(calls.stageAll, 1);
    assert.equal(sidebar.stagingAll, true);
    assert.equal(sidebar.canCommit(), false, "Stage All blocks commit until it settles");
    pending.resolve({ success: true, staged: true });
    assert.equal(await first, true);
    assert.equal(sidebar.stagingAll, false);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar reports Stage All failures with a retry action", async () => {
  const { sidebar, calls } = createSidebar({
    entries: [modifiedEntry, untrackedEntry],
    stageAllResult: {
      success: false,
      code: "PERMISSION_DENIED",
      error: "The workspace cannot be staged.",
    },
  });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(await sidebar.stageAllChanges(), false);
    assert.equal(calls.stageAll, 1);
    assert.equal(sidebar.getCommitStatusText(), "The workspace cannot be staged.");
    const notification = calls.notifications.find(
      (item) => item.title === "Could not stage all changes",
    );
    assert.equal(notification.type, "error");
    assert.equal(notification.source, "Git");
    assert.equal(notification.message, "The workspace cannot be staged.");
    assert.deepEqual(
      toPlain(notification.actions.map((action) => action.label)),
      ["Retry"],
    );
    notification.actions[0].action();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.stageAll, 2);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar ignores Stage All results from a previous workspace", async () => {
  const pending = deferred();
  const { sidebar, editor } = createSidebar({
    entries: [modifiedEntry],
    stageAllResult: () => pending.promise,
  });
  try {
    await sidebar.refresh({ reason: "open" });
    const staging = sidebar.stageAllChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    editor.fileExplorer.rootPath = "/workspace-b";
    sidebar.handleWorkspaceChanged("/workspace-b");
    pending.resolve({ success: true, staged: true });
    assert.equal(await staging, false);
    assert.equal(sidebar.stagingAll, false);
    assert.doesNotMatch(sidebar.getCommitStatusText(), /Staged 1 change/);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar renders stage-all and unstage-all actions in populated headers", async () => {
  const { sidebar } = createSidebar({ entries: [stagedEntry, modifiedEntry, untrackedEntry] });
  try {
    await sidebar.refresh({ reason: "open" });
    const changesHeader = sidebar.createSectionHeader({
      section: "changes",
      title: "Changes",
      count: 2,
    });
    const stageAction = changesHeader.children.find(
      (child) => child.className === "git-section-action",
    );
    assert.ok(stageAction, "the Changes header offers Stage All");
    assert.equal(stageAction.getAttribute("aria-label"), "Stage all changes");
    assert.equal(stageAction.title, "Stage all changes");
    assert.equal(stageAction.children[0].className, "fi fi-rr-plus");
    assert.equal(stageAction.disabled, false);

    const stagedHeader = sidebar.createSectionHeader({
      section: "staged",
      title: "Staged Changes",
      count: 1,
    });
    const unstageAction = stagedHeader.children.find(
      (child) => child.className === "git-section-action",
    );
    assert.ok(unstageAction, "the Staged header offers Unstage All");
    assert.equal(unstageAction.getAttribute("aria-label"), "Unstage all changes");
    assert.equal(unstageAction.title, "Unstage all changes");
    assert.equal(unstageAction.children[0].className, "fi fi-rr-minus");
    assert.equal(unstageAction.disabled, false);

    sidebar.stagingAll = true;
    const busyStage = sidebar.createSectionHeader({
      section: "changes",
      title: "Changes",
      count: 2,
    }).children.find((child) => child.className === "git-section-action");
    assert.equal(busyStage.disabled, true);
    assert.equal(busyStage.getAttribute("aria-busy"), "true");
    const busyUnstage = sidebar.createSectionHeader({
      section: "staged",
      title: "Staged Changes",
      count: 1,
    }).children.find((child) => child.className === "git-section-action");
    assert.equal(busyUnstage.disabled, true);
    sidebar.stagingAll = false;

    sidebar.unstagingAll = true;
    const pendingUnstage = sidebar.createSectionHeader({
      section: "staged",
      title: "Staged Changes",
      count: 1,
    }).children.find((child) => child.className === "git-section-action");
    assert.equal(pendingUnstage.disabled, true);
    assert.equal(pendingUnstage.getAttribute("aria-busy"), "true");
    sidebar.unstagingAll = false;

    const emptyChanges = sidebar.createSectionHeader({
      section: "changes",
      title: "Changes",
      count: 0,
    });
    assert.equal(
      emptyChanges.children.some((child) => child.className === "git-section-action"),
      false,
      "an empty Changes section hides Stage All",
    );
    const emptyStaged = sidebar.createSectionHeader({
      section: "staged",
      title: "Staged Changes",
      count: 0,
    });
    assert.equal(
      emptyStaged.children.some((child) => child.className === "git-section-action"),
      false,
      "an empty Staged section hides Unstage All",
    );
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar unstages every staged change at once and reports the count", async () => {
  const staged = [
    makeEntry("src/a.js", { index: "M" }),
    makeEntry("src/b.js", { index: "A", kind: "added" }),
  ];
  const changes = [
    makeEntry("src/a.js", { worktree: "M" }),
    makeEntry("src/b.js", { worktree: "?", kind: "untracked" }),
  ];
  const { sidebar, calls } = createSidebar({
    responses: [
      { success: true, status: makeStatus(staged) },
      { success: true, status: makeStatus(changes) },
    ],
  });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(await sidebar.unstageAllChanges(), true);
    assert.equal(calls.unstageAll, 1);
    assert.equal(calls.status, 2, "Unstage All refreshes the status");
    assert.equal(sidebar.getCommitStatusText(), "Unstaged 2 changes");
    assert.equal(sidebar.getSections().staged.length, 0);
    assert.equal(sidebar.getSections().changes.length, 2);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar ignores Unstage All when nothing is staged", async () => {
  const unstagedOnly = createSidebar({ entries: [modifiedEntry] });
  try {
    await unstagedOnly.sidebar.refresh({ reason: "open" });
    assert.equal(await unstagedOnly.sidebar.unstageAllChanges(), false);
    assert.equal(unstagedOnly.calls.unstageAll, 0);
  } finally {
    unstagedOnly.sidebar.destroy();
  }

  const clean = createSidebar({ entries: [] });
  try {
    await clean.sidebar.refresh({ reason: "open" });
    assert.equal(await clean.sidebar.unstageAllChanges(), false);
    assert.equal(clean.calls.unstageAll, 0);
  } finally {
    clean.sidebar.destroy();
  }
});

test("GitSidebar prevents overlapping Unstage All operations", async () => {
  const pending = deferred();
  const { sidebar, calls } = createSidebar({
    responses: [{ success: true, status: makeStatus([stagedEntry]) }],
    unstageAllResult: () => pending.promise,
  });
  try {
    await sidebar.refresh({ reason: "open" });
    sidebar.commitMessage = "fix: waiting";
    assert.equal(sidebar.canCommit(), true);
    const first = sidebar.unstageAllChanges();
    assert.equal(await sidebar.unstageAllChanges(), false);
    assert.equal(calls.unstageAll, 1);
    assert.equal(sidebar.unstagingAll, true);
    assert.equal(sidebar.canCommit(), false, "Unstage All blocks commit until it settles");
    pending.resolve({ success: true, unstaged: true });
    assert.equal(await first, true);
    assert.equal(sidebar.unstagingAll, false);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar reports Unstage All failures with a retry action", async () => {
  const { sidebar, calls } = createSidebar({
    entries: [stagedEntry],
    responses: [{ success: true, status: makeStatus([stagedEntry]) }],
    unstageAllResult: {
      success: false,
      code: "GIT_COMMAND_FAILED",
      error: "The staged changes cannot be reset.",
    },
  });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(await sidebar.unstageAllChanges(), false);
    assert.equal(calls.unstageAll, 1);
    assert.equal(sidebar.getCommitStatusText(), "The staged changes cannot be reset.");
    const notification = calls.notifications.find(
      (item) => item.title === "Could not unstage all changes",
    );
    assert.equal(notification.type, "error");
    assert.equal(notification.source, "Git");
    assert.equal(notification.message, "The staged changes cannot be reset.");
    assert.deepEqual(
      toPlain(notification.actions.map((action) => action.label)),
      ["Retry"],
    );
    notification.actions[0].action();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.unstageAll, 2);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar validates branch names before talking to Git", () => {
  assert.equal(GitSidebar.validateBranchName("feature/login"), null);
  assert.equal(GitSidebar.validateBranchName("release/1.0"), null);
  assert.match(GitSidebar.validateBranchName(""), /Enter a branch name/);
  assert.match(GitSidebar.validateBranchName("-bad"), /dash/);
  assert.match(GitSidebar.validateBranchName("bad name"), /spaces/);
  assert.match(GitSidebar.validateBranchName("bad..name"), /'\.\.'/);
  assert.match(GitSidebar.validateBranchName("bad@{name"), /@\{/);
  assert.match(GitSidebar.validateBranchName("feature//login"), /segment/);
  assert.match(GitSidebar.validateBranchName("feature."), /end with/);
});

test("GitSidebar sorts branches alphabetically for the menu", () => {
  const sorted = GitSidebar.sortBranches([
    { name: "zeta" },
    { name: "develop" },
    { name: "feature/login" },
    { name: "alpha" },
    { name: "" },
    null,
  ]);
  assert.deepEqual(
    toPlain(sorted.map((branch) => branch.name)),
    ["alpha", "develop", "feature/login", "zeta"],
  );
});

test("GitSidebar opens the branch picker with a create item and sorted branches", async () => {
  const { sidebar, calls } = createSidebar({
    entries: [modifiedEntry],
    branchesResult: {
      success: true,
      branches: [
        { name: "zeta", current: false },
        { name: "main", current: true },
        { name: "alpha", current: false },
      ],
      current: "main",
    },
  });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(await sidebar.openBranchPicker(), true);
    const panel = calls.quickPanel[0];
    assert.equal(panel.id, "git-branch-picker");
    assert.equal(panel.mode, "pick");
    assert.equal(panel.title, "Switch Branch");
    assert.equal(panel.preserveLabelCase, true);
    assert.equal(panel.selectedId, "branch:main");
    assert.deepEqual(
      toPlain(panel.items.map((item) => item.label)),
      ["Create new branch", "alpha", "main", "zeta"],
    );
    assert.equal(panel.items[0].id, "create");
    assert.equal(panel.items[1].separatorBefore, true);
    assert.equal(panel.items[2].checked, true);
    assert.equal(panel.items[3].checked, false);

    panel.onAccept(panel.items[1]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls.switchBranch, ["alpha"]);

    panel.onAccept(panel.items[0]);
    assert.equal(calls.quickPanel[1].id, "git-new-branch");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar keeps the current branch in the picker without refs", async () => {
  const { sidebar, calls } = createSidebar({
    entries: [modifiedEntry],
    branchesResult: { success: true, branches: [], current: null },
  });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(await sidebar.openBranchPicker(), true);
    const panel = calls.quickPanel[0];
    assert.deepEqual(
      toPlain(panel.items.map((item) => item.label)),
      ["Create new branch", "main"],
    );
    assert.equal(panel.items[1].checked, true);
    assert.equal(panel.items[1].separatorBefore, true);
    assert.equal(panel.selectedId, "branch:main");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar switches branches and keeps the commit draft", async () => {
  const featureStatus = makeStatus([modifiedEntry], {
    branch: { name: "feature/login" },
  });
  const { sidebar, calls } = createSidebar({
    responses: [
      { success: true, status: makeStatus([modifiedEntry]) },
      { success: true, status: featureStatus },
    ],
  });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(sidebar.getBranchLabel(), "main");
    sidebar.commitMessage = "fix: keep draft";
    assert.equal(await sidebar.switchToBranch("feature/login"), true);
    assert.deepEqual(calls.switchBranch, ["feature/login"]);
    assert.equal(calls.status, 2, "a branch switch refreshes the status");
    assert.equal(sidebar.getBranchLabel(), "feature/login");
    assert.equal(sidebar.commitMessage, "fix: keep draft");
    assert.equal(await sidebar.switchToBranch("feature/login"), false);
    assert.equal(calls.switchBranch.length, 1, "the current branch is ignored");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar reports branch switch failures with a retry action", async () => {
  const { sidebar, calls } = createSidebar({
    entries: [modifiedEntry],
    switchBranchResult: {
      success: false,
      code: "GIT_COMMAND_FAILED",
      error: "Your local changes would be overwritten. Commit or stash them first.",
    },
  });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(await sidebar.switchToBranch("feature/login"), false);
    assert.equal(calls.status, 2, "a failed switch refreshes the status");
    const notification = calls.notifications.find(
      (item) => item.title === "Could not switch branch",
    );
    assert.equal(notification.type, "error");
    assert.equal(notification.source, "Git");
    assert.match(notification.message, /overwritten/);
    assert.deepEqual(
      toPlain(notification.actions.map((action) => action.label)),
      ["Retry"],
    );
    notification.actions[0].action();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.switchBranch.length, 2);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar opens the New Branch prompt and creates the branch", async () => {
  const { sidebar, calls } = createSidebar({ entries: [modifiedEntry] });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(sidebar.promptNewBranch(), true);
    const panel = calls.quickPanel[0];
    assert.equal(panel.id, "git-new-branch");
    assert.equal(panel.mode, "input");
    assert.equal(panel.title, "New Branch");
    assert.match(panel.validate("bad name"), /spaces/);
    assert.equal(panel.validate("feature/login"), null);
    panel.onAccept("feature/login");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls.createBranch, ["feature/login"]);
    assert.equal(calls.status, 2, "a created branch refreshes the status");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar rejects an invalid new branch name before Git", async () => {
  const { sidebar, calls } = createSidebar({ entries: [modifiedEntry] });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(await sidebar.createNewBranch("bad name"), false);
    assert.equal(calls.createBranch.length, 0);
    const notification = calls.notifications.find(
      (item) => item.title === "Invalid branch name",
    );
    assert.equal(notification.type, "error");
    assert.equal(notification.source, "Git");
    assert.match(notification.message, /spaces/);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar prevents overlapping branch switches", async () => {
  const pending = deferred();
  const { sidebar, calls } = createSidebar({
    entries: [modifiedEntry],
    switchBranchResult: () => pending.promise,
  });
  try {
    await sidebar.refresh({ reason: "open" });
    const first = sidebar.switchToBranch("feature/login");
    assert.equal(await sidebar.switchToBranch("other"), false);
    assert.equal(calls.switchBranch.length, 1);
    assert.equal(sidebar.switchingBranch, true);
    pending.resolve({ success: true, branch: "feature/login" });
    assert.equal(await first, true);
    assert.equal(sidebar.switchingBranch, false);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar reports failed Git operations without claiming success", async () => {
  const entry = makeEntry("src/app.js", { worktree: "M" });
  const { sidebar } = createSidebar({
    entries: [entry],
    stageResult: { success: false, code: "INVALID_PATH", error: "The path is not allowed." },
  });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(await sidebar.toggleStage(entry, false), false);
    assert.equal(sidebar.getCommitStatusText(), "The path is not allowed.");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar gates commits on staged files and a non-empty message", async () => {
  const { sidebar, calls } = createSidebar({
    entries: [makeEntry("src/app.js", { worktree: "M" })],
  });
  try {
    await sidebar.refresh({ reason: "open" });
    sidebar.commitMessage = "feat: unstaged only";
    assert.equal(sidebar.canCommit(), false, "unstaged files are not committable");

    const status = makeStatus([stagedEntry]);
    const staged = createSidebar({ responses: [{ success: true, status }] });
    try {
      await staged.sidebar.refresh({ reason: "open" });
      assert.equal(staged.sidebar.canCommit(), false, "an empty message disables commit");
      staged.sidebar.commitMessage = "   ";
      assert.equal(staged.sidebar.canCommit(), false, "whitespace is not a message");
      staged.sidebar.commitMessage = "feat: real message";
      assert.equal(staged.sidebar.canCommit(), true);
      assert.equal(await staged.sidebar.commitChanges(), true);
      assert.deepEqual(staged.calls.commit, ["feat: real message"]);
      assert.equal(staged.sidebar.commitMessage, "", "a successful commit clears the message");
      assert.match(staged.sidebar.getCommitStatusText(), /^Committed 1234567/);
      assert.equal(staged.sidebar.canCommit(), false, "nothing staged remains after the refresh");
    } finally {
      staged.sidebar.destroy();
    }
    assert.equal(calls.commit.length, 0);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar notifies commit success and failure with a retry action", async () => {
  const success = createSidebar({
    responses: [{ success: true, status: makeStatus([stagedEntry]) }],
  });
  try {
    await success.sidebar.refresh({ reason: "open" });
    success.sidebar.commitMessage = "feat: notify";
    assert.equal(await success.sidebar.commitChanges(), true);
    const created = success.calls.notifications.find(
      (notification) => notification.title === "Commit created",
    );
    assert.equal(created.type, "success");
    assert.equal(created.source, "Git");
    assert.match(created.message, /feat: notify/);
  } finally {
    success.sidebar.destroy();
  }

  const failure = createSidebar({
    responses: [{ success: true, status: makeStatus([stagedEntry]) }],
    commitResult: {
      success: false,
      code: "GIT_HOOK_FAILED",
      error: "A Git hook rejected the commit.",
    },
  });
  try {
    await failure.sidebar.refresh({ reason: "open" });
    failure.sidebar.commitMessage = "fix: retry me";
    assert.equal(await failure.sidebar.commitChanges(), false);
    const failed = failure.calls.notifications.find(
      (notification) => notification.title === "Commit failed",
    );
    assert.equal(failed.type, "error");
    assert.equal(failed.source, "Git");
    assert.equal(failed.persistent, true);
    assert.deepEqual(
      toPlain(failed.actions.map((action) => action.label)),
      ["Retry"],
    );
    failed.actions[0].action();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(failure.calls.commit.length, 2);
  } finally {
    failure.sidebar.destroy();
  }
});

test("GitSidebar notifies stage and initialization failures", async () => {
  const stageFailure = createSidebar({
    entries: [modifiedEntry],
    stageResult: {
      success: false,
      code: "PERMISSION_DENIED",
      error: "The file cannot be staged.",
    },
  });
  try {
    await stageFailure.sidebar.refresh({ reason: "open" });
    assert.equal(
      await stageFailure.sidebar.toggleStage(modifiedEntry, false),
      false,
    );
    const notification = stageFailure.calls.notifications.find(
      (item) => item.title === "Could not stage file",
    );
    assert.equal(notification.type, "error");
    assert.equal(notification.source, "Git");
    assert.equal(notification.message, "The file cannot be staged.");
    assert.deepEqual(
      toPlain(notification.actions.map((action) => action.label)),
      ["Retry"],
    );
  } finally {
    stageFailure.sidebar.destroy();
  }

  const initFailure = createSidebar({
    responses: [{ success: false, code: "NOT_A_REPOSITORY", error: "not a repo" }],
    initResult: {
      success: false,
      code: "GIT_COMMAND_FAILED",
      error: "Git could not initialize.",
    },
  });
  try {
    await initFailure.sidebar.refresh({ reason: "open" });
    assert.equal(await initFailure.sidebar.initializeRepository(), false);
    const notification = initFailure.calls.notifications.find(
      (item) => item.title === "Git initialization failed",
    );
    assert.equal(notification.type, "error");
    assert.equal(notification.source, "Git");
    assert.equal(notification.message, "Git could not initialize.");
    notification.actions[0].action();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(initFailure.calls.init, 2);
  } finally {
    initFailure.sidebar.destroy();
  }
});

test("GitSidebar notifies manual refresh failures but not watcher failures", async () => {
  const { sidebar, calls } = createSidebar({
    responses: [
      { success: false, code: "GIT_TIMEOUT", error: "timed out" },
      { success: false, code: "GIT_TIMEOUT", error: "timed out" },
    ],
  });
  try {
    await sidebar.refresh({ reason: "manual" });
    assert.equal(calls.notifications.length, 1);
    assert.equal(calls.notifications[0].title, "Source Control unavailable");
    assert.equal(calls.notifications[0].type, "error");
    assert.equal(calls.notifications[0].source, "Git");
    await sidebar.refresh({ reason: "watcher" });
    assert.equal(calls.notifications.length, 1);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar notifies a successful initialization", async () => {
  const { sidebar, calls } = createSidebar({
    responses: [
      { success: false, code: "NOT_A_REPOSITORY", error: "not a repo" },
      { success: true, status: makeStatus([]) },
    ],
  });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(await sidebar.initializeRepository(), true);
    const notification = calls.notifications.find(
      (item) => item.title === "Git repository initialized",
    );
    assert.equal(notification.type, "success");
    assert.equal(notification.source, "Git");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar keeps the message when a hook rejects the commit", async () => {
  const { sidebar, calls } = createSidebar({
    responses: [{ success: true, status: makeStatus([stagedEntry]) }],
    commitResult: { success: false, code: "GIT_HOOK_FAILED", error: "A Git hook rejected the commit." },
  });
  try {
    await sidebar.refresh({ reason: "open" });
    sidebar.commitMessage = "fix: keep me";
    assert.equal(await sidebar.commitChanges(), false);
    assert.deepEqual(calls.commit, ["fix: keep me"]);
    assert.equal(sidebar.commitMessage, "fix: keep me");
    assert.match(sidebar.getCommitStatusText(), /hook rejected the commit/);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar prevents a second commit while one is running", async () => {
  const pending = deferred();
  let commits = 0;
  const { sidebar } = createSidebar({
    responses: [
      { success: true, status: makeStatus([stagedEntry]) },
      { success: true, status: makeStatus([]) },
    ],
    commitResult: () => { commits += 1; return pending.promise; },
  });
  try {
    await sidebar.refresh({ reason: "open" });
    sidebar.commitMessage = "one commit";
    const first = sidebar.commitChanges();
    const second = await sidebar.commitChanges();
    assert.equal(second, false);
    assert.equal(commits, 1);
    pending.resolve({ success: true, hash: "abcdef1234567890", summary: "one commit" });
    assert.equal(await first, true);
    assert.equal(commits, 1);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar discards a status that belongs to a previous workspace", async () => {
  const stale = deferred();
  let call = 0;
  const { sidebar, editor } = createSidebar({
    responses: [
      () => stale.promise,
      { success: true, status: makeStatus([]) },
    ],
  });
  try {
    const firstRefresh = sidebar.refresh({ reason: "open" });
    call += 1;
    assert.equal(call, 1);
    editor.fileExplorer.rootPath = "/workspace-b";
    sidebar.handleWorkspaceChanged("/workspace-b");
    stale.resolve({
      success: true,
      status: makeStatus([makeEntry("old.js", { worktree: "M" })]),
    });
    await firstRefresh;
    assert.equal(sidebar.workspaceRoot, "/workspace-b");
    assert.deepEqual(sidebar.getSections().changes, []);
    assert.equal(sidebar.getSections().staged.length, 0);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar refreshes the bottom-bar branch after status and workspace changes", async () => {
  const { sidebar, editor } = createSidebar({ entries: [] });
  let refreshes = 0;
  editor.bottomBar = {
    refreshGitBranch() {
      refreshes += 1;
    },
  };
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(refreshes, 1);
    sidebar.isOpen = false;
    sidebar.handleWorkspaceChanged("/workspace-b");
    assert.equal(refreshes, 2);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar explains missing workspaces, plain folders, and missing Git", async () => {
  const empty = createSidebar({ rootPath: "" });
  try {
    await empty.sidebar.refresh({ reason: "open" });
    assert.match(empty.sidebar.getStateMessage(), /Open a folder/);
    assert.equal(empty.calls.status, 0, "no Git status without a workspace");
    assert.deepEqual(
      stateActions(empty.sidebar),
      { init: false, refresh: false, retry: false, install: false, settings: false, clone: true },
    );
  } finally {
    empty.sidebar.destroy();
  }

  const plain = createSidebar({
    responses: [{ success: false, code: "NOT_A_REPOSITORY", error: "not a repo" }],
  });
  try {
    await plain.sidebar.refresh({ reason: "open" });
    assert.equal(plain.sidebar.getStateMessage(), "This workspace is not a Git repository.");
    assert.equal(plain.sidebar.status, null);
    assert.deepEqual(
      stateActions(plain.sidebar),
      { init: true, refresh: true, retry: false, install: false, settings: false, clone: true },
      "a plain folder offers Initialize and Refresh instead of Retry",
    );
  } finally {
    plain.sidebar.destroy();
  }

  const missingGit = createSidebar({
    responses: [{ success: false, code: "GIT_NOT_FOUND", error: "missing" }],
  });
  try {
    await missingGit.sidebar.refresh({ reason: "open" });
    assert.match(missingGit.sidebar.getStateMessage(), /Git is not installed/);
    assert.deepEqual(
      stateActions(missingGit.sidebar),
      { init: false, refresh: false, retry: false, install: true, settings: true, clone: false },
    );
    assert.equal(
      missingGit.sidebar.getStatePresentation(
        missingGit.sidebar.getViewState(),
      ).code,
      "",
      "the missing Git state offers settings instead of a raw error code",
    );
    await missingGit.sidebar.openGitSettings();
    assert.deepEqual(missingGit.calls.settings, ["Git"]);
  } finally {
    missingGit.sidebar.destroy();
  }
});

test("GitSidebar initializes the repository and refreshes with success", async () => {
  const { sidebar, calls } = createSidebar({
    responses: [
      { success: false, code: "NOT_A_REPOSITORY", error: "not a repo" },
      { success: true, status: makeStatus([]) },
    ],
  });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(await sidebar.initializeRepository(), true);
    assert.equal(calls.init, 1);
    assert.equal(calls.status, 2, "the sidebar refreshes after initialization");
    assert.equal(sidebar.error, null);
    assert.match(sidebar.getCommitStatusText(), /initialized/i);
    assert.equal(sidebar.getViewState().mode, "clean");
    assert.deepEqual(
      stateActions(sidebar),
      { init: false, refresh: true, retry: false, install: false, settings: false, clone: false },
      "a clean repository only offers a refresh action",
    );
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar derives explicit view states from the repository", async () => {
  const empty = createSidebar({ rootPath: "" });
  try {
    await empty.sidebar.refresh({ reason: "open" });
    assert.equal(empty.sidebar.getViewState().mode, "no-workspace");
  } finally {
    empty.sidebar.destroy();
  }

  const plain = createSidebar({
    responses: [{ success: false, code: "NOT_A_REPOSITORY", error: "not a repo" }],
  });
  try {
    await plain.sidebar.refresh({ reason: "open" });
    assert.equal(plain.sidebar.getViewState().mode, "no-repository");
  } finally {
    plain.sidebar.destroy();
  }

  const clean = createSidebar({ entries: [] });
  try {
    await clean.sidebar.refresh({ reason: "open" });
    const state = clean.sidebar.getViewState();
    assert.equal(state.mode, "clean");
    assert.equal(state.branch.name, "main");
  } finally {
    clean.sidebar.destroy();
  }

  const stagedOnly = createSidebar({ entries: [stagedEntry] });
  try {
    await stagedOnly.sidebar.refresh({ reason: "open" });
    const state = stagedOnly.sidebar.getViewState();
    assert.equal(state.mode, "changes");
    assert.equal(state.total, 1);
    assert.equal(state.staged.length, 1);
    assert.equal(state.changes.length, 0);
  } finally {
    stagedOnly.sidebar.destroy();
  }

  const failed = createSidebar({
    responses: [{ success: false, code: "GIT_TIMEOUT", error: "timed out" }],
  });
  try {
    await failed.sidebar.refresh({ reason: "manual" });
    const state = failed.sidebar.getViewState();
    assert.equal(state.mode, "error");
    assert.equal(state.errorCode, "GIT_TIMEOUT");
    assert.equal(state.message, "Git did not respond in time.");
  } finally {
    failed.sidebar.destroy();
  }

  const initFailed = createSidebar({
    responses: [{ success: false, code: "NOT_A_REPOSITORY", error: "not a repo" }],
    initResult: {
      success: false,
      code: "GIT_COMMAND_FAILED",
      error: "Git could not initialize.",
    },
  });
  try {
    await initFailed.sidebar.refresh({ reason: "open" });
    await initFailed.sidebar.initializeRepository();
    const state = initFailed.sidebar.getViewState();
    assert.equal(state.mode, "init-error");
    assert.equal(state.message, "Git could not initialize.");
    assert.deepEqual(
      stateActions(initFailed.sidebar),
      { init: true, refresh: true, retry: false, install: false, settings: false, clone: true },
    );
  } finally {
    initFailed.sidebar.destroy();
  }
});

test("GitSidebar keeps prior changes visible but stale after a transient error", async () => {
  const { sidebar } = createSidebar({
    responses: [
      { success: true, status: makeStatus([modifiedEntry]) },
      { success: false, code: "GIT_TIMEOUT", error: "timed out" },
    ],
  });
  try {
    await sidebar.refresh({ reason: "open" });
    await sidebar.refresh({ reason: "manual" });
    const state = sidebar.getViewState();
    assert.equal(state.mode, "changes");
    assert.equal(state.stale, true);
    assert.equal(state.total, 1);
    assert.equal(sidebar.getStateMessage(), "");
    assert.equal(sidebar.canCommit(), false, "stale changes cannot be committed");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar lists only non-empty change sections", async () => {
  const changeSections = (items) => toPlain(items
    .filter((item) => item.type === "section" && item.section !== "history")
    .map((item) => item.section));
  const stagedOnly = createSidebar({ entries: [stagedEntry] });
  try {
    await stagedOnly.sidebar.refresh({ reason: "open" });
    const items = stagedOnly.sidebar.buildListItems(
      stagedOnly.sidebar.getSections().staged,
      stagedOnly.sidebar.getSections().changes,
    );
    assert.deepEqual(changeSections(items), ["staged"]);
    assert.equal(items.some((item) => item.type === "empty"), false);
  } finally {
    stagedOnly.sidebar.destroy();
  }

  const changedOnly = createSidebar({ entries: [modifiedEntry] });
  try {
    await changedOnly.sidebar.refresh({ reason: "open" });
    const items = changedOnly.sidebar.buildListItems(
      changedOnly.sidebar.getSections().staged,
      changedOnly.sidebar.getSections().changes,
    );
    assert.deepEqual(changeSections(items), ["changes"]);
    assert.equal(items.some((item) => item.type === "empty"), false);
  } finally {
    changedOnly.sidebar.destroy();
  }

  const clean = createSidebar({ entries: [] });
  try {
    clean.sidebar.render();
    await clean.sidebar.refresh({ reason: "open" });
    const items = clean.sidebar.buildListItems([], []);
    assert.deepEqual(changeSections(items), []);
    assert.deepEqual(
      toPlain(items.map((item) => item.type)),
      [],
      "a clean repository renders no expanded list sections",
    );
    const collapsed = clean.sidebar.buildCollapsedSections([], []);
    assert.deepEqual(
      toPlain(collapsed.map((item) => item.section)),
      ["history"],
      "a clean repository still offers the collapsed history section in the pinned bar",
    );
    assert.equal(clean.sidebar.collapsedBar.children.length, 1);
    assert.equal(clean.sidebar.collapsedBar.children[0].dataset.section, "history");
    assert.equal(clean.sidebar.collapsedBar.hidden, false);
    assert.equal(clean.sidebar.listElement.hidden, false);
  } finally {
    clean.sidebar.destroy();
  }
});

test("GitSidebar accordion lifts collapsed headers above an opened section to the top", async () => {
  const { sidebar } = createSidebar({
    entries: [stagedEntry, modifiedEntry],
    commits: makeCommits(2),
  });
  const listItems = () => sidebar.buildListItems(
    sidebar.getSections().staged,
    sidebar.getSections().changes,
  );
  const listSections = () => toPlain(listItems()
    .filter((item) => item.type === "section").map((item) => item.section));
  const barSections = () => toPlain(
    sidebar.collapsedBar.children.map((child) => child.dataset.section),
  );
  const entrySections = () => toPlain([...new Set(listItems()
    .filter((item) => item.type === "entry").map((item) => item.section))]);
  const collapseAll = () => {
    for (const section of ["changes", "staged", "history"]) {
      if (sidebar.collapsed[section] !== true) sidebar.toggleSection(section);
    }
  };
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    // Changes and Staged are expanded by default; History starts collapsed.
    assert.deepEqual(listSections(), ["changes", "staged"]);
    assert.deepEqual(barSections(), ["history"]);
    assert.equal(sidebar.collapsedBar.hidden, false);

    // Nothing expanded: every header pins to the bottom bar, list stays empty.
    collapseAll();
    assert.deepEqual(listSections(), []);
    assert.deepEqual(barSections(), ["changes", "staged", "history"]);

    // Opening History lifts the collapsed Changes and Staged headers above it,
    // still collapsed, into the top list; the bottom bar empties.
    assert.equal(sidebar.toggleSection("history"), false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(listSections(), ["changes", "staged", "history"]);
    assert.deepEqual(barSections(), []);
    assert.deepEqual(entrySections(), [], "risen headers stay collapsed: only History has content");
    assert.equal(
      sidebar.history.commits.length > 0, true,
      "the expanded History loads its commits",
    );
    for (const section of ["changes", "staged"]) {
      const header = listItems().find((item) =>
        item.type === "section" && item.section === section);
      assert.equal(
        sidebar.createListItem(header).getAttribute("aria-expanded"), "false",
        `the risen ${section} header stays collapsed in the top list`,
      );
    }

    // Collapsing History again pins every header back to the bottom bar.
    assert.equal(sidebar.toggleSection("history"), true);
    assert.deepEqual(listSections(), []);
    assert.deepEqual(barSections(), ["changes", "staged", "history"]);

    // Opening the middle section (Staged) lifts only Changes above it; History
    // stays pinned below because it sits under the last expanded section.
    assert.equal(sidebar.toggleSection("staged"), false);
    assert.deepEqual(listSections(), ["changes", "staged"]);
    assert.deepEqual(barSections(), ["history"]);
    assert.deepEqual(entrySections(), ["staged"]);

    // Opening Changes too keeps natural order with both expanded on top.
    assert.equal(sidebar.toggleSection("changes"), false);
    assert.deepEqual(listSections(), ["changes", "staged"]);
    assert.deepEqual(barSections(), ["history"]);
    assert.deepEqual(entrySections(), ["changes", "staged"]);

    // Collapsing Staged while Changes stays expanded pins Staged below Changes.
    assert.equal(sidebar.toggleSection("staged"), true);
    assert.deepEqual(listSections(), ["changes"]);
    assert.deepEqual(barSections(), ["staged", "history"]);
    assert.deepEqual(entrySections(), ["changes"]);

    // Re-opening History lifts the collapsed Staged header between the two
    // expanded sections, preserving natural order in the top list.
    assert.equal(sidebar.toggleSection("history"), false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(listSections(), ["changes", "staged", "history"]);
    assert.deepEqual(barSections(), []);
    assert.deepEqual(entrySections(), ["changes"]);
    assert.equal(
      sidebar.createListItem(listItems().find((item) =>
        item.type === "section" && item.section === "staged")).getAttribute("aria-expanded"),
      "false",
      "the collapsed Staged header sits between the expanded Changes and History",
    );
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar animates only the sections that rise into the top list on toggle", async () => {
  const { sidebar } = createSidebar({
    entries: [stagedEntry, modifiedEntry],
    commits: makeCommits(2),
  });
  const rises = [];
  sidebar.animateRisenSections = (sections) => rises.push([...sections]);
  const collapseAll = () => {
    for (const section of ["changes", "staged", "history"]) {
      if (sidebar.collapsed[section] !== true) sidebar.toggleSection(section);
    }
  };
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });

    // Collapsing never lifts a header into the top list, so nothing animates.
    collapseAll();
    assert.deepEqual(rises, []);

    // Opening History lifts Changes, Staged and History itself out of the bar.
    sidebar.toggleSection("history");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(rises, [["changes", "staged", "history"]]);

    // Collapsing History drops them back down without a rise animation.
    sidebar.toggleSection("history");
    assert.deepEqual(rises, [["changes", "staged", "history"]]);

    // Opening Staged lifts only Changes and Staged; History stays pinned low.
    sidebar.toggleSection("staged");
    assert.deepEqual(rises, [["changes", "staged", "history"], ["changes", "staged"]]);

    // Changes already sits in the top list, so expanding it animates nothing.
    sidebar.toggleSection("changes");
    assert.deepEqual(rises, [["changes", "staged", "history"], ["changes", "staged"]]);

    // Collapsing Staged pins it below Changes; re-opening History then lifts the
    // collapsed Staged header and History, but not the already-present Changes.
    sidebar.toggleSection("staged");
    sidebar.toggleSection("history");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(rises, [
      ["changes", "staged", "history"],
      ["changes", "staged"],
      ["staged", "history"],
    ]);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar rise animation staggers a fade/slide and honors reduced motion", () => {
  let reduceMotion = false;
  const frames = [];
  const AnimatedSidebar = loadGlobal("src/js/sidebar/Git.Sidebar.js", "GitSidebar", {
    Sidebar,
    SearchResultsScroller: FakeScroller,
    document: documentStub,
    localStorage: storageStub,
    SETTINGS_SET: (key, value) => settingsSetHandler(key, value),
    NCEPath: {
      equals: (left, right) => left === right,
      basename: (value) => String(value || "").replace(/\\/g, "/").split("/").pop(),
    },
    window: {
      matchMedia: (query) => ({ matches: reduceMotion && query.includes("reduce") }),
    },
    requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
  });
  const animate = AnimatedSidebar.prototype.animateRisenSections;
  const animations = [];
  const headers = new Map();
  for (const section of ["changes", "staged", "history"]) {
    headers.set(section, {
      animate: (keyframes, options) => animations.push({ section, keyframes, options }),
    });
  }
  const context = {
    riseAnimationToken: 0,
    destroyed: false,
    listLayer: {
      querySelector: (selector) => {
        const match = selector.match(/data-section="(\w+)"/);
        return headers.get(match?.[1]) || null;
      },
    },
  };
  const flush = () => { while (frames.length) frames.shift()(); };

  // Reduced motion queues no frame and animates nothing.
  reduceMotion = true;
  animate.call(context, ["changes"]);
  assert.equal(frames.length, 0);
  assert.equal(animations.length, 0);

  // Normal motion waits one frame for the scroller render, then fades each
  // header in from below with a stagger and a backwards fill.
  reduceMotion = false;
  animate.call(context, ["changes", "staged", "history"]);
  assert.equal(frames.length, 1);
  assert.equal(animations.length, 0, "the animation waits for the scroller render frame");
  flush();
  assert.deepEqual(animations.map((entry) => entry.section), ["changes", "staged", "history"]);
  animations.forEach((entry, index) => {
    assert.equal(entry.options.delay, index * 24);
    assert.equal(entry.options.fill, "backwards");
    assert.deepEqual(toPlain(entry.keyframes[0]), { opacity: 0, transform: "translateY(10px)" });
    assert.deepEqual(toPlain(entry.keyframes[1]), { opacity: 1, transform: "translateY(0)" });
  });

  // A newer toggle supersedes any still-queued animation frame.
  animations.length = 0;
  animate.call(context, ["changes"]);
  animate.call(context, ["staged"]);
  flush();
  assert.deepEqual(animations.map((entry) => entry.section), ["staged"]);

  // Headers the scroller has not rendered yet are skipped without throwing.
  animations.length = 0;
  headers.delete("history");
  animate.call(context, ["history", "changes"]);
  flush();
  assert.deepEqual(animations.map((entry) => entry.section), ["changes"]);
});

test("GitSidebar hides the pinned bar when nothing is collapsed or the list is hidden", async () => {
  const { sidebar } = createSidebar({ entries: [modifiedEntry], commits: makeCommits(1) });
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    assert.deepEqual(
      toPlain(sidebar.collapsedBar.children.map((child) => child.dataset.section)),
      ["history"],
    );
    assert.equal(sidebar.collapsedBar.hidden, false);

    // Every section expanded: the bar empties and hides so it adds no gap.
    assert.equal(sidebar.toggleSection("history"), false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(sidebar.collapsedBar.children.length, 0);
    assert.equal(sidebar.collapsedBar.hidden, true);

    assert.equal(sidebar.toggleSection("history"), true);
    assert.equal(sidebar.collapsedBar.hidden, false);

    // The bar mirrors the list visibility: a hidden list hides the bar too.
    sidebar.listElement.hidden = true;
    sidebar.syncCollapsedBarVisibility();
    assert.equal(sidebar.collapsedBar.hidden, true);
    sidebar.listElement.hidden = false;
    sidebar.syncCollapsedBarVisibility();
    assert.equal(sidebar.collapsedBar.hidden, false);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar pinned bar headers reuse the section header and expand on click", async () => {
  const { sidebar } = createSidebar({ entries: [], commits: makeCommits(2) });
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    const barHeader = sidebar.collapsedBar.children[0];
    assert.equal(barHeader.dataset.section, "history");
    assert.equal(barHeader.dataset.gitFocusKey, "section:history");
    assert.equal(barHeader.getAttribute("aria-expanded"), "false");
    assert.equal(barHeader.getAttribute("role"), "button");

    barHeader.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(sidebar.collapsed.history, false);
    assert.equal(sidebar.collapsedBar.children.length, 0);
    assert.equal(sidebar.collapsedBar.hidden, true);
    const listHeader = sidebar.fileScroller.items.find((item) =>
      item.type === "section" && item.section === "history");
    assert.ok(listHeader, "the expanded history header joins the virtual list");
    const rendered = sidebar.createListItem(listHeader);
    assert.equal(rendered.getAttribute("aria-expanded"), "true");
    assert.equal(sidebar.history.commits.length, 2);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar claims Enter/Space on list headers and rows for its own keydown handling", async () => {
  const { sidebar } = createSidebar({ entries: [modifiedEntry] });
  try {
    sidebar.render();
    const header = { closest: (selector) => selector.includes(".git-section-header") ? header : null };
    const row = { closest: (selector) => selector.includes(".git-file-row") ? row : null };
    const foreign = { closest: () => foreign };
    const plain = { closest: () => null };
    sidebar.container.contains = (element) => element === header || element === row;
    assert.equal(sidebar.handleListKeyDown({ key: "Enter", target: header }), true);
    assert.equal(sidebar.handleListKeyDown({ key: " ", target: header }), true);
    assert.equal(sidebar.handleListKeyDown({ key: "Enter", target: row }), true);
    assert.equal(sidebar.handleListKeyDown({ key: "a", target: header }), false);
    assert.equal(sidebar.handleListKeyDown({ key: "Escape", target: header }), false);
    assert.equal(sidebar.handleListKeyDown({ key: "Enter", target: plain }), false);
    assert.equal(
      sidebar.handleListKeyDown({ key: "Enter", target: foreign }), false,
      "elements outside the sidebar container are not claimed",
    );
    assert.equal(sidebar.handleListKeyDown({ key: "Enter", target: null }), false);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar maps error codes to contextual state titles", () => {
  assert.equal(GitSidebar.errorTitle("GIT_NOT_FOUND"), "Git is not installed");
  assert.equal(GitSidebar.errorTitle("REPOSITORY_NOT_FOUND"), "Workspace unavailable");
  assert.equal(GitSidebar.errorTitle("PERMISSION_DENIED"), "Repository access denied");
  assert.equal(GitSidebar.errorTitle("GIT_TIMEOUT"), "Git did not respond");
  assert.equal(GitSidebar.errorTitle("GIT_INDEX_LOCKED"), "Git is already running");
  assert.equal(GitSidebar.errorTitle("GIT_OUTPUT_LIMIT"), "Too many changes");
  assert.equal(GitSidebar.errorTitle("GIT_COMMAND_FAILED"), "Source Control unavailable");
});

test("GitSidebar keeps Initialize available after a failed initialization", async () => {
  const { sidebar, calls } = createSidebar({
    responses: [{ success: false, code: "NOT_A_REPOSITORY", error: "not a repo" }],
    initResult: {
      success: false,
      code: "GIT_COMMAND_FAILED",
      error: "Git could not initialize.",
    },
  });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(await sidebar.initializeRepository(), false);
    assert.equal(calls.init, 1);
    assert.equal(calls.status, 1, "a failed initialization does not refresh");
    assert.equal(sidebar.getStateMessage(), "Git could not initialize.");
    assert.deepEqual(
      stateActions(sidebar),
      { init: true, refresh: true, retry: false, install: false, settings: false, clone: true },
      "the user can try Initialize again",
    );
    assert.equal(await sidebar.initializeRepository(), false, "a retry is attempted");
    assert.equal(calls.init, 2);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar drops Initialize when Git itself is missing", async () => {
  const { sidebar } = createSidebar({
    responses: [{ success: false, code: "NOT_A_REPOSITORY", error: "not a repo" }],
    initResult: { success: false, code: "GIT_NOT_FOUND", error: "missing" },
  });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(await sidebar.initializeRepository(), false);
    assert.match(sidebar.getStateMessage(), /Git is not installed/);
    assert.deepEqual(
      stateActions(sidebar),
      { init: false, refresh: false, retry: false, install: true, settings: true, clone: false },
    );
  } finally {
    sidebar.destroy();
  }
});

// The state buttons fire installGit without returning its promise.
function trackInstallGit(sidebar) {
  const installGit = sidebar.installGit.bind(sidebar);
  const runs = [];
  sidebar.installGit = () => {
    const run = installGit();
    runs.push(run);
    return run;
  };
  return runs;
}

test("GitSidebar installs Git from the missing-Git state and saves git.path", async () => {
  const { sidebar, calls } = createSidebar({
    responses: [
      { success: false, code: "GIT_NOT_FOUND", error: "missing" },
      { success: true, status: makeStatus([]) },
    ],
  });
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    assert.equal(sidebar.stateInstall.hidden, false);
    assert.equal(sidebar.stateInstall.dataset.action, "install");
    assert.equal(
      sidebar.stateInstall.classList.contains("git-sidebar-primary"),
      true,
      "Install Git is the primary fix when Git is missing",
    );
    assert.equal(sidebar.stateSettings.hidden, false, "the manual path stays available");
    const runs = trackInstallGit(sidebar);
    sidebar.stateInstall.click();
    assert.equal(await runs[0], true);
    assert.deepEqual(calls.install, ["git"]);
    assert.deepEqual(calls.setSetting, [
      ["git.path", "/userData/tools/git/2.56.1/bin/git"],
    ]);
    assert.equal(calls.status, 2, "the sidebar refreshes with the installed Git");
    assert.equal(sidebar.error, null);
    assert.equal(sidebar.installingGit, false);
    assert.equal(calls.installUnsubscribed, 1);
    const success = calls.notifications[calls.notifications.length - 1];
    assert.equal(success.type, "success");
    assert.equal(success.source, "Git");
    assert.match(success.message, /2\.56\.1/);
    assert.deepEqual(calls.dismissed, ["notification-1"], "the progress notification is removed");
    assert.equal(sidebar.stateInstall.hidden, true, "a working Git no longer offers Install");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar shows install progress and blocks other actions while installing", async () => {
  const pending = deferred();
  const { sidebar, calls } = createSidebar({
    responses: [{ success: false, code: "GIT_NOT_FOUND", error: "missing" }],
    installResult: () => pending.promise,
  });
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    const run = sidebar.installGit();
    assert.equal(sidebar.installingGit, true);
    assert.deepEqual(
      stateActions(sidebar),
      { init: false, refresh: false, retry: false, install: false, settings: false, clone: false },
    );
    assert.equal(sidebar.stateInstall.hidden, true);
    assert.equal(sidebar.stateSettings.hidden, true);
    const presentation = sidebar.getStatePresentation();
    assert.equal(presentation.title, "Installing Git…");
    assert.equal(presentation.busy, true);
    assert.equal(presentation.spinning, true);
    assert.equal(sidebar.stateElement.getAttribute("aria-busy"), "true");
    assert.equal(sidebar.getStateMessage(), "Installing Git…");
    calls.installListeners[0]({ packageId: "other", percent: 10 });
    assert.equal(sidebar.installProgress, null, "another package's progress is ignored");
    calls.installListeners[0]({
      packageId: "git",
      version: "2.56.1",
      step: "download",
      message: "Downloading Git 2.56.1…",
      percent: 42,
    });
    assert.match(sidebar.getStatePresentation().description, /42%/);
    assert.equal(
      sidebar.stateText.textContent,
      sidebar.getStatePresentation().description,
    );
    const progressNotification = calls.notifications[0];
    assert.equal(progressNotification.persistent, true);
    assert.equal(progressNotification.actions.length, 1);
    progressNotification.actions[0].action();
    assert.equal(calls.installCancel, 1, "the notification cancels the installation");
    pending.resolve({ success: false, code: "CANCELLED", error: "Installation cancelled." });
    assert.equal(await run, false);
    assert.equal(sidebar.installingGit, false);
    assert.equal(sidebar.installProgress, null);
    assert.equal(calls.installUnsubscribed, 1);
    assert.deepEqual(calls.setSetting, [], "a cancelled install never touches git.path");
    assert.equal(calls.notifications[calls.notifications.length - 1].type, "info");
    assert.equal(sidebar.stateInstall.hidden, false, "the user can install again");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar keeps the configured Git path when installation fails", async () => {
  const { sidebar, calls } = createSidebar({
    responses: [{ success: false, code: "GIT_NOT_FOUND", error: "missing" }],
    installResult: {
      success: false,
      packageId: "git",
      code: "CHECKSUM_MISMATCH",
      error: "Checksum mismatch for the Git archive.",
    },
  });
  try {
    await sidebar.refresh({ reason: "open" });
    const runs = trackInstallGit(sidebar);
    assert.equal(await sidebar.installGit(), false);
    assert.deepEqual(calls.setSetting, [], "a failed install never rewrites git.path");
    assert.equal(calls.status, 1, "a failed install does not refresh the status");
    const failure = calls.notifications[calls.notifications.length - 1];
    assert.equal(failure.type, "error");
    assert.match(failure.message, /Checksum mismatch/);
    assert.equal(failure.actions.length, 1);
    failure.actions[0].action();
    assert.equal(await runs[1], false);
    assert.equal(calls.install.length, 2, "the notification retries the installation");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar reports a Git path that could not be saved", async () => {
  const { sidebar, calls } = createSidebar({
    responses: [{ success: false, code: "GIT_NOT_FOUND", error: "missing" }],
    setSettingResult: false,
  });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(await sidebar.installGit(), true);
    assert.deepEqual(calls.setSetting, [
      ["git.path", "/userData/tools/git/2.56.1/bin/git"],
    ]);
    const failure = calls.notifications[calls.notifications.length - 1];
    assert.equal(failure.type, "error");
    assert.match(failure.message, /tools\/git\/2\.56\.1\/bin\/git/);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar reports an installer that is not available", async () => {
  const { sidebar, calls } = createSidebar({
    responses: [{ success: false, code: "GIT_NOT_FOUND", error: "missing" }],
    installer: null,
  });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(await sidebar.installGit(), false);
    assert.deepEqual(calls.install, []);
    assert.equal(calls.notifications[calls.notifications.length - 1].type, "error");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar ignores overlapping installs and unsubscribes on destroy", async () => {
  const pending = deferred();
  const { sidebar, calls } = createSidebar({
    responses: [{ success: false, code: "GIT_NOT_FOUND", error: "missing" }],
    installResult: () => pending.promise,
  });
  try {
    await sidebar.refresh({ reason: "open" });
    const first = sidebar.installGit();
    assert.equal(await sidebar.installGit(), false);
    assert.deepEqual(calls.install, ["git"]);
    sidebar.destroy();
    assert.equal(calls.installUnsubscribed, 1);
    pending.resolve({ success: false, code: "CANCELLED", error: "Installation cancelled." });
    assert.equal(await first, false);
    assert.deepEqual(calls.setSetting, []);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar ignores a second Initialize click while one is running", async () => {
  const pending = deferred();
  const { sidebar, calls } = createSidebar({
    responses: [
      { success: false, code: "NOT_A_REPOSITORY", error: "not a repo" },
      { success: true, status: makeStatus([]) },
    ],
    initResult: () => pending.promise,
  });
  try {
    await sidebar.refresh({ reason: "open" });
    const first = sidebar.initializeRepository();
    assert.equal(await sidebar.initializeRepository(), false);
    pending.resolve({ success: true, root: "/workspace" });
    assert.equal(await first, true);
    assert.equal(calls.init, 1);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar does not initialize outside the not-a-repository state", async () => {
  const { sidebar, calls } = createSidebar({ entries: [] });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(await sidebar.initializeRepository(), false);
    assert.equal(calls.init, 0);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar drops a stale initialization error on refresh", async () => {
  const { sidebar } = createSidebar({
    responses: [
      { success: false, code: "NOT_A_REPOSITORY", error: "not a repo" },
      { success: false, code: "NOT_A_REPOSITORY", error: "not a repo" },
    ],
    initResult: { success: false, code: "GIT_COMMAND_FAILED", error: "Git could not initialize." },
  });
  try {
    await sidebar.refresh({ reason: "open" });
    await sidebar.initializeRepository();
    assert.equal(sidebar.getStateMessage(), "Git could not initialize.");
    await sidebar.refresh({ reason: "manual" });
    assert.equal(sidebar.getStateMessage(), "This workspace is not a Git repository.");
    assert.deepEqual(
      stateActions(sidebar),
      { init: true, refresh: true, retry: false, install: false, settings: false, clone: true },
    );
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar keeps previous data only by marking it stale after a transient error", async () => {
  const { sidebar } = createSidebar({
    responses: [
      { success: true, status: makeStatus([modifiedEntry]) },
      { success: false, code: "GIT_TIMEOUT", error: "timed out" },
    ],
  });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(sidebar.getSections().changes.length, 1);
    await sidebar.refresh({ reason: "manual" });
    assert.equal(sidebar.getSections().changes.length, 1, "previous changes remain visible");
    assert.equal(sidebar.stale, true);
    assert.match(sidebar.getCommitStatusText(), /out of date/);
    assert.equal(sidebar.getStateMessage(), "", "a stale list is not replaced by a blocking state");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar resolves file paths without allowing traversal", () => {
  assert.equal(
    GitSidebar.resolveAbsolutePath("/workspace", "src/app.js"),
    "/workspace/src/app.js",
  );
  assert.equal(
    GitSidebar.resolveAbsolutePath("/workspace/", "src/app.js"),
    "/workspace/src/app.js",
  );
  assert.equal(GitSidebar.resolveAbsolutePath("/workspace", "../escape.js"), null);
  assert.equal(GitSidebar.resolveAbsolutePath("/workspace", "src/../../escape.js"), null);
  assert.equal(GitSidebar.resolveAbsolutePath("/workspace", "/etc/passwd"), null);
  assert.equal(GitSidebar.resolveAbsolutePath("/workspace", "C:/Windows/system.ini"), null);
  assert.equal(GitSidebar.resolveAbsolutePath("", "src/app.js"), null);
  assert.equal(GitSidebar.resolveAbsolutePath("/workspace", ""), null);
  assert.deepEqual(
    JSON.parse(JSON.stringify(GitSidebar.splitPath("a/very/long/directory/name.js"))),
    { name: "name.js", dir: "a/very/long/directory" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(GitSidebar.splitPath("name.js"))),
    { name: "name.js", dir: "" },
  );
});

test("GitSidebar explains a concurrent Git operation", () => {
  assert.match(
    GitSidebar.describeError({
      success: false,
      code: "GIT_INDEX_LOCKED",
      error: "Git is already running in this repository, or a previous operation was interrupted. Wait for it to finish, then retry.",
    }),
    /already running/i,
  );
});

test("GitSidebar opens staged or unstaged diffs and file context menus", async () => {
  const entry = makeEntry("src/app.js", { index: "M", worktree: "M" });
  const { sidebar, calls } = createSidebar({ entries: [entry] });
  try {
    await sidebar.refresh({ reason: "open" });
    await sidebar.openDiff(entry, true);
    const openCall = JSON.parse(JSON.stringify(calls.openDiff[0]));
    assert.equal(openCall.filePath, "/workspace/src/app.js");
    assert.equal(openCall.relativePath, "src/app.js");
    assert.equal(openCall.staged, true);
    assert.equal(openCall.statusKind, "modified");
    assert.equal(openCall.originalPath, null);
    assert.equal(openCall.versions.success, true);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.versions[0])), [
      "/workspace/src/app.js",
      { staged: true, originalPath: null },
    ]);
    await sidebar.openDiff(entry, false);
    assert.equal(calls.openDiff[1].staged, false);
    sidebar.openFileContextMenu(entry, false);
    assert.equal(calls.menus[0][0], "git-file");
    assert.equal(calls.menus[0][1].staged, false);
    sidebar.openHeaderContextMenu();
    assert.equal(calls.menus[1][0], "git-header");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar hides collapsed sections from the rendered items", async () => {
  const { sidebar } = createSidebar({ entries: [stagedEntry, modifiedEntry] });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(sidebar.toggleSection("staged"), true);
    const collapsed = sidebar.buildListItems(
      sidebar.getSections().staged,
      sidebar.getSections().changes,
    );
    assert.equal(collapsed.some((item) =>
      item.type === "entry" && item.section === "staged"), false);
    assert.equal(collapsed.some((item) =>
      item.type === "entry" && item.section === "changes"), true);
    assert.equal(sidebar.toggleSection("staged"), false);
    assert.equal(sidebar.toggleSection("unknown"), false);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar debounces file events and unsubscribes on destroy", async () => {
  const { sidebar, calls } = createSidebar();
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(calls.status, 1);
    calls.fileSystemHandler([{ event: "change", filePath: "/workspace/a.js" }]);
    calls.fileSystemHandler([{ event: "change", filePath: "/workspace/b.js" }]);
    sidebar.noteEditorSave();
    await new Promise((resolve) => setTimeout(resolve, 380));
    assert.equal(calls.status, 2, "bursts collapse into one refresh");
    sidebar.destroy();
    assert.equal(calls.unsubscribed, true);
    assert.equal(sidebar.fileScroller, null);
    sidebar.noteEditorSave();
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(calls.status, 2, "destroy cancels pending refreshes");
  } finally {
    sidebar.destroy();
  }
});

test("Git context menus expose only implemented Git actions", () => {
  const builders = loadGlobal(
    "src/js/contextMenu/GitFile.ContextMenu.js",
    "({ buildGitFileContextMenu, buildGitHeaderContextMenu })",
    { GitSidebar },
  );
  const { sidebar } = createSidebar({ entries: [modifiedEntry] });
  const editor = sidebar.editor;
  const unstaged = builders.buildGitFileContextMenu(editor)({
    sidebar,
    entry: modifiedEntry,
    staged: false,
  });
  assert.deepEqual(
    Object.keys(unstaged).filter((key) => unstaged[key].type !== "separator"),
    ["openDiff", "stage", "discard", "openFile", "copyRelativePath", "copyAbsolutePath", "refresh"],
  );
  const stagedMenu = builders.buildGitFileContextMenu(editor)({
    sidebar,
    entry: stagedEntry,
    staged: true,
  });
  assert.ok(stagedMenu.unstage);
  assert.equal(stagedMenu.stage, undefined);
  const deletedMenu = builders.buildGitFileContextMenu(editor)({
    sidebar,
    entry: makeEntry("gone.js", { worktree: "D", kind: "deleted" }),
    staged: false,
  });
  assert.equal(deletedMenu.openFile.enabled, false);
  const header = builders.buildGitHeaderContextMenu(editor)({ sidebar });
  assert.deepEqual(
    Object.keys(header),
    [
      "refresh", "history", "discardAllChanges", "discardAllStaged", "copyBranch",
      "sep2", "fetch", "pull", "push", "manageRemotes",
    ],
  );
  assert.equal(header.history.name, "Show History");
  assert.equal(header.history.enabled, false, "history needs a loaded repository status");
  sidebar.destroy();
});

test("Git header menu toggles the history section", async () => {
  const builders = loadGlobal(
    "src/js/contextMenu/GitFile.ContextMenu.js",
    "({ buildGitHeaderContextMenu })",
    { GitSidebar },
  );
  const { sidebar, calls } = createSidebar({ commits: makeCommits(2) });
  try {
    await sidebar.refresh({ reason: "open" });
    const menu = () => builders.buildGitHeaderContextMenu(sidebar.editor)({ sidebar });
    assert.equal(menu().history.enabled, true);
    assert.equal(menu().history.name, "Show History");
    menu().history.callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(sidebar.collapsed.history, false);
    assert.equal(calls.log.length, 1);
    assert.equal(menu().history.name, "Hide History");
    menu().history.callback();
    assert.equal(sidebar.collapsed.history, true);
    assert.equal(calls.log.length, 1, "hiding the section does not re-read the log");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar loads commit history only when the section is expanded", async () => {
  const commits = makeCommits(3);
  const { sidebar, calls } = createSidebar({ entries: [modifiedEntry], commits });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(calls.log.length, 0, "a collapsed history section reads nothing");
    assert.equal(sidebar.collapsed.history, true);
    const items = () => sidebar.buildListItems(
      sidebar.getSections().staged,
      sidebar.getSections().changes,
    );
    assert.equal(items().some((item) => item.type === "commit"), false);

    assert.equal(sidebar.toggleSection("history"), false, "expanding returns the collapsed flag");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(toPlain(calls.log), [{ limit: 50, skip: 0 }]);
    assert.equal(sidebar.history.commits.length, 3);
    assert.equal(sidebar.history.hasMore, false);
    const expanded = items();
    assert.deepEqual(
      toPlain(expanded.filter((item) => item.type === "commit").map((item) => item.commit.hash)),
      commits.map((commit) => commit.hash),
    );
    assert.equal(
      expanded.find((item) => item.type === "section" && item.section === "history").count,
      3,
    );
    assert.equal(sidebar.fileScroller.items.length, expanded.length);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar paginates history through Load more and the scroller tail", async () => {
  const commits = makeCommits(120);
  const { sidebar, calls } = createSidebar({ commits });
  try {
    await sidebar.refresh({ reason: "open" });
    await sidebar.showHistory();
    assert.equal(sidebar.history.commits.length, 50);
    assert.equal(sidebar.history.hasMore, true);
    const moreItem = () => sidebar.fileScroller.items.find((item) => item.type === "history-more");
    assert.ok(moreItem(), "a partial page offers more commits");

    const moreRow = sidebar.createListItem(moreItem());
    assert.equal(moreRow.dataset.action, "history-more");
    moreRow.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(toPlain(calls.log[1]), { limit: 50, skip: 50 });
    assert.equal(sidebar.history.commits.length, 100);

    sidebar.fileScroller.nearEnd();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(toPlain(calls.log[2]), { limit: 50, skip: 100 });
    assert.equal(sidebar.history.commits.length, 120);
    assert.equal(sidebar.history.hasMore, false);
    assert.equal(moreItem(), undefined);

    sidebar.fileScroller.nearEnd();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.log.length, 3, "an exhausted history stops requesting pages");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar stops loading history at its in-memory ceiling", async () => {
  const total = GitSidebar.MAX_HISTORY_COMMITS + 120;
  const { sidebar, calls } = createSidebar({ commits: makeCommits(total) });
  try {
    await sidebar.refresh({ reason: "open" });
    await sidebar.showHistory();
    while (sidebar.history.hasMore) {
      await sidebar.loadHistory();
      assert.ok(calls.log.length <= 20, "the ceiling stops the pagination loop");
    }
    assert.equal(sidebar.history.commits.length, GitSidebar.MAX_HISTORY_COMMITS);
    assert.equal(sidebar.history.truncated, true);
    const notice = sidebar.fileScroller.items.find((item) =>
      item.type === "message" &&
      item.text === `Showing the most recent ${GitSidebar.MAX_HISTORY_COMMITS} commits.`);
    assert.ok(notice, "a truncated history says so instead of offering more");
    assert.equal(
      sidebar.fileScroller.items.some((item) => item.type === "history-more"),
      false,
    );
    sidebar.fileScroller.nearEnd();
    const before = calls.log.length;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.log.length, before, "the scroller tail cannot exceed the ceiling");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar replays a history reset requested during a load", async () => {
  const pending = deferred();
  const stale = makeCommits(2);
  const fresh = [makeCommit("b".repeat(40), { subject: "feat: after commit" }), ...stale];
  let payload = stale;
  const { sidebar, calls } = createSidebar({
    commits: stale,
    logResult: (logOptions) => {
      if (calls.log.length === 1) return pending.promise;
      return { success: true, commits: payload, hasMore: false, skip: logOptions.skip };
    },
  });
  try {
    await sidebar.refresh({ reason: "open" });
    const first = sidebar.loadHistory({ reset: true });
    assert.equal(sidebar.history.loading, true);
    payload = fresh;
    assert.equal(await sidebar.loadHistory({ reset: true }), false);
    assert.equal(sidebar.history.pendingReset, true);
    pending.resolve({ success: true, commits: stale, hasMore: false });
    assert.equal(await first, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.log.length, 2, "the dropped reset is replayed");
    assert.deepEqual(toPlain(calls.log[1]), { limit: 50, skip: 0 });
    assert.equal(sidebar.history.commits.length, 3);
    assert.equal(sidebar.history.commits[0].subject, "feat: after commit");
    assert.equal(sidebar.history.pendingReset, false);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar ignores overlapping history requests", async () => {
  const pending = deferred();
  const { sidebar, calls } = createSidebar({
    commits: makeCommits(80),
    logResult: () => pending.promise,
  });
  try {
    await sidebar.refresh({ reason: "open" });
    const first = sidebar.showHistory();
    assert.equal(sidebar.history.loading, true);
    assert.equal(await sidebar.loadHistory(), false);
    assert.equal(calls.log.length, 1);
    const loadingRow = sidebar.fileScroller.items.find((item) =>
      item.type === "message" && item.text === "Loading history…");
    assert.ok(loadingRow, "a running load is visible in the list");
    pending.resolve({ success: true, commits: makeCommits(50), hasMore: true });
    assert.equal(await first, true);
    assert.equal(sidebar.history.loading, false);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar expands a commit into details and copies the full hash", async () => {
  const commit = makeCommit("f".repeat(40), {
    subject: "feat: history",
    refs: ["HEAD -> main", "tag: v1", "origin/main", "dev"],
  });
  const { sidebar, calls } = createSidebar({ commits: [commit] });
  try {
    await sidebar.refresh({ reason: "open" });
    await sidebar.showHistory();
    const row = sidebar.createListItem({ type: "commit", commit, height: 40, rowHeight: 40 });
    assert.equal(row.dataset.hash, commit.hash);
    assert.equal(row.dataset.gitFocusKey, `commit:${commit.hash}`);
    assert.equal(row.getAttribute("aria-expanded"), "false");
    const refs = row.children.find((child) => child.className === "git-commit-refs");
    assert.deepEqual(refs.children.map((badge) => badge.textContent), ["main", "tag: v1", "+2"]);
    assert.equal(refs.children[0].dataset.current, "true");
    assert.equal(refs.children[2].title, "origin/main, dev");
    const unordered = sidebar.createCommitRefs(["dev", "origin/main", "tag: v2", "HEAD -> main"]);
    assert.deepEqual(unordered.children.map((badge) => badge.textContent), ["main", "tag: v2", "+2"]);
    const branchesOnly = sidebar.createCommitRefs(["alpha", "zeta", "scroll-01"]);
    assert.deepEqual(branchesOnly.children.map((badge) => badge.textContent), ["+3"]);
    assert.equal(branchesOnly.children[0].title, "alpha, zeta, scroll-01");

    row.click();
    assert.equal(sidebar.selectedCommit, commit.hash);
    const detailItem = sidebar.fileScroller.items.find((item) => item.type === "commit-detail");
    assert.ok(detailItem, "selecting a commit inserts its detail row");
    assert.equal(detailItem.height, sidebar.commitDetailHeight(commit));
    const detail = sidebar.createListItem(detailItem);
    const rows = detail.children
      .filter((child) => child.className === "git-commit-detail-row")
      .map((child) => [
        child.children[0].textContent,
        child.children[1].textContent,
      ]);
    assert.deepEqual(rows, [
      ["Commit", commit.hash],
      ["Author", "NCE Test <nce@example.invalid>"],
      ["Date", GitSidebar.formatCommitTimestamp(commit.timestamp)],
      ["Refs", "HEAD -> main, tag: v1, origin/main, dev"],
    ]);
    detail.children[0].children[2].click();
    assert.deepEqual(calls.clipboard, [commit.hash]);

    assert.equal(sidebar.selectCommit(commit.hash), false);
    assert.equal(sidebar.selectedCommit, null);
    assert.equal(sidebar.selectCommit(""), false);
  } finally {
    sidebar.destroy();
  }
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("GitSidebar lists commit files with types and opens their diffs", async () => {
  const commits = makeCommits(2);
  const commitFiles = [
    { path: "src/new.js", originalPath: null, status: "added" },
    { path: "src/app.js", originalPath: null, status: "modified" },
    { path: "old.js", originalPath: null, status: "deleted" },
    { path: "dest.js", originalPath: "src/old.js", status: "renamed" },
  ];
  const { sidebar, calls } = createSidebar({ commits, commitFiles });
  try {
    await sidebar.refresh({ reason: "open" });
    await sidebar.showHistory();
    assert.equal(sidebar.selectCommit(commits[0].hash), true);
    await flush();
    assert.deepEqual(toPlain(calls.commitDetail), [commits[0].hash]);
    assert.equal(sidebar.commitDetail.files.length, 4);
    const detailItem = sidebar.fileScroller.items.find((item) => item.type === "commit-detail");
    assert.equal(detailItem.height, sidebar.commitDetailHeight(commits[0]));
    const detail = sidebar.createListItem(detailItem);
    const section = detail.children.find((child) => child.className === "git-commit-files");
    const fileRows = section.children.filter((child) => child.className === "git-commit-file");
    assert.deepEqual(fileRows.map((row) => row.children[0].textContent), ["A", "M", "D", "R"]);
    assert.deepEqual(fileRows.map((row) => row.dataset.path), [
      "src/new.js", "src/app.js", "old.js", "dest.js",
    ]);
    assert.equal(fileRows[3].title, "dest.js ← src/old.js");

    fileRows[3].click();
    await flush();
    assert.deepEqual(toPlain(calls.commitVersions), [[
      commits[0].hash,
      "dest.js",
      { baseHash: null, originalPath: "src/old.js" },
    ]]);
    assert.equal(calls.openDiff.length, 1);
    const opened = calls.openDiff[0];
    assert.equal(opened.filePath, "/workspace/dest.js");
    assert.equal(opened.commitHash, commits[0].hash);
    assert.equal(opened.baseHash, null);
    assert.equal(opened.statusKind, "renamed");
    assert.equal(opened.staged, false);
    assert.equal(opened.versions.success, true);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar navigates between commits from the detail panel", async () => {
  const commits = makeCommits(3);
  const { sidebar } = createSidebar({ commits });
  try {
    await sidebar.refresh({ reason: "open" });
    await sidebar.showHistory();
    sidebar.selectCommit(commits[1].hash);
    await flush();
    const navOf = (hash) => {
      const item = sidebar.fileScroller.items.find((entry) =>
        entry.type === "commit-detail" && entry.commit.hash === hash);
      const detail = sidebar.createListItem(item);
      return detail.children.find((child) => child.className === "git-commit-nav");
    };
    let nav = navOf(commits[1].hash);
    assert.equal(nav.children[0].disabled, false);
    assert.equal(nav.children[1].disabled, false);
    nav.children[1].click();
    await flush();
    assert.equal(sidebar.selectedCommit, commits[2].hash);
    nav = navOf(commits[2].hash);
    assert.equal(nav.children[1].disabled, true, "the oldest commit has no older neighbour");
    nav.children[0].click();
    await flush();
    assert.equal(sidebar.selectedCommit, commits[1].hash);
    nav = navOf(commits[1].hash);
    nav.children[0].click();
    await flush();
    assert.equal(sidebar.selectedCommit, commits[0].hash);
    nav = navOf(commits[0].hash);
    assert.equal(nav.children[0].disabled, true, "the newest commit has no newer neighbour");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar compares two commits and cancels the comparison", async () => {
  const commits = makeCommits(2);
  const compareFiles = [
    { path: "src/app.js", originalPath: null, status: "modified" },
    { path: "gone.js", originalPath: null, status: "deleted" },
  ];
  const { sidebar, calls } = createSidebar({ commits, compareFiles });
  try {
    await sidebar.refresh({ reason: "open" });
    await sidebar.showHistory();
    sidebar.selectCommit(commits[0].hash);
    await flush();
    const item = sidebar.fileScroller.items.find((entry) => entry.type === "commit-detail");
    const detail = sidebar.createListItem(item);
    const nav = detail.children.find((child) => child.className === "git-commit-nav");
    nav.children[2].click();
    assert.equal(sidebar.compareBase, commits[0].hash);
    assert.match(sidebar.notice, /Select a commit to compare/);

    assert.equal(sidebar.selectCommit(commits[1].hash), true);
    await flush();
    assert.deepEqual(toPlain(calls.compare), [[commits[0].hash, commits[1].hash]]);
    assert.equal(sidebar.compareBase, null);
    assert.equal(sidebar.selectedCommit, commits[1].hash);
    const compareItem = sidebar.fileScroller.items.find((entry) => entry.type === "compare-detail");
    assert.ok(compareItem, "the target commit shows the comparison detail");
    assert.equal(compareItem.height, sidebar.compareDetailHeight());
    const compareDetail = sidebar.createListItem(compareItem);
    assert.equal(compareDetail.children[0].children[1].textContent,
      `${commits[0].hash.slice(0, 7)} → ${commits[1].hash.slice(0, 7)}`);
    const section = compareDetail.children.find((child) => child.className === "git-commit-files");
    const fileRows = section.children.filter((child) => child.className === "git-commit-file");
    assert.equal(fileRows.length, 2);
    fileRows[0].click();
    await flush();
    assert.deepEqual(toPlain(calls.commitVersions[0]), [
      commits[1].hash,
      "src/app.js",
      { baseHash: commits[0].hash, originalPath: null },
    ]);
    assert.equal(calls.openDiff[0].baseHash, commits[0].hash);

    const cancel = compareDetail.children
      .find((child) => child.className === "git-commit-nav").children[0];
    cancel.click();
    await flush();
    assert.equal(sidebar.compare, null);
    assert.equal(sidebar.selectedCommit, commits[1].hash);
    assert.ok(sidebar.fileScroller.items.find((entry) => entry.type === "commit-detail"));
    assert.equal(calls.commitDetail.length, 2, "cancelling reloads the plain commit detail");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar cancels a pending comparison when the base commit is clicked again", async () => {
  const commits = makeCommits(2);
  const { sidebar, calls } = createSidebar({ commits });
  try {
    await sidebar.refresh({ reason: "open" });
    await sidebar.showHistory();
    sidebar.selectCommit(commits[0].hash);
    await flush();
    sidebar.beginCompare(commits[0].hash);
    assert.equal(sidebar.selectCommit(commits[0].hash), false);
    assert.equal(sidebar.compareBase, null);
    assert.equal(sidebar.notice, "");
    assert.equal(calls.compare.length, 0);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar retries a failed commit detail and reports compare failures", async () => {
  let failing = true;
  const commits = makeCommits(2);
  const { sidebar } = createSidebar({
    commits,
    commitDetailResult: () => failing
      ? { success: false, code: "GIT_TIMEOUT", error: "timeout" }
      : {
        success: true,
        commit: commits[0],
        files: [{ path: "a.txt", originalPath: null, status: "modified" }],
        truncated: false,
      },
    compareResult: { success: false, code: "GIT_COMMAND_FAILED", error: "compare failed" },
  });
  try {
    await sidebar.refresh({ reason: "open" });
    await sidebar.showHistory();
    sidebar.selectCommit(commits[0].hash);
    await flush();
    assert.equal(sidebar.commitDetail.error, "Git did not respond in time.");
    let item = sidebar.fileScroller.items.find((entry) => entry.type === "commit-detail");
    let detail = sidebar.createListItem(item);
    let section = detail.children.find((child) => child.className === "git-commit-files");
    const retry = section.children
      .find((child) => child.className === "git-commit-files-message").children
      .find((child) => child.dataset.action === "retry-commit-files");
    failing = false;
    retry.click();
    await flush();
    assert.equal(sidebar.commitDetail.error, "");
    assert.equal(sidebar.commitDetail.files.length, 1);

    sidebar.beginCompare(commits[0].hash);
    sidebar.selectCommit(commits[1].hash);
    await flush();
    assert.equal(sidebar.compare.error, "compare failed");
    item = sidebar.fileScroller.items.find((entry) => entry.type === "compare-detail");
    detail = sidebar.createListItem(item);
    section = detail.children.find((child) => child.className === "git-commit-files");
    const message = section.children.find((child) => child.className === "git-commit-files-message");
    assert.equal(message.children[0].textContent, "compare failed");
    assert.ok(message.children.find((child) => child.dataset.action === "retry-compare"));
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar drops commit detail and compare results after a workspace switch", async () => {
  const pendingDetail = deferred();
  const pendingCompare = deferred();
  const commits = makeCommits(2);
  const { sidebar, editor } = createSidebar({
    commits,
    commitDetailResult: () => pendingDetail.promise,
    compareResult: () => pendingCompare.promise,
  });
  try {
    await sidebar.refresh({ reason: "open" });
    await sidebar.showHistory();
    sidebar.selectCommit(commits[0].hash);
    sidebar.beginCompare(commits[0].hash);
    sidebar.selectCommit(commits[1].hash);
    editor.fileExplorer.rootPath = "/workspace-b";
    sidebar.handleWorkspaceChanged("/workspace-b");
    pendingDetail.resolve({ success: true, commit: commits[0], files: [], truncated: false });
    pendingCompare.resolve({ success: true, base: commits[0].hash, target: commits[1].hash, files: [], truncated: false });
    await flush();
    assert.equal(sidebar.selectedCommit, null);
    assert.equal(sidebar.commitDetail, null);
    assert.equal(sidebar.compare, null);
    assert.equal(sidebar.compareBase, null);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar explains truncated and empty commit file lists", async () => {
  const commits = makeCommits(1);
  const { sidebar } = createSidebar({
    commits,
    commitFiles: [{ path: "a.txt", originalPath: null, status: "modified" }],
    commitTruncated: true,
  });
  try {
    await sidebar.refresh({ reason: "open" });
    await sidebar.showHistory();
    sidebar.selectCommit(commits[0].hash);
    await flush();
    const item = sidebar.fileScroller.items.find((entry) => entry.type === "commit-detail");
    const detail = sidebar.createListItem(item);
    const section = detail.children.find((child) => child.className === "git-commit-files");
    const messages = section.children
      .filter((child) => child.className === "git-commit-files-message")
      .map((child) => child.children[0].textContent);
    assert.deepEqual(messages, ["Showing the first 500 files."]);

    sidebar.commitDetail = { hash: commits[0].hash, loading: false, error: "", files: [], truncated: false };
    const emptyDetail = sidebar.createListItem({ type: "commit-detail", commit: commits[0] });
    const emptySection = emptyDetail.children.find((child) => child.className === "git-commit-files");
    assert.equal(
      emptySection.children.find((child) => child.className === "git-commit-files-message").children[0].textContent,
      "No file changes.",
    );
    assert.equal(await sidebar.loadCommitDetail(""), false);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar reports history failures inline and retries them", async () => {
  let failing = true;
  const commits = makeCommits(2);
  const { sidebar, calls } = createSidebar({
    commits,
    logResult: () => failing
      ? { success: false, code: "GIT_TIMEOUT", error: "timeout" }
      : { success: true, commits, hasMore: false },
  });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(await sidebar.showHistory(), true);
    assert.equal(sidebar.history.loaded, false);
    const errorItem = sidebar.fileScroller.items.find((item) => item.action === "retry-history");
    assert.equal(errorItem.text, "Git did not respond in time.");
    const retry = sidebar.createListItem(errorItem).children
      .find((child) => child.dataset.action === "retry-history");
    failing = false;
    retry.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.log.length, 2);
    assert.equal(sidebar.history.error, "");
    assert.equal(sidebar.history.commits.length, 2);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar drops history that resolves after a workspace switch", async () => {
  const pending = deferred();
  const { sidebar, editor, calls } = createSidebar({
    commits: makeCommits(4),
    logResult: () => pending.promise,
  });
  try {
    await sidebar.refresh({ reason: "open" });
    const loading = sidebar.loadHistory({ reset: true });
    editor.fileExplorer.rootPath = "/workspace-b";
    sidebar.handleWorkspaceChanged("/workspace-b");
    pending.resolve({ success: true, commits: makeCommits(4), hasMore: false });
    assert.equal(await loading, false);
    assert.equal(sidebar.history.commits.length, 0);
    assert.equal(sidebar.history.loaded, false);
    assert.equal(sidebar.selectedCommit, null);
    assert.ok(calls.log.length >= 1);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar reloads history after commits and branches, not after watcher events", async () => {
  const { sidebar, calls } = createSidebar({ commits: makeCommits(2) });
  try {
    await sidebar.refresh({ reason: "open" });
    await sidebar.showHistory();
    assert.equal(calls.log.length, 1);
    await sidebar.refresh({ reason: "watcher" });
    assert.equal(calls.log.length, 1, "file events do not re-read the log");
    await sidebar.refresh({ reason: "commit" });
    assert.deepEqual(toPlain(calls.log[1]), { limit: 50, skip: 0 });
    await sidebar.refresh({ reason: "branch" });
    assert.equal(calls.log.length, 3);
    sidebar.toggleSection("history");
    await sidebar.refresh({ reason: "commit" });
    assert.equal(calls.log.length, 3, "a collapsed history is not re-read in the background");
    assert.equal(sidebar.history.loaded, false);
    sidebar.toggleSection("history");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(toPlain(calls.log[3]), { limit: 50, skip: 0 });
    assert.equal(sidebar.history.loaded, true);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar explains an empty history and keeps it reachable when clean", async () => {
  const { sidebar, calls } = createSidebar({ entries: [], commits: [] });
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    assert.equal(sidebar.getViewState().mode, "clean");
    assert.equal(sidebar.listElement.hidden, false);
    await sidebar.showHistory();
    assert.deepEqual(toPlain(calls.log), [{ limit: 50, skip: 0 }]);
    const empty = sidebar.fileScroller.items.find((item) =>
      item.type === "message" && item.text === "No commits yet.");
    assert.ok(empty, "an unborn repository explains the empty history");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar refuses history without a repository status or a log channel", async () => {
  const noStatus = createSidebar({ commits: makeCommits(1) });
  try {
    assert.equal(await noStatus.sidebar.showHistory(), false);
    assert.equal(await noStatus.sidebar.loadHistory(), false);
    assert.equal(noStatus.calls.log.length, 0);
  } finally {
    noStatus.sidebar.destroy();
  }

  const { sidebar, editor, calls } = createSidebar({ commits: makeCommits(1) });
  try {
    await sidebar.refresh({ reason: "open" });
    delete editor.api.git.getLog;
    assert.equal(await sidebar.loadHistory({ reset: true }), false);
    assert.equal(calls.log.length, 0);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar remembers the expanded history section", async () => {
  const first = createSidebar({ commits: makeCommits(1) });
  try {
    await first.sidebar.refresh({ reason: "open" });
    await first.sidebar.showHistory();
    assert.equal(
      JSON.parse(storageStub.getItem("nce.gitSidebar.collapsed")).history,
      false,
    );
  } finally {
    first.sidebar.destroy();
  }

  const stored = storageStub.getItem("nce.gitSidebar.collapsed");
  const restored = new GitSidebar(first.editor);
  restored.isOpen = true;
  try {
    assert.equal(restored.collapsed.history, false);
    assert.equal(JSON.parse(stored).history, false);
  } finally {
    restored.destroy();
  }
});

test("GitSidebar loads an expanded history section on open without a toggle", async () => {
  const first = createSidebar({ commits: makeCommits(2) });
  try {
    await first.sidebar.refresh({ reason: "open" });
    await first.sidebar.showHistory();
  } finally {
    first.sidebar.destroy();
  }

  // Reopen with the persisted expanded section: the log must load on open, not
  // only after a collapse/expand toggle (regression: expanded showed "History 0").
  const restored = new GitSidebar(first.editor);
  restored.isOpen = true;
  try {
    assert.equal(restored.collapsed.history, false);
    assert.equal(restored.history.loaded, false);
    await restored.refresh({ reason: "open" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(restored.history.loaded, true);
    assert.equal(restored.history.commits.length, 2);
    const section = restored.buildListItems(
      restored.getSections().staged,
      restored.getSections().changes,
    ).find((item) => item.type === "section" && item.section === "history");
    assert.equal(section.count, 2, "the expanded history shows its real count on open");
  } finally {
    restored.destroy();
  }
});

test("GitSidebar formats commit hashes and dates for the history rows", () => {
  assert.equal(GitSidebar.shortHash("0123456789abcdef"), "0123456");
  assert.equal(GitSidebar.shortHash(""), "");
  const now = Date.UTC(2026, 10, 12, 12, 0, 0);
  const seconds = (value) => Math.floor(value / 1000);
  assert.equal(GitSidebar.formatCommitDate(seconds(now - 30_000), now), "just now");
  assert.equal(GitSidebar.formatCommitDate(seconds(now - 5 * 60_000), now), "5 minutes ago");
  assert.equal(GitSidebar.formatCommitDate(seconds(now - 3 * 3_600_000), now), "3 hours ago");
  assert.equal(GitSidebar.formatCommitDate(seconds(now - 2 * 86_400_000), now), "2 days ago");
  assert.equal(
    GitSidebar.formatCommitDate(seconds(Date.UTC(2026, 0, 3, 8, 5, 0)), now),
    "2026-01-03",
  );
  assert.equal(
    GitSidebar.formatCommitTimestamp(seconds(Date.UTC(2026, 0, 3, 8, 5, 0))),
    "2026-01-03 08:05 UTC",
  );
  assert.equal(GitSidebar.formatCommitDate(0), "");
});



test("GitSidebar keeps failures out of diff tabs and reports them inline", async () => {
  const { sidebar, calls } = createSidebar({
    entries: [modifiedEntry],
    versionsResult: { success: false, code: "GIT_NOT_FOUND", error: "missing git" },
  });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(await sidebar.openDiff(modifiedEntry, false), null);
    assert.equal(calls.openDiff.length, 0);
    assert.match(sidebar.getCommitStatusText(), /Git is not installed/);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar drops a diff that resolves after a workspace switch", async () => {
  const pending = deferred();
  const { sidebar, editor, calls } = createSidebar({
    entries: [modifiedEntry],
    versionsResult: () => pending.promise,
  });
  try {
    await sidebar.refresh({ reason: "open" });
    const opening = sidebar.openDiff(modifiedEntry, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    editor.fileExplorer.rootPath = "/workspace-b";
    sidebar.handleWorkspaceChanged("/workspace-b");
    pending.resolve({
      success: true,
      oldContent: "a\n",
      newContent: "b\n",
      binary: false,
      tooLarge: false,
      untracked: false,
      deleted: false,
    });
    assert.equal(await opening, null);
    assert.equal(calls.openDiff.length, 0);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar ignores stage results from a previous workspace", async () => {
  const pending = deferred();
  const { sidebar, editor, calls } = createSidebar({
    entries: [modifiedEntry],
    stageResult: () => pending.promise,
  });
  try {
    await sidebar.refresh({ reason: "open" });
    const staging = sidebar.toggleStage(modifiedEntry, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    editor.fileExplorer.rootPath = "/workspace-b";
    sidebar.handleWorkspaceChanged("/workspace-b");
    pending.resolve({ success: true, path: "/workspace/src/app.js" });
    assert.equal(await staging, false);
    assert.doesNotMatch(sidebar.getCommitStatusText(), /Staged src\/app\.js/);
    assert.equal(calls.unstage.length, 0);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar keeps one commit draft per workspace", async () => {
  const { sidebar, editor, calls } = createSidebar({ entries: [stagedEntry] });
  try {
    await sidebar.refresh({ reason: "open" });
    sidebar.commitMessage = "message for workspace A";
    editor.fileExplorer.rootPath = "/workspace-b";
    sidebar.handleWorkspaceChanged("/workspace-b");
    assert.equal(sidebar.commitMessage, "");
    sidebar.commitMessage = "message for workspace B";
    editor.fileExplorer.rootPath = "/workspace";
    sidebar.handleWorkspaceChanged("/workspace");
    assert.equal(sidebar.commitMessage, "message for workspace A");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await sidebar.refresh({ reason: "manual" });
    assert.equal(await sidebar.commitChanges(), true);
    assert.equal(sidebar.commitDrafts.has("/workspace"), false);
    assert.deepEqual(calls.commit, ["message for workspace A"]);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar disables commit on stale data and caches sections", async () => {
  const { sidebar } = createSidebar({ entries: [stagedEntry] });
  try {
    await sidebar.refresh({ reason: "open" });
    sidebar.commitMessage = "fix";
    assert.equal(sidebar.canCommit(), true);
    assert.equal(sidebar.getSections(), sidebar.getSections());
    sidebar.stale = true;
    assert.equal(sidebar.canCommit(), false);
    sidebar.stale = false;
    assert.equal(sidebar.canCommit(), true);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar preserves POSIX backslashes in file names", () => {
  assert.equal(
    GitSidebar.resolveAbsolutePath("/workspace", "a\\b.txt"),
    "/workspace/a\\b.txt",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(GitSidebar.splitPath("dir/a\\b.txt"))),
    { name: "a\\b.txt", dir: "dir" },
  );
});

test("GitSidebar refreshes open diff tabs without stealing focus", async () => {
  const { sidebar, editor, calls } = createSidebar({ entries: [modifiedEntry] });
  try {
    await sidebar.refresh({ reason: "open" });
    const tab = {
      type: "git-diff",
      filePath: "/workspace/src/app.js",
      relativePath: "src/app.js",
      staged: false,
      statusKind: "modified",
      originalPath: null,
    };
    editor.tabManager.tabs = [tab];
    await sidebar.refreshDiffTabs();
    assert.equal(calls.openDiff.length, 1);
    assert.equal(calls.openDiff[0].focus, false);
    assert.equal(calls.versions.length >= 1, true);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar explains output limits without offering a useless retry", async () => {
  const { sidebar } = createSidebar({ entries: [] });
  try {
    sidebar.workspaceRoot = "/workspace";
    sidebar.applyStatusError({ code: "GIT_OUTPUT_LIMIT", error: "too much" });
    assert.equal(sidebar.status, null);
    assert.equal(sidebar.error.code, "GIT_OUTPUT_LIMIT");
    assert.match(sidebar.getStateMessage(), /Too many changes/);
    assert.deepEqual(
      stateActions(sidebar),
      { init: false, refresh: false, retry: false, install: false, settings: false, clone: false },
      "output limits offer no useless action",
    );
  } finally {
    sidebar.destroy();
  }
});

test("Git UI is wired into the renderer manifest and editor", () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(root, "src/js/main/renderer-scripts.json"),
    "utf8",
  ));
  const editor = fs.readFileSync(path.join(root, "src/js/main/Editor.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "src/html/index.html"), "utf8");
  const tabTypes = fs.readFileSync(path.join(root, "src/js/types/Tab.js"), "utf8");
  const states = fs.readFileSync(path.join(root, "src/js/manager/StatesManager.js"), "utf8");
  const index = (script) => manifest.indexOf(script);
  assert.ok(index("js/core/LineDiff.js") >= 0);
  assert.ok(index("js/core/GitDiffBuffer.js") >= 0);
  assert.ok(index("js/sidebar/Git.Sidebar.js") >= 0);
  assert.ok(index("js/contextMenu/GitFile.ContextMenu.js") >= 0);
  assert.ok(index("js/sidebar/Git.Sidebar.js") < index("js/main/Editor.js"));
  assert.ok(index("js/contextMenu/GitFile.ContextMenu.js") < index("js/main/Editor.js"));
  assert.equal(index("js/view/GitDiffView.js"), -1);
  assert.match(editor, /new GitSidebar\(this\)/);
  assert.match(editor, /this\.sidebarManager\.registerMenu\(this\.gitSidebar\)/);
  assert.match(editor, /buildGitFileContextMenu\(this\)/);
  assert.match(editor, /TAB_TYPES\.GIT_DIFF/);
  assert.match(editor, /editor-git-diff-active/);
  assert.doesNotMatch(html, /git-diff-view-host/);
  assert.doesNotMatch(html, /gitDiffView\.css/);
  assert.match(html, /\.\.\/css\/sidebar\/git\.css/);
  assert.match(tabTypes, /GIT_DIFF:\s*"git-diff"/);
  assert.match(tabTypes, /class GitDiffTab extends Tab/);
  assert.match(states, /tab\.type === TAB_TYPES\.GIT_DIFF\) return \[\]/);
  const application = fs.readFileSync(
    path.join(root, "src/config/Application.js"),
    "utf8",
  );
  assert.match(
    application,
    /id:\s*"git",\s*\n\s*title:\s*"Source Control",\s*\n\s*icon:\s*"fi fi-rr-code-branch",\s*\n\s*position:\s*"left"/,
  );
});

const selectionEntries = [
  makeEntry("a.js", { worktree: "M" }),
  makeEntry("b.js", { worktree: "M" }),
  makeEntry("c.js", { worktree: "M" }),
];

const selectionKeys = (sidebar) => Array.from(sidebar.selectedEntries.keys()).sort();

test("GitSidebar selects rows with modifier clicks and clears on plain click", async () => {
  const { sidebar, calls } = createSidebar({ entries: selectionEntries });
  try {
    await sidebar.refresh({ reason: "open" });
    const [a, b, c] = selectionEntries;
    const rowFor = (entry) => sidebar.createEntryRow(entry, "changes");
    rowFor(a).dispatch("click", { ctrlKey: true });
    assert.deepEqual(selectionKeys(sidebar), ["c:a.js"]);
    assert.ok(rowFor(a).classList.contains("is-selected"));
    rowFor(b).dispatch("click", { metaKey: true });
    assert.deepEqual(selectionKeys(sidebar), ["c:a.js", "c:b.js"]);
    rowFor(c).dispatch("click", { shiftKey: true });
    assert.deepEqual(selectionKeys(sidebar), ["c:a.js", "c:b.js", "c:c.js"]);
    rowFor(b).dispatch("click", {});
    assert.equal(sidebar.selectedEntries.size, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.openDiff.length, 1, "a plain click still opens the diff");
    assert.equal(sidebar.selectionAnchor, null);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar shift-click stays inside one section and Delete asks to discard", async () => {
  const staged = makeEntry("a.js", { index: "M" });
  const { sidebar } = createSidebar({ entries: [staged, ...selectionEntries] });
  try {
    await sidebar.refresh({ reason: "open" });
    sidebar.createEntryRow(selectionEntries[0], "changes")
      .dispatch("click", { ctrlKey: true });
    sidebar.createEntryRow(staged, "staged").dispatch("click", { shiftKey: true });
    assert.deepEqual(selectionKeys(sidebar), ["c:a.js", "s:a.js"]);
    const row = sidebar.createEntryRow(selectionEntries[1], "changes");
    row.dispatch("keydown", { key: "Delete" });
    assert.equal(sidebar.operationDialog?.open, true);
    assert.equal(sidebar.operationDialog.dataset.mode, "discard");
    sidebar.operationDialogCancelButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(sidebar.operationDialog.open, false);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar discards a single change through the confirmation dialog", async () => {
  const { sidebar, calls } = createSidebar({ entries: [modifiedEntry] });
  try {
    await sidebar.refresh({ reason: "open" });
    const cancelled = sidebar.requestDiscard([{ entry: modifiedEntry, staged: false }]);
    const dialog = sidebar.operationDialog;
    assert.equal(dialog.open, true);
    assert.equal(dialog.dataset.mode, "discard");
    assert.equal(sidebar.operationDialogTitle.textContent, "Discard Change");
    assert.equal(
      sidebar.operationDialogMessage.textContent,
      "These working tree changes will be reverted.",
    );
    assert.equal(sidebar.operationDialogFiles.children.length, 1);
    assert.equal(
      sidebar.operationDialogFiles.children[0].children[1].textContent,
      "src/app.js",
    );
    assert.equal(sidebar.operationDialogCheckboxLabel.hidden, true);
    assert.equal(sidebar.operationDialogCancelButton.focused, true);
    sidebar.operationDialogCancelButton.click();
    assert.equal(await cancelled, false);
    assert.equal(dialog.open, false);
    assert.equal(calls.discard.length, 0);

    const before = calls.status;
    const confirmed = sidebar.requestDiscard([{ entry: modifiedEntry, staged: false }]);
    sidebar.operationDialogConfirmButton.click();
    assert.equal(await confirmed, true);
    assert.deepEqual(toPlain(calls.discard), [[{ path: "src/app.js", originalPath: null }]]);
    assert.match(sidebar.getCommitStatusText(), /Discarded 1 change/);
    assert.ok(calls.status > before, "a successful discard refreshes the status");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar builds discard entries for staged, untracked and renamed scopes", async () => {
  const renamed = makeEntry("new.js", { index: "R", kind: "renamed", originalPath: "old.js" });
  const untracked = makeEntry("notes.md", { worktree: "?", kind: "untracked" });
  const modified = makeEntry("lib/b.js", { worktree: "M" });
  const { sidebar, calls } = createSidebar({ entries: [renamed, untracked, modified] });
  try {
    await sidebar.refresh({ reason: "open" });
    const stagedRequest = sidebar.requestDiscardAll("staged");
    assert.equal(sidebar.operationDialogTitle.textContent, "Discard Staged Change");
    assert.equal(
      sidebar.operationDialogFiles.children[0].children[1].textContent,
      "new.js ← old.js",
    );
    sidebar.operationDialogConfirmButton.click();
    assert.equal(await stagedRequest, true);
    assert.deepEqual(toPlain(calls.discard[0]), [
      { path: "new.js", originalPath: "old.js", staged: true },
    ]);

    const changesRequest = sidebar.requestDiscardAll("changes");
    assert.equal(sidebar.operationDialogTitle.textContent, "Discard 2 Changes");
    assert.equal(
      sidebar.operationDialogMessage.textContent,
      "Tracked changes will be reverted and untracked files will be permanently deleted.",
    );
    sidebar.operationDialogConfirmButton.click();
    assert.equal(await changesRequest, true);
    assert.deepEqual(toPlain(calls.discard[1]), [
      { path: "notes.md", untracked: true },
      { path: "lib/b.js", originalPath: null },
    ]);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar offers the also-staged checkbox only for tracked counterparts", async () => {
  const mixed = makeEntry("src/app.js", { index: "M", worktree: "M" });
  const untracked = makeEntry("notes.md", { worktree: "?", kind: "untracked" });
  const { sidebar, calls } = createSidebar({ entries: [mixed, untracked] });
  try {
    await sidebar.refresh({ reason: "open" });
    const withStaged = sidebar.requestDiscard([{ entry: mixed, staged: false }]);
    assert.equal(sidebar.operationDialogCheckboxLabel.hidden, false);
    sidebar.operationDialogCheckbox.checked = true;
    sidebar.operationDialogConfirmButton.click();
    assert.equal(await withStaged, true);
    assert.deepEqual(toPlain(calls.discard[0]), [
      { path: "src/app.js", originalPath: null },
      { path: "src/app.js", originalPath: null, staged: true },
    ]);

    const untrackedOnly = sidebar.requestDiscard([{ entry: untracked, staged: false }]);
    assert.equal(sidebar.operationDialogCheckboxLabel.hidden, true);
    assert.equal(
      sidebar.operationDialogMessage.textContent,
      "This untracked file will be permanently deleted.",
    );
    sidebar.operationDialogConfirmButton.click();
    assert.equal(await untrackedOnly, true);
    assert.deepEqual(toPlain(calls.discard[1]), [{ path: "notes.md", untracked: true }]);

    const stagedOnly = sidebar.requestDiscard([{ entry: mixed, staged: true }]);
    assert.equal(sidebar.operationDialogCheckboxLabel.hidden, true);
    sidebar.operationDialogConfirmButton.click();
    assert.equal(await stagedOnly, true);
    assert.deepEqual(toPlain(calls.discard[2]), [
      { path: "src/app.js", originalPath: null, staged: true },
    ]);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar excludes conflicted and stale entries from discard", async () => {
  const conflicted = makeEntry("u.js", {
    index: "U",
    worktree: "U",
    kind: "conflicted",
    conflicted: true,
  });
  const ok = makeEntry("ok.js", { worktree: "M" });
  const { sidebar, calls } = createSidebar({ entries: [conflicted, ok] });
  try {
    await sidebar.refresh({ reason: "open" });
    assert.equal(
      await sidebar.requestDiscard([{ entry: conflicted, staged: false }]),
      false,
    );
    assert.equal(sidebar.operationDialog, null, "no dialog for conflicted-only requests");
    assert.match(sidebar.actionError, /no changes to discard/i);
    assert.equal(
      await sidebar.requestDiscard([{ entry: makeEntry("gone.js", { worktree: "M" }), staged: false }]),
      false,
    );

    const request = sidebar.requestDiscardAll("changes");
    assert.equal(sidebar.operationDialogFiles.children.length, 1);
    assert.equal(
      sidebar.operationDialogFiles.children[0].children[1].textContent,
      "ok.js",
    );
    sidebar.operationDialogConfirmButton.click();
    assert.equal(await request, true);
    assert.deepEqual(toPlain(calls.discard), [[{ path: "ok.js", originalPath: null }]]);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar discards the whole multi-selection and clears it afterwards", async () => {
  const { sidebar, calls } = createSidebar({ entries: selectionEntries });
  try {
    await sidebar.refresh({ reason: "open" });
    sidebar.toggleEntrySelection(selectionEntries[0], false);
    sidebar.toggleEntrySelection(selectionEntries[1], false);
    const targets = sidebar.resolveDiscardTargetsFor(selectionEntries[0], false);
    assert.equal(targets.length, 2);
    const request = sidebar.requestDiscard(targets);
    assert.equal(sidebar.operationDialogTitle.textContent, "Discard 2 Changes");
    sidebar.operationDialogConfirmButton.click();
    assert.equal(await request, true);
    assert.deepEqual(toPlain(calls.discard), [[
      { path: "a.js", originalPath: null },
      { path: "b.js", originalPath: null },
    ]]);
    assert.equal(sidebar.selectedEntries.size, 0);
    assert.match(sidebar.getCommitStatusText(), /Discarded 2 changes/);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar section headers expose a guarded discard-all button", async () => {
  const conflicted = makeEntry("u.js", {
    index: "U",
    worktree: "U",
    kind: "conflicted",
    conflicted: true,
  });
  const { sidebar } = createSidebar({ entries: [modifiedEntry] });
  try {
    await sidebar.refresh({ reason: "open" });
    const header = sidebar.createSectionHeader({ section: "changes", title: "Changes", count: 1 });
    const discard = header.children.find((child) => child.dataset?.action === "discard-all");
    assert.ok(discard, "the changes header has a discard-all action");
    assert.equal(discard.disabled, false);
    discard.click();
    assert.equal(sidebar.operationDialog?.open, true);
    sidebar.operationDialogCancelButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    sidebar.status = makeStatus([conflicted]);
    const conflictedHeader = sidebar.createSectionHeader({ section: "changes", title: "Changes", count: 1 });
    const conflictedDiscard = conflictedHeader.children
      .find((child) => child.dataset?.action === "discard-all");
    assert.equal(conflictedDiscard.disabled, true, "conflicted-only sections cannot discard");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar reports discard failures with a retry notification", async () => {
  const { sidebar, calls } = createSidebar({
    entries: [modifiedEntry],
    discardResult: { success: false, code: "GIT_COMMAND_FAILED", error: "boom" },
  });
  try {
    await sidebar.refresh({ reason: "open" });
    const request = sidebar.requestDiscard([{ entry: modifiedEntry, staged: false }]);
    sidebar.operationDialogConfirmButton.click();
    assert.equal(await request, false);
    assert.equal(sidebar.actionError, "boom");
    assert.equal(calls.notifications.length, 1);
    assert.equal(calls.notifications[0].title, "Could not discard changes");
    assert.equal(calls.notifications[0].actions[0].label, "Retry");
    calls.notifications[0].actions[0].action();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.discard.length, 2, "retry re-runs the discard without a new dialog");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar ignores discard results after a workspace switch", async () => {
  const gate = deferred();
  const { sidebar, calls } = createSidebar({
    entries: [modifiedEntry],
    discardResult: () => gate.promise,
  });
  try {
    await sidebar.refresh({ reason: "open" });
    const request = sidebar.requestDiscard([{ entry: modifiedEntry, staged: false }]);
    sidebar.operationDialogConfirmButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(sidebar.discarding, true);
    sidebar.handleWorkspaceChanged("/other");
    gate.resolve({ success: true, discarded: ["src/app.js"] });
    assert.equal(await request, false);
    assert.equal(sidebar.notice, "");
    assert.equal(sidebar.discarding, false);
    assert.equal(calls.discard.length, 1);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar shows the merge banner and aborts through confirmation", async () => {
  const conflicted = makeEntry("u.js", {
    index: "U",
    worktree: "U",
    kind: "conflicted",
    conflicted: true,
  });
  const { sidebar, calls } = createSidebar({
    responses: [
      { success: true, status: makeStatus([conflicted], { merging: true }) },
      { success: true, status: makeStatus([]) },
    ],
  });
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    assert.equal(sidebar.operationBanner.hidden, false);
    assert.equal(sidebar.operationBannerText.textContent, "A merge is in progress.");
    assert.equal(sidebar.operationBannerButton.textContent, "Abort Merge");
    sidebar.operationBannerButton.click();
    const dialog = sidebar.operationDialog;
    assert.equal(dialog.open, true);
    assert.equal(dialog.dataset.mode, "abort");
    assert.equal(sidebar.operationDialogTitle.textContent, "Abort Merge");
    assert.equal(sidebar.operationDialogFiles.hidden, true);
    assert.equal(sidebar.operationDialogCheckboxLabel.hidden, true);
    sidebar.operationDialogCancelButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.abort.length, 0, "cancelling never aborts");

    sidebar.operationBannerButton.click();
    sidebar.operationDialogConfirmButton.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(toPlain(calls.abort), ["merge"]);
    assert.match(sidebar.getCommitStatusText(), /Aborted the merge/);
    assert.equal(sidebar.operationBanner.hidden, true, "the banner hides once the merge is gone");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar aborts a rebase and hides the banner when no operation is active", async () => {
  const { sidebar, calls } = createSidebar({
    responses: [
      { success: true, status: makeStatus([], { rebasing: true }) },
      { success: true, status: makeStatus([]) },
    ],
  });
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    assert.equal(sidebar.operationBannerButton.textContent, "Abort Rebase");
    assert.equal(sidebar.operationBannerText.textContent, "A rebase is in progress.");
    sidebar.operationBannerButton.click();
    assert.equal(sidebar.operationDialogTitle.textContent, "Abort Rebase");
    sidebar.operationDialogConfirmButton.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(toPlain(calls.abort), ["rebase"]);
    assert.equal(sidebar.operationBanner.hidden, true);
    assert.equal(await sidebar.requestAbortOperation(), false, "no operation, no abort");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar guards the operation dialog against reentry and Escape", async () => {
  const { sidebar, calls } = createSidebar({ entries: [modifiedEntry] });
  try {
    await sidebar.refresh({ reason: "open" });
    const first = sidebar.requestDiscard([{ entry: modifiedEntry, staged: false }]);
    const session = sidebar.operationDialogSession;
    assert.equal(
      await sidebar.requestDiscard([{ entry: modifiedEntry, staged: false }]),
      false,
      "a second request while the dialog is open is rejected",
    );
    assert.equal(sidebar.operationDialogSession, session);
    assert.equal(sidebar.operationDialog.open, true);
    let prevented = false;
    assert.equal(
      sidebar.handleOperationDialogKeyDown({
        key: "Escape",
        preventDefault() { prevented = true; },
        stopPropagation() {},
      }),
      true,
    );
    assert.equal(prevented, true);
    assert.equal(await first, false);
    assert.equal(sidebar.operationDialog.open, false);
    assert.equal(calls.discard.length, 0);
    assert.equal(sidebar.handleOperationDialogKeyDown({ key: "Escape" }), false);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar prunes the selection when entries disappear on refresh", async () => {
  const { sidebar } = createSidebar({
    responses: [
      { success: true, status: makeStatus(selectionEntries) },
      { success: true, status: makeStatus([selectionEntries[0]]) },
    ],
  });
  try {
    await sidebar.refresh({ reason: "open" });
    sidebar.toggleEntrySelection(selectionEntries[0], false);
    sidebar.toggleEntrySelection(selectionEntries[1], false);
    await sidebar.refresh({ reason: "watcher" });
    assert.deepEqual(selectionKeys(sidebar), ["c:a.js"]);
  } finally {
    sidebar.destroy();
  }
});

test("Git menus discard the selection and expose discard-all in the header", async () => {
  const builders = loadGlobal(
    "src/js/contextMenu/GitFile.ContextMenu.js",
    "({ buildGitFileContextMenu, buildGitHeaderContextMenu })",
    { GitSidebar },
  );
  const { sidebar } = createSidebar({ entries: selectionEntries });
  try {
    await sidebar.refresh({ reason: "open" });
    sidebar.toggleEntrySelection(selectionEntries[0], false);
    sidebar.toggleEntrySelection(selectionEntries[1], false);
    const menu = builders.buildGitFileContextMenu(sidebar.editor)({
      sidebar,
      entry: selectionEntries[0],
      staged: false,
    });
    assert.equal(menu.discard.name, "Discard 2 Changes…");
    assert.equal(menu.discard.enabled, true);
    menu.discard.callback();
    assert.equal(sidebar.operationDialog.open, true);
    assert.equal(sidebar.operationDialogTitle.textContent, "Discard 2 Changes");
    sidebar.operationDialogCancelButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const single = builders.buildGitFileContextMenu(sidebar.editor)({
      sidebar,
      entry: selectionEntries[2],
      staged: false,
    });
    assert.equal(single.discard.name, "Discard Changes…");
    const stagedMenu = builders.buildGitFileContextMenu(sidebar.editor)({
      sidebar,
      entry: makeEntry("a.js", { index: "M" }),
      staged: true,
    });
    assert.equal(stagedMenu.discard.name, "Discard Staged Changes…");
    const conflictedMenu = builders.buildGitFileContextMenu(sidebar.editor)({
      sidebar,
      entry: makeEntry("u.js", { kind: "conflicted", conflicted: true, index: "U", worktree: "U" }),
      staged: false,
    });
    assert.equal(conflictedMenu.discard.enabled, false);

    const header = builders.buildGitHeaderContextMenu(sidebar.editor)({ sidebar });
    assert.equal(header.discardAllChanges.enabled, true);
    assert.equal(header.discardAllStaged.enabled, false);
    header.discardAllChanges.callback();
    assert.equal(sidebar.operationDialog.open, true);
    sidebar.operationDialogCancelButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    sidebar.destroy();
  }
});

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

test("GitSidebar sync helpers describe success and failure per operation", () => {
  assert.equal(GitSidebar.syncSuccessTitle("fetch"), "Fetched");
  assert.equal(GitSidebar.syncSuccessTitle("pull"), "Pulled");
  assert.equal(GitSidebar.syncSuccessTitle("push"), "Pushed");
  assert.equal(GitSidebar.syncFailureTitle("fetch"), "Fetch failed");
  assert.equal(GitSidebar.syncFailureTitle("pull"), "Pull failed");
  assert.equal(GitSidebar.syncFailureTitle("push"), "Push failed");
  assert.equal(
    GitSidebar.syncSuccessMessage("fetch", { all: true }),
    "Fetched updates from all remotes.",
  );
  assert.equal(
    GitSidebar.syncSuccessMessage("fetch", { remote: "upstream" }),
    "Fetched updates from upstream.",
  );
  assert.equal(
    GitSidebar.syncSuccessMessage("pull", { alreadyUpToDate: true }),
    "Already up to date.",
  );
  assert.equal(
    GitSidebar.syncSuccessMessage("push", { remote: "origin", branch: "main" }),
    "Pushed main to origin.",
  );
  assert.equal(
    GitSidebar.syncSuccessMessage("push", { remote: "origin", branch: "main", forced: true }),
    "Force pushed main to origin with lease.",
  );
});

test("GitSidebar renders the sync bar with ahead and behind badges", async () => {
  const { sidebar } = createSidebar({
    responses: [
      { success: true, status: makeStatus([], { branch: { ahead: 2, behind: 3 } }) },
    ],
  });
  try {
    sidebar.render();
    assert.equal(sidebar.syncBar.hidden, true, "hidden before status loads");
    await sidebar.refresh({ reason: "open" });
    assert.equal(sidebar.syncBar.hidden, false);
    assert.equal(sidebar.syncPullCount.hidden, false);
    assert.equal(sidebar.syncPullCount.textContent, "3");
    assert.equal(sidebar.syncPushCount.hidden, false);
    assert.equal(sidebar.syncPushCount.textContent, "2");
    assert.equal(sidebar.syncStatus.hidden, true);
    assert.equal(sidebar.syncCancelButton.hidden, true);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar hides the sync count badges when there is nothing to sync", async () => {
  const { sidebar } = createSidebar();
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    assert.equal(sidebar.syncBar.hidden, false);
    assert.equal(sidebar.syncPullCount.hidden, true);
    assert.equal(sidebar.syncPushCount.hidden, true);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar fetches, pulls and pushes through the Git API and notifies success", async () => {
  const { sidebar, calls } = createSidebar();
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    assert.equal(await sidebar.fetchChanges(), true);
    assert.deepEqual(toPlain(calls.fetch), [{}]);
    assert.equal(await sidebar.pullChanges(), true);
    assert.deepEqual(toPlain(calls.pull), [{}]);
    assert.equal(await sidebar.pushChanges(), true);
    assert.deepEqual(toPlain(calls.push), [{}]);
    const titles = calls.notifications.map((note) => note.title);
    assert.ok(titles.includes("Fetched"));
    assert.ok(titles.includes("Pulled"));
    assert.ok(titles.includes("Pushed"));
    assert.equal(sidebar.syncing, null);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar shows network progress only for the running operation and cancels it", async () => {
  const { sidebar, calls } = createSidebar();
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    sidebar.syncing = "fetch";
    sidebar.handleNetworkProgress({ operation: "push", phase: "Writing objects", percent: 90 });
    assert.equal(sidebar.syncProgress, null, "progress for another operation is ignored");
    sidebar.handleNetworkProgress({ operation: "fetch", phase: "Receiving objects", percent: 42 });
    assert.equal(sidebar.syncStatus.hidden, false);
    assert.match(sidebar.syncStatus.textContent, /Fetching… Receiving objects 42%/);
    assert.equal(sidebar.syncCancelButton.hidden, false);
    assert.equal(await sidebar.cancelSync(), true);
    assert.equal(calls.cancelNetwork, 1);
    sidebar.syncing = null;
    assert.equal(await sidebar.cancelSync(), false, "no cancel when idle");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar prevents overlapping sync operations and ignores stale workspace results", async () => {
  const gate = deferred();
  const { sidebar, calls } = createSidebar({
    fetchResult: () => gate.promise,
  });
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    const first = sidebar.fetchChanges();
    await tick();
    assert.equal(sidebar.syncing, "fetch");
    assert.equal(await sidebar.pushChanges(), false, "a second sync is rejected while busy");
    assert.equal(calls.push.length, 0);
    sidebar.applyWorkspace("/other-workspace");
    gate.resolve({ success: true, remote: "origin", all: false });
    assert.equal(await first, false, "a result from the previous workspace is discarded");
    assert.equal(sidebar.syncing, null);
    assert.equal(calls.notifications.length, 0, "no success notification for a stale result");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar offers Pull and Force With Lease when a push is rejected", async () => {
  const { sidebar, calls } = createSidebar({
    pushResult: { success: false, code: "PUSH_REJECTED", error: "non-fast-forward" },
  });
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    assert.equal(await sidebar.pushChanges(), false);
    const note = calls.notifications.find((item) => item.title === "Push rejected");
    assert.ok(note, "a push rejection is reported");
    assert.equal(note.persistent, true);
    const labels = note.actions.map((action) => action.label);
    assert.deepEqual(toPlain(labels), ["Pull", "Force With Lease…"]);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar proposes publishing the branch when a push has no upstream", async () => {
  const { sidebar, calls } = createSidebar({
    pushResult: { success: false, code: "NO_UPSTREAM", error: "no upstream" },
  });
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    await sidebar.pushChanges();
    const note = calls.notifications.find((item) => item.title === "No upstream branch");
    assert.ok(note);
    assert.equal(note.actions[0].label, "Publish Branch");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar asks for a pull strategy and replays the pull with the chosen mode", async () => {
  let pullCalls = 0;
  const { sidebar, calls } = createSidebar({
    pullResult: () => {
      pullCalls += 1;
      return pullCalls === 1
        ? { success: false, code: "PULL_STRATEGY_REQUIRED", error: "divergent" }
        : { success: true, summary: "ok", alreadyUpToDate: false };
    },
  });
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    await sidebar.pullChanges();
    const config = calls.quickPanel.find((item) => item.id === "git-pull-strategy");
    assert.ok(config, "the pull strategy picker opens");
    assert.deepEqual(toPlain(config.items.map((item) => item.id)), ["merge", "rebase"]);
    config.onAccept({ id: "rebase" });
    await tick();
    assert.deepEqual(toPlain(calls.pull), [{}, { rebase: true }]);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar offers to add a remote when none is configured", async () => {
  const { sidebar, calls } = createSidebar({
    fetchResult: { success: false, code: "NO_REMOTE", error: "no remote" },
  });
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    await sidebar.fetchChanges();
    const note = calls.notifications.find((item) => item.title === "No remote configured");
    assert.ok(note);
    assert.equal(note.actions[0].label, "Add Remote");
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar reports authentication failures persistently without retrying silently", async () => {
  const { sidebar, calls } = createSidebar({
    fetchResult: { success: false, code: "AUTH_REQUIRED", error: "authentication failed" },
  });
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    await sidebar.fetchChanges();
    const note = calls.notifications.find((item) => item.title === "Authentication required");
    assert.ok(note);
    assert.equal(note.persistent, true);
    assert.equal(note.actions, undefined);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar treats a cancelled sync as a neutral notice", async () => {
  const { sidebar, calls } = createSidebar({
    fetchResult: { success: false, code: "OPERATION_CANCELLED", error: "cancelled" },
  });
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    await sidebar.fetchChanges();
    assert.match(sidebar.getCommitStatusText(), /cancelled/);
    assert.equal(calls.notifications.length, 0);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar force pushes with lease only after an explicit confirmation", async () => {
  const { sidebar, calls } = createSidebar({
    remotes: [{ name: "origin", fetchUrl: "https://example.invalid/repo.git", pushUrl: null }],
    defaultRemote: "origin",
  });
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    const cancelled = sidebar.requestForcePush({ remote: "origin", branch: "main" });
    await tick();
    assert.equal(sidebar.operationDialog.open, true);
    assert.equal(sidebar.operationDialog.dataset.mode, "force-push");
    assert.equal(sidebar.operationDialogTitle.textContent, "Force Push With Lease");
    sidebar.operationDialogCancelButton.click();
    assert.equal(await cancelled, false);
    assert.equal(calls.push.length, 0, "cancelling never force pushes");

    const confirmed = sidebar.requestForcePush({ remote: "origin", branch: "main" });
    await tick();
    sidebar.operationDialogConfirmButton.click();
    assert.equal(await confirmed, true);
    assert.deepEqual(toPlain(calls.push), [
      { remote: "origin", branch: "main", forceWithLease: true },
    ]);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar publishes the current branch to the resolved remote with upstream", async () => {
  const { sidebar, calls } = createSidebar({
    remotes: [{ name: "origin", fetchUrl: "https://example.invalid/repo.git", pushUrl: null }],
    defaultRemote: "origin",
  });
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    assert.equal(await sidebar.publishBranch(), true);
    assert.deepEqual(toPlain(calls.push), [
      { remote: "origin", branch: "main", setUpstream: true },
    ]);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar resolves the sync remote from config, a single remote, or a picker", async () => {
  const single = createSidebar({
    remotes: [{ name: "upstream", fetchUrl: "https://example.invalid/repo.git", pushUrl: null }],
  });
  try {
    assert.equal(await single.sidebar.resolveSyncRemote(), "upstream");
  } finally {
    single.sidebar.destroy();
  }

  const ambiguous = createSidebar({
    remotes: [
      { name: "origin", fetchUrl: "https://example.invalid/a.git", pushUrl: null },
      { name: "upstream", fetchUrl: "https://example.invalid/b.git", pushUrl: null },
    ],
  });
  try {
    const pending = ambiguous.sidebar.resolveSyncRemote();
    await tick();
    const config = ambiguous.calls.quickPanel.find((item) => item.id === "git-remote-picker");
    assert.ok(config, "an ambiguous remote set opens a picker");
    assert.deepEqual(config.items.map((item) => item.id), ["origin", "upstream"]);
    config.onAccept({ id: "upstream" });
    assert.equal(await pending, "upstream");
  } finally {
    ambiguous.sidebar.destroy();
  }
});

test("GitSidebar opens the remotes dialog, lists remotes and marks the default", async () => {
  const { sidebar } = createSidebar({
    remotes: [
      { name: "origin", fetchUrl: "https://example.invalid/a.git", pushUrl: "https://example.invalid/push.git" },
      { name: "upstream", fetchUrl: "https://example.invalid/b.git", pushUrl: null },
    ],
    defaultRemote: "origin",
  });
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    const opening = sidebar.openRemotesDialog();
    await tick();
    assert.equal(sidebar.remotesDialog.open, true);
    assert.equal(sidebar.remotesList.children.length, 2);
    const firstRow = sidebar.remotesList.children[0];
    assert.equal(firstRow.dataset.remote, "origin");
    assert.match(firstRow.children[0].children[0].textContent, /origin/);
    assert.equal(firstRow.children[0].children[0].children.length, 1, "default tag present");
    sidebar.remotesCloseButton.click();
    assert.equal(await opening, true);
    assert.equal(sidebar.remotesDialog.open, false);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar adds a remote from the dialog and reports validation errors", async () => {
  let remotes = [];
  const { sidebar, calls } = createSidebar({
    remotesResult: () => ({ success: true, remotes, defaultRemote: null }),
  });
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    const opening = sidebar.openRemotesDialog();
    await tick();
    sidebar.remotesAddName.value = "  ";
    sidebar.remotesAddUrl.value = "https://example.invalid/repo.git";
    sidebar.remotesAddButton.click();
    await tick();
    assert.equal(calls.addRemote.length, 0, "an empty name is rejected before Git");
    assert.equal(sidebar.remotesError.hidden, false);

    sidebar.remotesAddName.value = "origin";
    sidebar.remotesAddUrl.value = "https://example.invalid/repo.git";
    remotes = [{ name: "origin", fetchUrl: "https://example.invalid/repo.git", pushUrl: null }];
    sidebar.remotesAddButton.click();
    await tick();
    assert.deepEqual(toPlain(calls.addRemote), [
      ["origin", "https://example.invalid/repo.git"],
    ]);
    assert.equal(sidebar.remotesList.children.length, 1);
    assert.equal(sidebar.remotesAddName.value, "");
    assert.ok(calls.notifications.some((note) => note.title === "Remote added"));
    sidebar.remotesCloseButton.click();
    await opening;
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar edits a remote fetch and push URL from the dialog", async () => {
  const { sidebar, calls } = createSidebar({
    remotes: [{ name: "origin", fetchUrl: "https://example.invalid/old.git", pushUrl: null }],
    defaultRemote: "origin",
  });
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    const opening = sidebar.openRemotesDialog();
    await tick();
    const row = sidebar.remotesList.children[0];
    const editButton = row.children[1].children[0];
    assert.equal(editButton.textContent, "Edit");
    editButton.click();
    const editForm = sidebar.remotesList.children[0].children[0];
    const fetchInput = editForm.children[1];
    const pushInput = editForm.children[2];
    fetchInput.value = "https://example.invalid/new.git";
    pushInput.value = "https://example.invalid/push.git";
    const saveButton = editForm.children[3].children[1];
    saveButton.click();
    await tick();
    assert.deepEqual(toPlain(calls.setRemoteUrl), [
      ["origin", "https://example.invalid/new.git", null],
      ["origin", "https://example.invalid/push.git", { push: true }],
    ]);
    assert.ok(calls.notifications.some((note) => note.title === "Remote updated"));
    sidebar.remotesCloseButton.click();
    await opening;
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar removes a remote only after an inline confirmation", async () => {
  let remotes = [{ name: "origin", fetchUrl: "https://example.invalid/a.git", pushUrl: null }];
  const { sidebar, calls } = createSidebar({
    remotesResult: () => ({ success: true, remotes, defaultRemote: null }),
  });
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    const opening = sidebar.openRemotesDialog();
    await tick();
    const row = sidebar.remotesList.children[0];
    const removeButton = row.children[1].children[1];
    assert.equal(removeButton.textContent, "Remove");
    removeButton.click();
    assert.equal(calls.removeRemote.length, 0, "the first click only asks for confirmation");
    const confirmRow = sidebar.remotesList.children[0];
    const cancelButton = confirmRow.children[1];
    const confirmButton = confirmRow.children[2];
    assert.equal(confirmButton.textContent, "Remove");
    cancelButton.click();
    assert.equal(calls.removeRemote.length, 0, "cancelling keeps the remote");

    sidebar.remotesList.children[0].children[1].children[1].click();
    remotes = [];
    sidebar.remotesList.children[0].children[2].click();
    await tick();
    assert.deepEqual(toPlain(calls.removeRemote), ["origin"]);
    assert.equal(sidebar.remotesList.children.length, 1);
    assert.equal(sidebar.remotesList.children[0].className, "git-remotes-empty");
    assert.ok(calls.notifications.some((note) => note.title === "Remote removed"));
    sidebar.remotesCloseButton.click();
    await opening;
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar surfaces remote API failures inside the dialog", async () => {
  const { sidebar, calls } = createSidebar({
    remotes: [{ name: "origin", fetchUrl: "https://example.invalid/a.git", pushUrl: null }],
    addRemoteResult: { success: false, code: "REMOTE_EXISTS", error: "already exists" },
  });
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    const opening = sidebar.openRemotesDialog();
    await tick();
    sidebar.remotesAddName.value = "origin";
    sidebar.remotesAddUrl.value = "https://example.invalid/a.git";
    sidebar.remotesAddButton.click();
    await tick();
    assert.equal(sidebar.remotesError.hidden, false);
    assert.match(sidebar.remotesError.textContent, /already exists/);
    assert.equal(sidebar.remotesBusy, false, "the dialog re-enables after a failure");
    assert.equal(sidebar.remotesAddButton.disabled, false);
    sidebar.remotesCloseButton.click();
    await opening;
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar resets sync state and closes the remotes dialog on workspace change", async () => {
  const { sidebar } = createSidebar({
    remotes: [{ name: "origin", fetchUrl: "https://example.invalid/a.git", pushUrl: null }],
  });
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    const opening = sidebar.openRemotesDialog();
    await tick();
    sidebar.syncing = "fetch";
    sidebar.syncProgress = { phase: "Receiving objects", percent: 10 };
    sidebar.applyWorkspace("/other-workspace");
    assert.equal(sidebar.syncing, null);
    assert.equal(sidebar.syncProgress, null);
    assert.equal(sidebar.remotes.length, 0);
    assert.equal(sidebar.remotesDialog.open, false);
    await opening;
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar unsubscribes network progress and removes the remotes dialog on destroy", async () => {
  const { sidebar, calls } = createSidebar({
    remotes: [{ name: "origin", fetchUrl: "https://example.invalid/a.git", pushUrl: null }],
  });
  sidebar.render();
  await sidebar.refresh({ reason: "open" });
  const opening = sidebar.openRemotesDialog();
  await tick();
  assert.equal(calls.networkListeners.length, 1);
  sidebar.destroy();
  await opening;
  assert.equal(calls.networkUnsubscribed, 1);
  assert.equal(sidebar.remotesDialog, null);
});

test("Git header context menu exposes fetch, pull, push and remote management", async () => {
  const builders = loadGlobal(
    "src/js/contextMenu/GitFile.ContextMenu.js",
    "({ buildGitFileContextMenu, buildGitHeaderContextMenu })",
    { GitSidebar },
  );
  const { sidebar, calls } = createSidebar();
  try {
    sidebar.render();
    await sidebar.refresh({ reason: "open" });
    const header = builders.buildGitHeaderContextMenu(sidebar.editor)({ sidebar });
    assert.equal(header.fetch.enabled, true);
    assert.equal(header.pull.enabled, true);
    assert.equal(header.push.enabled, true);
    assert.equal(header.manageRemotes.enabled, true);
    header.fetch.callback();
    await tick();
    assert.equal(calls.fetch.length, 1);
    header.pull.callback();
    await tick();
    assert.equal(calls.pull.length, 1);
    header.push.callback();
    await tick();
    assert.equal(calls.push.length, 1);
  } finally {
    sidebar.destroy();
  }
});

test("Git header context menu disables sync actions without a repository", () => {
  const builders = loadGlobal(
    "src/js/contextMenu/GitFile.ContextMenu.js",
    "({ buildGitFileContextMenu, buildGitHeaderContextMenu })",
    { GitSidebar },
  );
  const { sidebar } = createSidebar();
  try {
    const header = builders.buildGitHeaderContextMenu(sidebar.editor)({ sidebar });
    assert.equal(header.fetch.enabled, false);
    assert.equal(header.pull.enabled, false);
    assert.equal(header.push.enabled, false);
    assert.equal(header.manageRemotes.enabled, false);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar shows the clone action without a repository and hides it once clean", async () => {
  const { sidebar } = createSidebar();
  try {
    sidebar.render();
    sidebar.workspaceRoot = "/workspace";
    sidebar.status = null;
    sidebar.error = { code: "NOT_A_REPOSITORY", error: "not a repo" };
    sidebar.loading = false;
    assert.equal(stateActions(sidebar).clone, true);
    sidebar.error = null;
    sidebar.status = makeStatus([]);
    assert.equal(stateActions(sidebar).clone, false);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar opens the clone dialog and cancels it without calling Git", async () => {
  const { sidebar, calls } = createSidebar();
  try {
    sidebar.render();
    const opening = sidebar.openCloneDialog();
    await tick();
    assert.equal(sidebar.cloneDialog.open, true);
    assert.equal(sidebar.cloneUrlInput.focused, true);
    sidebar.cloneCancelButton.click();
    assert.equal(await opening, true);
    assert.equal(sidebar.cloneDialog.open, false);
    assert.equal(calls.clone.length, 0);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar browses for a clone destination through the native folder dialog", async () => {
  const { sidebar, calls } = createSidebar({ selectFolderResult: "/picked/folder" });
  try {
    sidebar.render();
    const opening = sidebar.openCloneDialog();
    await tick();
    await sidebar.browseCloneDestination();
    assert.equal(calls.selectFolder, 1);
    assert.equal(sidebar.cloneDestination, "/picked/folder");
    assert.equal(sidebar.cloneDestinationInput.value, "/picked/folder");
    sidebar.cloneCancelButton.click();
    await opening;
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar validates the clone URL and destination before calling Git", async () => {
  const { sidebar, calls } = createSidebar();
  try {
    sidebar.render();
    const opening = sidebar.openCloneDialog();
    await tick();
    sidebar.cloneUrlInput.value = "   ";
    await sidebar.submitClone();
    assert.equal(calls.clone.length, 0, "an empty URL is rejected");
    assert.equal(sidebar.cloneError.hidden, false);

    sidebar.cloneUrlInput.value = "https://example.invalid/repo.git";
    await sidebar.submitClone();
    assert.equal(calls.clone.length, 0, "a missing destination is rejected");
    assert.match(sidebar.cloneError.textContent, /destination/i);
    sidebar.cloneCancelButton.click();
    await opening;
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar clones and opens the cloned folder through the project system", async () => {
  const { sidebar, calls } = createSidebar({
    cloneResult: { success: true, path: "/chosen/destination/repo", folderName: "repo" },
  });
  try {
    sidebar.render();
    const opening = sidebar.openCloneDialog();
    await tick();
    sidebar.cloneUrlInput.value = "https://example.invalid/repo.git";
    sidebar.cloneDestination = "/chosen/destination";
    sidebar.cloneFolderInput.value = "repo";
    await sidebar.submitClone();
    assert.deepEqual(toPlain(calls.clone), [
      { url: "https://example.invalid/repo.git", destination: "/chosen/destination", folderName: "repo" },
    ]);
    assert.deepEqual(toPlain(calls.workspaceSwitch), [["/chosen/destination/repo", null]]);
    assert.ok(calls.notifications.some((note) => note.title === "Repository cloned"));
    assert.equal(sidebar.cloneDialog.open, false);
    assert.equal(await opening, true);
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar omits an empty folder name so Git derives it from the URL", async () => {
  const { sidebar, calls } = createSidebar();
  try {
    sidebar.render();
    const opening = sidebar.openCloneDialog();
    await tick();
    sidebar.cloneUrlInput.value = "https://example.invalid/repo.git";
    sidebar.cloneDestination = "/chosen/destination";
    sidebar.cloneFolderInput.value = "  ";
    await sidebar.submitClone();
    assert.deepEqual(toPlain(calls.clone), [
      { url: "https://example.invalid/repo.git", destination: "/chosen/destination" },
    ]);
    await opening;
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar surfaces clone failures inside the dialog and stays open", async () => {
  const { sidebar, calls } = createSidebar({
    cloneResult: { success: false, code: "CLONE_DESTINATION_EXISTS", error: "The folder already exists and is not empty." },
  });
  try {
    sidebar.render();
    const opening = sidebar.openCloneDialog();
    await tick();
    sidebar.cloneUrlInput.value = "https://example.invalid/repo.git";
    sidebar.cloneDestination = "/chosen/destination";
    await sidebar.submitClone();
    assert.equal(sidebar.cloneError.hidden, false);
    assert.match(sidebar.cloneError.textContent, /already exists/);
    assert.equal(sidebar.cloneDialog.open, true);
    assert.equal(calls.workspaceSwitch.length, 0);
    assert.equal(sidebar.cloneBusy, false);
    assert.equal(sidebar.cloneCloneButton.disabled, false);
    sidebar.cloneCancelButton.click();
    await opening;
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar shows clone progress and cancels a running clone", async () => {
  const gate = deferred();
  const { sidebar, calls } = createSidebar({ cloneResult: () => gate.promise });
  try {
    sidebar.render();
    const opening = sidebar.openCloneDialog();
    await tick();
    sidebar.cloneUrlInput.value = "https://example.invalid/repo.git";
    sidebar.cloneDestination = "/chosen/destination";
    const submitting = sidebar.submitClone();
    await tick();
    assert.equal(sidebar.cloneBusy, true);
    assert.equal(sidebar.cloneCloneButton.disabled, true);
    assert.equal(sidebar.cloneProgressElement.hidden, false);

    const listener = calls.networkListeners[0];
    listener({ operation: "clone", phase: "Receiving objects", percent: 42 });
    assert.equal(sidebar.cloneProgress.percent, 42);
    assert.equal(sidebar.cloneProgressBar.style.width, "42%");
    assert.match(sidebar.cloneProgressText.textContent, /Receiving objects 42%/);
    listener({ operation: "fetch", phase: "Receiving objects", percent: 99 });
    assert.equal(sidebar.cloneProgress.percent, 42, "foreign operations do not drive clone progress");

    sidebar.cloneCancelButton.click();
    await tick();
    assert.equal(calls.cancelNetwork, 1);
    assert.equal(sidebar.cloneDialog.open, true, "cancelling a running clone keeps the dialog open");
    gate.resolve({ success: false, code: "OPERATION_CANCELLED", error: "cancelled" });
    await submitting;
    assert.match(sidebar.cloneError.textContent, /cancelled/i);
    sidebar.cloneCancelButton.click();
    await opening;
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar resets clone state and closes the clone dialog on workspace change", async () => {
  const { sidebar } = createSidebar();
  try {
    sidebar.render();
    const opening = sidebar.openCloneDialog();
    await tick();
    sidebar.cloneDestination = "/chosen/destination";
    sidebar.applyWorkspace("/other-workspace");
    assert.equal(sidebar.cloneBusy, false);
    assert.equal(sidebar.cloneProgress, null);
    assert.equal(sidebar.cloneDestination, "");
    assert.equal(sidebar.cloneDialog.open, false);
    await opening;
  } finally {
    sidebar.destroy();
  }
});

test("GitSidebar removes the clone dialog on destroy", async () => {
  const { sidebar } = createSidebar();
  sidebar.render();
  const opening = sidebar.openCloneDialog();
  await tick();
  sidebar.destroy();
  await opening;
  assert.equal(sidebar.cloneDialog, null);
});
