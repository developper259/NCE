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
