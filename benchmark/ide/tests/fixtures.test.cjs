const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isInside } = require("../utils/files.cjs");
const { parseOptions, writeBytes, writeLines, writeLongLine, writeBinary, maximumLineLength } = require("../fixtures/generate-fixtures.cjs");

test("fixture profiles are explicit and reject unknown or unsafe profiles", () => {
  assert.equal(parseOptions(["--profile", "full", "--extreme"]).extreme, true);
  assert.throws(() => parseOptions(["--profile", "unbounded"]), /quick, standard or full/);
  assert.throws(() => parseOptions(["--delete", "C:\\"]), /Unknown option/);
});

test("generators write deterministic line, byte-size, and Unicode fixtures", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nce-benchmark-test-"));
  try {
    const lines = path.join(directory, "lines.txt");
    const bytes = path.join(directory, "bytes.txt");
    const unicode = path.join(directory, "unicode.txt");
    const binary = path.join(directory, "sample.bin");
    writeLines(lines, 12);
    writeBytes(bytes, 4097);
    writeLongLine(unicode, 20, { unicode: true });
    writeBinary(binary, 128);
    assert.equal(fs.readFileSync(lines, "utf8").split("\n").length - 1, 12);
    assert.equal(fs.statSync(bytes).size, 4097);
    assert.match(fs.readFileSync(unicode, "utf8"), /🙂/);
    assert.equal(fs.statSync(binary).size, 128);
    assert.notEqual(fs.readFileSync(binary)[0], 0x78);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("JavaScript fixture metadata covers the longest generated source line", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nce-js-fixture-"));
  try {
    const file = path.join(directory, "sample.js");
    writeLines(file, 1000, "javascript");
    const actual = fs.readFileSync(file, "utf8").split(/\r?\n/).reduce((max, line) => Math.max(max, line.length), 0);
    assert.equal(maximumLineLength("javascript"), actual);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("path containment permits generated children and rejects escapes", () => {
  const root = path.resolve(".benchmark-data", "ide", "fixtures");
  assert.equal(isInside(root, path.join(root, "files", "small.txt")), true);
  assert.equal(isInside(root, path.resolve(root, "..", "results")), false);
});
