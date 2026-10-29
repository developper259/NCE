const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

const LineNode = loadGlobal("src/js/types/Line.js", "LineNode");
const LineDiff = loadGlobal("src/js/core/LineDiff.js", "LineDiff");
const NCEPath = {
  basename: (value) => String(value || "").replace(/\\/g, "/").split("/").pop(),
};
const FileNode = loadGlobal("src/js/types/Tab.js", "FileNode", {
  LineNode,
  NCEPath,
  SETTINGS_GET: () => 4,
});
const buildGitDiffBuffer = loadGlobal(
  "src/js/core/GitDiffBuffer.js",
  "buildGitDiffBuffer",
  { LineDiff, FileNode, LineNode, NCEPath },
);

function versions(oldContent, newContent, extra = {}) {
  return {
    success: true,
    oldContent,
    newContent,
    staged: false,
    untracked: false,
    deleted: false,
    binary: false,
    tooLarge: false,
    ...extra,
  };
}

async function build(payload, overrides = {}) {
  let detections = 0;
  const file = await buildGitDiffBuffer(
    {
      tabManager: { getNextID: () => 41 },
      highlightController: {
        async detectLanguage() {
          detections += 1;
          return "javascript";
        },
      },
    },
    {
      filePath: "/workspace/src/app.js",
      relativePath: "src/app.js",
      ...overrides,
      versions: payload,
    },
  );
  return { file, detections };
}

function types(rows) {
  return rows.map((row) => row.type).join(",");
}

function texts(rows) {
  return rows.map((row) => row.text);
}

test("LineDiff splits files into display lines across ending styles", () => {
  assert.equal(LineDiff.splitLines("").join("|"), "");
  assert.equal(LineDiff.splitLines("a").join("|"), "a");
  assert.equal(LineDiff.splitLines("a\n").join("|"), "a");
  assert.equal(LineDiff.splitLines("a\nb\n").join("|"), "a|b");
  assert.equal(LineDiff.splitLines("a\r\nb\r\n").join("|"), "a|b");
  assert.equal(LineDiff.splitLines("a\rb").join("|"), "a|b");
  assert.equal(LineDiff.splitLines("\n").join("|"), "");
  assert.equal(LineDiff.splitLines("a\n\n").join("|"), "a|");
});

test("LineDiff keeps identical files unchanged and deterministic", () => {
  const rows = LineDiff.buildRows("a\nb\n", "a\nb\n");
  assert.equal(types(rows), "unchanged,unchanged");
  assert.equal(texts(rows).join("|"), "a|b");
  assert.equal(rows.map((row) => row.documentIndex).join("|"), "0|1");
  assert.equal(
    JSON.stringify(rows.map((row) => [row.oldLineNumber, row.newLineNumber])),
    JSON.stringify([[1, 1], [2, 2]]),
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(LineDiff.buildRows("x\ny\nz\n", "x\nY\nz\n"))),
    JSON.parse(JSON.stringify(LineDiff.buildRows("x\ny\nz\n", "x\nY\nz\n"))),
  );
});

test("LineDiff reports a replaced line with both numbers", () => {
  const rows = LineDiff.buildRows("a\nb\nc\n", "a\nB\nc\n");
  assert.equal(types(rows), "unchanged,removed,added,unchanged");
  assert.equal(texts(rows).join("|"), "a|b|B|c");
  assert.equal(
    JSON.stringify(rows.map((row) => [row.oldLineNumber, row.newLineNumber, row.documentIndex])),
    JSON.stringify([[1, 1, 0], [2, null, null], [null, 2, 1], [3, 3, 2]]),
  );
});

test("LineDiff handles insertions, deletions, and repeated lines", () => {
  const inserted = LineDiff.buildRows("a\nc\n", "a\nb\nc\n");
  assert.equal(types(inserted), "unchanged,added,unchanged");
  assert.equal(texts(inserted).join("|"), "a|b|c");

  const deleted = LineDiff.buildRows("a\nb\nc\n", "a\nc\n");
  assert.equal(types(deleted), "unchanged,removed,unchanged");

  const repeated = LineDiff.buildRows("x\nx\nx\n", "x\nx\n");
  assert.equal(types(repeated), "unchanged,unchanged,removed");
  assert.equal(repeated[2].oldLineNumber, 3);
});

test("LineDiff keeps separated changes in order and preserves untouched context", () => {
  const rows = LineDiff.buildRows(
    "one\ntwo\nthree\nfour\nfive\n",
    "one\nTWO\nthree\nfour\nFIVE\n",
  );
  assert.equal(types(rows), "unchanged,removed,added,unchanged,unchanged,removed,added");
  assert.equal(texts(rows).join("|"), "one|two|TWO|three|four|five|FIVE");
});

test("LineDiff handles empty files, unicode, and CRLF", () => {
  assert.equal(types(LineDiff.buildRows("", "")), "");
  assert.equal(types(LineDiff.buildRows("", "first\n")), "added");
  assert.equal(types(LineDiff.buildRows("gone\n", "")), "removed");
  const crlf = LineDiff.buildRows("a\r\nb\r\n", "a\nb\nc\n");
  assert.equal(types(crlf), "unchanged,unchanged,added");
  const unicode = LineDiff.buildRows("héllo\n🙂\n", "héllo\n🙃\n");
  assert.equal(texts(unicode).join("|"), "héllo|🙂|🙃");
});

test("LineDiff falls back deterministically beyond the edit-distance limit", () => {
  const before = Array.from({ length: 2600 }, (_, index) => `before-${index}`);
  const after = Array.from({ length: 2600 }, (_, index) => `after-${index}`);
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const first = LineDiff.buildOperations(before, after);
    const second = LineDiff.buildOperations(before, after);
    assert.equal(first.length, before.length + after.length);
    assert.deepEqual(
      JSON.parse(JSON.stringify(first)),
      JSON.parse(JSON.stringify(second)),
    );
    assert.equal(first.filter((operation) => operation.type === "delete").length, 2600);
    assert.equal(first.filter((operation) => operation.type === "insert").length, 2600);
  } finally {
    console.warn = originalWarn;
  }
});

test("GitDiffBuffer builds a read-only file with merged context rows", async () => {
  const { file, detections } = await build(versions("a\nb\nc\n", "a\nB\nc\n"));
  assert.equal(file.isDiffView, true);
  assert.equal(file.path, null);
  assert.equal(file.name, "app.js");
  assert.equal(file.isLoaded, true);
  assert.equal(file.isSaved, true);
  assert.equal(file.language, "javascript");
  assert.equal(detections, 1);
  assert.equal(file.lines.map((line) => line.getText()).join("|"), "a|B|c");
  assert.equal(file.diffRows.length, 4);
  assert.equal(file.totalLines, 3);
  assert.equal(file.row, 2);
  assert.equal(file.column, 0);
  assert.equal(file.diffActive, false);
  assert.equal(file.diffSnapshot, null);
});

test("GitDiffBuffer renders untracked and deleted files with explicit rows", async () => {
  const untracked = await build(versions("", "new\nfile\n", { untracked: true }));
  assert.equal(types(untracked.file.diffRows), "added,added");
  assert.equal(untracked.file.lines.map((line) => line.getText()).join("|"), "new|file");

  const deleted = await build(versions("old\ncontent\n", "", { deleted: true }));
  assert.equal(types(deleted.file.diffRows), "removed,removed");
  assert.equal(deleted.file.diffRows.every((row) => row.documentIndex === null), true);
  assert.equal(deleted.file.lines.length, 1, "the editor still needs a line buffer");
});

test("GitDiffBuffer reports no-change, binary, oversized, and failed versions", async () => {
  const identical = await build(versions("a\nb\n", "a\nb\n"));
  assert.equal(identical.file.loadError.code, "GIT_DIFF_EMPTY");
  assert.equal(identical.file.diffRows.length, 0);

  const finalNewline = await build(versions("a\n", "a"));
  assert.equal(finalNewline.file.loadError.code, "GIT_DIFF_EMPTY");

  const binary = await build(versions("", "", { binary: true }));
  assert.equal(binary.file.loadError.code, "BINARY_FILE");

  const tooLarge = await build(versions("", "", { tooLarge: true }));
  assert.equal(tooLarge.file.loadError.code, "FILE_TOO_LARGE");

  const failed = await build({ success: false, code: "GIT_COMMAND_FAILED", error: "boom" });
  assert.equal(failed.file.loadError.code, "GIT_DIFF_ERROR");
  assert.equal(failed.file.diffRows.length, 0);
  assert.equal(failed.file.lines.map((line) => line.getText()).join("|"), "");
});

test("GitDiffBuffer preserves syntax-neutral file content without Git headers", async () => {
  const oldContent = "const value = 1;\nconsole.log(value);\n";
  const newContent = "const value = 2;\nconsole.log(value);\n";
  const { file } = await build(versions(oldContent, newContent));
  const rendered = file.diffRows.map((row) => row.text).join("\n");
  assert.doesNotMatch(rendered, /^diff --git/m);
  assert.doesNotMatch(rendered, /^index /m);
  assert.doesNotMatch(rendered, /^@@/m);
  assert.doesNotMatch(rendered, /^\+\+\+ /m);
  assert.match(rendered, /const value = 1;/);
  assert.match(rendered, /const value = 2;/);
});
