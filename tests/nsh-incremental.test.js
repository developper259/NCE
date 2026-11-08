const test = require("node:test");
const assert = require("node:assert/strict");
const { Tokenizer, IncrementalDocument, CSV } = require("nsh");

function createCsvDocument(lineCount = 10000) {
  const code = Array.from({ length: lineCount }, (_, index) =>
    `name${index},value${index}`).join("\n");
  return new IncrementalDocument(new Tokenizer(new CSV()), code);
}

test("CSV line insertion and deletion retokenize the suffix with bounded latency", () => {
  const insertedDocument = createCsvDocument();
  let started = performance.now();
  const inserted = insertedDocument.updateLines(5000, 0, ["new,row"]);
  const insertedMs = performance.now() - started;
  assert.equal(inserted.retokenizedLines, 5001);
  assert.equal(inserted.changedStartLine, 5000);
  assert.equal(inserted.changedEndLine, 10001);
  assert.ok(insertedMs < 750, `CSV insertion took ${insertedMs.toFixed(1)} ms`);

  const deletedDocument = createCsvDocument();
  started = performance.now();
  const deleted = deletedDocument.updateLines(3000, 1, []);
  const deletedMs = performance.now() - started;
  assert.equal(deleted.retokenizedLines, 6999);
  assert.equal(deleted.changedStartLine, 3000);
  assert.equal(deleted.changedEndLine, 9999);
  assert.ok(deletedMs < 750, `CSV deletion took ${deletedMs.toFixed(1)} ms`);

  const replacedDocument = createCsvDocument();
  started = performance.now();
  const replaced = replacedDocument.updateLines(10, 1, ["changed,row"]);
  const replacedMs = performance.now() - started;
  assert.equal(replaced.retokenizedLines, 2);
  assert.equal(replaced.changedStartLine, 10);
  assert.equal(replaced.changedEndLine, 11);
  assert.ok(replacedMs < 250, `CSV replacement took ${replacedMs.toFixed(1)} ms`);
});
