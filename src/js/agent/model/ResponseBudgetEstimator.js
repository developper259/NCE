class ResponseBudgetEstimator {
  constructor(agent) {
    this.agent = agent || null;
  }

  normalizeUsage(list = []) {
    if (!Array.isArray(list)) return [];
    return list
      .map((entry) => {
        if (Number.isFinite(entry)) return entry;
        if (entry && typeof entry === 'object') {
          const value = Number.isFinite(entry?.estimatedTokens)
            ? entry.estimatedTokens
            : Number.isFinite(entry?.promptTokens)
              ? entry.promptTokens
              : Number.isFinite(entry?.outputTokens)
                ? entry.outputTokens
                : null;
          return Number.isFinite(value) ? value : null;
        }
        return null;
      })
      .filter((value) => Number.isFinite(value));
  }

  clamp(value, minimum, maximum) {
    if (!Number.isFinite(value)) return minimum;
    if (Number.isFinite(maximum)) return Math.min(Math.max(value, minimum), maximum);
    return Math.max(value, minimum);
  }

  estimateResponseBudget({
    agent = this.agent,
    model = {},
    runtimeState = {},
    previousUsage = [],
    modelHint = null,
  } = {}) {
    const modelContextWindow = Number.isFinite(model.contextWindow)
      ? model.contextWindow
      : Number.isFinite(agent?.contextWindow)
        ? agent.contextWindow
        : null;

    const modelOutputLimit = Number.isFinite(model.maxOutputTokens)
      ? model.maxOutputTokens
      : Number.isFinite(agent?.modelConfig?.maxOutputTokens)
        ? agent.modelConfig.maxOutputTokens
        : Number.isFinite(agent?.runConfig?.maxOutputTokens)
          ? agent.runConfig.maxOutputTokens
          : Number.isFinite(agent?.maxTokens)
            ? agent.maxTokens
            : null;

    const configured = agent?.responseBudget || agent?.runConfig?.responseBudget || {};
    const baseReserved = Number.isFinite(configured.reservedForResponseTokens)
      ? configured.reservedForResponseTokens
      : 512;
    const minReserved = Number.isFinite(configured.minReservedForResponseTokens)
      ? configured.minReservedForResponseTokens
      : 128;
    const maxReserved = Number.isFinite(configured.maxReservedForResponseTokens)
      ? configured.maxReservedForResponseTokens
      : Number.isFinite(modelOutputLimit)
        ? modelOutputLimit
        : 16384;
    const safetyFactor = Number.isFinite(configured.safetyFactor)
      ? configured.safetyFactor
      : 1.35;
    const modelHintBias = Number.isFinite(configured.modelHintBias)
      ? configured.modelHintBias
      : 0;

    const usage = this.normalizeUsage(previousUsage);
    const lastRegularizedUsage = usage.length
      ? usage[usage.length - 1]
      : null;
    let heuristicEstimate = Number.isFinite(lastRegularizedUsage)
      ? lastRegularizedUsage
      : baseReserved;

    const runtimeKind = String(runtimeState?.kind || '').toLowerCase();
    const largeWriteActive = runtimeState?.largeWriteActive === true || runtimeState?.largeWrite === true;
    const lastTool = String(runtimeState?.lastTool || '').toLowerCase();
    if (largeWriteActive || runtimeKind.includes('write') || lastTool.includes('write')) {
      heuristicEstimate += 2048;
    }
    if (lastTool.includes('modify_file') || lastTool.includes('write_file_chunk')) {
      heuristicEstimate += 1024;
    }

    if (runtimeKind.includes('read') || lastTool.includes('read_file')) {
      heuristicEstimate = Math.max(heuristicEstimate, 256);
    }

    if (typeof modelHint === 'string' && modelHint.trim()) {
      const parsedHint = Number.parseInt(modelHint.trim(), 10);
      if (Number.isFinite(parsedHint)) {
        heuristicEstimate = Math.max(heuristicEstimate, Math.round(parsedHint * 0.75));
      }
    }

    if (Number.isFinite(configured.modelHintBias)) {
      heuristicEstimate += configured.modelHintBias;
    }

    const averageUsage = usage.length
      ? usage.reduce((sum, value) => sum + value, 0) / usage.length
      : heuristicEstimate;
    heuristicEstimate = Math.max(heuristicEstimate, Math.round(averageUsage * 0.75));

    // The estimator intentionally stays conservative but deterministic.
    const estimatedResponseTokens = Math.round(
      this.clamp(
        heuristicEstimate * safetyFactor,
        minReserved,
        Number.isFinite(maxReserved) ? maxReserved : Number.POSITIVE_INFINITY,
      ),
    );

    const reservedForResponseTokens = Math.round(
      this.clamp(
        Math.max(estimatedResponseTokens, minReserved),
        minReserved,
        Number.isFinite(maxReserved) ? maxReserved : Number.POSITIVE_INFINITY,
      ),
    );

    const effectiveMaxOutputTokens = Number.isFinite(modelOutputLimit)
      ? Math.min(modelOutputLimit, reservedForResponseTokens)
      : reservedForResponseTokens;

    return {
      success: true,
      contextWindow: modelContextWindow,
      maxOutputTokens: modelOutputLimit,
      effectiveMaxOutputTokens,
      estimatedResponseTokens,
      reservedForResponseTokens,
      hardMinReservedForResponseTokens: minReserved,
      hardMaxReservedForResponseTokens: maxReserved,
      safetyFactor,
      modelHintBias,
      modelHint,
      source: 'local-deterministic-estimator',
    };
  }
}
