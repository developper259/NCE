"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const { LanguageService } = require("../dist/ts/languages/LanguageService.js");
const { LanguageApplicationService } = require("../dist/ts/languages/LanguageApplicationService.js");
const { builtinLanguages } = require("../dist/ts/languages/index.js");
const { PackageRegistry } = require("../dist/ts/packages/PackageRegistry.js");
const { builtinManagedPackages } = require("../dist/ts/packages/index.js");

const registry = new PackageRegistry(builtinManagedPackages);
// Pin the platform: the Node.js distribution is declared for darwin and win32
// only, so inheriting the host platform made these plans pass on macOS and
// Windows but fail on Linux CI.
const service = new LanguageService(builtinLanguages, registry, "darwin");

const snapshot = (states = {}) => ({
  version: 1,
  packages: builtinManagedPackages.map((definition) => ({
    id: definition.id,
    state: states[definition.id] || "not-installed",
    installations: states[definition.id] === "installed"
      ? [{ id: `inst-${definition.id}`, state: "installed" }]
      : [],
  })),
  operations: [],
});

test("LanguageService lists every language with real component versions", () => {
  const list = service.list();
  assert.deepEqual(list.map((item) => item.id).sort(), ["javascript", "python"]);
  const js = list.find((item) => item.id === "javascript");
  assert.equal(js.name, "JavaScript & TypeScript");
  assert.deepEqual(js.fileExtensions, [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
  const runtime = js.components.find((component) => component.id === "javascript.runtime");
  assert.equal(runtime.installableVersion, "24.22.3");
  assert.equal(runtime.type, "runtime");
  assert.equal(js.components.find((c) => c.id === "javascript.typescript").installableVersion, "5.9.3");
  assert.equal(js.components.find((c) => c.id === "javascript.lsp").installableVersion, "6.1.0");
  const py = list.find((item) => item.id === "python");
  assert.equal(py.components.find((c) => c.id === "python.runtime").installableVersion, "3.12.16");
});

test("LanguageService maps packages to their owning language", () => {
  assert.equal(service.languageForPackage("node"), "javascript");
  assert.equal(service.languageForPackage("typescript"), "javascript");
  assert.equal(service.languageForPackage("typescript-language-server"), "javascript");
  assert.equal(service.languageForPackage("python"), "python");
  assert.equal(service.languageForPackage("pyright"), "python");
  assert.equal(service.languageForPackage("git"), null);
  assert.deepEqual(service.packageIdsFor("python").sort(), ["pyright", "python"]);
  assert.deepEqual(
    service.packageIdsFor("javascript").sort(),
    ["node", "typescript", "typescript-language-server"],
  );
});

test("LanguageService uses declared defaults and plans missing components", () => {
  const view = service.view("python", snapshot({ python: "installed" }), undefined);
  assert.deepEqual(view.selected, ["python.runtime", "python.lsp"]);
  assert.deepEqual(view.plan.toInstall, ["python.lsp"]);
  assert.deepEqual(view.plan.unchanged, ["python.runtime"]);
  assert.deepEqual(view.plan.toUninstall, []);
});

test("LanguageService uses declarative defaults on a fresh install", () => {
  const view = service.view("python", snapshot(), undefined);
  assert.deepEqual(view.selected, ["python.runtime", "python.lsp"]);
  assert.deepEqual(view.plan.toInstall, ["python.runtime", "python.lsp"]);
});

test("LanguageService computes a mixed plan from an explicit selection", () => {
  const view = service.view("javascript", snapshot({ node: "installed", typescript: "installed" }), ["javascript.lsp"]);
  assert.deepEqual(view.selected, ["javascript.lsp"]);
  assert.deepEqual(view.plan.toInstall, ["javascript.lsp"]);
  assert.deepEqual(view.plan.unchanged.sort(), ["javascript.runtime", "javascript.typescript"]);
});

test("the shared environment plans TypeScript components independently", () => {
  // A JavaScript-only project selects the runtime; a TypeScript project also
  // selects the compiler and the language server. Same language, two plans.
  const jsOnly = service.view(
    "javascript",
    snapshot({ node: "installed", typescript: "installed" }),
    ["javascript.runtime"],
  );
  assert.deepEqual(jsOnly.selected, ["javascript.runtime"]);
  assert.deepEqual(jsOnly.plan.toInstall, []);
  assert.deepEqual(jsOnly.plan.unchanged, ["javascript.runtime"]);

  const withTs = service.view(
    "javascript",
    snapshot({ node: "installed", typescript: "installed" }),
    ["javascript.runtime", "javascript.typescript", "javascript.lsp"],
  );
  assert.deepEqual(withTs.plan.toInstall, ["javascript.lsp"]);
  assert.deepEqual(withTs.plan.unchanged.sort(), ["javascript.runtime", "javascript.typescript"]);
});

test("a platform without a Node.js distribution blocks the runtime instead of planning it", () => {
  // Linux has no declared Node.js archive yet, so the runtime is reported as
  // unsupported with an explicit blocker instead of being scheduled for an
  // install that cannot succeed. This is the behaviour the Linux CI job sees.
  const linux = new LanguageService(builtinLanguages, registry, "linux");
  const view = linux.view(
    "javascript",
    snapshot(),
    ["javascript.runtime", "javascript.typescript", "javascript.lsp"],
  );
  assert.deepEqual(view.plan.unsupported, ["javascript.runtime"]);
  assert.ok(view.plan.blockers.some((blocker) => /not available on linux/.test(blocker)));
  // The runtime is never scheduled for installation.
  assert.equal(view.plan.toInstall.includes("javascript.runtime"), false);
});

test("LanguageService rejects unknown languages", () => {
  assert.equal(service.view("ghost", snapshot()), null);
  assert.equal(service.languageDefinition("ghost"), null);
  assert.ok(service.languageDefinition("python"));
});

test("LanguageApplicationService applies a plan through the injected PackageManager", async () => {
  const calls = [];
  const fakePackages = {
    store: { listByPackage: (id) => [{ id: `inst-${id}`, state: "installed" }] },
    install: async (id) => { calls.push(["install", id]); return { success: true }; },
    verify: async (id) => { calls.push(["verify", id]); return { success: true }; },
    uninstall: async (id) => { calls.push(["uninstall", id]); return { success: true }; },
    cancel: () => true,
  };
  const application = new LanguageApplicationService(fakePackages);
  const view = service.view("python", snapshot(), ["python.runtime", "python.lsp"]);
  const definition = service.languageDefinition("python");
  const events = [];
  const result = await application.apply(view.plan, definition.components, (event) => events.push(event));
  assert.equal(result.success, true);
  assert.deepEqual(result.completed.sort(), ["python.lsp", "python.runtime"]);
  assert.deepEqual(calls, [
    ["install", "python"],
    ["install", "pyright"],
    ["verify", "inst-python"],
    ["verify", "inst-pyright"],
  ]);
  assert.ok(events.length > 0);
  assert.ok(events.every((event) => typeof event.componentId === "string"));
});

test("installing the Python language server announces the Node.js it needs", () => {
  // Pyright is a JavaScript program: the pyright package depends on node. That
  // dependency is legitimate, but a JavaScript runtime downloading during a
  // Python install must be explained, not discovered.
  const view = service.view("python", snapshot(), ["python.runtime", "python.lsp"]);
  const node = view.packageDependencies.find((entry) => entry.packageId === "node");
  assert.ok(node, "the Node.js dependency is reported");
  assert.equal(node.packageName, "JavaScript & TypeScript");
  assert.equal(node.requiredBy, "Pyright Language Server");
  assert.equal(node.installed, false);
});

test("an already installed dependency is not announced as a new download", () => {
  const view = service.view(
    "python",
    snapshot({ python: "installed", pyright: "installed", node: "installed" }),
    ["python.runtime", "python.lsp"],
  );
  const node = view.packageDependencies.find((entry) => entry.packageId === "node");
  assert.equal(node.installed, true);
});

test("Python never reports a JavaScript component as its own", () => {
  // The component graph and the package graph must stay distinct: node is a
  // package dependency of pyright, never a component of the Python language.
  const view = service.view("python", snapshot(), ["python.runtime", "python.lsp"]);
  assert.deepEqual(view.components.map((component) => component.id), ["python.runtime", "python.lsp"]);
  assert.equal(
    view.requiredBySelection.some((id) => id.startsWith("javascript.")),
    false,
  );
});
