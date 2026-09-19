const test = require("node:test");
const assert = require("node:assert/strict");
const { createAgent } = require("./helpers/agent-runtime");

function createBusAgent() {
  const agent = createAgent({
    api: {},
    fileExplorer: { rootPath: "/workspace" },
    tabManager: { activeFile: null, getFileByPath: () => null },
  });
  agent.agentProgress.reset();
  return agent;
}

test("AgentEventBus: multiple observers same event", () => {
  const agent = createBusAgent();
  let a = 0;
  let b = 0;
  agent.subscribe("test:event", () => {
    a += 1;
  });
  agent.subscribe("test:event", () => {
    b += 1;
  });
  agent.eventBus.emit("test:event", { ok: true });
  assert.equal(a, 1);
  assert.equal(b, 1);
});

test("AgentEventBus: unsubscribe and double unsubscribe", () => {
  const agent = createBusAgent();
  let calls = 0;
  const unsubscribe = agent.subscribe("test:event", () => {
    calls += 1;
  });
  agent.eventBus.emit("test:event", {});
  assert.equal(calls, 1);
  assert.equal(unsubscribe(), true);
  assert.equal(unsubscribe(), false);
  agent.eventBus.emit("test:event", {});
  assert.equal(calls, 1);
});

test("AgentEventBus: sync listener throw isolation", () => {
  const agent = createBusAgent();
  agent.agentProgress.metrics.callbackFailures = 0;
  let b = 0;
  agent.subscribe("test:event", () => {
    throw new Error("sync failure");
  });
  agent.subscribe("test:event", () => {
    b += 1;
  });
  agent.eventBus.emit("test:event", {});
  assert.equal(b, 1);
  assert.equal(agent.agentProgress.metrics.callbackFailures, 1);
});

test("AgentEventBus: async listener rejection isolation", async () => {
  const agent = createBusAgent();
  agent.agentProgress.metrics.callbackFailures = 0;
  let b = 0;
  const unhandled = [];
  const onUnhandled = (reason) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);

  agent.subscribe("test:event", async () => {
    throw new Error("async failure");
  });
  agent.subscribe("test:event", () => {
    b += 1;
  });

  agent.eventBus.emit("test:event", {});
  await new Promise((resolve) => setTimeout(resolve, 30));

  process.off("unhandledRejection", onUnhandled);
  assert.equal(b, 1);
  assert.equal(agent.agentProgress.metrics.callbackFailures, 1);
  assert.equal(unhandled.length, 0);
});

test("AgentEventBus: listener A fails but B still runs", () => {
  const agent = createBusAgent();
  const order = [];
  agent.subscribe("test:event", () => {
    order.push("A");
    throw new Error("A failed");
  });
  agent.subscribe("test:event", () => {
    order.push("B");
  });
  agent.eventBus.emit("test:event", {});
  assert.deepEqual(order, ["A", "B"]);
});

test("AgentEventBus: setCallbacks legacy + subscribe modern coexist", () => {
  const agent = createBusAgent();
  let modern = 0;
  let legacy = 0;
  agent.subscribe("run:start", () => {
    modern += 1;
  });
  agent.setCallbacks({
    onToken: () => {
      legacy += 1;
    },
  });
  agent.activeRunState = { runId: 1, ended: false };
  agent.emitEvent("run:start", { runId: 1 });
  assert.equal(modern, 1);
  assert.equal(typeof agent.callbacks.onToken, "function");
  agent.safeInvokeCallback("onToken", ["x"]);
  assert.equal(legacy, 1);
});

test("AgentEventBus: second setCallbacks does not remove modern subscription", () => {
  const agent = createBusAgent();
  let modern = 0;
  agent.subscribe("run:start", () => {
    modern += 1;
  });
  agent.setCallbacks({ onToken: () => {} });
  agent.setCallbacks({ onError: () => {} });
  agent.activeRunState = { runId: 2, ended: false };
  agent.emitEvent("run:start", { runId: 2 });
  assert.equal(modern, 1);
});

test("AgentEventBus: observer failure increments callbackFailures metric", () => {
  const agent = createBusAgent();
  agent.agentProgress.metrics.callbackFailures = 0;
  agent.subscribe("boom", () => {
    throw new Error("observer boom");
  });
  agent.eventBus.emit("boom", {});
  assert.equal(agent.agentProgress.metrics.callbackFailures, 1);
  assert.equal(
    agent.agentProgress.getMetrics().callbackFailures,
    1,
    "callbackFailures covers both legacy callbacks and EventBus observers",
  );
});
