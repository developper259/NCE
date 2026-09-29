#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const LOWER_IS_BETTER = /(?:Ms|MB|Bytes|Percent|domNodeCount|DomNodes|Count)$/i;
const LATENCY_METRICS = new Set([
  "durationMs", "rendererDurationMs", "actionDurationMs", "rendererLogicalMs",
  "inputToStableFrameMs", "stableFrameWaitMs", "fileSystemReadMs", "fileInitializeMs",
  "fileChunkMs", "fileOpenRequestMs", "fileInitialViewportStableMs", "fileModelReadyMs",
  "fileStableRenderMs", "fileFullyReadyMs", "workspaceOpenRequestMs", "openCloseCycleDurationMs",
  "totalScenarioDurationMs", "totalInteractionDurationMs", "observationDurationMs",
  "frameIntervalP50Ms", "frameIntervalP95Ms", "frameIntervalP99Ms", "frameIntervalMaxMs",
  "mainCpuUserMs", "mainCpuSystemMs", "rendererScriptDurationDeltaMs", "rendererTaskDurationDeltaMs",
  "scriptDurationMs",
]);
const ENVIRONMENT_FIELDS = ["os", "platform", "architecture", "cpuModel", "logicalCpuCores", "totalMemoryBytes", "nodeVersion", "electronVersion", "nceVersion"];

function readResult(filePath) {
  const resolved = path.resolve(filePath);
  const result = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (result.schemaVersion !== 1 || !Array.isArray(result.scenarios) || !result.environment) {
    throw new Error(`${filePath} is not a supported NCE IDE benchmark result`);
  }
  return { path: resolved, result };
}

function parseArgs(argv) {
  const options = { thresholdPercent: 5, absoluteThresholdMs: 1 };
  const files = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--threshold-percent") options.thresholdPercent = Number(argv[++index]);
    else if (arg.startsWith("--threshold-percent=")) options.thresholdPercent = Number(arg.split("=")[1]);
    else if (arg === "--absolute-threshold-ms") options.absoluteThresholdMs = Number(argv[++index]);
    else if (arg.startsWith("--absolute-threshold-ms=")) options.absoluteThresholdMs = Number(arg.split("=")[1]);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else files.push(arg);
  }
  if (options.help) return options;
  if (files.length !== 2) throw new Error("Usage: node benchmark/ide/scripts/compare-runs.cjs [--threshold-percent 5] before.json after.json");
  if (!Number.isFinite(options.thresholdPercent) || options.thresholdPercent < 0) throw new Error("Threshold percent must be nonnegative");
  if (!Number.isFinite(options.absoluteThresholdMs) || options.absoluteThresholdMs < 0) throw new Error("Absolute threshold must be nonnegative");
  options.files = files;
  return options;
}

function metricEntries(scenario) {
  const entries = [];
  for (const [metric, stats] of Object.entries(scenario.statistics || {})) {
    if (!stats || !Number.isFinite(stats.p50)) continue;
    if (/^(?:fileBytes|fileReadBytes|lineCount|maxLineLength|openTabs|workspaceEntries|explorerRootEntries|searchResults|searchResultRows|frames|cycles|metricProcessCount|rendererDomNodes|scrollZones|selectedCharacters|expectedSelectedCharacters|copyCharacters)$/i.test(metric)) continue;
    if (LATENCY_METRICS.has(metric)) {
      entries.push({ metric: `${metric}.p50`, name: metric, percentile: "p50", value: stats.p50 });
      if (Number.isFinite(stats.p95)) entries.push({ metric: `${metric}.p95`, name: metric, percentile: "p95", value: stats.p95 });
    } else {
      entries.push({ metric: `${metric}.p50`, name: metric, percentile: "p50", value: stats.p50 });
    }
  }
  return entries;
}

function compare(before, after, options) {
  const warnings = [];
  for (const field of ENVIRONMENT_FIELDS) {
    if (before.environment[field] !== after.environment[field]) warnings.push(`${field} differs: ${before.environment[field] ?? "unknown"} → ${after.environment[field] ?? "unknown"}`);
  }
  for (const [field, label] of [["mode", "benchmark mode"], ["configHash", "benchmark configuration"], ["fixtureHash", "fixture set"]]) {
    if (before.configuration?.[field] !== after.configuration?.[field]) warnings.push(`${label} differs`);
  }
  const beforeScenarios = new Map(before.scenarios.map((scenario) => [scenario.name, scenario]));
  const afterScenarios = new Map(after.scenarios.map((scenario) => [scenario.name, scenario]));
  const rows = [];
  for (const [scenarioName, next] of afterScenarios) {
    const previous = beforeScenarios.get(scenarioName);
    if (!previous) { warnings.push(`scenario '${scenarioName}' is absent from the before run`); continue; }
    const oldMetrics = new Map(metricEntries(previous).map((item) => [item.metric, item]));
    for (const newMetric of metricEntries(next)) {
      const oldMetric = oldMetrics.get(newMetric.metric);
      if (!oldMetric) { warnings.push(`metric '${scenarioName}.${newMetric.metric}' is absent from the before run`); continue; }
      const delta = newMetric.value - oldMetric.value;
      const deltaPercent = oldMetric.value === 0 ? null : delta / Math.abs(oldMetric.value) * 100;
      const isLatency = LATENCY_METRICS.has(newMetric.name) || LOWER_IS_BETTER.test(newMetric.name);
      let status = "unclassified";
      if (isLatency) {
        const absoluteSmall = LATENCY_METRICS.has(newMetric.name) && Math.abs(delta) < options.absoluteThresholdMs;
        const relativeSmall = deltaPercent !== null && Math.abs(deltaPercent) < options.thresholdPercent;
        status = absoluteSmall || relativeSmall ? "within threshold" : delta < 0 ? "improved" : "regressed";
      }
      rows.push({ scenario: scenarioName, metric: newMetric.metric, before: oldMetric.value, after: newMetric.value, delta, deltaPercent, status });
    }
  }
  return { warnings, rows };
}

function format(value, digits = 2) { return Number.isFinite(value) ? Number(value).toFixed(digits) : "—"; }
function color(status, value) {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return value;
  const code = status === "improved" ? "32" : status === "regressed" ? "31" : status === "within threshold" ? "33" : "0";
  return `\u001b[${code}m${value}\u001b[0m`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run benchmark:compare -- [--threshold-percent 5] [--absolute-threshold-ms 1] before.json after.json");
    return 0;
  }
  const before = readResult(options.files[0]);
  const after = readResult(options.files[1]);
  const comparison = compare(before.result, after.result, options);
  console.log(`NCE IDE benchmark comparison\nBefore: ${before.path}\nAfter:  ${after.path}\n`);
  if (comparison.warnings.length) {
    console.log("Comparability warnings:");
    for (const warning of comparison.warnings) console.log(`  ! ${warning}`);
    console.log("");
  }
  console.log(`${"Scenario / metric".padEnd(45)} ${"Before".padStart(12)} ${"After".padStart(12)} ${"Delta".padStart(12)} ${"Change".padStart(10)} Status`);
  for (const row of comparison.rows) {
    const delta = `${row.delta > 0 ? "+" : ""}${format(row.delta)}`;
    const percent = Number.isFinite(row.deltaPercent) ? `${row.deltaPercent > 0 ? "+" : ""}${format(row.deltaPercent)}%` : "—";
    const label = `${row.scenario}.${row.metric}`.slice(0, 44);
    console.log(`${label.padEnd(45)} ${format(row.before).padStart(12)} ${format(row.after).padStart(12)} ${delta.padStart(12)} ${percent.padStart(10)} ${color(row.status, row.status)}`);
  }
  if (!comparison.rows.length) console.log("No common numeric scenario metrics were found.");
  console.log(`\nClassification threshold: ${options.thresholdPercent}% relative, ${options.absoluteThresholdMs} ms absolute for latency. This is advisory; it does not fail the comparison.`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { console.error(`Comparison failed: ${error.message}`); process.exitCode = 1; }
}

module.exports = { parseArgs, metricEntries, compare };
