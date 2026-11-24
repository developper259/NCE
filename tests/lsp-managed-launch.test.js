"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  resolveServerExecutable,
} = require("../dist/ts/lsp/LspExecutableResolver.js");
const {
  getServerDefinition,
  languageIdForPath,
  normalizeServerId,
  isKnownServerId,
} = require("../dist/ts/lsp/LspServerRegistry.js");

/** Stub managed port: a map of packageId -> resolution. */
function managedPort(entries) {
  return {
    resolve: async (packageId, entryPoint) => {
      const entry = entries[packageId];
      if (!entry) {
        return {
          available: false,
          source: "missing",
          installation: null,
          executable: null,
          installDir: null,
          version: null,
          error: `${packageId} is not installed by NCE.`,
        };
      }
      const executable = entryPoint
        ? `${entry.installDir}/${entryPoint}`
        : entry.executable;
      if (entry.missingEntry) {
        return {
          available: false,
          source: "missing",
          installation: null,
          executable: null,
          installDir: null,
          version: null,
          error: `${packageId} ${entry.version}: entry point is missing (${entryPoint}).`,
        };
      }
      return {
        available: true,
        source: "managed",
        installation: { packageId, version: entry.version, installDir: entry.installDir },
        executable,
        installDir: entry.installDir,
        version: entry.version,
        error: null,
      };
    },
  };
}

const NODE = {
  installDir: "/managed/tools/node/24.22.3",
  executable: "/managed/tools/node/24.22.3/bin/node",
  version: "24.22.3",
};
const PYRIGHT = {
  installDir: "/managed/tools/pyright/1.1.414",
  executable: "/managed/tools/pyright/1.1.414/langserver.index.js",
  version: "1.1.414",
};
const TLS = {
  installDir: "/managed/tools/typescript-language-server/6.1.0",
  executable: "/managed/tools/typescript-language-server/6.1.0/lib/cli.mjs",
  version: "6.1.0",
};
const TYPESCRIPT = {
  installDir: "/managed/tools/typescript/5.9.3",
  executable: "/managed/tools/typescript/5.9.3/lib/tsserver.js",
  version: "5.9.3",
};

const EMPTY_ENV = { PATH: "" };

test("Pyright launches through the managed Node.js runtime", async () => {
  const resolution = await resolveServerExecutable({
    definition: getServerDefinition("pyright"),
    configuration: undefined,
    env: EMPTY_ENV,
    platform: "darwin",
    managed: managedPort({ node: NODE, pyright: PYRIGHT }),
  });

  assert.equal(resolution.available, true);
  assert.equal(resolution.source, "managed");
  assert.equal(resolution.command, NODE.executable);
  assert.deepEqual(resolution.args, [PYRIGHT.executable, "--stdio"]);
});

test("TypeScript Language Server launches through managed Node.js with tsserver.path", async () => {
  const resolution = await resolveServerExecutable({
    definition: getServerDefinition("typescript-language-server"),
    configuration: undefined,
    env: EMPTY_ENV,
    platform: "darwin",
    managed: managedPort({ node: NODE, "typescript-language-server": TLS, typescript: TYPESCRIPT }),
  });

  assert.equal(resolution.available, true);
  assert.equal(resolution.source, "managed");
  assert.equal(resolution.command, NODE.executable);
  assert.deepEqual(resolution.args, [TLS.executable, "--stdio"]);
  assert.equal(
    resolution.initializationOptions.tsserver.path,
    TYPESCRIPT.executable,
    "the managed TypeScript SDK must be passed as tsserver.path",
  );
});

test("a missing TypeScript SDK is an explicit failure, not a silent launch", async () => {
  const resolution = await resolveServerExecutable({
    definition: getServerDefinition("typescript-language-server"),
    configuration: undefined,
    env: EMPTY_ENV,
    platform: "darwin",
    managed: managedPort({ node: NODE, "typescript-language-server": TLS }),
  });

  assert.equal(resolution.available, false);
  assert.match(resolution.error, /TypeScript SDK could not be resolved/);
});

test("a missing runtime is an explicit failure", async () => {
  const resolution = await resolveServerExecutable({
    definition: getServerDefinition("pyright"),
    configuration: undefined,
    env: EMPTY_ENV,
    platform: "darwin",
    managed: managedPort({ pyright: PYRIGHT }),
  });

  assert.equal(resolution.available, false);
  assert.match(resolution.error, /needs node/);
});

test("a configured absolute path always wins over a managed installation", async () => {
  const resolution = await resolveServerExecutable({
    definition: getServerDefinition("pyright"),
    configuration: { path: process.execPath },
    env: EMPTY_ENV,
    platform: process.platform,
    managed: managedPort({ node: NODE, pyright: PYRIGHT }),
  });

  assert.equal(resolution.available, true);
  assert.equal(resolution.source, "configured");
  assert.equal(resolution.command, process.execPath);
});

test("a managed installation wins over PATH discovery", async () => {
  const resolution = await resolveServerExecutable({
    definition: getServerDefinition("pyright"),
    configuration: undefined,
    env: { PATH: "/usr/bin:/bin" },
    platform: process.platform,
    managed: managedPort({ node: NODE, pyright: PYRIGHT }),
  });

  assert.equal(resolution.source, "managed");
});

test("PATH discovery is still used when nothing is installed by NCE", async () => {
  const resolution = await resolveServerExecutable({
    definition: getServerDefinition("pyright"),
    configuration: undefined,
    env: { PATH: "/usr/bin:/bin" },
    platform: process.platform,
    managed: managedPort({}),
  });

  // No pyright on PATH in a clean environment: the failure must name both paths.
  assert.equal(resolution.available, false);
  assert.match(resolution.error, /Install pyright from the Version Manager/);
});

test("a corrupted managed install does not silently fall back to PATH", async () => {
  const resolution = await resolveServerExecutable({
    definition: getServerDefinition("pyright"),
    configuration: undefined,
    env: EMPTY_ENV,
    platform: "darwin",
    managed: managedPort({
      node: NODE,
      pyright: { ...PYRIGHT, missingEntry: true },
    }),
  });

  assert.equal(resolution.available, false);
  assert.match(resolution.error, /installed by NCE but cannot be launched/);
});

test("servers without a managed spec keep the historical PATH behaviour", async () => {
  const resolution = await resolveServerExecutable({
    definition: getServerDefinition("clangd"),
    configuration: undefined,
    env: EMPTY_ENV,
    platform: "darwin",
    managed: managedPort({ node: NODE }),
  });

  assert.equal(resolution.available, false);
  assert.match(resolution.error, /Executable not found/);
});

test("Pyright is the single Python server id and basedpyright is an alias", () => {
  assert.equal(isKnownServerId("pyright"), true);
  assert.equal(normalizeServerId("basedpyright"), "pyright");
  assert.equal(normalizeServerId("pyright"), "pyright");
  assert.equal(getServerDefinition("pyright").managed.packageId, "pyright");
});

test("extension mapping covers every declared JavaScript and TypeScript extension", () => {
  const cases = {
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".py": "python",
    ".pyi": "python",
    ".pyw": "python",
  };
  for (const [extension, languageId] of Object.entries(cases)) {
    assert.equal(languageIdForPath(`/project/file${extension}`), languageId, extension);
  }
});

test("the TypeScript server declares the full extension family", () => {
  const definition = getServerDefinition("typescript-language-server");
  for (const extension of [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]) {
    assert.ok(definition.extensions.includes(extension), extension);
  }
});
