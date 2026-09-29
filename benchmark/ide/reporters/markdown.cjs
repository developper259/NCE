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
    "| Scenario | Status | Samples | Duration p50 | Duration p95 | Renderer p50 | File read p50 | Memory after close | DOM nodes |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const scenario of result.scenarios) {
    const metrics = scenario.statistics || {};
    const cell = (name, key = "p50") => formatNumber(metrics[name]?.[key]);
    lines.push(`| ${escapeCell(scenario.name)} | ${escapeCell(scenario.status)} | ${scenario.samples.filter((sample) => sample.status === "passed" && !sample.warmup).length} | ${cell("durationMs")} ms | ${cell("durationMs", "p95")} ms | ${cell("rendererDurationMs")} ms | ${cell("fileSystemReadMs")} ms | ${cell("memoryAfterCloseJsHeapMB")} MB | ${cell("domNodeCount")} |`);
  }
  lines.push("", "## Measurement notes", "", "- `durationMs` is measured by the runner with a monotonic clock and ends after the scenario's required two animation frames. `rendererDurationMs` is measured inside Chromium with Performance marks.", "- Startup is a fresh NCE process and isolated profile for each sample. OS file caches are not cleared, so this is cold-profile startup, not a cold OS cache.", "- Electron process private memory is used when Electron reports it. Renderer JavaScript heap and main-process RSS are reported separately to avoid adding shared working sets together.", "- Raw per-sample data, phase events and failures are preserved in the JSON result.", "");
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
      ["App ready → BrowserWindow creation", "appReadyToWindowCreateMs"],
      ["BrowserWindow creation → ready-to-show", "browserWindowCreateToReadyToShowMs"],
      ["DOM ready → renderer-ready", "domReadyToRendererReadyMs"],
      ["Application shutdown", "applicationShutdownMs"],
    ]) lines.push(`| ${label} | ${formatNumber(startup.statistics[metric]?.p50)} | ${formatNumber(startup.statistics[metric]?.p95)} |`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

module.exports = { renderMarkdown };
