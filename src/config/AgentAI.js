const AgentAI = {
  defaultAgent: "coder",
  defaultProvider: "openrouter",

  maxIterations: 100,

  readOnlyTools: [
    "get_editor_context",
    "get_cursor",
    "read_selection",
    "read_active_file",
    "read_file",
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

      defaultModel: "z-ai/glm-5.2:free",
      fallbackModels: [
        "qwen/qwen3-coder:free",
        "openai/gpt-4o-mini",
        { provider: "zenmux", model: "z-ai/glm-5.2-free" },
      ],

      models: {
        "z-ai/glm-5.2:free": {
          id: "z-ai/glm-5.2:free",
          name: "GLM 5.2 Free",
        },

        "qwen/qwen3-coder:free": {
          id: "qwen/qwen3-coder:free",
          name: "Qwen3 Coder 480B Free",
        },

        "openai/gpt-4o-mini": {
          id: "openai/gpt-4o-mini",
          name: "GPT-4o mini",
        },
      },
    },

    zenmux: {
      id: "zenmux",
      name: "ZenMux",
      baseURL: "https://zenmux.ai/api/v1",
      requiresApiKey: true,
      supportsTools: true,
      supportsToolChoice: true,
      defaultModel: "z-ai/glm-5.2-free",
      fallbackModels: [],

      models: {
        "z-ai/glm-5.2-free": {
          id: "z-ai/glm-5.2-free",
          name: "GLM 5.2 Free",
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
      maxTokens: 4096,

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
          ? { provider: provider.id, model: candidate }
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

      fallbackChain: this.getFallbackChain(provider.id, model),

      temperature: agent.temperature,

      maxTokens: agent.maxTokens,

      maxIterations: this.maxIterations,

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
