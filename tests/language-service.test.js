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
  assert.equal(js.components.some((c) => c.id === "javascript.runtime"), false);
  assert.equal(js.components.find((c) => c.id === "javascript.typescript").installableVersion, "6.0.3");
  assert.equal(js.components.find((c) => c.id === "javascript.lsp").installableVersion, "6.1.0");
  const py = list.find((item) => item.id === "python");
  assert.equal(py.components.find((c) => c.id === "python.runtime").installableVersion, "3.12.16");
});

test("LanguageService exposes plain-language presentation data for every language", () => {
  for (const language of service.list()) {
    assert.equal(typeof language.summary, "string");
    assert.ok(language.summary.length > 0, `${language.id} needs a summary`);
    assert.ok(Array.isArray(language.benefits) && language.benefits.length >= 2);
    for (const benefit of language.benefits) {
      assert.ok(benefit.title && benefit.description && benefit.icon);
      // Technical internals must not leak into the user-facing presentation.
      for (const text of [benefit.title, benefit.description, language.summary]) {
        assert.equal(/\b(LSP|runtime|Runtime|package|Package|language server)\b/.test(text), false, text);
      }
    }
  }
});

test("LanguageService maps packages to their owning language", () => {
  assert.equal(service.languageForPackage("typescript"), "javascript");
  assert.equal(service.languageForPackage("typescript-language-server"), "javascript");
  assert.equal(service.languageForPackage("python"), "python");
  assert.equal(service.languageForPackage("pyright"), "python");
  assert.equal(service.languageForPackage("git"), null);
  assert.deepEqual(service.packageIdsFor("python").sort(), ["pyright", "python"]);
  assert.deepEqual(
    service.packageIdsFor("javascript").sort(),
    ["typescript", "typescript-language-server"],
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
  const view = service.view("javascript", snapshot({ typescript: "installed" }), ["javascript.lsp"]);
  assert.deepEqual(view.selected, ["javascript.lsp"]);
  assert.deepEqual(view.plan.toInstall, ["javascript.lsp"]);
  assert.deepEqual(view.plan.unchanged, ["javascript.typescript"]);
});

test("the shared environment plans TypeScript components independently", () => {
  // A compiler-only project selects just TypeScript; a full project also
  // selects the language server. Same language, two plans, no runtime card.
  const compilerOnly = service.view(
    "javascript",
    snapshot({ typescript: "installed" }),
    ["javascript.typescript"],
  );
  assert.deepEqual(compilerOnly.selected, ["javascript.typescript"]);
  assert.deepEqual(compilerOnly.plan.toInstall, []);
  assert.deepEqual(compilerOnly.plan.unchanged, ["javascript.typescript"]);

  const withLsp = service.view(
    "javascript",
    snapshot({ typescript: "installed" }),
    ["javascript.typescript", "javascript.lsp"],
  );
  assert.deepEqual(withLsp.plan.toInstall, ["javascript.lsp"]);
  assert.deepEqual(withLsp.plan.unchanged, ["javascript.typescript"]);
});

test("JavaScript components are supported on Linux without a Node.js install", () => {
  const linux = new LanguageService(builtinLanguages, registry, "linux");
  const view = linux.view(
    "javascript",
    snapshot(),
    ["javascript.typescript", "javascript.lsp"],
  );
  assert.deepEqual(view.plan.unsupported, []);
  assert.deepEqual(view.plan.toInstall, ["javascript.typescript", "javascript.lsp"]);
  assert.equal(view.components.some((component) => component.id === "javascript.runtime"), false);
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

test("installing the Python language server needs no Node.js download", () => {
  const view = service.view("python", snapshot(), ["python.runtime", "python.lsp"]);
  assert.deepEqual(view.packageDependencies, []);
});

test("no language announces a Node.js dependency", () => {
  for (const languageId of ["python", "javascript"]) {
    const view = service.view(languageId, snapshot());
    assert.equal(
      view.packageDependencies.some((entry) => entry.packageId === "node"),
      false,
      `${languageId} must not announce a Node.js download`,
    );
  }
});

test("Python never reports a JavaScript component as its own", () => {
  // The component graph and the package graph must stay distinct.
  const view = service.view("python", snapshot(), ["python.runtime", "python.lsp"]);
  assert.deepEqual(view.components.map((component) => component.id), ["python.runtime", "python.lsp"]);
  assert.equal(
    view.requiredBySelection.some((id) => id.startsWith("javascript.")),
    false,
  );
});
