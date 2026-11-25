"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("the LSP resolver has no dependency on project runtime resolution", () => {
  const source = read("src/ts/lsp/LspExecutableResolver.ts");
  assert.doesNotMatch(source, /ProjectRuntime|projectRuntime|VersionManager|InstallationStore/);
  assert.match(source, /InternalRuntimePort/);
});

test("project command runners never reference the internal runtime", () => {
  for (const file of [
    "src/ts/addon/AgentProcessRunner.ts",
    "src/ts/terminal/TerminalManager.ts",
  ]) {
    const source = read(file);
    assert.doesNotMatch(source, /InternalNodeRuntime|internalRuntime|resources\/internal-node/);
  }
});

test("the internal runtime is wired only into the LSP manager", () => {
  const window = read("src/ts/Window.ts");
  assert.match(window, /resolveInternalNodeRuntime/);
  assert.match(window, /internalRuntime:/);
});

test("no installable package declares Node.js as a dependency", () => {
  const { builtinManagedPackages } = require("../dist/ts/packages/index.js");
  assert.equal(builtinManagedPackages.some((definition) => definition.id === "node"), false);
  for (const definition of builtinManagedPackages) {
    assert.equal((definition.dependencies || []).includes("node"), false);
  }
});
