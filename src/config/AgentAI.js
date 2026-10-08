const AgentAI = {
  defaultAgent: "coder",
  defaultProvider: "openrouter",

  maxIterations: 100,
  maxIncompleteContinuations: 3,

  largeFileWriting: {
    // Character limits are deliberately conservative: escaped JSON payloads
    // can consume substantially more model output than their source text.
    recommendedChunkCharacters: 8000,
    maxChunkCharacters: 10000,
    maxRecoveryAttempts: 3,
    maxStrategyReplans: 3,
  },

  toolLimits: {
    common: { pathCharacters: 4000 },
    task_complete: { summaryCharacters: 2000, validationCharacters: 2000 },
    read_file: { outputCharacters: 4000, defaultLines: 200 },
    search_code: {
      queryCharacters: 500,
      maxOffset: 100000,
      maxResults: 100,
      outputCharacters: 4000,
    },
    get_project_map: { maxDepth: 20, outputCharacters: 4000 },
    get_diff: { outputCharacters: 12000 },
    run_tests: {
      outputCharacters: 12000,
      maxStoredOutputCharacters: 5 * 1024 * 1024,
      timeoutMs: 120000,
    },
  },

  responseBudget: {
    minReservedForResponseTokens: 2048,
    maxReservedForResponseTokens: 8192,
    reservedForResponseTokens: 4096,
    safetyFactor: 1.35,
    modelHintBias: 0,
    toolInputLimitTokens: 4096,
    toolOutputLimitTokens: 4096,
    contextCompactionSafetyMarginTokens: 8192,
  },

  contextCompaction: {
    enabled: true,
    recentIterations: 2,
    warmIterations: 6,
    maxPreviouslyReadFiles: 100,
    triggerRatio: 0.8,
    hardRatio: 0.9,
    criticalRatio: 0.95,
    safetyMarginTokens: 8192,
    charsPerToken: 4,
    logMetrics: true,
    debugDecisions: false,
  },

  progressGuidance: {
    overExplorationThreshold: 6,
    overExplorationEscalationInterval: 4,
  },

  readOnlyTools: ["read_file", "get_project_map", "search_code"],

  providers: AgentProviderCatalog.providers,

  agents: {
    coder: {
      id: "coder",
      name: "Code",

      description:
        "Agent principal pour comprendre, modifier et corriger directement le projet.",

      temperature: 1,
      maxTokens: 8192,

      permissions: "code",
    },

    ask: {
      id: "ask",
      name: "Ask",

      description:
        "Analyse le projet et répond aux questions sans modifier les fichiers.",

      temperature: 0.2,
      maxTokens: 4096,

      permissions: "read",
    },

    plan: {
      id: "plan",
      name: "Plan",

      description:
        "Analyse le projet et prépare un plan d'implémentation pour le mode Code.",

      temperature: 0.1,
      maxTokens: 4096,

      permissions: "read",
    },

    explain: {
      id: "explain",
      name: "Explain",

      description:
        "Analyse et explique le code réel sans modifier les fichiers.",

      temperature: 0.2,
      maxTokens: 3000,

      permissions: "read",
    },
  },

  getAgent(agentId = null) {
    const id = agentId || this.defaultAgent;
    return this.agents[id] || null;
  },

  getProvider(providerId = null) {
    const id = providerId || this.defaultProvider;
    return this.providers[id] || null;
  },

  getFallbackChain(providerId, modelId) {
    const provider = this.getProvider(providerId);
    if (!provider) return [];

    const modelConfig = provider.models?.[modelId] || null;

    const configured = Array.isArray(modelConfig?.fallbackChain)
      ? modelConfig.fallbackChain
      : provider.fallbackModels;

    if (!Array.isArray(configured)) return [];

    return configured
      .map((candidate) =>
        typeof candidate === "string"
          ? {
              provider: provider.id,
              model: candidate,
            }
          : {
              provider: candidate?.provider || provider.id,
              model: candidate?.model,
            },
      )
      .filter(
        (candidate) =>
          typeof candidate.model === "string" &&
          candidate.model &&
          this.getModelKey(candidate.provider, candidate.model) !==
            this.getModelKey(provider.id, modelId),
      );
  },

  resolve(agentId = null, providerId = null, modelId = null) {
    const agent = this.getAgent(agentId);

    if (!agent) {
      throw new Error(`Agent AI inconnu : ${agentId || this.defaultAgent}`);
    }

    const provider = this.getProvider(providerId);

    if (!provider) {
      throw new Error(
        `Provider AI inconnu : ${providerId || this.defaultProvider}`,
      );
    }

    const model = modelId || agent.model || provider.defaultModel;

    const modelConfig = provider.models?.[model] || {};

    const modelFamily = AgentPrompts.resolveModelFamily(model);

    return {
      agent,
      provider,

      model,

      modelConfig,

      modelFamily,

      supportsTools:
        modelConfig.supportsTools !== false && provider.supportsTools !== false,

      supportsToolChoice:
        modelConfig.supportsToolChoice !== false &&
        provider.supportsToolChoice !== false,

      contextWindow: Number.isFinite(modelConfig.contextWindow)
        ? modelConfig.contextWindow
        : null,

      maxOutputTokens: Number.isFinite(modelConfig.maxOutputTokens)
        ? modelConfig.maxOutputTokens
        : null,

      fallbackChain: this.getFallbackChain(provider.id, model),

      temperature: agent.temperature,

      maxTokens: Number.isFinite(modelConfig.maxOutputTokens)
        ? Math.min(agent.maxTokens, modelConfig.maxOutputTokens)
        : agent.maxTokens,

      maxIterations: this.maxIterations,

      maxIncompleteContinuations: this.maxIncompleteContinuations,

      largeFileWriting: { ...this.largeFileWriting },

      responseBudget: { ...this.responseBudget },

      contextCompaction: { ...this.contextCompaction },

      progressGuidance: { ...this.progressGuidance },

      permissions: agent.permissions || "read",

      systemPrompt: AgentPrompts.getSystemPrompt({
        agentId: agent.id,
        providerId: provider.id,
        modelId: model,
      }),
    };
  },

  getAgents() {
    return Object.values(this.agents);
  },

  getProviders() {
    return AgentProviderCatalog.getProviders();
  },

  getModelKey(providerId, modelId) {
    return AgentProviderCatalog.getModelKey(providerId, modelId);
  },

  getModels() {
    return this.getProviders().flatMap((provider) =>
      Object.values(provider.models || {}).map((model) => ({
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        modelName: model.name,
        provider,
        model,
      })),
    );
  },
};
