"use strict";

const assert = require("node:assert");
const { promises: fs } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const {
  InstallationStore,
  INSTALLATION_SCHEMA_VERSION,
  validateRecord,
} = require("../dist/ts/packages/InstallationStore.js");
const { tempDir } = require("./helpers/installer.js");

function record(overrides = {}) {
  return {
    id: "inst-1",
    packageId: "git",
    name: "Git",
    version: "2.56.1",
    categories: ["git"],
    installDir: path.join(path.sep, "tmp", "nce", "tools", "git", "2.56.1"),
    executable: path.join(path.sep, "tmp", "nce", "tools", "git", "2.56.1", "bin", "git"),
    platform: process.platform,
    arch: process.arch,
    state: "installed",
    provenance: "managed",
    installedAt: 1000,
    updatedAt: 1000,
    verifiedAt: 1000,
    uninstall: { strategy: "installer-directory" },
    ...overrides,
  };
}

test("InstallationStore records, reads, updates and removes installations", async () => {
  const dir = await tempDir("nce-store-");
  try {
    const store = new InstallationStore(dir, { now: () => 5000 });
    await store.initialize();
    assert.equal(await store.add(record()), true);
    assert.equal(store.get("inst-1").version, "2.56.1");
    assert.equal(store.listByPackage("git").length, 1);
    assert.equal(store.findByInstallDir(record().installDir).id, "inst-1");

    const updated = await store.update("inst-1", { state: "corrupted", version: "2.56.2" });
    assert.equal(updated.state, "corrupted");
    assert.equal(updated.updatedAt, 5000);
    assert.equal(updated.id, "inst-1", "id cannot be patched");
    assert.equal(updated.packageId, "git", "packageId cannot be patched");

    assert.equal(await store.remove("inst-1"), true);
    assert.equal(store.get("inst-1"), null);
    assert.equal(await store.remove("inst-1"), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("InstallationStore persists across a restart", async () => {
  const dir = await tempDir("nce-store-");
  try {
    const first = new InstallationStore(dir);
    await first.initialize();
    await first.add(record());
    await first.add(record({ id: "inst-2", version: "2.55.0", installDir: path.join(dir, "tools", "git", "2.55.0") }));
    await first.flush();

    const second = new InstallationStore(dir);
    const status = await second.initialize();
    assert.equal(status.available, true);
    assert.equal(status.dropped, 0);
    assert.equal(second.list().length, 2);
    assert.equal(second.get("inst-1").version, "2.56.1");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("InstallationStore supports multiple installations of one package", async () => {
  const dir = await tempDir("nce-store-");
  try {
    const store = new InstallationStore(dir);
    await store.initialize();
    await store.add(record({ id: "a", version: "2.55.0", installDir: path.join(dir, "a") }));
    await store.add(record({ id: "b", version: "2.56.1", installDir: path.join(dir, "b") }));
    assert.equal(store.listByPackage("git").length, 2);
    assert.equal(await store.add(record({ id: "a" })), false, "duplicate id rejected");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("InstallationStore drops corrupt entries but keeps valid ones", async () => {
  const dir = await tempDir("nce-store-");
  try {
    const file = path.join(dir, "installations.json");
    await fs.writeFile(file, JSON.stringify({
      schemaVersion: INSTALLATION_SCHEMA_VERSION,
      installations: [record(), { id: "bad" }, { ...record({ id: "x" }), provenance: "external" }],
    }));
    const store = new InstallationStore(dir);
    const status = await store.initialize();
    assert.equal(status.dropped, 2);
    assert.equal(store.list().length, 1);
    assert.equal(store.get("inst-1").id, "inst-1");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("InstallationStore recovers from an unreadable file via reconciliation", async () => {
  const dir = await tempDir("nce-store-");
  try {
    await fs.writeFile(path.join(dir, "installations.json"), "{ not json");
    const store = new InstallationStore(dir);
    const status = await store.initialize();
    assert.equal(status.available, true);
    assert.equal(status.dropped, 1);
    assert.equal(store.list().length, 0);
    assert.equal(await store.add(record()), true, "store is writable after recovery");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("InstallationStore refuses to overwrite a newer schema (fail-closed)", async () => {
  const dir = await tempDir("nce-store-");
  try {
    const file = path.join(dir, "installations.json");
    const newer = JSON.stringify({ schemaVersion: INSTALLATION_SCHEMA_VERSION + 1, installations: [] });
    await fs.writeFile(file, newer);
    const store = new InstallationStore(dir);
    const status = await store.initialize();
    assert.equal(status.degraded, true);
    assert.equal(await store.add(record()), false);
    assert.equal(await fs.readFile(file, "utf8"), newer, "newer file is preserved");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("validateRecord rejects unsafe paths, states and provenance", () => {
  assert.ok(validateRecord(record()));
  assert.equal(validateRecord({ ...record(), installDir: "relative/path" }), null);
  assert.equal(validateRecord({ ...record(), installDir: "/tmp/\0evil" }), null);
  assert.equal(validateRecord({ ...record(), state: "bogus" }), null);
  assert.equal(validateRecord({ ...record(), provenance: "external" }), null);
  assert.equal(validateRecord({ ...record(), categories: ["bogus"] }), null);
  assert.equal(validateRecord({ ...record(), uninstall: { strategy: "script" } }), null);
  assert.equal(validateRecord(null), null);
});