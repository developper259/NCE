const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { GitManager } = require("../dist/ts/manager/GitManager.js");
const { PathAccess } = require("../dist/ts/manager/PathAccess.js");

let gitAvailable = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  gitAvailable = false;
}
const gitSkip = !gitAvailable && "Git CLI is required for GitManager tests";
const posixSkip = !gitAvailable
  ? gitSkip
  : process.platform === "win32" && "POSIX-only fixture";

// Keep the developer's global Git configuration out of every fixture and
// manager call so identities, hooks, and signing never leak into assertions.
const emptyConfig = path.join(os.tmpdir(), `nce-git-empty-${process.pid}.gitconfig`);
fsSync.writeFileSync(emptyConfig, "");
process.on("exit", () => {
  try { fsSync.unlinkSync(emptyConfig); } catch {}
});
const isolatedEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: emptyConfig,
};

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...isolatedEnv },
  });
}

async function createRepository({ commits = 1 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-git-manager-"));
  git(root, ["init", "-q"]);
  git(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(root, ["config", "user.name", "NCE Test"]);
  git(root, ["config", "user.email", "nce@example.invalid"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["config", "core.autocrlf", "false"]);
  if (commits > 0) {
    await fs.writeFile(path.join(root, "tracked.txt"), "initial\n");
    git(root, ["add", "--", "tracked.txt"]);
    git(root, ["commit", "-q", "-m", "initial"]);
  }
  return root;
}

function managerFor(workspace, options = {}) {
  return new GitManager({
    getWorkspaceRoot: () => workspace,
    pathAccess: new PathAccess(() => workspace),
    env: isolatedEnv,
    ...options,
  });
}

async function removeAll(...directories) {
  for (const directory of directories)
    await fs.rm(directory, { recursive: true, force: true });
}

test("GitManager detects Git, versions, and repository roots", { skip: gitSkip }, async () => {
  const root = await createRepository();
  const manager = managerFor(root);
  try {
    assert.equal(await manager.isGitAvailable(), true);
    const version = await manager.getGitVersion();
    assert.equal(version.success, true);
    assert.match(version.version, /^\d+\.\d+/);
    const repository = await manager.getRepository();
    assert.equal(repository.success, true);
    assert.equal(repository.repository.root, await fs.realpath(root));
    assert.match(repository.repository.gitDir, /\.git$/);
    assert.equal((await manager.getRepositoryRoot()).root, await fs.realpath(root));
    assert.equal(await manager.isRepository(), true);
  } finally {
    manager.dispose();
    await removeAll(root);
  }
});

test("GitManager reports missing Git, bare folders, and removed workspaces", { skip: gitSkip }, async () => {
  const root = await createRepository();
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "nce-git-plain-"));
  const missing = await fs.mkdtemp(path.join(os.tmpdir(), "nce-git-missing-"));
  const withoutGit = managerFor(root, { gitPath: path.join(root, "no-such-git") });
  const plainManager = managerFor(plain);
  try {
    assert.equal(await withoutGit.isGitAvailable(), false);
    assert.equal((await withoutGit.getGitVersion()).code, "GIT_NOT_FOUND");
    assert.equal(await plainManager.isRepository(), false);
    assert.equal((await plainManager.getStatus()).code, "NOT_A_REPOSITORY");
    assert.equal((await plainManager.getRepositoryRoot()).code, "NOT_A_REPOSITORY");
    await fs.rm(missing, { recursive: true, force: true });
    const removed = managerFor(missing);
    assert.equal((await removed.getStatus()).code, "REPOSITORY_NOT_FOUND");
    removed.dispose();
  } finally {
    withoutGit.dispose();
    plainManager.dispose();
    await removeAll(root, plain, missing);
  }
});

test("GitManager resolves a workspace inside a repository subfolder", { skip: gitSkip }, async () => {
  const root = await createRepository();
  const nested = path.join(root, "packages", "app");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, "nested.txt"), "nested\n");
  // The authorization boundary is the workspace, but Git may report a parent root.
  const manager = managerFor(nested);
  try {
    assert.equal((await manager.getRepositoryRoot()).root, await fs.realpath(root));
    const staged = await manager.stageFile(path.join(nested, "nested.txt"));
    assert.equal(staged.success, true);
    assert.equal(staged.path, path.join("packages", "app", "nested.txt").split(path.sep).join("/"));
    const status = await manager.getStatus();
    assert.equal(status.success, true);
    assert.equal(status.status.entries[0].path, "packages/app/nested.txt");
  } finally {
    manager.dispose();
    await removeAll(root);
  }
});

test("GitManager handles repositories without an initial commit", { skip: gitSkip }, async () => {
  const root = await createRepository({ commits: 0 });
  const manager = managerFor(root);
  try {
    const status = await manager.getStatus();
    assert.equal(status.success, true);
    assert.equal(status.status.hasCommits, false);
    assert.equal(status.status.branch.name, "main");
    assert.equal(status.status.branch.oid, null);
    assert.equal((await manager.getCurrentBranch()).branch, "main");
    assert.deepEqual((await manager.getBranches()).branches, []);
    assert.deepEqual((await manager.getLog()).commits, []);

    const file = path.join(root, "first.txt");
    await fs.writeFile(file, "first\n");
    assert.equal((await manager.stageFile(file)).success, true);
    const staged = await manager.getStatus();
    assert.equal(staged.status.entries[0].index, "A");
    const unstaged = await manager.unstageFile(file);
    assert.equal(unstaged.success, true);
    assert.equal(await fs.readFile(file, "utf8"), "first\n");
    const after = await manager.getStatus();
    assert.equal(after.status.entries[0].kind, "untracked");
    assert.equal((await manager.unstageFile(file)).code, "NOTHING_TO_COMMIT");
  } finally {
    manager.dispose();
    await removeAll(root);
  }
});

test("GitManager normalizes status entries", { skip: gitSkip }, async () => {
  const root = await createRepository();
  await fs.writeFile(path.join(root, "deleted.txt"), "gone soon\n");
  await fs.writeFile(path.join(root, "mixed.txt"), "one\n");
  await fs.writeFile(path.join(root, "old.txt"), "rename me\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixtures"]);

  await fs.rm(path.join(root, "deleted.txt"));
  git(root, ["mv", "old.txt", "new.txt"]);
  await fs.writeFile(path.join(root, "staged.txt"), "staged\n");
  git(root, ["add", "--", "staged.txt"]);
  await fs.writeFile(path.join(root, "mixed.txt"), "two\n");
  git(root, ["add", "--", "mixed.txt"]);
  await fs.writeFile(path.join(root, "mixed.txt"), "three\n");
  await fs.writeFile(path.join(root, "tracked.txt"), "changed\n");
  await fs.writeFile(path.join(root, "new file é.js"), "untracked\n");

  const manager = managerFor(root);
  try {
    const result = await manager.getStatus();
    assert.equal(result.success, true);
    const { status } = result;
    assert.equal(status.branch.name, "main");
    assert.equal(status.branch.detached, false);
    assert.match(status.branch.oid, /^[0-9a-f]{40}$/);
    assert.equal(status.hasCommits, true);
    const entry = file => status.entries.find(candidate => candidate.path === file);
    assert.deepEqual(
      { kind: entry("new file é.js").kind, index: entry("new file é.js").index, worktree: entry("new file é.js").worktree },
      { kind: "untracked", index: null, worktree: "?" },
    );
    assert.deepEqual(
      { kind: entry("tracked.txt").kind, index: entry("tracked.txt").index, worktree: entry("tracked.txt").worktree },
      { kind: "modified", index: null, worktree: "M" },
    );
    assert.deepEqual(
      { kind: entry("staged.txt").kind, index: entry("staged.txt").index, worktree: entry("staged.txt").worktree },
      { kind: "added", index: "A", worktree: null },
    );
    assert.deepEqual(
      { kind: entry("deleted.txt").kind, index: entry("deleted.txt").index, worktree: entry("deleted.txt").worktree },
      { kind: "deleted", index: null, worktree: "D" },
    );
    assert.deepEqual(
      {
        kind: entry("new.txt").kind,
        index: entry("new.txt").index,
        originalPath: entry("new.txt").originalPath,
      },
      { kind: "renamed", index: "R", originalPath: "old.txt" },
    );
    assert.deepEqual(
      { kind: entry("mixed.txt").kind, index: entry("mixed.txt").index, worktree: entry("mixed.txt").worktree },
      { kind: "modified", index: "M", worktree: "M" },
    );
    const summary = await manager.getDiffSummary({ staged: true });
    assert.equal(summary.success, true);
    const renamed = summary.files.find(file => file.path === "new.txt");
    assert.equal(renamed.originalPath, "old.txt");
    assert.equal(renamed.binary, false);
  } finally {
    manager.dispose();
    await removeAll(root);
  }
});

test("GitManager keeps newline filenames distinct", { skip: posixSkip }, async () => {
  const root = await createRepository();
  const name = "line\nbreak.txt";
  await fs.writeFile(path.join(root, name), "content\n");
  const manager = managerFor(root);
  try {
    const status = await manager.getStatus();
    assert.equal(status.success, true);
    assert.equal(status.status.entries.length, 1);
    assert.equal(status.status.entries[0].path, name);
    const diff = await manager.getDiff(path.join(root, name));
    assert.equal(diff.success, true);
    assert.equal(diff.reason, "untracked");
    assert.equal(diff.preview, "content\n");
  } finally {
    manager.dispose();
    await removeAll(root);
  }
});

test("GitManager stages and unstages without losing worktree changes", { skip: gitSkip }, async () => {
  const root = await createRepository();
  const tracked = path.join(root, "tracked.txt");
  await fs.writeFile(tracked, "modified\n");
  const manager = managerFor(root);
  try {
    assert.equal((await manager.stageFile(tracked)).success, true);
    let status = await manager.getStatus();
    assert.equal(status.status.entries[0].index, "M");
    assert.equal(status.status.entries[0].worktree, null);
    assert.equal((await manager.unstageFile(tracked)).success, true);
    status = await manager.getStatus();
    assert.equal(status.status.entries[0].index, null);
    assert.equal(status.status.entries[0].worktree, "M");
    assert.equal(await fs.readFile(tracked, "utf8"), "modified\n");

    const removed = path.join(root, "removed.txt");
    await fs.writeFile(removed, "removed\n");
    git(root, ["add", "--", "removed.txt"]);
    git(root, ["commit", "-q", "-m", "removed fixture"]);
    await fs.rm(removed);
    assert.equal((await manager.stageFile(removed)).success, true);
    status = await manager.getStatus();
    assert.equal(status.status.entries.find(entry => entry.path === "removed.txt").index, "D");
    assert.equal((await manager.unstageFile(removed)).success, true);
    status = await manager.getStatus();
    const deletion = status.status.entries.find(entry => entry.path === "removed.txt");
    assert.equal(deletion.index, null);
    assert.equal(deletion.worktree, "D");
    assert.equal(fsSync.existsSync(removed), false);
  } finally {
    manager.dispose();
    await removeAll(root);
  }
});

test("GitManager commits staged changes and reports commit failures", { skip: gitSkip }, async () => {
  const root = await createRepository();
  const manager = managerFor(root);
  try {
    await fs.writeFile(path.join(root, "tracked.txt"), "committed change\n");
    await fs.writeFile(path.join(root, "untracked.txt"), "stays out\n");
    assert.equal((await manager.commit("   ")).code, "EMPTY_COMMIT_MESSAGE");
    assert.equal((await manager.commit("")).code, "EMPTY_COMMIT_MESSAGE");
    assert.equal((await manager.commit(null)).code, "INVALID_ARGUMENT");
    assert.equal((await manager.commit("before staging")).code, "NOTHING_TO_COMMIT");
    git(root, ["add", "--", "tracked.txt"]);
    const commit = await manager.commit("  message with 'quotes' and \"double\"  \n");
    assert.equal(commit.success, true);
    assert.match(commit.hash, /^[0-9a-f]{40}$/);
    assert.equal(commit.summary.trim(), "message with 'quotes' and \"double\"");
    assert.equal((await manager.commit("again")).code, "NOTHING_TO_COMMIT");
    const status = await manager.getStatus();
    assert.deepEqual(status.status.entries.map(entry => entry.path), ["untracked.txt"]);
    const log = await manager.getLog();
    assert.equal(log.commits[0].hash, commit.hash);
    assert.equal(log.commits[0].subject.trim(), "message with 'quotes' and \"double\"");

    git(root, ["config", "user.useConfigOnly", "true"]);
    git(root, ["config", "--unset", "user.name"]);
    git(root, ["config", "--unset", "user.email"]);
    await fs.writeFile(path.join(root, "tracked.txt"), "identity required\n");
    git(root, ["add", "--", "tracked.txt"]);
    assert.equal((await manager.commit("identity")).code, "GIT_IDENTITY_MISSING");
  } finally {
    manager.dispose();
    await removeAll(root);
  }
});

test("GitManager reports hook rejections", { skip: posixSkip }, async () => {
  const root = await createRepository();
  const hook = path.join(root, ".git", "hooks", "pre-commit");
  await fs.writeFile(hook, "#!/bin/sh\nexit 1\n");
  await fs.chmod(hook, 0o755);
  const manager = managerFor(root);
  try {
    await fs.writeFile(path.join(root, "tracked.txt"), "hooked\n");
    git(root, ["add", "--", "tracked.txt"]);
    const result = await manager.commit("blocked");
    assert.equal(result.success, false);
    assert.equal(result.code, "GIT_HOOK_FAILED");
    const log = await manager.getLog();
    assert.equal(log.commits.length, 1);
  } finally {
    manager.dispose();
    await removeAll(root);
  }
});

test("GitManager returns bounded diffs with explicit reasons", { skip: gitSkip }, async () => {
  const root = await createRepository();
  const tracked = path.join(root, "tracked.txt");
  const manager = managerFor(root);
  try {
    await fs.writeFile(tracked, "changed\n");
    const unstaged = await manager.getDiff(tracked);
    assert.equal(unstaged.available, true);
    assert.match(unstaged.patch, /-initial/);
    assert.match(unstaged.patch, /\+changed/);
    assert.equal(unstaged.added, 1);
    assert.equal(unstaged.deleted, 1);

    git(root, ["add", "--", "tracked.txt"]);
    const staged = await manager.getDiff(tracked, { staged: true });
    assert.equal(staged.available, true);
    assert.match(staged.patch, /\+changed/);
    assert.equal((await manager.getDiff(tracked)).reason, "no-changes");

    const untracked = path.join(root, "notes.txt");
    await fs.writeFile(untracked, "untracked preview\n");
    const preview = await manager.getDiff(untracked);
    assert.equal(preview.reason, "untracked");
    assert.equal(preview.preview, "untracked preview\n");
    assert.equal((await manager.getDiff(untracked, { staged: true })).reason, "no-changes");

    const binary = path.join(root, "binary.bin");
    await fs.writeFile(binary, Buffer.from([0, 1, 2, 3]));
    git(root, ["add", "--", "binary.bin"]);
    git(root, ["commit", "-q", "-m", "binary fixture"]);
    await fs.writeFile(binary, Buffer.from([0, 9, 9, 9]));
    const binaryDiff = await manager.getDiff(binary);
    assert.equal(binaryDiff.success, true);
    assert.equal(binaryDiff.available, false);
    assert.equal(binaryDiff.reason, "binary");
    const binarySummary = await manager.getDiffSummary();
    assert.equal(binarySummary.files.find(file => file.path === "binary.bin").binary, true);

    const large = path.join(root, "large.txt");
    await fs.writeFile(large, `${"x".repeat(1024 * 1024 + 1)}\n`);
    git(root, ["add", "--", "large.txt"]);
    git(root, ["commit", "-q", "-m", "large fixture"]);
    await fs.appendFile(large, "tail\n");
    const largeDiff = await manager.getDiff(large);
    assert.equal(largeDiff.reason, "too-large");

    const deleted = path.join(root, "deleted.txt");
    await fs.writeFile(deleted, "deleted content\n");
    git(root, ["add", "--", "deleted.txt"]);
    git(root, ["commit", "-q", "-m", "deleted fixture"]);
    await fs.rm(deleted);
    const deletion = await manager.getDiff(deleted);
    assert.equal(deletion.available, true);
    assert.match(deletion.patch, /-deleted content/);
  } finally {
    manager.dispose();
    await removeAll(root);
  }
});

test("GitManager reports merge conflicts in the status", { skip: gitSkip }, async () => {
  const root = await createRepository();
  git(root, ["checkout", "-q", "-b", "feature"]);
  await fs.writeFile(path.join(root, "tracked.txt"), "feature\n");
  git(root, ["commit", "-q", "-am", "feature change"]);
  git(root, ["checkout", "-q", "main"]);
  await fs.writeFile(path.join(root, "tracked.txt"), "main\n");
  git(root, ["commit", "-q", "-am", "main change"]);
  try {
    git(root, ["merge", "feature"]);
  } catch {}
  const manager = managerFor(root);
  try {
    const result = await manager.getStatus();
    assert.equal(result.success, true);
    assert.equal(result.status.merging, true);
    assert.equal(result.status.rebasing, false);
    const conflict = result.status.entries.find(entry => entry.path === "tracked.txt");
    assert.equal(conflict.conflicted, true);
    assert.equal(conflict.kind, "conflicted");
    assert.match(conflict.index, /^[UAD]$/);
  } finally {
    manager.dispose();
    await removeAll(root);
  }
});

test("GitManager reads branches and paginated history", { skip: gitSkip }, async () => {
  const root = await createRepository();
  for (const name of ["second.txt", "third.txt"]) {
    await fs.writeFile(path.join(root, name), `${name}\n`);
    git(root, ["add", "--", name]);
    git(root, ["commit", "-q", "-m", `add ${name}`]);
  }
  git(root, ["branch", "dev"]);
  const manager = managerFor(root);
  try {
    const firstPage = await manager.getLog({ limit: 2 });
    assert.equal(firstPage.commits.length, 2);
    assert.equal(firstPage.commits[0].subject, "add third.txt");
    assert.equal(firstPage.commits[1].subject, "add second.txt");
    const secondPage = await manager.getLog({ limit: 1, skip: 2 });
    assert.equal(secondPage.commits.length, 1);
    assert.equal(secondPage.commits[0].subject, "initial");
    assert.equal((await manager.getLog({ limit: 0 })).code, "INVALID_ARGUMENT");
    assert.equal((await manager.getLog({ limit: "5" })).code, "INVALID_ARGUMENT");
    const branches = await manager.getBranches();
    assert.deepEqual(branches.branches.map(branch => branch.name).sort(), ["dev", "main"]);
    assert.equal(branches.current, "main");
    assert.equal((await manager.getCurrentBranch()).branch, "main");
  } finally {
    manager.dispose();
    await removeAll(root);
  }
});

test("GitManager rejects paths outside the workspace", { skip: gitSkip }, async () => {
  const root = await createRepository();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "nce-git-outside-"));
  const outsideFile = path.join(outside, "outside.txt");
  await fs.writeFile(outsideFile, "outside\n");
  const manager = managerFor(root);
  try {
    assert.equal((await manager.stageFile(outsideFile)).code, "INVALID_PATH");
    assert.equal((await manager.getDiff(outsideFile)).code, "INVALID_PATH");
    assert.equal((await manager.stageFile(path.join(root, "..", "escape.txt"))).code, "INVALID_PATH");
    assert.equal((await manager.stageFile(42)).code, "INVALID_PATH");
    assert.equal((await manager.getDiff(null)).code, "INVALID_PATH");
  } finally {
    manager.dispose();
    await removeAll(root, outside);
  }
});

test("GitManager exposes only named Git channels through the preload", () => {
  const root = path.join(__dirname, "..");
  const preload = fsSync.readFileSync(path.join(root, "src/js/main/Preload.js"), "utf8");
  const windowSource = fsSync.readFileSync(path.join(root, "src/ts/Window.ts"), "utf8");
  const managerSource = fsSync.readFileSync(
    path.join(root, "src/ts/manager/GitManager.ts"),
    "utf8",
  );
  assert.match(preload, /git:\s*\{/);
  for (const channel of [
    "Git:isAvailable", "Git:version", "Git:repository", "Git:isRepository",
    "Git:repositoryRoot", "Git:status", "Git:diff", "Git:diffSummary",
    "Git:stage", "Git:unstage", "Git:commit", "Git:branches",
    "Git:currentBranch", "Git:log",
  ]) {
    assert.match(preload, new RegExp(`"${channel}"`), `preload exposes ${channel}`);
    assert.match(managerSource, new RegExp(`"${channel}"`), `GitManager registers ${channel}`);
  }
  assert.doesNotMatch(preload, /child_process|require\("node:/);
  assert.doesNotMatch(preload, /gitCommand|runGit/);
  assert.match(windowSource, /new GitManager\(\{/);
  assert.match(windowSource, /this\.gitManager\?\.handleIPC\(this\.ipc\)/);
  assert.match(windowSource, /this\.gitManager\?\.dispose\(\)/);
});

test("GitManager times out and cancels Git processes", { skip: posixSkip }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-git-timeout-"));
  const script = path.join(root, "slow-git");
  await fs.writeFile(script, "#!/bin/sh\nexec sleep 30\n");
  await fs.chmod(script, 0o755);
  const timed = managerFor(root, { gitPath: script, timeoutMs: 200 });
  const cancelled = managerFor(root, { gitPath: script, timeoutMs: 30_000 });
  try {
    const started = Date.now();
    assert.equal((await timed.getGitVersion()).code, "GIT_TIMEOUT");
    assert.ok(Date.now() - started < 5000, "the timeout kills the child quickly");

    const pending = cancelled.getGitVersion();
    await new Promise(resolve => setTimeout(resolve, 100));
    const cancelStarted = Date.now();
    cancelled.dispose();
    assert.equal((await pending).code, "OPERATION_CANCELLED");
    assert.ok(Date.now() - cancelStarted < 5000, "dispose cancels an in-flight command");
  } finally {
    timed.dispose();
    cancelled.dispose();
    await removeAll(root);
  }
});
