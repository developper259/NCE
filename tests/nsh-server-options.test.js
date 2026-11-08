const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { NSHServer } = require("nsh/server");
const { Highlighter } = require("nsh");
const WebSocket = require("ws");
const { loadGlobal } = require("./helpers/runtime");
const {
  createNSHServerOptions,
  NSH_RENDERER_ORIGINS,
} = require("../dist/ts/nsh/NSHServerOptions.js");

function createClient(port, origin) {
  return new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: origin === undefined ? {} : { Origin: origin },
  });
}

async function expectAccepted(port, origin) {
  const socket = createClient(port, origin);
  const pending = new Map();
  let nextId = 0;
  socket.on("message", (data) => {
    const response = JSON.parse(data);
    const resolve = pending.get(response.id);
    if (resolve) {
      pending.delete(response.id);
      resolve(response);
    }
  });
  try {
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
      socket.once("unexpected-response", (_request, response) =>
        reject(new Error(`HTTP ${response.statusCode}`)));
    });
    const id = String(++nextId);
    const result = await new Promise((resolve) => {
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, requestType: "supportedLanguages" }));
    });
    assert.equal(result.success, true, result.error);
    return socket;
  } catch (error) {
    socket.terminate();
    throw error;
  }
}

async function expectRejected(port, origin) {
  const socket = createClient(port, origin);
  try {
    const result = await new Promise((resolve) => {
      socket.once("open", () => resolve("open"));
      socket.once("unexpected-response", (_request, response) =>
        resolve(`http-${response.statusCode}`));
      socket.once("error", (error) => resolve(`error:${error.message}`));
    });
    assert.notEqual(result, "open", `origin ${origin} must be rejected`);
    return result;
  } finally {
    socket.terminate();
  }
}

test("NSH server options keep quotas and origins explicit", () => {
  const options = createNSHServerOptions();
  assert.equal(options.host, "127.0.0.1");
  assert.equal(options.port, 0);
  assert.deepEqual([...options.allowedOrigins], [...NSH_RENDERER_ORIGINS]);
  assert.equal(options.allowedOrigins.includes("*"), false);
  assert.equal(options.allowNullOrigin, true);
  assert.equal(options.maxDocumentCharacters, 1024 * 1024);
  assert.equal(options.maxDocumentsPerClient, 128);
  assert.equal(options.maxClientDocumentCharacters, 64 * 1024 * 1024);
  assert.equal(options.maxLinesPerRequest, 0);
  assert.equal(options.maxPayload, undefined, "maxPayload keeps the NSH default");
  assert.equal(options.maxStateDepth, undefined, "maxStateDepth keeps the NSH default");
  assert.equal(options.maxClients, undefined, "maxClients keeps the NSH default");
  assert.equal(options.maxRequestsPerSecond, undefined, "rate limit keeps the NSH default");
});

test("NSH accepts only local renderer origins", { timeout: 20_000 }, async () => {
  const server = new NSHServer(createNSHServerOptions());
  const port = await server.start();
  const accepted = [];
  try {
    for (const origin of [
      "file://",
      "null",
      "http://127.0.0.1:5173",
      "http://localhost:5173",
      undefined,
    ]) {
      accepted.push(await expectAccepted(port, origin));
    }
    const rejected = await expectRejected(port, "http://evil.example");
    assert.match(rejected, /403/);
  } finally {
    for (const socket of accepted) socket.terminate();
    await server.stop();
  }
});

test("NSH quotas cover many open tabs and large incremental updates", { timeout: 30_000 }, async () => {
  const server = new NSHServer(createNSHServerOptions());
  const port = await server.start();
  const socket = createClient(port, "http://127.0.0.1:5173");
  const pending = new Map();
  let nextId = 0;
  socket.on("message", (data) => {
    const response = JSON.parse(data);
    const resolve = pending.get(response.id);
    if (resolve) {
      pending.delete(response.id);
      resolve(response);
    }
  });
  const request = (requestType, args = {}) => new Promise((resolve) => {
    const id = String(++nextId);
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, requestType, ...args }));
  });
  try {
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    for (let index = 0; index < 40; index += 1) {
      const opened = await request("openDocument", {
        documentId: `tab-${index}`,
        language: "javascript",
        code: `const value${index} = ${index};`,
      });
      assert.equal(opened.success, true, opened.error);
    }

    const longCode = Array.from({ length: 6_000 }, (_, index) =>
      `const line${index} = ${index};`).join("\n");
    const longDocument = await request("openDocument", {
      documentId: "long-document",
      language: "javascript",
      code: longCode,
    });
    assert.equal(longDocument.success, true, longDocument.error);
    const lines = await request("getDocumentLines", {
      documentId: "long-document",
      startLine: 0,
      endLine: 6_000,
    });
    assert.equal(lines.success, true, lines.error);
    assert.equal(lines.lines.length, 6_000);

    const updated = await request("updateDocument", {
      documentId: "long-document",
      startLine: 3_000,
      deletedLines: 0,
      insertedLines: Array.from({ length: 5_500 }, (_, index) => `let added${index} = 1;`),
    });
    assert.equal(updated.success, true, updated.error);

    const oneMiB = await request("openDocument", {
      documentId: "large-document",
      language: "javascript",
      code: "x".repeat(1024 * 1024),
    });
    assert.equal(oneMiB.success, true, oneMiB.error);
  } finally {
    socket.terminate();
    await server.stop();
  }
});

test("Markdown fence hints resolve to supported NSH languages", async () => {
  const MarkdownRenderer = loadGlobal(
    "src/js/addon/MarkdownRenderer.js",
    "MarkdownRenderer",
  );
  const renderer = Object.create(MarkdownRenderer.prototype);
  renderer.detectedLanguages = new Map();
  const supported = new Set(Highlighter.getSupportedLanguages());
  const controller = {
    detectLanguage: async (fileName) => {
      const extension = `.${fileName.split(".").pop()}`;
      return Highlighter.detectLanguage(extension) || "plaintext";
    },
  };
  const expected = {
    js: "javascript",
    ts: "typescript",
    py: "python",
    sh: "bash",
    shell: "bash",
    "c++": "cpp",
    html: "html",
    css: "css",
    json: "json",
    scss: "scss",
    sass: "sass",
    md: "markdown",
    jsx: "jsx",
    tsx: "tsx",
    sql: "sql",
    rust: "rust",
    go: "go",
  };
  for (const [hint, language] of Object.entries(expected)) {
    assert.equal(
      await renderer.resolveCodeLanguage(controller, hint, supported),
      language,
      hint,
    );
  }
});

test("NSH rejects documents beyond the default lexical state depth", { timeout: 20_000 }, async () => {
  const server = new NSHServer(createNSHServerOptions());
  const port = await server.start();
  const socket = createClient(port, "file://");
  const pending = new Map();
  let nextId = 0;
  socket.on("message", (data) => {
    const response = JSON.parse(data);
    const resolve = pending.get(response.id);
    if (resolve) {
      pending.delete(response.id);
      resolve(response);
    }
  });
  const request = (requestType, args = {}) => new Promise((resolve) => {
    const id = String(++nextId);
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, requestType, ...args }));
  });
  try {
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const shallow = await request("openDocument", {
      documentId: "shallow",
      language: "css",
      code: "a { b { c { color: red; } } }",
    });
    assert.equal(shallow.success, true, shallow.error);

    const deep = await request("openDocument", {
      documentId: "deep",
      language: "css",
      code: Array.from({ length: 200 }, () => "{").join("\n"),
    });
    assert.equal(deep.success, false);
    assert.match(deep.error, /state depth/i);
  } finally {
    socket.terminate();
    await server.stop();
  }
});

test("real NSH token classes keep theme colors", { timeout: 20_000 }, async () => {
  const root = path.resolve(__dirname, "..");
  const themeClasses = new Set();
  for (const theme of ["dark", "light"]) {
    const css = fs.readFileSync(path.join(root, "src/css/nsh", `${theme}.css`), "utf8");
    for (const match of css.matchAll(/\.(nsh-[a-z-]+)/g)) themeClasses.add(match[1]);
  }
  const server = new NSHServer(createNSHServerOptions());
  const port = await server.start();
  const socket = createClient(port, "file://");
  const pending = new Map();
  let nextId = 0;
  socket.on("message", (data) => {
    const response = JSON.parse(data);
    const resolve = pending.get(response.id);
    if (resolve) {
      pending.delete(response.id);
      resolve(response);
    }
  });
  const request = (requestType, args = {}) => new Promise((resolve) => {
    const id = String(++nextId);
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, requestType, ...args }));
  });
  try {
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const samples = {
      javascript: 'const value = "hello"; // comment',
      typescript: "interface User { name: string; }",
      jsx: 'const view = <div className="box">{value}</div>;',
      tsx: "const view: JSX.Element = <Panel value={1} />;",
      markdown: "# Title\n\n- item\n\n`code`",
      bash: 'for file in *.txt; do echo "$file"; done',
      sql: "SELECT id, name FROM users WHERE id = 1;",
      rust: "fn main() { let value: i32 = 1; }",
      go: "package main\nfunc main() { var value int = 1 }",
      scss: "$color: red;\n.box { color: $color; }",
      sass: ".box\n  color: red",
      csv: "name,age\nAda,36",
      html: '<!DOCTYPE html><div class="box" id="x">Hello</div>',
      css: ".box { color: red; margin: 10px; }",
      php: '<?php $value = "hello"; echo $value; ?>',
    };
    for (const [language, code] of Object.entries(samples)) {
      const response = await request("highlight", {
        language,
        code,
        responseType: "tokens",
      });
      assert.equal(response.success, true, response.error);
      assert.ok(response.tokens.length > 0, `${language} produced tokens`);
      for (const token of response.tokens) {
        if (!token.className) continue;
        assert.ok(
          themeClasses.has(token.className),
          `${language} token ${token.className} has a theme rule`,
        );
        assert.doesNotMatch(token.className, /nsh-(tag|attribute|control|builtin|regex)$/);
      }
    }
  } finally {
    socket.terminate();
    await server.stop();
  }
});
