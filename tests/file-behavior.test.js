const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createEditor, loadGlobal } = require("./helpers/runtime");

const LineNode = loadGlobal("src/js/types/Line.js", "LineNode");
const FileNode = loadGlobal("src/js/types/Tab.js", "FileNode", { LineNode });

test("FileNode serializes LF, CRLF, and mixed EOL without byte drift", () => {
  const editor = { lineController: { loadContent() {} }, historyController: { clear() {} } };
  const file = new FileNode(editor, 1, "mixed.txt", "/tmp/mixed.txt");
  file.lines = [new LineNode("one"), new LineNode("two"), new LineNode("three")];
  file.lineEndings = ["\r\n", "\n", "\r\n"];
  file.eol = "\n";
  file.hasFinalNewline = true;
  assert.equal(file.serializeContent(), "one\r\ntwo\nthree\r\n");

  file.lineEndings = [];
  file.eol = "\r\n";
  assert.equal(file.serializeContent(), "one\r\ntwo\r\nthree\r\n");
});

test("FileNode preserves empty files and final-newline policy", () => {
  const file = new FileNode({}, 1, "empty.txt", "");
  file.lines = [new LineNode("")];
  assert.equal(file.serializeContent(), "");
  file.lines = [new LineNode("value")];
  file.hasFinalNewline = true;
  assert.equal(file.serializeContent(), "value\n");
});

test("LineNode clone and JSON roundtrip preserve editing metadata", () => {
  const line = new LineNode("const x = 1;");
  line.setTokens([{ type: "keyword", value: "const" }]);
  line.setState(["root"]);
  line.setHighlighted(true);
  line.diffSegments = [{ type: "added", text: "x" }];
  const clone = line.clone();
  const restored = LineNode.fromJSON(line.toJSON());
  assert.equal(clone.getText(), line.getText());
  assert.deepEqual(restored.getTokens(), line.getTokens());
  assert.deepEqual(restored.diffSegments, line.diffSegments);
  assert.equal(restored.isHighlight, true);
});

test("temporary file fixtures support UTF-8, binary, and invalid UTF-8 cases", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-tests-"));
  try {
    const textPath = path.join(directory, "unicode.txt");
    const binaryPath = path.join(directory, "binary.bin");
    const invalidPath = path.join(directory, "invalid.txt");
    await fsp.writeFile(textPath, "é 你好 😀\r\n", "utf8");
    await fsp.writeFile(binaryPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
    await fsp.writeFile(invalidPath, Buffer.from([0xc3, 0x28]));
    assert.equal((await fsp.readFile(textPath)).toString("utf8"), "é 你好 😀\r\n");
    assert.equal((await fsp.readFile(binaryPath))[0], 0x50);
    assert.throws(() => new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(invalidPath)));
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

test("FileManager and WorkspaceSearch source retain binary and ignored-directory guards", () => {
  const fileManager = fs.readFileSync(path.join(__dirname, "../src/ts/addon/FileManager.ts"), "utf8");
  const workspaceSearch = fs.readFileSync(path.join(__dirname, "../src/ts/addon/WorkspaceSearch.ts"), "utf8");
  assert.match(fileManager, /TextDecoder\("utf-8", \{ fatal: true \}\)/);
  assert.match(fileManager, /BINARY_FILE/);
  for (const ignored of ["node_modules", "dist", "coverage"]) assert.match(workspaceSearch, new RegExp(`\\"${ignored}\\"`));
});
