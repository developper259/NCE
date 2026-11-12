const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { GitManager, redactCredentials } = require("../dist/ts/manager/GitManager.js");
const { PathAccess } = require("../dist/ts/manager/PathAccess.js");

let gitAvailable = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  gitAvailable = false;
}
const gitSkip = !gitAvailable && "Git CLI is required for Git remote tests";
const posixSkip = !gitAvailable
  ? gitSkip
  : process.platform === "win32" && "POSIX-only fixture";

const emptyConfig = path.join(os.tmpdir(), `nce-git-remote-empty-${process.pid}.gitconfig`);
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

function managerFor(workspace, options = {}) {
  return new GitManager({
    getWorkspaceRoot: () => workspace,
    pathAccess: new PathAccess(() => workspace),
    env: isolatedEnv,
    ...options,
  });
}

async function createRepository({ commits = 1 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-git-remote-"));
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

async function createBareRemote() {
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), "nce-git-bare-"));
  git(bare, ["init", "-q", "--bare"]);
  git(bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return bare;
}

async function createRepositoryWithRemote(remoteName = "upstream") {
  const root = await createRepository();
  const bare = await createBareRemote();
  git(root, ["remote", "add", remoteName, bare]);
  return { root, bare };
}

/** Advance a bare remote through an independent clone, like another developer would. */
async function advanceRemote(bare, { file = "remote.txt", content = "remote change\n", message = "remote commit" } = {}) {
  const clone = await fs.mkdtemp(path.join(os.tmpdir(), "nce-git-clone-"));
  try {
    git(clone, ["clone", "-q", bare, "."]);
    git(clone, ["config", "user.name", "NCE Test"]);
    git(clone, ["config", "user.email", "nce@example.invalid"]);
    git(clone, ["config", "commit.gpgsign", "false"]);
    await fs.writeFile(path.join(clone, file), content);
    git(clone, ["add", "--", file]);
    git(clone, ["commit", "-q", "-m", message]);
    git(clone, ["push", "-q", "origin", "HEAD:main"]);
    return git(bare, ["rev-parse", "refs/heads/main"]).trim();
  } finally {
    await fs.rm(clone, { recursive: true, force: true });
  }
}

async function removeAll(...directories) {
  for (const directory of directories)
    await fs.rm(directory, { recursive: true, force: true });
}

function serveUnauthorized() {
  return new Promise((resolve) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="NCE Test"' });
      response.end("Unauthorized");
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function createRegistrar() {
  const handlers = new Map();
  return {
    handlers,
    handle: (channel, listener) => handlers.set(channel, listener),
  };
}

function createSender() {
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
}

test("remotes can be added, listed, re-targeted and removed", { skip: gitSkip }, async () => {
  const root = await createRepository();
  const bare = await createBareRemote();
  const pushBare = await createBareRemote();
  const manager = managerFor(root);
  try {
    assert.deepEqual((await manager.getRemotes()).remotes, []);
    assert.equal((await manager.getRemotes()).defaultRemote, null);

    const added = await manager.addRemote("upstream", bare);
    assert.equal(added.success, true);
    let listed = await manager.getRemotes();
    assert.deepEqual(listed.remotes, [{ name: "upstream", fetchUrl: bare, pushUrl: null }]);
    assert.equal(listed.defaultRemote, "upstream", "a single remote is the default even when it is not origin");

    assert.equal((await manager.addRemote("upstream", bare)).code, "REMOTE_EXISTS");
    assert.equal((await manager.setRemoteUrl("missing", bare)).code, "REMOTE_NOT_FOUND");
    assert.equal((await manager.removeRemote("missing")).code, "REMOTE_NOT_FOUND");

    const pushed = await manager.setRemoteUrl("upstream", pushBare, true);
    assert.equal(pushed.success, true);
    listed = await manager.getRemotes();
    assert.equal(listed.remotes[0].fetchUrl, bare);
    assert.equal(listed.remotes[0].pushUrl, pushBare);

    const fetched = await manager.setRemoteUrl("upstream", pushBare);
    assert.equal(fetched.success, true);
    listed = await manager.getRemotes();
    assert.equal(listed.remotes[0].fetchUrl, pushBare);
    assert.equal(listed.remotes[0].pushUrl, null, "matching push URL collapses to null");

    assert.equal((await manager.removeRemote("upstream")).success, true);
    assert.deepEqual((await manager.getRemotes()).remotes, []);
  } finally {
    manager.dispose();
    await removeAll(root, bare, pushBare);
  }
});

test("remote names and URLs are validated in the main process", { skip: gitSkip }, async () => {
  const root = await createRepository();
  const manager = managerFor(root);
  try {
    for (const name of ["-evil", "bad name", "../escape", "", "a/b", ".hidden", "x".repeat(101)])
      assert.equal((await manager.addRemote(name, "/tmp/repo")).code, "INVALID_ARGUMENT", `name ${name}`);
    for (const url of [
      "",
      "--upload-pack=evil",
      "javascript:alert(1)",
      "https://example.com/repo\n--upload-pack=evil",
      "https://example.com/\u0000repo",
      42,
    ])
      assert.equal((await manager.addRemote("origin", url)).code, "INVALID_ARGUMENT", `url ${url}`);
    assert.equal((await manager.addRemote("origin", "https://example.com/repo.git")).success, true);
    assert.equal((await manager.addRemote("mirror", "git@example.com:team/repo.git")).success, true);
    assert.equal((await manager.addRemote("local", "/tmp/some repo.git")).success, true);
    assert.equal((await manager.fetch({ remote: "--upload-pack=evil" })).code, "REMOTE_NOT_FOUND");
  } finally {
    manager.dispose();
    await removeAll(root);
  }
});

test("the default remote follows branch config, never a hardcoded origin", { skip: gitSkip }, async () => {
  const root = await createRepository();
  const alpha = await createBareRemote();
  const beta = await createBareRemote();
  const manager = managerFor(root);
  try {
    await manager.addRemote("alpha", alpha);
    await manager.addRemote("beta", beta);
    assert.equal((await manager.getRemotes()).defaultRemote, null, "ambiguous remotes have no default");

    git(root, ["config", "checkout.defaultRemote", "alpha"]);
    assert.equal((await manager.getRemotes()).defaultRemote, "alpha");

    git(root, ["config", "branch.main.remote", "beta"]);
    assert.equal((await manager.getRemotes()).defaultRemote, "beta", "the branch remote wins");

    git(root, ["config", "branch.main.remote", "ghost"]);
    assert.equal((await manager.getRemotes()).defaultRemote, "alpha", "unknown configured remotes are ignored");
  } finally {
    manager.dispose();
    await removeAll(root, alpha, beta);
  }
});

test("fetch updates tracking refs without touching the worktree", { skip: gitSkip }, async () => {
  const { root, bare } = await createRepositoryWithRemote();
  const manager = managerFor(root);
  try {
    assert.equal((await manager.push({ remote: "upstream", branch: "main", setUpstream: true })).success, true);
    await fs.writeFile(path.join(root, "tracked.txt"), "local work in progress\n");
    const remoteHead = await advanceRemote(bare);

    const progress = [];
    const fetched = await manager.fetch({}, { onProgress: (event) => progress.push(event) });
    assert.equal(fetched.success, true);
    assert.equal(fetched.remote, "upstream");
    assert.equal(fetched.all, false);
    assert.equal(
      git(root, ["rev-parse", "refs/remotes/upstream/main"]).trim(),
      remoteHead,
      "the tracking ref follows the remote",
    );
    assert.equal(
      await fs.readFile(path.join(root, "tracked.txt"), "utf8"),
      "local work in progress\n",
      "fetch leaves the worktree untouched",
    );
    const status = await manager.getStatus();
    assert.equal(status.status.entries.length, 1, "the local modification is still the only change");
    assert.equal(status.status.branch.behind, 1);

    assert.equal((await manager.fetch({ remote: "ghost" })).code, "REMOTE_NOT_FOUND");
  } finally {
    manager.dispose();
    await removeAll(root, bare);
  }
});

test("fetch supports all remotes, tags and prune", { skip: gitSkip }, async () => {
  const root = await createRepository();
  const alpha = await createBareRemote();
  const beta = await createBareRemote();
  const manager = managerFor(root);
  try {
    await manager.addRemote("alpha", alpha);
    await manager.addRemote("beta", beta);
    await manager.push({ remote: "alpha", branch: "main" });
    await manager.push({ remote: "beta", branch: "main" });
    const alphaHead = await advanceRemote(alpha, { file: "alpha.txt" });
    const betaHead = await advanceRemote(beta, { file: "beta.txt" });

    const fetched = await manager.fetch({ all: true });
    assert.equal(fetched.success, true);
    assert.equal(fetched.all, true);
    assert.equal(git(root, ["rev-parse", "refs/remotes/alpha/main"]).trim(), alphaHead);
    assert.equal(git(root, ["rev-parse", "refs/remotes/beta/main"]).trim(), betaHead);

    const clone = await fs.mkdtemp(path.join(os.tmpdir(), "nce-git-tag-"));
    try {
      git(clone, ["clone", "-q", alpha, "."]);
      git(clone, ["tag", "v9.9.9"]);
      git(clone, ["push", "-q", "origin", "v9.9.9"]);
    } finally {
      await fs.rm(clone, { recursive: true, force: true });
    }
    assert.equal((await manager.fetch({ remote: "alpha", tags: true })).success, true);
    assert.match(git(root, ["tag", "--list"]), /v9\.9\.9/);

    git(alpha, ["branch", "topic", "refs/heads/main"]);
    await manager.fetch({ remote: "alpha", prune: true });
    assert.match(git(root, ["branch", "-r"]), /alpha\/topic/);
    git(alpha, ["branch", "-D", "topic"]);
    await manager.fetch({ remote: "alpha", prune: true });
    assert.doesNotMatch(git(root, ["branch", "-r"]), /alpha\/topic/);
  } finally {
    manager.dispose();
    await removeAll(root, alpha, beta);
  }
});

test("pull fast-forwards, reports up-to-date and detects missing upstream", { skip: gitSkip }, async () => {
  const { root, bare } = await createRepositoryWithRemote();
  const manager = managerFor(root);
  try {
    assert.equal((await manager.pull()).code, "NO_UPSTREAM");
    assert.equal((await manager.pull({ branch: "main" })).code, "INVALID_ARGUMENT");
    assert.equal((await manager.pull({ remote: "ghost" })).code, "REMOTE_NOT_FOUND");

    await manager.push({ remote: "upstream", branch: "main", setUpstream: true });
    await advanceRemote(bare, { file: "tracked.txt", content: "updated upstream\n" });
    const pulled = await manager.pull();
    assert.equal(pulled.success, true);
    assert.equal(pulled.alreadyUpToDate, false);
    assert.equal(await fs.readFile(path.join(root, "tracked.txt"), "utf8"), "updated upstream\n");

    const again = await manager.pull();
    assert.equal(again.success, true);
    assert.equal(again.alreadyUpToDate, true);

    const status = await manager.getStatus();
    assert.equal(status.status.branch.upstream, "upstream/main");
    assert.equal(status.status.branch.ahead, 0);
    assert.equal(status.status.branch.behind, 0);
  } finally {
    manager.dispose();
    await removeAll(root, bare);
  }
});

test("pull conflicts surface as PULL_CONFLICTS and abort recovers", { skip: gitSkip }, async () => {
  const { root, bare } = await createRepositoryWithRemote();
  const manager = managerFor(root);
  try {
    await manager.push({ remote: "upstream", branch: "main", setUpstream: true });
    await advanceRemote(bare, { file: "tracked.txt", content: "their version\n" });
    await fs.writeFile(path.join(root, "tracked.txt"), "our version\n");
    git(root, ["commit", "-q", "-am", "local version"]);

    // Without a configured strategy Git refuses to reconcile divergent branches;
    // NCE must surface that instead of silently picking one.
    assert.equal((await manager.pull()).code, "PULL_STRATEGY_REQUIRED");
    // An explicit choice works without configuration; the same content conflicts
    // during the rebase, which must be reported and abortable.
    assert.equal((await manager.pull({ rebase: true })).code, "PULL_CONFLICTS");
    assert.equal((await manager.getStatus()).status.rebasing, true);
    assert.equal((await manager.abortOperation("rebase")).success, true);
    git(root, ["config", "pull.rebase", "false"]);

    const pulled = await manager.pull();
    assert.equal(pulled.success, false);
    assert.equal(pulled.code, "PULL_CONFLICTS");
    let status = await manager.getStatus();
    assert.equal(status.status.merging, true);
    assert.ok(status.status.entries.some((entry) => entry.conflicted));

    assert.equal((await manager.abortOperation("merge")).success, true);
    status = await manager.getStatus();
    assert.equal(status.status.merging, false);
    assert.equal(status.status.entries.length, 0);
    assert.equal(await fs.readFile(path.join(root, "tracked.txt"), "utf8"), "our version\n");
  } finally {
    manager.dispose();
    await removeAll(root, bare);
  }
});

test("pull respects the user's pull.rebase configuration and explicit overrides", { skip: gitSkip }, async () => {
  const { root, bare } = await createRepositoryWithRemote();
  const manager = managerFor(root);
  try {
    await manager.push({ remote: "upstream", branch: "main", setUpstream: true });
    const remoteHead = await advanceRemote(bare, { file: "remote.txt" });
    git(root, ["commit", "-q", "--allow-empty", "-m", "local work"]);
    git(root, ["config", "pull.rebase", "true"]);

    const rebased = await manager.pull();
    assert.equal(rebased.success, true, JSON.stringify(rebased));
    assert.equal(git(root, ["rev-parse", "HEAD~1"]).trim(), remoteHead, "the local commit sits on top of the remote head");
    assert.equal(git(root, ["rev-list", "--merges", "HEAD"]).trim(), "", "no merge commit was created");

    // An explicit merge choice must override the rebase configuration.
    git(root, ["reset", "-q", "--hard", "HEAD~1"]);
    git(root, ["commit", "-q", "--allow-empty", "-m", "local work again"]);
    await advanceRemote(bare, { file: "remote2.txt" });
    const merged = await manager.pull({ rebase: false });
    assert.equal(merged.success, true, JSON.stringify(merged));
    assert.ok(git(root, ["rev-list", "--merges", "HEAD"]).trim(), "explicit merge creates a merge commit");
  } finally {
    manager.dispose();
    await removeAll(root, bare);
  }
});

test("push publishes branches, sets upstream and rejects non-fast-forward", { skip: gitSkip }, async () => {
  const { root, bare } = await createRepositoryWithRemote();
  const manager = managerFor(root);
  try {
    assert.equal((await manager.push()).code, "NO_UPSTREAM");
    assert.equal((await manager.push({ forceWithLease: true })).code, "INVALID_ARGUMENT");
    assert.equal(
      (await manager.push({ forceWithLease: true, remote: "upstream" })).code,
      "INVALID_ARGUMENT",
      "force with lease needs an explicit branch too",
    );

    const published = await manager.push({ remote: "upstream", branch: "main", setUpstream: true });
    assert.equal(published.success, true);
    assert.equal(published.forced, false);
    assert.equal(git(bare, ["rev-parse", "refs/heads/main"]).trim(), git(root, ["rev-parse", "HEAD"]).trim());
    assert.equal((await manager.getStatus()).status.branch.upstream, "upstream/main");

    await advanceRemote(bare, { file: "remote.txt" });
    git(root, ["commit", "-q", "--allow-empty", "-m", "divergent local work"]);
    const rejected = await manager.push();
    assert.equal(rejected.success, false);
    assert.equal(rejected.code, "PUSH_REJECTED");

    // The lease only allows a force once the remote move is known locally.
    assert.equal((await manager.fetch()).success, true);
    const forced = await manager.push({ remote: "upstream", branch: "main", forceWithLease: true });
    assert.equal(forced.success, true);
    assert.equal(forced.forced, true);
    assert.equal(git(bare, ["rev-parse", "refs/heads/main"]).trim(), git(root, ["rev-parse", "HEAD"]).trim());
  } finally {
    manager.dispose();
    await removeAll(root, bare);
  }
});

test("force with lease refuses to overwrite unseen remote commits", { skip: gitSkip }, async () => {
  const { root, bare } = await createRepositoryWithRemote();
  const manager = managerFor(root);
  try {
    await manager.push({ remote: "upstream", branch: "main", setUpstream: true });
    await advanceRemote(bare, { file: "unseen.txt" });
    git(root, ["commit", "-q", "--allow-empty", "-m", "local rewrite"]);

    const stale = await manager.push({ remote: "upstream", branch: "main", forceWithLease: true });
    assert.equal(stale.success, false, "the lease must fail while the remote move is unseen");
    assert.equal(stale.code, "PUSH_REJECTED");
    assert.ok(
      git(bare, ["rev-parse", "refs/heads/main"]).trim() !== git(root, ["rev-parse", "HEAD"]).trim(),
      "the unseen remote commit survives",
    );

    assert.equal((await manager.fetch()).success, true);
    const informed = await manager.push({ remote: "upstream", branch: "main", forceWithLease: true });
    assert.equal(informed.success, true, "after fetching, the lease is informed and the force succeeds");
  } finally {
    manager.dispose();
    await removeAll(root, bare);
  }
});

test("push streams real progress for the requesting window", { skip: gitSkip }, async () => {
  const root = await createRepository({ commits: 0 });
  const bare = await createBareRemote();
  const manager = managerFor(root);
  try {
    for (let index = 0; index < 150; index += 1)
      await fs.writeFile(path.join(root, `file-${index}.txt`), `content ${index}\n`.repeat(20));
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "many objects"]);
    await manager.addRemote("upstream", bare);

    const ipc = createRegistrar();
    manager.handleIPC(ipc);
    const sender = createSender();
    const result = await ipc.handlers.get("Git:push")(
      { sender },
      { remote: "upstream", branch: "main", setUpstream: true },
    );
    assert.equal(result.success, true);
    const events = sender.sent.filter((message) => message.channel === "Git:networkProgress");
    assert.ok(events.length > 0, "progress events reach the requesting window");
    assert.ok(events.every((message) => message.payload.operation === "push"));
    assert.ok(events.some((message) => message.payload.phase === "Writing objects"));
    assert.ok(events.some((message) => message.payload.percent === 100));
    assert.equal(await ipc.handlers.get("Git:cancelNetworkOperation")({ sender }), false, "nothing to cancel when idle");
  } finally {
    manager.dispose();
    await removeAll(root, bare);
  }
});

test("network operations can be cancelled and time out", { skip: posixSkip }, async () => {
  const { root, bare } = await createRepositoryWithRemote();
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "nce-git-slow-"));
  const script = path.join(fixtureDir, "slow-upload-pack.sh");
  await fs.writeFile(
    script,
    "#!/bin/sh\nprintf 'Receiving objects:  10%% (1/10)\\r' >&2\nsleep 30\nexec git-upload-pack \"$@\"\n",
  );
  await fs.chmod(script, 0o755);
  git(root, ["config", "remote.upstream.uploadpack", script]);
  const manager = managerFor(root);
  const timed = managerFor(root, { networkTimeoutMs: 400 });
  try {
    const controller = new AbortController();
    const progress = [];
    const pending = manager.fetch({}, {
      signal: controller.signal,
      onProgress: (event) => progress.push(event),
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    const started = Date.now();
    const cancelled = await pending;
    assert.equal(cancelled.success, false);
    assert.equal(cancelled.code, "OPERATION_CANCELLED");
    assert.ok(Date.now() - started < 5000, "cancellation kills the process tree quickly");
    assert.ok(
      progress.some((event) => event.operation === "fetch" && event.phase === "Receiving objects" && event.percent === 10),
      "progress lines are parsed before cancellation",
    );

    const pendingIpc = manager.fetch();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(manager.cancelNetworkOperation(), true);
    assert.equal((await pendingIpc).code, "OPERATION_CANCELLED");
    assert.equal(manager.cancelNetworkOperation(), false);

    const timeoutStarted = Date.now();
    assert.equal((await timed.fetch()).code, "GIT_TIMEOUT");
    assert.ok(Date.now() - timeoutStarted < 8000, "the network timeout applies to fetch");

    const status = await manager.getStatus();
    assert.equal(status.status.entries.length, 0, "cancelled fetches leave the repository clean");
  } finally {
    manager.dispose();
    timed.dispose();
    await removeAll(root, bare, fixtureDir);
  }
});

test("authentication failures are actionable and never leak credentials", { skip: gitSkip }, async () => {
  const { server, origin } = await serveUnauthorized();
  const root = await createRepository();
  const manager = managerFor(root);
  try {
    await manager.addRemote("upstream", `${origin}/repo.git`);
    const failed = await manager.fetch();
    assert.equal(failed.success, false);
    assert.equal(failed.code, "AUTH_REQUIRED");
    assert.match(failed.error, /credential helper|SSH key/i);

    await manager.setRemoteUrl("upstream", `http://user:supersecret@127.0.0.1:${server.address().port}/repo.git`);
    const leaked = await manager.fetch();
    assert.equal(leaked.success, false);
    assert.equal(leaked.code, "AUTH_REQUIRED");
    assert.ok(!JSON.stringify(leaked).includes("supersecret"), "credentials never reach the result");
  } finally {
    manager.dispose();
    server.close();
    await removeAll(root);
  }
});

test("redactCredentials strips passwords and tokens from URLs", () => {
  assert.equal(
    redactCredentials("fatal: Authentication failed for 'https://alice:s3cret@example.com/repo.git'"),
    "fatal: Authentication failed for 'https://alice:<redacted>@example.com/repo.git'",
  );
  assert.equal(
    redactCredentials("https://ghp_token123@github.com/team/repo.git"),
    "https://<redacted>@github.com/team/repo.git",
  );
  assert.equal(
    redactCredentials("git@github.com:team/repo.git and http://bob:pw@host/x"),
    "git@github.com:team/repo.git and http://bob:<redacted>@host/x",
  );
  assert.equal(redactCredentials("no credentials here"), "no credentials here");
});

test("remote IPC channels are registered and routed to the requesting window", { skip: gitSkip }, async () => {
  const { root, bare } = await createRepositoryWithRemote();
  const manager = managerFor(root);
  try {
    const ipc = createRegistrar();
    manager.handleIPC(ipc);
    for (const channel of [
      "Git:remotes", "Git:addRemote", "Git:setRemoteUrl", "Git:removeRemote",
      "Git:fetch", "Git:pull", "Git:push", "Git:cancelNetworkOperation",
    ])
      assert.ok(ipc.handlers.has(channel), `${channel} is registered`);

    const sender = createSender();
    const listed = await ipc.handlers.get("Git:remotes")({ sender });
    assert.equal(listed.remotes[0].name, "upstream");
    const pushed = await ipc.handlers.get("Git:push")(
      { sender },
      { remote: "upstream", branch: "main", setUpstream: true },
    );
    assert.equal(pushed.success, true);
    const fetched = await ipc.handlers.get("Git:fetch")({ sender }, { remote: "upstream" });
    assert.equal(fetched.success, true);
    assert.equal(
      (await ipc.handlers.get("Git:pull")({ sender }, { remote: "ghost" })).code,
      "REMOTE_NOT_FOUND",
    );
  } finally {
    manager.dispose();
    await removeAll(root, bare);
  }
});