const serverId = process.argv[2] || "fake-server";
const mode = process.argv[3] || "normal";
const documents = new Map();
let lastDocumentUri = null;
let clientResponses = {};
let input = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function range(line = 0, endLine = 0) {
  return {
    start: { line, character: 0 },
    end: { line: endLine, character: 5 },
  };
}

function capabilities() {
  return {
    textDocumentSync: { openClose: true, change: 2, save: { includeText: true } },
    completionProvider: { triggerCharacters: ["."], resolveProvider: true },
    hoverProvider: true,
    definitionProvider: true,
    declarationProvider: true,
    implementationProvider: true,
    typeDefinitionProvider: true,
    referencesProvider: true,
    renameProvider: { prepareProvider: true },
    codeActionProvider: true,
    documentFormattingProvider: true,
    documentRangeFormattingProvider: true,
    documentSymbolProvider: true,
    workspaceSymbolProvider: true,
    signatureHelpProvider: { triggerCharacters: ["("] },
  };
}

function applyChange(text, change) {
  if (!change.range) return change.text;
  const lines = text.split("\n");
  const offsetAt = (position) => {
    let offset = 0;
    for (let index = 0; index < position.line && index < lines.length; index += 1)
      offset += lines[index].length + 1;
    return offset + Math.min(position.character, lines[position.line]?.length || 0);
  };
  const start = offsetAt(change.range.start);
  const end = offsetAt(change.range.end);
  return text.slice(0, start) + change.text + text.slice(end);
}

function documentParams(uri) {
  return documents.get(uri) || { uri, text: "", version: 1 };
}

function publishDiagnostics(uri, version, empty = false) {
  const document = documentParams(uri);
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri,
      version,
      diagnostics: empty ? [] : [{
        range: range(0),
        severity: serverId.includes("second") ? 2 : 1,
        source: serverId,
        message: `${serverId} diagnostic for version ${version}`,
        code: `${serverId}-code`,
      }],
    },
  });
  return document;
}

function workspaceEdit(uri, newName) {
  const document = documentParams(uri);
  const changes = {};
  changes[uri] = [{
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    newText: `${newName}-${serverId}\n`,
  }];
  if (mode === "outside") {
    changes["file:///etc/passwd"] = [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      newText: "outside\n",
    }];
  }
  return changes;
}

function handleRequest(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    if (mode === "init-failure") {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: "initialize refused" } });
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      result: {
        serverInfo: { name: serverId, version: "1.0.0" },
        capabilities: capabilities(),
      },
    });
    if (mode === "server-request") {
      send({
        jsonrpc: "2.0",
        id: "server-question",
        method: "workspace/configuration",
        params: { items: [{ section: serverId }] },
      });
      send({
        jsonrpc: "2.0",
        id: "server-unknown",
        method: "fake/unsupported",
        params: {},
      });
    }
    return;
  }
  if (method === "shutdown") {
    send({ jsonrpc: "2.0", id, result: null });
    return;
  }
  if (method === "textDocument/completion") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        isIncomplete: false,
        items: [
          { label: `${serverId}-item`, kind: 3, detail: serverId },
          { label: "shared-item", kind: 3, detail: "shared" },
        ],
      },
    });
    return;
  }
  if (method === "completionItem/resolve") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        ...params,
        detail: `${serverId}-resolved`,
        documentation: { kind: "markdown", value: `${serverId} resolved documentation` },
      },
    });
    return;
  }
  if (method === "textDocument/hover") {
    const document = documentParams(params.textDocument.uri);
    send({
      jsonrpc: "2.0",
      id,
      result: {
        contents: {
          kind: "markdown",
          value: `**${serverId}** hover v${document.version} len${document.text.length} cfg=${JSON.stringify(clientResponses)}`,
        },
      },
    });
    return;
  }
  if (method === "textDocument/definition") {
    send({
      jsonrpc: "2.0",
      id,
      result: [{ uri: params.textDocument.uri, range: range(1) }],
    });
    return;
  }
  if (method === "textDocument/declaration" || method === "textDocument/implementation" ||
      method === "textDocument/typeDefinition") {
    send({
      jsonrpc: "2.0",
      id,
      result: [{ uri: params.textDocument.uri, range: range(2) }],
    });
    return;
  }
  if (method === "textDocument/references") {
    send({
      jsonrpc: "2.0",
      id,
      result: [
        { uri: params.textDocument.uri, range: range(1) },
        { uri: params.textDocument.uri, range: range(2) },
      ],
    });
    return;
  }
  if (method === "textDocument/prepareRename") {
    send({ jsonrpc: "2.0", id, result: { range: range(0), placeholder: "symbol" } });
    return;
  }
  if (method === "textDocument/rename") {
    send({
      jsonrpc: "2.0",
      id,
      result: { changes: workspaceEdit(params.textDocument.uri, params.newName) },
    });
    return;
  }
  if (method === "textDocument/codeAction") {
    send({
      jsonrpc: "2.0",
      id,
      result: [
        {
          title: `${serverId} quick fix`,
          kind: "quickfix",
          isPreferred: true,
          edit: {
            changes: {
              [params.textDocument.uri]: [{
                range: range(0),
                newText: "",
              }],
            },
          },
        },
        {
          title: `${serverId} command action`,
          kind: "quickfix",
          command: { title: "Run", command: `${serverId}.command`, arguments: [] },
        },
      ],
    });
    return;
  }
  if (method === "workspace/executeCommand") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        changes: {
          [lastDocumentUri]: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: `command-${serverId}\n`,
          }],
        },
      },
    });
    return;
  }
  if (method === "textDocument/formatting") {
    send({
      jsonrpc: "2.0",
      id,
      result: [{
        range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
        newText: `formatted-${serverId}\n`,
      }],
    });
    return;
  }
  if (method === "textDocument/rangeFormatting") {
    send({
      jsonrpc: "2.0",
      id,
      result: [{
        range: params.range,
        newText: `range-${serverId}\n`,
      }],
    });
    return;
  }
  if (method === "textDocument/documentSymbol") {
    send({
      jsonrpc: "2.0",
      id,
      result: [{
        name: `${serverId}-symbol`,
        kind: 12,
        range: range(0, 2),
        selectionRange: range(0),
      }],
    });
    return;
  }
  if (method === "workspace/symbol") {
    send({
      jsonrpc: "2.0",
      id,
      result: [{
        name: `${serverId}-workspace-symbol`,
        kind: 12,
        location: { uri: lastDocumentUri, range: range(1) },
      }],
    });
    return;
  }
  if (method === "textDocument/signatureHelp") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        activeSignature: 0,
        activeParameter: 0,
        signatures: [{
          label: `${serverId}(value)`,
          parameters: [{ label: "value" }],
        }],
      },
    });
    return;
  }
  send({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Unsupported method ${method}` },
  });
}

function handleNotification(message) {
  const { method, params } = message;
  if (method === "exit") {
    process.exit(0);
    return;
  }
  if (method === "textDocument/didOpen") {
    const { uri, text, version } = params.textDocument;
    documents.set(uri, { uri, text, version });
    lastDocumentUri = uri;
    publishDiagnostics(uri, version);
    return;
  }
  if (method === "textDocument/didChange") {
    const document = documents.get(params.textDocument.uri);
    if (!document) return;
    for (const change of params.contentChanges) document.text = applyChange(document.text, change);
    document.version = params.textDocument.version;
    publishDiagnostics(document.uri, document.version);
    if (mode === "crash-on-change") process.exit(3);
    return;
  }
  if (method === "textDocument/didSave") {
    const document = documents.get(params.textDocument.uri);
    if (document && typeof params.text === "string") document.text = params.text;
    return;
  }
  if (method === "textDocument/didClose") {
    const uri = params.textDocument.uri;
    documents.delete(uri);
    publishDiagnostics(uri, null, true);
  }
}

function handleMessage(message) {
  if (message.method) {
    if (message.id !== undefined && message.id !== null) handleRequest(message);
    else handleNotification(message);
    return;
  }
  if (message.id === "server-question") {
    clientResponses.configuration = message.result;
    return;
  }
  if (message.id === "server-unknown") {
    clientResponses.unknown = message.error?.code;
  }
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (true) {
    const separator = input.indexOf("\r\n\r\n");
    if (separator < 0) return;
    let length = null;
    for (const line of input.subarray(0, separator).toString("ascii").split("\r\n")) {
      const match = /^content-length:\s*(\d+)$/i.exec(line);
      if (match) length = Number(match[1]);
    }
    if (length === null) process.exit(2);
    const start = separator + 4;
    if (input.length < start + length) return;
    const body = input.subarray(start, start + length).toString("utf8");
    input = input.subarray(start + length);
    try {
      handleMessage(JSON.parse(body));
    } catch (error) {
      process.stderr.write(`fake-lsp parse error: ${String(error)}\n`);
    }
  }
});

if (mode === "exit-after-init") {
  setTimeout(() => process.exit(4), 300);
}

process.on("SIGTERM", () => process.exit(0));
