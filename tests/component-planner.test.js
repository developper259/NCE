"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const {
  ComponentPlanner,
} = require("../dist/ts/languages/ComponentPlanner.js");

const component = (id, deps = [], extra = {}) => ({
  id,
  name: id,
  description: id,
  type: id.includes("lsp") ? "language-server" : "runtime",
  packageId: id.replace(/\./g, "-"),
  platforms: ["darwin", "linux", "win32"],
  dependencies: deps,
  ...extra,
});

const language = (components) => ({
  id: "test",
  name: "Test",
  description: "Test language",
  categories: ["language"],
  fileExtensions: [".t"],
  components,
});

const planner = new ComponentPlanner();
const plan = (components, selected, installed = {}, platform = "darwin") =>
  planner.plan({
    language: language(components),
    selected,
    installed: new Map(Object.entries(installed)),
    platform,
  });

test("installs an absent selected component", () => {
  const result = plan([component("a")], ["a"]);
  assert.deepEqual(result.toInstall, ["a"]);
  assert.deepEqual(result.toUninstall, []);
  assert.deepEqual(result.unchanged, []);
  assert.equal(planner.actionCount(result), 1);
});

test("uninstalls an installed deselected component", () => {
  const result = plan([component("a")], [], { a: "installed" });
  assert.deepEqual(result.toInstall, []);
  assert.deepEqual(result.toUninstall, ["a"]);
});

test("handles simultaneous installs and uninstalls", () => {
  const result = plan(
    [component("a"), component("b")],
    ["b"],
    { a: "installed" },
  );
  assert.deepEqual(result.toInstall, ["b"]);
  assert.deepEqual(result.toUninstall, ["a"]);
  assert.equal(planner.actionCount(result), 2);
});

test("no change when selection matches reality (reset state)", () => {
  const result = plan(
    [component("a"), component("b")],
    ["a"],
    { a: "installed" },
  );
  assert.deepEqual(result.toInstall, []);
  assert.deepEqual(result.toUninstall, []);
  assert.deepEqual(result.unchanged, ["a"]);
  assert.equal(planner.actionCount(result), 0);
});

test("installs transitive dependencies automatically and marks them", () => {
  const result = plan(
    [component("runtime"), component("lsp", ["runtime"]), component("base", ["lsp"])],
    ["base"],
  );
  assert.deepEqual(result.toInstall, ["runtime", "lsp", "base"]);
  assert.deepEqual(result.dependenciesToInstall.sort(), ["lsp", "runtime"]);
});

test("a dependency already installed stays unchanged", () => {
  const result = plan(
    [component("runtime"), component("lsp", ["runtime"])],
    ["lsp"],
    { runtime: "installed" },
  );
  assert.deepEqual(result.toInstall, ["lsp"]);
  assert.deepEqual(result.unchanged, ["runtime"]);
  assert.deepEqual(result.dependenciesToInstall, []);
});

test("shared dependency is not uninstalled while still required", () => {
  const result = plan(
    [
      component("runtime"),
      component("lsp-a", ["runtime"]),
      component("lsp-b", ["runtime"]),
    ],
    ["lsp-a"],
    { runtime: "installed", "lsp-a": "installed", "lsp-b": "installed" },
  );
  assert.deepEqual(result.toUninstall, ["lsp-b"]);
  assert.deepEqual(result.toInstall, []);
  assert.deepEqual(result.unchanged.sort(), ["lsp-a", "runtime"]);
  assert.deepEqual(result.blockers, []);
});

test("uninstall order removes dependents before their dependencies", () => {
  const result = plan(
    [component("runtime"), component("lsp", ["runtime"]), component("base", ["lsp"])],
    [],
    { runtime: "installed", lsp: "installed", base: "installed" },
  );
  assert.deepEqual(result.toUninstall, ["base", "lsp", "runtime"]);
});

test("reports circular dependencies as blockers", () => {
  const result = plan(
    [component("a", ["b"]), component("b", ["a"])],
    ["a"],
  );
  assert.ok(result.blockers.some((b) => /Circular dependency/.test(b)));
});

test("unsupported platform components are blocked, not planned", () => {
  const result = plan(
    [component("a", [], { platforms: ["linux"] })],
    ["a"],
    {},
    "darwin",
  );
  assert.deepEqual(result.toInstall, []);
  assert.deepEqual(result.unsupported, ["a"]);
  assert.ok(result.blockers.some((b) => /not available on darwin/.test(b)));
});

test("corrupted and unknown components are replanned as installs", () => {
  for (const state of ["corrupted", "unknown", "not-installed"]) {
    const result = plan([component("a")], ["a"], { a: state });
    assert.deepEqual(result.toInstall, ["a"], `state ${state}`);
  }
});

test("unknown selections are blockers", () => {
  const result = plan([component("a")], ["a", "ghost"]);
  assert.ok(result.blockers.some((b) => /Unknown component "ghost"/.test(b)));
  assert.deepEqual(result.toInstall, ["a"]);
});
