const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { loadGlobal, root } = require("./helpers/runtime");

function applicationBindings() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${fs.readFileSync(path.join(root, "src/config/Application.js"), "utf8")}
     this.bindings = USERCONFIG_KEYBINDING;`,
    context,
  );
  return Array.from(context.bindings, (binding) => ({ ...binding }));
}

const GIT_ACTIONS = [
  ["git_open_source_control", "Git: Open Source Control"],
  ["git_refresh", "Git: Refresh Source Control"],
  ["git_switch_branch", "Git: Switch Branch"],
  ["git_create_branch", "Git: Create New Branch"],
  ["git_stage_all", "Git: Stage All Changes"],
  ["git_unstage_all", "Git: Unstage All Changes"],
  ["git_focus_commit_message", "Git: Focus Commit Message"],
  ["git_open_settings", "Git: Open Settings"],
  ["git_clone", "Git: Clone Repository"],
  ["git_fetch", "Git: Fetch"],
  ["git_pull", "Git: Pull"],
  ["git_push", "Git: Push"],
  ["git_show_history", "Git: Show History"],
  ["git_manage_remotes", "Git: Manage Remotes"],
];

test("the command palette exposes the Git commands", () => {
  let panelOptions;
  const KeyBinding = loadGlobal("src/js/addon/KeyBinding.js", "KeyBinding", {
    USERCONFIG_KEYBINDING: applicationBindings(),
    CONFIG_KEYBINDING_DISPLAY: (key) => key || "",
  });
  const keyBinding = new KeyBinding({
    tabManager: { activeFile: null },
    quickPanel: {
      isOpen: () => false,
      open: (options) => { panelOptions = options; },
    },
  });

  keyBinding.control_open_command();

  for (const [action, label] of GIT_ACTIONS) {
    const item = panelOptions.items.find((entry) => entry.id === action);
    assert.ok(item, `${action} is listed in the command palette`);
    assert.equal(item.label, label);
    assert.ok(item.keywords.includes("git"));
  }
  const switchBranch = panelOptions.items.find(
    (entry) => entry.id === "git_switch_branch",
  );
  assert.ok(switchBranch.keywords.includes("checkout"));
});

test("Git palette commands dispatch to Source Control", async () => {
  const calls = [];
  const sidebar = {
    isOpen: false,
    status: null,
    commitInput: { focus: () => calls.push("focus-commit") },
    refresh: async ({ reason } = {}) => {
      calls.push(["refresh", reason]);
      sidebar.status = { entries: [] };
    },
    stageAllChanges: async () => {
      calls.push("stage-all");
      return true;
    },
    unstageAllChanges: async () => {
      calls.push("unstage-all");
      return true;
    },
    openBranchPicker: () => {
      calls.push("switch-branch");
      return true;
    },
    promptNewBranch: () => {
      calls.push("create-branch");
      return true;
    },
    openCloneDialog: () => {
      calls.push("clone-dialog");
      return true;
    },
    fetchChanges: async () => {
      calls.push("fetch");
      return true;
    },
    pullChanges: async () => {
      calls.push("pull");
      return true;
    },
    pushChanges: async () => {
      calls.push("push");
      return true;
    },
    showHistory: async () => {
      calls.push("show-history");
      return true;
    },
    openRemotesDialog: async () => {
      calls.push("remotes-dialog");
      return true;
    },
  };
  const keyBinding = new (loadGlobal(
    "src/js/addon/KeyBinding.js",
    "KeyBinding",
  ))({
    sidebarManager: {
      openMenu: (id) => {
        calls.push(["open-menu", id]);
        sidebar.isOpen = true;
        return true;
      },
    },
    gitSidebar: sidebar,
    openSettings: (category) => {
      calls.push(["open-settings", category]);
      return true;
    },
  });

  keyBinding.exec({ action: "git_open_source_control" });
  assert.deepEqual(calls.at(-1), ["open-menu", "git"]);

  assert.equal(keyBinding.control_git_switch_branch(), true);
  assert.equal(calls.at(-1), "switch-branch");

  assert.equal(keyBinding.control_git_create_branch(), true);
  assert.equal(calls.at(-1), "create-branch");

  assert.equal(await keyBinding.control_git_stage_all(), true);
  assert.deepEqual(calls.slice(-2), [["refresh", "manual"], "stage-all"]);

  assert.equal(await keyBinding.control_git_unstage_all(), true);
  assert.equal(calls.at(-1), "unstage-all");

  sidebar.isOpen = false;
  assert.equal(keyBinding.control_git_refresh(), true);
  assert.deepEqual(calls.at(-1), ["open-menu", "git"]);

  sidebar.isOpen = true;
  await keyBinding.control_git_refresh();
  assert.deepEqual(calls.at(-1), ["refresh", "manual"]);

  sidebar.isOpen = false;
  assert.equal(keyBinding.control_git_focus_commit_message(), true);
  assert.deepEqual(calls.slice(-2), [["open-menu", "git"], "focus-commit"]);

  keyBinding.exec({ action: "git_open_settings" });
  assert.deepEqual(calls.at(-1), ["open-settings", "Git"]);

  assert.equal(keyBinding.control_git_clone(), true);
  assert.equal(calls.at(-1), "clone-dialog");

  // Sync, history and remotes commands delegate to the open sidebar directly.
  sidebar.isOpen = true;
  sidebar.status = { entries: [] };
  assert.equal(await keyBinding.control_git_fetch(), true);
  assert.equal(calls.at(-1), "fetch");
  assert.equal(await keyBinding.control_git_pull(), true);
  assert.equal(calls.at(-1), "pull");
  assert.equal(await keyBinding.control_git_push(), true);
  assert.equal(calls.at(-1), "push");
  assert.equal(await keyBinding.control_git_show_history(), true);
  assert.equal(calls.at(-1), "show-history");
  assert.equal(await keyBinding.control_git_manage_remotes(), true);
  assert.equal(calls.at(-1), "remotes-dialog");

  // Closed with no status: a sync command opens Source Control and refreshes
  // before running, so the operation has a repository to act on.
  sidebar.isOpen = false;
  sidebar.status = null;
  assert.equal(await keyBinding.control_git_fetch(), true);
  assert.deepEqual(calls.slice(-3), [
    ["open-menu", "git"],
    ["refresh", "manual"],
    "fetch",
  ]);

  // Manage Remotes opens the sidebar but the dialog loads its own remotes.
  sidebar.isOpen = false;
  assert.equal(await keyBinding.control_git_manage_remotes(), true);
  assert.deepEqual(calls.slice(-2), [["open-menu", "git"], "remotes-dialog"]);

  // Missing sidebar operations fail closed instead of throwing.
  const bare = new (loadGlobal("src/js/addon/KeyBinding.js", "KeyBinding"))({
    gitSidebar: {},
  });
  assert.equal(await bare.control_git_fetch(), false);
  assert.equal(await bare.control_git_show_history(), false);
  assert.equal(bare.control_git_manage_remotes(), false);
});
