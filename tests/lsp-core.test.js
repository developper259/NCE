const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  JsonRpcConnection,
  JsonRpcTimeoutError,
  JsonRpcCancelledError,
} = require("../dist/ts/lsp/JsonRpcConnection.js");
const {
  lineSpans,
  positionToOffset,
  offsetToPosition,
  applyTextChange,
  applyTextEdits,
  pathToUri,
  uriToPath,
} = require("../dist/ts/lsp/LspText.js");
const {
  languageIdForPath,
  serversForLanguage,
  resolveServerRoot,
} = require("../dist/ts/lsp/LspServerRegistry.js");
const { sanitizeLspSettings, isValidLspServers } = require("../dist/ts/lsp/LspSettings.js");
const { LspDiagnosticsStore } = require("../dist/ts/lsp/LspDiagnosticsStore.js");
const { LspDocumentStore } = require("../dist/ts/lsp/LspDocumentStore.js");
const { SettingsManager } = require("../dist/ts/manager/SettingsManager.js");

function frame(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

function createFrameReader(stream) {
  let buffer = Buffer.alloc(0);
  const messages = [];
  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const separator = buffer.indexOf("\r\n\r\n");
      if (separator < 0) return;
      let length = null;
      for (const line of buffer.subarray(0, separator).toString("ascii").split("\r\n")) {
        const match = /^content-length:\s*(\d+)$/i.exec(line);
        if (match) length = Number(match[1]);
      }
      if (length === null) return;
      const start = separator + 4;
      if (buffer.length < start + length) return;
      messages.push(JSON.parse(buffer.subarray(start, start + length).toString("utf8")));
      buffer = buffer.subarray(start + length);
    }
  });
  return messages;
}

async function waitFor(read, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the expected condition.");
}

test("JSON-RPC framing handles grouped, fragmented and UTF-8 messages", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const notifications = [];
  const connection = new JsonRpcConnection({
    input,
    output,
    onNotification: (method, params) => notifications.push({ method, params }),
    onRequest: () => null,
  });
  connection.start();
  const grouped = Buffer.concat([
    frame({ jsonrpc: "2.0", method: "first", params: { emoji: "😀" } }),
    frame({ jsonrpc: "2.0", method: "second", params: null }),
  ]);
  const split = Math.floor(grouped.length / 2);
  input.write(grouped.subarray(0, split));
  await new Promise((resolve) => setTimeout(resolve, 20));
  input.write(grouped.subarray(split));
  await waitFor(() => notifications.length === 2);
  assert.deepEqual(notifications.map((entry) => entry.method), ["first", "second"]);
  assert.equal(notifications[0].params.emoji, "😀");
  connection.dispose();
});

test("JSON-RPC correlates requests and rejects timeouts and cancellations", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const written = createFrameReader(output);
  const connection = new JsonRpcConnection({
    input,
    output,
    onNotification: () => {},
    onRequest: () => null,
    requestTimeoutMs: 5_000,
  });
  connection.start();

  const first = connection.request("first", {}, { timeoutMs: 2_000 });
  const second = connection.request("second", {}, { timeoutMs: 2_000 });
  await waitFor(() => written.length === 2);
  const [firstRequest, secondRequest] = written;
  input.write(frame({ jsonrpc: "2.0", id: secondRequest.id, result: "second-result" }));
  input.write(frame({ jsonrpc: "2.0", id: firstRequest.id, result: "first-result" }));
  assert.equal(await first, "first-result");
  assert.equal(await second, "second-result");

  const timedOut = connection.request("slow", {}, { timeoutMs: 80 });
  await assert.rejects(timedOut, JsonRpcTimeoutError);
  await waitFor(() => written.some((message) => message.method === "$/cancelRequest"));

  const controller = new AbortController();
  const cancelled = connection.request("cancelled", {}, { timeoutMs: 2_000, signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, JsonRpcCancelledError);
  connection.dispose();
});

test("JSON-RPC answers server requests and rejects unknown methods", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const written = createFrameReader(output);
  const connection = new JsonRpcConnection({
    input,
    output,
    onNotification: () => {},
    onRequest: (method) => {
      if (method === "workspace/configuration") return [{ setting: true }];
      const error = new Error("unsupported");
      error.code = -32601;
      throw error;
    },
  });
  connection.start();
  input.write(frame({ jsonrpc: "2.0", id: 7, method: "workspace/configuration", params: { items: [{}] } }));
  await waitFor(() => written.length === 1);
  assert.deepEqual(written[0], { jsonrpc: "2.0", id: 7, result: [{ setting: true }] });
  input.write(frame({ jsonrpc: "2.0", id: 8, method: "unknown/method", params: {} }));
  await waitFor(() => written.length === 2);
  assert.deepEqual(written[1], {
    jsonrpc: "2.0",
    id: 8,
    error: { code: -32601, message: "unsupported" },
  });
  connection.dispose();
});

test("JSON-RPC rejects malformed and oversized messages", async () => {
  const errors = [];
  const input = new PassThrough();
  const output = new PassThrough();
  const connection = new JsonRpcConnection({
    input,
    output,
    onNotification: () => {},
    onRequest: () => null,
    maxMessageBytes: 32,
    onProtocolError: (error) => errors.push(error),
  });
  connection.start();
  input.write(Buffer.from("Content-Length: 3\r\n\r\n{bad", "ascii"));
  await waitFor(() => errors.length === 1);
  assert.equal(connection.isClosed, true);

  const secondErrors = [];
  const secondInput = new PassThrough();
  const secondConnection = new JsonRpcConnection({
    input: secondInput,
    output: new PassThrough(),
    onNotification: () => {},
    onRequest: () => null,
    maxMessageBytes: 32,
    onProtocolError: (error) => secondErrors.push(error),
  });
  secondConnection.start();
  secondInput.write(frame({ jsonrpc: "2.0", method: "too-large", params: "x".repeat(100) }));
  await waitFor(() => secondErrors.length === 1);
  assert.equal(secondConnection.isClosed, true);
});

test("LSP text utilities preserve UTF-16 positions across CRLF and emoji", () => {
  const text = "a😀b\r\nsecond\nthird";
  assert.deepEqual(lineSpans(text), [
    { start: 0, end: 4 },
    { start: 6, end: 12 },
    { start: 13, end: 18 },
  ]);
  assert.equal(positionToOffset(text, { line: 0, character: 3 }), 3);
  assert.deepEqual(offsetToPosition(text, 3), { line: 0, character: 3 });
  assert.equal(applyTextChange(text, {
    start: { line: 0, character: 1 },
    end: { line: 0, character: 3 },
  }, "🐍"), "a🐍b\r\nsecond\nthird");
  assert.equal(
    applyTextEdits("abcdef", [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "A" },
      { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 6 } }, newText: "EF" },
    ]),
    "AbcdEF",
  );
  assert.throws(() => applyTextEdits("abcdef", [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, newText: "x" },
    { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } }, newText: "y" },
  ]));
  const spacedFile = path.join(os.tmpdir(), "a file.ts");
  const uri = pathToUri(spacedFile);
  assert.match(uri, /^file:\/\//);
  assert.equal(uriToPath(uri), spacedFile);
});

test("server registry maps NSH languages and resolves project roots", async () => {
  assert.equal(languageIdForPath("/tmp/app.ts"), "typescript");
  assert.equal(languageIdForPath("/tmp/header.h"), "c");
  assert.equal(languageIdForPath("/tmp/image.svg"), "xml");
  assert.equal(languageIdForPath("/tmp/view.tsx"), null);
  const typescriptServers = serversForLanguage("typescript");
  assert.equal(typescriptServers.some((server) => server.id === "typescript-language-server"), true);
  assert.equal(typescriptServers.some((server) => server.id === "eslint-language-server"), true);

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nce-lsp-root-"));
  const project = path.join(workspace, "packages", "app");
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, "tsconfig.json"), "{}");
  const source = path.join(project, "index.ts");
  await fs.writeFile(source, "const value = 1;\n");
  const definition = typescriptServers.find((server) => server.id === "typescript-language-server");
  assert.equal(
    await resolveServerRoot(definition, await fs.realpath(source), workspace),
    await fs.realpath(project),
  );
  assert.equal(
    await resolveServerRoot(definition, path.join(workspace, "other.ts"), workspace),
    workspace,
  );
  await fs.rm(workspace, { recursive: true, force: true });
});

test("LSP settings reject malformed server entries", () => {
  const sanitized = sanitizeLspSettings({
    enabled: false,
    servers: {
      "typescript-language-server": { enabled: true, path: "/opt/ts-ls", args: ["--stdio"] },
      "bad id": { enabled: true },
      "clangd": { path: "relative" },
    },
  });
  assert.equal(sanitized.enabled, false);
  assert.deepEqual(Object.keys(sanitized.servers).sort(),
    ["clangd", "typescript-language-server"]);
  assert.equal(sanitized.servers.clangd.path, "relative");
  assert.equal(isValidLspServers(sanitized.servers), true);
  assert.equal(isValidLspServers({ clangd: { path: "relative" } }), true);
  assert.equal(isValidLspServers({ clangd: { unknown: true } }), false);
  assert.equal(isValidLspServers({ "Bad Id": {} }), false);
});

test("diagnostics isolate servers, clear empty sets and reject stale versions", () => {
  const store = new LspDiagnosticsStore();
  store.setServerName("a", "Server A");
  store.setServerName("b", "Server B");
  const diagnostic = {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    message: "problem",
    severity: 1,
  };
  assert.equal(store.publish("file:///a.ts", "a", 2, [diagnostic]), true);
  assert.equal(store.publish("file:///a.ts", "b", 1, [diagnostic]), true);
  assert.equal(store.publish("file:///a.ts", "a", 1, [diagnostic]), false, "stale publish ignored");
  const aggregate = store.aggregate();
  assert.equal(aggregate.length, 1);
  assert.equal(aggregate[0].diagnostics.length, 2);
  assert.deepEqual(aggregate[0].diagnostics.map((entry) => entry.serverName).sort(), ["Server A", "Server B"]);
  assert.equal(store.publish("file:///a.ts", "a", 3, []), true);
  assert.equal(store.aggregate()[0].diagnostics.length, 1);
  assert.equal(store.clearServer("b"), true);
  assert.equal(store.aggregate().length, 0);
});

test("document store keeps monotonic versions and applies incremental changes", () => {
  const store = new LspDocumentStore();
  const document = store.open("/tmp/a.ts", "file:///tmp/a.ts", "typescript", "one\ntwo\n");
  assert.equal(document.version, 1);
  const changed = store.change("/tmp/a.ts", [{
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
    text: "TWO",
  }], 1024);
  assert.equal(changed.document.version, 2);
  assert.equal(changed.document.text, "one\nTWO\n");
  assert.throws(() => store.change("/tmp/a.ts", [{ text: "x".repeat(2_000) }], 1024));
  assert.equal(store.get("/tmp/a.ts").version, 2);
  assert.equal(store.close("/tmp/a.ts").version, 2);
  assert.equal(store.size, 0);
});

test("SettingsManager persists validated LSP settings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nce-lsp-settings-"));
  const manager = new SettingsManager(root);
  try {
    const settings = await manager.initialize();
    assert.deepEqual(settings.lsp, { enabled: true, servers: {} });
    assert.equal(await manager.set("lsp.enabled", false), true);
    assert.equal(await manager.set("lsp.servers", {
      clangd: { enabled: true, path: "/usr/bin/clangd", args: [] },
    }), true);
    assert.equal(await manager.set("lsp.servers", { clangd: { path: 42 } }), false);
    assert.equal(await manager.set("lsp.servers", { "bad id": {} }), false);
    const stored = manager.getAll();
    assert.equal(stored.lsp.enabled, false);
    assert.equal(stored.lsp.servers.clangd.path, "/usr/bin/clangd");
    const reloaded = new SettingsManager(root);
    assert.equal((await reloaded.initialize()).lsp.enabled, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
