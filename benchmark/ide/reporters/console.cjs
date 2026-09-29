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
  console.log(`${"Scenario".padEnd(nameWidth)}  ${"Status".padEnd(9)} ${"N".padStart(3)} ${"p50 ms".padStart(10)} ${"p95 ms".padStart(10)} ${"input→frame".padStart(12)} ${"file ready".padStart(11)} ${"frame p50".padStart(10)} ${">16.7 ms".padStart(9)}`);
  for (const scenario of result.scenarios) {
    const measured = scenario.samples.filter((sample) => sample.status === "passed" && !sample.warmup).length;
    const stats = scenario.statistics || {};
    const status = scenario.status === "passed" ? paint("green", scenario.status) : paint("red", scenario.status);
    const p95 = (stats.durationMs?.count || 0) >= 20 ? stats.durationMs.p95 : null;
    console.log(`${scenario.name.padEnd(nameWidth)}  ${status.padEnd(9)} ${String(measured).padStart(3)} ${fmt(stats.durationMs?.p50).padStart(10)} ${fmt(p95).padStart(10)} ${fmt(stats.inputToStableFrameMs?.p50).padStart(12)} ${fmt(stats.fileFullyReadyMs?.p50).padStart(11)} ${fmt(stats.frameIntervalP50Ms?.p50).padStart(10)} ${fmt(stats.framesOver16_7Ms?.p50).padStart(9)}`);
    if (scenario.failure) console.log(`  ${paint("red", scenario.failure.split("\n")[0])}`);
  }
  const startup = result.scenarios.find((scenario) => scenario.name === "startup.cold-ish");
  if (startup?.statistics) {
    console.log("\nStartup phases, p50 (ms)");
    for (const [label, metric] of [
      ["spawn → first renderer target", "spawnToRendererWindowMs"],
      ["spawn → interactive + stable frame", "durationMs"],
      ["main start → app ready", "mainProcessStartToAppReadyMs"],
      ["app ready → window create request", "appReadyToWindowCreateRequestMs"],
      ["window request → BrowserWindow created", "windowCreateRequestToBrowserWindowCreatedMs"],
      ["BrowserWindow created → ready-to-show", "browserWindowCreateToReadyToShowMs"],
      ["DOM ready → editor renderer-ready", "domReadyToRendererReadyMs"],
      ["application shutdown", "applicationShutdownMs"],
    ]) {
      const p95 = (startup.statistics[metric]?.count || 0) >= 20 ? startup.statistics[metric].p95 : null;
      console.log(`  ${label.padEnd(42)} ${fmt(startup.statistics[metric]?.p50)} ms | p95 ${fmt(p95)} ms`);
    }
  }
  console.log("");
  console.log(`Status: ${result.status}`);
  console.log(`JSON: ${result.output.json}`);
  console.log(`Markdown: ${result.output.markdown}`);
}

module.exports = { printRun };
