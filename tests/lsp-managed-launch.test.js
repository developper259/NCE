"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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

/** Standalone runtime stub: no PATH lookup, no managed `node` package. */
const internalRuntimePort = {
  resolve: async () => ({ executable: NODE.executable, version: NODE.version }),
};

test("Pyright launches through the internal Node.js runtime", async () => {
  const resolution = await resolveServerExecutable({
    definition: getServerDefinition("pyright"),
    configuration: undefined,
    env: EMPTY_ENV,
    platform: "darwin",
    managed: managedPort({ pyright: PYRIGHT }),
    internalRuntime: internalRuntimePort,
  });

  assert.equal(resolution.available, true);
  assert.equal(resolution.source, "managed");
  assert.equal(resolution.command, NODE.executable);
  assert.deepEqual(resolution.args, [PYRIGHT.executable, "--stdio"]);
});

test("TypeScript Language Server launches through the internal Node.js runtime with tsserver.fallbackPath", async () => {
  const resolution = await resolveServerExecutable({
    definition: getServerDefinition("typescript-language-server"),
    configuration: undefined,
    env: EMPTY_ENV,
    platform: "darwin",
    managed: managedPort({ "typescript-language-server": TLS, typescript: TYPESCRIPT }),
    internalRuntime: internalRuntimePort,
  });

  assert.equal(resolution.available, true);
  assert.equal(resolution.source, "managed");
  assert.equal(resolution.command, NODE.executable);
  assert.deepEqual(resolution.args, [TLS.executable, "--stdio"]);
  assert.equal(
    resolution.initializationOptions.tsserver.fallbackPath,
    TYPESCRIPT.executable,
    "the managed TypeScript SDK must be passed as tsserver.fallbackPath",
  );
  // `path` overrides the workspace TypeScript unconditionally. NCE must let a
  // project keep its own usable SDK, so the managed one is only a fallback.
  assert.equal(
    resolution.initializationOptions.tsserver.path,
    undefined,
    "NCE must not force tsserver.path",
  );
});

test("a Windows tsserver path survives placeholder expansion", async () => {
  // A Windows path contains backslashes, which are not legal JSON escapes. The
  // placeholder used to be spliced into serialized JSON, so this threw a
  // SyntaxError and the server could never launch on Windows.
  const WINDOWS_TYPESCRIPT = {
    installDir: "C:\\managed\\tools\\typescript\\5.9.3",
    executable: "C:\\managed\\tools\\typescript\\5.9.3\\lib\\tsserver.js",
    version: "5.9.3",
  };
  const WINDOWS_NODE = {
    installDir: "C:\\managed\\tools\\node\\24.22.3",
    executable: "C:\\managed\\tools\\node\\24.22.3\\node.exe",
    version: "24.22.3",
  };
  const WINDOWS_TLS = {
    installDir: "C:\\managed\\tools\\typescript-language-server\\6.1.0",
    executable: "C:\\managed\\tools\\typescript-language-server\\6.1.0\\lib\\cli.mjs",
    version: "6.1.0",
  };

  const resolution = await resolveServerExecutable({
    definition: getServerDefinition("typescript-language-server"),
    configuration: undefined,
    env: EMPTY_ENV,
    platform: "win32",
    managed: managedPort({
      "typescript-language-server": WINDOWS_TLS,
      typescript: WINDOWS_TYPESCRIPT,
    }),
    internalRuntime: {
      resolve: async () => ({ executable: WINDOWS_NODE.executable, version: WINDOWS_NODE.version }),
    },
  });

  assert.equal(resolution.available, true, resolution.error || undefined);
  assert.equal(resolution.source, "managed");
  assert.equal(resolution.command, WINDOWS_NODE.executable);
  // The entry point comes from the test helper, which joins with a forward
  // slash; only the tsserver path is produced by the code under test.
  assert.match(resolution.args[0], /cli\.mjs$/);
  assert.equal(resolution.args[1], "--stdio");
  const tsserverPath = resolution.initializationOptions.tsserver.fallbackPath;
  // The regression was a SyntaxError from splicing a Windows path into JSON,
  // which also mangled the backslashes. The path must survive intact.
  assert.ok(
    tsserverPath.startsWith("C:\\managed\\tools\\typescript\\5.9.3"),
    `the Windows tsserver path must keep its backslashes, got: ${tsserverPath}`,
  );
  assert.match(tsserverPath, /tsserver\.js$/);
});

test("a missing TypeScript SDK is an explicit failure, not a silent launch", async () => {
  const resolution = await resolveServerExecutable({
    definition: getServerDefinition("typescript-language-server"),
    configuration: undefined,
    env: EMPTY_ENV,
    platform: "darwin",
    managed: managedPort({ "typescript-language-server": TLS }),
    internalRuntime: internalRuntimePort,
  });

  assert.equal(resolution.available, false);
  assert.match(resolution.error, /TypeScript SDK could not be resolved/);
});

test("a missing internal runtime is an explicit failure", async () => {
  const resolution = await resolveServerExecutable({
    definition: getServerDefinition("pyright"),
    configuration: undefined,
    env: EMPTY_ENV,
    platform: "darwin",
    managed: managedPort({ pyright: PYRIGHT }),
  });

  assert.equal(resolution.available, false);
  assert.match(resolution.error, /internal Node\.js runtime/);
});

test("a failing internal runtime is reported, never replaced by PATH Node", async () => {
  const resolution = await resolveServerExecutable({
    definition: getServerDefinition("pyright"),
    configuration: undefined,
    env: { PATH: "/usr/bin:/bin" },
    platform: "darwin",
    managed: managedPort({ pyright: PYRIGHT }),
    internalRuntime: {
      resolve: async () => { throw new Error("runtime binary is missing"); },
    },
  });

  assert.equal(resolution.available, false);
  assert.match(resolution.error, /runtime binary is missing/);
});

test("a configured absolute path always wins over a managed installation", async () => {
  const resolution = await resolveServerExecutable({
    definition: getServerDefinition("pyright"),
    configuration: { path: process.execPath },
    env: EMPTY_ENV,
    platform: process.platform,
    managed: managedPort({ pyright: PYRIGHT }),
    internalRuntime: internalRuntimePort,
  });

  assert.equal(resolution.available, true);
  assert.equal(resolution.source, "configured");
  assert.equal(resolution.command, process.execPath);
});

test("a Node.js found on PATH never replaces the internal runtime", async () => {
  const externalNode = path.join(os.tmpdir(), "nce-external-node");
  fs.writeFileSync(externalNode, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const externalDir = path.dirname(externalNode);
  try {
    const resolution = await resolveServerExecutable({
      definition: getServerDefinition("pyright"),
      configuration: undefined,
      env: { PATH: externalDir },
      platform: "darwin",
      managed: managedPort({ pyright: PYRIGHT }),
      internalRuntime: internalRuntimePort,
    });
    assert.equal(resolution.available, true);
    assert.equal(resolution.command, NODE.executable, "only the internal runtime may launch the server");
    assert.notEqual(resolution.command, externalNode);
  } finally {
    fs.rmSync(externalNode, { force: true });
  }
});

test("a managed installation wins over PATH discovery", async () => {
  const resolution = await resolveServerExecutable({
    definition: getServerDefinition("pyright"),
    configuration: undefined,
    env: { PATH: "/usr/bin:/bin" },
    platform: process.platform,
    managed: managedPort({ pyright: PYRIGHT }),
    internalRuntime: internalRuntimePort,
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

  // No pyright on PATH in a clean environment: the inline status stays short.
  assert.equal(resolution.available, false);
  assert.equal(resolution.error, "Executable not found");
});

test("a corrupted managed install does not silently fall back to PATH", async () => {
  const resolution = await resolveServerExecutable({
    definition: getServerDefinition("pyright"),
    configuration: undefined,
    env: EMPTY_ENV,
    platform: "darwin",
    managed: managedPort({
      pyright: { ...PYRIGHT, missingEntry: true },
    }),
    internalRuntime: internalRuntimePort,
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
    managed: managedPort({}),
    internalRuntime: internalRuntimePort,
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
    // The React ids are what typescript-language-server needs to open these
    // files with the JSX/TSX script kind instead of plain JS/TS.
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescriptreact",
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

test("initialization options merge deterministically instead of replacing tsserver", () => {
  const { mergeInitializationOptions } = require("../dist/ts/lsp/LspManager.js");

  // The definition carries a user-facing `tsserver.path`; the managed
  // resolution contributes `fallbackPath`. A shallow spread would drop `path`.
  const merged = mergeInitializationOptions(
    { tsserver: { path: "/user/tsserver.js", logVerbosity: "verbose" }, maxTsServerMemory: 4096 },
    { tsserver: { fallbackPath: "/managed/tsserver.js" } },
  );
  assert.deepEqual(merged, {
    tsserver: {
      path: "/user/tsserver.js",
      logVerbosity: "verbose",
      fallbackPath: "/managed/tsserver.js",
    },
    maxTsServerMemory: 4096,
  });

  // Scalars and arrays are replaced, not merged.
  assert.deepEqual(
    mergeInitializationOptions({ plugins: [{ name: "a" }], locale: "en" }, { plugins: [], locale: "fr" }),
    { plugins: [], locale: "fr" },
  );

  // Missing sides are handled without inventing an empty object.
  assert.deepEqual(mergeInitializationOptions(undefined, { tsserver: { fallbackPath: "/x" } }), {
    tsserver: { fallbackPath: "/x" },
  });
  assert.deepEqual(mergeInitializationOptions({ a: 1 }, undefined), { a: 1 });
  assert.equal(mergeInitializationOptions(undefined, undefined), undefined);

  // Deterministic: same inputs, same output, and the inputs are not mutated.
  const base = { tsserver: { path: "/user/tsserver.js" } };
  const override = { tsserver: { fallbackPath: "/managed/tsserver.js" } };
  const first = mergeInitializationOptions(base, override);
  const second = mergeInitializationOptions(base, override);
  assert.deepEqual(first, second);
  assert.deepEqual(base, { tsserver: { path: "/user/tsserver.js" } });
  assert.deepEqual(override, { tsserver: { fallbackPath: "/managed/tsserver.js" } });
});
