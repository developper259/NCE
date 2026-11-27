"use strict";

/**
 * End-to-end environment journeys.
 *
 * Every other test in this repository checks one layer with the next one
 * stubbed. These tests chain the real layers instead: the real Installer
 * downloads a real archive over loopback HTTP and verifies its checksum, the
 * real PackageManager records it in the real InstallationStore, the real
 * ManagedToolResolver reads that record back, the real LspExecutableResolver
 * resolves the launch command, and the real LspManager starts a real child
 * process with the real embedded Node.js runtime.
 *
 * The only substitution is the language server itself: a fake LSP server
 * speaks the protocol over stdio, because downloading the real TypeScript
 * Language Server on every run would make the suite depend on the network.
 * Everything NCE owns is the production code path.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const { Installer } = require("../dist/ts/installer/Installer.js");
const { PackageManager } = require("../dist/ts/packages/PackageManager.js");
const { PackageRegistry } = require("../dist/ts/packages/PackageRegistry.js");
const { InstallationStore } = require("../dist/ts/packages/InstallationStore.js");
const { ManagedToolResolver } = require("../dist/ts/packages/ManagedToolResolver.js");
const { resolveServerExecutable } = require("../dist/ts/lsp/LspExecutableResolver.js");
const { getServerDefinition } = require("../dist/ts/lsp/LspServerRegistry.js");
const { LspManager } = require("../dist/ts/lsp/LspManager.js");
const { PathAccess } = require("../dist/ts/manager/PathAccess.js");
const { resolveInternalNodeRuntime } = require("../dist/ts/runtime/InternalNodeRuntime.js");

const { makeTarGz, serve, sha256, staticRoute, tempDir } = require("./helpers/installer.js");

const FAKE_SERVER = path.join(__dirname, "helpers", "fake-lsp-server.cjs");
const SERVER_VERSION = "6.1.0";
const SDK_VERSION = "6.0.3";

/** The real embedded runtime, or null when this checkout did not stage it. */
async function embeddedRuntime() {
  try {
    // Tests run from the repository root, where the build stages the binary
    // under resources/. `appPath` is how the runtime finds it outside Electron.
    return await resolveInternalNodeRuntime({ appPath: path.resolve(__dirname, "..") });
  } catch {
    return null;
  }
}

async function packageArchive(entries) {
  const dir = await tempDir("nce-e2e-archive-");
  const file = path.join(dir, "package.tar.gz");
  await makeTarGz(entries, file);
  const body = await fs.readFile(file);
  return { dir, body, checksum: sha256(body) };
}

/**
 * A managed package definition shaped like the real ones, but pointing at a
 * loopback archive so the real Installer runs without touching the network.
 */
function managedDefinition({ id, version, url, checksum, executable }) {
  return {
    id,
    name: id,
    description: `Test package ${id}.`,
    categories: ["language"],
    platforms: [process.platform],
    capabilities: ["install", "uninstall", "verify"],
    installerPackageId: id,
    installableVersion: version,
    installationRoot: `tools/${id}`,
    uninstall: { strategy: "installer-directory" },
  };
}

function installerDefinition({ id, version, url, checksum, executable }) {
  return {
    id,
    name: id,
    version,
    platforms: {
      [process.platform]: {
        [process.arch]: {
          download: { url, checksum, checksumAlgorithm: "sha256" },
          archive: { format: "tar.gz", stripComponents: 0 },
          executable,
        },
      },
    },
    install: {
      destination: "tools/{id}/{version}",
      steps: [{ type: "download" }, { type: "extract" }],
    },
    verification: { executable: `{installDir}/${executable}`, mode: "presence" },
  };
}

/**
 * Wire the real services the way App.ts wires them: one Installer, one
 * PackageManager over one InstallationStore, one ManagedToolResolver.
 */
async function environment(archives) {
  const userData = await tempDir("nce-e2e-userdata-");
  const routes = {};
  for (const [id, archive] of Object.entries(archives)) {
    routes[`/${id}.tar.gz`] = staticRoute(archive.body);
  }
  const server = await serve(routes);

  const installerRegistry = {};
  const managedRegistry = {};
  for (const [id, archive] of Object.entries(archives)) {
    const spec = {
      id,
      version: archive.version,
      url: `${server.origin}/${id}.tar.gz`,
      checksum: archive.checksum,
      executable: archive.executable,
    };
    installerRegistry[id] = installerDefinition(spec);
    managedRegistry[id] = managedDefinition(spec);
  }

  const installer = new Installer({ userDataPath: userData, registry: installerRegistry });
  const store = new InstallationStore(userData);
  await store.initialize();
  const packages = new PackageManager({
    userDataPath: userData,
    installer,
    store,
    registry: new PackageRegistry(Object.values(managedRegistry)),
    platform: process.platform,
    arch: process.arch,
  });
  await packages.initialize();
  const resolver = new ManagedToolResolver({ store });

  return {
    userData,
    installer,
    store,
    packages,
    resolver,
    close: async () => {
      await server.close();
      await fs.rm(userData, { recursive: true, force: true });
    },
  };
}

async function waitFor(read, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw last || new Error("Timed out waiting for the language server.");
}

const serverArchive = (data) => packageArchive([{ name: "lib/cli.mjs", data, mode: 0o644 }]);
const sdkArchive = () => packageArchive([{ name: "lib/tsserver.js", data: "// tsserver\n", mode: 0o644 }]);

// ---------------------------------------------------------------------------
// Journey A: install -> inventory -> resolver.
// ---------------------------------------------------------------------------

test("journey A: installing through PackageManager makes the package resolvable", async (t) => {
  const archive = await serverArchive("#!/usr/bin/env node\n");
  const env = await environment({
    "typescript-language-server": { ...archive, version: SERVER_VERSION, executable: "lib/cli.mjs" },
  });
  t.after(async () => {
    await env.close();
    await fs.rm(archive.dir, { recursive: true, force: true });
  });

  // Before: nothing installed, and the resolver says why.
  const before = await env.resolver.resolve("typescript-language-server", "lib/cli.mjs");
  assert.equal(before.available, false);
  assert.match(before.error, /is not installed by NCE/);

  // Install through the real lifecycle orchestrator, which downloads over
  // real HTTP, verifies the checksum, extracts and records the result.
  const installed = await env.packages.install("typescript-language-server");
  assert.equal(installed.success, true, installed.error);

  // The store is the source of truth and now reports it.
  const records = env.store.listByPackage("typescript-language-server");
  assert.equal(records.length, 1);
  assert.equal(records[0].state, "installed");
  assert.equal(records[0].version, SERVER_VERSION);

  // The resolver reads the store, not the install result.
  const after = await env.resolver.resolve("typescript-language-server", "lib/cli.mjs");
  assert.equal(after.available, true, after.error);
  assert.equal(after.executable, path.join(installed.installDir, "lib", "cli.mjs"));
  await fs.access(after.executable);

  // And the inventory the Version Manager shows agrees with the resolver.
  const state = env.packages.getState();
  const info = state.packages.find((entry) => entry.id === "typescript-language-server");
  assert.equal(info.state, "installed");
});

test("journey A: a stale record never counts as a working installation", async (t) => {
  const archive = await serverArchive("#!/usr/bin/env node\n");
  const env = await environment({
    "typescript-language-server": { ...archive, version: SERVER_VERSION, executable: "lib/cli.mjs" },
  });
  t.after(async () => {
    await env.close();
    await fs.rm(archive.dir, { recursive: true, force: true });
  });

  const installed = await env.packages.install("typescript-language-server");
  assert.equal(installed.success, true, installed.error);

  // The record survives but the entry point is gone.
  await fs.rm(path.join(installed.installDir, "lib", "cli.mjs"));
  const resolved = await env.resolver.resolve("typescript-language-server", "lib/cli.mjs");
  assert.equal(resolved.available, false);
  assert.match(resolved.error, /not usable|missing|no usable/i);
});

// ---------------------------------------------------------------------------
// Journey B: the full launch chain, including the embedded runtime.
// ---------------------------------------------------------------------------

test("journey B: an installed server launches through the embedded Node.js runtime", async (t) => {
  const runtime = await embeddedRuntime();
  if (!runtime) {
    t.skip("the embedded Node.js runtime is not staged in this checkout");
    return;
  }

  // The archive stands in for the npm package: the registry's declared entry
  // point exists and is a script the embedded runtime can execute.
  const entry = await fs.readFile(FAKE_SERVER, "utf8");
  const archive = await serverArchive(entry);
  const sdk = await sdkArchive();
  const env = await environment({
    "typescript-language-server": { ...archive, version: SERVER_VERSION, executable: "lib/cli.mjs" },
    typescript: { ...sdk, version: SDK_VERSION, executable: "lib/tsserver.js" },
  });
  const workspace = await tempDir("nce-e2e-workspace-");
  t.after(async () => {
    await env.close();
    await fs.rm(archive.dir, { recursive: true, force: true });
    await fs.rm(sdk.dir, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const sdkInstall = await env.packages.install("typescript");
  assert.equal(sdkInstall.success, true, sdkInstall.error);
  const serverInstall = await env.packages.install("typescript-language-server");
  assert.equal(serverInstall.success, true, serverInstall.error);

  // The real resolver, with the real managed resolver and the real runtime.
  const definition = getServerDefinition("typescript-language-server");
  assert.ok(definition, "the registry must declare the TypeScript server");
  const resolution = await resolveServerExecutable({
    definition,
    configuration: undefined,
    managed: env.resolver,
    internalRuntime: { resolve: async () => runtime },
  });
  assert.equal(resolution.available, true, resolution.error);
  assert.equal(resolution.source, "managed");
  // The command is the embedded runtime, never a Node.js from PATH.
  assert.equal(resolution.command, runtime.executable);
  assert.equal(resolution.args[0], path.join(serverInstall.installDir, "lib", "cli.mjs"));
  assert.deepEqual(resolution.args.slice(1), ["--stdio"]);
  // tsserver.fallbackPath points at the SDK NCE installed.
  assert.equal(
    resolution.initializationOptions?.tsserver?.fallbackPath,
    path.join(sdkInstall.installDir, "lib", "tsserver.js"),
  );

  // And the manager actually starts it. No path is configured here: the
  // manager must reach the managed installation through the resolver itself.
  const events = { statuses: [], diagnostics: [] };
  const manager = new LspManager({
    getWorkspaceRoot: () => workspace,
    pathAccess: new PathAccess(() => workspace),
    getSettings: () => ({
      enabled: true,
      servers: { "typescript-language-server": { enabled: true } },
    }),
    send: (channel, payload) => {
      if (channel === "Lsp:status") events.statuses.push(payload);
      if (channel === "Lsp:diagnostics") events.diagnostics.push(payload);
    },
    managedTools: env.resolver,
    internalRuntime: { resolve: async () => runtime },
    requestTimeoutMs: 8_000,
  });
  t.after(() => manager.dispose?.());

  const file = path.join(workspace, "index.ts");
  const text = "const answer: number = 42;\n";
  await fs.writeFile(file, text);
  const opened = await manager.openDocument({ path: file, languageId: "typescript", text });
  assert.equal(opened.success, true, opened.error);
  assert.equal(opened.servers.length, 1, "the document must be attached to the TypeScript server");

  // The server is ready only once it answered initialize through the runtime.
  // Session state lives on `sessions`; other servers in the registry are
  // expected to fail here, so only the TypeScript session is inspected.
  const ready = await waitFor(() => {
    const status = events.statuses.at(-1);
    const session = (status?.sessions ?? []).find(
      (entry) => entry.serverId === "typescript-language-server",
    );
    return session?.state === "ready" ? status : null;
  });
  const session = ready.sessions.find((entry) => entry.serverId === "typescript-language-server");
  assert.equal(session.documents, 1);
  assert.equal(
    ready.servers.find((entry) => entry.id === "typescript-language-server").source,
    "managed",
    "the running server must be reported as NCE-managed",
  );
  // Diagnostics arrive as a document map, not a flat list.
  const diagnostics = await waitFor(() =>
    events.diagnostics.find((payload) =>
      Object.values(payload?.documents ?? {}).some((entry) => (entry?.diagnostics?.length ?? 0) > 0),
    ),
  );
  const published = Object.values(diagnostics.documents).find(
    (entry) => (entry?.diagnostics?.length ?? 0) > 0,
  );
  // The diagnostic must come from the server that was launched, and describe
  // the document that was opened.
  assert.equal(published.diagnostics[0].severity, 1);
  assert.match(published.diagnostics[0].message, /diagnostic for version/);
});

test("journey B: without an installation the launch fails with a readable reason", async (t) => {
  const runtime = await embeddedRuntime();
  if (!runtime) {
    t.skip("the embedded Node.js runtime is not staged in this checkout");
    return;
  }
  const env = await environment({});
  t.after(() => env.close());

  const definition = getServerDefinition("typescript-language-server");
  const resolution = await resolveServerExecutable({
    definition,
    configuration: undefined,
    managed: env.resolver,
    internalRuntime: { resolve: async () => runtime },
    // An empty PATH so the fallback cannot find a real binary by accident.
    env: { PATH: "" },
  });
  assert.equal(resolution.available, false);
  // Short, because it is shown inline in the Problems panel.
  assert.equal(resolution.error, "Executable not found");
});

test("journey B: a missing embedded runtime is named, never replaced by PATH Node", async (t) => {
  const archive = await serverArchive("#!/usr/bin/env node\n");
  const env = await environment({
    "typescript-language-server": { ...archive, version: SERVER_VERSION, executable: "lib/cli.mjs" },
  });
  t.after(async () => {
    await env.close();
    await fs.rm(archive.dir, { recursive: true, force: true });
  });
  const installed = await env.packages.install("typescript-language-server");
  assert.equal(installed.success, true, installed.error);

  const definition = getServerDefinition("typescript-language-server");
  const resolution = await resolveServerExecutable({
    definition,
    configuration: undefined,
    managed: env.resolver,
    internalRuntime: {
      resolve: async () => {
        throw new Error("The internal Node.js runtime is unavailable.");
      },
    },
    // A PATH that does contain a working Node: it must still not be used.
    env: { PATH: path.dirname(process.execPath) },
  });
  assert.equal(resolution.available, false);
  assert.match(resolution.error, /internal Node\.js runtime is unavailable/);
  assert.equal(resolution.command, null);
});

// ---------------------------------------------------------------------------
// Journey C: uninstall removes the installation and the resolver notices.
// ---------------------------------------------------------------------------

test("journey C: uninstalling clears the inventory and the resolver stops resolving", async (t) => {
  const archive = await serverArchive("#!/usr/bin/env node\n");
  const env = await environment({
    "typescript-language-server": { ...archive, version: SERVER_VERSION, executable: "lib/cli.mjs" },
  });
  t.after(async () => {
    await env.close();
    await fs.rm(archive.dir, { recursive: true, force: true });
  });

  const installed = await env.packages.install("typescript-language-server");
  assert.equal(installed.success, true, installed.error);
  assert.equal((await env.resolver.resolve("typescript-language-server", "lib/cli.mjs")).available, true);

  // Uninstall takes the installation id, which is what the UI holds.
  const record = env.store.listByPackage("typescript-language-server")[0];
  assert.ok(record, "the installation must be recorded before it can be removed");
  const removed = await env.packages.uninstall(record.id);
  assert.equal(removed.success, true, removed.error);

  // The directory is gone, the inventory no longer offers it, and the resolver
  // reports the absence instead of a stale success.
  await assert.rejects(fs.access(installed.installDir));
  const installedRecords = env.store
    .listByPackage("typescript-language-server")
    .filter((record) => record.state === "installed");
  assert.equal(installedRecords.length, 0);
  const after = await env.resolver.resolve("typescript-language-server", "lib/cli.mjs");
  assert.equal(after.available, false);
  const info = env.packages.getState().packages.find((entry) => entry.id === "typescript-language-server");
  assert.notEqual(info.state, "installed");
});
