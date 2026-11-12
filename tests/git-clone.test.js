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
const gitSkip = !gitAvailable && "Git CLI is required for Git clone tests";

const emptyConfig = path.join(os.tmpdir(), `nce-git-clone-empty-${process.pid}.gitconfig`);
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

async function makeTemp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function configureIdentity(root) {
  git(root, ["config", "user.name", "NCE Test"]);
  git(root, ["config", "user.email", "nce@example.invalid"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["config", "core.autocrlf", "false"]);
}

/** A bare repository with real history, like a remote another developer pushed to. */
async function createSourceBare({ files = 1, name = "source.git" } = {}) {
  const work = await makeTemp("nce-git-clone-work-");
  const parent = await makeTemp("nce-git-clone-bare-");
  const bare = path.join(parent, name);
  try {
    git(work, ["init", "-q"]);
    git(work, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    configureIdentity(work);
    for (let index = 0; index < files; index += 1)
      await fs.writeFile(path.join(work, `file-${index}.txt`), `content ${index}\n`.repeat(20));
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "initial"]);
    git(work, ["clone", "-q", "--bare", work, bare]);
    git(bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    return { bare, parent };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

async function removeAll(...directories) {
  for (const directory of directories)
    await fs.rm(directory, { recursive: true, force: true });
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

async function exists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

test("clone creates a working repository and derives the folder name from the URL", { skip: gitSkip }, async () => {
  const { bare, parent } = await createSourceBare({ name: "my-project.git" });
  const destination = await makeTemp("nce-git-clone-dest-");
  const realDestination = await fs.realpath(destination);
  const manager = managerFor(destination);
  try {
    const progress = [];
    const result = await manager.clone(
      { url: bare, destination },
      { onProgress: (event) => progress.push(event) },
    );
    assert.equal(result.success, true);
    assert.equal(result.folderName, "my-project", "the .git suffix is stripped from the derived name");
    assert.equal(result.path, path.join(realDestination, "my-project"));
    assert.equal(
      await fs.readFile(path.join(result.path, "file-0.txt"), "utf8"),
      "content 0\n".repeat(20),
      "the worktree is checked out",
    );
    assert.equal(git(result.path, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main");
    assert.equal(
      git(result.path, ["log", "-1", "--format=%s"]).trim(),
      "initial",
      "the cloned history is present",
    );
    assert.equal(
      git(result.path, ["remote", "get-url", "origin"]).trim(),
      bare,
      "the source becomes the origin remote",
    );
    assert.ok(progress.every((event) => event.operation === "clone"), "progress is tagged as clone");
  } finally {
    manager.dispose();
    await removeAll(destination, parent);
  }
});

test("clone honours an explicit folder name and branch", { skip: gitSkip }, async () => {
  const { bare, parent } = await createSourceBare();
  const destination = await makeTemp("nce-git-clone-dest-");
  const realDestination = await fs.realpath(destination);
  const manager = managerFor(destination);
  try {
    const result = await manager.clone({ url: bare, destination, folderName: "custom-name", branch: "main" });
    assert.equal(result.success, true);
    assert.equal(result.folderName, "custom-name");
    assert.equal(result.path, path.join(realDestination, "custom-name"));
    assert.equal(await exists(path.join(destination, "custom-name", ".git")), true);
  } finally {
    manager.dispose();
    await removeAll(destination, parent);
  }
});

test("clone validates the URL, destination and folder name in the main process", { skip: gitSkip }, async () => {
  const { bare, parent } = await createSourceBare();
  const destination = await makeTemp("nce-git-clone-dest-");
  const manager = managerFor(destination);
  try {
    for (const url of ["", "--upload-pack=evil", "javascript:alert(1)", "https://example.com/repo\n--upload-pack=evil", 42])
      assert.equal((await manager.clone({ url, destination })).code, "INVALID_ARGUMENT", `url ${url}`);
    for (const folderName of ["../escape", "a/b", "", "-evil", ".", "..", "bad:name", "x".repeat(256)])
      assert.equal((await manager.clone({ url: bare, destination, folderName })).code, "INVALID_ARGUMENT", `folder ${folderName}`);
    assert.equal((await manager.clone({ url: bare, destination: path.join(destination, "missing") })).code, "INVALID_PATH");
    assert.equal((await manager.clone({ url: bare, destination: "relative/path" })).code, "INVALID_PATH");
    assert.equal((await manager.clone({ url: bare })).code, "INVALID_PATH");
    const file = path.join(destination, "a-file.txt");
    await fs.writeFile(file, "x");
    assert.equal((await manager.clone({ url: bare, destination: file })).code, "INVALID_PATH");
    assert.equal((await manager.clone({ url: bare, destination, branch: "bad branch" })).code, "INVALID_ARGUMENT");
  } finally {
    manager.dispose();
    await removeAll(destination, parent);
  }
});

test("clone refuses a non-empty destination and preserves its data", { skip: gitSkip }, async () => {
  const { bare, parent } = await createSourceBare({ name: "occupied.git" });
  const destination = await makeTemp("nce-git-clone-dest-");
  const occupied = path.join(destination, "occupied");
  await fs.mkdir(occupied);
  await fs.writeFile(path.join(occupied, "precious.txt"), "do not delete\n");
  const manager = managerFor(destination);
  try {
    const result = await manager.clone({ url: bare, destination });
    assert.equal(result.success, false);
    assert.equal(result.code, "CLONE_DESTINATION_EXISTS");
    assert.equal(
      await fs.readFile(path.join(occupied, "precious.txt"), "utf8"),
      "do not delete\n",
      "pre-existing data is never touched",
    );
  } finally {
    manager.dispose();
    await removeAll(destination, parent);
  }
});

test("clone refuses when a file already occupies the target name", { skip: gitSkip }, async () => {
  const { bare, parent } = await createSourceBare({ name: "blocked.git" });
  const destination = await makeTemp("nce-git-clone-dest-");
  await fs.writeFile(path.join(destination, "blocked"), "not a directory\n");
  const manager = managerFor(destination);
  try {
    const result = await manager.clone({ url: bare, destination });
    assert.equal(result.code, "CLONE_DESTINATION_EXISTS");
    assert.equal(await fs.readFile(path.join(destination, "blocked"), "utf8"), "not a directory\n");
  } finally {
    manager.dispose();
    await removeAll(destination, parent);
  }
});

test("a failed clone removes only the destination it created", { skip: gitSkip }, async () => {
  const { bare, parent } = await createSourceBare();
  const destination = await makeTemp("nce-git-clone-dest-");
  const manager = managerFor(destination);
  try {
    const created = await manager.clone({ url: bare, destination, folderName: "fresh", branch: "no-such-branch" });
    assert.equal(created.success, false);
    assert.equal(await exists(path.join(destination, "fresh")), false, "the partial clone it created is cleaned up");

    const preexisting = path.join(destination, "preexisting");
    await fs.mkdir(preexisting);
    const kept = await manager.clone({ url: bare, destination, folderName: "preexisting", branch: "no-such-branch" });
    assert.equal(kept.success, false);
    assert.equal(await exists(preexisting), true, "a pre-existing empty folder is never deleted");
  } finally {
    manager.dispose();
    await removeAll(destination, parent);
  }
});

test("clone reports progress for a repository with many objects", { skip: gitSkip }, async () => {
  const { bare, parent } = await createSourceBare({ files: 200 });
  const destination = await makeTemp("nce-git-clone-dest-");
  const manager = managerFor(destination);
  try {
    const progress = [];
    const result = await manager.clone(
      { url: `file://${bare}`, destination },
      { onProgress: (event) => progress.push(event) },
    );
    assert.equal(result.success, true);
    assert.ok(progress.length > 0, "clone emits progress events");
    assert.ok(progress.every((event) => event.operation === "clone"));
    assert.ok(progress.some((event) => event.percent === 100), "progress reaches completion");
  } finally {
    manager.dispose();
    await removeAll(destination, parent);
  }
});

test("clone can be cancelled and times out without leaving a partial destination", { skip: gitSkip }, async () => {
  const { bare, parent } = await createSourceBare({ files: 200 });
  const destination = await makeTemp("nce-git-clone-dest-");
  const manager = managerFor(destination);
  const timed = managerFor(destination, { networkTimeoutMs: 1 });
  try {
    const controller = new AbortController();
    controller.abort();
    const preAborted = await manager.clone(
      { url: bare, destination, folderName: "pre-aborted" },
      { signal: controller.signal },
    );
    assert.equal(preAborted.success, false);
    assert.equal(preAborted.code, "OPERATION_CANCELLED");
    assert.equal(await exists(path.join(destination, "pre-aborted")), false, "a pre-aborted clone creates nothing");

    const pendingIpc = manager.clone({ url: bare, destination, folderName: "ipc-cancel" });
    const ipcDeadline = Date.now() + 5000;
    let ipcCancelled = false;
    while (Date.now() < ipcDeadline) {
      if (manager.cancelNetworkOperation()) { ipcCancelled = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(ipcCancelled, true, "a running clone can be cancelled over IPC");
    const cancelled = await pendingIpc;
    assert.equal(cancelled.code, "OPERATION_CANCELLED");
    assert.equal(await exists(path.join(destination, "ipc-cancel")), false, "the cancelled clone is cleaned up");
    assert.equal(manager.cancelNetworkOperation(), false, "nothing left to cancel");

    const timeoutStarted = Date.now();
    const timedOut = await timed.clone({ url: bare, destination, folderName: "timed" });
    assert.equal(timedOut.code, "GIT_TIMEOUT");
    assert.ok(Date.now() - timeoutStarted < 8000, "the network timeout applies to clone");
    assert.equal(await exists(path.join(destination, "timed")), false, "the timed-out clone is cleaned up");
  } finally {
    manager.dispose();
    timed.dispose();
    await removeAll(destination, parent);
  }
});

test("clone IPC is registered and routes progress to the requesting window", { skip: gitSkip }, async () => {
  const { bare, parent } = await createSourceBare({ files: 150, name: "ipc-source.git" });
  const destination = await makeTemp("nce-git-clone-dest-");
  const manager = managerFor(destination);
  try {
    const ipc = createRegistrar();
    manager.handleIPC(ipc);
    assert.ok(ipc.handlers.has("Git:clone"), "Git:clone is registered");
    const sender = createSender();
    const result = await ipc.handlers.get("Git:clone")(
      { sender },
      { url: `file://${bare}`, destination },
    );
    assert.equal(result.success, true);
    assert.equal(result.folderName, "ipc-source");
    const events = sender.sent.filter((message) => message.channel === "Git:networkProgress");
    assert.ok(events.length > 0, "progress events reach the requesting window");
    assert.ok(events.every((message) => message.payload.operation === "clone"));
  } finally {
    manager.dispose();
    await removeAll(destination, parent);
  }
});
