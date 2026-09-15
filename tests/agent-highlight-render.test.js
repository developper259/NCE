const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGlobal, createEditor } = require('./helpers/runtime');

const LineNode = loadGlobal('src/js/types/Line.js', 'LineNode');
function node(tag = '') {
  return {
    tag, children: [], className: '', dataset: {}, style: {}, textContent: '',
    classList: { add(...classes) { this.owner.className += ` ${classes.join(' ')}`; } },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = children; },
  };
}
const document = {
  createElement(tag) { const result = node(tag); result.classList.owner = result; return result; },
  createDocumentFragment() { return node('fragment'); },
  createTextNode(text) { const result = node('text'); result.textContent = text; return result; },
};
const Writer = loadGlobal('src/js/controller/WriterController.js', 'WriterController', {
  document, expandTabsForDisplay: (text) => text, LineNode, Events: { ON_CHANGE: 'change' },
});
const LineController = loadGlobal('src/js/controller/LineController.js', 'LineController', {
  OutputScroller: class {}, SETTINGS_GET: () => 4,
});
function walk(root) { return [root, ...root.children.flatMap(walk)]; }
function classes(root) { return walk(root).map((item) => item.className).join(' '); }
function text(root) { return root.textContent + root.children.map(text).join(''); }

const htmlTokens = (value, line = 1) => [
  { line, column: 2, value: 'div', className: 'tag' },
  { line, column: value.indexOf('id') + 1, value: 'id', className: 'attribute' },
  { line, column: value.indexOf('"') + 1, value: value.match(/"[^"]*"/)[0], className: 'string' },
];

test('tokens without diff keep the original token DOM shape', () => {
  const writer = new Writer({});
  const rendered = writer.textToOBJ('<div id="game-board"></div>', htmlTokens('<div id="game-board"></div>'));
  assert.match(classes(rendered), /nsh-tag/);
  assert.doesNotMatch(classes(rendered), /diff-segment/);
  assert.equal(rendered.children[0].children[1].className, 'token editor-select nsh-tag');
});

test('inline diff and syntax tokens compose across different character boundaries', () => {
  const writer = new Writer({});
  const value = '<div id="game-board"></div>';
  const rendered = writer.textToOBJ(value, htmlTokens(value), [
    { text: '<di', type: 'added' },
    { text: 'v id="game-board"></div>', type: 'modified' },
  ]);
  assert.equal(text(rendered), value);
  assert.match(classes(rendered), /diff-added/);
  assert.match(classes(rendered), /diff-modified/);
  assert.match(classes(rendered), /nsh-tag/);
  assert.match(classes(rendered), /nsh-attribute/);
  assert.match(classes(rendered), /nsh-string/);
  assert.equal(walk(rendered).filter((item) => /nsh-tag/.test(item.className)).length, 2);
});

test('removed history row uses its own text and never current document tokens', () => {
  const value = '<div id="old"></div>';
  const file = { lines: [new LineNode('<div id="new"></div>')], diffRows: [
    { type: 'removed', text: value, documentIndex: null },
    { type: 'added', text: '<div id="new"></div>', documentIndex: 0 },
  ] };
  file.lines[0].setTokens(htmlTokens(file.lines[0].getText()));
  const editor = { tabManager: { activeFile: file }, writerController: new Writer({}) };
  const lines = Object.create(LineController.prototype);
  lines.editor = editor;
  lines.startIndex = 0;
  lines.getLineTop = () => 0;
  lines.getVisibleTokens = LineController.prototype.getVisibleTokens;
  const rendered = lines.createLineOBJ({ text: value, startChar: 0 }, 0);
  assert.equal(text(rendered), value);
  assert.match(classes(rendered), /line-removed/);
  assert.match(classes(rendered), /diff-removed/);
  assert.doesNotMatch(classes(rendered), /nsh-/);
});

test('visible inline diff projection keeps token and diff alignment during horizontal scroll', () => {
  const value = '<div id="game-board"></div>';
  const line = new LineNode(value);
  line.setTokens(htmlTokens(value));
  line.diffSegments = [{ type: 'added', text: '<div id="' }, { type: 'modified', text: 'game-board"></div>' }];
  const file = { lines: [line] };
  const editor = { tabManager: { activeFile: file }, writerController: new Writer({}) };
  const lines = Object.create(LineController.prototype);
  lines.editor = editor;
  lines.startIndex = 0;
  lines.getLineTop = () => 0;
  const rendered = lines.createLineOBJ({ text: value.slice(4, 17), startChar: 4 }, 0);
  assert.equal(text(rendered), value.slice(4, 17));
  assert.match(classes(rendered), /nsh-attribute/);
  assert.match(classes(rendered), /diff-modified/);
});

test('Agent replacement sends incremental NSH update and renders fresh tokens with row diff', async () => {
  const before = '<div id="game-container"></div>';
  const after = '<div id="game-board"></div>';
  const { editor, file } = createEditor(before);
  file.language = 'html';
  file.incrementalEligible = true;
  file.getSyntaxMetrics = () => ({ logicalLength: after.length, longLineCount: 0 });
  file.setIsSaved = () => {};
  editor.writerController = new Writer(editor);
  const calls = [];
  class Client { async request(type, data) {
    calls.push({ type, data });
    if (type === 'updateDocument') return { changedStartLine: 0, lines: [
      { text: after, tokens: htmlTokens(after), stateAfter: ['root'] },
    ] };
    return {};
  } }
  const Highlight = loadGlobal('src/js/controller/HighlightController.js', 'HighlightController', { NSHClient: Client });
  const h = new Highlight(editor);
  editor.highlightController = h;
  h.documentModes.set(file.id, 'incremental');
  h.documentEpochs.set(file.id, 0);
  h.applyHighlightToLine = () => {};
  editor.events.callEvent = (_, change) => h.handleChange(change);
  const agent = {
    editor, waitForEditorReady: async () => true,
    executedModificationRequests: new Map(),
    markFileDiffHighlights(beforeText, afterText, target) {
      assert.equal(beforeText, before);
      assert.equal(afterText, after);
      target.diffRows = [{ type: 'added', text: afterText, documentIndex: 0 }];
    },
    toProjectRelativePath: () => 'game.html',
    getContentRevision: () => 'revision',
  };
  editor.lineController.getContent = () => file.lines.map((line) => line.getText()).join('\n');
  const Manager = loadGlobal('src/js/agent/files/ActiveFileManager.js', 'ActiveFileManager', { window: {} });
  const result = await new Manager(agent).modifyActiveFile({ oldText: before, newText: after });
  assert.equal(result.success, true);
  await h.documentQueues.get(file.id);
  assert.equal(file.lines[0].getText(), after);
  assert.equal(file.lines[0].isHighlight, true);
  assert.equal(file.lines[0].getTokens()[2].value, '"game-board"');
  assert.equal(calls.filter(({ type }) => type === 'updateDocument').length, 1);
  const lines = Object.create(LineController.prototype);
  lines.editor = editor;
  lines.startIndex = 0;
  lines.getLineTop = () => 0;
  const rendered = lines.createLineOBJ({ text: after, startChar: 0 }, 0);
  assert.match(classes(rendered), /line-added/);
  assert.match(classes(rendered), /nsh-tag/);
  assert.match(classes(rendered), /nsh-string/);
});

test('async NSH DOM application preserves inline diff on a visible line', () => {
  const value = '<div id="game-board"></div>';
  const line = new LineNode(value);
  line.diffSegments = [{ type: 'added', text: '<div id="' }, { type: 'modified', text: 'game-board"></div>' }];
  const file = { lines: [line] };
  const slot = document.createElement('div');
  slot.dataset.line = '0';
  slot.isConnected = true;
  const editor = { tabManager: { activeFile: file }, writerController: new Writer({}) };
  const lines = Object.create(LineController.prototype);
  lines.editor = editor;
  lines.getSlicedLine = (text) => ({ text, startChar: 0 });
  editor.lineController = lines;
  const Highlight = loadGlobal('src/js/controller/HighlightController.js', 'HighlightController', {
    NSHClient: class {},
  });
  const h = Object.create(Highlight.prototype);
  h.editor = editor;
  h.lineNodes = new Map([[0, slot]]);
  assert.equal(h.applyHighlightToLine(0, htmlTokens(value)), true);
  assert.match(classes(slot), /diff-added/);
  assert.match(classes(slot), /nsh-string/);
});

test('multiline incremental response applies converged lexical state only to matching current lines', async () => {
  const { editor, file } = createEditor('/*\ncomment\n*/');
  file.language = 'javascript';
  file.incrementalEligible = true;
  file.getSyntaxMetrics = () => ({ logicalLength: 20, longLineCount: 0 });
  editor.writerController = new Writer(editor);
  class Client { async request(type) {
    if (type === 'updateDocument') return { changedStartLine: 0, lines: [
      { text: 'const x = 1;', tokens: [{ line: 1, column: 1, value: 'const', className: 'keyword' }], stateAfter: ['root'] },
      { text: 'comment', tokens: [{ line: 2, column: 1, value: 'comment', className: 'variable' }], stateAfter: ['root'] },
      { text: '*/', tokens: [{ line: 3, column: 1, value: '*/', className: 'operator' }], stateAfter: ['root'] },
    ] };
    return {};
  } }
  const Highlight = loadGlobal('src/js/controller/HighlightController.js', 'HighlightController', { NSHClient: Client });
  const h = new Highlight(editor);
  h.documentModes.set(file.id, 'incremental');
  h.documentEpochs.set(file.id, 0);
  h.applyHighlightToLine = () => {};
  editor.highlightController = h;
  editor.events.callEvent = (_, change) => h.handleChange(change);
  editor.writerController.replaceRange('const x = 1;', 1, 0, 1, 2);
  await h.documentQueues.get(file.id);
  assert.deepEqual(file.lines.map((line) => line.getTokens()[0].className), ['keyword', 'variable', 'operator']);
  assert.deepEqual(file.lines.map((line) => line.getState()[0]), ['root', 'root', 'root']);
  h.applyCachedLines(file, [{ text: 'stale', tokens: [{ line: 1, value: 'stale' }] }]);
  assert.equal(file.lines[0].getTokens()[0].value, 'const');
});

test('NSH incremental lexical change propagates through multiline comment and stops at convergence', () => {
  const { Tokenizer, JavaScript, IncrementalDocument } = require('nsh');
  const source = '/*\ncomment\n*/\nconst x = 1;\nconst y = 2;';
  const document = new IncrementalDocument(new Tokenizer(new JavaScript()), source);
  assert.equal(document.getLine(1).tokens[0].className, 'nsh-comment');
  const changed = document.updateLines(0, 1, ['const z = 0;']);
  assert.equal(document.getLine(1).tokens[0].className, 'nsh-variable');
  assert.equal(document.getLine(2).tokens[0].className, 'nsh-operator');
  assert.equal(changed.changedEndLine, 3);
  assert.ok(changed.retokenizedLines < document.getLineCount());
});
