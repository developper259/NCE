const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgent } = require('./helpers/agent-runtime');

function fixture() {
  const editor = {
    api: {}, fileExplorer: { rootPath: '/workspace' },
    tabManager: { activeFile: null, getFileByPath: () => null },
  };
  const agent = createAgent(editor);
  agent.runId = 1;
  agent.runChangeTracker.beginRun(1, '/workspace');
  return { agent, tracker: agent.runChangeTracker };
}
function create(tracker, path, content) {
  tracker.recordCreate({ success: true, path, content, revision: `r-${content.length}` });
}
function modify(tracker, path, before, after) {
  tracker.recordModify({ success: true, path, beforeText: before, afterText: after,
    previousRevision: `r-${before.length}`, revision: `r-${after.length}` });
}
function call(name, args = {}, id = `${name}-${Math.random()}`) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}
async function diffTool(agent, args = {}, id = 'diff') {
  const result = await agent.executeToolCall(call('get_diff', args, id), { runId: 1 });
  assert.equal(result.success, true, JSON.stringify(result));
  return result.result;
}

test('small global diff reviews all changed files and static completion is eligible', async () => {
  const { agent, tracker } = fixture();
  create(tracker, 'index.html', '<main>Hi</main>');
  create(tracker, 'css/main.css', 'main { color: red; }');
  const listed = await agent.executeToolCall(call('get_changed_files', {}, 'listed'), { runId: 1 });
  assert.equal(listed.success, true);
  assert.equal(tracker.validateTaskComplete().error.code, 'CHANGES_NOT_REVIEWED');
  const result = await diffTool(agent, {}, 'global-small');
  assert.equal(result.truncated, false);
  assert.equal(result.reviewComplete, true);
  assert.deepEqual(Array.from(result.unreviewedPaths), []);
  assert.equal(agent.getToolCapabilities().commandExecution, false);
  assert.equal(agent.validateTaskComplete().success, true);
  assert.equal(agent.agentRunner.validateTaskCompletion({
    requiresModification: true, successfulWriteCount: 2,
  }).accepted, true);
});

test('truncated global diff identifies every remaining path and path reviews unblock completion', async () => {
  const { agent, tracker } = fixture();
  create(tracker, 'a.js', 'a'.repeat(6500));
  create(tracker, 'b.js', 'b'.repeat(6500));
  const result = await diffTool(agent, {}, 'global-large');
  assert.equal(result.truncated, true);
  assert.equal(result.reviewComplete, false);
  assert.deepEqual(Array.from(result.unreviewedPaths), ['a.js', 'b.js']);
  assert.match(result.reviewInstruction, /get_diff\(\{ path \}\)/);
  const blocked = agent.validateTaskComplete();
  assert.equal(blocked.error.code, 'CHANGES_NOT_REVIEWED');
  assert.deepEqual(Array.from(blocked.error.unreviewedPaths), ['a.js', 'b.js']);
  assert.equal(blocked.error.globalDiffTruncated, true);
  assert.match(blocked.error.message, /get_diff\(\{ path \}\)/);
  const a = await diffTool(agent, { path: 'a.js' }, 'path-a');
  assert.equal(a.reviewComplete, false);
  assert.deepEqual(Array.from(a.unreviewedPaths), ['b.js']);
  const b = await diffTool(agent, { path: 'b.js' }, 'path-b');
  assert.equal(b.reviewComplete, true);
  assert.equal(agent.validateTaskComplete().success, true);
  const diagnostic = tracker.getCompletionDiagnostics();
  assert.equal(diagnostic.globalDiffTruncated, true);
  assert.deepEqual(Array.from(diagnostic.reviewedFiles), ['a.js', 'b.js']);
});

test('a write invalidates only its own file review', async () => {
  const { agent, tracker } = fixture();
  create(tracker, 'a.js', 'one');
  create(tracker, 'b.js', 'two');
  await diffTool(agent, { path: 'a.js' }, 'review-a');
  await diffTool(agent, { path: 'b.js' }, 'review-b');
  const aVersion = tracker.current.changes.get('a.js').version;
  modify(tracker, 'b.js', 'two', 'three');
  assert.equal(tracker.current.changes.get('a.js').version, aVersion);
  assert.equal(tracker.current.changes.get('a.js').reviewedVersion, aVersion);
  assert.deepEqual(Array.from(tracker.getUnreviewedPaths()), ['b.js']);
  await diffTool(agent, { path: 'b.js' }, 'review-b-again');
  assert.equal(agent.validateTaskComplete().success, true);
});

test('a new write after full global review retains untouched file reviews', async () => {
  const { agent, tracker } = fixture();
  create(tracker, 'a.js', 'one');
  create(tracker, 'b.js', 'two');
  await diffTool(agent, {}, 'review-all');
  modify(tracker, 'b.js', 'two', 'three');
  assert.deepEqual(Array.from(tracker.getUnreviewedPaths()), ['b.js']);
  assert.equal(tracker.getCompletionDiagnostics().globalDiffReviewed, false);
  await diffTool(agent, { path: 'b.js' }, 'review-updated');
  assert.equal(agent.validateTaskComplete().success, true);
});

test('a recovered write failure is removed before completion', async () => {
  const { agent, tracker } = fixture();
  let attempt = 0;
  agent.registerTool('recover_write', {
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: () => ++attempt === 1
      ? { success: false, error: { code: 'TOOL_ARGUMENTS_TRUNCATED', message: 'retry in chunks' } }
      : { success: true, path: 'a.js' },
  });
  const failed = await agent.executeToolCall(call('recover_write', { path: 'a.js' }, 'failed'), { runId: 1 });
  assert.equal(failed.success, false);
  assert.equal(tracker.validateTaskComplete().error.code, 'UNRESOLVED_FAILURES');
  const recovered = await agent.executeToolCall(call('recover_write', { path: 'a.js' }, 'recovered'), { runId: 1 });
  assert.equal(recovered.success, true);
  assert.equal(tracker.current.unresolvedFailures.size, 0);
  create(tracker, 'a.js', 'recovered content');
  await diffTool(agent, { path: 'a.js' }, 'review-recovery');
  assert.equal(agent.validateTaskComplete().success, true);
});

test('no-change read-only completion has no diff review requirement', () => {
  const { agent } = fixture();
  assert.equal(agent.validateTaskComplete().success, true);
});

test('runner sends structured remaining paths after rejected task_complete', async () => {
  const { agent } = fixture();
  let turn = 0;
  const plan = [
    call('get_diff', {}, 'global'),
    call('task_complete', {}, 'done-first'),
    call('get_diff', { path: 'a.js' }, 'review-a'),
    call('get_diff', { path: 'b.js' }, 'review-b'),
    call('task_complete', {}, 'done-final'),
  ];
  agent.api.aiChat = async () => {
    if (turn++ === 0) {
      create(agent.runChangeTracker, 'a.js', 'a'.repeat(6500));
      create(agent.runChangeTracker, 'b.js', 'b'.repeat(6500));
    }
    return { choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', content: null, tool_calls: [plan[turn - 1]],
    } }] };
  };
  agent.setProvider({ id: 'mock', baseURL: 'https://mock.invalid' });
  agent.setModel('mock');
  agent.permissions = 'code';
  const result = await agent.execute('Review and complete the project changes');
  assert.equal(result.taskComplete, true);
  const rejected = agent.messages.find((message) => message.role === 'tool' && message.tool_call_id === 'done-first');
  assert.ok(rejected);
  const payload = JSON.parse(rejected.content);
  assert.equal(payload.success, false);
  assert.equal(payload.error.code, 'CHANGES_NOT_REVIEWED');
  assert.deepEqual(payload.error.unreviewedPaths, ['a.js', 'b.js']);
});
