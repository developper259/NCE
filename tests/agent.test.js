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
    getFileContent: manager.getFileContent.bind(manager),
    getProjectMap: search.getProjectMap.bind(search),
    searchInFiles: search.search.bind(search),
    getFolderContent: manager.getFolderContent.bind(manager),
  } };
  return { root, editor, agent: createAgent(editor), manager };
}

const CODE_TOOLS = [
  'create_file',
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
    assert.equal(agent.getTool('task_complete').codeOnly, true);
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

test('Agent create/chunk/rename use actual temporary files and verify revisions', async () => {
  const { root, agent } = await setup();
  try {
    const created = await agent.createWorkspaceFile({ path: 'a.txt', content: 'first' });
    assert.equal(created.success, true, JSON.stringify(created)); assert.equal(created.verification.verified, true);
    const bad = await agent.writeWorkspaceFileChunk({ path: 'a.txt', content: '\nsecond', expectedRevision: 'wrong' });
    assert.equal(bad.error.code, 'REVISION_MISMATCH');
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
