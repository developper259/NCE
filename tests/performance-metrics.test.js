const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { loadMain } = require("./helpers/main-runtime");

function createMetrics() {
  const window = {};
  const clock = { value: 10, now() { return this.value; } };
  loadMain("src/js/core/PerformanceMetrics.js", {}, { window, performance: clock });
  return { metrics: window.NCEPerformanceMetrics, clock };
}

test("performance metrics record marks, bounded measures, counters, and gauges", () => {
  const { metrics, clock } = createMetrics();
  metrics.mark("startup.begin");
  const measure = metrics.begin("workspace.restore");
  clock.value += 12.5;
  assert.equal(metrics.end(measure), 12.5);
  metrics.increment("files.read.requests", 2);
  metrics.setGauge("workspaceSearch.filesScanned", 42);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.measures["workspace.restore"].count, 1);
  assert.equal(snapshot.measures["workspace.restore"].lastMs, 12.5);
  assert.equal(snapshot.counters["files.read.requests"], 2);
  assert.equal(snapshot.counters["workspaceSearch.filesScanned"], 42);
  assert.equal(snapshot.entries.some((entry) => entry.name === "startup.begin"), true);
});

test("performance metrics keep a fixed ring, bound counter names, and reset cleanly", () => {
  const { metrics, clock } = createMetrics();
  for (let index = 0; index < 650; index += 1) metrics.mark("test.event");
  for (let index = 0; index < 140; index += 1) metrics.increment(`test.counter${index}`);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.capacity, 500);
  assert.equal(snapshot.eventCount, 500);
  assert.ok(snapshot.totalEvents >= 650);
  assert.equal(Object.keys(snapshot.counters).length, 128);
  assert.equal(snapshot.droppedCounters, 12);

  clock.value += 1;
  const reset = metrics.reset();
  assert.equal(reset.eventCount, 0);
  assert.equal(Object.keys(reset.counters).length, 0);
  assert.equal(reset.droppedCounters, 0);
  assert.equal(reset.resetAt, clock.value);
});

test("performance metric labels reject paths and the utility installs no timers", () => {
  const { metrics } = createMetrics();
  assert.equal(metrics.mark("/Users/person/private.js"), false);
  assert.equal(metrics.increment("/workspace/secret.js"), false);
  assert.equal(Object.keys(metrics.snapshot().counters).length, 0);

  const source = fs.readFileSync("src/js/core/PerformanceMetrics.js", "utf8");
  assert.doesNotMatch(source, /setTimeout|setInterval|requestAnimationFrame/);
});
