"use strict";

const assert = require("node:assert/strict");
const { promises: fs } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  ManagedToolResolver,
  compareVersions,
  isScriptEntryPoint,
} = require("../dist/ts/packages/ManagedToolResolver.js");

function record(overrides = {}) {
  return {
    id: overrides.id || `inst-${Math.random().toString(36).slice(2)}`,
    packageId: "node",
    name: "Node.js",
    version: "24.22.3",
    categories: ["runtime"],
    installDir: "/tmp/does-not-matter",
    executable: "/tmp/does-not-matter/bin/node",
    platform: "darwin",
    arch: "x64",
    state: "installed",
    provenance: "managed",
    installedAt: 0,
    updatedAt: 0,
    uninstall: { strategy: "installer-directory" },
    ...overrides,
  };
}

/** In-memory store that satisfies ManagedInstallationSource. */
function store(records) {
  return {
    listByPackage: (packageId) => records.filter((entry) => entry.packageId === packageId),
    list: () => records.slice(),
  };
}

/** Resolver over a fake filesystem described by a set of absolute paths. */
function resolverWith(records, files, options = {}) {
  const present = new Set(files);
  const executable = new Set(options.executableFiles || files);
  return new ManagedToolResolver({
    store: store(records),
    platform: options.platform || "darwin",
    pathExists: async (target) => present.has(target),
    isExecutable: async (target) => executable.has(target),
  });
}

test("resolves a native executable inside the recorded install directory", async () => {
  const installDir = "/tools/node/24.22.3";
  const executable = path.join(installDir, "bin/node");
  const resolver = resolverWith(
    [record({ installDir, executable })],
    [installDir, executable],
  );

  const resolution = await resolver.resolve("node");
  assert.equal(resolution.available, true);
  assert.equal(resolution.source, "managed");
  assert.equal(resolution.executable, executable);
  assert.equal(resolution.version, "24.22.3");
  assert.equal(resolution.error, null);
});

test("resolves a relative entry point against the install directory", async () => {
  const installDir = "/tools/typescript-language-server/6.1.0";
  const entry = path.join(installDir, "lib/cli.mjs");
  const resolver = resolverWith(
    [record({ packageId: "typescript-language-server", installDir, executable: entry })],
    [installDir, entry],
  );

  const resolution = await resolver.resolve("typescript-language-server", "lib/cli.mjs");
  assert.equal(resolution.available, true);
  assert.equal(resolution.executable, entry);
});

test("a JavaScript entry point does not need the executable bit", async () => {
  const installDir = "/tools/pyright/1.1.414";
  const entry = path.join(installDir, "langserver.index.js");
  const resolver = resolverWith(
    [record({ packageId: "pyright", installDir, executable: entry })],
    [installDir, entry],
    { executableFiles: [] },
  );

  const resolution = await resolver.resolve("pyright");
  assert.equal(resolution.available, true);
  assert.equal(resolution.executable, entry);
});

test("a native entry point without the executable bit is rejected", async () => {
  const installDir = "/tools/node/24.22.3";
  const executable = path.join(installDir, "bin/node");
  const resolver = resolverWith(
    [record({ installDir, executable })],
    [installDir, executable],
    { executableFiles: [] },
  );

  const resolution = await resolver.resolve("node");
  assert.equal(resolution.available, false);
  assert.match(resolution.error, /not executable/);
});

test("reports a missing package explicitly", async () => {
  const resolver = resolverWith([], []);
  const resolution = await resolver.resolve("node");
  assert.equal(resolution.available, false);
  assert.equal(resolution.source, "missing");
  assert.match(resolution.error, /not installed by NCE/);
});

test("resolveIfInstalled treats a missing package as a quiet fallback", async () => {
  const resolver = resolverWith([], []);
  const resolution = await resolver.resolveIfInstalled("pyright");
  assert.equal(resolution.available, false);
  assert.equal(resolution.error, null);
});

test("a corrupted installation is not usable and its state is reported", async () => {
  const installDir = "/tools/pyright/1.1.414";
  const resolver = resolverWith(
    [record({ packageId: "pyright", installDir, state: "corrupted" })],
    [installDir],
  );

  const resolution = await resolver.resolve("pyright");
  assert.equal(resolution.available, false);
  assert.match(resolution.error, /not usable \(state: corrupted\)/);
});

test("an installation whose directory disappeared is rejected", async () => {
  const installDir = "/tools/node/24.22.3";
  const resolver = resolverWith(
    [record({ installDir, executable: path.join(installDir, "bin/node") })],
    [],
  );

  const resolution = await resolver.resolve("node");
  assert.equal(resolution.available, false);
  assert.match(resolution.error, /install directory is missing/);
});

test("an entry point escaping the install directory is rejected", async () => {
  const installDir = "/tools/node/24.22.3";
  const resolver = resolverWith(
    [record({ installDir, executable: path.join(installDir, "bin/node") })],
    [installDir, "/etc/passwd"],
  );

  const resolution = await resolver.resolve("node", "../../../etc/passwd");
  assert.equal(resolution.available, false);
  assert.match(resolution.error, /escapes the install directory/);
});

test("several versions resolve to the newest usable one", async () => {
  const oldDir = "/tools/node/20.11.0";
  const newDir = "/tools/node/24.22.3";
  const resolver = resolverWith(
    [
      record({ id: "old", version: "20.11.0", installDir: oldDir, executable: path.join(oldDir, "bin/node") }),
      record({ id: "new", version: "24.22.3", installDir: newDir, executable: path.join(newDir, "bin/node") }),
    ],
    [oldDir, newDir, path.join(oldDir, "bin/node"), path.join(newDir, "bin/node")],
  );

  const resolution = await resolver.resolve("node");
  assert.equal(resolution.available, true);
  assert.equal(resolution.version, "24.22.3");
});

test("a corrupted newest version falls back to an older usable one", async () => {
  const oldDir = "/tools/node/20.11.0";
  const newDir = "/tools/node/24.22.3";
  const resolver = resolverWith(
    [
      record({ id: "old", version: "20.11.0", installDir: oldDir, executable: path.join(oldDir, "bin/node") }),
      record({ id: "new", version: "24.22.3", installDir: newDir, state: "corrupted" }),
    ],
    [oldDir, newDir, path.join(oldDir, "bin/node")],
  );

  const resolution = await resolver.resolve("node");
  assert.equal(resolution.available, true);
  assert.equal(resolution.version, "20.11.0");
});

test("activeInstallation never returns a non-installed record", () => {
  const resolver = resolverWith(
    [record({ packageId: "pyright", state: "installing" })],
    [],
  );
  assert.equal(resolver.activeInstallation("pyright"), null);
});

test("compareVersions orders numerically, not lexically", () => {
  assert.ok(compareVersions("24.22.3", "20.11.0") > 0);
  assert.ok(compareVersions("9.0.0", "10.0.0") < 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("isScriptEntryPoint recognises runtime-launched entry points", () => {
  assert.equal(isScriptEntryPoint("/x/langserver.index.js"), true);
  assert.equal(isScriptEntryPoint("/x/lib/cli.mjs"), true);
  assert.equal(isScriptEntryPoint("/x/lib/cli.cjs"), true);
  assert.equal(isScriptEntryPoint("/x/bin/node"), false);
  assert.equal(isScriptEntryPoint("/x/node.exe"), false);
});

test("resolves against a real temporary installation on disk", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-mtr-"));
  try {
    const installDir = path.join(root, "tools", "node", "24.22.3");
    const binDir = path.join(installDir, "bin");
    await fs.mkdir(binDir, { recursive: true });
    const executable = path.join(binDir, "node");
    await fs.writeFile(executable, "#!/bin/sh\necho v24.22.3\n", { mode: 0o755 });

    const resolver = new ManagedToolResolver({
      store: store([record({ installDir, executable })]),
    });

    const resolution = await resolver.resolve("node");
    assert.equal(resolution.available, true);
    assert.equal(resolution.executable, executable);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
