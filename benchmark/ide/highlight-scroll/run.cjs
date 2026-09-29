#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { generateFixture } = require("./generate-fixture.cjs");
const { launchElectron } = require("./electron-run.cjs");
const { runHighlightScrollScenario, installProbe } = require("./scenario.cjs");

const ROOT = path.resolve(__dirname, "../../..");
const FIXTURE_ROOT = path.join(ROOT, ".benchmark-data", "ide", "fixtures");
const DEFAULT_OUTPUT_ROOT = path.join(ROOT, ".benchmark-data", "ide", "results");
const SCENARIOS = new Map([
  ["highlight.scroll-warm", "scroll with all JavaScript line tokens warmed"],
  ["highlight.scroll-plain-control", "scroll the same fixture as plain text"],
]);

function parseArgs(argv) {
  const options = {
    scenarios: ["highlight.scroll-warm", "highlight.scroll-plain-control"],
    samples: 20,
    warmups: 1,
    timeoutMs: 60000,
    output: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const read = (name) => argument.startsWith(`${name}=`)
      ? argument.slice(name.length + 1)
      : argv[++index];
    if (argument === "--scenario" || argument.startsWith("--scenario="))
      options.scenarios = read("--scenario").split(",").filter(Boolean);
    else if (argument === "--samples" || argument.startsWith("--samples="))
      options.samples = Number(read("--samples"));
    else if (argument === "--warmups" || argument.startsWith("--warmups="))
      options.warmups = Number(read("--warmups"));
    else if (argument === "--timeout" || argument.startsWith("--timeout="))
      options.timeoutMs = Number(read("--timeout"));
    else if (argument === "--output" || argument.startsWith("--output="))
      options.output = read("--output");
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!options.scenarios.length || options.scenarios.some((name) => !SCENARIOS.has(name)))
    throw new Error(`--scenario accepts only: ${[...SCENARIOS.keys()].join(",")}`);
  if (!Number.isInteger(options.samples) || options.samples < 1 || options.samples > 100)
    throw new Error("--samples must be between 1 and 100");
  if (!Number.isInteger(options.warmups) || options.warmups < 0 || options.warmups > 10)
    throw new Error("--warmups must be between 0 and 10");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 600000)
    throw new Error("--timeout must be between 1000 and 600000 milliseconds");
  return options;
}

function printHelp() {
  process.stdout.write(`NCE highlight scroll microbenchmark\n\nUsage: npm run benchmark:highlight-scroll -- [options]\n\nOptions:\n  --scenario highlight.scroll-warm,highlight.scroll-plain-control\n  --samples <n>   Measured samples per scenario (default 20)\n  --warmups <n>   Warm-up samples excluded from statistics (default 1)\n  --timeout <ms>  Per sample timeout (default 60000)\n  --output <path> JSON report path\n  --help\n`);
}

function percentile(values, quantile) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function summarize(values) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return null;
  const mean = valid.reduce((sum, value) => sum + value, 0) / valid.length;
  const variance = valid.reduce((sum, value) => sum + (value - mean) ** 2, 0) / valid.length;
  return {
    count: valid.length,
    min: Math.min(...valid),
    p50: percentile(valid, 0.5),
    median: percentile(valid, 0.5),
    mean,
    p95: percentile(valid, 0.95),
    p99: valid.length >= 100 ? percentile(valid, 0.99) : null,
    max: Math.max(...valid),
    stddev: Math.sqrt(variance),
  };
}

function summarizeSamples(samples) {
  const names = new Set();
  for (const sample of samples) {
    if (sample.warmup || sample.status !== "passed") continue;
    for (const [name, value] of Object.entries(sample.metrics))
      if (Number.isFinite(value)) names.add(name);
  }
  return Object.fromEntries([...names].sort().map((name) => [
    name,
    summarize(samples.filter((sample) => !sample.warmup && sample.status === "passed")
      .map((sample) => sample.metrics[name])),
  ]));
}

function environmentInfo() {
  const git = (args) => {
    try { return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim(); }
    catch { return null; }
  };
  const cpu = os.cpus()[0];
  let electronVersion = null;
  try { electronVersion = require("electron/package.json").version; } catch {}
  let nceVersion = null;
  try { nceVersion = require(path.join(ROOT, "package.json")).version; } catch {}
  return {
    os: `${os.type()} ${os.release()}`,
    platform: process.platform,
    architecture: process.arch,
    cpuModel: cpu?.model || null,
    logicalCpuCores: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
    nodeVersion: process.version,
    electronVersion,
    nceVersion,
    gitBranch: git(["branch", "--show-current"]),
    gitCommit: git(["rev-parse", "HEAD"]),
    gitDirty: Boolean(git(["status", "--porcelain"])),
  };
}

async function prepareRenderer(run) {
  await run.cdp.evaluate(`(async () => {
    if (!window.editor || !window.api) throw new Error("NCE renderer is not ready");
    await window.api.setAutoSaveState?.(false);
    window.__nceBenchmarkState = { longTasks: [], observer: null };
    try {
      window.__nceBenchmarkState.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__nceBenchmarkState.longTasks.push(entry.duration);
      });
      window.__nceBenchmarkState.observer.observe({ type: "longtask", buffered: true });
    } catch {}
    return true;
  })()`);
  await run.cdp.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
}

async function waitRendererStable(run) {
  await run.cdp.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))", run.timeoutMs);
}

async function cleanTabs(run) {
  await run.cdp.evaluate(`(async () => {
    editor.searchController?.close?.();
    if (editor.tabManager?.tabs?.length) await editor.tabManager.closeFiles({ skipPrepare: true });
    return true;
  })()`, run.timeoutMs);
  await waitRendererStable(run);
}

async function openFixture(run, fixturePath, { expected }) {
  const state = await run.cdp.evaluate(`(async () => {
    const filePath = ${JSON.stringify(fixturePath)};
    await editor.tabManager.openFileWithPath(filePath);
    const file = editor.tabManager.activeFile;
    if (!file) throw new Error("NCE did not create an active file");
    await editor.fileLoader.waitForFileLoaded(file);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      path: file.path,
      loaded: file.isLoaded === true,
      lines: file.totalLines,
      bytes: file.loadingState?.loadedBytes ?? null,
      language: file.language,
    };
  })()`, run.timeoutMs);
  if (!state?.loaded || state.path !== fixturePath || state.lines !== expected.lines)
    throw new Error(`Highlight fixture failed to load: ${JSON.stringify(state)}`);
  if (state.language !== "javascript")
    throw new Error(`Fixture language was ${state.language}; expected javascript`);
  return state;
}

async function focusEditor(run) {
  const point = await run.cdp.evaluate(`(() => {
    const element = document.querySelector(".editor-output");
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + Math.min(rect.width / 2, 200), y: rect.top + Math.min(rect.height / 2, 100) };
  })()`);
  if (!point) throw new Error("Could not find editor output");
  await run.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1,
  });
  await run.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1,
  });
  return point;
}

async function startFrameWindow(run) {
  return run.cdp.evaluate(`(() => {
    const state = window.__nceBenchmarkState;
    if (!state) throw new Error("Highlight scroll frame observer is unavailable");
    state.longTasks.length = 0;
    const windowState = { active: true, timestamps: [] };
    state.frameWindow = windowState;
    const tick = (now) => {
      if (!windowState.active) return;
      windowState.timestamps.push(now);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return true;
  })()`);
}

async function stopFrameWindow(run) {
  return run.cdp.evaluate(`(async () => {
    const state = window.__nceBenchmarkState;
    const frameWindow = state?.frameWindow;
    if (!frameWindow) return { frameTimestamps: [], longTasks: [] };
    frameWindow.active = false;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const result = { frameTimestamps: frameWindow.timestamps.slice(), longTasks: state.longTasks.slice() };
    state.longTasks.length = 0;
    state.frameWindow = null;
    return result;
  })()`, run.timeoutMs);
}

function frameIntervalsFromTimestamps(timestamps) {
  const values = Array.isArray(timestamps) ? timestamps : [];
  const frameIntervalsMs = [];
  let invalidFrameIntervalCount = 0;
  for (let index = 1; index < values.length; index += 1) {
    const interval = values[index] - values[index - 1];
    if (Number.isFinite(interval) && interval >= 0) frameIntervalsMs.push(interval);
    else invalidFrameIntervalCount += 1;
  }
  return { frameIntervalsMs, invalidFrameIntervalCount, frameCallbackCount: values.length };
}

function summarizeFrameIntervals(frameIntervals, options = {}) {
  const values = frameIntervals.filter(Number.isFinite).sort((a, b) => a - b);
  const countOver = (threshold) => values.filter((value) => value > threshold).length;
  return {
    frameIntervals: values.length,
    invalidFrameIntervalCount: options.invalidFrameIntervalCount || 0,
    frameIntervalP50Ms: percentile(values, 0.5),
    frameIntervalP95Ms: values.length >= 20 ? percentile(values, 0.95) : null,
    frameIntervalP99Ms: values.length >= 100 ? percentile(values, 0.99) : null,
    frameIntervalMaxMs: values.length ? Math.max(...values) : null,
    framesOver16_7Ms: countOver(16.7),
    framesOver33_3Ms: countOver(33.3),
    framesOver50Ms: countOver(50),
  };
}

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function writeReport(outputPath, report) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { printHelp(); return 0; }

  const fixture = generateFixture(path.join(FIXTURE_ROOT, "highlight-scroll.js"));
  const fixtureManifest = {
    fixtureVersion: "highlight-scroll-v1",
    file: { path: "highlight-scroll.js", bytes: fixture.bytes, lines: fixture.lines, maxLineLength: fixture.maxLineLength },
  };
  const startedAt = new Date().toISOString();
  const runId = `highlight-scroll-${startedAt.replace(/[-:.]/g, "")}`;
  const outputPath = options.output
    ? path.resolve(ROOT, options.output)
    : path.join(DEFAULT_OUTPUT_ROOT, `${runId}.json`);
  const environment = environmentInfo();
  const fixtureHash = crypto.createHash("sha256")
    .update(fs.readFileSync(fixture.path))
    .digest("hex");
  const configuration = {
    scenarios: options.scenarios,
    measuredSamples: options.samples,
    warmupSamples: options.warmups,
    timeoutMs: options.timeoutMs,
    fixture: fixtureManifest,
    scrollPattern: { durationMs: 1500, cadenceMs: 20, eventCount: 75, deltaY: 20 },
    output: { json: outputPath },
  };
  const report = {
    schemaVersion: 1,
    reportVersion: 1,
    runId,
    timestamp: startedAt,
    status: "running",
    environment: { ...environment, benchmarkMode: "highlight-scroll", fixtureVersion: fixtureManifest.fixtureVersion },
    configuration: { ...configuration, configHash: hashJson(configuration), fixtureHash },
    scenarios: options.scenarios.map((name) => ({ name, description: SCENARIOS.get(name), status: "pending", samples: [], statistics: {} })),
    output: { json: outputPath },
  };
  writeReport(outputPath, report);

  const run = await launchElectron({ timeoutMs: options.timeoutMs });
  run.timeoutMs = options.timeoutMs;
  run.scenarioTimeoutMs = options.timeoutMs;
  try {
    await run.connect();
    await run.waitFor("window.editor && editor.isOnInit === false", "NCE editor initialization");
    await prepareRenderer(run);
    const context = {
      run,
      fixtures: { files: { "highlight-scroll": fixtureManifest.file } },
      fixtureRoot: FIXTURE_ROOT,
    };
    const callbacks = {
      installProbe,
      cleanTabs,
      openFixture,
      focusEditor,
      waitRendererStable,
      startFrameWindow,
      stopFrameWindow,
      summarizeFrameIntervals,
      frameIntervalsFromTimestamps,
    };

    for (const scenario of report.scenarios) {
      scenario.status = "running";
      process.stdout.write(`[${scenario.name}] `);
      const totalSamples = options.warmups + options.samples;
      for (let index = 0; index < totalSamples; index += 1) {
        const warmup = index < options.warmups;
        const sample = {
          index: warmup ? index : index - options.warmups,
          warmup,
          status: "running",
          startedAt: new Date().toISOString(),
          metrics: {},
          value: null,
        };
        scenario.samples.push(sample);
        try {
          const measured = await runHighlightScrollScenario({
            name: scenario.name,
            context,
            sampleIndex: sample.index,
            callbacks,
          });
          sample.metrics = measured.metrics;
          sample.value = measured.value;
          sample.status = "passed";
        } catch (error) {
          sample.status = "failed";
          sample.error = error?.stack || String(error);
          scenario.failure = sample.error;
        }
        sample.finishedAt = new Date().toISOString();
        if (warmup) sample.note = "warm-up sample; excluded from statistics";
        scenario.statistics = summarizeSamples(scenario.samples);
        writeReport(outputPath, report);
        if (sample.status === "failed") break;
      }
      const passed = scenario.samples.filter((sample) => !sample.warmup && sample.status === "passed").length;
      const failed = scenario.samples.some((sample) => sample.status === "failed");
      scenario.status = failed || passed !== options.samples ? "failed" : "passed";
      scenario.finishedAt = new Date().toISOString();
      process.stdout.write(`${passed}/${options.samples} measured samples ${scenario.status}\n`);
      writeReport(outputPath, report);
    }
  } finally {
    report.shutdown = await run.close();
  }

  report.status = report.scenarios.every((scenario) => scenario.status === "passed") ? "complete" : "failed";
  report.finishedAt = new Date().toISOString();
  writeReport(outputPath, report);
  process.stdout.write(`Status: ${report.status}\nJSON: ${outputPath}\n`);
  return report.status === "complete" ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, main, summarize, summarizeSamples };
