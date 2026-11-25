"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const config = require("../scripts/internal-node-config.cjs");
const {
  resolveServerExecutable,
} = require("../dist/ts/lsp/LspExecutableResolver.js");
const { getServerDefinition } = require("../dist/ts/lsp/LspServerRegistry.js");

function stagedBinary() {
  return path.join(
    root,
    "resources",
    config.RESOURCE_DIR,
    config.VERSION,
    process.platform === "win32" ? "node.exe" : "node",
  );
}

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
      return {
        available: true,
        source: "managed",
        installation: { packageId, version: entry.version, installDir: entry.installDir },
        executable: entryPoint ? `${entry.installDir}/${entryPoint}` : entry.executable,
        installDir: entry.installDir,
        version: entry.version,
        error: null,
      };
    },
  };
}

function jsonRpcClient(child) {
  let buffer = Buffer.alloc(0);
  const listeners = new Map();
  const notifications = [];
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const match = /Content-Length: (\d+)/i.exec(buffer.slice(0, headerEnd).toString("utf8"));
      if (!match) throw new Error("Malformed LSP header");
      const length = Number(match[1]);
      if (buffer.length < headerEnd + 4 + length) return;
      const message = JSON.parse(buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString("utf8"));
      buffer = buffer.slice(headerEnd + 4 + length);
      if (typeof message.id === "number" && listeners.has(message.id)) {
        listeners.get(message.id)(message);
        listeners.delete(message.id);
      } else if (!("id" in message)) {
        notifications.push(message);
      }
    }
  });
  const client = { notifications, nextId: 1 };
  client.request = (method, params) => {
      const id = client.nextId++;
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8");
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${method}`)), 5000);
        listeners.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
        child.stdin.write(body);
      });
  };
  return client;
}

function withTimeout(promise, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), 10000);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

for (const serverId of ["pyright", "typescript-language-server"]) {
  test(`${serverId} resolves to the internal runtime without a managed node package`, async () => {
    const binary = stagedBinary();
    if (!fs.existsSync(binary)) return;
    const installDir = serverId === "pyright"
      ? "/managed/pyright"
      : "/managed/typescript-language-server";
    const entryPoint = serverId === "pyright" ? "langserver.index.js" : "lib/cli.mjs";
    const entry = `${installDir}/${entryPoint}`;
    const resolution = await resolveServerExecutable({
      definition: getServerDefinition(serverId),
      configuration: undefined,
      env: { PATH: "" },
      platform: process.platform,
      managed: managedPort({
        [serverId]: { installDir, executable: entry, version: "1" },
        typescript: { installDir: "/managed/typescript", executable: "/managed/typescript/lib/tsserver.js", version: "5.9.3" },
      }),
      internalRuntime: { resolve: async () => ({ executable: binary, version: config.VERSION }) },
    });
    assert.equal(resolution.available, true, resolution.error || undefined);
    assert.equal(resolution.command, binary);
    assert.equal(resolution.args[0], entry);
    assert.equal(resolution.args[1], "--stdio");
  });
}

test("a real LSP speaks JSON-RPC over stdio through the internal runtime", async () => {
  const binary = stagedBinary();
  if (!fs.existsSync(binary)) return;
  const script = path.join(root, "tests/helpers/fake-lsp-server.cjs");
  const child = spawn(binary, [script, "typescript-language-server", "normal"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  try {
    const client = jsonRpcClient(child);
    const initialized = await withTimeout(client.request("initialize", {
      processId: process.pid,
      rootUri: "file:///tmp",
      capabilities: {},
    }), "initialize");
    assert.equal(initialized.id, client.nextId - 1);
    assert.ok(initialized.result.capabilities);

    const completion = await withTimeout(client.request("textDocument/completion", {
      textDocument: { uri: "file:///tmp/a.ts" },
      position: { line: 0, character: 1 },
    }), "completion");
    assert.ok(Array.isArray(completion.result.items), "completion must return items");

    const hover = await withTimeout(client.request("textDocument/hover", {
      textDocument: { uri: "file:///tmp/a.ts" },
      position: { line: 0, character: 1 },
    }), "hover");
    assert.ok(hover.result, "hover must return a result");
  } finally {
    child.kill();
  }
});
