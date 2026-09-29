function percentile(values, quantile) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * quantile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) return sorted[lowerIndex];
  const weight = position - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
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
  const metricNames = new Set();
  for (const sample of samples) {
    for (const [name, value] of Object.entries(sample.metrics || {})) {
      if (Number.isFinite(value)) metricNames.add(name);
    }
  }
  return Object.fromEntries([...metricNames].sort().map((name) => [
    name,
    summarize(samples.map((sample) => sample.metrics?.[name])),
  ]));
}

module.exports = { percentile, summarize, summarizeSamples };
