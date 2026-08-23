const AgentAI = {
  defaultAgent: "coder",
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
      name: "NCE Coder",
      description:
        "Agent principal pour comprendre, modifier et corriger du code.",
      provider: "groq",
      model: "openai/gpt-oss-120b",
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
- Ne modifie jamais un fichier simplement pour "essayer".
- Les modifications doivent passer par les outils prévus par NCE.
- Respecte les confirmations utilisateur.
- Ne contourne jamais une confirmation.
- Si une opération échoue, indique clairement l'erreur.
- Évite de répéter des informations déjà présentes dans le contexte.
- Lorsque la tâche est terminée, réponds avec un résumé court.

Tu es un agent intégré à un éditeur de code, pas un simple chatbot.`.trim(),
    },
    reviewer: {
      id: "reviewer",
      name: "Code Reviewer",
      description:
        "Analyse le code et détecte les problèmes sans le modifier automatiquement.",
      provider: "groq",
      model: "openai/gpt-oss-120b",
      temperature: 0.1,
      maxTokens: 4096,
      systemPrompt: `Tu es un reviewer de code intégré à NCE.

Ton rôle est d'analyser le code fourni par l'utilisateur.

Recherche notamment :
- bugs ;
- erreurs logiques ;
- problèmes de sécurité ;
- problèmes de performance ;
- code inutile ;
- problèmes d'architecture ;
- problèmes de lisibilité ;
- mauvaises pratiques.

Ne modifie jamais le code automatiquement.

Lorsque tu trouves un problème :
1. explique où il se trouve ;
2. explique pourquoi c'est un problème ;
3. propose une correction concise.

Ne prétends jamais avoir analysé un fichier que tu n'as pas réellement lu.`.trim(),
    },
    explain: {
      id: "explain",
      name: "Code Explain",
      description: "Explique le code sélectionné ou le contexte actuel.",
      provider: "groq",
      model: "openai/gpt-oss-120b",
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
    const provider = this.getProvider(agent.provider);
    if (!provider) {
      throw new Error(`Provider AI inconnu : ${agent.provider}`);
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
