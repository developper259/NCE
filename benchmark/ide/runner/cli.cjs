#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { generate } = require("../fixtures/generate-fixtures.cjs");
const { hashJson, ensureDirectory, writeJsonAtomic } = require("../utils/files.cjs");
const { summarizeSamples } = require("../utils/statistics.cjs");
const scenarioManifest = require("../scenarios/manifest.cjs");
const { collectEnvironment } = require("./environment.cjs");
const { launchNce } = require("./application.cjs");
const {
  runScenario,
  runStartupIteration,
  prepareRenderer,
  warmInteractiveApp,
  loadFixtureManifest,
} = require("./scenarios.cjs");
const { renderMarkdown } = require("../reporters/markdown.cjs");
const { printRun } = require("../reporters/console.cjs");

const ROOT = path.resolve(__dirname, "../../..");
const CONFIG_PATH = path.join(__dirname, "../config/benchmark.config.json");
const FIXTURE_ROOT = path.join(ROOT, ".benchmark-data", "ide", "fixtures");
const RESULT_ROOT = path.join(ROOT, ".benchmark-data", "ide", "results");
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const definitions = new Map(scenarioManifest.map((scenario) => [scenario.name, scenario]));

function parseArgs(argv) {
  const options = { mode: config.defaultMode, groups: [], scenarios: [], timeoutMs: config.defaultTimeoutMs, quiet: false, verbose: false, debug: false, extreme: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const read = (name) => {
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
      return argv[++index];
    };
    if (arg === "--mode" || arg.startsWith("--mode=")) options.mode = read("--mode");
    else if (arg === "--group" || arg.startsWith("--group=")) options.groups.push(...read("--group").split(",").filter(Boolean));
    else if (arg === "--scenario" || arg.startsWith("--scenario=")) options.scenarios.push(...read("--scenario").split(",").filter(Boolean));
    else if (arg === "--machine" || arg.startsWith("--machine=")) options.machine = read("--machine");
    else if (arg === "--output" || arg.startsWith("--output=")) options.output = read("--output");
    else if (arg === "--timeout" || arg.startsWith("--timeout=")) options.timeoutMs = Number(read("--timeout"));
    else if (arg === "--extreme") options.extreme = true;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--debug") options.debug = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--list") options.list = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!config.modes[options.mode]) throw new Error("--mode must be quick, standard or full");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 600000) throw new Error("--timeout must be between 1000 and 600000 milliseconds");
  if (options.machine && (options.machine.length > 80 || /[\r\n\0]/.test(options.machine))) throw new Error("--machine must be a label of at most 80 characters");
  if (options.extreme && options.mode !== "full") throw new Error("--extreme is available only with --mode full");
  return options;
}

function printHelp() {
  console.log(`NCE IDE benchmark\n\nUsage: npm run benchmark:ide -- [options]\n\nOptions:\n  --mode quick|standard|full   Workload intensity (default: ${config.defaultMode})\n  --group startup,files,tabs,editor,scroll,search,memory,workspace,idle\n  --scenario name[,name]       Run selected scenarios\n  --machine <label>            Add a user-provided machine label\n  --output <path>              JSON result path (Markdown is written alongside)\n  --timeout <ms>               Per-startup/scenario timeout\n  --extreme                    Explicitly generate the 100,000-file workspace\n  --quiet | --verbose | --debug\n  --list                       List available scenarios\n  --help`);
}

function selectedScenarios(options) {
  const all = config.modes[options.mode].scenarios;
  if (options.scenarios.length) {
    for (const name of options.scenarios) if (!definitions.has(name)) throw new Error(`Unknown scenario '${name}'`);
    return [...new Set(options.scenarios)];
  }
  if (options.groups.length) {
    const selected = all.filter((name) => options.groups.some((group) => definitions.get(name)?.group === group || (group === "startup" && name === "startup.cold-ish")));
    const unknown = options.groups.filter((group) => !scenarioManifest.some((item) => item.group === group));
    if (unknown.length) throw new Error(`Unknown group(s): ${unknown.join(", ")}`);
    if (!selected.length) throw new Error(`No scenarios in ${options.mode} mode match the selected group(s)`);
    return selected;
  }
  return all.slice();
}

function fixtureCacheMatches(options, names) {
  const manifestPath = path.join(FIXTURE_ROOT, "manifest.json");
  if (!fs.existsSync(manifestPath)) return false;
  try {
    const existing = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (existing.profile !== options.mode || Boolean(existing.extreme) !== options.extreme) return false;
    for (const name of names) {
      if (name.startsWith("file.open.")) {
        const rawKey = name.slice("file.open.".length);
        const key = /^(?:10kb|100kb|1mb|5mb|10mb|50mb)$/.test(rawKey) ? `size-${rawKey}` : rawKey;
        const file = existing.files?.[key];
        if (!file || !fs.existsSync(path.join(FIXTURE_ROOT, file.path)) || fs.statSync(path.join(FIXTURE_ROOT, file.path)).size !== file.bytes) return false;
      }
      if (name.startsWith("workspace.open.")) {
        const workspace = existing.workspaces?.find((item) => item.name === name.slice("workspace.open.".length));
        if (!workspace || !fs.existsSync(workspace.path)) return false;
      }
    }
    return true;
  } catch { return false; }
}

function iterationCount(options, name) {
  if (name === "startup.cold-ish" || name === "window.open") return config.modes[options.mode].startupSamples;
  if (name.startsWith("memory.")) return config.iterations[options.mode].memory;
  if (name.startsWith("file.open.")) return config.iterations[options.mode].open;
  return config.iterations[options.mode].interaction;
}

function makeRunId(timestamp, environment, mode) {
  const stamp = timestamp.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${mode}-${(environment.gitCommit || "nogit").slice(0, 8)}`;
}

function errorText(error) {
  return error && error.stack ? error.stack : String(error);
}

async function ensureInteractiveApp(state, options) {
  if (state.appRun && !state.appRun.exited) return state.appRun;
  state.appRun = await launchNce({ timeoutMs: options.timeoutMs, profileLabel: "interactive" });
  await state.appRun.connect();
  await state.appRun.waitFor("window.editor && editor.isOnInit === false", "NCE editor initialization");
  await prepareRenderer(state.appRun.cdp);
  state.interactionWarmupMs = await warmInteractiveApp(state.appRun, FIXTURE_ROOT);
  return state.appRun;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { printHelp(); return 0; }
  if (options.list) {
    for (const scenario of scenarioManifest) console.log(`${scenario.name.padEnd(34)} ${scenario.group.padEnd(10)} ${scenario.description}`);
    return 0;
  }
  const names = selectedScenarios(options);
  if (names.includes("workspace.open.extreme") && !options.extreme) throw new Error("workspace.open.extreme requires the explicit --extreme flag");
  if (options.mode === "full" && os.totalmem() / 1024 / 1024 < 4096 && !options.quiet) {
    console.warn("Full mode can use substantial RAM and disk space. Keep the generated 50 MB file and 20k workspace in mind; avoid --extreme on low-memory machines.");
  }
  if (options.extreme && !names.includes("workspace.open.extreme")) {
    console.warn("--extreme generated the 100,000-file fixture; select --scenario workspace.open.extreme to measure it.");
  }
  const startedAt = new Date().toISOString();
  const configHash = hashJson(config);
  const environment = collectEnvironment({ machine: options.machine, mode: options.mode, configHash });
  const runId = makeRunId(startedAt, environment, options.mode);
  const jsonPath = options.output ? path.resolve(ROOT, options.output) : path.join(RESULT_ROOT, `${runId}.json`);
  const markdownPath = `${jsonPath.replace(/\.json$/i, "")}.md`;
  ensureDirectory(path.dirname(jsonPath));

  const fixtureStart = performance.now();
  const fixturesReused = fixtureCacheMatches(options, names);
  const fixtures = fixturesReused ? loadFixtureManifest(FIXTURE_ROOT) : generate({ profile: options.mode, extreme: options.extreme });
  const fixtureGenerationMs = performance.now() - fixtureStart;
  const fixtureHash = hashJson({
    fixtureVersion: fixtures.fixtureVersion,
    files: fixtures.files,
    workspaces: fixtures.workspaces.map(({ name, files, folders, entries }) => ({ name, files, folders, entries })),
  });

  const result = {
    schemaVersion: 1,
    reportVersion: 1,
    runId,
    timestamp: startedAt,
    status: "running",
    environment,
    configuration: {
      mode: options.mode,
      selectedGroups: options.groups,
      selectedScenarios: names,
      timeoutMs: options.timeoutMs,
      startupProfile: "fresh user-data/session profile per iteration; operating-system cache is not cleared",
      interactionWarmup: "one tiny fixture open/close before interactive scenarios; excluded from scenario samples",
      warmupSamples: config.modes[options.mode].warmupSamples,
      configHash,
      fixtureHash,
      fixtureVersion: fixtures.fixtureVersion,
      fixtureGenerationMs,
      fixturesReused,
      extremeWorkspaceIncluded: options.extreme,
      output: { json: jsonPath, markdown: markdownPath },
    },
    scenarios: names.map((name) => ({ ...definitions.get(name), status: "pending", samples: [], statistics: {} })),
    output: { json: jsonPath, markdown: markdownPath },
    shutdown: null,
  };

  const savePartial = () => {
    if (!result.finishedAt) result.status = result.scenarios.some((scenario) => scenario.status === "failed") ? "failed" : "running";
    writeJsonAtomic(jsonPath, result);
    fs.writeFileSync(markdownPath, renderMarkdown(result), "utf8");
  };
  savePartial();

  const state = { appRun: null, switchTabs: null, mode: options.mode, manifest: fixtures, fixtureRoot: FIXTURE_ROOT };
  let anyFailures = false;
  try {
    for (let scenarioIndex = 0; scenarioIndex < result.scenarios.length; scenarioIndex += 1) {
      const scenario = result.scenarios[scenarioIndex];
      const count = iterationCount(options, scenario.name);
      const warmups = scenario.name.startsWith("startup.") || scenario.name === "window.open" ? 0 : config.modes[options.mode].warmupSamples;
      scenario.status = "running";
      if (!options.quiet) console.log(`[${scenarioIndex + 1}/${result.scenarios.length}] ${scenario.name}`);
      const totalSamples = warmups + count;

      for (let sampleIndex = 0; sampleIndex < totalSamples; sampleIndex += 1) {
        const warmup = sampleIndex < warmups;
        const measuredIndex = sampleIndex - warmups;
        const sample = {
          index: warmup ? sampleIndex : measuredIndex,
          warmup,
          status: "running",
          startedAt: new Date().toISOString(),
          metrics: {},
          value: null,
        };
        scenario.samples.push(sample);
        try {
          if (scenario.name === "startup.cold-ish" || scenario.name === "window.open") {
            const startup = await runStartupIteration({ timeoutMs: options.timeoutMs, profileLabel: scenario.name.replaceAll(".", "-") });
            sample.metrics = startup.metrics;
            sample.value = startup.value;
          } else {
            const appRun = await ensureInteractiveApp(state, options);
            result.configuration.interactionWarmupMs = state.interactionWarmupMs;
            sample.value = await runScenario(scenario.name, { ...state, run: appRun, fixtures, fixtureRoot: FIXTURE_ROOT, mode: options.mode }, warmup ? sampleIndex : measuredIndex);
            sample.metrics = sample.value.metrics || {};
            sample.value = sample.value.value ?? null;
          }
          sample.status = "passed";
        } catch (error) {
          sample.status = "failed";
          sample.error = errorText(error);
          scenario.failure = sample.error;
          anyFailures = true;
          if (options.verbose || options.debug) console.error(sample.error);
          if (state.appRun) {
            await state.appRun.close().catch(() => {});
            state.appRun = null;
          }
        } finally {
          sample.finishedAt = new Date().toISOString();
          if (warmup) sample.note = "warm-up sample; excluded from statistics";
          scenario.statistics = summarizeSamples(scenario.samples.filter((item) => item.status === "passed" && !item.warmup));
          savePartial();
        }
      }
      const passedCount = scenario.samples.filter((sample) => sample.status === "passed" && !sample.warmup).length;
      const failedCount = scenario.samples.filter((sample) => sample.status === "failed" && !sample.warmup).length;
      scenario.status = failedCount > 0 || passedCount === 0 ? "failed" : "passed";
      scenario.finishedAt = new Date().toISOString();
      savePartial();
    }
  } finally {
    if (state.appRun) {
      const closeStart = process.hrtime.bigint();
      state.shutdown = await state.appRun.close();
      result.shutdown = { ...state.shutdown, durationMs: Number(process.hrtime.bigint() - closeStart) / 1e6 };
      state.appRun = null;
    }
  }

  if (result.shutdown && (result.shutdown.exitCode !== 0 || result.shutdown.exitSignal)) anyFailures = true;
  result.status = anyFailures ? "failed" : "complete";
  result.finishedAt = new Date().toISOString();
  result.execution = {
    processShutdown: result.shutdown ? {
      exitCode: result.shutdown.exitCode,
      exitSignal: result.shutdown.exitSignal,
      durationMs: result.shutdown.durationMs,
    } : null,
  };
  savePartial();
  printRun(result, { quiet: options.quiet });
  return anyFailures ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`Benchmark could not start: ${errorText(error)}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, selectedScenarios, iterationCount };
