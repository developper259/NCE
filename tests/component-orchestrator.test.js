"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const {
  ComponentOrchestrator,
} = require("../dist/ts/languages/ComponentOrchestrator.js");

const component = (id) => ({
  id,
  name: id,
  description: id,
  type: "runtime",
  packageId: `pkg-${id}`,
  platforms: ["darwin"],
});

const components = (...ids) => new Map(ids.map((id) => [id, component(id)]));

function fakeOperations(overrides = {}) {
  const calls = [];
  const installations = new Map();
  return {
    calls,
    installations,
    async install(packageId) {
      calls.push(["install", packageId]);
      const result = overrides.install?.(packageId) ?? { success: true };
      if (result.success) installations.set(packageId, `inst-${packageId}`);
      return result;
    },
    async verify(installationId) {
      calls.push(["verify", installationId]);
      return overrides.verify?.(installationId) ?? { success: true };
    },
    async uninstall(installationId) {
      calls.push(["uninstall", installationId]);
      const result = overrides.uninstall?.(installationId) ?? { success: true };
      if (result.success) for (const [k, v] of installations) if (v === installationId) installations.delete(k);
      return result;
    },
    installationIdFor(packageId) {
      return installations.get(packageId) ?? overrides.installationIdFor?.(packageId) ?? null;
    },
    cancel() {
      calls.push(["cancel"]);
      return true;
    },
  };
}

const plan = (toInstall = [], toUninstall = [], blockers = []) => ({
  toInstall,
  toUninstall,
  unchanged: [],
  dependenciesToInstall: [],
  blockers,
  unsupported: [],
});

test("applies install then verify then uninstall in a mixed plan", async () => {
  const operations = fakeOperations({
    installationIdFor: (packageId) => `existing-${packageId}`,
  });
  const orchestrator = new ComponentOrchestrator();
  const result = await orchestrator.apply({
    plan: plan(["new"], ["old"]),
    components: components("new", "old"),
    operations,
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.completed.sort(), ["new", "old"]);
  assert.deepEqual(operations.calls, [
    ["install", "pkg-new"],
    ["verify", "inst-pkg-new"],
    ["uninstall", "existing-pkg-old"],
  ]);
});

test("reports progress events for each phase", async () => {
  const events = [];
  const orchestrator = new ComponentOrchestrator();
  await orchestrator.apply({
    plan: plan(["a"], ["b"]),
    components: components("a", "b"),
    operations: fakeOperations({ installationIdFor: () => "inst-b" }),
    onEvent: (event) => events.push(event),
  });
  assert.deepEqual(
    events.map((e) => `${e.componentId}:${e.kind}:${e.state}`),
    [
      "a:install:running",
      "a:install:completed",
      "a:verify:running",
      "a:verify:completed",
      "b:uninstall:running",
      "b:uninstall:completed",
    ],
  );
});

test("a failed install blocks uninstalls and reports partial failure", async () => {
  const operations = fakeOperations({
    install: () => ({ success: false, code: "DOWNLOAD_FAILED", error: "network" }),
    installationIdFor: () => "inst-old",
  });
  const orchestrator = new ComponentOrchestrator();
  const result = await orchestrator.apply({
    plan: plan(["new"], ["old"]),
    components: components("new", "old"),
    operations,
  });
  assert.equal(result.success, false);
  assert.deepEqual(result.failed, ["new"]);
  assert.deepEqual(operations.calls, [["install", "pkg-new"]]);
});

test("a failed verification blocks uninstalls", async () => {
  const operations = fakeOperations({
    verify: () => ({ success: false, code: "VERIFICATION_FAILED", error: "bad checksum" }),
    installationIdFor: () => "inst-old",
  });
  const orchestrator = new ComponentOrchestrator();
  const result = await orchestrator.apply({
    plan: plan(["new"], ["old"]),
    components: components("new", "old"),
    operations,
  });
  assert.equal(result.success, false);
  assert.ok(result.failed.includes("new"));
  assert.ok(!operations.calls.some(([kind]) => kind === "uninstall"));
});

test("cancellation stops the plan and is reported", async () => {
  const controller = new AbortController();
  const operations = fakeOperations({
    install: () => {
      controller.abort();
      return { success: false, cancelled: true };
    },
  });
  const orchestrator = new ComponentOrchestrator();
  const result = await orchestrator.apply({
    plan: plan(["a", "b"]),
    components: components("a", "b"),
    operations,
    signal: controller.signal,
  });
  assert.equal(result.success, false);
  assert.equal(result.cancelled, true);
  assert.deepEqual(operations.calls, [["install", "pkg-a"]]);
});

test("blockers prevent any operation", async () => {
  const operations = fakeOperations();
  const orchestrator = new ComponentOrchestrator();
  const result = await orchestrator.apply({
    plan: plan(["a"], [], ["Circular dependency"]),
    components: components("a"),
    operations,
  });
  assert.equal(result.success, false);
  assert.deepEqual(operations.calls, []);
  assert.ok(result.events.some((e) => e.message === "Circular dependency"));
});

test("rejects a concurrent apply", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const operations = fakeOperations({ install: async () => { await gate; return { success: true }; } });
  const orchestrator = new ComponentOrchestrator();
  const first = orchestrator.apply({
    plan: plan(["a"]),
    components: components("a"),
    operations,
  });
  const second = await orchestrator.apply({
    plan: plan(["b"]),
    components: components("b"),
    operations,
  });
  assert.equal(second.success, false);
  assert.match(second.events[0].message, /already running/);
  release();
  await first;
});

test("missing managed installation is skipped without failure", async () => {
  const orchestrator = new ComponentOrchestrator();
  const result = await orchestrator.apply({
    plan: plan([], ["ghost"]),
    components: components("ghost"),
    operations: fakeOperations({ installationIdFor: () => null }),
  });
  assert.equal(result.success, true);
  assert.ok(result.events.some((e) => e.state === "skipped"));
});
