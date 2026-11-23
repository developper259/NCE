"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const { LanguageService } = require("../dist/ts/languages/LanguageService.js");
const { LanguageApplicationService } = require("../dist/ts/languages/LanguageApplicationService.js");
const { builtinLanguages } = require("../dist/ts/languages/index.js");
const { PackageRegistry } = require("../dist/ts/packages/PackageRegistry.js");
const { builtinManagedPackages } = require("../dist/ts/packages/index.js");

const registry = new PackageRegistry(builtinManagedPackages);
const service = new LanguageService(builtinLanguages, registry);

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
  assert.deepEqual(list.map((item) => item.id).sort(), ["javascript", "python", "typescript"]);
  const js = list.find((item) => item.id === "javascript");
  assert.equal(js.name, "JavaScript");
  assert.deepEqual(js.fileExtensions, [".js", ".jsx", ".mjs", ".cjs"]);
  const runtime = js.components.find((component) => component.id === "javascript.runtime");
  assert.equal(runtime.installableVersion, "24.22.3");
  assert.equal(runtime.type, "runtime");
  const ts = list.find((item) => item.id === "typescript");
  assert.equal(ts.name, "TypeScript");
  assert.deepEqual(ts.fileExtensions, [".ts", ".tsx", ".mts", ".cts"]);
  assert.equal(ts.components.find((c) => c.id === "typescript.compiler").installableVersion, "5.9.3");
  assert.equal(ts.components.find((c) => c.id === "typescript.lsp").installableVersion, "6.1.0");
  const py = list.find((item) => item.id === "python");
  assert.equal(py.components.find((c) => c.id === "python.runtime").installableVersion, "3.12.16");
});

test("LanguageService maps packages to their owning language", () => {
  assert.equal(service.languageForPackage("node"), "javascript");
  assert.equal(service.languageForPackage("typescript"), "typescript");
  assert.equal(service.languageForPackage("typescript-language-server"), "javascript");
  assert.equal(service.languageForPackage("python"), "python");
  assert.equal(service.languageForPackage("pyright"), "python");
  assert.equal(service.languageForPackage("git"), null);
  assert.deepEqual(service.packageIdsFor("python").sort(), ["pyright", "python"]);
  assert.deepEqual(
    service.packageIdsFor("typescript").sort(),
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

test("TypeScript plans its own components independently from JavaScript", () => {
  const view = service.view(
    "typescript",
    snapshot({ node: "installed", typescript: "installed" }),
    ["typescript.lsp"],
  );
  assert.deepEqual(view.selected, ["typescript.lsp"]);
  assert.deepEqual(view.plan.toInstall, ["typescript.lsp"]);
  assert.deepEqual(view.plan.unchanged.sort(), ["typescript.compiler", "typescript.runtime"]);
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
