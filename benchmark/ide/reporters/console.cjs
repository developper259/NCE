const ANSI = { green: "\u001b[32m", red: "\u001b[31m", yellow: "\u001b[33m", reset: "\u001b[0m" };

function fmt(value, digits = 2) { return Number.isFinite(value) ? Number(value).toFixed(digits) : "—"; }

function printRun(result, { quiet = false } = {}) {
  if (quiet) return;
  const color = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
  const paint = (status, value) => color ? `${ANSI[status] || ""}${value}${ANSI.reset}` : value;
  console.log("NCE IDE Benchmark");
  console.log("=".repeat(68));
  console.log(`Mode: ${result.configuration.mode} | Machine: ${result.environment.machine || "not labeled"} | Commit: ${(result.environment.gitCommit || "unknown").slice(0, 12)}`);
  console.log(`${result.environment.platform} ${result.environment.architecture} | ${result.environment.cpuModel || "CPU unknown"} | ${fmt(result.environment.totalMemoryMB / 1024, 1)} GB RAM | Node ${result.environment.nodeVersion} | Electron ${result.environment.electronVersion || "unknown"}`);
  console.log("");
  const nameWidth = Math.min(34, Math.max(17, ...result.scenarios.map((item) => item.name.length)));
  console.log(`${"Scenario".padEnd(nameWidth)}  ${"Status".padEnd(9)} ${"N".padStart(3)} ${"p50 ms".padStart(10)} ${"p95 ms".padStart(10)} ${"renderer p50".padStart(13)} ${"read p50".padStart(10)}`);
  for (const scenario of result.scenarios) {
    const measured = scenario.samples.filter((sample) => sample.status === "passed" && !sample.warmup).length;
    const stats = scenario.statistics || {};
    const status = scenario.status === "passed" ? paint("green", scenario.status) : paint("red", scenario.status);
    console.log(`${scenario.name.padEnd(nameWidth)}  ${status.padEnd(9)} ${String(measured).padStart(3)} ${fmt(stats.durationMs?.p50).padStart(10)} ${fmt(stats.durationMs?.p95).padStart(10)} ${fmt(stats.rendererDurationMs?.p50).padStart(13)} ${fmt(stats.fileSystemReadMs?.p50).padStart(10)}`);
    if (scenario.failure) console.log(`  ${paint("red", scenario.failure.split("\n")[0])}`);
  }
  const startup = result.scenarios.find((scenario) => scenario.name === "startup.cold-ish");
  if (startup?.statistics) {
    console.log("\nStartup phases, p50 (ms)");
    for (const [label, metric] of [
      ["spawn → first renderer target", "spawnToRendererWindowMs"],
      ["spawn → interactive + stable frame", "durationMs"],
      ["main start → app ready", "mainProcessStartToAppReadyMs"],
      ["app ready → BrowserWindow created", "appReadyToWindowCreateMs"],
      ["BrowserWindow created → ready-to-show", "browserWindowCreateToReadyToShowMs"],
      ["DOM ready → editor renderer-ready", "domReadyToRendererReadyMs"],
      ["application shutdown", "applicationShutdownMs"],
    ]) console.log(`  ${label.padEnd(42)} ${fmt(startup.statistics[metric]?.p50)} ms`);
  }
  console.log("");
  console.log(`Status: ${result.status}`);
  console.log(`JSON: ${result.output.json}`);
  console.log(`Markdown: ${result.output.markdown}`);
}

module.exports = { printRun };
