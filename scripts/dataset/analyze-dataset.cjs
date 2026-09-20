#!/usr/bin/env node
const path = require("node:path"),
  fs = require("node:fs");
const {
  DatasetAnalyzer,
} = require("../../src/js/agent/dataset/DatasetAnalyzer");
const a = process.argv.slice(2),
  json = a.includes("--json"),
  strict = a.includes("--strict"),
  i = a.indexOf("--input"),
  input =
    i >= 0 ? a[i + 1] : path.resolve("dataset/output/pilot/dataset.jsonl");
(async () => {
  if (!fs.existsSync(input))
    throw new Error(`Dataset input not found: ${input}`);
  const r = await new DatasetAnalyzer().analyze(input);
  if (json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`samples: ${r.samples}`);
    console.log(`outcomes: ${JSON.stringify(r.outcomes)}`);
    console.log(
      `validation pass rate: ${(r.metrics.validationPassRate * 100).toFixed(1)}%`,
    );
    console.log(
      `average duration: ${r.metrics.averageDuration.toFixed(0)}ms, median: ${r.metrics.medianDuration.toFixed(0)}ms`,
    );
    console.log(
      `average tools: ${r.metrics.averageToolCalls.toFixed(2)}, model requests: ${r.metrics.averageModelRequests.toFixed(2)}`,
    );
    if (r.issues.length)
      console.log(`issues (${r.issues.length}):\n- ${r.issues.join("\n- ")}`);
  }
  if (strict && r.issues.length) process.exitCode = 1;
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
