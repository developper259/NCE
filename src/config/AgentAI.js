const AgentAI = {
  defaultAgent: "coder",
  defaultProvider: "openrouter",

  maxIterations: 100,
  maxIncompleteContinuations: 3,

  largeFileWriting: {
    recommendedChunkCharacters: 10000,
    maxChunkCharacters: 12000,
    maxRecoveryAttempts: 2,
  },

  contextCompaction: {
    enabled: true,
    recentIterations: 2,
    warmIterations: 6,
    maxPreviouslyReadFiles: 100,
    softLimitRatio: 0.4,
    hardLimitRatio: 0.7,
    criticalLimitRatio: 0.85,
    safetyMarginTokens: 8192,
    charsPerToken: 4,
    logMetrics: true,
    debugDecisions: false,
  },

  readOnlyTools: [
    "get_editor_context",
    "get_cursor",
    "read_selection",
    "read_active_file",
    "read_file",
    "get_project_map",
    "list_project_files",
    "search_active_file",
    "search_project_files",
  ],

  providers: {
    ollama: {
      id: "ollama",
      name: "Ollama",
      baseURL: "http://localhost:11434/v1",
      requiresApiKey: false,
      supportsTools: true,
      supportsToolChoice: true,
      defaultModel: "qwen3",
      fallbackModels: [],

      models: {
        qwen3: {
          id: "qwen3",
          name: "Qwen 3",
          contextWindow: 40960,
        },
      },
    },

    openrouter: {
      id: "openrouter",
      name: "OpenRouter",
      baseURL: "https://openrouter.ai/api/v1",
      requiresApiKey: true,
      supportsTools: true,
      supportsToolChoice: true,

      defaultModel: "cohere/north-mini-code:free",

      fallbackModels: [
        "poolside/laguna-s-2.1:free",
        "nvidia/nemotron-3-ultra-550b-a55b:free",
        "z-ai/glm-5.2:free",
        "qwen/qwen3-coder:free",
        "openai/gpt-4o-mini",
      ],

      models: {
        "cohere/north-mini-code:free": {
          id: "cohere/north-mini-code:free",
          name: "North Mini Code Free",
          contextWindow: 256000,
          maxOutputTokens: 64000,
        },

        "poolside/laguna-s-2.1:free": {
          id: "poolside/laguna-s-2.1:free",
          name: "Laguna S 2.1 Free",
          contextWindow: 1048576,
          maxOutputTokens: 131072,
        },

        "nvidia/nemotron-3-ultra-550b-a55b:free": {
          id: "nvidia/nemotron-3-ultra-550b-a55b:free",
          name: "Nemotron 3 Ultra Free",
          contextWindow: 512288,
          maxOutputTokens: 16384,
        },

        "z-ai/glm-5.2:free": {
          id: "z-ai/glm-5.2:free",
          name: "GLM 5.2 Free",
          contextWindow: 1048576,
          maxOutputTokens: 131072,
        },

        "qwen/qwen3-coder:free": {
          id: "qwen/qwen3-coder:free",
          name: "Qwen3 Coder 480B Free",
          contextWindow: 1048576,
        },

        "openai/gpt-4o-mini": {
          id: "openai/gpt-4o-mini",
          name: "GPT-4o mini",
          contextWindow: 128000,
          maxOutputTokens: 16384,
          supportsTools: false,
          supportsToolChoice: false,
        },
      },
    },
  },

  agents: {
    coder: {
      id: "coder",
      name: "Code",

      description:
        "Agent principal pour comprendre, modifier et corriger directement le projet.",

      temperature: 0.2,
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
          `${candidate.provider}:${candidate.model}` !==
            `${provider.id}:${modelId}`,
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

      contextCompaction: { ...this.contextCompaction },

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
    return Object.values(this.providers);
  },
};
