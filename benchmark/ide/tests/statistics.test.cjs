const test = require("node:test");
const assert = require("node:assert/strict");
const { percentile, summarize, summarizeSamples } = require("../utils/statistics.cjs");

test("percentile uses linear interpolation and handles empty samples", () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.ok(Math.abs(percentile([4, 1, 3, 2], 0.95) - 3.85) < 1e-12);
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([7], 0.99), 7);
});

test("summary keeps raw outliers represented in maximum and spread", () => {
  const result = summarize([10, 10, 10, 100]);
  assert.equal(result.count, 4);
  assert.equal(result.p50, 10);
  assert.equal(result.max, 100);
  assert.ok(result.stddev > 0);
  assert.equal(result.p99, null);
});

test("sample aggregation ignores missing and nonnumeric metrics", () => {
  const result = summarizeSamples([
    { metrics: { durationMs: 2, domNodeCount: 30 } },
    { metrics: { durationMs: 4, domNodeCount: 40, ignored: "text" } },
  ]);
  assert.equal(result.durationMs.p50, 3);
  assert.equal(result.domNodeCount.p50, 35);
  assert.equal(result.ignored, undefined);
});

test("statistics discard non-finite inputs and never emit non-finite summary values", () => {
  const result = summarize([1, 3, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
  assert.equal(result.count, 2);
  for (const value of Object.values(result)) {
    if (typeof value === "number") assert.equal(Number.isFinite(value), true);
  }
  assert.equal(summarizeSamples([{ metrics: { durationMs: Number.POSITIVE_INFINITY } }]).durationMs, undefined);
});
