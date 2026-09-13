const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createAgent } = require('./helpers/agent-runtime');
const { FileManager } = require('../dist/ts/addon/FileManager');
const { WorkspaceSearch } = require('../dist/ts/addon/WorkspaceSearch');
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nce-agent-'));
  const manager = new FileManager({});
  const search = new WorkspaceSearch({});
  const editor = { fileExplorer: { rootPath: root }, tabManager: { getFileByPath: () => null }, api: {
    agentFileOperation: manager.agentFileOperation.bind(manager),
    pathExists: async p => { try { await fs.stat(p); return true; } catch { return false; } },
    pathStatus: async p => { try { const stat = await fs.stat(p); return { exists: true, isDirectory: stat.isDirectory(), readable: true }; } catch (error) { return { exists: false, code: error.code }; } },
    getFileContent: manager.getFileContent.bind(manager),
    getProjectMap: search.getProjectMap.bind(search),
    searchInFiles: search.search.bind(search),
    getFolderContent: manager.getFolderContent.bind(manager),
  } };
  return { root, editor, agent: createAgent(editor), manager };
}

async function setupEditable(content, { open = true, saved = true } = {}) {
  const fixture = await setup();
  const filePath = path.join(fixture.root, 'editable.txt');
  await fs.writeFile(filePath, content);
  const makeLine = text => ({ text, getText() { return this.text; }, diffState: null, diffSegments: [] });
  const makeFile = (text, targetPath = filePath) => ({
    id: 17,
    name: 'editable.txt',
    path: targetPath,
    lines: text.replace(/\r\n?/g, '\n').split('\n').map(makeLine),
    totalLines: text.split(/\r?\n/).length,
    maxLineLength: 0,
    isSaved: saved,
    autoSave: false,
    diffSnapshot: null,
    diffActive: false,
    diffRows: [],
    setIsSaved(value) { this.isSaved = value; },
  });
  let currentFile = open ? makeFile(content) : null;
  fixture.editor.tabManager = {
    activeFile: currentFile,
    getFileByPath: candidate => candidate === currentFile?.path ? currentFile : null,
    async openFileWithPath(candidate) {
      currentFile = makeFile(await fs.readFile(candidate, 'utf8'), candidate);
      this.activeFile = currentFile;
      return currentFile;
    },
    async setFocusFile(file) { this.activeFile = file; },
  };
  fixture.editor.fileLoader = { async waitForFileLoaded() {} };
  fixture.editor.lineController = { loadContent() {}, refresh() {}, markDirtyAll() {} };
  fixture.getFile = () => currentFile;
  return fixture;
}

const CODE_TOOLS = [
  'create_file',
  'delete_file',
  'get_project_map',
  'modify_file',
  'read_file',
  'rename_file',
  'search_code',
  'task_complete',
  'write_file_chunk',
];

const READ_TOOLS = [
  'get_project_map',
  'read_file',
  'search_code',
];

test('Agent exposes the minimal public tool surface for read and code modes', async () => {
  const { root, agent } = await setup();
  try {
    assert.deepEqual([...agent.getAvailableToolNames()].sort(), CODE_TOOLS);
    assert.equal(agent.tools.size, CODE_TOOLS.length);
    for (const removed of [
      'get_editor_context',
      'get_cursor',
      'read_selection',
      'read_active_file',
      'search_active_file',
      'list_project_files',
      'search_project_files',
      'modify_active_file',
      'replace_text',
    ]) {
      assert.equal(agent.getTool(removed), undefined, removed);
    }

    agent.setConfig({ permissions: 'read' });
    assert.deepEqual([...agent.getAvailableToolNames()].sort(), READ_TOOLS);
    assert.equal(agent.getTool('modify_file').readOnly, false);
    assert.equal(agent.getTool('delete_file').readOnly, false);
    assert.equal(agent.getTool('task_complete').codeOnly, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('delete_file removes only safe workspace files and refreshes project caches', async () => {
  const { root, agent, editor } = await setup();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nce-delete-outside-'));
  try {
    await fs.writeFile(path.join(root, 'keep.txt'), 'keep');
    await fs.writeFile(path.join(root, 'delete.txt'), 'delete');
    await fs.mkdir(path.join(root, 'directory'));
    await fs.writeFile(path.join(outside, 'outside.txt'), 'outside');
    let invalidatedRoot = null;
    let refreshedFolder = null;
    editor.quickOpen = { invalidate: value => { invalidatedRoot = value; } };
    editor.fileExplorer.refreshFolder = async value => { refreshedFolder = value; };

    const firstMap = await agent.getProjectMap({});
    assert.match(firstMap.text, /delete\.txt/);
    const result = await agent.executeToolCall({
      id: 'delete-safe-file',
      function: { name: 'delete_file', arguments: JSON.stringify({ path: 'delete.txt' }) },
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.result.path, 'delete.txt');
    assert.equal(await editor.api.pathExists(path.join(root, 'delete.txt')), false);
    assert.equal(await fs.readFile(path.join(root, 'keep.txt'), 'utf8'), 'keep');
    assert.doesNotMatch((await agent.getProjectMap({})).text, /delete\.txt/);
    assert.equal((await agent.getTool('search_code').execute({ query: 'delete' })).totalMatches, 0);
    assert.equal(invalidatedRoot, root);
    assert.equal(refreshedFolder, root);

    assert.equal((await agent.deleteWorkspaceFile({ path: 'missing.txt' })).error.code, 'FILE_NOT_FOUND');
    assert.equal((await agent.deleteWorkspaceFile({ path: 'directory' })).error.code, 'NOT_A_FILE');
    for (const unsafe of ['../outside.txt', '../../etc/passwd', path.join(outside, 'outside.txt')]) {
      assert.equal((await agent.deleteWorkspaceFile({ path: unsafe })).success, false, unsafe);
    }
    assert.equal(await fs.readFile(path.join(outside, 'outside.txt'), 'utf8'), 'outside');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('delete_file rejects escaped symlinks and dirty tabs, then closes a clean open tab', async () => {
  const { root, agent, editor } = await setup();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nce-delete-symlink-'));
  try {
    const outsideFile = path.join(outside, 'outside.txt');
    await fs.writeFile(outsideFile, 'outside');
    await fs.symlink(outsideFile, path.join(root, 'escape.txt'), process.platform === 'win32' ? 'file' : undefined);
    const escaped = await agent.deleteWorkspaceFile({ path: 'escape.txt' });
    assert.equal(escaped.success, false);
    assert.equal(escaped.error.code, 'OUTSIDE_WORKSPACE');
    assert.equal(await fs.readFile(outsideFile, 'utf8'), 'outside');

    const openPath = path.join(root, 'open.txt');
    await fs.writeFile(openPath, 'disk');
    const openFile = { id: 7, path: openPath, isSaved: false };
    editor.tabManager.activeFile = openFile;
    editor.tabManager.getFileByPath = p => p === openPath ? openFile : null;
    let closeCalls = 0;
    editor.tabManager.closeFile = async id => {
      closeCalls++;
      assert.equal(id, openFile.id);
      editor.tabManager.activeFile = null;
      editor.tabManager.getFileByPath = () => null;
      return true;
    };
    const dirty = await agent.deleteWorkspaceFile({ path: 'open.txt' });
    assert.equal(dirty.error.code, 'DIRTY_FILE');
    assert.equal(await fs.readFile(openPath, 'utf8'), 'disk');
    assert.equal(closeCalls, 0);

    openFile.isSaved = true;
    editor.tabManager.getFileByPath = p => p === openPath ? openFile : null;
    const clean = await agent.deleteWorkspaceFile({ path: 'open.txt' });
    assert.equal(clean.success, true, JSON.stringify(clean));
    assert.equal(closeCalls, 1);
    assert.equal(editor.tabManager.activeFile, null);
    assert.equal(await editor.api.pathExists(openPath), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('ResponseBudgetEstimator provides a bounded local estimate without extra AI calls', async () => {
  const { root, agent } = await setup();
  try {
    const budget = agent.responseBudgetEstimator.estimateResponseBudget({
      agent,
      model: {
        contextWindow: 128000,
        maxOutputTokens: 16384,
      },
      runtimeState: {
        kind: 'normal-edit',
        lastTool: 'modify_file',
        largeWriteActive: false,
      },
      previousUsage: [],
      modelHint: null,
    });
    assert.equal(budget.success, true);
    assert.equal(typeof budget.estimatedResponseTokens, 'number');
    assert.equal(typeof budget.reservedForResponseTokens, 'number');
    assert.equal(typeof budget.effectiveMaxOutputTokens, 'number');
    assert.equal(budget.reservedForResponseTokens >= budget.estimatedResponseTokens, true);
    assert.equal(budget.reservedForResponseTokens <= budget.effectiveMaxOutputTokens, true);
    assert.equal(agent.getTool('read_file').readOnly, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Agent public project, search, read and completion tools remain functional', async () => {
  const { root, agent } = await setup();
  try {
    await fs.writeFile(path.join(root, 'sample.js'), 'const needle = true;\n');
    const map = await agent.getTool('get_project_map').execute({});
    assert.equal(map.success, true);
    assert.match(map.text, /sample\.js/);

    const search = await agent.getTool('search_code').execute({ query: 'needle' });
    assert.equal(search.totalMatches, 1);
    const read = await agent.getTool('read_file').execute({ path: 'sample.js' });
    assert.equal(read.success, true);
    assert.match(read.content, /needle/);

    const completion = await agent.getTool('task_complete').execute({ summary: 'done' });
    assert.equal(completion.taskCompleteRequested, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('modify_file uses explicit revisions for immediate and repeated edits', async () => {
  const fixture = await setupEditable('alpha beta gamma');
  const { root, agent } = fixture;
  try {
    const read = await agent.readFile('editable.txt');
    const first = await agent.modifyFile({ path: 'editable.txt', revision: read.revision, oldText: 'alpha', newText: 'one' });
    assert.equal(first.success, true, JSON.stringify(first));
    assert.equal(first.previousRevision, read.revision);
    const second = await agent.modifyFile({ path: 'editable.txt', revision: first.revision, oldText: 'beta', newText: 'two' });
    const third = await agent.modifyFile({ path: 'editable.txt', revision: second.revision, oldText: 'gamma', newText: 'three' });
    assert.equal(third.success, true, JSON.stringify(third));
    assert.equal(fixture.getFile().lines.map(line => line.getText()).join('\n'), 'one two three');
    assert.equal(agent.readFileContexts.get(path.join(root, 'editable.txt')).revision, third.revision);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('modify_file rejects stale revisions and recovers after reading the changed buffer', async () => {
  const fixture = await setupEditable('before');
  const { root, agent } = fixture;
  try {
    const read = await agent.readFile('editable.txt');
    fixture.getFile().lines = [{ getText: () => 'user change', diffState: null, diffSegments: [] }];
    fixture.getFile().isSaved = false;
    const stale = await agent.modifyFile({ path: 'editable.txt', revision: read.revision, oldText: 'before', newText: 'agent change' });
    assert.equal(stale.error.code, 'STALE_REVISION');
    assert.equal(fixture.getFile().lines[0].getText(), 'user change');

    const reread = await agent.readFile('editable.txt');
    const recovered = await agent.modifyFile({ path: 'editable.txt', revision: reread.revision, oldText: 'user change', newText: 'user + agent' });
    assert.equal(recovered.success, true, JSON.stringify(recovered));
    assert.equal(fixture.getFile().lines[0].getText(), 'user + agent');
    assert.equal(fixture.getFile().isSaved, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('modify_file separates revision validation from exact and ambiguous matching', async () => {
  const fixture = await setupEditable('same\nmiddle\nsame');
  const { root, agent } = fixture;
  try {
    const read = await agent.readFile('editable.txt');
    const missingRevision = await agent.modifyFile({ path: 'editable.txt', oldText: 'middle', newText: 'center' });
    assert.equal(missingRevision.error.code, 'REVISION_REQUIRED');
    const missing = await agent.modifyFile({ path: 'editable.txt', revision: read.revision, oldText: 'absent', newText: 'value' });
    assert.equal(missing.error.code, 'OLD_TEXT_NOT_FOUND');
    const ambiguous = await agent.modifyFile({ path: 'editable.txt', revision: read.revision, oldText: 'same', newText: 'value' });
    assert.equal(ambiguous.error.code, 'AMBIGUOUS_MATCH');
    assert.equal(fixture.getFile().lines.map(line => line.getText()).join('\n'), 'same\nmiddle\nsame');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('partial and truncated reads do not become hidden write preconditions', async () => {
  const longPrefix = 'x'.repeat(5000);
  const fixture = await setupEditable(`${longPrefix}\ntarget\ntail`);
  const { root, agent } = fixture;
  try {
    const partial = await agent.readFile('editable.txt', { startLine: 2, endLine: 2 });
    const partialEdit = await agent.modifyFile({ path: 'editable.txt', revision: partial.revision, oldText: 'target', newText: 'changed' });
    assert.equal(partialEdit.success, true, JSON.stringify(partialEdit));

    const full = await agent.readFile('editable.txt', { startLine: 1, endLine: 3 });
    assert.equal(full.truncated, true);
    assert.doesNotMatch(full.content, /tail/);
    const outsideVisiblePrefix = await agent.modifyFile({ path: 'editable.txt', revision: full.revision, oldText: 'tail', newText: 'done' });
    assert.equal(outsideVisiblePrefix.success, true, JSON.stringify(outsideVisiblePrefix));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('closed CRLF files and newly created files follow the same revision chain', async () => {
  const fixture = await setupEditable('first\r\nsecond', { open: false });
  const { root, agent } = fixture;
  try {
    const read = await agent.readFile('editable.txt');
    const crlfEdit = await agent.modifyFile({ path: 'editable.txt', revision: read.revision, oldText: 'first\nsecond', newText: 'first\nupdated' });
    assert.equal(crlfEdit.success, true, JSON.stringify(crlfEdit));

    const created = await agent.createWorkspaceFile({ path: 'created.txt', content: 'created value' });
    const createdEdit = await agent.modifyFile({ path: 'created.txt', revision: created.revision, oldText: 'created', newText: 'updated' });
    assert.equal(createdEdit.success, true, JSON.stringify(createdEdit));
    assert.equal(createdEdit.previousRevision, created.revision);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('create_file overwrite requires the explicit revision of existing content', async () => {
  const { root, agent } = await setup();
  try {
    await fs.writeFile(path.join(root, 'existing.txt'), 'known');
    const refused = await agent.createWorkspaceFile({ path: 'existing.txt', content: 'replacement', overwrite: true });
    assert.equal(refused.error.code, 'REVISION_REQUIRED');
    assert.equal(await fs.readFile(path.join(root, 'existing.txt'), 'utf8'), 'known');

    const read = await agent.readFile('existing.txt');
    const overwritten = await agent.createWorkspaceFile({ path: 'existing.txt', content: 'replacement', overwrite: true, revision: read.revision });
    assert.equal(overwritten.success, true, JSON.stringify(overwritten));
    assert.equal(await fs.readFile(path.join(root, 'existing.txt'), 'utf8'), 'replacement');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('write guards reject stopped runs and workspace changes before mutation', async () => {
  const { root, agent, editor } = await setup();
  const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nce-other-workspace-'));
  try {
    agent.runId = 4;
    agent.runConfig = { permissions: 'code', workspaceRoot: root };
    agent.stopRequested = true;
    const stopped = await agent.executeToolCall({ function: { name: 'create_file', arguments: '{"path":"blocked.txt"}' } }, { runId: 4 });
    assert.equal(stopped.error.code, 'RUN_ABORTED');
    assert.equal(await editor.api.pathExists(path.join(root, 'blocked.txt')), false);

    agent.stopRequested = false;
    editor.fileExplorer.rootPath = otherRoot;
    const switched = await agent.executeToolCall({ function: { name: 'create_file', arguments: '{"path":"blocked.txt"}' } }, { runId: 4 });
    assert.equal(switched.error.code, 'WORKSPACE_CHANGED');
    assert.equal(await editor.api.pathExists(path.join(otherRoot, 'blocked.txt')), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(otherRoot, { recursive: true, force: true });
  }
});

test('Agent create/chunk/rename use actual temporary files and verify revisions', async () => {
  const { root, agent } = await setup();
  try {
    const created = await agent.createWorkspaceFile({ path: 'a.txt', content: 'first' });
    assert.equal(created.success, true, JSON.stringify(created)); assert.equal(created.verification.verified, true);
    const bad = await agent.writeWorkspaceFileChunk({ path: 'a.txt', content: '\nsecond', expectedRevision: 'wrong' });
    assert.equal(bad.error.code, 'STALE_REVISION');
    const appended = await agent.writeWorkspaceFileChunk({ path: 'a.txt', content: '\nsecond', expectedRevision: created.revision });
    assert.equal(appended.success, true, JSON.stringify(appended)); assert.equal(appended.verification.verified, true);
    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'first\nsecond');
    const renamed = await agent.renameWorkspaceFile({ path: 'a.txt', newPath: 'b.txt' });
    assert.equal(renamed.success, true, JSON.stringify(renamed));
    assert.equal(await fs.readFile(path.join(root, 'b.txt'), 'utf8'), 'first\nsecond');
    const map = await agent.getProjectMap({}); assert.equal(map.success, true); assert.match(map.text, /b.txt/);
    await fs.writeFile(path.join(root, 'broken.asar'), Buffer.from('invalid\0archive'));
    assert.equal((await agent.readFile('broken.asar')).error.code, 'BINARY_FILE');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Agent rejects traversal, Windows escapes, dirty overwrite and write payload overflow', async () => {
  const { root, agent, editor } = await setup();
  try {
    for (const p of ['../outside.txt', '..\\outside.txt', '/outside.txt', 'C:\\outside.txt']) {
      assert.equal((await agent.createWorkspaceFile({ path: p, content: 'bad' })).success, false);
    }
    assert.equal(agent.resolveWorkspacePath('..\\outside.txt', 'C:\\project'), null);
    await fs.writeFile(path.join(root, 'dirty.txt'), 'disk'); editor.tabManager.getFileByPath = () => ({ isSaved: false });
    assert.equal((await agent.createWorkspaceFile({ path: 'dirty.txt', content: 'overwrite', overwrite: true })).error.code, 'PERMISSION_DENIED');
    assert.equal((await agent.writeWorkspaceFileChunk({ path: 'dirty.txt', content: 'x', expectedRevision: 'a' })).error.code, 'PERMISSION_DENIED');
    assert.equal(agent.toolExecutor.validateFileWritePayload('create_file', { content: 'x'.repeat(10001) }).valid, false);
    assert.throws(() => agent.registerTool('invalid', {}));
    assert.ok(agent.getTool('create_file'));
    assert.equal(agent.validateTool(agent.getTool('write_file_chunk'), {}).valid, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('main Agent file boundary rejects a symlink to a different temporary directory', async () => {
  const { root, manager } = await setup();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nce-outside-'));
  try {
    await fs.symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await manager.agentFileOperation(root, 'createFile', [path.join(root, 'link'), 'escape.txt', 'bad']);
    assert.equal(result.success, false); assert.equal(result.code, 'OUTSIDE_WORKSPACE');
    assert.deepEqual(await fs.readdir(outside), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); }
});

test('ModelClient performs only mocked transport and strips API key from bridge config', async () => {
  let request;
  const agent = createAgent({ api: { aiChat: async data => { request = data; return { choices: [{ message: { role: 'assistant', content: 'mock answer' } }] }; } } });
  agent.messages = [{ role: 'user', content: 'test' }];
  agent.contextCompaction.logMetrics = false;
  const result = await agent.requestSingleModel(new AbortController(), { provider: { id: 'mock', baseURL: 'https://invalid.example', apiKey: 'test-key' }, model: 'mock', supportsTools: false });
  assert.equal(result.choices[0].message.content, 'mock answer'); assert.equal(request.provider.apiKey, undefined);
  const config = agent.createRunConfig({ runId: 3, sessionId: 'session' });
  assert.equal(config.runId, 3); assert.equal(config.sessionId, 'session');
  const state = agent.createLargeWriteRuntimeState({ largeFileWriting: { maxChunkCharacters: 4000 } });
  assert.equal(state.maxChunkChars, 4000); assert.equal(state.state, 'IDLE');
  await assert.rejects(agent.agentRunner.execute(''), /obligatoire/);
  assert.equal((await agent.activeFileManager.readActiveFile()).success, false);
});
