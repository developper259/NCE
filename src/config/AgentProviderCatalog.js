const AgentProviderCatalog = {
  providers: {
    modalQwen: {
      id: "modalQwen",
      name: "Qwen 2.5 Coder",
      baseURL:
        "https://trolleur-belvedere--nce-coder-serve.modal.run/v1/chat/completions",

      requiresApiKey: false,
      supportsTools: true,
      supportsToolChoice: true,
      toolChoice: "auto",

      defaultModel: "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8",

      models: {
        "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8": {
          id: "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8",
          name: "Qwen 2.5 Coder",
          contextWindow: 32768,
          maxOutputTokens: 8192,
        },
      },
    },
    opencode: {
      id: "opencode",
      name: "OpenCode Go",
      baseURL: "https://opencode.ai/zen/go/v1/chat/completions",

      requiresApiKey: true,
      supportsTools: true,
      supportsToolChoice: true,

      requestHeaders: {
        "User-Agent": "nce-agent/0.1.0",
      },

      sessionHeader: "x-opencode-session",

      defaultModel: "kimi-k2.7-code",

      fallbackModels: ["glm-5.3-flash", "kimi-k3", "deepseek-v4.1-flash"],

      models: {
        "kimi-k2.7-code": {
          id: "kimi-k2.7-code",
          name: "Kimi K2.7 Code",
          contextWindow: 262144,
          maxOutputTokens: 32768,
        },

        "glm-5.3-flash": {
          id: "glm-5.3-flash",
          name: "GLM-5.3 Flash",
          contextWindow: 1000000,
          maxOutputTokens: 131072,
        },

        "kimi-k3": {
          id: "kimi-k3",
          name: "Kimi K3",
          contextWindow: 1048576,
          maxOutputTokens: 131072,
        },

        "deepseek-v4.1-flash": {
          id: "deepseek-v4.1-flash",
          name: "DeepSeek V4.1 Flash",
          contextWindow: 1048576,
          maxOutputTokens: 131072,
        },
      },
    },
    openrouter: {
      id: "openrouter",
      name: "OpenRouter",
      baseURL: "https://openrouter.ai/api/v1/chat/completions",
      requiresApiKey: true,
      supportsTools: true,
      supportsToolChoice: true,

      defaultModel: "cohere/north-mini-code:free",

      fallbackModels: [
        "nvidia/nemotron-3-ultra-550b-a55b:free",
        "qwen/qwen3-coder:free",
      ],

      models: {
        "cohere/north-mini-code:free": {
          id: "cohere/north-mini-code:free",
          name: "North Mini Code Free",
          contextWindow: 256000,
          maxOutputTokens: 64000,
        },
        "nvidia/nemotron-3-ultra-550b-a55b:free": {
          id: "nvidia/nemotron-3-ultra-550b-a55b:free",
          name: "Nemotron 3 Ultra Free",
          contextWindow: 512288,
          maxOutputTokens: 16384,
        },

        "qwen/qwen3-coder:free": {
          id: "qwen/qwen3-coder:free",
          name: "Qwen3 Coder 480B Free",
          contextWindow: 1048576,
        },
      },
    },
  },

  getProviders() {
    return Object.values(this.providers);
  },

  getModelKey(providerId, modelId) {
    return `${providerId}:${modelId}`;
  },
};
