const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

function loadTools() {
  return loadGlobal("src/js/core/Tools.js", "NCETextPosition", {
    SETTINGS_GET: () => 4,
  });
}

test("grapheme boundaries keep UTF-16 offsets legal", () => {
  const {
    getGraphemeBoundaries,
    normalizeTextBoundary,
    previousGraphemeBoundary,
    nextGraphemeBoundary,
  } = loadTools();

  assert.deepEqual(Array.from(getGraphemeBoundaries("A😀B")), [0, 1, 3, 4]);
  assert.deepEqual(Array.from(getGraphemeBoundaries("A👨‍👩‍👧‍👦B")), [0, 1, 12, 13]);
  assert.deepEqual(
    Array.from(getGraphemeBoundaries("e\u0301👍🏻🇫🇷")),
    [0, 2, 6, 10],
  );
  assert.equal(normalizeTextBoundary("A😀B", 2), 1);
  assert.equal(previousGraphemeBoundary("A😀B", 2), 1);
  assert.equal(nextGraphemeBoundary("A😀B", 2), 3);
});

test("visual-column conversion round-trips legal Unicode offsets and tabs", () => {
  const {
    getGraphemeBoundaries,
    realColumnToViewColumn,
    viewColumnToRealColumn,
  } = loadTools();
  for (const text of ["abc", "\tabc", "a😀b", "👍🏻", "A👨‍👩‍👧‍👦\tB", "e\u0301"]) {
    for (const offset of getGraphemeBoundaries(text)) {
      const viewColumn = realColumnToViewColumn(text, offset, 4);
      assert.equal(viewColumnToRealColumn(text, viewColumn, 4), offset, text);
    }
  }
});
