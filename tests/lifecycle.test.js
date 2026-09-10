const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { loadGlobal, createEditor } = require('./helpers/runtime');
const LineNode = loadGlobal('src/js/types/Line.js', 'LineNode');
const [TAB_TYPES, Tab, SettingsTab, FileNode] = loadGlobal(
  'src/js/types/Tab.js', '[TAB_TYPES, Tab, SettingsTab, FileNode]', { LineNode },
);
const NCEPath = loadGlobal('src/js/core/Path.js', 'NCEPath');
const FileLoader = loadGlobal('src/js/addon/FileLoader.js', 'FileLoader', { LineNode, window: {} });
const TabManager = loadGlobal('src/js/manager/TabManager.js', 'tabManager', { FileNode, SettingsTab, TAB_TYPES, NCEPath, getElement: () => null, Events: {} });
const Editor = loadGlobal('src/js/main/Editor.js', 'Editor', {
  document: { addEventListener() {} }, window: {},
  SETTINGS_GET: () => false, SETTINGS_SET: async () => true,
});
const StatesManager = loadGlobal('src/js/manager/StatesManager.js', 'StatesManager', { FileNode, SettingsTab, TAB_TYPES });
const quiet = { ...console, warn() {}, error() {} };

function setup() {
  const { editor } = createEditor();
  editor.fileExplorer = { setActiveFile(p) { this.activeFilePath = p; } };
  editor.searchController = { close() {} };
  editor.selectController.refreshContaisSelected = () => {};
  editor.selectController.refreshSelectionDOM = () => {};
  editor.highlightController = { closeAllFiles() {}, closeFile: async () => {}, invalidateFile: async () => {}, detectLanguage: async () => 'plaintext', openFile: async () => {}, dirtyLines: new Set() };
  editor.lineController.dirtyLines = new Set();
  editor.lineController.markDirtyAll = () => {};
  editor.scrollerManager = { refreshAll() {} };
  editor.refreshAll = () => {};
  editor.tabManager = new TabManager(editor);
  editor.tabManager.refresh = () => {};
  editor.fileLoader = new FileLoader(editor);
  return editor;
}

for (const choices of [[], ['save'], ['dontSave'], ['cancel'], ['save', 'dontSave'], ['save', 'cancel']]) {
  test(`quit preserves tabs with decisions ${JSON.stringify(choices)}`, async () => {
    const editor = setup();
    const files = Array.from({ length: Math.max(1, choices.length) }, (_, i) => {
      const file = new FileNode(editor, i + 1, `${i}.js`, `/tmp/${i}.js`);
      file.isSaved = !choices.length;
      file.save = async () => { file.isSaved = true; return true; };
      return file;
    });
    editor.tabManager.files = files;
    editor.tabManager.activeFile = files[0];
    const decisions = [...choices];
    editor.savePopupManager = { confirmClose: async () => decisions.shift() };
    let callback, approved = 0, cancelled = 0, snapshot;
    editor.api = { onSaveRequest(fn) { callback = fn; }, approveQuit: async () => approved++, cancelQuit: async () => cancelled++, saveEditorState: async (s) => { snapshot = JSON.parse(s); return true; } };
    editor.statesManager = new StatesManager(editor);
    editor.fileExplorer = null;
    Editor.prototype.initQuitEvent.call(editor);
    await callback();
    assert.equal(approved, choices.includes('cancel') ? 0 : 1);
    assert.equal(cancelled, choices.includes('cancel') ? 1 : 0);
    assert.equal(editor.tabManager.files, files);
    assert.equal(editor.tabManager.activeFile, files[0]);
    if (approved) assert.equal(snapshot.tabManager.files.length, files.length);
  });
}
for (const failure of ['save-false', 'save-throws', 'state-false', 'state-throws']) {
  test(`quit cancels on ${failure}`, async () => {
    const editor = setup();
    const file = new FileNode(editor, 1, 'a', '/a');
    file.isSaved = false;
    file.save = async () => { if (failure === 'save-throws') throw Error('save failed'); return failure !== 'save-false'; };
    editor.tabManager.files = [file]; editor.tabManager.activeFile = file;
    editor.savePopupManager = { confirmClose: async () => 'save' };
    let callback, cancelled = 0;
    editor.api = { onSaveRequest(fn) { callback = fn; }, cancelQuit: async () => cancelled++, approveQuit: async () => assert.fail('unexpected quit') };
    editor.statesManager = { save: async () => { if (failure === 'state-throws') throw Error('state failed'); return false; } };
    const originalError = console.error;
    if (failure.endsWith('throws')) console.error = () => {};
    try { Editor.prototype.initQuitEvent.call(editor); await callback(); }
    finally { console.error = originalError; }
    assert.equal(cancelled, 1); assert.equal(editor.tabManager.files.length, 1);
  });
}

test('serialization failure never overwrites the previous state with {}', async () => {
  let writes = 0;
  const manager = new StatesManager({ api: { saveEditorState: async () => writes++ } });
  manager.getState = () => { throw Error('serialization failed'); };
  const originalError = console.error; console.error = () => {};
  try { assert.equal(await manager.save(), false); assert.equal(writes, 0); }
  finally { console.error = originalError; }
});

test('existing FileNode auto-save follows the shared state and safe save pipeline', async () => {
  const editor = setup();
  editor.autoSaveEnabled = false;
  editor.getAutoSaveState = Editor.prototype.getAutoSaveState;
  editor.setAutoSaveState = Editor.prototype.setAutoSaveState;
  editor.toggleAutoSave = Editor.prototype.toggleAutoSave;
  editor.api = { setAutoSaveState() {} };
  editor.statesManager = { save: async () => true };
  let writes = 0;
  editor.api.saveFile = async (filePath) => { writes++; return filePath; };
  const file = new FileNode(editor, 1, 'saved.txt', '/saved.txt');
  file.loadingState = { status: 'loaded', loadedLineCount: 1, expectedTotalLines: 1 };
  file.lines = [new LineNode('changed')];
  editor.tabManager.files = [file]; editor.tabManager.activeFile = file;

  file.onChange(); await new Promise(r => setImmediate(r));
  assert.equal(writes, 0); assert.equal(file.isSaved, false);
  editor.setAutoSaveState(true, { persist: false });
  file.onChange(); await new Promise(r => setImmediate(r));
  assert.equal(writes, 1); assert.equal(file.isSaved, true);

  editor.api.saveFile = async () => false;
  const originalWarn = console.warn; console.warn = () => {};
  try { file.onChange(); await new Promise(r => setImmediate(r)); }
  finally { console.warn = originalWarn; }
  assert.equal(file.isSaved, false);
  editor.api.saveFile = async (filePath) => { writes++; return filePath; };

  const untitled = new FileNode(editor, 2, 'New file', null);
  editor.tabManager.files.push(untitled); editor.tabManager.activeFile = untitled;
  untitled.onChange(); await new Promise(r => setImmediate(r));
  assert.equal(writes, 1);

  const loading = new FileNode(editor, 3, 'large.txt', '/large.txt');
  loading.loadingState = { status: 'loading', loadedLineCount: 1, expectedTotalLines: 2,
    completion: new Promise(() => {}) };
  editor.tabManager.files.push(loading); editor.tabManager.activeFile = loading;
  loading.onChange(); await new Promise(r => setImmediate(r));
  assert.equal(writes, 1);

  editor.tabManager.activeFile = file;
  editor.tabManager.markFileAsDeleted(file.path);
  file.onChange(); await new Promise(r => setImmediate(r));
  assert.equal(writes, 1);
  assert.equal(file.isSaved, false);
  assert.equal(file.deletedFromDisk, true);
});

test('auto-save preference is absent from session state and legacy state is ignored', async () => {
  const editor = setup();
  editor.fileExplorer = null;
  editor.autoSaveEnabled = true;
  editor.getAutoSaveState = () => editor.autoSaveEnabled;
  const state = new StatesManager(editor).getState();
  assert.equal('preferences' in state, false);
  let restored = false;
  editor.setAutoSaveState = () => { restored = true; };
  await new StatesManager(editor).loadStates({ preferences: { autoSave: true } });
  assert.equal(restored, false);
});

for (const mode of ['failure', 'cancel', 'complete', 'save-as', 'short-chunk']) {
  test(`15000-line file: ${mode} preserves data or saves complete content`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nce-partial-'));
    const filePath = path.join(directory, 'large.txt');
    const lines = Array.from({ length: 15000 }, (_, i) => `line ${i}`);
    const original = lines.join('\n');
    const hash = (value) => createHash('sha256').update(value).digest('hex');
    await fs.writeFile(filePath, original);
    const editor = setup();
    let writes = 0;
    editor.api = {
      initializeFile: async () => ({ success: true, totalLines: lines.length, size: 2000000 }),
      getFileChunk: async (_, start, count) => {
        if (start === 2000 && mode === 'failure') throw Error('injected chunk failure');
        if (start === 2000 && mode === 'short-chunk') return { success: true, lines: [] };
        return { success: true, lines: lines.slice(start, start + count) };
      },
      saveFile: async (p, content) => { writes++; await fs.writeFile(p, content); return p; },
    };
    editor.tabManager.selectNewFile = async () => path.join(directory, 'copy.txt');
    editor.highlightController.changeLanguage = async () => {};
    const file = new FileNode(editor, 1, 'large.txt', filePath);
    editor.tabManager.files = [file]; editor.tabManager.activeFile = file;
    try {
      await file.loadContent();
      assert.equal(file.lines.length, 1000);
      if (mode === 'cancel') editor.fileLoader.cancelLoading(filePath);
      const warnings = [];
      const originalWarn = console.warn;
      console.warn = (message) => warnings.push(String(message));
      let result;
      try { result = mode === 'save-as' ? await file.saveAs() : await file.save(); }
      finally { console.warn = originalWarn; }
      const success = ['complete', 'save-as'].includes(mode);
      assert.equal(result, success); assert.equal(writes, success ? 1 : 0);
      assert.equal(hash(await fs.readFile(filePath)), hash(original));
      if (mode === 'save-as') assert.equal(await fs.readFile(file.path, 'utf8'), original);
      if (!success) assert.match(file.saveError.code, /^FILE_(LOAD_FAILED|NOT_FULLY_LOADED)$/);
      if (!success) assert.equal(warnings.length, 1);
    } finally { editor.fileLoader.cancelLoading(); await fs.rm(directory, { recursive: true, force: true }); }
  });
}

test('an in-flight chunk cannot append after cancellation or reload', async () => {
  const editor = setup(); let resolve;
  editor.api = { getFileChunk: () => new Promise(r => { resolve = r; }) };
  const file = new FileNode(editor, 1, 'a', '/a'); file.lines = [new LineNode('first')];
  const state = editor.fileLoader.getState('/a'); state.status = 'loading'; state.loadedLineCount = 1;
  file.loadingState = state;
  const pending = editor.fileLoader.performChunkLoad(file, '/a', 1, 2, 2, () => assert.fail('continued'), state);
  editor.fileLoader.cancelLoading('/a'); resolve({ success: true, lines: ['late'] }); await pending;
  assert.equal(file.lines.length, 1);
});

test('Windows paths compare separators and rename only complete segments', async () => {
  assert.equal(NCEPath.basename('C:\\Users\\Andrea\\project\\main.ts'), 'main.ts');
  assert.equal(NCEPath.equals('C:\\project\\a.js', 'C:/project/a.js'), true);
  assert.equal(NCEPath.isInside('/foo/bar2/a', '/foo/bar'), false);
  const editor = setup();
  const file = new FileNode(editor, 1, 'a.js', 'C:\\project\\src\\a.js'); file.isLoaded = true;
  editor.tabManager.files = [file]; editor.tabManager.activeFile = file;
  editor.highlightController.changeLanguage = async (f, lang) => { f.language = lang; };
  await editor.tabManager.updateFilePath('C:\\project\\src', 'C:\\project\\source');
  assert.equal(file.path, 'C:\\project\\source\\a.js');
  assert.equal(editor.fileExplorer.activeFilePath, file.path);
  assert.equal(editor.tabManager.getFileByPath('C:/project/source/a.js'), file);
});

test('tab bulk close uses a stable snapshot, preserves its target, and stops on cancel', async () => {
  const editor = setup();
  const files = ['a', 'b', 'c', 'd'].map(
    (name, index) => new FileNode(editor, index + 1, name, `/${name}`),
  );
  editor.tabManager.files = files;
  editor.tabManager.activeFile = files[0];
  const [aId, bId, cId] = files.map((file) => file.id);
  const target = files[1];

  const attempted = [];
  editor.tabManager.setFocusFile = async (file) => {
    editor.tabManager.activeFile = file;
  };
  editor.tabManager.closeFile = async (id) => {
    attempted.push(id);
    if (id === cId) return false;
    editor.tabManager.removeFileByID(id);
    return true;
  };

  assert.equal(await editor.tabManager.closeOtherFiles(target), false);
  assert.deepEqual(attempted, [aId, cId]);
  assert.deepEqual(editor.tabManager.files.map((file) => file.id), [bId, cId, 4]);
  assert.equal(editor.tabManager.activeFile, target);
});

test('tab bulk close selects exactly the tabs to the left or right', async () => {
  const editor = setup();
  const files = ['a', 'b', 'c', 'd'].map(
    (name, index) => new FileNode(editor, index + 1, name, `/${name}`),
  );
  editor.tabManager.files = [...files];
  editor.tabManager.activeFile = files[2];
  const closed = [];
  editor.tabManager.closeFile = async (id) => {
    closed.push(id);
    editor.tabManager.removeFileByID(id);
    return true;
  };

  assert.equal(await editor.tabManager.closeFilesToLeft(files[2]), true);
  assert.deepEqual(closed, [files[0].id, files[1].id]);
  assert.deepEqual(editor.tabManager.files, [files[2], files[3]]);

  closed.length = 0;
  assert.equal(await editor.tabManager.closeFilesToRight(files[2]), true);
  assert.deepEqual(closed, [files[3].id]);
  assert.deepEqual(editor.tabManager.files, [files[2]]);
  assert.equal(editor.tabManager.activeFile, files[2]);
});

test('closing a dirty tab reports cancel and save failure without removing it', async () => {
  const editor = setup();
  const file = new FileNode(editor, 1, 'dirty', '/dirty');
  file.isSaved = false;
  editor.tabManager.files = [file];
  editor.tabManager.activeFile = file;

  editor.savePopupManager = { confirmClose: async () => 'cancel' };
  assert.equal(await editor.tabManager.closeFile(file.id), false);
  assert.deepEqual(editor.tabManager.files, [file]);

  editor.savePopupManager = { confirmClose: async () => 'save' };
  file.save = async () => false;
  assert.equal(await editor.tabManager.closeFile(file.id), false);
  assert.deepEqual(editor.tabManager.files, [file]);
});

test('lazy state restore keeps A/B/C, B active, cursor/selection/scroll', async () => {
  const editor = setup();
  const loaded = [];
  editor.tabManager.setFocusFile = async (file) => { editor.tabManager.activeFile = file; loaded.push(file.id); };
  const manager = new StatesManager(editor);
  await manager.loadTabManagerState({ activeFile: { id: 2 }, files: [1,2,3].map(id => ({ id, name: `${id}.js`, path: `/${id}.js`, row: 4, column: 2, startIndex: 2, offsetX: 10, offsetY: 4, selectedLines: [[0, { startCol: 1, endCol: 3 }]] })) });
  const state = manager.getTabManagerState();
  assert.deepEqual(loaded, [2]); assert.equal(state.files.length, 3); assert.equal(state.activeFile.id, 2);
  assert.equal(state.files[1].row, 4); assert.equal(state.files[1].offsetX, 10); assert.equal(state.files[1].selectedLines.length, 1);
});

test('rapid focus changes cannot load A content into B', async () => {
  const editor = setup(); let finishA;
  editor.api = {
    initializeFile: async p => ({ success: true, totalLines: 1, size: 1 }),
    getFileChunk: async p => p === '/a' ? await new Promise(r => { finishA = r; }) : { success: true, lines: ['B'] },
  };
  const a = new FileNode(editor, 1, 'a', '/a'); const b = new FileNode(editor, 2, 'b', '/b');
  editor.tabManager.files = [a,b];
  const first = editor.tabManager.setFocusFile(a);
  await new Promise(r => setImmediate(r));
  await editor.tabManager.setFocusFile(b);
  finishA({ success: true, lines: ['A'] }); await first;
  assert.equal(editor.tabManager.activeFile, b); assert.equal(a.lines[0].getText(), 'A'); assert.equal(b.lines[0].getText(), 'B');
});

test('save completion does not mark newer edits as saved', async () => {
  const editor = setup(); let finish;
  editor.api = { saveFile: () => new Promise(r => { finish = r; }) };
  const file = new FileNode(editor, 1, 'a', '/a'); file.isSaved = false;
  file.loadingState = { status: 'loaded', expectedTotalLines: 1, loadedLineCount: 1 };
  const saved = file.save(); await new Promise(r => setImmediate(r));
  file.editVersion++; file.lines[0].setText('newer'); finish('/a'); await saved;
  assert.equal(file.isSaved, false);
});

test('Close All is a real close, and Cancel leaves all tabs open', async () => {
  const editor = setup();
  const file = new FileNode(editor, 1, 'a', '/a'); file.isSaved = false;
  editor.tabManager.files = [file]; editor.tabManager.activeFile = file;
  editor.savePopupManager = { confirmClose: async () => 'cancel' };
  assert.equal(await editor.tabManager.closeFiles(), false); assert.equal(editor.tabManager.files.length, 1);
  editor.savePopupManager.confirmClose = async () => 'dontSave';
  assert.equal(await editor.tabManager.closeFiles(), true); assert.equal(editor.tabManager.files.length, 0);
});
