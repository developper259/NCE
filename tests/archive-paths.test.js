const assert = require("node:assert/strict");
const test = require("node:test");
const {
  normalizeArchivePath,
  toAsarLookupPath,
} = require("../scripts/archive-paths");

test("archive member paths normalize Windows, rooted POSIX and canonical input", () => {
  for (const [input, expected] of [
    ["\\dist\\renderer\\html\\index.html", "dist/renderer/html/index.html"],
    ["/dist/renderer/html/index.html", "dist/renderer/html/index.html"],
    ["dist/renderer/html/index.html", "dist/renderer/html/index.html"],
  ]) {
    assert.equal(normalizeArchivePath(input), expected);
  }
});

test("ASAR lookup paths adapt only the canonical archive path to the API separator", () => {
  const canonicalPath = "dist/renderer/html/index.html";

  assert.equal(
    toAsarLookupPath(canonicalPath, "\\"),
    "dist\\renderer\\html\\index.html",
  );
  assert.equal(toAsarLookupPath(canonicalPath, "/"), canonicalPath);
  assert.equal(normalizeArchivePath(canonicalPath), canonicalPath);
});
