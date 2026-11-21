"use strict";

const path = require("node:path");
const { promises: fs } = require("node:fs");
const { makeTarGz, serve, sha256, staticRoute, tempDir } = require("./installer.js");
const { Installer } = require("../../dist/ts/installer/Installer.js");
const { git: gitDistribution } = require("../../dist/ts/installer/packages/git.js");
const { git: gitManaged } = require("../../dist/ts/packages/git.js");
const { PackageManager } = require("../../dist/ts/packages/PackageManager.js");
const { PackageRegistry } = require("../../dist/ts/packages/PackageRegistry.js");
const { InstallationStore } = require("../../dist/ts/packages/InstallationStore.js");
const { VersionManager } = require("../../dist/ts/manager/VersionManager.js");

const NODE = process.execPath;
const GIT_FIXTURE_VERSION = "2.56.1";

/** A cross-platform fake tool whose verification prints a parseable version. */
async function toolFixture(version = "1.2.3") {
  const dir = await tempDir("nce-vm-fixture-");
  const file = path.join(dir, "tool.tar.gz");
  await makeTarGz([
    { name: "version.js", data: `console.log("tool version ${version}");\n` },
  ], file);
  const body = await fs.readFile(file);
  return { dir, body, checksum: sha256(body), version };
}

function toolDistribution(url, checksum, id = "tool", version = "1.2.3") {
  return {
    id,
    name: "Tool",
    version,
    platforms: {
      [process.platform]: {
        [process.arch]: {
          download: { url, checksum, checksumAlgorithm: "sha256" },
          archive: { format: "tar.gz" },
          executable: "version.js",
        },
      },
    },
    install: { destination: "tools/{id}/{version}", steps: [{ type: "download" }, { type: "extract" }] },
    verification: { executable: NODE, args: ["{installDir}/version.js"] },
  };
}

function managedTool(id = "tool", version = "1.2.3", extra = {}) {
  return {
    id,
    name: "Tool",
    description: "A test tool managed by NCE.",
    categories: ["other"],
    platforms: [process.platform],
    capabilities: ["install", "uninstall", "verify"],
    installerPackageId: id,
    installableVersion: version,
    installationRoot: `tools/${id}`,
    uninstall: { strategy: "installer-directory" },
    versionPattern: "tool version (\\S+)",
    versionArgs: ["--version"],
    ...extra,
  };
}

function createManager(userDataPath, { distributions, managed, settings, now } = {}) {
  const installer = new Installer({ userDataPath, registry: distributions });
  const registry = new PackageRegistry(managed);
  const store = new InstallationStore(userDataPath, { now });
  const manager = new PackageManager({ userDataPath, installer, registry, store, settings, now });
  return { manager, installer, registry, store };
}

function memorySettings(initial = {}) {
  const values = { ...initial };
  const writes = [];
  return {
    values,
    writes,
    get: (key) => values[key],
    set: async (key, value) => {
      values[key] = value;
      writes.push({ key, value });
      return true;
    },
  };
}

/**
 * A deterministic stand-in for the dugite-native distribution: same layout
 * (bin/git, tools/{id}/{version}) but the binary is a shell script that only
 * answers --version. POSIX-only; the real distribution covers other platforms.
 */
function gitFixtureDistribution(url, checksum) {
  return {
    id: "git",
    name: "Git",
    version: GIT_FIXTURE_VERSION,
    platforms: {
      [process.platform]: {
        [process.arch]: {
          download: { url, checksum, checksumAlgorithm: "sha256" },
          archive: { format: "tar.gz", stripComponents: 0 },
          executable: "bin/git",
          verification: { executable: "{installDir}/bin/git", args: ["--version"] },
        },
      },
    },
    install: { destination: "tools/{id}/{version}", steps: [{ type: "download" }, { type: "extract" }] },
    verification: { executable: "{installDir}/bin/git", args: ["--version"] },
  };
}

async function serveGitFixture() {
  const dir = await tempDir("nce-vm-git-fixture-");
  const file = path.join(dir, "git.tar.gz");
  await makeTarGz([
    { name: "bin/", type: "directory" },
    { name: "bin/git", mode: 0o755, data: `#!/bin/sh\necho "git version ${GIT_FIXTURE_VERSION}"\n` },
  ], file);
  const body = await fs.readFile(file);
  const checksum = sha256(body);
  const server = await serve({ "/git.tar.gz": staticRoute(body) });
  return { dir, server, distribution: gitFixtureDistribution(`${server.origin}/git.tar.gz`, checksum) };
}

/** Plant a pre-Version-Manager installation directly on disk (no installer call). */
async function plantGit(root, dirName, version = GIT_FIXTURE_VERSION) {
  const dir = path.join(root, "tools", "git", dirName);
  await fs.mkdir(path.join(dir, "bin"), { recursive: true });
  const executable = path.join(dir, "bin", "git");
  await fs.writeFile(executable, `#!/bin/sh\necho "git version ${version}"\n`, { mode: 0o755 });
  return { dir, executable };
}

/** App-layer owner wired exactly like App.ts: one shared Installer, settings bridge, broadcast. */
function createVersionManager(userDataPath, { distribution, settings, broadcast } = {}) {
  const installer = new Installer({ userDataPath, registry: { git: distribution ?? gitDistribution } });
  const registry = new PackageRegistry([gitManaged]);
  const versionManager = new VersionManager({ userDataPath, installer, registry, settings, broadcast });
  return { versionManager, installer };
}

module.exports = {
  toolFixture,
  toolDistribution,
  managedTool,
  createManager,
  memorySettings,
  NODE,
  GIT_FIXTURE_VERSION,
  gitFixtureDistribution,
  serveGitFixture,
  plantGit,
  createVersionManager,
};