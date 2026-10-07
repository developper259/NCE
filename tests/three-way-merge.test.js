const test = require("node:test");
const assert = require("node:assert/strict");
const { loadGlobal } = require("./helpers/runtime");

const ThreeWayTextMerge = loadGlobal(
  "src/js/core/ThreeWayMerge.js",
  "ThreeWayTextMerge",
  { TextEncoder },
);

test("three-way merge keeps local-only and disk-only edits", () => {
  const localOnly = ThreeWayTextMerge.merge("a\nb\nc", "A\nb\nc", "a\nb\nc");
  assert.equal(localOnly.ok, true);
  assert.equal(localOnly.content, "A\nb\nc");
  assert.equal(localOnly.conflicts, 0);

  const diskOnly = ThreeWayTextMerge.merge("a\nb\nc", "a\nb\nc", "a\nB\nc");
  assert.equal(diskOnly.ok, true);
  assert.equal(diskOnly.content, "a\nB\nc");
  assert.equal(diskOnly.conflicts, 0);
});

test("three-way merge combines non-overlapping changes, inserts and deletes", () => {
  const result = ThreeWayTextMerge.merge(
    "one\ntwo\nthree\nfour",
    "ONE\ntwo\nthree\nfour\nlocal tail",
    "one\ntwo\nTHREE",
  );
  assert.equal(result.ok, true);
  assert.equal(result.conflicts, 0);
  assert.equal(result.content, "ONE\ntwo\nTHREE\nlocal tail");
});

test("overlapping edits and same-position insertions preserve both sides with markers", () => {
  const overlap = ThreeWayTextMerge.merge("before\nbase\nafter", "before\nlocal\nafter", "before\ndisk\nafter");
  assert.equal(overlap.ok, true);
  assert.equal(overlap.conflicts, 1);
  assert.match(overlap.content, /<<<<<<< LOCAL\nlocal\n=======\ndisk\n>>>>>>> DISK/);

  const insertion = ThreeWayTextMerge.merge("", "local", "disk");
  assert.equal(insertion.ok, true);
  assert.equal(insertion.conflicts, 1);
  assert.match(insertion.content, /local[\s\S]*disk/);
});

test("merge preserves CRLF, mixed source endings, final newline and Unicode", () => {
  const result = ThreeWayTextMerge.merge(
    "café\r\n東京\r\nlast\r\n",
    "CAFÉ\r\n東京\r\nlast\r\n",
    "café\r\n東京\r\nfin\r\n",
  );
  assert.equal(result.ok, true);
  assert.equal(result.content, "CAFÉ\r\n東京\r\nfin\r\n");

  const noFinalNewline = ThreeWayTextMerge.merge("a\nb", "A\nb", "a\nB");
  assert.equal(noFinalNewline.ok, true);
  assert.equal(noFinalNewline.content, "A\nB");

  const mixed = ThreeWayTextMerge.merge(
    "a\r\nb\nc\r\n",
    "A\r\nb\nc\r\n",
    "a\r\nB\nc\r\n",
  );
  assert.equal(mixed.ok, true);
  assert.equal(mixed.content, "A\r\nB\nc\r\n");
});

test("merge refuses oversized, over-line-limit and excessively complex inputs", () => {
  assert.equal(ThreeWayTextMerge.merge("aa", "b", "c", { maxBytes: 1 }).reason, "file-too-large");
  assert.equal(ThreeWayTextMerge.merge("a\nb", "a\nb", "a\nb", { maxLines: 1 }).reason, "too-many-lines");
  assert.equal(ThreeWayTextMerge.merge("aa", "aa", "aa", { maxLineLength: 1 }).reason, "line-too-long");
  assert.equal(ThreeWayTextMerge.merge("a\nb\nc", "x\ny\nz", "a\nb\nc", { maxEditDistance: 1 }).reason, "diff-too-complex");
});
