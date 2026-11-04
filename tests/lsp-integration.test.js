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
  const events = { diagnostics: [], statuses: [], resets: 0, applyEditRequests: [], progress: [], messages: [] };
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
      else if (channel === "Lsp:applyEditRequest") events.applyEditRequests.push(payload);
      else if (channel === "Lsp:progress") events.progress.push(payload);
      else if (channel === "Lsp:message") events.messages.push(payload);
    },
    requestTimeoutMs: options.requestTimeoutMs || 4_000,
    maxDocumentBytes: options.maxDocumentBytes,
  });
  return { manager, events };
}

function createIpcRegistrar() {
  const handlers = new Map();
  return {
    handle(channel, listener) { handlers.set(channel, listener); },
    invoke(channel, payload) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Missing IPC handler ${channel}`);
      return handler(null, payload);
    },
  };
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
    const readyServer = ready.servers.find((server) => server.id === "typescript-language-server");
    assert.equal(readyServer.source, "configured");
    assert.equal(readyServer.executable, process.execPath);
    assert.deepEqual(readyServer.args, [fakeServer, "typescript-language-server", "normal"]);
    assert.equal(readyServer.requiresConfiguration, false);
    const needsConfiguration = ready.servers.find((server) => server.id === "eclipse-jdtls");
    assert.equal(needsConfiguration.requiresConfiguration, true);
    assert.equal(needsConfiguration.available, false);
    assert.equal(needsConfiguration.source, null);
    assert.deepEqual(needsConfiguration.args, []);
    assert.equal(ready.sessions.every((session) => session.documents === 1), true);
    const readySession = ready.sessions.find((session) =>
      session.serverId === "typescript-language-server");
    assert.deepEqual(readySession.capabilities.completionTriggerCharacters, ["."]);
    assert.deepEqual(readySession.capabilities.signatureHelpTriggerCharacters, ["("]);
    assert.equal(readySession.capabilities.completionResolve, true);

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
    const documentDiagnostics = await waitFor(() => {
      const latest = events.diagnostics.at(-1);
      const document = latest?.documents.find((entry) => entry.path === documentPath);
      if (!document?.diagnostics.length) return null;
      return document.diagnostics.every((entry) =>
        entry.serverId.startsWith("typescript-language-server")) ? document : null;
    });
    assert.equal(documentDiagnostics.diagnostics.length > 0, true);
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

test("resource operations in workspace edits are sanitized for the renderer", { timeout: 30_000 }, async () => {
  const workspace = await createWorkspace();
  await fs.writeFile(path.join(workspace, "old.ts"), "old\n");
  const documentPath = await fs.realpath(path.join(workspace, "main.ts"));
  const { manager } = createManager(workspace, {
    eslint: false,
    typescriptMode: "resource-edit",
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
    assert.equal(renamed.success, true);
    assert.equal(renamed.edit.resources.length, 3);
    assert.deepEqual(renamed.edit.resources.map((resource) => resource.kind), ["create", "rename", "delete"]);
    assert.equal(renamed.edit.resources[0].path.endsWith("created.ts"), true);
    assert.equal(renamed.edit.resources[1].oldPath, documentPath);
    assert.equal(renamed.edit.resources[2].path, await fs.realpath(path.join(workspace, "old.ts")));
    assert.equal(renamed.edit.files.length, 1);
    assert.equal(renamed.edit.files[0].edits[0].newText, "created by server\n");
    assert.equal(renamed.edit.files[0].version, null);
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("NCE workspace state is never synchronized or edited", { timeout: 20_000 }, async () => {
  const workspace = await createWorkspace();
  await fs.mkdir(path.join(workspace, ".nce"), { recursive: true });
  await fs.writeFile(path.join(workspace, ".nce", "state.ts"), "const state = 1;\n");
  const { manager } = createManager(workspace, { eslint: false });
  try {
    const opened = await manager.openDocument({
      path: path.join(workspace, ".nce", "state.ts"),
      text: "const state = 1;\n",
    });
    assert.equal(opened.success, false);
    assert.equal(opened.code, "LSP_INVALID_PATH");
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("dynamic registrations enable features for servers without static capabilities", { timeout: 30_000 }, async () => {
  const workspace = await createWorkspace();
  const documentPath = await fs.realpath(path.join(workspace, "main.ts"));
  const { manager } = createManager(workspace, {
    eslint: false,
    typescriptMode: "dynamic",
  });
  try {
    assert.equal((await manager.openDocument({
      path: documentPath,
      text: "const value = 1;\n",
    })).success, true);
    const status = await waitFor(async () => {
      const current = await manager.getStatus();
      const session = current.success && current.sessions.find((entry) =>
        entry.serverId === "typescript-language-server" && entry.state === "ready");
      return session?.capabilities.completion === true ? current : null;
    });
    const session = status.sessions.find((entry) =>
      entry.serverId === "typescript-language-server");
    assert.equal(session.capabilities.hover, true);
    assert.equal(session.capabilities.definition, true);
    assert.equal(session.capabilities.signatureHelp, true);
    assert.deepEqual(session.capabilities.completionTriggerCharacters, ["."]);
    assert.deepEqual(session.capabilities.signatureHelpTriggerCharacters, ["("]);
    const completion = await manager.completion({
      path: documentPath,
      position: { line: 0, character: 0 },
    });
    assert.equal(completion.success, true);
    assert.equal(completion.items.length >= 2, true);
    const signature = await manager.signatureHelp({
      path: documentPath,
      position: { line: 0, character: 0 },
    });
    assert.equal(signature.success, true);
    manager.handleFileSystemEvent("change", documentPath);
    const watched = await waitFor(async () => {
      const value = await manager.hover({ path: documentPath, position: { line: 0, character: 0 } });
      return value.success && /watched:1/.test(value.hover.contents) ? value : null;
    });
    assert.match(watched.hover.contents, /watched:1/);
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("server-initiated workspace edits round-trip through the renderer", { timeout: 30_000 }, async () => {
  const workspace = await createWorkspace();
  const documentPath = await fs.realpath(path.join(workspace, "main.ts"));
  const { manager, events } = createManager(workspace, {
    eslint: false,
    typescriptMode: "apply-edit",
  });
  const ipc = createIpcRegistrar();
  manager.handleIPC(ipc);
  try {
    assert.equal((await manager.openDocument({
      path: documentPath,
      text: "const value = 1;\n",
    })).success, true);
    const request = await waitFor(() => events.applyEditRequests[0]);
    assert.equal(request.edit.files.length, 1);
    assert.equal(request.edit.files[0].path, documentPath);
    assert.equal(request.edit.files[0].edits[0].newText, "server-typescript-language-server\n");
    const result = await ipc.invoke("Lsp:applyEditResult", {
      id: request.id,
      applied: true,
    });
    assert.equal(result.success, true);
    const hover = await waitFor(async () => {
      const value = await manager.hover({ path: documentPath, position: { line: 0, character: 0 } });
      return value.success && /"applied":true/.test(value.hover.contents) ? value : null;
    });
  } finally {
    await manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("progress notifications reach the renderer", { timeout: 30_000 }, async () => {
  const workspace = await createWorkspace();
  const documentPath = await fs.realpath(path.join(workspace, "main.ts"));
  const { manager, events } = createManager(workspace, {
    eslint: false,
    typescriptMode: "progress",
  });
  try {
    assert.equal((await manager.openDocument({
      path: documentPath,
      text: "const value = 1;\n",
    })).success, true);
    await waitFor(() => events.progress.some((entry) => entry.kind === "end"));
    assert.deepEqual(events.progress.map((entry) => entry.kind), ["begin", "report", "end"]);
    assert.equal(events.progress[0].title, "typescript-language-server analysis");
    assert.equal(events.progress[1].percentage, 50);
    assert.equal(events.progress[0].serverId.startsWith("typescript-language-server::"), true);
    await waitFor(() => events.messages.length > 0);
    assert.equal(events.messages[0].type, 2);
    assert.equal(events.messages[0].message, "typescript-language-server message");
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
      return result.success && result.hover && /\[\{\}\]/.test(result.hover.contents) &&
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
