"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const {
  LanguageRegistry,
  LanguageRegistryError,
} = require("../dist/ts/languages/LanguageRegistry.js");
const { PackageRegistry } = require("../dist/ts/packages/PackageRegistry.js");
const { managedTool } = require("./helpers/version-manager.js");

function language(overrides = {}) {
  return {
    id: "python",
    name: "Python",
    description: "Python programming language",
    categories: ["language"],
    fileExtensions: [".py", ".pyi"],
    components: [
      {
        id: "python.runtime",
        name: "Python Runtime",
        description: "Interpreter and standard library",
        type: "runtime",
        packageId: "python-runtime",
        platforms: ["darwin", "linux", "win32"],
        capabilities: ["execute-scripts", "create-virtualenv"],
        defaultSelected: true,
      },
      {
        id: "python.lsp",
        name: "Python Language Server",
        description: "LSP server for Python",
        type: "language-server",
        packageId: "pylsp",
        platforms: ["darwin", "linux", "win32"],
        dependencies: ["python.runtime"],
        lspServerId: "pylsp",
      },
    ],
    defaultSelection: ["python.runtime"],
    ...overrides,
  };
}

function packageRegistry(...ids) {
  return new PackageRegistry(ids.map((id) => managedTool(id)));
}

test("LanguageRegistry registers, retrieves, lists and finds by component", () => {
  const registry = new LanguageRegistry([language()], packageRegistry("python-runtime", "pylsp"));
  assert.equal(registry.get("python").name, "Python");
  assert.equal(registry.has("python"), true);
  assert.equal(registry.has("missing"), false);
  assert.deepEqual(registry.list().map((l) => l.id), ["python"]);
  assert.equal(registry.findByComponent("python.lsp").id, "python");
  assert.equal(registry.findByComponent("missing"), undefined);
});

test("LanguageRegistry validates components against the package registry", () => {
  assert.throws(
    () => new LanguageRegistry([language()], packageRegistry("python-runtime")),
    /unregistered package "pylsp"/,
  );
  // Without a package registry, component->package links are not cross-checked.
  assert.doesNotThrow(() => new LanguageRegistry([language()]));
});

test("LanguageRegistry rejects duplicate component ids and unknown dependencies", () => {
  const packages = packageRegistry("python-runtime", "pylsp");
  const duplicate = language({
    components: [language().components[0], { ...language().components[0], id: "python.runtime" }],
  });
  assert.throws(() => new LanguageRegistry([duplicate], packages), /duplicate component id/);

  const badDependency = language({
    components: [
      language().components[0],
      { ...language().components[1], dependencies: ["python.ghost"] },
    ],
  });
  assert.throws(() => new LanguageRegistry([badDependency], packages), /unknown dependency/);
});

test("LanguageRegistry rejects invalid language and component definitions", () => {
  const packages = packageRegistry("python-runtime", "pylsp");
  const cases = [
    [{ ...language(), id: "../escape" }, /path-safe/],
    [{ ...language(), name: "" }, /name is required/],
    [{ ...language(), categories: [] }, /category/],
    [{ ...language(), fileExtensions: ["py"] }, /dotted extensions/],
    [{ ...language(), components: [] }, /component/],
    [{ ...language(), defaultSelection: ["python.ghost"] }, /defaultSelection/],
    [{ ...language(), components: [{ ...language().components[0], type: "magic" }] }, /component type/],
    [{ ...language(), components: [{ ...language().components[0], capabilities: ["fly"] }] }, /capability/],
    [{ ...language(), components: [{ ...language().components[0], platforms: [] }] }, /platforms/],
  ];
  for (const [definition, pattern] of cases) {
    assert.throws(() => new LanguageRegistry([definition], packages), pattern);
  }
  assert.throws(() => new LanguageRegistry([language()], packages).register(language()), /already registered/);
});

test("component types and capabilities are extensible by declaration only", () => {
  const packages = packageRegistry("toolchain-pkg");
  const definition = language({
    id: "rust",
    components: [
      {
        id: "rust.toolchain",
        name: "Rust Toolchain",
        description: "Compiler and cargo",
        type: "toolchain",
        packageId: "toolchain-pkg",
        platforms: ["linux"],
        capabilities: ["manage-packages"],
      },
    ],
    defaultSelection: ["rust.toolchain"],
  });
  const registry = new LanguageRegistry([definition], packages);
  assert.equal(registry.get("rust").components[0].type, "toolchain");
  assert.ok(registry.get("rust").components[0].capabilities.includes("manage-packages"));
});
