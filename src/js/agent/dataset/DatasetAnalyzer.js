const fs = require("node:fs/promises");
class DatasetAnalyzer {
  async analyze(file) {
    const lines = (await fs.readFile(file, "utf8"))
        .split(/\r?\n/)
        .filter(Boolean),
      samples = [],
      issues = [],
      ids = new Set();
    for (let i = 0; i < lines.length; i++) {
      let s;
      try {
        s = JSON.parse(lines[i]);
      } catch {
        issues.push(`line ${i + 1}: invalid JSON`);
        continue;
      }
      if (s.schemaVersion !== 1)
        issues.push(
          `${s.sampleId || `line ${i + 1}`}: unsupported schemaVersion`,
        );
      if (!s.sampleId || ids.has(s.sampleId))
        issues.push(
          `${s.sampleId || `line ${i + 1}`}: duplicate or missing sampleId`,
        );
      ids.add(s.sampleId);
      if (!s.task?.id) issues.push(`${s.sampleId}: missing task id`);
      if (!s.attempt) issues.push(`${s.sampleId}: missing attempt`);
      if (!s.run?.runId) issues.push(`${s.sampleId}: missing runId`);
      if (!s.validation) issues.push(`${s.sampleId}: missing validation`);
      if (!Array.isArray(s.trajectory) || !s.trajectory.length)
        issues.push(`${s.sampleId}: empty trajectory`);
      if (s.integrity?.valid === false)
        issues.push(`${s.sampleId}: invalid trace`);
      samples.push(s);
    }
    const n = samples.length,
      sum = (k) => samples.reduce((a, s) => a + Number(s.metrics?.[k] || 0), 0),
      outcomes = {};
    samples.forEach(
      (s) => (outcomes[s.outcome] = (outcomes[s.outcome] || 0) + 1),
    );
    const d = samples
        .map((s) => Number(s.run?.durationMs || 0))
        .sort((a, b) => a - b),
      avg = (k) => (n ? sum(k) / n : 0);
    return {
      samples: n,
      outcomes,
      metrics: {
        validationPassRate: n
          ? samples.filter((s) => s.validation?.passed === true).length / n
          : 0,
        averageIterations: avg("totalIterations"),
        averageToolCalls: avg("toolCalls"),
        averageModelRequests: avg("modelRequests"),
        inputTokens: sum("inputTokens"),
        outputTokens: sum("outputTokens"),
        totalTokens: sum("totalTokens"),
        retryCount: sum("retryCount"),
        fallbackCount: sum("fallbackCount"),
        averageDuration: n ? d.reduce((a, b) => a + b, 0) / n : 0,
        medianDuration: n ? d[Math.floor(n / 2)] : 0,
      },
      issues,
      valid: issues.length === 0,
    };
  }
}
module.exports = { DatasetAnalyzer };
