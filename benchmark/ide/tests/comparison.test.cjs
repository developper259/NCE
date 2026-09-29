const test = require("node:test");
const assert = require("node:assert/strict");
const { compare, parseArgs, metricEntries } = require("../scripts/compare-runs.cjs");

function result({ cpu = "CPU A", duration = 20, memory = 100 } = {}) {
  return {
    schemaVersion: 1,
    environment: { os: "Windows 10", platform: "win32", architecture: "x64", cpuModel: cpu, logicalCpuCores: 8, totalMemoryBytes: 8000, nodeVersion: "v22", electronVersion: "42", nceVersion: "1" },
    configuration: { mode: "quick", configHash: "same", fixtureHash: "same" },
    scenarios: [{ name: "editor.typing", statistics: { durationMs: { p50: duration, p95: duration + 2 }, rendererJsHeapMB: { p50: memory } } }],
  };
}

test("comparison classifies latency and memory direction", () => {
  const output = compare(result(), result({ duration: 10, memory: 90 }), { thresholdPercent: 5, absoluteThresholdMs: 1 });
  assert.equal(output.rows.find((row) => row.metric === "durationMs.p50").status, "improved");
  assert.equal(output.rows.find((row) => row.metric === "rendererJsHeapMB.p50").status, "improved");
  assert.equal(output.warnings.length, 0);
});

test("comparison warns when environments differ", () => {
  const output = compare(result(), result({ cpu: "CPU B", duration: 20.8 }), { thresholdPercent: 5, absoluteThresholdMs: 1 });
  assert.ok(output.warnings.some((warning) => warning.includes("cpuModel differs")));
  assert.equal(output.rows.find((row) => row.metric === "durationMs.p50").status, "within threshold");
});

test("comparator excludes fixture dimensions and parses threshold options", () => {
  const entries = metricEntries({ statistics: { durationMs: { p50: 2, p95: 3 }, fileBytes: { p50: 2048 } } });
  assert.deepEqual(entries.map((entry) => entry.metric), ["durationMs.p50", "durationMs.p95"]);
  assert.deepEqual(parseArgs(["--threshold-percent", "8", "before.json", "after.json"]).files, ["before.json", "after.json"]);
});

test("comparator includes stable-frame latency and lower-is-better slow-frame counts", () => {
  const entries = metricEntries({ statistics: {
    inputToStableFrameMs: { p50: 20, p95: 25 },
    frameIntervalP95Ms: { p50: 18, p95: 22 },
    framesOver16_7Ms: { p50: 4 },
    editorOutputNodeCount: { p50: 100 },
  } });
  assert.deepEqual(entries.map((entry) => entry.metric), [
    "inputToStableFrameMs.p50", "inputToStableFrameMs.p95",
    "frameIntervalP95Ms.p50", "frameIntervalP95Ms.p95",
    "framesOver16_7Ms.p50", "editorOutputNodeCount.p50",
  ]);
  const baseline = result();
  baseline.scenarios[0].statistics = { framesOver16_7Ms: { p50: 8 }, editorOutputNodeCount: { p50: 200 } };
  const next = result();
  next.scenarios[0].statistics = { framesOver16_7Ms: { p50: 2 }, editorOutputNodeCount: { p50: 100 } };
  const comparison = compare(baseline, next, { thresholdPercent: 5, absoluteThresholdMs: 1 });
  assert.equal(comparison.rows.find((row) => row.metric === "framesOver16_7Ms.p50").status, "improved");
  assert.equal(comparison.rows.find((row) => row.metric === "editorOutputNodeCount.p50").status, "improved");
});
