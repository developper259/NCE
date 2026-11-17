"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const { PackageRegistry, PackageRegistryError } = require("../dist/ts/packages/PackageRegistry.js");
const { git } = require("../dist/ts/packages/git.js");
const { managedTool } = require("./helpers/version-manager.js");

test("PackageRegistry registers, retrieves and lists packages", () => {
  const registry = new PackageRegistry([managedTool("tool"), managedTool("other")]);
  assert.equal(registry.get("tool").id, "tool");
  assert.equal(registry.has("tool"), true);
  assert.equal(registry.has("missing"), false);
  assert.deepEqual(registry.list().map((definition) => definition.id), ["tool", "other"]);
});

test("PackageRegistry filters by category and supports multi-category packages", () => {
  const registry = new PackageRegistry([
    managedTool("node", "1.0.0", { categories: ["language", "runtime"] }),
    managedTool("rust-analyzer", "1.0.0", { categories: ["language-server"] }),
    managedTool("git", "1.0.0", { categories: ["git"] }),
  ]);
  assert.deepEqual(registry.listByCategory("language").map((d) => d.id), ["node"]);
  assert.deepEqual(registry.listByCategory("runtime").map((d) => d.id), ["node"]);
  assert.deepEqual(registry.listByCategory("language-server").map((d) => d.id), ["rust-analyzer"]);
  assert.deepEqual(registry.listByCategory("compiler"), []);
});

test("PackageRegistry rejects unknown ids and duplicate registration", () => {
  const registry = new PackageRegistry([managedTool("tool")]);
  assert.throws(() => registry.get("missing"), PackageRegistryError);
  assert.throws(() => registry.register(managedTool("tool")), /already registered/);
});

test("PackageRegistry rejects invalid definitions", () => {
  const cases = [
    [{ ...managedTool(), id: "../escape" }, /path-safe/],
    [{ ...managedTool(), name: "" }, /name is required/],
    [{ ...managedTool(), categories: [] }, /category/],
    [{ ...managedTool(), categories: ["bogus"] }, /category/],
    [{ ...managedTool(), platforms: [] }, /platform/],
    [{ ...managedTool(), installationRoot: "/etc" }, /installationRoot/],
    [{ ...managedTool(), installationRoot: "tools/../../etc" }, /installationRoot/],
    [{ ...managedTool(), uninstall: { strategy: "rm-rf" } }, /uninstall strategy/],
    [{ ...managedTool(), capabilities: ["update"] }, /capability/],
    [{ ...managedTool(), versionPattern: "(" }, /regular expression/],
  ];
  for (const [definition, pattern] of cases) {
    assert.throws(() => new PackageRegistry([definition]), pattern);
  }
});

test("builtin Git definition is registered and declares real V1 capabilities", () => {
  const registry = new PackageRegistry();
  const definition = registry.get("git");
  assert.equal(definition.id, "git");
  assert.equal(definition.installerPackageId, "git");
  assert.deepEqual(definition.categories, ["git"]);
  assert.deepEqual(definition.capabilities, ["install", "uninstall", "verify"]);
  assert.deepEqual(definition.managedSettings, ["git.path"]);
  assert.equal(definition.installableVersion, git.installableVersion);
  assert.ok(definition.platforms.includes(process.platform));
  assert.equal(typeof definition.externalCandidates, "function");
});