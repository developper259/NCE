"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { promises: fs } = require("node:fs");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { git: managedGit } = require("../dist/ts/packages/git.js");
const { git: gitDistribution } = require("../dist/ts/installer/packages/git.js");
const { Installer } = require("../dist/ts/installer/Installer.js");
const { InstallationStore } = require("../dist/ts/packages/InstallationStore.js");
const { PackageManager } = require("../dist/ts/packages/PackageManager.js");
const { PackageRegistry } = require("../dist/ts/packages/PackageRegistry.js");
const { GitManager } = require("../dist/ts/manager/GitManager.js");
const { PathAccess } = require("../dist/ts/manager/PathAccess.js");
const { resolveGitExecutable, trustedGitCandidates } = require("../dist/ts/manager/GitProcess.js");
const { tempDir } = require("./helpers/installer.js");
const {
  GIT_FIXTURE_VERSION: FIXTURE_VERSION,
  gitFixtureDistribution,
  serveGitFixture,
  plantGit,
  memorySettings,
} = require("./helpers/version-manager.js");

const posixSkip = process.platform === "win32" ? "POSIX shell-script Git fixture" : false;
const networkSkip = process.env.NCE_INSTALLER_NETWORK === "1"
  ? false
  : "set NCE_INSTALLER_NETWORK=1 to download the real Git distribution";

let systemGitVersion = null;
try {
  systemGitVersion = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
} catch {}
const gitSkip = systemGitVersion ? false : "Git CLI is required";

// Keep the developer's global Git configuration out of every fixture repository.
const emptyConfig = path.join(os.tmpdir(), `nce-vm-git-empty-${process.pid}.gitconfig`);
fsSync.writeFileSync(emptyConfig, "");
process.on("exit", () => {
  try { fsSync.unlinkSync(emptyConfig); } catch {}
});
const isolatedEnv = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig };

function createGitManager(userDataPath, { distribution = gitDistribution, settings = memorySettings() } = {}) {
  const installer = new Installer({ userDataPath, registry: { [distribution.id]: distribution } });
  const registry = new PackageRegistry([managedGit]);
  const store = new InstallationStore(userDataPath);
  const manager = new PackageManager({ userDataPath, installer, registry, store, settings });
  return { manager, installer, store, settings };
}

// Mirrors the production wiring: GitManager reads git.path on every resolution.
function gitManagerFor(workspace, settings) {
  return new GitManager({
    getWorkspaceRoot: () => workspace,
    pathAccess: new PathAccess(() => workspace),
    getGitPath: () => settings.get("git.path"),
    env: isolatedEnv,
  });
}

async function findSystemGit() {
  for (const candidate of trustedGitCandidates(process.platform)) {
    const stats = await fs.stat(candidate).catch(() => null);
    if (!stats?.isFile()) continue;
    if (process.platform !== "win32" && (stats.mode & 0o111) === 0) continue;
    return candidate;
  }
  return null;
}

async function createRepository() {
  const root = await tempDir("nce-vm-git-repo-");
  const git = (args) => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...isolatedEnv },
  });
  git(["init", "-q"]);
  git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(["config", "user.name", "NCE Test"]);
  git(["config", "user.email", "nce@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(root, "tracked.txt"), "initial\n");
  git(["add", "--", "tracked.txt"]);
  git(["commit", "-q", "-m", "initial"]);
  return root;
}

async function removeAll(...directories) {
  for (const directory of directories)
    await fs.rm(directory, { recursive: true, force: true });
}

test("Version Manager installs Git into tools/git and adopts an empty git.path", { skip: posixSkip }, async () => {
  const root = await tempDir("nce-vm-git-install-");
  const fixture = await serveGitFixture();
  const { manager, store, settings } = createGitManager(root, { distribution: fixture.distribution });
  try {
    await manager.initialize();
    assert.equal(manager.getState().packages.find((entry) => entry.id === "git").state, "not-installed");

    const result = await manager.install("git");
    assert.equal(result.success, true, result.error);
    assert.equal(result.installDir, path.join(root, "tools", "git", FIXTURE_VERSION));
    assert.equal(result.executable, path.join(result.installDir, "bin", "git"));

    const records = store.listByPackage("git");
    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.packageId, "git");
    assert.equal(record.version, FIXTURE_VERSION);
    assert.equal(record.state, "installed");
    assert.equal(record.provenance, "managed");
    assert.equal(record.uninstall.strategy, "installer-directory");
    assert.equal(record.source.url, `${fixture.server.origin}/git.tar.gz`);
    assert.equal(record.source.checksum, fixture.distribution.platforms[process.platform][process.arch].download.checksum);
    assert.equal(settings.get("git.path"), record.executable);
    assert.equal(manager.getState().packages.find((entry) => entry.id === "git").state, "installed");

    const stdout = execFileSync(record.executable, ["--version"], { encoding: "utf8" });
    assert.match(stdout, /git version 2\.56\.1/);
  } finally {
    await fixture.server.close();
    await removeAll(root, fixture.dir);
  }
});

test("reconciliation imports a pre-existing Git installation without reinstalling", { skip: posixSkip }, async () => {
  const root = await tempDir("nce-vm-git-import-");
  // Directory name deliberately differs from the binary's reported version: the
  // inventory must trust the executable, not the folder label.
  const planted = await plantGit(root, "9.9.9", FIXTURE_VERSION);
  // The pre-Version-Manager install flow already configured git.path; migration
  // must adopt the installation without touching the user's settings.
  const settings = memorySettings({ "git.path": planted.executable });
  const { manager, store } = createGitManager(root, { settings });
  try {
    await manager.initialize();
    const records = store.listByPackage("git");
    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.installDir, planted.dir);
    assert.equal(record.executable, planted.executable);
    assert.equal(record.version, FIXTURE_VERSION);
    assert.equal(record.state, "installed");
    assert.equal(record.provenance, "managed");
    assert.ok(record.installedAt > 0);
    assert.equal(settings.get("git.path"), planted.executable);
    assert.deepEqual(settings.writes, []);

    const persisted = JSON.parse(await fs.readFile(store.filePath, "utf8"));
    assert.equal(persisted.schemaVersion, 1);
    assert.equal(persisted.installations.length, 1);

    // A second reconciliation keeps the same record instead of duplicating it.
    await manager.refresh();
    assert.equal(store.listByPackage("git").length, 1);
    assert.equal(store.listByPackage("git")[0].id, record.id);
  } finally {
    await removeAll(root);
  }
});

test("verify reads the real version and flags a corrupted Git installation", { skip: posixSkip }, async () => {
  const root = await tempDir("nce-vm-git-verify-");
  const planted = await plantGit(root, FIXTURE_VERSION);
  // Version-probe-only distribution: the real definition's functional Git
  // lifecycle is exercised by the network-gated test below.
  const distribution = gitFixtureDistribution("https://example.invalid/git.tar.gz", "0".repeat(64));
  const { manager, store } = createGitManager(root, { distribution });
  try {
    await manager.initialize();
    const record = store.listByPackage("git")[0];

    const verified = await manager.verify(record.id);
    assert.equal(verified.success, true);
    assert.equal(verified.installation.state, "installed");
    assert.equal(verified.installation.version, FIXTURE_VERSION);
    assert.ok(verified.installation.verifiedAt > 0);

    await fs.rm(planted.executable);
    const corrupted = await manager.verify(record.id);
    // A failed verification is a failed operation: callers must not treat it
    // as a green light to uninstall the components this one replaces.
    assert.equal(corrupted.success, false);
    assert.equal(corrupted.code, "VERIFICATION_FAILED");
    assert.equal(manager.getState().packages.find((entry) => entry.id === "git").state, "corrupted");
  } finally {
    await removeAll(root);
  }
});

test("uninstall removes only the managed Git directory and clears the managed git.path", { skip: posixSkip }, async () => {
  const root = await tempDir("nce-vm-git-uninstall-");
  const fixture = await serveGitFixture();
  const { manager, store, settings } = createGitManager(root, { distribution: fixture.distribution });
  // A second, valid Git version plus a file outside the managed tree: uninstall
  // must remove exactly the targeted directory and nothing else.
  const sibling = await plantGit(root, "keep-dir");
  const sentinel = path.join(root, "external-keep.txt");
  try {
    await fs.writeFile(sentinel, "keep\n");

    await manager.initialize();
    const installed = await manager.install("git");
    assert.equal(installed.success, true, installed.error);
    const record = store.listByPackage("git").find((entry) => entry.installDir === installed.installDir);
    assert.ok(record);
    assert.equal(settings.get("git.path"), record.executable);

    const removed = await manager.uninstall(record.id);
    assert.equal(removed.success, true, removed.error);
    assert.equal(removed.installDir, record.installDir);
    await assert.rejects(fs.stat(record.installDir), { code: "ENOENT" });
    assert.equal(settings.get("git.path"), "");

    // The sibling version survives, still runs, and stays in the inventory.
    assert.match(execFileSync(sibling.executable, ["--version"], { encoding: "utf8" }), /git version /);
    const remaining = store.listByPackage("git");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].installDir, sibling.dir);
    assert.equal(remaining[0].state, "installed");
    assert.equal(manager.getState().packages.find((entry) => entry.id === "git").state, "installed");
    assert.equal(await fs.readFile(sentinel, "utf8"), "keep\n");
  } finally {
    await fixture.server.close();
    await removeAll(root, fixture.dir);
  }
});

test("external Git is reported with provenance and is never uninstallable", { skip: gitSkip }, async () => {
  const root = await tempDir("nce-vm-git-external-");
  const { manager, store } = createGitManager(root);
  try {
    const system = await findSystemGit();
    assert.ok(system, "a trusted system Git candidate must exist");
    await manager.initialize();

    const info = manager.getState().packages.find((entry) => entry.id === "git");
    assert.equal(info.state, "not-installed");
    assert.equal(info.installations.length, 0);
    assert.ok(info.external);
    assert.equal(info.external.packageId, "git");
    assert.equal(info.external.provenance, "external");
    assert.equal(info.external.executable, system);
    assert.match(info.external.version, /^\d+\.\d+/);
    // External installations expose no managed record and no uninstall handle.
    assert.equal(info.external.id, undefined);
    assert.equal(info.external.installDir, undefined);
    assert.equal(store.listByPackage("git").length, 0);

    const refused = await manager.uninstall("external");
    assert.equal(refused.success, false);
    assert.equal(refused.code, "INSTALLATION_NOT_FOUND");
    assert.match(execFileSync(system, ["--version"], { encoding: "utf8" }), /git version /);
  } finally {
    await removeAll(root);
  }
});

test("install and uninstall never override an explicit external git.path", { skip: posixSkip }, async () => {
  const root = await tempDir("nce-vm-git-external-path-");
  const fixture = await serveGitFixture();
  const externalPath = path.join(root, "external-git", "bin", "git");
  const settings = memorySettings({ "git.path": externalPath });
  const { manager, store } = createGitManager(root, { distribution: fixture.distribution, settings });
  try {
    await manager.initialize();
    const installed = await manager.install("git");
    assert.equal(installed.success, true, installed.error);
    assert.equal(settings.get("git.path"), externalPath);

    const record = store.listByPackage("git")[0];
    const removed = await manager.uninstall(record.id);
    assert.equal(removed.success, true, removed.error);
    assert.equal(settings.get("git.path"), externalPath);
    assert.deepEqual(settings.writes, []);
  } finally {
    await fixture.server.close();
    await removeAll(root, fixture.dir);
  }
});

test("GitManager resolves the managed Git through git.path", { skip: posixSkip }, async () => {
  const root = await tempDir("nce-vm-git-manager-");
  const workspace = await tempDir("nce-vm-git-ws-");
  const fixture = await serveGitFixture();
  const { manager, settings } = createGitManager(root, { distribution: fixture.distribution });
  const gitManager = gitManagerFor(workspace, settings);
  try {
    await manager.initialize();
    const installed = await manager.install("git");
    assert.equal(installed.success, true, installed.error);

    assert.equal(await gitManager.isGitAvailable(), true);
    const version = await gitManager.getGitVersion();
    assert.equal(version.success, true);
    assert.equal(version.version, FIXTURE_VERSION);
  } finally {
    gitManager.dispose();
    await fixture.server.close();
    await removeAll(root, workspace, fixture.dir);
  }
});

test("uninstall leaves the external Git intact and GitManager falls back to it", { skip: posixSkip || gitSkip }, async () => {
  const root = await tempDir("nce-vm-git-fallback-");
  const fixture = await serveGitFixture();
  const { manager, store, settings } = createGitManager(root, { distribution: fixture.distribution });
  const system = await findSystemGit();
  const repo = await createRepository();
  const gitManager = gitManagerFor(repo, settings);
  try {
    await manager.initialize();
    const installed = await manager.install("git");
    assert.equal(installed.success, true, installed.error);
    assert.equal(settings.get("git.path"), installed.executable);

    const before = await gitManager.getGitVersion();
    assert.equal(before.success, true);
    assert.equal(before.version, FIXTURE_VERSION);

    const record = store.listByPackage("git")[0];
    const removed = await manager.uninstall(record.id);
    assert.equal(removed.success, true, removed.error);
    assert.equal(settings.get("git.path"), "");

    // The external binary is untouched and still runs.
    assert.ok((await fs.stat(system)).isFile());
    assert.match(execFileSync(system, ["--version"], { encoding: "utf8" }), /git version /);
    const resolved = await resolveGitExecutable({ explicit: settings.get("git.path") || undefined });
    assert.equal(resolved, system);

    // GitManager re-resolves after the settings change and works on a real repo.
    assert.equal(await gitManager.isGitAvailable(), true);
    const after = await gitManager.getGitVersion();
    assert.equal(after.success, true);
    assert.equal(after.version, systemGitVersion.match(/git version (\S+)/)[1]);
    const repository = await gitManager.getRepository();
    assert.equal(repository.success, true);
    assert.equal(repository.repository.root, await fs.realpath(repo));
  } finally {
    gitManager.dispose();
    await fixture.server.close();
    await removeAll(root, repo, fixture.dir);
  }
});

test("Version Manager installs, verifies, uses and uninstalls the real Git", { skip: networkSkip || gitSkip, timeout: 600000 }, async () => {
  const root = await tempDir("nce-vm-git-real-");
  const { manager, store, settings } = createGitManager(root);
  const repo = await createRepository();
  const gitManager = gitManagerFor(repo, settings);
  try {
    await manager.initialize();
    const result = await manager.install("git");
    assert.equal(result.success, true, result.error);
    assert.equal(result.installDir, path.join(root, "tools", "git", "2.56.1"));

    const record = store.listByPackage("git")[0];
    assert.match(record.version, /^2\.56\.1(?:\.windows\.\d+)?$/);
    assert.equal(record.provenance, "managed");
    assert.equal(settings.get("git.path"), record.executable);

    // Functional verification runs a real Git lifecycle (init/commit/status/log).
    const verified = await manager.verify(record.id);
    assert.equal(verified.success, true);
    assert.equal(verified.installation.state, "installed");
    assert.match(verified.installation.version, /^2\.56\.1(?:\.windows\.\d+)?$/);

    // GitManager drives the managed binary against a real repository.
    assert.equal(await gitManager.isGitAvailable(), true);
    const version = await gitManager.getGitVersion();
    assert.equal(version.success, true);
    assert.match(version.version, /^2\.56\.1(?:\.windows\.\d+)?$/);
    const repository = await gitManager.getRepository();
    assert.equal(repository.success, true);
    assert.equal(repository.repository.root, await fs.realpath(repo));

    const removed = await manager.uninstall(record.id);
    assert.equal(removed.success, true, removed.error);
    await assert.rejects(fs.stat(result.installDir), { code: "ENOENT" });
    assert.equal(store.listByPackage("git").length, 0);
    assert.equal(settings.get("git.path"), "");
  } finally {
    gitManager.dispose();
    await removeAll(root, repo);
  }
});