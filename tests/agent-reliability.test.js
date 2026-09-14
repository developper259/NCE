const test = require("node:test");
const assert = require("node:assert/strict");
const { createAgent } = require("./helpers/agent-runtime");

function editor(root = "/workspace") {
  return {
    api: {},
    fileExplorer: { rootPath: root },
    tabManager: { activeFile: null, getFileByPath() { return null; } },
  };
}

function call(name, args = {}, id = "call-1") {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

test("task_complete is a request and only the runner commits completed state", async () => {
  const agent = createAgent(editor());
  agent.runId = 1;
  agent.runChangeTracker.beginRun(1, "/workspace");
  const result = await agent.executeToolCall(call("task_complete"), { runId: 1 });
  assert.equal(result.success, true);
  assert.equal(result.result.taskCompleteRequested, true);
  assert.equal(agent.runChangeTracker.current.status, "running");
  assert.equal(agent.agentRunner.commitRunCompleted(1), true);
  assert.equal(agent.runChangeTracker.current.status, "completed");
  assert.equal(agent.runChangeTracker.setRunStatus("running", 1).status, "completed");
});

test("pending calls are visible while executing and always cleared after success or throw", async () => {
  const agent = createAgent(editor());
  agent.runId = 1;
  agent.runChangeTracker.beginRun(1, "/workspace");
  let release;
  agent.registerTool("slow_read", {
    readOnly: true,
    parameters: { type: "object", properties: {} },
    execute: () => new Promise((resolve) => { release = resolve; }),
  });
  const pending = agent.executeToolCall(call("slow_read", {}, "slow"), { runId: 1 });
  await Promise.resolve();
  assert.equal(agent.runChangeTracker.current.pendingToolCalls.size, 1);
  assert.equal(agent.validateTaskComplete().error.code, "RUN_NOT_SETTLED");
  release({ success: true });
  await pending;
  assert.equal(agent.runChangeTracker.current.pendingToolCalls.size, 0);

  agent.registerTool("throws", {
    readOnly: true,
    parameters: { type: "object", properties: {} },
    execute() { throw new Error("boom"); },
  });
  assert.equal((await agent.executeToolCall(call("throws", {}, "throws"), { runId: 1 })).success, false);
  assert.equal(agent.runChangeTracker.current.pendingToolCalls.size, 0);
});

test("callback exceptions are isolated from tool execution", async () => {
  const agent = createAgent(editor());
  agent.runId = 1;
  agent.runChangeTracker.beginRun(1, "/workspace");
  let executions = 0;
  agent.registerTool("safe_read", {
    readOnly: true,
    parameters: { type: "object", properties: {} },
    execute() { executions += 1; return { success: true, value: 1 }; },
  });
  agent.setCallbacks({
    onToolStart() { throw new Error("start UI"); },
    onToolEnd() { throw new Error("end UI"); },
    onToken() { throw new Error("token UI"); },
    onReasoning() { throw new Error("reasoning UI"); },
    onModelStatus() { throw new Error("status UI"); },
    onFinish() { throw new Error("finish UI"); },
  });
  assert.equal((await agent.executeToolCall(call("safe_read"), { runId: 1 })).success, true);
  agent.agentRunner.emitModelOutput("assistant", "ok", { runId: 1, requestId: "r" });
  agent.agentRunner.emitModelOutput("reasoning", "why", { runId: 1, requestId: "r" });
  agent.modelClient.emitModelStatus({ kind: "retry" }, { runId: 1 });
  agent.safeInvokeCallback("onFinish", [{ response: "ok" }, { runId: 1 }]);
  assert.equal(executions, 1);
  assert.equal(agent.agentProgress.metrics.callbackFailures, 6);
});

test("tool replay is exactly once and an ID collision is rejected", async () => {
  const agent = createAgent(editor());
  agent.runId = 1;
  agent.runChangeTracker.beginRun(1, "/workspace");
  let executions = 0;
  agent.registerTool("mutation", {
    readOnly: false,
    parameters: { type: "object", required: ["value"], properties: { value: { type: "integer" } } },
    execute() { executions += 1; return { success: true }; },
  });
  const first = call("mutation", { value: 1 }, "same-id");
  assert.equal((await agent.executeToolCall(first, { runId: 1 })).success, true);
  assert.equal((await agent.executeToolCall(first, { runId: 1 })).success, true);
  const conflict = await agent.executeToolCall(call("mutation", { value: 2 }, "same-id"), { runId: 1 });
  assert.equal(conflict.error.code, "TOOL_CALL_ID_CONFLICT");
  assert.equal(executions, 1);
});

test("workspace mutation lane serializes conflicting operations", async () => {
  const agent = createAgent(editor());
  agent.runId = 1;
  agent.runChangeTracker.beginRun(1, "/workspace");
  let active = 0;
  let peak = 0;
  agent.registerTool("mutation", {
    readOnly: false,
    parameters: { type: "object", properties: {} },
    async execute() {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { success: true };
    },
  });
  await Promise.all([
    agent.executeToolCall(call("mutation", {}, "a"), { runId: 1 }),
    agent.executeToolCall(call("mutation", {}, "b"), { runId: 1 }),
  ]);
  assert.equal(peak, 1);
  assert.equal(agent.runChangeTracker.current.pendingToolCalls.size, 0);
});

test("a new run is not deadlocked by an abandoned mutation lane", async () => {
  const agent = createAgent(editor());
  agent.runId = 1;
  agent.runChangeTracker.beginRun(1, "/workspace");
  const releaseOld = await agent.toolExecutor.acquireMutationLane({ runId: 1 });
  agent.runChangeTracker.setRunStatus("aborted", 1);
  agent.runId = 2;
  agent.runChangeTracker.beginRun(2, "/workspace");
  const started = Date.now();
  const releaseNew = await agent.toolExecutor.acquireMutationLane({ runId: 2 });
  assert.ok(Date.now() - started < 1000);
  assert.equal(agent.getMutationGuardError(1)?.code, "RUN_ABORTED");
  releaseNew();
  releaseOld();
});

test("failure identities are path-specific and reread resolves only matching concurrency failures", () => {
  const agent = createAgent(editor());
  agent.runId = 1;
  agent.runChangeTracker.beginRun(1, "/workspace");
  agent.runChangeTracker.addUnresolvedFailure({ toolName: "modify_file", path: "a.js", error: { code: "STALE_REVISION" } });
  agent.runChangeTracker.addUnresolvedFailure({ toolName: "modify_file", path: "b.js", error: { code: "STALE_REVISION" } });
  assert.equal(agent.runChangeTracker.current.unresolvedFailures.size, 2);
  agent.runChangeTracker.resolveFailuresForPath("a.js", ["STALE_REVISION"]);
  assert.equal(agent.runChangeTracker.current.unresolvedFailures.size, 1);
  assert.equal([...agent.runChangeTracker.current.unresolvedFailures.values()][0].path, "b.js");
});

test("line diff keeps an insertion local and path identity never uses suffix matching", () => {
  const agent = createAgent(editor("C:/Users/foo/project"));
  agent.runId = 1;
  agent.runChangeTracker.beginRun(1, "C:/Users/foo/project");
  const diff = agent.runChangeTracker.unifiedDiffLines("a\nb\nc", "a\ninserted\nb\nc");
  assert.equal(diff.filter((line) => line.startsWith("+")).join("\n"), "+inserted");
  assert.equal(agent.runChangeTracker.normalizePath("C:\\Users\\foo\\project\\src\\a.js"), "src/a.js");
  assert.equal(agent.runChangeTracker.normalizePath("archive/src/a.js") === agent.runChangeTracker.normalizePath("src/a.js"), false);
});

test("response budget controls provider max_tokens and keeps the context inequality", async () => {
  let captured;
  const e = editor();
  e.api.aiChat = async ({ payload }) => {
    captured = payload;
    return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }] };
  };
  const agent = createAgent(e);
  agent.setProvider({ id: "mock", baseURL: "https://mock.invalid" });
  agent.setModel("mock");
  agent.contextWindow = 4096;
  agent.modelConfig = { maxOutputTokens: 2048 };
  agent.responseBudget.contextCompactionSafetyMarginTokens = 128;
  const config = agent.createRunConfig({ runId: 1 });
  agent.messages = [{ role: "user", content: "hello" }];
  await agent.requestModel(new AbortController(), config);
  const prompt = agent.estimateTokens(captured.messages);
  assert.ok(captured.max_tokens > 0);
  assert.ok(captured.max_tokens <= 2048);
  assert.ok(prompt + captured.max_tokens + 128 <= 4096);
});

test("read pagination resumes after the last model-visible line", async () => {
  const content = Array.from({ length: 300 }, (_, index) =>
    `${String(index + 1).padStart(3, "0")}:${"x".repeat(90)}`,
  ).join("\n");
  const e = editor();
  e.api.getFileContent = async (paths) => ({ [paths[0]]: content });
  const agent = createAgent(e);
  const first = await agent.readFile("long.txt", { startLine: 1, endLine: 200 });
  assert.equal(first.success, true);
  assert.equal(first.contentStartLine, 1);
  assert.ok(first.contentEndLine < 200);
  assert.equal(first.nextStartLine, first.contentEndLine + 1);
  const second = await agent.readFile("long.txt", {
    startLine: first.nextStartLine,
    endLine: 200,
  });
  assert.equal(second.startLine, first.nextStartLine);
  assert.match(second.content, new RegExp(`^${String(first.nextStartLine).padStart(3, "0")}:`));
});

test("coding response budget respects the Agent hard limit without collapsing to hundreds of tokens", () => {
  const agent = createAgent(editor());
  agent.maxTokens = 8192;
  agent.runConfig = { maxTokens: 8192 };
  const budget = agent.responseBudgetEstimator.estimateResponseBudget({
    agent,
    model: { maxTokens: 8192, maxOutputTokens: 64000, contextWindow: 256000 },
    runtimeState: { kind: "coding", largeWrite: { active: true } },
  });
  assert.equal(budget.hardOutputLimit, 8192);
  assert.ok(budget.effectiveMaxOutputTokens >= 4096);
  assert.ok(budget.effectiveMaxOutputTokens <= 8192);
});

test("provider accounting includes large tool schemas in the real input budget", async () => {
  let payload;
  const e = editor();
  e.api.aiChat = async (request) => {
    payload = request.payload;
    return { choices: [{ message: { role: "assistant", content: "ok" } }] };
  };
  const agent = createAgent(e);
  agent.setProvider({ id: "mock", baseURL: "https://mock.invalid" });
  agent.setModel("mock");
  agent.contextWindow = 12000;
  agent.maxTokens = 4096;
  agent.registerTool("large_schema", {
    readOnly: true,
    description: "x".repeat(8000),
    parameters: { type: "object", properties: {} },
    execute: () => ({ success: true }),
  });
  agent.messages = [{ role: "user", content: "hello" }];
  await agent.requestModel(new AbortController(), agent.createRunConfig({ runId: 1 }));
  const metrics = agent.lastContextMetrics;
  assert.ok(metrics.toolSchemaTokens > 1000);
  assert.equal(metrics.estimatedInputTokens, metrics.messageTokens + metrics.toolSchemaTokens + metrics.toolChoiceTokens);
  assert.ok(metrics.estimatedInputTokens + payload.max_tokens + metrics.safetyMarginTokens <= metrics.contextWindow);
});

test("read_file paginates every character of a very long line without gaps", async () => {
  const content = "0123456789".repeat(5000);
  const e = editor();
  e.api.getFileContent = async (paths) => ({ [paths[0]]: content });
  const agent = createAgent(e);
  let column = 0;
  let rebuilt = "";
  do {
    const page = await agent.readFile("min.js", { startLine: 1, endLine: 1, startColumn: column });
    assert.equal(page.success, true);
    assert.equal(page.contentStartColumn, column);
    rebuilt += page.content;
    column = page.nextStartColumn;
  } while (column !== null);
  assert.equal(rebuilt, content);
});

test("change tracking composes modify, rename chains, real stats and mandatory diff review", () => {
  const agent = createAgent(editor());
  agent.runId = 1;
  const tracker = agent.runChangeTracker;
  tracker.beginRun(1, "/workspace");
  tracker.recordModify({ success: true, path: "a.js", beforeText: "one\ntwo", afterText: "one\nchanged", previousRevision: "r1", revision: "r2" });
  tracker.recordRename({ success: true, oldPath: "a.js", newPath: "b.js" });
  tracker.recordRename({ success: true, oldPath: "b.js", newPath: "c.js" });
  const change = tracker.current.changes.get("c.js");
  assert.equal(change.originalPath, "a.js");
  assert.equal(change.beforeContent, "one\ntwo");
  assert.equal(change.afterContent, "one\nchanged");
  assert.equal(change.additions, 1);
  assert.equal(change.deletions, 1);
  tracker.markReviewChangedFiles();
  assert.equal(tracker.validateTaskComplete().error.code, "CHANGES_NOT_REVIEWED");
  const diff = tracker.getDiff();
  assert.match(diff.diff, /-two/);
  assert.match(diff.diff, /\+changed/);
  tracker.markReviewDiff(null, diff);
  assert.equal(tracker.validateTaskComplete().success, true);
});

test("create overwrite is tracked as a modification with its original baseline", () => {
  const agent = createAgent(editor());
  agent.runId = 1;
  const tracker = agent.runChangeTracker;
  tracker.beginRun(1, "/workspace");
  tracker.recordCreate({
    success: true,
    path: "existing.js",
    overwritten: true,
    beforeText: "const value = 1;",
    content: "const value = 2;",
    revision: "r2",
  });
  const change = tracker.current.changes.get("existing.js");
  assert.equal(change.status, "modified");
  assert.equal(change.created, false);
  assert.equal(change.beforeContent, "const value = 1;");
  assert.equal(change.additions, 1);
  assert.equal(change.deletions, 1);
  assert.match(tracker.getDiff().diff, /--- a\/existing\.js/);
});

test("reread makes a write failure recovery-ready but only a successful write resolves it", () => {
  const agent = createAgent(editor());
  agent.runId = 1;
  const tracker = agent.runChangeTracker;
  tracker.beginRun(1, "/workspace");
  tracker.addUnresolvedFailure({ toolName: "modify_file", path: "a.js", error: { code: "STALE_REVISION" } });
  tracker.markFailuresRecoveryReady("a.js", ["STALE_REVISION"]);
  const pending = [...tracker.current.unresolvedFailures.values()][0];
  assert.equal(pending.status, "recovery_ready");
  assert.equal(tracker.validateTaskComplete().error.code, "UNRESOLVED_FAILURES");
  tracker.resolveFailuresForTool("modify_file", "a.js");
  assert.equal(tracker.current.unresolvedFailures.size, 0);
});

test("a 5000-line one-line edit produces a localized diff", () => {
  const agent = createAgent(editor());
  const before = Array.from({ length: 5000 }, (_, index) => `line ${index}`);
  const after = [...before];
  after[2499] = "changed";
  const result = agent.runChangeTracker.computeLineDiff(before.join("\n"), after.join("\n"));
  assert.equal(result.diffTooLarge, false);
  assert.ok(result.lines.length < 10);
  assert.deepEqual(Array.from(result.lines.slice(1)), ["+changed", "-line 2499"]);
});

test("an uncertain appended chunk is reconciled and never duplicated", async () => {
  const e = editor();
  let content = "ABC";
  let reads = 0;
  let saves = 0;
  e.api.pathExists = async () => true;
  e.api.saveFile = async (filePath, next) => {
    saves += 1;
    content = next;
    return filePath;
  };
  e.api.getFileContent = async (paths) => {
    reads += 1;
    if (reads === 2) throw new Error("verification unavailable");
    return { [paths[0]]: content };
  };
  const agent = createAgent(e);
  agent.api.pathExists = e.api.pathExists;
  agent.api.saveFile = e.api.saveFile;
  agent.api.getFileContent = e.api.getFileContent;
  agent.runId = 1;
  agent.runChangeTracker.beginRun(1, "/workspace");
  const revision = agent.getContentRevision(content);
  const first = await agent.writeWorkspaceFileChunk({ path: "large.txt", content: "DEF", expectedRevision: revision });
  assert.equal(first.mutationOutcome, "APPLIED_BUT_UNCERTAIN");
  const retry = await agent.writeWorkspaceFileChunk({ path: "large.txt", content: "DEF", expectedRevision: revision });
  assert.equal(retry.success, true);
  assert.equal(retry.reconciled, true);
  assert.equal(content, "ABCDEF");
  assert.equal(saves, 1);
});

test("fallback policy centralizes origin-aware rules", () => {
  const agent = createAgent(editor());
  assert.equal(agent.shouldFallbackModelForFailure({ failureOrigin: "task" }), false);
  assert.equal(agent.shouldFallbackModelForFailure({ failureOrigin: "tool" }), false);
  assert.equal(agent.shouldFallbackModelForFailure({ failureOrigin: "protocol" }), false);
  assert.equal(agent.shouldFallbackModelForFailure({ failureOrigin: "provider" }), true);
  assert.equal(agent.shouldFallbackModelForFailure({ failureOrigin: "context" }), false);
});

test("one model turn cannot create orphan protocol entries beyond the tool limit", async () => {
  const e = editor();
  let request = 0;
  e.api.aiChat = async () => {
    request += 1;
    if (request === 1) {
      return {
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: Array.from({ length: 50 }, (_, index) =>
              call("bounded_read", { index }, `read-${index}`)),
          },
        }],
      };
    }
    return {
      choices: [{
        finish_reason: "tool_calls",
        message: { role: "assistant", content: null, tool_calls: [call("task_complete", {}, "done")] },
      }],
    };
  };
  const agent = createAgent(e);
  agent.setProvider({ id: "mock", baseURL: "https://mock.invalid" });
  agent.setModel("mock");
  agent.maxToolCallsPerTurn = 7;
  let executions = 0;
  agent.registerTool("bounded_read", {
    readOnly: true,
    parameters: { type: "object", properties: { index: { type: "integer" } } },
    execute() { executions += 1; return { success: true }; },
  });
  await agent.execute("Inspect safely");
  assert.equal(executions, 7);
  const assistantCalls = agent.messages.filter((message) => message.role === "assistant" && message.tool_calls);
  assert.equal(assistantCalls[0].tool_calls.length, 7);
  const handled = new Set(agent.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id));
  for (const toolCall of assistantCalls.flatMap((message) => message.tool_calls)) {
    assert.equal(handled.has(toolCall.id), true);
  }
});

test("context length failure compacts once and retries the same candidate", async () => {
  const e = editor();
  let requests = 0;
  e.api.aiChat = async () => {
    requests += 1;
    if (requests === 1) {
      throw Object.assign(new Error("maximum context length exceeded"), {
        code: "CONTEXT_LENGTH_EXCEEDED",
      });
    }
    return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "recovered" } }] };
  };
  const agent = createAgent(e);
  agent.setProvider({ id: "mock", baseURL: "https://mock.invalid" });
  agent.setModel("mock");
  agent.contextWindow = 32768;
  const result = await agent.execute("Answer after recovery");
  assert.equal(result.response, "recovered");
  assert.equal(requests, 2);
  assert.equal(agent.lastRunMetrics.contextRecoveries, 1);
  assert.equal(agent.runChangeTracker.current.status, "completed");
});

test("a second context overflow falls back only to a larger tool-capable model", async () => {
  const agent = createAgent(editor());
  let attempts = 0;
  agent.modelClient.requestSingleModel = async (_controller, config) => {
    attempts += 1;
    if (config.model === "small") {
      throw Object.assign(new Error("maximum context length exceeded"), { code: "CONTEXT_LENGTH_EXCEEDED" });
    }
    return { choices: [{ message: { role: "assistant", content: "fallback" } }] };
  };
  agent.modelConfigResolver = (_agentId, providerId, model) => ({
    provider: { id: providerId, baseURL: "https://mock.invalid", requiresApiKey: false, supportsTools: model !== "no-tools" },
    providerId,
    model,
    modelConfig: { id: model },
    contextWindow: model === "large" ? 200000 : 1000,
    maxTokens: 8192,
    supportsTools: model !== "no-tools",
  });
  const config = {
    runId: 1,
    sessionId: 1,
    agentId: "coder",
    providerId: "primary",
    provider: { id: "primary", baseURL: "https://mock.invalid", supportsTools: true },
    model: "small",
    modelConfig: {},
    contextWindow: 40000,
    maxTokens: 8192,
    supportsTools: true,
    fallbackChain: [
      { provider: "fallback", model: "smaller" },
      { provider: "fallback", model: "no-tools" },
      { provider: "fallback", model: "large" },
    ],
  };
  const result = await agent.requestModel(new AbortController(), config);
  assert.equal(result.choices[0].message.content, "fallback");
  assert.equal(config.model, "large");
  assert.equal(attempts, 3);
});
