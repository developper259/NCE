const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGlobal, createEditor } = require('./helpers/runtime');
const LineNode = loadGlobal('src/js/types/Line.js', 'LineNode');
const FileNode = loadGlobal('src/js/types/Tab.js', 'FileNode', { LineNode });
const Writer = loadGlobal('src/js/controller/WriterController.js', 'WriterController', { LineNode, Events: { ON_CHANGE: 'change' } });
const History = loadGlobal('src/js/controller/HistoryController.js', 'HistoryController');
function setup(content) {
  const { editor } = createEditor();
  const file = new FileNode(editor, 1, 'a.js', '');
  const lines = content.split(/\r?\n/);
  file.hasFinalNewline = /\n$/.test(content);
  if (file.hasFinalNewline) lines.pop();
  file.lines = lines.map(s => new LineNode(s)); file.row = 1;
  file.eol = content.includes('\r\n') ? '\r\n' : '\n';
  file.lineEndings = [...content.matchAll(/\r\n|\n/g)].map(m => m[0]);
  editor.tabManager.activeFile = file;
  editor.writerController = new Writer(editor); editor.historyController = new History(editor);
  return { editor, file };
}
for (const content of ['abc', 'abc\n', 'abc\r\n', 'abc\n\n', 'abc\r\n\r\n', 'éàçù\r\n你好\n日本語\r\n😀🚀']) {
  for (const insertion of ['X', '\n', 'paste\nnext']) {
    test(`byte fidelity and undo/redo: ${JSON.stringify(content)} + ${JSON.stringify(insertion)}`, async () => {
      const { editor, file } = setup(content);
      assert.equal(file.serializeContent(), content);
      editor.writerController.applyRangeEdit({ row: 1, column: 1 }, { row: 1, column: 1 }, insertion);
      const expected = content.slice(0,1) + insertion.replace(/\n/g, file.eol) + content.slice(1);
      assert.equal(file.serializeContent(), expected);
      await editor.historyController.undo(); assert.equal(file.serializeContent(), content);
      await editor.historyController.redo(); assert.equal(file.serializeContent(), expected);
    });
  }
}
for (const replacement of ['', 'new\nlines', 'one\ntwo\nthree']) {
  test(`mixed EOL multiline replacement ${JSON.stringify(replacement)}`, async () => {
    const { editor, file } = setup('line1\r\nline2\nline3\r\n');
    editor.writerController.applyRangeEdit({ row: 1, column: 2 }, { row: 2, column: 3 }, replacement);
    assert.equal(file.serializeContent(), 'li' + replacement.replace(/\n/g, '\r\n') + 'e2\nline3\r\n');
    await editor.historyController.undo(); assert.equal(file.serializeContent(), 'line1\r\nline2\nline3\r\n');
    await editor.historyController.redo(); assert.equal(file.lineEndings.at(-1), '\r\n');
  });
}

test('50000 lines: typing and display access do not traverse the full document', () => {
  const { editor, file } = setup(Array(50000).fill('const a = 1;').join('\n'));
  file.incrementalEligible = true; file.language = 'javascript'; file.getSyntaxMetrics();
  const Highlight = loadGlobal('src/js/controller/HighlightController.js', 'HighlightController', { NSHClient: class {} });
  const highlight = new Highlight(editor);
  highlight.getLogicalText = () => assert.fail('eligibility constructed full text');
  file.lines.map = () => assert.fail('full map on typing');
  file.lines.every = () => assert.fail('full scan on typing');
  editor.writerController.applyRangeEdit({ row: 25000, column: 2 }, { row: 25000, column: 2 }, 'X');
  assert.equal(highlight.canUseIncremental(file), true);
  const Controller = loadGlobal('src/js/controller/LineController.js', 'LineController');
  const controller = Object.create(Controller.prototype); controller.editor = editor;
  controller.getDisplayRows = () => assert.fail('full display rows');
  assert.equal(controller.getDisplayLineCount(), 50000);
  assert.equal(controller.getDisplayIndexForDocument(25000), 25000);
  assert.equal(controller.getDisplayRow(24999).text, 'coXnst a = 1;');
});

test('incremental thresholds include exact limits and update affected-line metrics', () => {
  const { editor, file } = setup('a'.repeat(1000));
  const Highlight = loadGlobal('src/js/controller/HighlightController.js', 'HighlightController', { NSHClient: class {} });
  const h = new Highlight(editor); file.incrementalEligible = true; file.language = 'javascript';
  assert.equal(h.canUseIncremental(file), true);
  editor.writerController.applyRangeEdit({ row: 1, column: 0 }, { row: 1, column: 0 }, 'b');
  assert.equal(h.canUseIncremental(file), false);
  editor.writerController.applyRangeEdit({ row: 1, column: 0 }, { row: 1, column: 1 }, '');
  assert.equal(h.canUseIncremental(file), true);
  file.syntaxMetrics = { logicalLength: 1024 * 1024, longLineCount: 0 };
  assert.equal(h.canUseIncremental(file), true);
  file.syntaxMetrics.logicalLength++; assert.equal(h.canUseIncremental(file), false);
});
