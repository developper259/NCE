"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { PackageDependencyGraph } = require("../dist/ts/packages/PackageDependencyGraph.js");
const { PackageRegistry } = require("../dist/ts/packages/PackageRegistry.js");
const { builtinManagedPackages } = require("../dist/ts/packages/index.js");
const { managedTool } = require("./helpers/version-manager.js");

// Synthetic definitions keep the graph tests independent of which packages
// happen to be installable. Node.js is no longer one of them: NCE ships its
// own runtime, so the real catalog must not declare it as a dependency.
const FIXTURES = [
  managedTool("runtime", "1.0.0", { name: "Runtime" }),
  managedTool("compiler", "1.0.0", { name: "Compiler", dependencies: ["runtime"] }),
  managedTool("server", "1.0.0", { name: "Language Server", dependencies: ["runtime", "compiler"] }),
  managedTool("other", "1.0.0", { name: "Other Server", dependencies: ["runtime"] }),
];

function graph(installed, versions = {}) {
  return new PackageDependencyGraph({
    registry: new PackageRegistry(FIXTURES),
    installedPackageIds: () => installed,
    installedVersions: (packageId) => versions[packageId] || [],
  });
}

test("the real catalog declares no dependency on an installable Node.js", () => {
  const registry = new PackageRegistry(builtinManagedPackages);
  assert.equal(registry.has("node"), false);
  for (const definition of builtinManagedPackages) {
    assert.equal((definition.dependencies || []).includes("node"), false);
  }
});

test("an installed dependent blocks removal of its runtime", () => {
  const check = graph(["runtime", "other"]).checkRemoval("runtime");
  assert.equal(check.allowed, false);
  assert.deepEqual(check.requiredBy.map((blocker) => blocker.packageId), ["other"]);
  assert.match(check.reason, /still required by Other Server/);
});

test("a runtime can be removed when nothing installed needs it", () => {
  const check = graph(["runtime"]).checkRemoval("runtime");
  assert.equal(check.allowed, true);
  assert.deepEqual(check.requiredBy, []);
  assert.equal(check.reason, null);
});

test("a declared but absent dependent does not block a removal", () => {
  const check = graph(["runtime", "other"]).checkRemoval("runtime");
  const ids = check.requiredBy.map((blocker) => blocker.packageId);
  assert.equal(ids.includes("server"), false);
});

test("a compiler is protected by an installed language server", () => {
  const check = graph(["runtime", "compiler", "server"]).checkRemoval("compiler");
  assert.equal(check.allowed, false);
  assert.deepEqual(check.requiredBy.map((blocker) => blocker.packageId), ["server"]);
});

test("transitive dependents are found through the chain", () => {
  const dependents = graph([]).transitiveDependents("runtime").map((definition) => definition.id).sort();
  assert.deepEqual(dependents, ["compiler", "other", "server"]);
});

test("transitive dependencies are reported dependency-first", () => {
  const dependencies = graph([]).transitiveDependencies("server");
  assert.deepEqual(dependencies.sort(), ["compiler", "runtime"]);
});

test("a package with no dependents is always removable", () => {
  const check = graph(["runtime", "other"]).checkRemoval("other");
  assert.equal(check.allowed, true);
});

test("the refusal names every installed blocker", () => {
  const check = graph(["runtime", "other", "compiler"]).checkRemoval("runtime");
  assert.equal(check.allowed, false);
  assert.deepEqual(
    check.requiredBy.map((blocker) => blocker.packageId).sort(),
    ["compiler", "other"],
  );
  assert.match(check.reason, /Compiler/);
  assert.match(check.reason, /Other Server/);
});

test("installed versions are carried into the blocker for the UI", () => {
  const check = graph(["runtime", "other"], { other: ["1.1.414"] }).checkRemoval("runtime");
  assert.deepEqual(check.requiredBy[0].installedVersions, ["1.1.414"]);
});
