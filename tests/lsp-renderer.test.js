const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadGlobal } = require("./helpers/runtime");

const LspPositions = loadGlobal("src/js/lsp/LspPositions.js", "LspPositions");

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeFile(text, { finalNewline = true } = {}) {
  const lines = text.split("\n");
  if (finalNewline && lines[lines.length - 1] === "") lines.pop();
  return {
    lines: lines.map((value) => ({ getText: () => value })),
    hasFinalNewline: finalNewline,
  };
}

test("document text matches the edited buffer and exposes LSP positions", () => {
  assert.equal(LspPositions.documentText(makeFile("a\nb")), "a\nb\n");
  assert.equal(LspPositions.documentText(makeFile("a\nb", { finalNewline: false })), "a\nb");
  assert.deepEqual(plain(LspPositions.position(3, 2)), { line: 2, character: 2 });
  assert.deepEqual(plain(LspPositions.range({ row: 1, column: 0 }, { row: 2, column: 3 })), {
    start: { line: 0, character: 0 },
    end: { line: 1, character: 3 },
  });
  assert.deepEqual(
    plain(LspPositions.editorRange({
      start: { line: 1, character: 4 },
      end: { line: 9, character: 2 },
    }, 3)),
    {
      start: { row: 2, column: 4 },
      end: { row: 3, column: 2 },
    },
  );
});

test("edit payloads produce minimal incremental changes", () => {
  const file = makeFile("const value = 1;\nnext");
  assert.deepEqual(plain(LspPositions.changeForEdit(file, {
    beforeRow: 1,
    beforeColumn: 6,
    beforeText: "value",
    afterText: "answer",
  })), [{
    range: {
      start: { line: 0, character: 6 },
      end: { line: 0, character: 11 },
    },
    text: "answer",
  }]);

  assert.deepEqual(plain(LspPositions.changeForEdit(file, {
    beforeRow: 1,
    beforeColumn: 0,
    beforeText: "a\nb\nc",
    afterText: "x",
  })), [{
    range: {
      start: { line: 0, character: 0 },
      end: { line: 2, character: 1 },
    },
    text: "x",
  }]);

  assert.deepEqual(plain(LspPositions.changeForEdit(file, {
    batch: true,
    beforeText: "ignored",
    afterText: "ignored",
  })), [{ text: "const value = 1;\nnext\n" }]);
});

test("word ranges respect Unicode letters and punctuation", () => {
  assert.deepEqual(plain(LspPositions.wordRangeAt("const café = 1", 9)), {
    start: 6,
    end: 10,
    text: "café",
  });
  assert.equal(LspPositions.isWordCharacter("é"), true);
  assert.equal(LspPositions.isWordCharacter("."), false);
  assert.deepEqual(plain(LspPositions.wordRangeAt("value.", 4)), {
    start: 0,
    end: 5,
    text: "value",
  });
});

test("renderer bundles and preload expose the LSP integration", () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "src/js/main/renderer-scripts.json"),
    "utf8",
  ));
  for (const script of [
    "js/lsp/LspPositions.js",
    "js/lsp/LspPopover.js",
    "js/lsp/LspCompletionWidget.js",
    "js/lsp/ProblemsPanel.js",
    "js/lsp/LspController.js",
  ]) {
    assert.ok(manifest.includes(script), `${script} is bundled`);
    assert.ok(
      manifest.indexOf(script) < manifest.indexOf("js/main/Editor.js"),
      `${script} loads before the editor`,
    );
  }
  const preload = fs.readFileSync(
    path.join(__dirname, "..", "src/js/main/Preload.js"),
    "utf8",
  );
  for (const channel of [
    "Lsp:status", "Lsp:openDocument", "Lsp:changeDocument", "Lsp:saveDocument",
    "Lsp:closeDocument", "Lsp:completion", "Lsp:hover", "Lsp:definition",
    "Lsp:references", "Lsp:rename", "Lsp:codeActions", "Lsp:format",
    "Lsp:documentSymbols", "Lsp:workspaceSymbols", "Lsp:signatureHelp",
    "Lsp:restartServer", "Lsp:resolveCompletion",
  ]) assert.match(preload, new RegExp(`"${channel}"`), `preload exposes ${channel}`);
  assert.match(preload, /ipcRenderer\.removeListener\("Lsp:diagnostics"/);
  assert.match(preload, /ipcRenderer\.removeListener\("Lsp:status"/);
  const editor = fs.readFileSync(
    path.join(__dirname, "..", "src/js/main/Editor.js"),
    "utf8",
  );
  assert.match(editor, /new LspController\(this\)/);
  assert.match(editor, /lspController\?\.destroy/);
  const lineController = fs.readFileSync(
    path.join(__dirname, "..", "src/js/controller/LineController.js"),
    "utf8",
  );
  assert.match(lineController, /diagnosticsOutputFast/);
  assert.match(lineController, /refreshDiagnosticsOverlay/);
});
