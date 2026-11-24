"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { PackageDependencyGraph } = require("../dist/ts/packages/PackageDependencyGraph.js");
const { PackageRegistry } = require("../dist/ts/packages/PackageRegistry.js");
const { builtinManagedPackages } = require("../dist/ts/packages/index.js");

function graph(installed, versions = {}) {
  return new PackageDependencyGraph({
    registry: new PackageRegistry(builtinManagedPackages),
    installedPackageIds: () => installed,
    installedVersions: (packageId) => versions[packageId] || [],
  });
}

test("the real catalog knows what depends on Node.js", () => {
  const dependents = graph([]).directDependents("node").map((definition) => definition.id).sort();
  assert.deepEqual(dependents, ["pyright", "typescript", "typescript-language-server"]);
});

test("Pyright cannot be removed while it is installed and needs Node.js", () => {
  const check = graph(["node", "pyright"]).checkRemoval("node");
  assert.equal(check.allowed, false);
  assert.deepEqual(check.requiredBy.map((blocker) => blocker.packageId), ["pyright"]);
  assert.match(check.reason, /still required by Pyright/);
});

test("Node.js can be removed when nothing installed needs it", () => {
  const check = graph(["node"]).checkRemoval("node");
  assert.equal(check.allowed, true);
  assert.deepEqual(check.requiredBy, []);
  assert.equal(check.reason, null);
});

test("a declared but absent dependent does not block a removal", () => {
  // typescript-language-server declares node, but it is not installed here.
  const check = graph(["node", "pyright"]).checkRemoval("node");
  const ids = check.requiredBy.map((blocker) => blocker.packageId);
  assert.equal(ids.includes("typescript-language-server"), false);
});

test("TypeScript is protected by an installed language server", () => {
  const check = graph(["node", "typescript", "typescript-language-server"])
    .checkRemoval("typescript");
  assert.equal(check.allowed, false);
  assert.deepEqual(check.requiredBy.map((blocker) => blocker.packageId), ["typescript-language-server"]);
});

test("transitive dependents are found through the chain", () => {
  const dependents = graph([]).transitiveDependents("node").map((definition) => definition.id).sort();
  // typescript-language-server depends on node directly and through typescript.
  assert.deepEqual(dependents, ["pyright", "typescript", "typescript-language-server"]);
});

test("transitive dependencies are reported dependency-first", () => {
  const dependencies = graph([]).transitiveDependencies("typescript-language-server");
  assert.deepEqual(dependencies.sort(), ["node", "typescript"]);
});

test("a package with no dependents is always removable", () => {
  const check = graph(["node", "pyright"]).checkRemoval("pyright");
  assert.equal(check.allowed, true);
});

test("the refusal names every installed blocker", () => {
  const check = graph(["node", "pyright", "typescript"]).checkRemoval("node");
  assert.equal(check.allowed, false);
  assert.deepEqual(
    check.requiredBy.map((blocker) => blocker.packageId).sort(),
    ["pyright", "typescript"],
  );
  assert.match(check.reason, /Pyright/);
  assert.match(check.reason, /TypeScript/);
});

test("installed versions are carried into the blocker for the UI", () => {
  const check = graph(["node", "pyright"], { pyright: ["1.1.414"] }).checkRemoval("node");
  assert.deepEqual(check.requiredBy[0].installedVersions, ["1.1.414"]);
});
