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
  constructor(editor, renderItem) {
    this.editor = editor;
    this.renderItem = renderItem;
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
  suspend() { this.suspended = true; }
  resume() { this.suspended = false; }
  destroy() { this.destroyed = true; }
}

const GitSidebar = loadGlobal("src/js/sidebar/Git.Sidebar.js", "GitSidebar", {
  Sidebar,
  SearchResultsScroller: FakeScroller,
  NCEPath: {
    equals: (left, right) => left === right,
    basename: (value) => String(value || "").replace(/\\/g, "/").split("/").pop(),
  },
});

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

function createSidebar(options = {}) {
  const responses = [...(options.responses || [])];
  const calls = {
    status: 0,
    init: 0,
    stage: [],
    unstage: [],
    commit: [],
    clipboard: [],
    openDiff: [],
    openFile: [],
    versions: [],
    menus: [],
    notifications: [],
    settings: [],
    unsubscribed: false,
  };
  const rootPath = options.rootPath === undefined ? "/workspace" : options.rootPath;
  const editor = {
    fileExplorer: {
      rootPath,
      projectName: options.projectName || "workspace",
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
        async commit(message) {
          calls.commit.push(message);
          return typeof options.commitResult === "function"
            ? options.commitResult(message)
            : options.commitResult || { success: true, hash: "1234567890abcdef", summary: message };
        },
      },
      writeClipboardText(text) { calls.clipboard.push(text); },
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
    domManager: {},
    notificationManager: {
      notify(options) {
        calls.notifications.push(options);
        return { id: `notification-${calls.notifications.length}`, ...options };
      },
    },
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
    const { staged, changes, items } = sidebar.describeStatus();
    assert.equal(staged.length, 1);
    assert.equal(changes.length, 2);
    const sections = items.filter((item) => item.type === "section");
    assert.equal(
      sections.map((item) => `${item.section}:${item.count}`).join("|"),
      "staged:1|changes:2",
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

test("GitSidebar explains missing workspaces, plain folders, and missing Git", async () => {
  const empty = createSidebar({ rootPath: "" });
  try {
    await empty.sidebar.refresh({ reason: "open" });
    assert.match(empty.sidebar.getStateMessage(), /Open a folder/);
    assert.equal(empty.calls.status, 0, "no Git status without a workspace");
    assert.deepEqual(
      stateActions(empty.sidebar),
      { init: false, refresh: false, retry: false, settings: false },
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
      { init: true, refresh: true, retry: false, settings: false },
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
      { init: false, refresh: false, retry: false, settings: true },
    );
    assert.equal(
      missingGit.sidebar.getStatePresentation(
        missingGit.sidebar.getViewState(),
      ).code,
      "",
      "the missing Git state offers settings instead of a raw error code",
    );
    await missingGit.sidebar.openGitSettings();
    assert.deepEqual(missingGit.calls.settings, ["Editor"]);
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
      { init: false, refresh: true, retry: false, settings: false },
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
      { init: true, refresh: true, retry: false, settings: false },
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
  const stagedOnly = createSidebar({ entries: [stagedEntry] });
  try {
    await stagedOnly.sidebar.refresh({ reason: "open" });
    const items = stagedOnly.sidebar.buildListItems(
      stagedOnly.sidebar.getSections().staged,
      stagedOnly.sidebar.getSections().changes,
    );
    assert.deepEqual(
      toPlain(items.filter((item) => item.type === "section").map((item) => item.section)),
      ["staged"],
    );
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
    assert.deepEqual(
      toPlain(items.filter((item) => item.type === "section").map((item) => item.section)),
      ["changes"],
    );
    assert.equal(items.some((item) => item.type === "empty"), false);
  } finally {
    changedOnly.sidebar.destroy();
  }

  const clean = createSidebar({ entries: [] });
  try {
    await clean.sidebar.refresh({ reason: "open" });
    assert.deepEqual(toPlain(clean.sidebar.buildListItems([], [])), []);
  } finally {
    clean.sidebar.destroy();
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
      { init: true, refresh: true, retry: false, settings: false },
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
      { init: false, refresh: false, retry: false, settings: true },
    );
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
      { init: true, refresh: true, retry: false, settings: false },
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
    ["openDiff", "stage", "openFile", "copyRelativePath", "copyAbsolutePath", "refresh"],
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
  assert.deepEqual(Object.keys(header), ["refresh", "copyBranch"]);
  sidebar.destroy();
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
      { init: false, refresh: false, retry: false, settings: false },
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
