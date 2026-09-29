function escapeCell(value) {
  return String(value ?? "—").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function formatNumber(value, decimals = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(decimals) : "—";
}

function renderMarkdown(result) {
  const lines = [
    `# NCE IDE benchmark — ${result.configuration.mode}`,
    "",
    `- Run: \`${result.runId}\``,
    `- Date: ${result.timestamp}`,
    `- Report version: ${result.reportVersion ?? 1}; fixture version: ${result.environment.fixtureVersion || result.configuration.fixtureVersion || "unknown"}`,
    `- Commit: \`${result.environment.gitCommit || "unknown"}\` (${result.environment.gitBranch || "unknown branch"})${result.environment.gitDirty ? "; dirty worktree" : "; clean worktree"}`,
    `- Machine label: ${result.environment.machine || "not supplied"}`,
    `- Platform: ${result.environment.os}, ${result.environment.architecture}; CPU: ${result.environment.cpuModel || "unknown"}; ${formatNumber(result.environment.totalMemoryMB / 1024, 1)} GB RAM`,
    `- Node/Electron/NCE: ${result.environment.nodeVersion} / ${result.environment.electronVersion || "unknown"} / ${result.environment.nceVersion || "unknown"}`,
    `- Configuration SHA-256: \`${result.configuration.configHash}\``,
    `- Fixture SHA-256: \`${result.configuration.fixtureHash}\``,
    `- Fixture generation: ${formatNumber(result.configuration.fixtureGenerationMs)} ms${result.configuration.fixturesReused ? " (cached)" : ""}`,
    `- Result status: **${result.status}**`,
    "",
    "## Scenarios",
    "",
    "| Scenario | Status | Samples | Duration p50 | Duration p95 | Input → stable p50 | File ready p50 | RAF intervals | Invalid RAF | Frame p50 | Frame p95 | Frames >16.7 ms | Main CPU p50 ms | CPU core eq. p50 % | CPU normalized p50 % | Heap after close | DOM nodes |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const scenario of result.scenarios) {
    const metrics = scenario.statistics || {};
    const cell = (name, key = "p50") => {
      const stats = metrics[name];
      if (key === "p95" && (stats?.count || 0) < 20) return "—";
      return formatNumber(stats?.[key]);
    };
    const sampleCount = scenario.samples.filter((sample) => sample.status === "passed" && !sample.warmup).length;
    lines.push(`| ${escapeCell(scenario.name)} | ${escapeCell(scenario.status)} | ${sampleCount} | ${cell("durationMs")} ms | ${cell("durationMs", "p95")} ms | ${cell("inputToStableFrameMs")} ms | ${cell("fileFullyReadyMs")} ms | ${cell("frameIntervals")} | ${cell("invalidFrameIntervalCount")} | ${cell("frameIntervalP50Ms")} ms | ${cell("frameIntervalP95Ms")} ms | ${cell("framesOver16_7Ms")} | ${cell("mainCpuTotalMs")} ms | ${cell("mainCpuCoreEquivalentPercent")} | ${cell("mainCpuNormalizedPercent")} | ${cell("memoryAfterCloseJsHeapMB")} MB | ${cell("domNodeCount")} |`);
  }
  lines.push("", "## Measurement notes", "", "- File-open `durationMs` ends at the stable initial viewport; `fileFullyReadyMs` covers the progressive model load and its final two-RAF render stabilization. `fileOpenRequestMs`, `fileModelReadyMs` and `fileStableRenderMs` retain the sub-phases.", "- For interaction scenarios, `actionDurationMs`, `rendererLogicalMs` and `inputToStableFrameMs` have separate meanings. The two-RAF input-to-stable value is an end-to-end rendering proxy, not CPU time; `scriptDurationMs` is reported separately when available.", "- CPU user/system counters come from cumulative `process.cpuUsage()` snapshots in microseconds. `mainCpuTotalMs` is their millisecond delta; core-equivalent percent is CPU ms divided by the matching monotonic snapshot window, and normalized percent divides that value by logical CPU cores. Invalid CPU samples are null and include a diagnostic.", "- RAF intervals use differences between successive RAF callback timestamps. The first callback seeds the clock; invalid deltas are excluded and counted in `invalidFrameIntervalCount`.", "- Scroll frame intervals and slow-frame counts come from an active RAF observer during paced wheel input. `idle.activity` uses no benchmark RAF loop; its observation window can still include normal NCE/Chromium background activity.", "- Startup is a fresh NCE process and isolated profile for each sample. OS file caches are not cleared, so this is cold-profile startup, not a cold OS cache.", "- Electron process private memory is used when Electron reports it. Renderer JavaScript heap and main-process RSS are reported separately to avoid adding shared working sets together.", "- Raw per-sample data, phase events and failures are preserved in the JSON result. Markdown p95 values require at least 20 passing samples; p99 remains null below 100 samples.", "");
  for (const scenario of result.scenarios) {
    for (const sample of scenario.samples || []) {
      const diagnostic = sample.metrics?.mainCpuMetricDiagnostic;
      if (sample.metrics?.mainCpuMetricsValid === false && diagnostic) {
        lines.push(`### ${scenario.name} CPU diagnostic (sample ${sample.index})`, "", "```text", diagnostic, "```", "");
      }
    }
  }
  for (const scenario of result.scenarios.filter((item) => item.failure)) {
    lines.push(`### ${scenario.name} failure`, "", "```text", scenario.failure, "```", "");
  }
  const startup = result.scenarios.find((scenario) => scenario.name === "startup.cold-ish");
  if (startup?.statistics) {
    lines.push("## Startup phases", "", "| Phase | p50 (ms) | p95 (ms) |", "|---|---:|---:|");
    for (const [label, metric] of [
      ["Spawn → renderer target", "spawnToRendererWindowMs"],
      ["Spawn → interactive and stable frame", "durationMs"],
      ["Main process start → app ready", "mainProcessStartToAppReadyMs"],
      ["App ready → window creation request", "appReadyToWindowCreateRequestMs"],
      ["Window request → BrowserWindow created", "windowCreateRequestToBrowserWindowCreatedMs"],
      ["App ready → BrowserWindow created (compatibility phase)", "appReadyToWindowCreateMs"],
      ["BrowserWindow creation → ready-to-show", "browserWindowCreateToReadyToShowMs"],
      ["DOM ready → renderer-ready", "domReadyToRendererReadyMs"],
      ["Application shutdown", "applicationShutdownMs"],
    ]) lines.push(`| ${label} | ${formatNumber(startup.statistics[metric]?.p50)} | ${startup.statistics[metric]?.count >= 20 ? formatNumber(startup.statistics[metric]?.p95) : "—"} |`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

module.exports = { renderMarkdown };
