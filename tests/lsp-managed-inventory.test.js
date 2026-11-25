"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { LspManager } = require("../dist/ts/lsp/LspManager.js");
const { PathAccess } = require("../dist/ts/manager/PathAccess.js");

const fakeServer = path.join(__dirname, "helpers", "fake-lsp-server.cjs");

async function waitFor(read, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw lastError || new Error("Timed out waiting for the language server state.");
}

/**
 * A mutable managed-tool inventory. Tests flip `state.entries` to simulate an
 * install or an uninstall between calls.
 */
function inventoryPort(entries) {
  const state = { entries: { ...entries } };
  return {
    state,
    resolve: async (packageId) => {
      const entry = state.entries[packageId];
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
      return {
        available: true,
        source: "managed",
        installation: { packageId, version: entry.version, installDir: entry.installDir },
        executable: entry.executable,
        installDir: entry.installDir,
        version: entry.version,
        error: null,
      };
    },
  };
}

/** The fake server stands in for the managed entry point and the TypeScript SDK. */
function managedEntries() {
  return {
    node: { installDir: "/managed/node", executable: process.execPath, version: "24.22.3" },
    "typescript-language-server": {
      installDir: "/managed/tls",
      executable: fakeServer,
      version: "6.1.0",
    },
    typescript: { installDir: "/managed/typescript", executable: fakeServer, version: "5.9.3" },
    pyright: { installDir: "/managed/pyright", executable: fakeServer, version: "1.1.414" },
  };
}

function createManager(workspace, managed, servers = {}) {
  const events = { diagnostics: [], statuses: [] };
  const manager = new LspManager({
    getWorkspaceRoot: () => workspace,
    pathAccess: new PathAccess(() => workspace),
    getSettings: () => ({ enabled: true, servers }),
    managedTools: managed,
    internalRuntime: { resolve: async () => ({ executable: process.execPath, version: process.versions.node }) },
    send: (channel, payload) => {
      if (channel === "Lsp:diagnostics") events.diagnostics.push(payload);
      else if (channel === "Lsp:status") events.statuses.push(payload);
    },
    requestTimeoutMs: 4_000,
  });
  return { manager, events };
}

async function createWorkspace() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nce-lsp-inventory-"));
  await fs.writeFile(path.join(workspace, "main.ts"), "const value = 1;\n");
  return workspace;
}

async function openManagedSession(workspace, managed) {
  const documentPath = await fs.realpath(path.join(workspace, "main.ts"));
  const { manager, events } = createManager(workspace, managed);
  const opened = await manager.openDocument({
    path: documentPath,
    text: "const value = 1;\n",
  });
  assert.equal(opened.success, true);
  const ready = await waitFor(async () => {
    const status = await manager.getStatus();
    return status.success &&
      status.sessions.length === 1 &&
      status.sessions[0].state === "ready" &&
      status;
  });
  assert.equal(ready.sessions[0].serverId, "typescript-language-server");
  const diagnostics = await waitFor(() => {
    const latest = [...events.diagnostics].reverse().find((payload) =>
      payload?.documents?.some((document) => document.path === documentPath &&
        document.diagnostics.length > 0));
    return latest || null;
  });
  return { manager, events, documentPath, ready, diagnostics };
}

test("uninstalling a managed server stops its session and clears its diagnostics", { timeout: 40_000 }, async () => {
  const workspace = await createWorkspace();
  const managed = inventoryPort(managedEntries());
  const { manager, events, documentPath } = await openManagedSession(workspace, managed);
  try {
    // The package is uninstalled: the resolver can no longer find it.
    delete managed.state.entries["typescript-language-server"];

    await manager.handleManagedPackagesChanged(["typescript-language-server"]);

    const status = await manager.getStatus();
    assert.equal(status.success, true);
    assert.deepEqual(
      status.sessions,
      [],
      "the session for an uninstalled server must be stopped, not left running",
    );

    const latest = events.diagnostics.at(-1);
    const stillListed = latest?.documents?.some((document) =>
      document.path === documentPath && document.diagnostics.length > 0);
    assert.equal(stillListed, false, "diagnostics from an uninstalled server must be cleared");

    // The server is no longer reported as coming from the managed install. It
    // may still resolve from PATH (npm puts node_modules/.bin there), which is
    // legitimate; what must not survive is the managed launch.
    const server = status.servers.find((entry) => entry.id === "typescript-language-server");
    assert.notEqual(server.source, "managed");
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("installing a server attaches the already-open document without a reload", { timeout: 40_000 }, async () => {
  const workspace = await createWorkspace();
  await fs.writeFile(path.join(workspace, "main.py"), "value = 1\n");
  const documentPath = await fs.realpath(path.join(workspace, "main.py"));
  // The server is not installed yet: opening the file cannot launch it.
  const managed = inventoryPort({});
  const { manager, events } = createManager(workspace, managed);
  try {
    const opened = await manager.openDocument({ path: documentPath, text: "value = 1\n" });
    assert.equal(opened.success, true);
    assert.equal(opened.languageId, "python");
    assert.deepEqual(opened.servers, [], "nothing can be launched before the install");

    const unavailable = await manager.getStatus();
    // The failed attempt is reported, but no server is running.
    assert.equal(
      unavailable.sessions.some((session) => session.state === "ready"),
      false,
      "no server can be ready before the install",
    );

    // The user installs Pyright from the Version Manager.
    Object.assign(managed.state.entries, managedEntries());
    await manager.handleManagedPackagesChanged(["pyright"]);

    // The document is still open, so it must be attached without reopening it.
    const ready = await waitFor(async () => {
      const status = await manager.getStatus();
      return status.success &&
        status.sessions.some((session) =>
          session.serverId === "pyright" && session.state === "ready") && status;
    });
    const session = ready.sessions.find((entry) => entry.serverId === "pyright");
    assert.equal(session.documents, 1, "the open document must be synchronized with the new server");

    const diagnostics = await waitFor(() => {
      const latest = [...events.diagnostics].reverse().find((payload) =>
        payload?.documents?.some((document) =>
          document.path === documentPath && document.diagnostics.length > 0));
      return latest || null;
    });
    assert.ok(diagnostics, "the newly installed server must report diagnostics for the open file");
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("an inventory refresh also picks up a server that became available", { timeout: 40_000 }, async () => {
  const workspace = await createWorkspace();
  await fs.writeFile(path.join(workspace, "main.py"), "value = 1\n");
  const documentPath = await fs.realpath(path.join(workspace, "main.py"));
  const managed = inventoryPort({});
  const { manager } = createManager(workspace, managed);
  try {
    assert.equal((await manager.openDocument({ path: documentPath, text: "value = 1\n" })).success, true);

    // A reconcile reports no package ids at all; it must still recover.
    Object.assign(managed.state.entries, managedEntries());
    await manager.handleManagedPackagesChanged([]);

    const ready = await waitFor(async () => {
      const status = await manager.getStatus();
      return status.success &&
        status.sessions.some((session) =>
          session.serverId === "pyright" && session.state === "ready") && status;
    });
    assert.equal(ready.sessions.find((entry) => entry.serverId === "pyright").documents, 1);
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("an inventory refresh with no package ids keeps healthy managed sessions", { timeout: 40_000 }, async () => {
  const workspace = await createWorkspace();
  const managed = inventoryPort(managedEntries());
  const { manager, events, documentPath } = await openManagedSession(workspace, managed);
  try {
    // A reconcile or manual refresh reports no specific package. It must not be
    // read as "every managed server changed".
    await manager.handleManagedPackagesChanged([]);

    const status = await manager.getStatus();
    assert.equal(status.success, true);
    assert.equal(status.sessions.length, 1, "a refresh must not tear down a healthy session");
    assert.equal(status.sessions[0].state, "ready");

    const latest = events.diagnostics.at(-1);
    const stillListed = latest?.documents?.some((document) =>
      document.path === documentPath && document.diagnostics.length > 0);
    assert.equal(stillListed, true, "diagnostics must survive an unrelated refresh");
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("a missing TypeScript SDK stops the language server that depends on it", { timeout: 40_000 }, async () => {
  const workspace = await createWorkspace();
  const managed = inventoryPort(managedEntries());
  const { manager } = await openManagedSession(workspace, managed);
  try {
    // The server binary is still there, but the SDK whose path was injected at
    // initialize time is gone. The session must not stay ready against it.
    delete managed.state.entries.typescript;
    await manager.handleManagedPackagesChanged(["typescript"]);

    const status = await manager.getStatus();
    assert.equal(status.success, true);
    assert.equal(
      status.sessions.some((session) => session.serverId === "typescript-language-server"),
      false,
      "a session pointing at a missing SDK must be stopped",
    );
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("a managed server re-confirmed by an inventory change re-attaches its open document", { timeout: 40_000 }, async () => {
  const workspace = await createWorkspace();
  const managed = inventoryPort(managedEntries());
  const { manager } = await openManagedSession(workspace, managed);
  try {
    // The package is still installed: a verify or refresh reports it again.
    // The session is restarted, and the open document must follow it.
    await manager.handleManagedPackagesChanged(["typescript-language-server"]);

    const ready = await waitFor(async () => {
      const status = await manager.getStatus();
      const session = status.sessions.find((entry) => entry.serverId === "typescript-language-server");
      return status.success && session?.state === "ready" && session.documents === 1 && status;
    });
    assert.equal(ready.sessions.length, 1);
    const session = ready.sessions[0];
    assert.equal(session.documents, 1, "the open document must re-attach to the restarted server");
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("a session launched from a configured path survives an inventory change", { timeout: 40_000 }, async () => {
  const workspace = await createWorkspace();
  const documentPath = await fs.realpath(path.join(workspace, "main.ts"));
  // The user pointed the server at their own executable. The managed inventory
  // has no business tearing that session down when some package is installed.
  const { manager } = createManager(workspace, inventoryPort(managedEntries()), {
    "typescript-language-server": {
      enabled: true,
      path: process.execPath,
      args: [fakeServer, "typescript-language-server", "normal"],
    },
  });
  try {
    const opened = await manager.openDocument({
      path: documentPath,
      text: "const value = 1;\n",
    });
    assert.equal(opened.success, true);
    const ready = await waitFor(async () => {
      const status = await manager.getStatus();
      return status.success && status.sessions.length === 1 && status;
    });
    assert.equal(ready.sessions[0].serverId, "typescript-language-server");

    await manager.handleManagedPackagesChanged(["typescript-language-server"]);

    const status = await manager.getStatus();
    assert.equal(
      status.sessions.length,
      1,
      "a configured server does not depend on the managed package",
    );
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
