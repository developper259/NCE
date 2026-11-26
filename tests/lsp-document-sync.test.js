"use strict";

/**
 * Regression tests for LSP document synchronization.
 *
 * These cover the failure that made Ctrl+Space in a Python file report
 * "This document is not synchronized with a language server": a document that
 * the renderer believed was synchronized but the main process had never
 * registered, plus the reset races that produced the same state.
 */

const assert = require("node:assert");
const { test } = require("node:test");
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
  if (lastError) throw lastError;
  throw new Error("Timed out waiting for the expected LSP state.");
}

async function createWorkspace() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nce-lsp-sync-"));
  await fs.writeFile(path.join(workspace, "main.py"), "import os\n");
  await fs.writeFile(path.join(workspace, "main.ts"), "const value = 1;\n");
  return workspace;
}

function createManager(workspace, options = {}) {
  const events = { resets: 0, statuses: [] };
  const settings = {
    enabled: options.enabled !== false,
    servers: options.servers || {
      basedpyright: {
        enabled: options.python !== false,
        path: process.execPath,
        args: [fakeServer, "basedpyright", options.pythonMode || "normal"],
      },
    },
  };
  const manager = new LspManager({
    getWorkspaceRoot: () => workspace,
    pathAccess: new PathAccess(() => workspace),
    getSettings: () => settings,
    send: (channel, payload) => {
      if (channel === "Lsp:reset") events.resets += 1;
      else if (channel === "Lsp:status") events.statuses.push(payload);
    },
    requestTimeoutMs: options.requestTimeoutMs || 4_000,
  });
  return { manager, events, settings };
}

test("a supported language with its server disabled registers the document", async () => {
  const workspace = await createWorkspace();
  const documentPath = await fs.realpath(path.join(workspace, "main.py"));
  const { manager } = createManager(workspace, { python: false });
  try {
    const opened = await manager.openDocument({ path: documentPath, text: "import os\n" });
    assert.equal(opened.success, true);
    assert.equal(opened.supported, true);
    assert.equal(opened.languageId, "python");
    assert.deepEqual(opened.servers, [], "no server is attached");

    // The document is registered, so a change is accepted rather than reported
    // as an unsynchronized document.
    const changed = await manager.changeDocument({
      path: documentPath,
      changes: [{ text: "import sys\n" }],
    });
    assert.equal(changed.success, true, "the document is synchronized, just without a server");

    // Features answer "no provider", which is the honest answer, not
    // "not open", which would claim the renderer is out of sync.
    const completion = await manager.completion({
      path: documentPath,
      position: { line: 0, character: 0 },
    });
    assert.equal(completion.success, false);
    assert.equal(completion.code, "LSP_NO_PROVIDER");
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("an unknown language is still reported as unsupported, not synchronized", async () => {
  const workspace = await createWorkspace();
  await fs.writeFile(path.join(workspace, "notes.txt"), "plain text\n");
  const documentPath = await fs.realpath(path.join(workspace, "notes.txt"));
  const { manager } = createManager(workspace);
  try {
    const opened = await manager.openDocument({ path: documentPath, text: "plain text\n" });
    assert.equal(opened.success, true);
    assert.equal(opened.supported, false);
    assert.equal(opened.languageId, null);
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("completion works immediately after opening a Python document", async () => {
  const workspace = await createWorkspace();
  const documentPath = await fs.realpath(path.join(workspace, "main.py"));
  const { manager } = createManager(workspace);
  try {
    const opened = await manager.openDocument({ path: documentPath, text: "import os\n" });
    assert.equal(opened.success, true);
    assert.equal(opened.servers.length, 1);

    // No sleeping: the manager must either answer now or answer once the server
    // is ready. A request in the gap must not claim the document is missing.
    const completion = await waitFor(async () => {
      const result = await manager.completion({
        path: documentPath,
        position: { line: 0, character: 0 },
      });
      if (result.success) return result;
      assert.notEqual(
        result.code,
        "LSP_DOCUMENT_NOT_OPEN",
        "the document is registered as soon as openDocument resolves",
      );
      return null;
    });
    assert.equal(completion.success, true);
    assert.ok(completion.items.length > 0);
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a settings reset during opening supersedes the open instead of reporting success", async () => {
  const workspace = await createWorkspace();
  const documentPath = await fs.realpath(path.join(workspace, "main.py"));
  const { manager } = createManager(workspace);
  try {
    // Start the open and reset before it can finish resolving the executable.
    const opening = manager.openDocument({ path: documentPath, text: "import os\n" });
    const reset = manager.refreshSettings();
    const [opened] = await Promise.all([opening, reset]);

    // Either the open completed before the reset landed, or it was superseded.
    // What must never happen is a success for a document the reset removed.
    if (opened.success) {
      const completion = await manager.completion({
        path: documentPath,
        position: { line: 0, character: 0 },
      });
      assert.notEqual(
        completion.code,
        "LSP_DOCUMENT_NOT_OPEN",
        "a successful open must leave a registered document behind",
      );
    } else {
      assert.equal(opened.code, "LSP_OPEN_SUPERSEDED");
    }
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a workspace reset during opening leaves no stale document behind", async () => {
  const workspace = await createWorkspace();
  const documentPath = await fs.realpath(path.join(workspace, "main.py"));
  const { manager } = createManager(workspace);
  try {
    const opening = manager.openDocument({ path: documentPath, text: "import os\n" });
    const reset = manager.handleWorkspaceChanged();
    const [opened] = await Promise.all([opening, reset]);

    if (opened.success) {
      const completion = await manager.completion({
        path: documentPath,
        position: { line: 0, character: 0 },
      });
      assert.notEqual(completion.code, "LSP_DOCUMENT_NOT_OPEN");
    } else {
      assert.equal(opened.code, "LSP_OPEN_SUPERSEDED");
    }

    // A retry after the reset must work: the renderer re-synchronizes.
    const reopened = await manager.openDocument({ path: documentPath, text: "import os\n" });
    assert.equal(reopened.success, true);
    const completion = await waitFor(async () => {
      const result = await manager.completion({
        path: documentPath,
        position: { line: 0, character: 0 },
      });
      return result.success ? result : null;
    });
    assert.equal(completion.success, true);
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a document stays usable across a settings refresh", async () => {
  const workspace = await createWorkspace();
  const documentPath = await fs.realpath(path.join(workspace, "main.py"));
  const { manager } = createManager(workspace);
  try {
    await manager.openDocument({ path: documentPath, text: "import os\n" });
    await waitFor(async () => {
      const status = await manager.getStatus();
      return status.success && status.sessions.some((session) => session.state === "ready");
    });

    await manager.refreshSettings();

    // A settings change must not lose the user's open documents: the server
    // restarts, but the document is re-synchronized automatically.
    const retried = await waitFor(async () => {
      const result = await manager.completion({
        path: documentPath,
        position: { line: 0, character: 0 },
      });
      return result.success ? result : null;
    });
    assert.equal(retried.success, true);
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("completion still works after several rapid changes", async () => {
  const workspace = await createWorkspace();
  const documentPath = await fs.realpath(path.join(workspace, "main.py"));
  const { manager } = createManager(workspace);
  try {
    await manager.openDocument({ path: documentPath, text: "import os\n" });
    await waitFor(async () => {
      const status = await manager.getStatus();
      return status.success && status.sessions.some((session) => session.state === "ready");
    });

    for (let index = 0; index < 5; index += 1) {
      const changed = await manager.changeDocument({
        path: documentPath,
        changes: [{ text: `# edit ${index}\n` }],
      });
      assert.equal(changed.success, true);
    }

    const completion = await manager.completion({
      path: documentPath,
      position: { line: 0, character: 0 },
    });
    assert.equal(completion.success, true);
    assert.ok(completion.items.length > 0);
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a missing executable is reported without registering a false synchronization", async () => {
  const workspace = await createWorkspace();
  const documentPath = await fs.realpath(path.join(workspace, "main.py"));
  const { manager } = createManager(workspace, {
    servers: {
      basedpyright: {
        enabled: true,
        path: path.join(workspace, "does-not-exist"),
        args: [],
      },
    },
  });
  try {
    const opened = await manager.openDocument({ path: documentPath, text: "import os\n" });
    assert.equal(opened.success, true);
    assert.deepEqual(opened.servers, [], "no server attached when the executable is missing");

    const status = await manager.getStatus();
    // The status reports the canonical server id; the legacy `basedpyright`
    // settings key above is still honoured through the alias table.
    const server = status.servers.find((entry) => entry.id === "pyright");
    assert.ok(server, "the Python server is listed under its canonical id");
    assert.equal(server.available, false);

    // The document is registered, so the answer is "no provider", not "not open".
    const completion = await manager.completion({
      path: documentPath,
      position: { line: 0, character: 0 },
    });
    assert.equal(completion.success, false);
    assert.equal(completion.code, "LSP_NO_PROVIDER");
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
