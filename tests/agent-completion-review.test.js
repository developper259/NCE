const test = require("node:test");
const assert = require("node:assert/strict");
const { createAgent } = require("./helpers/agent-runtime");

function fixture() {
  const editor = {
    api: {},
    fileExplorer: { rootPath: "/workspace" },
    tabManager: { activeFile: null, getFileByPath: () => null },
  };
  const agent = createAgent(editor);
  agent.runId = 1;
  agent.runChangeTracker.beginRun(1, "/workspace");
  return { agent, tracker: agent.runChangeTracker };
}
function create(tracker, path, content) {
  tracker.recordCreate({
    success: true,
    path,
    content,
    revision: `r-${content.length}`,
  });
}
function modify(tracker, path, before, after) {
  tracker.recordModify({
    success: true,
    path,
    beforeText: before,
    afterText: after,
    previousRevision: `r-${before.length}`,
    revision: `r-${after.length}`,
  });
}
function call(name, args = {}, id = `${name}-${Math.random()}`) {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}
async function diffTool(agent, args = {}, id = "diff") {
  const result = await agent.executeToolCall(call("get_diff", args, id), {
    runId: 1,
  });
  assert.equal(result.success, true, JSON.stringify(result));
  return result.result;
}

test("small global diff reviews all changed files and static completion is eligible", async () => {
  const { agent, tracker } = fixture();
  create(tracker, "index.html", "<main>Hi</main>");
  create(tracker, "css/main.css", "main { color: red; }");
  const listed = await agent.executeToolCall(
    call("get_changed_files", {}, "listed"),
    { runId: 1 },
  );
  assert.equal(listed.success, true);
  assert.equal(
    tracker.validateTaskComplete().error.code,
    "CHANGES_NOT_REVIEWED",
  );
  const result = await diffTool(agent, {}, "global-small");
  assert.equal(result.truncated, false);
  assert.equal(result.reviewComplete, true);
  assert.deepEqual(Array.from(result.unreviewedPaths), []);
  assert.equal(agent.getToolCapabilities().commandExecution, true);
  assert.equal(agent.validateTaskComplete().success, true);
  assert.equal(
    agent.agentRunner.validateTaskCompletion({
      requiresModification: true,
      successfulWriteCount: 2,
    }).accepted,
    true,
  );
});

test("truncated global diff identifies every remaining path and path reviews unblock completion", async () => {
  const { agent, tracker } = fixture();
  create(tracker, "a.js", "a".repeat(6500));
  create(tracker, "b.js", "b".repeat(6500));
  const result = await diffTool(agent, {}, "global-large");
  assert.equal(result.truncated, true);
  assert.equal(result.reviewComplete, false);
  assert.deepEqual(Array.from(result.unreviewedPaths), ["a.js", "b.js"]);
  assert.match(result.reviewInstruction, /get_diff\(\{ path \}\)/);
  const blocked = agent.validateTaskComplete();
  assert.equal(blocked.error.code, "CHANGES_NOT_REVIEWED");
  assert.deepEqual(Array.from(blocked.error.unreviewedPaths), ["a.js", "b.js"]);
  assert.equal(blocked.error.globalDiffTruncated, true);
  assert.match(blocked.error.message, /get_diff\(\{ path \}\)/);
  const a = await diffTool(agent, { path: "a.js" }, "path-a");
  assert.equal(a.reviewComplete, false);
  assert.deepEqual(Array.from(a.unreviewedPaths), ["b.js"]);
  const b = await diffTool(agent, { path: "b.js" }, "path-b");
  assert.equal(b.reviewComplete, true);
  assert.equal(agent.validateTaskComplete().success, true);
  const diagnostic = tracker.getCompletionDiagnostics();
  assert.equal(diagnostic.globalDiffTruncated, true);
  assert.deepEqual(Array.from(diagnostic.reviewedFiles), ["a.js", "b.js"]);
});

test("a write invalidates only its own file review", async () => {
  const { agent, tracker } = fixture();
  create(tracker, "a.js", "one");
  create(tracker, "b.js", "two");
  await diffTool(agent, { path: "a.js" }, "review-a");
  await diffTool(agent, { path: "b.js" }, "review-b");
  const aVersion = tracker.current.changes.get("a.js").version;
  modify(tracker, "b.js", "two", "three");
  assert.equal(tracker.current.changes.get("a.js").version, aVersion);
  assert.equal(tracker.current.changes.get("a.js").reviewedVersion, aVersion);
  assert.deepEqual(Array.from(tracker.getUnreviewedPaths()), ["b.js"]);
  await diffTool(agent, { path: "b.js" }, "review-b-again");
  assert.equal(agent.validateTaskComplete().success, true);
});

test("a large path diff is fully reviewable through bounded cursors", async () => {
  const { agent, tracker } = fixture();
  const content = Array.from(
    { length: 5000 },
    (_, index) => `print(${index})`,
  ).join("\n");
  create(tracker, "big.py", content);

  const pages = [];
  let result = await diffTool(agent, { path: "big.py" }, "big-page-1");
  while (true) {
    assert.ok(result.diff.length <= 12000);
    pages.push(result.diff);
    if (!result.hasMore) break;
    assert.equal(typeof result.nextCursor, "string");
    result = await diffTool(
      agent,
      { cursor: result.nextCursor },
      `big-page-${pages.length + 1}`,
    );
  }

  const expected = tracker.renderDiff(
    tracker.current.changes.get("big.py"),
  ).text;
  assert.equal(pages.join(""), expected);
  assert.equal(result.truncated, false);
  assert.equal(result.nextCursor, null);
  assert.equal(result.reviewComplete, true);
  assert.deepEqual(Array.from(tracker.getUnreviewedPaths()), []);
  assert.equal(agent.validateTaskComplete().success, true);
});

test("invalid and stale diff cursors never complete review", async () => {
  const { agent, tracker } = fixture();
  const before = Array.from(
    { length: 5000 },
    (_, index) => `old(${index})`,
  ).join("\n");
  create(tracker, "big.py", before);
  const first = await diffTool(agent, { path: "big.py" }, "cursor-start");
  assert.equal(first.hasMore, true);

  const invalid = await agent.executeToolCall(
    call("get_diff", { cursor: "not-a-real-cursor" }, "invalid-cursor"),
    { runId: 1 },
  );
  assert.equal(invalid.success, false);
  assert.equal(invalid.error.code, "INVALID_DIFF_CURSOR");
  assert.deepEqual(Array.from(tracker.getUnreviewedPaths()), ["big.py"]);

  modify(tracker, "big.py", before, `${before}\nprint("new")`);
  const stale = await agent.executeToolCall(
    call("get_diff", { cursor: first.nextCursor }, "stale-cursor"),
    { runId: 1 },
  );
  assert.equal(stale.success, false);
  assert.equal(stale.error.code, "STALE_DIFF_CURSOR");
  assert.notEqual(
    tracker.current.changes.get("big.py").reviewedVersion,
    tracker.current.changes.get("big.py").version,
  );
});

test("a new write after full global review retains untouched file reviews", async () => {
  const { agent, tracker } = fixture();
  create(tracker, "a.js", "one");
  create(tracker, "b.js", "two");
  await diffTool(agent, {}, "review-all");
  modify(tracker, "b.js", "two", "three");
  assert.deepEqual(Array.from(tracker.getUnreviewedPaths()), ["b.js"]);
  assert.equal(tracker.getCompletionDiagnostics().globalDiffReviewed, false);
  await diffTool(agent, { path: "b.js" }, "review-updated");
  assert.equal(agent.validateTaskComplete().success, true);
});

test("a recovered write failure is removed before completion", async () => {
  const { agent, tracker } = fixture();
  let attempt = 0;
  agent.registerTool("recover_write", {
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    execute: () =>
      ++attempt === 1
        ? {
            success: false,
            error: {
              code: "TOOL_ARGUMENTS_TRUNCATED",
              message: "retry in chunks",
            },
          }
        : { success: true, path: "a.js" },
  });
  const failed = await agent.executeToolCall(
    call("recover_write", { path: "a.js" }, "failed"),
    { runId: 1 },
  );
  assert.equal(failed.success, false);
  assert.equal(
    tracker.validateTaskComplete().error.code,
    "UNRESOLVED_FAILURES",
  );
  const recovered = await agent.executeToolCall(
    call("recover_write", { path: "a.js" }, "recovered"),
    { runId: 1 },
  );
  assert.equal(recovered.success, true);
  assert.equal(tracker.current.unresolvedFailures.size, 0);
  create(tracker, "a.js", "recovered content");
  await diffTool(agent, { path: "a.js" }, "review-recovery");
  assert.equal(agent.validateTaskComplete().success, true);
});

test("no-change read-only completion has no diff review requirement", () => {
  const { agent } = fixture();
  assert.equal(agent.validateTaskComplete().success, true);
});

test("fresh validation allows safe completion without get_diff", () => {
  const { agent, tracker } = fixture();
  create(tracker, "feature.py", "print('ok')");
  tracker.recordValidation({
    status: "PASSED",
    projectRoot: ".",
    scope: { mode: "project", projectRoot: "." },
    toolCallId: "validation-safe",
  });

  const completion = agent.validateTaskComplete();
  assert.equal(completion.success, true);
  assert.equal(completion.completionState, "SAFE");
  assert.equal(completion.reviewRequired, false);
  assert.equal(
    tracker.getCompletionDiagnostics().nextAction.tool,
    "task_complete",
  );
});

test("a large validated file can complete safely without get_diff", () => {
  const { agent, tracker } = fixture();
  const content = Array.from(
    { length: 5000 },
    (_, index) => `line(${index})`,
  ).join("\n");
  create(tracker, "large.py", content);
  tracker.recordValidation({
    status: "PASSED",
    projectRoot: ".",
    scope: { mode: "project", projectRoot: "." },
    toolCallId: "validation-large",
  });

  assert.equal(agent.validateTaskComplete().success, true);
});

test("deletions require explicit review even with fresh validation", async () => {
  const { agent, tracker } = fixture();
  modify(tracker, "important.js", "old", "new");
  tracker.recordDelete({ success: true, path: "important.js" }, "new");
  tracker.recordValidation({
    status: "PASSED",
    projectRoot: ".",
    scope: { mode: "project", projectRoot: "." },
    toolCallId: "validation-delete",
  });

  const blocked = agent.validateTaskComplete();
  assert.equal(blocked.error.code, "CHANGES_NOT_REVIEWED");
  assert.equal(blocked.error.reviewRequired, true);
  assert.ok(blocked.error.reviewReasons.includes("FILE_DELETED"));

  await diffTool(agent, { path: "important.js" }, "review-delete");
  assert.equal(agent.validateTaskComplete().success, true);
});

test("stale validation blocks completion until a fresh validation exists", () => {
  const { agent, tracker } = fixture();
  create(tracker, "feature.py", "one");
  tracker.recordValidation({
    status: "PASSED",
    projectRoot: ".",
    scope: { mode: "project", projectRoot: "." },
    toolCallId: "validation-before-change",
  });
  modify(tracker, "feature.py", "one", "two");

  const blocked = agent.validateTaskComplete();
  assert.equal(blocked.error.code, "VALIDATION_STALE");
  assert.equal(blocked.error.completionState, "BLOCKED");
});

test("safe completion still permits voluntary diff review", async () => {
  const { agent, tracker } = fixture();
  create(tracker, "feature.py", "print('ok')");
  tracker.recordValidation({
    status: "PASSED",
    projectRoot: ".",
    scope: { mode: "project", projectRoot: "." },
    toolCallId: "validation-voluntary-review",
  });

  const result = await diffTool(agent, { path: "feature.py" }, "voluntary");
  assert.equal(result.reviewComplete, true);
  assert.equal(agent.validateTaskComplete().success, true);
});

test("runner completes a validated safe run without injecting get_diff", async () => {
  const { agent } = fixture();
  let modelRequests = 0;
  agent.api.aiChat = async () => {
    modelRequests += 1;
    create(agent.runChangeTracker, "feature.py", "print('ok')");
    agent.runChangeTracker.recordValidation({
      status: "PASSED",
      projectRoot: ".",
      scope: { mode: "project", projectRoot: "." },
      toolCallId: "runner-validation-safe",
    });
    return {
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              call(
                "task_complete",
                { summary: "done", validation: "PASSED" },
                "runner-safe-complete",
              ),
            ],
          },
        },
      ],
    };
  };
  agent.setProvider({ id: "mock", baseURL: "https://mock.invalid" });
  agent.setModel("mock");
  agent.permissions = "code";

  const result = await agent.execute("Confirm the validated run");
  assert.equal(result.taskComplete, true);
  assert.equal(modelRequests, 1);
  assert.equal(
    agent.messages.some(
      (message) => message.role === "tool" && message.name === "get_diff",
    ),
    false,
  );
});

test("runner sends structured remaining paths after rejected task_complete", async () => {
  const { agent } = fixture();
  let turn = 0;
  const plan = [
    call("get_diff", {}, "global"),
    call("task_complete", {}, "done-first"),
    call("get_diff", { path: "a.js" }, "review-a"),
    call("get_diff", { path: "b.js" }, "review-b"),
    call("task_complete", {}, "done-final"),
  ];
  agent.api.aiChat = async () => {
    if (turn++ === 0) {
      create(agent.runChangeTracker, "a.js", "a".repeat(6500));
      create(agent.runChangeTracker, "b.js", "b".repeat(6500));
    }
    return {
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [plan[turn - 1]],
          },
        },
      ],
    };
  };
  agent.setProvider({ id: "mock", baseURL: "https://mock.invalid" });
  agent.setModel("mock");
  agent.permissions = "code";
  const result = await agent.execute("Review and complete the project changes");
  assert.equal(result.taskComplete, true);
  const rejected = agent.messages.find(
    (message) =>
      message.role === "tool" && message.tool_call_id === "done-first",
  );
  assert.ok(rejected);
  const payload = JSON.parse(rejected.content);
  assert.equal(payload.success, false);
  assert.equal(payload.error.code, "CHANGES_NOT_REVIEWED");
  assert.deepEqual(payload.error.unreviewedPaths, ["a.js", "b.js"]);
});
