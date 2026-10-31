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

function createManager(workspace, options = {}) {
  const events = { diagnostics: [], statuses: [], resets: 0 };
  const servers = {
    "typescript-language-server": {
      enabled: options.typescript !== false,
      path: process.execPath,
      args: [fakeServer, "typescript-language-server", options.typescriptMode || "normal"],
    },
    "eslint-language-server": {
      enabled: options.eslint !== false,
      path: process.execPath,
      args: [fakeServer, "second-server", options.eslintMode || "normal"],
    },
    ...(options.servers || {}),
  };
  const manager = new LspManager({
    getWorkspaceRoot: () => workspace,
    pathAccess: new PathAccess(() => workspace),
    getSettings: options.getSettings || (() => ({
      enabled: options.enabled !== false,
      servers,
    })),
    send: (channel, payload) => {
      if (channel === "Lsp:diagnostics") events.diagnostics.push(payload);
      else if (channel === "Lsp:status") events.statuses.push(payload);
      else if (channel === "Lsp:reset") events.resets += 1;
    },
    requestTimeoutMs: options.requestTimeoutMs || 4_000,
    maxDocumentBytes: options.maxDocumentBytes,
  });
  return { manager, events };
}

async function createWorkspace() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nce-lsp-workspace-"));
  await fs.writeFile(path.join(workspace, "main.ts"), "const value = 1;\n");
  await fs.writeFile(path.join(workspace, "other.ts"), "const other = 2;\n");
  return workspace;
}

function latestDiagnostics(events, documentPath) {
  return [...events.diagnostics].reverse().find((payload) =>
    payload?.documents?.some((document) => document.path === documentPath &&
      document.diagnostics.length > 0));
}

test("LSP manager runs several servers for one document and routes features", { timeout: 40_000 }, async () => {
  const workspace = await createWorkspace();
  const documentPath = await fs.realpath(path.join(workspace, "main.ts"));
  const otherPath = await fs.realpath(path.join(workspace, "other.ts"));
  const { manager, events } = createManager(workspace);
  try {
    const opened = await manager.openDocument({
      path: documentPath,
      text: "const value = 1;\n",
    });
    assert.equal(opened.success, true);
    assert.equal(opened.supported, true);
    assert.equal(opened.languageId, "typescript");
    assert.equal(opened.path, documentPath);
    assert.equal(opened.servers.length, 2);

    const ready = await waitFor(async () => {
      const status = await manager.getStatus();
      return status.success && status.sessions.length === 2 &&
        status.sessions.every((session) => session.state === "ready") && status;
    });
    assert.equal(ready.servers.find((server) => server.id === "typescript-language-server").available, true);
    assert.equal(ready.sessions.every((session) => session.documents === 1), true);

    const diagnostics = await waitFor(() => {
      const latest = latestDiagnostics(events, documentPath);
      return latest?.documents.find((document) => document.path === documentPath)
        ?.diagnostics.length === 2 ? latest : null;
    });
    const documentDiagnostics = diagnostics.documents.find((document) => document.path === documentPath);
    assert.equal(documentDiagnostics.diagnostics.length, 2);
    assert.deepEqual(
      [...new Set(documentDiagnostics.diagnostics.map((entry) => entry.serverId))]
        .map((entry) => entry.split("::")[0]).sort(),
      ["eslint-language-server", "typescript-language-server"],
    );
    assert.equal(documentDiagnostics.diagnostics.every((entry) => entry.message.includes("version 1")), true);

    const completion = await manager.completion({
      path: documentPath,
      position: { line: 0, character: 3 },
    });
    assert.equal(completion.success, true);
    const labels = completion.items.map((item) => item.label).sort();
    assert.deepEqual(labels, ["second-server-item", "shared-item", "typescript-language-server-item"]);
    assert.equal(completion.items.filter((item) => item.label === "shared-item").length, 1);
    const resolvable = completion.items.find((item) => item.label === "typescript-language-server-item");
    assert.equal(typeof resolvable.id, "string");
    const resolved = await manager.resolveCompletion({ id: resolvable.id });
    assert.equal(resolved.success, true);
    assert.equal(resolved.item.detail, "typescript-language-server-resolved");
    assert.match(resolved.item.documentation, /resolved documentation/);

    const hover = await manager.hover({ path: documentPath, position: { line: 0, character: 0 } });
    assert.equal(hover.success, true);
    assert.equal(hover.hover.source, "typescript-language-server");
    assert.match(hover.hover.contents, /typescript-language-server/);
    assert.match(hover.hover.contents, /v1 len17/);

    const definition = await manager.locations(
      { path: documentPath, position: { line: 0, character: 0 } },
      "definition",
    );
    assert.equal(definition.success, true);
    assert.equal(definition.locations.length, 1);
    assert.equal(definition.locations[0].path, documentPath);
    assert.equal(definition.locations[0].authorized, true);

    const references = await manager.references({
      path: documentPath,
      position: { line: 0, character: 0 },
    });
    assert.equal(references.success, true);
    assert.equal(references.groups.length, 2);
    assert.equal(references.total, 4);
    assert.equal(references.groups.every((group) => group.locations.every((entry) => entry.authorized)), true);

    const changed = await manager.changeDocument({
      path: documentPath,
      changes: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        text: "let x",
      }],
    });
    assert.equal(changed.success, true);
    assert.equal(changed.version, 2);
    const changedDiagnostics = await waitFor(() => {
      const latest = latestDiagnostics(events, documentPath);
      return latest?.documents.find((document) => document.path === documentPath)
        ?.diagnostics.every((entry) => entry.message.includes("version 2")) ? latest : null;
    });
    assert.ok(changedDiagnostics);
    const hoverAfterChange = await manager.hover({ path: documentPath, position: { line: 0, character: 0 } });
    assert.match(hoverAfterChange.hover.contents, /len17|len16|v2/);

    const prepared = await manager.prepareRename({ path: documentPath, position: { line: 0, character: 0 } });
    assert.equal(prepared.success, true);
    assert.equal(prepared.preparation.source, "typescript-language-server");
    const renamed = await manager.rename({
      path: documentPath,
      position: { line: 0, character: 0 },
      newName: "renamed",
    });
    assert.equal(renamed.success, true);
    assert.equal(renamed.edit.files.length, 1);
    assert.equal(renamed.edit.files[0].path, documentPath);
    assert.equal(renamed.edit.source, "typescript-language-server");

    const actions = await manager.codeActions({
      path: documentPath,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      context: { diagnostics: [] },
    });
    assert.equal(actions.success, true);
    assert.equal(actions.actions.length, 4);
    assert.equal(actions.actions.every((action) => typeof action.id === "string"), true);
    const commandAction = actions.actions.find((action) => action.command);
    const executed = await manager.executeCodeAction({ id: commandAction.id });
    assert.equal(executed.success, true);
    assert.equal(executed.edit.files[0].path, documentPath);
    assert.match(executed.edit.files[0].edits[0].newText, /command-/);

    const formatting = await manager.format({ path: documentPath });
    assert.equal(formatting.success, true);
    assert.equal(formatting.edit.files[0].path, documentPath);
    assert.match(formatting.edit.files[0].edits[0].newText, /formatted-typescript-language-server/);

    const symbols = await manager.documentSymbols({ path: documentPath });
    assert.equal(symbols.success, true);
    assert.equal(symbols.symbols.length, 2);
    const workspaceSymbols = await manager.workspaceSymbols({ path: documentPath, query: "sym" });
    assert.equal(workspaceSymbols.success, true);
    assert.equal(workspaceSymbols.symbols.length, 2);
    assert.equal(workspaceSymbols.symbols.every((symbol) => symbol.location.authorized === true), true);

    const signature = await manager.signatureHelp({ path: documentPath, position: { line: 0, character: 0 } });
    assert.equal(signature.success, true);
    assert.equal(signature.help.source, "typescript-language-server");

    assert.equal((await manager.saveDocument({ path: documentPath })).success, true);
    assert.equal((await manager.closeDocument({ path: documentPath })).success, true);
    await waitFor(() => {
      const latest = events.diagnostics.at(-1);
      return latest?.documents.every((document) => document.path !== documentPath);
    });

    assert.equal((await manager.openDocument({
      path: otherPath,
      text: "const other = 2;\n",
    })).success, true);
    const statusAfterReopen = await waitFor(async () => {
      const status = await manager.getStatus();
      return status.success && status.sessions.length === 2 &&
        status.sessions.every((session) => session.documents === 1) && status;
    });
    assert.equal(statusAfterReopen.sessions.length, 2, "sessions are reused across documents");
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("LSP manager reports missing executables without breaking documents", { timeout: 20_000 }, async () => {
  const workspace = await createWorkspace();
  const documentPath = await fs.realpath(path.join(workspace, "main.ts"));
  const missing = path.join(workspace, "missing-typescript-server");
  const { manager } = createManager(workspace, {
    eslint: false,
    servers: {
      "typescript-language-server": { enabled: true, path: missing, args: [] },
    },
  });
  try {
    const opened = await manager.openDocument({ path: documentPath, text: "const value = 1;\n" });
    assert.equal(opened.success, true);
    assert.equal(opened.supported, true);
    assert.deepEqual(opened.servers, []);
    const status = await manager.getStatus();
    assert.equal(status.success, true);
    const unavailable = status.sessions.find((session) =>
      session.serverId === "typescript-language-server");
    assert.equal(unavailable.state, "failed");
    assert.match(unavailable.error, /missing or not executable/);
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("LSP manager rejects workspace edits outside the authorized workspace", { timeout: 30_000 }, async () => {
  const workspace = await createWorkspace();
  const documentPath = await fs.realpath(path.join(workspace, "main.ts"));
  const { manager } = createManager(workspace, {
    eslint: false,
    typescriptMode: "outside",
  });
  try {
    assert.equal((await manager.openDocument({
      path: documentPath,
      text: "const value = 1;\n",
    })).success, true);
    await waitFor(async () => {
      const status = await manager.getStatus();
      return status.success && status.sessions.some((session) => session.state === "ready");
    });
    const renamed = await manager.rename({
      path: documentPath,
      position: { line: 0, character: 0 },
      newName: "renamed",
    });
    assert.equal(renamed.success, false);
    assert.equal(renamed.code, "LSP_INVALID_PATH");
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("one crashing server keeps the other session and its diagnostics alive", { timeout: 30_000 }, async () => {
  const workspace = await createWorkspace();
  const documentPath = await fs.realpath(path.join(workspace, "main.ts"));
  const { manager, events } = createManager(workspace, { eslintMode: "crash-on-change" });
  try {
    assert.equal((await manager.openDocument({
      path: documentPath,
      text: "const value = 1;\n",
    })).success, true);
    await waitFor(() => latestDiagnostics(events, documentPath)?.documents
      .find((document) => document.path === documentPath)?.diagnostics.length === 2);
    assert.equal((await manager.changeDocument({
      path: documentPath,
      changes: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
        text: "let",
      }],
    })).success, true);
    await waitFor(async () => {
      const status = await manager.getStatus();
      return status.success && status.sessions.some((session) =>
        session.serverId === "eslint-language-server" && session.state === "failed");
    });
    const completion = await manager.completion({
      path: documentPath,
      position: { line: 0, character: 0 },
    });
    assert.equal(completion.success, true);
    assert.equal(completion.items.some((item) => item.label === "typescript-language-server-item"), true);
    const latest = events.diagnostics.at(-1);
    const documentDiagnostics = latest.documents.find((document) => document.path === documentPath);
    assert.equal(documentDiagnostics.diagnostics.every((entry) =>
      entry.serverId.startsWith("typescript-language-server")), true);
    assert.equal((await manager.restartServer({ serverId: "eslint-language-server" })).success, true);
    await waitFor(async () => {
      const status = await manager.getStatus();
      return status.success && status.sessions.some((session) =>
        session.serverId === "eslint-language-server" && session.state === "ready");
    });
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("settings changes reset sessions and respect disabled servers", { timeout: 30_000 }, async () => {
  const workspace = await createWorkspace();
  const documentPath = await fs.realpath(path.join(workspace, "main.ts"));
  const servers = {
    "typescript-language-server": {
      enabled: true,
      path: process.execPath,
      args: [fakeServer, "typescript-language-server"],
    },
    "eslint-language-server": { enabled: false },
  };
  let settings = { enabled: true, servers };
  const { manager, events } = createManager(workspace, { getSettings: () => settings });
  try {
    assert.equal((await manager.openDocument({
      path: documentPath,
      text: "const value = 1;\n",
    })).success, true);
    await waitFor(async () => {
      const status = await manager.getStatus();
      return status.success && status.sessions.some((session) => session.state === "ready");
    });
    settings = { enabled: false, servers: {} };
    await manager.refreshSettings();
    assert.ok(events.resets >= 1);
    const disabled = await manager.getStatus();
    assert.equal(disabled.success, true);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.sessions.length, 0);
    const reopened = await manager.openDocument({
      path: documentPath,
      text: "const value = 1;\n",
    });
    assert.equal(reopened.success, true);
    assert.equal(reopened.supported, false);
    await manager.handleWorkspaceChanged();
    assert.equal((await manager.getStatus()).sessions.length, 0);
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("LSP manager answers server-initiated requests and validates payloads", { timeout: 30_000 }, async () => {
  const workspace = await createWorkspace();
  const documentPath = await fs.realpath(path.join(workspace, "main.ts"));
  const { manager } = createManager(workspace, {
    eslint: false,
    typescriptMode: "server-request",
    maxDocumentBytes: 32,
  });
  try {
    const opened = await manager.openDocument({ path: documentPath, text: "const value = 1;\n" });
    assert.equal(opened.success, true);
    await waitFor(async () => {
      const status = await manager.getStatus();
      return status.success && status.sessions.some((session) => session.state === "ready");
    });
    const hover = await waitFor(async () => {
      const result = await manager.hover({ path: documentPath, position: { line: 0, character: 0 } });
      return result.success && result.hover && /\[null\]/.test(result.hover.contents) &&
        /-32601/.test(result.hover.contents) ? result : null;
    });
    assert.equal(hover.success, true);

    const tooLarge = await manager.openDocument({
      path: path.join(workspace, "other.ts"),
      text: "x".repeat(64),
    });
    assert.equal(tooLarge.success, false);
    assert.equal(tooLarge.code, "LSP_INVALID_ARGUMENT");

    const outside = await manager.openDocument({
      path: path.join(os.tmpdir(), "outside.ts"),
      text: "const outside = 1;\n",
    });
    assert.equal(outside.success, false);
    assert.equal(outside.code, "LSP_INVALID_PATH");

    const invalidPosition = await manager.hover({ path: documentPath, position: { line: -1, character: 0 } });
    assert.equal(invalidPosition.success, false);
    assert.equal(invalidPosition.code, "LSP_INVALID_ARGUMENT");
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
