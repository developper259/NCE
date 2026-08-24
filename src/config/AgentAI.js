const AgentAI = {
  defaultAgent: "coder",
  defaultProvider: "groq",
  maxIterations: 10,
  providers: {
    ollama: {
      id: "ollama",
      name: "Ollama",
      baseURL: "http://localhost:11434/v1",
      requiresApiKey: false,
      defaultModel: "qwen3",
      models: {
        qwen3: { id: "qwen3", name: "Qwen 3" },
      },
    },
    openai: {
      id: "openai",
      name: "OpenAI",
      baseURL: "https://api.openai.com/v1",
      requiresApiKey: true,
      defaultModel: "gpt-4o-mini",
      models: {
        "gpt-4o-mini": { id: "gpt-4o-mini", name: "GPT-4o mini" },
        "gpt-4o": { id: "gpt-4o", name: "GPT-4o" },
      },
    },
    groq: {
      id: "groq",
      name: "Groq",
      baseURL: "https://api.groq.com/openai/v1",
      requiresApiKey: true,
      defaultModel: "openai/gpt-oss-120b",
      models: {
        "openai/gpt-oss-120b": {
          id: "openai/gpt-oss-120b",
          name: "GPT OSS 120B",
        },
        "llama-3.3-70b-versatile": {
          id: "llama-3.3-70b-versatile",
          name: "Llama 3.3 70B",
        },
        "llama-3.1-8b-instant": {
          id: "llama-3.1-8b-instant",
          name: "Llama 3.1 8B",
        },
      },
    },
    openrouter: {
      id: "openrouter",
      name: "OpenRouter",
      baseURL: "https://openrouter.ai/api/v1",
      requiresApiKey: true,
      defaultModel: "openai/gpt-4o-mini",
      models: {
        "openai/gpt-4o-mini": {
          id: "openai/gpt-4o-mini",
          name: "GPT-4o mini",
        },
        "google/gemini-2.0-flash-001": {
          id: "google/gemini-2.0-flash-001",
          name: "Gemini 2 Flash",
        },
      },
    },
    mistral: {
      id: "mistral",
      name: "Mistral",
      baseURL: "https://api.mistral.ai/v1",
      requiresApiKey: true,
      defaultModel: "mistral-small-latest",
      models: {
        "mistral-small-latest": {
          id: "mistral-small-latest",
          name: "Mistral Small",
        },
        "mistral-large-latest": {
          id: "mistral-large-latest",
          name: "Mistral Large",
        },
      },
    },
  },
  agents: {
    coder: {
      id: "coder",
      name: "Code",
      description:
        "Agent principal pour comprendre, modifier et corriger du code.",
      temperature: 0.2,
      maxTokens: 4096,
      systemPrompt: `Tu es l'agent de programmation intégré à NCE.

Tu aides l'utilisateur à comprendre, corriger, modifier et améliorer son code directement depuis l'éditeur.

Tu dois être précis, prudent et économique en tokens.

RÈGLES :
- Ne lis jamais inutilement des fichiers entiers.
- Utilise le contexte de l'éditeur avant de demander des informations supplémentaires.
- Utilise les outils disponibles lorsque tu as besoin d'informations précises.
- Ne suppose jamais le contenu d'un fichier que tu n'as pas consulté.
- Avant une modification, vérifie que tu comprends suffisamment le contexte.
- Ne modifie jamais un fichier simplement pour essayer.
- Les modifications doivent passer par les outils prévus par NCE.
- Respecte les confirmations utilisateur.
- Si une opération échoue, indique clairement l'erreur.
- Lorsque la tâche est terminée, réponds avec un résumé court.

Tu es un agent intégré à un éditeur de code, pas un simple chatbot.`.trim(),
    },
    ask: {
      id: "ask",
      name: "Ask",
      description: "Répond aux questions et aide à comprendre le projet.",
      temperature: 0.2,
      maxTokens: 4096,
      systemPrompt: `Tu es le mode Ask de NCE.

Réponds aux questions de l'utilisateur avec clarté et précision.
Utilise les outils lorsque des informations du projet sont nécessaires.
Ne modifie jamais les fichiers dans ce mode.
Ne prétends jamais avoir vérifié une information que tu n'as pas lue.`.trim(),
    },
    plan: {
      id: "plan",
      name: "Plan",
      description:
        "Prépare une stratégie de modification sans changer le code.",
      temperature: 0.1,
      maxTokens: 4096,
      systemPrompt: `Tu es le mode Plan de NCE.

Analyse la demande et le projet avant de répondre.
Utilise les outils de lecture et de recherche pour établir les faits.
Présente un plan d'implémentation ordonné, précis et vérifiable.
Ne modifie jamais les fichiers dans ce mode.`.trim(),
    },
    explain: {
      id: "explain",
      name: "Explain",
      description: "Explique le code sélectionné ou le contexte actuel.",
      temperature: 0.2,
      maxTokens: 3000,
      systemPrompt: `Tu es un assistant spécialisé dans l'explication du code.

Explique le code de manière claire et progressive.

Priorité :
1. comprendre le fonctionnement ;
2. identifier les parties importantes ;
3. expliquer les relations entre les composants ;
4. signaler les points potentiellement problématiques.

Ne modifie jamais le code.
Ne demande pas de contexte inutile.
Si une information manque, utilise les outils disponibles avant de demander à l'utilisateur de la fournir.`.trim(),
    },
  },
  getAgent(agentId = null) {
    const id = agentId || this.defaultAgent;
    return this.agents[id] || null;
  },
  getProvider(providerId) {
    if (!providerId) return null;
    return this.providers[providerId] || null;
  },
  resolve(agentId = null) {
    const agent = this.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent AI inconnu : ${agentId || this.defaultAgent}`);
    }
    const provider = this.getProvider(this.defaultProvider);
    if (!provider) {
      throw new Error(`Provider AI inconnu : ${this.defaultProvider}`);
    }
    return {
      agent,
      provider,
      model: agent.model || provider.defaultModel,
      temperature: agent.temperature,
      maxTokens: agent.maxTokens,
      systemPrompt: agent.systemPrompt,
    };
  },
  getAgents() {
    return Object.values(this.agents);
  },
  getProviders() {
    return Object.values(this.providers);
  },
};
