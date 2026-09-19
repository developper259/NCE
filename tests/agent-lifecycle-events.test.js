const test = require("node:test");
const assert = require("node:assert/strict");
const { createAgent } = require("./helpers/agent-runtime");

function editor(root = "/workspace") {
  return {
    api: {},
    fileExplorer: { rootPath: root },
    tabManager: {
      activeFile: null,
      getFileByPath() {
        return null;
      },
    },
  };
}

function okResponse(
  content = "ok",
  usage = { prompt_tokens: 10, completion_tokens: 5 },
) {
  return {
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content },
      },
    ],
    usage,
  };
}

function toolCallResponse(name, args = {}, id = "call_1") {
  return {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function collectEvents(agent, names) {
  const events = [];
  for (const name of names) {
    agent.subscribe(name, (payload) => {
      events.push({ type: name, payload });
    });
  }
  return events;
}

function setupAgent(overrides = {}) {
  const e = editor(overrides.root);
  const agent = createAgent(e);
  agent.setProvider({
    id: overrides.providerId || "mock",
    baseURL: "https://mock.invalid",
    apiKey: overrides.apiKey || "SUPER_SECRET_API_KEY",
    headers: {
      Authorization: overrides.authorization || "Bearer SUPER_SECRET_TOKEN",
    },
    requiresApiKey: false,
    supportsTools: true,
  });
  agent.setModel(overrides.model || "mock-model");
  agent.waitForModelRetry = async () => {};
  agent.getModelRetryDelay = () => 0;
  agent.maxProviderRetries = overrides.maxProviderRetries ?? 2;
  agent.maxModelFallbacks = overrides.maxModelFallbacks ?? 3;
  if (overrides.maxIterations != null) {
    agent.maxIterations = overrides.maxIterations;
  }
  return { agent, editor: e };
}

function mockChat(agent, impl) {
  agent.api.aiChat = impl;
}

test("lifecycle: run success emits run:start/end exactly once", async () => {
  const { agent } = setupAgent();
  const events = collectEvents(agent, ["run:start", "run:end"]);
  mockChat(agent, async () => okResponse("Hello world"));

  const result = await agent.execute("test message", { sessionId: "s1" });

  const starts = events.filter((e) => e.type === "run:start");
  const ends = events.filter((e) => e.type === "run:end");
  assert.equal(starts.length, 1);
  assert.equal(ends.length, 1);
  assert.equal(starts[0].payload.sessionId, "s1");
  assert.equal(ends[0].payload.sessionId, "s1");
  assert.equal(starts[0].payload.runId, ends[0].payload.runId);
  assert.equal(ends[0].payload.status, "completed");
  assert.ok(ends[0].payload.metrics);
  assert.equal(agent.runChangeTracker.current.status, "completed");
  assert.equal(result.response, "Hello world");
});

test("lifecycle: provider failure emits run:end failed exactly once", async () => {
  const { agent } = setupAgent();
  const events = collectEvents(agent, ["run:start", "run:end"]);
  let onErrorCalled = 0;
  agent.setCallbacks({
    onError: () => {
      onErrorCalled += 1;
    },
  });
  mockChat(agent, async () => {
    throw Object.assign(new Error("invalid request schema"), {
      status: 400,
      code: "INVALID_REQUEST",
    });
  });

  await assert.rejects(() => agent.execute("fail please"));

  const ends = events.filter((ev) => ev.type === "run:end");
  assert.equal(events.filter((ev) => ev.type === "run:start").length, 1);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].payload.status, "failed");
  assert.ok(ends[0].payload.error);
  assert.equal(ends[0].payload.error.apiKey, undefined);
  assert.equal(onErrorCalled, 1);
  assert.equal(agent.runChangeTracker.current.status, "failed");
});

test("lifecycle: abort via stop emits run:end aborted exactly once", async () => {
  const { agent } = setupAgent();
  const events = collectEvents(agent, ["run:start", "run:end"]);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  mockChat(agent, async () => {
    await gate;
    if (agent.abortController?.signal?.aborted || agent.stopRequested) {
      throw agent.abortError();
    }
    return okResponse();
  });

  const executePromise = agent.execute("slow");
  await new Promise((r) => setTimeout(r, 10));
  agent.stop();
  release();

  await assert.rejects(() => executePromise);

  const ends = events.filter((ev) => ev.type === "run:end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0].payload.status, "aborted");
});

test("lifecycle: abort during run_tests cancels process and ends once", async () => {
  const { agent } = setupAgent();
  const events = collectEvents(agent, [
    "run:start",
    "run:end",
    "tool:start",
    "tool:end",
  ]);
  let cancelCalls = 0;
  agent.api.cancelAgentProcess = async () => {
    cancelCalls += 1;
  };

  let attempts = 0;
  mockChat(agent, async () => {
    attempts += 1;
    if (attempts === 1) {
      return toolCallResponse("run_tests", {});
    }
    return okResponse("done");
  });

  agent.registerTool("run_tests", {
    readOnly: true,
    parameters: { type: "object", properties: {} },
    async execute() {
      agent.activeTestRequestId = "test-req-1";
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (agent.abortController?.signal?.aborted || agent.stopRequested) {
        throw agent.abortError();
      }
      return { success: true, status: "PASSED" };
    },
  });

  const executePromise = agent.execute("run tests");
  await new Promise((r) => setTimeout(r, 15));
  agent.stop();

  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await executePromise;
  } catch {
    // expected abort
  }
  await new Promise((r) => setTimeout(r, 20));
  process.off("unhandledRejection", onUnhandled);

  assert.equal(cancelCalls, 1);
  const ends = events.filter((ev) => ev.type === "run:end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0].payload.status, "aborted");
  const toolStarts = events.filter((ev) => ev.type === "tool:start");
  const toolEnds = events.filter((ev) => ev.type === "tool:end");
  assert.equal(toolStarts.length, toolEnds.length);
  assert.equal(unhandled.length, 0);
});

test("lifecycle: MAX_ITERATIONS_REACHED ends failed exactly once", async () => {
  const { agent } = setupAgent({ maxIterations: 1 });
  const events = collectEvents(agent, ["run:start", "run:end"]);
  mockChat(agent, async () => toolCallResponse("read_file", { path: "a.js" }));
  // Override existing read_file if present
  agent.registerTool("read_file", {
    readOnly: true,
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    execute: async () => ({ success: true, content: "x" }),
  });

  await assert.rejects(() => agent.execute("loop"), (error) => {
    assert.equal(error.code, "MAX_ITERATIONS_REACHED");
    return true;
  });

  const ends = events.filter((ev) => ev.type === "run:end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0].payload.status, "failed");
  assert.equal(ends[0].payload.error.code, "MAX_ITERATIONS_REACHED");
});

test("lifecycle: task_complete rejected then accepted", async () => {
  const { agent } = setupAgent();
  const events = collectEvents(agent, ["run:start", "run:end"]);
  let attempts = 0;
  let completions = 0;

  mockChat(agent, async () => {
    attempts += 1;
    if (attempts <= 2) {
      return toolCallResponse(
        "task_complete",
        { summary: "done", validation: "ok" },
        `tc_${attempts}`,
      );
    }
    return okResponse("finished");
  });

  const originalValidate = agent.validateTaskComplete.bind(agent);
  agent.validateTaskComplete = (args) => {
    completions += 1;
    if (completions === 1) {
      return {
        success: false,
        error: {
          code: "TASK_INCOMPLETE",
          message: "still incomplete",
        },
      };
    }
    return originalValidate(args);
  };

  const result = await agent.execute("complete it");
  assert.ok(completions >= 1);
  const ends = events.filter((ev) => ev.type === "run:end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0].payload.status, "completed");
  assert.ok(result);
});

test("lifecycle: tool:start/end pairing for success, result false, throw, abort", async () => {
  const { agent } = setupAgent();
  const events = collectEvents(agent, ["tool:start", "tool:end"]);
  agent.activeRunState = { runId: 99, ended: false, sessionId: null };
  agent.runId = 99;
  agent.currentSessionId = null;

  agent.registerTool("t_ok", {
    readOnly: true,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ success: true, value: 1 }),
  });
  await agent.executeToolCall(
    { id: "c1", function: { name: "t_ok", arguments: "{}" } },
    { runId: 99 },
  );

  agent.registerTool("t_false", {
    readOnly: true,
    parameters: { type: "object", properties: {} },
    execute: async () => ({
      success: false,
      error: { code: "X", message: "nope" },
    }),
  });
  await agent.executeToolCall(
    { id: "c2", function: { name: "t_false", arguments: "{}" } },
    { runId: 99 },
  );

  agent.registerTool("t_throw", {
    readOnly: true,
    parameters: { type: "object", properties: {} },
    execute: async () => {
      throw new Error("boom");
    },
  });
  await agent.executeToolCall(
    { id: "c3", function: { name: "t_throw", arguments: "{}" } },
    { runId: 99 },
  );

  agent.abortController = new AbortController();
  agent.registerTool("t_abort", {
    readOnly: true,
    parameters: { type: "object", properties: {} },
    execute: async () => {
      agent.abortController.abort();
      throw agent.abortError();
    },
  });
  await agent.executeToolCall(
    { id: "c4", function: { name: "t_abort", arguments: "{}" } },
    { runId: 99 },
  );

  const starts = events.filter((e) => e.type === "tool:start");
  const ends = events.filter((e) => e.type === "tool:end");
  assert.equal(starts.length, 4);
  assert.equal(ends.length, 4);
  for (const start of starts) {
    const end = ends.find(
      (e) => e.payload.toolCallId === start.payload.toolCallId,
    );
    assert.ok(end, `missing tool:end for ${start.payload.toolCallId}`);
  }
  assert.equal(ends[0].payload.status, "success");
  assert.equal(ends[1].payload.status, "failed");
  assert.equal(ends[2].payload.status, "failed");
  assert.equal(ends[3].payload.status, "aborted");

  // Contract: rejected BEFORE execution (schema) does not emit tool:start.
  const before = events.length;
  agent.registerTool("t_required", {
    readOnly: true,
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    execute: async () => ({ success: true }),
  });
  const rejected = await agent.executeToolCall(
    { id: "c5", function: { name: "t_required", arguments: "{}" } },
    { runId: 99 },
  );
  assert.equal(rejected.success, false);
  assert.equal(events.length, before);
});

test("lifecycle: run_tests FAILED is tool infrastructure success", async () => {
  const { agent } = setupAgent();
  const events = collectEvents(agent, ["tool:start", "tool:end"]);
  agent.activeRunState = { runId: 7, ended: false };
  agent.runId = 7;
  agent.registerTool("run_tests", {
    readOnly: true,
    parameters: { type: "object", properties: {} },
    execute: async () => ({
      success: true,
      status: "FAILED",
      summary: "1 failed",
    }),
  });
  const result = await agent.executeToolCall(
    { id: "rt1", function: { name: "run_tests", arguments: "{}" } },
    { runId: 7 },
  );
  assert.equal(result.success, true);
  const end = events.find((e) => e.type === "tool:end");
  assert.equal(end.payload.status, "success");
  const nested =
    end.payload.result?.result?.status ||
    end.payload.result?.status ||
    end.payload.result?.result?.result?.status;
  assert.equal(nested, "FAILED");
});

test("lifecycle: model retry timeline keeps requestId and increments attempt", async () => {
  const { agent } = setupAgent({ maxProviderRetries: 2 });
  const events = collectEvents(agent, [
    "model:request:start",
    "model:request:end",
    "model:retry",
    "model:fallback",
    "run:start",
    "run:end",
  ]);
  let attempts = 0;
  mockChat(agent, async () => {
    attempts += 1;
    if (attempts === 1) {
      throw Object.assign(new Error("network connection reset"), {
        code: "NETWORK_ERROR",
      });
    }
    return okResponse("recovered");
  });

  await agent.execute("retry me");

  const timeline = events
    .filter((e) => e.type.startsWith("model:"))
    .map((e) => ({
      type: e.type,
      attempt: e.payload.attempt,
      requestId: e.payload.requestId,
      status: e.payload.status,
      model: e.payload.model,
    }));

  assert.equal(timeline[0].type, "model:request:start");
  assert.equal(timeline[0].attempt, 1);
  assert.equal(timeline[1].type, "model:request:end");
  assert.equal(timeline[1].attempt, 1);
  assert.equal(timeline[1].status, "failed");
  assert.equal(timeline[2].type, "model:retry");
  assert.equal(timeline[2].attempt, 2);
  assert.equal(timeline[3].type, "model:request:start");
  assert.equal(timeline[3].attempt, 2);
  assert.equal(timeline[4].type, "model:request:end");
  assert.equal(timeline[4].status, "success");
  assert.equal(new Set(timeline.map((t) => t.requestId)).size, 1);
  assert.equal(events.filter((e) => e.type === "model:fallback").length, 0);
  assert.equal(
    events.filter((e) => e.type === "run:end")[0].payload.status,
    "completed",
  );
});

test("lifecycle: model fallback timeline", async () => {
  const { agent } = setupAgent();
  agent.modelConfigResolver = (_agentId, providerId, model) => ({
    provider: {
      id: providerId,
      baseURL: "https://mock.invalid",
      requiresApiKey: false,
      supportsTools: true,
    },
    providerId,
    model,
    modelConfig: { id: model, name: model },
    contextWindow: 80000,
    maxTokens: 1024,
    supportsTools: true,
  });
  agent.fallbackChain = [{ provider: "fallback", model: "model-b" }];
  agent.setModel("model-a");
  agent.setProvider({
    id: "primary",
    baseURL: "https://mock.invalid",
    requiresApiKey: false,
    supportsTools: true,
  });

  const events = collectEvents(agent, [
    "model:request:start",
    "model:request:end",
    "model:retry",
    "model:fallback",
  ]);

  mockChat(agent, async ({ payload }) => {
    if (payload.model === "model-a") {
      throw Object.assign(new Error("model not found"), {
        status: 404,
        code: "MODEL_NOT_FOUND",
      });
    }
    return okResponse("from-b");
  });

  agent.modelRequestState = null;
  const config = agent.createRunConfig({
    runId: 1,
    sessionId: "s",
    providerId: "primary",
    model: "model-a",
  });
  config.provider = {
    id: "primary",
    baseURL: "https://mock.invalid",
    supportsTools: true,
  };
  config.fallbackChain = [{ provider: "fallback", model: "model-b" }];
  config.modelConfig = { id: "model-a", name: "model-a" };
  config.contextWindow = 80000;
  agent.runId = 1;
  agent.activeRunState = { runId: 1, ended: false, sessionId: "s" };
  agent.currentSessionId = "s";
  agent.messages = [{ role: "user", content: "hi" }];

  const result = await agent.requestModel(new AbortController(), config);
  assert.equal(result.choices[0].message.content, "from-b");

  const modelEvents = events.filter((e) => e.type.startsWith("model:"));
  assert.equal(modelEvents[0].type, "model:request:start");
  assert.equal(modelEvents[0].payload.model, "model-a");
  assert.equal(modelEvents[1].type, "model:request:end");
  assert.equal(modelEvents[1].payload.status, "failed");
  assert.equal(modelEvents[2].type, "model:fallback");
  assert.equal(modelEvents[2].payload.fromModel, "model-a");
  assert.equal(modelEvents[2].payload.toModel, "model-b");
  assert.equal(modelEvents[3].type, "model:request:start");
  assert.equal(modelEvents[3].payload.model, "model-b");
  assert.equal(modelEvents[3].payload.attempt, 2);
  assert.equal(modelEvents[4].type, "model:request:end");
  assert.equal(modelEvents[4].payload.status, "success");
  assert.equal(events.filter((e) => e.type === "model:fallback").length, 1);
  assert.equal(events.filter((e) => e.type === "model:retry").length, 0);
  assert.equal(
    modelEvents[0].payload.requestId,
    modelEvents[3].payload.requestId,
  );
});

test("lifecycle: context recovery keeps run completed without intermediate failed end", async () => {
  const { agent } = setupAgent();
  const events = collectEvents(agent, [
    "run:start",
    "run:end",
    "model:request:start",
    "model:request:end",
  ]);
  let requests = 0;
  mockChat(agent, async () => {
    requests += 1;
    if (requests === 1) {
      throw Object.assign(new Error("maximum context length exceeded"), {
        code: "CONTEXT_LENGTH_EXCEEDED",
      });
    }
    return okResponse("recovered");
  });

  const result = await agent.execute("recover context");
  assert.equal(result.response, "recovered");
  assert.equal(events.filter((e) => e.type === "run:end").length, 1);
  assert.equal(
    events.filter((e) => e.type === "run:end")[0].payload.status,
    "completed",
  );
  assert.equal(agent.lastRunMetrics.contextRecoveries, 1);
  const starts = events.filter((e) => e.type === "model:request:start");
  assert.ok(starts.length >= 2);
  assert.equal(starts[0].payload.requestId, starts[1].payload.requestId);
});

test("lifecycle: local context rejection does not consume a provider attempt", async () => {
  const { agent } = setupAgent();
  const events = collectEvents(agent, [
    "model:request:start",
    "model:request:end",
    "run:end",
  ]);
  const originalEstimate =
    agent.responseBudgetEstimator.estimateResponseBudget.bind(
      agent.responseBudgetEstimator,
    );
  let budgetChecks = 0;
  agent.responseBudgetEstimator.estimateResponseBudget = (input) => {
    budgetChecks += 1;
    const estimate = originalEstimate(input);
    if (budgetChecks === 1) {
      return { ...estimate, contextWindow: 1 };
    }
    return { ...estimate, contextWindow: 100000 };
  };
  let providerCalls = 0;
  mockChat(agent, async () => {
    providerCalls += 1;
    return okResponse("recovered locally");
  });

  const result = await agent.execute("recover before transport");
  assert.equal(result.response, "recovered locally");
  assert.equal(providerCalls, 1);
  const starts = events.filter((event) => event.type === "model:request:start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].payload.attempt, 1);
  assert.equal(
    events.find((event) => event.type === "model:request:end").payload.attempt,
    1,
  );
  assert.equal(
    events.find((event) => event.type === "run:end").payload.status,
    "completed",
  );
});

test("lifecycle: secret safety across run/model/error payloads", async () => {
  const { agent } = setupAgent({
    apiKey: "SUPER_SECRET_API_KEY",
    authorization: "Bearer SUPER_SECRET_TOKEN",
  });
  const events = collectEvents(agent, [
    "run:start",
    "run:end",
    "model:request:start",
    "model:request:end",
    "model:retry",
    "model:fallback",
  ]);

  mockChat(agent, async () => {
    const err = new Error(
      "Invalid API key SUPER_SECRET_API_KEY / Bearer SUPER_SECRET_TOKEN",
    );
    err.status = 401;
    err.apiKey = "SUPER_SECRET_API_KEY";
    err.authorization = "Bearer SUPER_SECRET_TOKEN";
    err.headers = { Authorization: "Bearer SUPER_SECRET_TOKEN" };
    err.body = { error: { message: "bad key SUPER_SECRET_API_KEY" } };
    throw err;
  });

  agent.maxProviderRetries = 0;
  agent.fallbackChain = [];
  agent.shouldFallbackModelForFailure = () => false;

  try {
    await agent.execute("secret probe");
  } catch {
    // expected
  }

  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes("SUPER_SECRET_API_KEY"), false);
  assert.equal(serialized.includes("SUPER_SECRET_TOKEN"), false);
  assert.equal(serialized.includes("[REDACTED]"), true);

  const normalized = agent.normalizeObservableError(
    Object.assign(new Error("x"), {
      apiKey: "SUPER_SECRET_API_KEY",
      authorization: "Bearer SUPER_SECRET_TOKEN",
      body: { secret: "SUPER_SECRET_TOKEN" },
      headers: { Authorization: "Bearer SUPER_SECRET_TOKEN" },
    }),
  );
  assert.equal(normalized.apiKey, undefined);
  assert.equal(normalized.authorization, undefined);
  assert.equal(normalized.body, undefined);
  assert.equal(normalized.headers, undefined);
});

test("lifecycle: no events after run:end", async () => {
  const { agent } = setupAgent();
  const events = collectEvents(agent, [
    "run:start",
    "run:end",
    "tool:start",
    "model:request:start",
    "response:token",
    "response:reasoning",
  ]);
  mockChat(agent, async () => okResponse("done"));
  await agent.execute("finish");
  const runId = events.find((e) => e.type === "run:end").payload.runId;
  const after = events.length;

  agent.emitEvent("tool:start", { runId, toolName: "late" });
  agent.emitEvent("model:request:start", { runId, requestId: "x", attempt: 1 });
  agent.emitEvent("response:token", { runId, content: "late" });
  agent.emitEvent("response:reasoning", { runId, content: "late" });

  assert.equal(events.length, after);
});

test("lifecycle: two sequential runs keep isolated runIds", async () => {
  const { agent } = setupAgent();
  const events = collectEvents(agent, [
    "run:start",
    "run:end",
    "model:request:start",
  ]);
  mockChat(agent, async () => okResponse("one"));
  await agent.execute("run1");
  mockChat(agent, async () => okResponse("two"));
  await agent.execute("run2");

  const starts = events.filter((e) => e.type === "run:start");
  const ends = events.filter((e) => e.type === "run:end");
  assert.equal(starts.length, 2);
  assert.equal(ends.length, 2);
  assert.notEqual(starts[0].payload.runId, starts[1].payload.runId);
  assert.equal(starts[0].payload.runId, ends[0].payload.runId);
  assert.equal(starts[1].payload.runId, ends[1].payload.runId);

  const models = events.filter((e) => e.type === "model:request:start");
  assert.equal(models[0].payload.runId, starts[0].payload.runId);
  assert.equal(models[1].payload.runId, starts[1].payload.runId);
});

test("lifecycle: stop then new run has no stale abort state", async () => {
  const { agent } = setupAgent();
  const events = collectEvents(agent, ["run:start", "run:end"]);

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  mockChat(agent, async () => {
    await gate;
    if (agent.stopRequested || agent.abortController?.signal?.aborted) {
      throw agent.abortError();
    }
    return okResponse("aborted-path");
  });
  const first = agent.execute("first");
  await new Promise((r) => setTimeout(r, 10));
  agent.stop();
  release();
  try {
    await first;
  } catch {
    // aborted
  }

  mockChat(agent, async () => okResponse("second-ok"));
  const result = await agent.execute("second");
  assert.equal(result.response, "second-ok");

  const ends = events.filter((e) => e.type === "run:end");
  assert.equal(ends.length, 2);
  assert.equal(ends[0].payload.status, "aborted");
  assert.equal(ends[1].payload.status, "completed");
  assert.notEqual(ends[0].payload.runId, ends[1].payload.runId);
  assert.equal(agent.stopRequested, false);
  assert.equal(agent.isRunning, false);
});

test("lifecycle: stopped run ends once while its replacement is already active", async () => {
  const { agent } = setupAgent();
  const events = collectEvents(agent, [
    "run:start",
    "run:end",
    "model:request:start",
    "tool:start",
    "response:token",
    "response:reasoning",
  ]);
  let releaseFirst;
  let releaseSecond;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const secondGate = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  let providerCalls = 0;
  mockChat(agent, async () => {
    providerCalls += 1;
    if (providerCalls === 1) await firstGate;
    if (providerCalls === 2) await secondGate;
    return okResponse(providerCalls === 1 ? "late-first" : "second");
  });

  const run1 = agent.execute("slow");
  while (events.filter((event) => event.type === "run:start").length < 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  agent.stop();
  const run2 = agent.execute("second");
  while (events.filter((event) => event.type === "run:start").length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const [run1Id, run2Id] = events
    .filter((event) => event.type === "run:start")
    .map((event) => event.payload.runId);
  assert.notEqual(run1Id, run2Id);

  releaseFirst();
  await assert.rejects(() => run1);
  assert.equal(agent.activeRunState?.runId, run2Id);
  releaseSecond();
  const settled = await Promise.allSettled([run1, run2]);
  assert.equal(settled[0].status, "rejected");
  assert.equal(settled[1].status, "fulfilled");

  for (const [runId, status] of [
    [run1Id, "aborted"],
    [run2Id, "completed"],
  ]) {
    assert.equal(
      events.filter(
        (event) => event.type === "run:start" && event.payload.runId === runId,
      ).length,
      1,
    );
    const ends = events.filter(
      (event) => event.type === "run:end" && event.payload.runId === runId,
    );
    assert.equal(ends.length, 1);
    assert.equal(ends[0].payload.status, status);
  }

  const run1EndIndex = events.findIndex(
    (event) => event.type === "run:end" && event.payload.runId === run1Id,
  );
  const operational = new Set([
    "tool:start",
    "model:request:start",
    "response:token",
    "response:reasoning",
  ]);
  assert.equal(
    events
      .slice(run1EndIndex + 1)
      .some(
        (event) =>
          operational.has(event.type) && event.payload.runId === run1Id,
      ),
    false,
  );
  assert.equal(agent.activeRunState, null);
});

test("lifecycle: legacy callbacks remain functional", async () => {
  const { agent } = setupAgent();
  const calls = {
    onFinish: 0,
    onSessionInfoUpdated: 0,
    onError: 0,
  };
  agent.setCallbacks({
    onToken: () => {},
    onReasoning: () => {},
    onToolStart: () => {},
    onToolEnd: () => {},
    onModelStatus: () => {},
    onError: () => {
      calls.onError += 1;
    },
    onFinish: () => {
      calls.onFinish += 1;
    },
    onSessionInfoUpdated: () => {
      calls.onSessionInfoUpdated += 1;
    },
    onAuthenticationRequired: async () => "replacement-key",
  });

  mockChat(agent, async () => okResponse("done"));
  await agent.execute("legacy");
  assert.equal(calls.onFinish, 1);
  assert.ok(calls.onSessionInfoUpdated >= 1);
  assert.equal(typeof agent.callbacks.onAuthenticationRequired, "function");

  mockChat(agent, async () => {
    throw Object.assign(new Error("invalid request schema"), {
      status: 400,
      code: "INVALID_REQUEST",
    });
  });
  await assert.rejects(() => agent.execute("legacy fail"));
  assert.equal(calls.onError, 1);
});

test("lifecycle: usage normalization is the single source", () => {
  const { agent } = setupAgent();
  const n = (u) => agent.modelClient.normalizeModelUsage(u);

  assert.equal(n({ prompt_tokens: 100, completion_tokens: 20 }).inputTokens, 100);
  assert.equal(n({ prompt_tokens: 100, completion_tokens: 20 }).outputTokens, 20);
  assert.equal(n({ prompt_tokens: 100, completion_tokens: 20 }).totalTokens, 120);
  assert.equal(n({ input_tokens: 11, output_tokens: 2 }).totalTokens, 13);
  assert.equal(n({ promptTokens: 5, completionTokens: 1 }).totalTokens, 6);
  const snakeTotal = n({ total_tokens: 123 });
  assert.equal(snakeTotal.inputTokens, null);
  assert.equal(snakeTotal.outputTokens, null);
  assert.equal(snakeTotal.totalTokens, 123);
  const camelTotal = n({ totalTokens: 123 });
  assert.equal(camelTotal.inputTokens, null);
  assert.equal(camelTotal.outputTokens, null);
  assert.equal(camelTotal.totalTokens, 123);
  assert.equal(n({}), null);
  assert.equal(n(null), null);
  assert.equal(n(undefined), null);
  assert.equal(
    n({ prompt_tokens: null, completion_tokens: null, total_tokens: null }),
    null,
  );
  const numericStrings = n({ input_tokens: "100", output_tokens: "20" });
  assert.equal(numericStrings.inputTokens, 100);
  assert.equal(numericStrings.outputTokens, 20);
  assert.equal(numericStrings.totalTokens, 120);
  assert.equal(n({ prompt_tokens: 100 }).outputTokens, null);
  assert.equal(n({ prompt_tokens: 100 }).totalTokens, null);
  assert.equal(
    n({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 99 }).totalTokens,
    99,
  );

  agent.modelRequestState = { previousOutputUsage: [] };
  agent.modelClient.recordPreviousOutputUsage({
    usage: { completion_tokens: 7 },
  });
  assert.deepEqual(agent.modelRequestState.previousOutputUsage, [7]);
});

test("lifecycle: metrics reset each run and expose callbackFailures", async () => {
  const { agent } = setupAgent();
  agent.subscribe("run:start", () => {
    throw new Error("observer fail");
  });
  mockChat(agent, async () => okResponse("ok"));
  await agent.execute("m1");
  assert.ok(agent.lastRunMetrics.callbackFailures >= 1);
  await agent.execute("m2");
  assert.ok(agent.lastRunMetrics.callbackFailures >= 1);
  assert.ok("callbackFailures" in agent.agentProgress.getMetrics());
});
