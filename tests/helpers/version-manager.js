"use strict";

const path = require("node:path");
const { promises: fs } = require("node:fs");
const { makeTarGz, sha256, tempDir } = require("./installer.js");
const { Installer } = require("../../dist/ts/installer/Installer.js");
const { PackageManager } = require("../../dist/ts/packages/PackageManager.js");
const { PackageRegistry } = require("../../dist/ts/packages/PackageRegistry.js");
const { InstallationStore } = require("../../dist/ts/packages/InstallationStore.js");

const NODE = process.execPath;

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

module.exports = { toolFixture, toolDistribution, managedTool, createManager, memorySettings, NODE };