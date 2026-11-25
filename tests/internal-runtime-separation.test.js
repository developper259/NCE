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

test("the embedded runtime ships as an app resource, outside app.asar", () => {
  const manifest = JSON.parse(read("package.json"));
  const resources = manifest.build.extraResources || [];
  assert.ok(
    resources.some((entry) => entry.to === "internal-node"),
    "the runtime must be copied to process.resourcesPath/internal-node",
  );
  const asarContents = manifest.build.files || [];
  assert.equal(
    asarContents.some((entry) => typeof entry === "string" && entry.includes("internal-node")),
    false,
    "the binary must not be packed inside app.asar",
  );
});

test("packaging keeps every existing Electron fuse disabled", () => {
  const source = read("scripts/after-pack.js");
  assert.match(source, /FuseV1Options\.RunAsNode\]: false/);
  assert.match(source, /FuseV1Options\.EnableNodeCliInspectArguments\]: false/);
  assert.match(source, /FuseV1Options\.EnableNodeOptionsEnvironmentVariable\]: false/);
  assert.match(source, /FuseV1Options\.OnlyLoadAppFromAsar\]: true/);
  assert.doesNotMatch(source, /RunAsNode\]: true/);
});

test("no installable package declares Node.js as a dependency", () => {
  const { builtinManagedPackages } = require("../dist/ts/packages/index.js");
  assert.equal(builtinManagedPackages.some((definition) => definition.id === "node"), false);
  for (const definition of builtinManagedPackages) {
    assert.equal((definition.dependencies || []).includes("node"), false);
  }
});
