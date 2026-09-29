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
