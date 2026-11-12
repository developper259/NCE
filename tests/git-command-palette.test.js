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
});
