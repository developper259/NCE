const AgentPath = {
  sep: "/",
  normalize(value) {
    if (typeof value !== "string") return "";
    let normalized = value.replace(/\\/g, "/").trim();
    const driveMatch = normalized.match(/^([A-Za-z]:)/);
    const drive = driveMatch ? driveMatch[1].toUpperCase() : "";
    const remainder = drive ? normalized.slice(2) : normalized;
    const absoluteUnix = remainder.startsWith("/");
    const segments = remainder.split("/").filter(Boolean);
    const stack = [];

    for (const segment of segments) {
      if (segment === ".") continue;
      if (segment === "..") {
        if (stack.length) {
          stack.pop();
        } else if (!absoluteUnix && !drive) {
          stack.push("..");
        }
        continue;
      }
      stack.push(segment);
    }

    const joined = stack.join("/");
    if (drive) {
      const withRoot = joined ? `/${joined}` : "";
      return `${drive}${withRoot}`.replace(/\/+$/g, "") || drive;
    }
    if (absoluteUnix) return `/${joined}`.replace(/\/+$/g, "") || "/";
    return joined;
  },
  isAbsolute(value) {
    if (typeof value !== "string") return false;
    const normalized = value.replace(/\\/g, "/");
    return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
  },
  resolve(...segments) {
    const safeSegments = segments.filter(
      (segment) => typeof segment === "string" && segment.length > 0,
    );
    if (!safeSegments.length) return "/";
    const joined = safeSegments
      .map((segment) => segment.replace(/\\/g, "/"))
      .join("/");
    return this.normalize(joined);
  },
  relative(from, to) {
    const base = this.normalize(from);
    const target = this.normalize(to);
    const baseParts = base.split("/").filter(Boolean);
    const targetParts = target.split("/").filter(Boolean);
    let index = 0;

    while (
      index < baseParts.length &&
      index < targetParts.length &&
      baseParts[index] === targetParts[index]
    ) {
      index += 1;
    }

    const up = Array(Math.max(0, baseParts.length - index)).fill("..");
    const down = targetParts.slice(index);
    const relative = [...up, ...down].join("/");
    return relative;
  },
  dirname(value) {
    const normalized = this.normalize(value);
    const index = normalized.lastIndexOf("/");
    if (index < 0) return "";
    if (index === 0) return "/";
    if (index === 2 && /^[A-Za-z]:\//.test(normalized)) {
      return `${normalized.slice(0, 2)}/`;
    }
    return normalized.slice(0, index);
  },
  basename(value) {
    const normalized = this.normalize(value);
    return normalized.slice(normalized.lastIndexOf("/") + 1);
  },
};

class Agent {
  constructor(editor) {
    this.editor = editor;
    this.api = editor?.api || window.api;
    this.window = window;
    this.provider = null;
    this.model = null;
    this.runConfig = null;
    this.tools = new Map();
    this.callbacks = {};
    this.contextProvider = null;
    this.abortController = null;
    this.currentSessionId = null;
    this.isRunning = false;
    this.stopRequested = false;
    this.runId = 0;
    this.maxIterations = 30;
    this.maxIncompleteContinuations = 3;
    this.temperature = undefined;
    this.maxTokens = undefined;
    this.permissions = "code";
    this.messages = [];
    this.fileSnapshots = new Map();
    this.readFileContexts = new Map();
    this.fileContextVersion = 0;
    this.readAfterFailurePaths = new Set();
    this.executedToolCalls = new Map();
    this.executedModificationRequests = new Map();
    this.systemPrompt = "";
    this.agentId = null;
    this.modelFamily = null;
    this.modelConfig = null;
    this.contextWindow = null;
    this.contextCompaction = {
      enabled: true,
      recentIterations: 2,
      softLimitRatio: 0.4,
      hardLimitRatio: 0.7,
      criticalLimitRatio: 0.85,
      safetyMarginTokens: 8192,
      charsPerToken: 4,
      logMetrics: true,
      debugDecisions: false,
    };
    this.lastContextMetrics = null;
    this.supportsTools = true;
    this.supportsToolChoice = true;
    this.modelConfigResolver = null;
    this.fallbackChain = [];
    this.maxProviderRetries = 2;
    this.maxModelFallbacks = 3;
    this.maxRetryDelayMs = 30000;
    this.modelRequestState = null;
    this.modelRequestCounter = 0;
    this.modelOutputStates = new Map();
    this.registerEditorTools();
  }

  setWindow(value) {
    this.window = value || window;
    return this;
  }
  setProvider(provider) {
    if (!provider || typeof provider !== "object")
      throw new TypeError("Le provider doit être un objet.");
    this.provider = { ...provider };
    return this;
  }
  setModel(model) {
    if (typeof model !== "string" || !model.trim())
      throw new TypeError("Le modèle doit être une chaîne non vide.");
    this.model = model.trim();
    return this;
  }
  setSystemPrompt(prompt) {
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new TypeError("Le system prompt doit être une chaîne non vide.");
    }
    this.systemPrompt = prompt.trim();
    return this;
  }
  setModelConfigResolver(resolver) {
    if (resolver !== null && typeof resolver !== "function") {
      throw new TypeError("modelConfigResolver doit être une fonction.");
    }
    this.modelConfigResolver = resolver;
    return this;
  }
  debugTool(name, args, result, details = {}) {
    const preview = (value) => {
      if (typeof value !== "string") return value;
      return value.length > 240
        ? `${value.slice(0, 240)}...[truncated]`
        : value;
    };
    console.info("[NCE Agent tool]", {
      name,
      mode:
        name.startsWith("read") || name.startsWith("search")
          ? "read"
          : name === "modify_file"
            ? "workspace-text"
            : args?.oldText !== undefined
              ? "text"
              : "coordinates",
      request: {
        path: args?.path,
        oldText: preview(args?.oldText),
        newText: preview(args?.newText ?? args?.text),
        expectedText: preview(args?.expectedText),
        nearLine: args?.nearLine ?? null,
        revision: args?.revision ?? null,
        range:
          args?.startLine !== undefined ||
          args?.startColumn !== undefined ||
          args?.endLine !== undefined ||
          args?.endColumn !== undefined
            ? {
                startLine: args?.startLine ?? null,
                startColumn: args?.startColumn ?? null,
                endLine: args?.endLine ?? null,
                endColumn: args?.endColumn ?? null,
              }
            : null,
      },
      result:
        result?.success === false
          ? { success: false, error: result.error }
          : { success: true },
      details,
    });
  }
  setConfig(config = {}) {
    if (Number.isFinite(config.maxIterations)) {
      this.maxIterations = Math.max(1, Math.floor(config.maxIterations));
    }
    if (Number.isFinite(config.maxIncompleteContinuations)) {
      this.maxIncompleteContinuations = Math.max(
        0,
        Math.floor(config.maxIncompleteContinuations),
      );
    }
    if (Number.isFinite(config.temperature)) {
      this.temperature = Math.max(0, Math.min(2, config.temperature));
    }
    if (Number.isFinite(config.maxTokens)) {
      this.maxTokens = Math.max(1, Math.floor(config.maxTokens));
    }
    if (config.permissions === "read" || config.permissions === "code") {
      this.permissions = config.permissions;
    }
    if (typeof config.agent?.id === "string") this.agentId = config.agent.id;
    if (typeof config.agentId === "string") this.agentId = config.agentId;
    if (typeof config.modelFamily === "string" || config.modelFamily === null) {
      this.modelFamily = config.modelFamily;
    }
    if (config.modelConfig && typeof config.modelConfig === "object") {
      this.modelConfig = { ...config.modelConfig };
    }
    this.contextWindow = Number.isFinite(config.contextWindow)
      ? config.contextWindow
      : null;
    if (
      config.contextCompaction &&
      typeof config.contextCompaction === "object"
    ) {
      this.contextCompaction = {
        ...this.contextCompaction,
        ...config.contextCompaction,
      };
    }
    if (typeof config.supportsTools === "boolean") {
      this.supportsTools = config.supportsTools;
    }
    if (typeof config.supportsToolChoice === "boolean") {
      this.supportsToolChoice = config.supportsToolChoice;
    }
    if (Array.isArray(config.fallbackChain)) {
      this.fallbackChain = config.fallbackChain.map((candidate) => ({
        ...candidate,
      }));
    }
    if (Number.isFinite(config.maxProviderRetries)) {
      this.maxProviderRetries = Math.max(
        0,
        Math.floor(config.maxProviderRetries),
      );
    }
    if (Number.isFinite(config.maxModelFallbacks)) {
      this.maxModelFallbacks = Math.max(
        0,
        Math.floor(config.maxModelFallbacks),
      );
    }
    return this;
  }
  setContextProvider(provider) {
    if (provider !== null && typeof provider !== "function")
      throw new TypeError("contextProvider doit être une fonction.");
    this.contextProvider = provider;
    return this;
  }
  setCallbacks(callbacks = {}) {
    for (const name of [
      "onToken",
      "onReasoning",
      "onToolStart",
      "onToolEnd",
      "onModelStatus",
      "onAuthenticationRequired",
      "onError",
      "onFinish",
    ]) {
      if (name in callbacks) {
        if (callbacks[name] !== null && typeof callbacks[name] !== "function")
          throw new TypeError(`${name} doit être une fonction ou null.`);
        this.callbacks[name] = callbacks[name];
      }
    }
    return this;
  }
  registerTool(name, definition) {
    if (
      typeof name !== "string" ||
      !name.trim() ||
      !definition ||
      typeof definition.execute !== "function"
    )
      throw new TypeError(`Définition invalide pour l'outil "${name}".`);
    const parameters = definition.parameters || {
      type: "object",
      properties: {},
    };
    if (
      !this.isPlainObject(parameters) ||
      parameters.type !== "object" ||
      !this.isPlainObject(parameters.properties || {})
    ) {
      throw new TypeError(
        `Le schema de l'outil "${name}" doit avoir une racine object JSON Schema.`,
      );
    }
    const tool = {
      name,
      description: definition.description || "",
      parameters,
      execute: definition.execute,
      readOnly:
        definition.readOnly === true ||
        (typeof AgentAI !== "undefined" &&
          AgentAI.readOnlyTools?.includes(name)),
      enabled: definition.enabled !== false,
    };
    this.tools.set(name, tool);
    return tool;
  }
  unregisterTool(name) {
    return this.tools.delete(name);
  }
  getTool(name) {
    return this.tools.get(name);
  }

  createRunConfig(overrides = {}) {
    const provider = this.provider ? { ...this.provider } : null;
    const providerId =
      overrides.providerId ||
      (provider && typeof provider.id === "string" ? provider.id : null) ||
      this.runConfig?.providerId ||
      "unknown";
    const config = {
      sessionId: overrides.sessionId ?? this.currentSessionId ?? null,
      runId: overrides.runId ?? this.runId,
      agentId: overrides.agentId ?? this.agentId,
      providerId,
      provider: provider ? { ...provider } : null,
      model: overrides.model ?? this.model,
      temperature: Number.isFinite(this.temperature)
        ? this.temperature
        : undefined,
      maxTokens: Number.isFinite(this.maxTokens) ? this.maxTokens : undefined,
      maxIterations: Number.isFinite(this.maxIterations)
        ? this.maxIterations
        : undefined,
      maxIncompleteContinuations: Number.isFinite(
        this.maxIncompleteContinuations,
      )
        ? this.maxIncompleteContinuations
        : undefined,
      permissions: this.permissions || "read",
      systemPrompt: this.systemPrompt || "",
      modelFamily: this.modelFamily,
      modelConfig: this.modelConfig ? { ...this.modelConfig } : null,
      contextWindow: this.contextWindow,
      contextCompaction: { ...this.contextCompaction },
      supportsTools: this.supportsTools && provider?.supportsTools !== false,
      supportsToolChoice:
        this.supportsToolChoice && provider?.supportsToolChoice !== false,
      fallbackChain: this.fallbackChain.map((candidate) => ({ ...candidate })),
      maxProviderRetries: this.maxProviderRetries,
      maxModelFallbacks: this.maxModelFallbacks,
      maxRetryDelayMs: this.maxRetryDelayMs,
    };
    return config;
  }

  async execute(userMessage, options = {}) {
    if (this.isRunning && !this.stopRequested)
      throw new Error("Un agent est déjà en cours d'exécution.");
    if (typeof userMessage !== "string" || !userMessage.trim())
      throw new TypeError("Le message utilisateur est obligatoire.");
    this.isRunning = true;
    this.stopRequested = false;
    this.abortController = new AbortController();
    const runId = ++this.runId;
    const controller = this.abortController;
    const runContext = { sessionId: options.sessionId || null, runId };
    this.currentSessionId = runContext.sessionId;
    const runConfig = this.createRunConfig({
      sessionId: runContext.sessionId,
      runId,
      agentId: options.agentId || null,
      providerId: options.providerId || this.provider?.id || null,
      model: this.model,
    });
    this.runConfig = runConfig;
    this.executedToolCalls = new Map();
    this.executedModificationRequests = new Map();
    this.readFileContexts = new Map();
    this.fileContextVersion = 0;
    this.readAfterFailurePaths = new Set();
    this.modelRequestState = null;
    this.modelRequestCounter = 0;
    this.modelOutputStates = new Map();
    try {
      const editorContext = await this.getContext();
      runConfig.editorContext = editorContext;
      this.messages = [
        {
          role: "system",
          content: this.buildSystemMessage(
            editorContext,
            runConfig.systemPrompt,
          ),
        },
      ];
      const modificationHint = this.detectModificationIntent(userMessage);
      if (modificationHint) {
        this.messages.push({
          role: "system",
          content:
            "PRIORITÉ: cette requête nécessite une modification du projet. Utilise un outil de modification si possible et réponds avec le résultat réel de la modification.",
        });
      }
      this.appendHistory(options.history);
      this.messages.push({ role: "user", content: userMessage });
      const result = await this.runLoop(runId, controller, runConfig, {
        requiresModification:
          runConfig.permissions === "code" &&
          this.detectModificationIntent(userMessage),
        allowsFullCodeResponse: this.requestsFullCodeResponse(userMessage),
      });
      this.callbacks.onFinish?.(result, runContext);
      return result;
    } catch (error) {
      if (!this.isAbortError(error) && runId === this.runId)
        this.callbacks.onError?.(error, runContext);
      throw error;
    } finally {
      if (runId === this.runId) {
        this.isRunning = false;
        this.abortController = null;
        this.currentSessionId = null;
        this.runConfig = null;
      }
    }
  }
  run(userMessage, options = {}) {
    return this.execute(userMessage, options);
  }
  stop() {
    this.stopRequested = true;
    this.abortController?.abort();
  }

  detectModificationIntent(message) {
    if (typeof message !== "string") return false;
    const normalized = message.toLowerCase();
    const actionWords = [
      "corrige",
      "modifie",
      "change",
      "ajoute",
      "crée",
      "cree",
      "écris",
      "ecris",
      "supprime",
      "renomme",
      "refactor",
      "optimise",
      "améliore",
      "implémente",
      "ajuster",
      "fix",
      "update",
      "add",
      "create",
      "write",
      "remove",
      "rename",
      "optimize",
      "implement",
      "refactor",
      "rewrite",
    ];
    const contextWords = [
      "fonction",
      "fichier",
      "classe",
      "composant",
      "bug",
      "erreur",
      "code",
      "script",
    ];
    const hasAction = actionWords.some((word) => normalized.includes(word));
    const hasContext = contextWords.some((word) => normalized.includes(word));
    if (!hasAction) return false;
    return (
      hasContext || normalized.includes("cette") || normalized.includes("ce ")
    );
  }

  requestsFullCodeResponse(message) {
    if (typeof message !== "string") return false;
    const normalized = message.toLowerCase();
    if (
      /(?:ne|n')\s+(?:renvoie|recopie|affiche|montre|fournis|donne)[^.!?\n]{0,80}(?:code|fichier|patch|diff)/.test(
        normalized,
      )
    ) {
      return false;
    }
    return [
      /montre(?:-moi| moi)? (?:le |la |les )?(?:code|fichier)/,
      /(?:donne|fournis)(?:-moi| moi)? (?:le |la )?(?:fichier complet|code complet|patch|diff)/,
      /affiche [^.!?\n]{0,30}(?:code|fichier|fonction)/,
      /(?:show|display) (?:me )?(?:the )?(?:code|full file|complete file|patch|diff)/,
      /(?:give|send) me (?:the )?(?:full file|complete file|code|patch|diff)/,
    ].some((pattern) => pattern.test(normalized));
  }

  isLikelyFullFileDump(text) {
    if (typeof text !== "string") return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    const lines = trimmed.split(/\r?\n/);
    const dumpIntroduction =
      /(?:voici|ci-dessous).{0,40}(?:fichier complet|fichier mis à jour|version finale)|(?:updated|full|complete) file\s*:/i.test(
        trimmed.slice(0, 500),
      );
    const fencedBlocks = [...trimmed.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
    const largestFenceLines = fencedBlocks.reduce(
      (largest, match) =>
        Math.max(largest, String(match[1] || "").split(/\r?\n/).length),
      0,
    );
    if (largestFenceLines >= 30) return true;
    if (dumpIntroduction && (lines.length >= 20 || trimmed.length >= 1500)) {
      return true;
    }
    if (lines.length < 40 && trimmed.length < 5000) return false;
    let codeLikeLines = 0;
    for (const line of lines) {
      const value = line.trim();
      if (!value) continue;
      if (
        /[;{}]$/.test(value) ||
        /^(?:import|export|const|let|var|class|interface|type|function|async|def|public|private|protected|#include)\b/.test(
          value,
        ) ||
        /^(?:<\/?[A-Za-z]|[.#][\w-]+\s*\{)/.test(value)
      ) {
        codeLikeLines += 1;
      }
    }
    return (
      (lines.length >= 60 && codeLikeLines >= 20) ||
      (trimmed.length >= 12000 && lines.length >= 40)
    );
  }

  buildSuccessfulWriteFallback(successfulWrites = []) {
    const writes = successfulWrites.filter(Boolean);
    if (!writes.length) {
      return "Les modifications ont été appliquées et vérifiées.";
    }
    if (writes.length === 1) {
      const write = writes[0];
      if (write.tool === "create_file") {
        return `Fichier créé et vérifié : ${write.path}.`;
      }
      if (write.tool === "rename_file") {
        return `Fichier renommé et vérifié : ${write.path} → ${write.newPath}.`;
      }
      return `Modification appliquée et vérifiée dans ${write.path}.`;
    }
    const files = [];
    for (const write of writes) {
      const label =
        write.tool === "rename_file"
          ? `${write.path} → ${write.newPath}`
          : write.path;
      if (label && !files.includes(label)) files.push(label);
    }
    return `Modifications appliquées dans ${files.length} fichiers :\n${files
      .map((filePath) => `- ${filePath}`)
      .join("\n")}\n\nVérifications post-écriture effectuées.`;
  }

  assertRunActive(runId, controller = this.abortController) {
    if (
      this.stopRequested ||
      runId !== this.runId ||
      controller?.signal?.aborted
    ) {
      throw this.abortError();
    }
  }

  createModelOutputContext(runId, phase = "main") {
    this.modelRequestCounter += 1;
    return {
      sessionId: this.currentSessionId,
      runId,
      requestId: `${runId}:${phase}:${this.modelRequestCounter}`,
    };
  }

  normalizeModelOutput(value, context = {}, mode = "snapshot") {
    if (typeof value !== "string" || !value) {
      return { delta: "", fullText: "", reset: false, revision: 0 };
    }
    const channel = context.channel || "text";
    const requestId = context.requestId || "legacy";
    const key = `${context.runId ?? ""}:${requestId}:${channel}`;
    let state = this.modelOutputStates.get(key);
    if (!state) {
      state = { fullText: "", revision: 0 };
      this.modelOutputStates.set(key, state);
    }

    let delta = value;
    let reset = false;
    if (mode === "delta") {
      state.fullText += value;
    } else if (mode === "snapshot") {
      if (value === state.fullText) {
        delta = "";
      } else if (value.startsWith(state.fullText)) {
        delta = value.slice(state.fullText.length);
      } else if (state.fullText) {
        state.revision += 1;
        reset = true;
      }
      state.fullText = value;
    } else {
      if (value === state.fullText) {
        delta = "";
      } else if (value.startsWith(state.fullText)) {
        delta = value.slice(state.fullText.length);
        state.fullText = value;
      } else {
        state.fullText += value;
      }
    }

    return {
      delta,
      fullText: state.fullText,
      reset,
      revision: state.revision,
    };
  }

  emitModelOutput(channel, value, context, mode = "snapshot") {
    if (typeof value !== "string" || !value) return;
    this.assertRunActive(context.runId);
    const normalized = this.normalizeModelOutput(
      value,
      { ...context, channel },
      mode,
    );
    if (!normalized.delta && !normalized.reset) return;
    const callback =
      channel === "reasoning"
        ? this.callbacks.onReasoning
        : this.callbacks.onToken;
    callback?.(normalized.delta, {
      ...context,
      contentMode: "delta",
      resetSegment: normalized.reset,
      segmentId: `${context.requestId}:${channel}:${normalized.revision}`,
    });
  }

  resolveToolChoice(message) {
    return "auto";
  }

  normalizeFinishReason(result, message = null, toolCalls = []) {
    const choice = result?.choices?.[0];
    const rawReason =
      choice?.finish_reason ??
      choice?.finishReason ??
      choice?.stop_reason ??
      choice?.stopReason ??
      result?.finish_reason ??
      result?.finishReason ??
      result?.stop_reason ??
      result?.stopReason ??
      result?.incomplete_details?.reason ??
      message?.finish_reason ??
      message?.finishReason ??
      message?.stop_reason ??
      message?.stopReason ??
      null;
    const reason =
      typeof rawReason === "string" ? rawReason.trim().toLowerCase() : "";
    if (toolCalls.length > 0 || ["tool_calls", "function_call"].includes(reason)) {
      return "tool_calls";
    }
    if (
      [
        "length",
        "max_tokens",
        "max_output_tokens",
        "model_length",
        "token_limit",
      ].includes(reason)
    ) {
      return "length";
    }
    if (["stop", "end_turn", "stop_sequence", "eos", "eos_token", "end"].includes(reason)) {
      return "stop";
    }
    if (["content_filter", "safety", "blocked"].includes(reason)) {
      return "content_filter";
    }
    if (["error", "failed", "failure"].includes(reason)) return "error";
    if (
      ["incomplete", "cancelled", "canceled"].includes(reason) ||
      String(result?.status || "").toLowerCase() === "incomplete"
    ) {
      return "incomplete";
    }
    return "unknown";
  }

  evaluateIterationOutcome({
    finishReason = "unknown",
    hasReasoning = false,
    hasText = false,
    toolCallCount = 0,
    requiresModification = false,
    modificationPerformed = false,
    validationPending = false,
  } = {}) {
    if (toolCallCount > 0) {
      return { action: "execute_tools", reason: "tool_calls_available" };
    }
    if (finishReason === "error" || finishReason === "content_filter") {
      return { action: "fail", reason: `provider_${finishReason}` };
    }
    if (finishReason === "length" || finishReason === "incomplete") {
      return { action: "continue", reason: `generation_${finishReason}` };
    }
    if (finishReason === "tool_calls") {
      return { action: "continue", reason: "missing_finalized_tool_calls" };
    }
    if (hasReasoning && !hasText) {
      return { action: "continue", reason: "reasoning_without_final_text" };
    }
    if (!hasText) {
      return { action: "continue", reason: "empty_model_turn" };
    }
    if (requiresModification && !modificationPerformed) {
      return { action: "continue", reason: "required_write_missing" };
    }
    if (validationPending) {
      return { action: "continue", reason: "post_write_validation_pending" };
    }
    return { action: "finish", reason: "final_response_complete" };
  }

  debugIterationDecision(details = {}) {
    console.debug("[NCE Agent iteration]", {
      iteration: details.iteration,
      modelTurn: details.modelTurn,
      finishReason: details.finishReason,
      hasReasoning: details.hasReasoning,
      hasText: details.hasText,
      toolCallCount: details.toolCallCount,
      requiresModification: details.requiresModification,
      modificationPerformed: details.modificationPerformed,
      validationPending: details.validationPending,
      incompleteContinuations: details.incompleteContinuations,
      decision: String(details.decision || "").toUpperCase(),
      decisionReason: details.decisionReason,
    });
  }

  createIncompleteGenerationError(reason, count, limit) {
    const error = new Error(
      `La génération est restée incomplète après ${count} continuations (${reason}).`,
    );
    error.name = "AgentIncompleteGenerationError";
    error.code = "GENERATION_INCOMPLETE";
    error.category = "GENERATION_INCOMPLETE";
    error.reason = reason;
    error.continuations = count;
    error.maxIncompleteContinuations = limit;
    return error;
  }

  createIterationFailure(finishReason) {
    const filtered = finishReason === "content_filter";
    const error = new Error(
      filtered
        ? "La réponse du modèle a été bloquée par le filtre de contenu."
        : "Le provider a terminé la génération avec une erreur.",
    );
    error.name = "AgentGenerationError";
    error.code = filtered ? "GENERATION_CONTENT_FILTERED" : "GENERATION_FAILED";
    error.category = error.code;
    error.finishReason = finishReason;
    return error;
  }

  createMaxIterationsError(iterations, limit) {
    const error = new Error(`Nombre maximal d'itérations atteint (${limit}).`);
    error.name = "AgentMaxIterationsError";
    error.code = "MAX_ITERATIONS_REACHED";
    error.category = "MAX_ITERATIONS_REACHED";
    error.iterations = iterations;
    error.maxIterations = limit;
    return error;
  }

  appendIncompleteContinuation(parsed, decisionReason) {
    if (parsed.text) {
      this.messages.push({ role: "assistant", content: parsed.text });
    }
    this.messages.push({
      role: "system",
      content:
        decisionReason === "reasoning_without_final_text"
          ? "Continue l'exécution. Tu as produit un raisonnement intermédiaire sans action ni réponse finale. Ne répète pas les étapes déjà effectuées."
          : decisionReason === "post_write_validation_pending"
            ? "Continue l'exécution. Une modification a réussi mais sa validation reste incomplète. Relis le fichier concerné et vérifie le résultat réel avant de répondre."
          : "Continue la tâche à partir de l'état actuel. La génération précédente s'est terminée avant sa finalisation. Ne répète pas les étapes déjà effectuées et utilise les tools nécessaires.",
    });
  }

  toolResultConfirmsValidation(toolPayload) {
    return toolPayload?.verification?.verified === true;
  }

  async runLoop(runId, controller, runConfig = this.runConfig, runState = {}) {
    let finalResponse = "";
    let finalReasoning = "";
    let postEditRepairAttempts = 0;
    let modificationFailures = 0;
    let failedModifications = [];
    const requiresModification = runState.requiresModification === true;
    const allowsFullCodeResponse = runState.allowsFullCodeResponse === true;
    let successfulWriteCount = 0;
    const successfulWrites = [];
    let missingWriteRetries = 0;
    let finalSummaryRequested = false;
    let incompleteContinuations = 0;
    let modelTurn = 0;
    let toolIterations = 0;
    let validationPending = false;
    const pendingValidationPaths = new Set();
    const maxIterations = runConfig?.maxIterations ?? this.maxIterations;
    const maxIncompleteContinuations =
      runConfig?.maxIncompleteContinuations ?? this.maxIncompleteContinuations;
    const writeTools = new Set([
      "modify_file",
      "create_file",
      "rename_file",
      "modify_active_file",
      "replace_text",
    ]);
    const readTools = new Set([
      "read_file",
      "read_active_file",
      "search_active_file",
      "search_project_files",
      "list_project_files",
      "get_project_map",
      "get_editor_context",
      "get_cursor",
      "read_selection",
    ]);
    while (true) {
      const iteration = toolIterations + 1;
      modelTurn += 1;
      this.assertRunActive(runId, controller);
      runConfig.contextState = {
        writesSucceeded: successfulWriteCount,
        successfulWrites: successfulWrites.map((write) => ({ ...write })),
        pendingValidation: validationPending,
        pendingValidationPaths: [...pendingValidationPaths],
        lastModificationError:
          failedModifications[failedModifications.length - 1] || null,
      };
      const outputContext = this.createModelOutputContext(runId, "main");
      const modelResponse = await this.requestModel(controller, runConfig);
      this.assertRunActive(runId, controller);
      const parsed = this.parseResponse(modelResponse, {
        source: "provider_response",
        iteration,
        runId,
        provider: runConfig?.providerId,
        model: runConfig?.model,
      });
      finalResponse = parsed.text || "";
      finalReasoning = parsed.reasoning || finalReasoning;
      let outcome = this.evaluateIterationOutcome({
        finishReason: parsed.finishReason,
        hasReasoning: Boolean(parsed.reasoning),
        hasText: Boolean(parsed.text.trim()),
        toolCallCount: parsed.toolCalls.length,
        requiresModification,
        modificationPerformed: successfulWriteCount > 0,
        validationPending,
      });
      if (
        outcome.action === "execute_tools" &&
        toolIterations >= maxIterations
      ) {
        outcome = { action: "fail", reason: "max_iterations_reached" };
      } else if (
        outcome.reason === "required_write_missing" &&
        missingWriteRetries >= 2
      ) {
        outcome = { action: "fail", reason: "required_write_not_performed" };
      }
      this.debugIterationDecision({
        iteration,
        modelTurn,
        finishReason: parsed.finishReason,
        hasReasoning: Boolean(parsed.reasoning),
        hasText: Boolean(parsed.text.trim()),
        toolCallCount: parsed.toolCalls.length,
        requiresModification,
        modificationPerformed: successfulWriteCount > 0,
        validationPending,
        incompleteContinuations,
        decision: outcome.action,
        decisionReason: outcome.reason,
      });
      if (parsed.reasoning) {
        this.emitModelOutput(
          "reasoning",
          parsed.reasoning,
          outputContext,
          "snapshot",
        );
      }
      if (
        parsed.text &&
        (!requiresModification ||
          (parsed.toolCalls.length > 0 && !finalSummaryRequested))
      ) {
        this.emitModelOutput(
          "assistant",
          parsed.text,
          outputContext,
          "snapshot",
        );
      }
      if (outcome.action === "fail") {
        if (outcome.reason === "max_iterations_reached") {
          throw this.createMaxIterationsError(toolIterations, maxIterations);
        }
        if (outcome.reason === "required_write_not_performed") {
          this.emitModelOutput(
            "assistant",
            parsed.text,
            outputContext,
            "snapshot",
          );
          return {
            response:
              "La modification n'a pas été effectuée : aucun outil d'écriture n'a réussi.",
            reasoning: finalReasoning,
            error: {
              code: "WRITE_REQUIRED_NOT_PERFORMED",
              message: "Aucun outil d'écriture n'a réussi pour cette demande.",
            },
            iterations: iteration,
          };
        }
        throw this.createIterationFailure(parsed.finishReason);
      }
      if (outcome.action === "continue") {
        if (outcome.reason === "required_write_missing") {
          this.emitModelOutput(
            "assistant",
            parsed.text,
            outputContext,
            "snapshot",
          );
          missingWriteRetries += 1;
          this.messages.push({
            role: "system",
            content:
              "La demande nécessite une modification réelle du projet. Aucun outil d'écriture n'a encore réussi. N'envoie pas le code dans le chat : utilise modify_file, create_file ou rename_file.",
          });
          continue;
        }
        incompleteContinuations += 1;
        if (incompleteContinuations > maxIncompleteContinuations) {
          throw this.createIncompleteGenerationError(
            outcome.reason,
            incompleteContinuations,
            maxIncompleteContinuations,
          );
        }
        this.appendIncompleteContinuation(parsed, outcome.reason);
        continue;
      }
      if (outcome.action === "finish") {
        incompleteContinuations = 0;
        if (requiresModification && successfulWriteCount > 0) {
          const looksLikeDump = this.isLikelyFullFileDump(parsed.text);
          if (
            looksLikeDump &&
            !allowsFullCodeResponse &&
            !finalSummaryRequested
          ) {
            finalSummaryRequested = true;
            finalResponse = "";
            this.messages.push({
              role: "system",
              content:
                "Les modifications ont déjà été appliquées avec succès. Ne renvoie pas le contenu complet des fichiers. Fournis uniquement un résumé concis des changements et des vérifications, sans appeler de tool.",
            });
            continue;
          }
          if (looksLikeDump && !allowsFullCodeResponse) {
            finalResponse = this.buildSuccessfulWriteFallback(successfulWrites);
          }
          if (finalResponse) {
            this.emitModelOutput(
              "assistant",
              finalResponse,
              outputContext,
              looksLikeDump && !allowsFullCodeResponse ? "delta" : "snapshot",
            );
          }
        }
        return failedModifications.length > 0
          ? {
              response: `Certaines modifications n'ont pas été appliquées : ${failedModifications.join("; ")}.`,
              reasoning: finalReasoning,
              error: { code: "PARTIAL_MODIFICATION_FAILURE" },
              iterations: iteration,
            }
          : {
              response: finalResponse,
              reasoning: finalReasoning,
              iterations: iteration,
            };
      }
      incompleteContinuations = 0;
      const hasReadCall = parsed.toolCalls.some((call) =>
        readTools.has(call?.function?.name),
      );
      const hasWriteCall = parsed.toolCalls.some((call) =>
        writeTools.has(call?.function?.name),
      );
      const orderedToolCalls = [...parsed.toolCalls].sort((left, right) => {
        return (
          Number(!readTools.has(left?.function?.name)) -
          Number(!readTools.has(right?.function?.name))
        );
      });
      const executableToolCalls =
        hasReadCall && hasWriteCall
          ? orderedToolCalls.filter((call) =>
              readTools.has(call?.function?.name),
            )
          : hasWriteCall
            ? orderedToolCalls
                .filter((call) => writeTools.has(call?.function?.name))
                .slice(0, 1)
            : orderedToolCalls;
      this.messages.push(
        this.createAssistantToolCallMessage(
          parsed.assistantMessage,
          executableToolCalls,
          {
            source: "run_loop",
            iteration,
            runId,
            provider: runConfig?.providerId,
            model: runConfig?.model,
          },
        ),
      );
      for (const call of executableToolCalls) {
        this.assertRunActive(runId, controller);
        const toolResult = await this.executeToolCall(call, {
          sessionId: this.currentSessionId,
          runId,
        });
        this.assertRunActive(runId, controller);
        this.messages.push(this.createToolResultMessage(call.id, toolResult));

        const toolPayload = toolResult?.result ?? toolResult;
        let toolArgs = {};
        try {
          toolArgs = this.parseCanonicalToolArguments(
            call?.function?.arguments,
          );
        } catch {
          toolArgs = {};
        }
        const modificationTool =
          call?.function?.name === "modify_active_file" ||
          call?.function?.name === "replace_text" ||
          call?.function?.name === "modify_file";
        if (writeTools.has(call?.function?.name) && toolResult?.success) {
          successfulWriteCount += 1;
          missingWriteRetries = 0;
          const affectedPath = AgentPath.normalize(
            toolPayload?.newPath ||
              toolPayload?.path ||
              toolArgs?.newPath ||
              toolArgs?.path ||
              "",
          );
          if (this.toolResultConfirmsValidation(toolPayload)) {
            if (affectedPath) pendingValidationPaths.delete(affectedPath);
          } else if (affectedPath) {
            pendingValidationPaths.add(affectedPath);
          } else {
            pendingValidationPaths.add("[unknown-write-target]");
          }
          validationPending = pendingValidationPaths.size > 0;
          successfulWrites.push({
            tool: call.function.name,
            path: toolPayload?.path || toolPayload?.oldPath || "fichier",
            newPath: toolPayload?.newPath || "",
          });
        } else if (
          ["read_file", "read_active_file"].includes(call?.function?.name) &&
          toolResult?.success
        ) {
          const readPath = AgentPath.normalize(
            toolArgs?.path ||
              toolPayload?.path ||
              this.editor?.tabManager?.activeFile?.path ||
              "",
          );
          if (readPath) {
            for (const pendingPath of pendingValidationPaths) {
              if (
                readPath === pendingPath ||
                readPath.endsWith(`/${pendingPath}`) ||
                pendingPath.endsWith(`/${readPath}`)
              ) {
                pendingValidationPaths.delete(pendingPath);
              }
            }
          }
          validationPending = pendingValidationPaths.size > 0;
        }
        const retryableErrorCodes = new Set([
          "CONTENT_MISMATCH",
          "INVALID_RANGE",
          "NO_MATCH",
          "AMBIGUOUS_MATCH",
          "MODIFICATION_VERIFICATION_FAILED",
          "SUSPECTED_DUPLICATION",
        ]);
        if (modificationTool && toolResult?.success === false) {
          if (retryableErrorCodes.has(toolPayload?.error?.code)) {
            modificationFailures += 1;
          }
          const failureMessage =
            toolPayload?.error?.message || "échec de modification";
          failedModifications.push(
            `${call?.function?.name || "outil de modification"}: ${failureMessage}`,
          );
          if (modificationFailures >= 2) {
            return {
              response:
                "Modification arrêtée après deux échecs de validation. Relis le fichier et relance une demande avec un contexte actualisé.",
              reasoning: finalReasoning,
              error: toolPayload.error,
              iterations: iteration,
            };
          }
        } else if (modificationTool && toolResult?.success) {
          modificationFailures = 0;
          failedModifications.pop();
        }

        const toolName = call?.function?.name;
        if (toolName === "modify_active_file" && toolResult?.success) {
          const validation = this.validateActiveFileSyntax();
          if (!validation.valid) {
            if (postEditRepairAttempts >= 3) {
              throw new Error(
                `La validation du fichier échoue après correction automatique : ${validation.error}`,
              );
            }
            postEditRepairAttempts += 1;
            const activePath = AgentPath.normalize(
              this.editor?.tabManager?.activeFile?.path || "",
            );
            pendingValidationPaths.add(activePath || "[active-file]");
            validationPending = true;
            this.messages.push({
              role: "system",
              content: `VALIDATION POST-MODIFICATION : le fichier modifié contient une erreur de syntaxe (${validation.error}). Lis le code actuel, corrige immédiatement la cause et réapplique une modification valide avant de répondre.`,
            });
          }
        }
      }
      if (hasReadCall && hasWriteCall) {
        this.messages.push({
          role: "system",
          content:
            "Les lectures ont été exécutées. Décide des écritures au prochain tour avec leur résultat.",
        });
      } else if (
        hasWriteCall &&
        orderedToolCalls.filter((call) => writeTools.has(call?.function?.name))
          .length > executableToolCalls.length
      ) {
        this.messages.push({
          role: "system",
          content:
            "Une seule écriture a été exécutée. Réévalue les écritures restantes au prochain tour à partir du résultat réel.",
        });
      }
      toolIterations += 1;
    }
  }

  async requestModel(
    controller = this.abortController,
    runConfig = this.runConfig,
  ) {
    const config = runConfig || this.createRunConfig();
    const state = this.getModelRequestState(config);
    let retryCount = 0;

    while (state.currentConfig) {
      const activeConfig = state.currentConfig;
      try {
        const result = await this.requestSingleModel(controller, activeConfig);
        this.applyActiveModelConfig(config, activeConfig);
        return result;
      } catch (error) {
        if (this.isAbortError(error) && controller?.signal?.aborted)
          throw error;
        if (error?.code === "MESSAGE_SERIALIZATION_FAILED") throw error;
        const classified = this.classifyModelError(error, error?.response, {
          provider: activeConfig.provider,
          providerId: activeConfig.providerId,
          model: activeConfig.model,
          modelConfig: activeConfig.modelConfig,
        });
        state.failures.push(classified);
        this.debugModelError(classified, {
          retryCount,
          fallbackCount: state.modelFallbackCount,
        });

        if (
          classified.category === "AUTH_ERROR" &&
          !state.authenticationCancelledProviders.has(
            activeConfig.providerId,
          ) &&
          typeof this.callbacks.onAuthenticationRequired === "function"
        ) {
          let replacementKey = "";
          try {
            replacementKey = await this.callbacks.onAuthenticationRequired(
              classified,
              {
                sessionId: config.sessionId ?? this.currentSessionId,
                runId: config.runId ?? this.runId,
                providerId: activeConfig.providerId,
              },
            );
          } catch (authenticationError) {
            console.error(
              "[NCE Agent model] impossible de remplacer la clé API",
              authenticationError,
            );
          }
          this.assertRunActive(config.runId, controller);
          if (typeof replacementKey === "string" && replacementKey.trim()) {
            const apiKey = replacementKey.trim();
            activeConfig.provider = {
              ...activeConfig.provider,
              apiKey,
            };
            if (config.providerId === activeConfig.providerId) {
              config.provider = { ...config.provider, apiKey };
            }
            state.currentConfig = activeConfig;
            retryCount = 0;
            continue;
          }
          state.authenticationCancelledProviders.add(activeConfig.providerId);
        }

        const retryDelay = this.getModelRetryDelay(classified, retryCount);
        const mayRetry =
          classified.retryable &&
          retryCount < (config.maxProviderRetries ?? this.maxProviderRetries) &&
          retryDelay <= (config.maxRetryDelayMs ?? this.maxRetryDelayMs);
        if (mayRetry) {
          retryCount += 1;
          state.providerRetryCount += 1;
          this.emitModelStatus(
            {
              kind: "retry",
              classification: classified,
              delayMs: retryDelay,
              attempt: retryCount,
              userMessage: `${classified.userMessage} Nouvelle tentative dans ${this.formatRetryDelay(retryDelay)}…`,
            },
            config,
          );
          await this.waitForModelRetry(retryDelay, controller);
          continue;
        }

        if (
          classified.category === "MODEL_NOT_FOUND" ||
          classified.category === "NO_CAPACITY" ||
          classified.category === "NO_TOKENS_AVAILABLE" ||
          classified.category === "MODEL_UNAVAILABLE"
        ) {
          state.unhealthyModels.add(
            `${activeConfig.providerId}:${activeConfig.model}`,
          );
        }

        const fallback = classified.fallbackRecommended
          ? this.takeNextFallback(state, classified, config)
          : null;
        if (fallback) {
          const previous = activeConfig;
          state.currentConfig = fallback;
          state.modelFallbackCount += 1;
          retryCount = 0;
          this.applyActiveModelConfig(config, fallback);
          this.emitModelStatus(
            {
              kind: "fallback",
              classification: classified,
              fromProvider: previous.providerId,
              fromModel: previous.model,
              toProvider: fallback.providerId,
              toModel: fallback.model,
              userMessage: `${this.getModelDisplayName(previous)} est indisponible. Basculement vers ${this.getModelDisplayName(fallback)}…`,
            },
            config,
          );
          continue;
        }

        throw this.createFinalModelError(classified, state);
      }
    }

    throw this.createFinalModelError(
      this.classifyModelError(new Error("Aucun modèle IA configuré."), null, {
        provider: config.provider,
        providerId: config.providerId,
        model: config.model,
        modelConfig: config.modelConfig,
      }),
      state,
    );
  }

  async requestSingleModel(controller, config) {
    const provider = config.provider || this.provider;
    if (!provider?.baseURL) {
      throw Object.assign(new Error("Aucun provider IA configuré."), {
        code: "PROVIDER_NOT_CONFIGURED",
      });
    }
    if (!config.model) {
      throw Object.assign(new Error("Aucun modèle IA configuré."), {
        code: "MODEL_NOT_CONFIGURED",
      });
    }
    const modelContext = this.buildModelContext(this.messages, config);
    const providerMessages = this.normalizeMessagesForProvider(modelContext);
    const payload = {
      model: config.model,
      messages: providerMessages,
      stream: false,
    };
    if (config.supportsTools !== false && provider.supportsTools !== false) {
      payload.tools = this.getOpenAITools();
      if (
        config.supportsToolChoice !== false &&
        provider.supportsToolChoice !== false
      ) {
        payload.tool_choice = this.resolveToolChoice(
          this.messages[this.messages.length - 1]?.content || "",
        );
      }
    }
    if (Number.isFinite(config.temperature))
      payload.temperature = config.temperature;
    if (Number.isFinite(config.maxTokens))
      payload.max_tokens = config.maxTokens;
    const sanitizedProvider = { ...provider };
    delete sanitizedProvider.apiKey;
    if (typeof this.api?.aiChat === "function") {
      const result = await this.api.aiChat({
        provider: sanitizedProvider,
        payload,
      });
      return this.unwrapModelTransportResult(result);
    }
    if (typeof this.api?.requestAI === "function") {
      const result = await this.api.requestAI({
        provider: sanitizedProvider,
        payload,
      });
      return this.unwrapModelTransportResult(result);
    }
    const headers = { "Content-Type": "application/json" };
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
    const url = `${provider.baseURL.replace(/\/+$/, "")}/chat/completions`;
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), 60000);
    try {
      const signal =
        controller?.signal && typeof AbortSignal?.any === "function"
          ? AbortSignal.any([controller.signal, timeoutController.signal])
          : timeoutController.signal;
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal,
      });
      if (!response.ok) {
        const text = await response.text();
        let body = text;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
        const transportError = new Error(
          `Model request failed (${response.status})`,
        );
        transportError.status = response.status;
        transportError.body = body;
        transportError.response = response;
        throw transportError;
      }
      return response.json();
    } catch (error) {
      if (
        error?.name === "AbortError" &&
        !controller?.signal?.aborted &&
        timeoutController.signal.aborted
      ) {
        throw Object.assign(new Error("Le provider ne répond pas."), {
          name: "TimeoutError",
          code: "ETIMEDOUT",
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  getSafeValuePreview(value, maxLength = 240) {
    const seen = new Set();
    const summarize = (entry, depth = 0, key = "") => {
      if (/api.?key|authorization|secret|token/i.test(key)) {
        return "[redacted]";
      }
      if (typeof entry === "string") {
        return entry.length <= 80 ? entry : `${entry.slice(0, 80)}…`;
      }
      if (
        entry === null ||
        typeof entry === "number" ||
        typeof entry === "boolean"
      ) {
        return entry;
      }
      if (typeof entry === "bigint") return `${entry}n`;
      if (typeof entry !== "object") return `[${typeof entry}]`;
      if (seen.has(entry)) return "[circular]";
      if (depth >= 2) return `[${entry.constructor?.name || "Object"}]`;
      seen.add(entry);
      if (Array.isArray(entry)) {
        const result = entry
          .slice(0, 5)
          .map((item) => summarize(item, depth + 1));
        if (entry.length > 5) result.push(`… ${entry.length - 5} more`);
        return result;
      }
      const result = {};
      const entries = Object.entries(entry).slice(0, 10);
      for (const [entryKey, item] of entries) {
        result[entryKey] = summarize(item, depth + 1, entryKey);
      }
      if (Object.keys(entry).length > entries.length) result["…"] = "truncated";
      return result;
    };
    let preview = "";
    try {
      preview = JSON.stringify(summarize(value));
    } catch {
      preview = Object.prototype.toString.call(value);
    }
    if (typeof preview !== "string") preview = String(preview);
    return preview.length <= maxLength
      ? preview
      : `${preview.slice(0, maxLength)}…`;
  }

  assertJsonSafeArguments(value, path = "function.arguments", seen = new Set()) {
    if (value === null) return;
    const valueType = typeof value;
    if (valueType === "string" || valueType === "boolean") return;
    if (valueType === "number") {
      if (Number.isFinite(value)) return;
      throw new TypeError(`${path} contient un nombre non fini`);
    }
    if (
      valueType === "undefined" ||
      valueType === "function" ||
      valueType === "symbol" ||
      valueType === "bigint"
    ) {
      throw new TypeError(`${path} contient une valeur ${valueType}`);
    }
    if (seen.has(value)) throw new TypeError(`${path} contient une référence circulaire`);
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry, index) =>
        this.assertJsonSafeArguments(entry, `${path}[${index}]`, seen),
      );
      seen.delete(value);
      return;
    }
    if (!this.isPlainObject(value)) {
      throw new TypeError(`${path} contient un objet complexe non autorisé`);
    }
    for (const [key, entry] of Object.entries(value)) {
      this.assertJsonSafeArguments(entry, `${path}.${key}`, seen);
    }
    seen.delete(value);
  }

  parseCanonicalToolArguments(value) {
    if (value === null || value === undefined || value === "") return {};
    let parsed = value;
    if (typeof value === "string") parsed = JSON.parse(value);
    if (!this.isPlainObject(parsed)) {
      throw new TypeError("les arguments doivent représenter un objet JSON");
    }
    this.assertJsonSafeArguments(parsed);
    return parsed;
  }

  createToolCallValidationError(toolCall, toolCallIndex, reason, context = {}) {
    const toolName = toolCall?.function?.name || "(inconnu)";
    const value = toolCall?.function?.arguments;
    const error = new Error(
      `Tool call invalide pour ${toolName} : ${reason || "format incompatible"}.`,
    );
    error.name = "AgentToolCallValidationError";
    error.code = "TOOL_CALL_FINALIZATION_FAILED";
    error.category = "TOOL_CALL_FINALIZATION_FAILED";
    error.messageIndex = Number.isInteger(context.messageIndex)
      ? context.messageIndex
      : null;
    error.toolCallIndex = Number.isInteger(toolCallIndex) ? toolCallIndex : null;
    error.toolName = toolName;
    error.field = "function.arguments";
    error.valueType =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    error.reason = reason || "format incompatible";
    error.source = context.source || "provider_response";
    error.runId = context.runId ?? this.runId;
    error.userMessage = `Le modèle a produit un appel invalide pour l'outil ${toolName}.`;
    console.error("[NCE Tool Call invalid]", {
      code: error.code,
      messageIndex: error.messageIndex,
      toolCallIndex: error.toolCallIndex,
      toolName,
      field: error.field,
      valueType: error.valueType,
      reason: error.reason,
      argumentsPreview: this.getSafeValuePreview(value),
      source: error.source,
      runId: error.runId,
      provider: context.provider || this.runConfig?.providerId || null,
      model: context.model || this.runConfig?.model || this.model || null,
    });
    return error;
  }

  finalizeToolCall(toolCall, toolCallIndex = 0, context = {}) {
    try {
      if (!this.isPlainObject(toolCall)) throw new TypeError("tool_call doit être un objet");
      if (typeof toolCall.id !== "string" || !toolCall.id.trim()) {
        throw new TypeError("id manquant ou invalide");
      }
      if (!this.isPlainObject(toolCall.function)) {
        throw new TypeError("function doit être un objet");
      }
      if (
        typeof toolCall.function.name !== "string" ||
        !toolCall.function.name.trim()
      ) {
        throw new TypeError("function.name manquant ou invalide");
      }
      const args = this.parseCanonicalToolArguments(
        toolCall.function.arguments,
      );
      return {
        id: toolCall.id.trim(),
        type: "function",
        function: {
          name: toolCall.function.name.trim(),
          arguments: JSON.stringify(args),
        },
      };
    } catch (error) {
      throw this.createToolCallValidationError(
        toolCall,
        toolCallIndex,
        error?.message,
        context,
      );
    }
  }

  finalizeToolCalls(toolCalls, context = {}) {
    if (!Array.isArray(toolCalls)) return [];
    return toolCalls.map((toolCall, toolCallIndex) =>
      this.finalizeToolCall(toolCall, toolCallIndex, context),
    );
  }

  createMessageSerializationError(
    messageIndex,
    toolCallIndex,
    field,
    value,
    reason,
    details = {},
  ) {
    const valueType =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const error = new Error(
      `Impossible de sérialiser le message ${messageIndex}${Number.isInteger(toolCallIndex) ? `, tool call ${toolCallIndex}` : ""} pour le provider.`,
    );
    error.name = "AgentMessageSerializationError";
    error.code = "MESSAGE_SERIALIZATION_FAILED";
    error.category = "MESSAGE_SERIALIZATION_FAILED";
    error.retryable = false;
    error.fallbackRecommended = false;
    error.userMessage = error.message;
    error.messageIndex = messageIndex;
    error.toolCallIndex = Number.isInteger(toolCallIndex)
      ? toolCallIndex
      : null;
    error.field = field;
    error.valueType = valueType;
    error.toolName = details.toolName || null;
    error.reason = reason || "format incompatible";
    error.valuePreview = this.getSafeValuePreview(value);
    error.runId = details.runId ?? this.runId;
    error.technicalMessage = `${field} contient une valeur de type ${valueType}${reason ? ` (${reason})` : ""}.`;
    console.error("[NCE Agent serialization]", {
      code: error.code,
      messageIndex: error.messageIndex,
      toolCallIndex: error.toolCallIndex,
      toolName: error.toolName,
      field: error.field,
      valueType: error.valueType,
      reason: error.reason,
      argumentsPreview: error.valuePreview,
      runId: error.runId,
      provider: this.runConfig?.providerId || this.provider?.id || null,
      model: this.runConfig?.model || this.model || null,
    });
    return error;
  }
  normalizeToolArgumentsForProvider(
    value,
    messageIndex,
    toolCallIndex,
    toolName = null,
  ) {
    try {
      return JSON.stringify(this.parseCanonicalToolArguments(value));
    } catch (error) {
      throw this.createMessageSerializationError(
        messageIndex,
        toolCallIndex,
        "function.arguments",
        value,
        error?.message || "JSON non sérialisable",
        { toolName },
      );
    }
  }

  normalizeToolResultForHistory(value, path = "result", seen = new Set()) {
    if (value === null) return null;
    const valueType = typeof value;
    if (valueType === "string" || valueType === "boolean") return value;
    if (valueType === "number") return Number.isFinite(value) ? value : null;
    if (valueType === "bigint") return value.toString();
    if (
      valueType === "undefined" ||
      valueType === "function" ||
      valueType === "symbol"
    ) {
      return undefined;
    }
    const objectTag = Object.prototype.toString.call(value);
    if (value instanceof Error || objectTag.endsWith("Error]")) {
      return {
        name: value.name || "Error",
        message: value.message || String(value),
        ...(value.code !== undefined ? { code: String(value.code) } : {}),
      };
    }
    if (value instanceof Date || objectTag === "[object Date]") {
      return new Date(value).toISOString();
    }
    if (value instanceof RegExp || objectTag === "[object RegExp]") {
      return String(value);
    }
    if (seen.has(value)) {
      const error = new TypeError(`${path} contient une référence circulaire`);
      error.code = "TOOL_RESULT_SERIALIZATION_FAILED";
      throw error;
    }
    seen.add(value);
    if (value instanceof Map || objectTag === "[object Map]") {
      const entries = [...value.entries()];
      const allStringKeys = entries.every(([key]) => typeof key === "string");
      const normalized = allStringKeys ? {} : [];
      for (const [key, entry] of entries) {
        const safeEntry = this.normalizeToolResultForHistory(
          entry,
          `${path}.${String(key)}`,
          seen,
        );
        if (allStringKeys) {
          if (safeEntry !== undefined) normalized[key] = safeEntry;
        } else {
          normalized.push([
            this.normalizeToolResultForHistory(key, `${path}.key`, seen) ?? null,
            safeEntry ?? null,
          ]);
        }
      }
      seen.delete(value);
      return normalized;
    }
    if (value instanceof Set || objectTag === "[object Set]") {
      const normalized = [...value].map(
        (entry, index) =>
          this.normalizeToolResultForHistory(
            entry,
            `${path}[${index}]`,
            seen,
          ) ?? null,
      );
      seen.delete(value);
      return normalized;
    }
    if (ArrayBuffer.isView(value)) {
      const normalized = Array.from(value);
      seen.delete(value);
      return normalized;
    }
    if (Array.isArray(value)) {
      const normalized = value.map(
        (entry, index) =>
          this.normalizeToolResultForHistory(
            entry,
            `${path}[${index}]`,
            seen,
          ) ?? null,
      );
      seen.delete(value);
      return normalized;
    }
    if (!this.isPlainObject(value)) {
      const error = new TypeError(`${path} contient un objet complexe non pris en charge`);
      error.code = "TOOL_RESULT_SERIALIZATION_FAILED";
      throw error;
    }
    const normalized = {};
    for (const [key, entry] of Object.entries(value)) {
      const safeEntry = this.normalizeToolResultForHistory(
        entry,
        `${path}.${key}`,
        seen,
      );
      if (safeEntry !== undefined) normalized[key] = safeEntry;
    }
    seen.delete(value);
    return normalized;
  }

  normalizeToolContentForProvider(value, messageIndex) {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return "";
    try {
      const serialized = JSON.stringify(
        this.normalizeToolResultForHistory(value, "content"),
      );
      if (typeof serialized !== "string") throw new TypeError("résultat vide");
      return serialized;
    } catch (error) {
      throw this.createMessageSerializationError(
        messageIndex,
        null,
        "content",
        value,
        error?.message || "JSON non sérialisable",
      );
    }
  }

  getContextCompactionConfig(config = {}) {
    const source = {
      ...this.contextCompaction,
      ...(config.contextCompaction || {}),
    };
    const number = (value, fallback, minimum = 0) =>
      Number.isFinite(value) ? Math.max(minimum, value) : fallback;
    const softLimitRatio = Math.min(
      1,
      number(source.softLimitRatio, 0.4),
    );
    const hardLimitRatio = Math.min(
      1,
      Math.max(softLimitRatio, number(source.hardLimitRatio, 0.7)),
    );
    const criticalLimitRatio = Math.min(
      1,
      Math.max(hardLimitRatio, number(source.criticalLimitRatio, 0.85)),
    );
    return {
      enabled: source.enabled !== false,
      recentIterations: Math.max(
        1,
        Math.floor(number(source.recentIterations, 2, 1)),
      ),
      softLimitRatio,
      hardLimitRatio,
      criticalLimitRatio,
      safetyMarginTokens: Math.floor(
        number(source.safetyMarginTokens, 8192),
      ),
      charsPerToken: number(source.charsPerToken, 4, 1),
      logMetrics: source.logMetrics !== false,
      debugDecisions: source.debugDecisions === true,
    };
  }

  estimateTokens(value, charsPerToken = this.contextCompaction.charsPerToken) {
    const seen = new Set();
    const estimateCharacters = (entry) => {
      if (entry === null || entry === undefined) return 4;
      if (typeof entry === "string") return entry.length + 2;
      if (typeof entry === "number" || typeof entry === "boolean") {
        return String(entry).length;
      }
      if (typeof entry !== "object") return 0;
      if (seen.has(entry)) return 0;
      seen.add(entry);
      let characters = Array.isArray(entry) ? 2 : 2;
      if (Array.isArray(entry)) {
        for (const item of entry) characters += estimateCharacters(item) + 1;
      } else {
        for (const [key, item] of Object.entries(entry)) {
          characters += key.length + 3 + estimateCharacters(item) + 1;
        }
      }
      seen.delete(entry);
      return characters;
    };
    return Math.max(
      1,
      Math.ceil(estimateCharacters(value) / Math.max(1, charsPerToken)),
    );
  }

  parseContextJSON(value) {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  getContextToolMetadata(toolCall, toolMessage = null) {
    const name = toolCall?.function?.name || "";
    const args = this.parseContextJSON(toolCall?.function?.arguments) || {};
    const resultRoot = this.parseContextJSON(toolMessage?.content);
    const result = resultRoot?.result ?? resultRoot ?? {};
    const success =
      resultRoot?.success !== false && result?.success !== false;
    const error = resultRoot?.error || result?.error || null;
    const normalizePath = (value) =>
      typeof value === "string" && value.trim()
        ? AgentPath.normalize(value.trim())
        : "";
    const path = normalizePath(
      result?.path || args.path || result?.oldPath || args.oldPath,
    );
    const newPath = normalizePath(result?.newPath || args.newPath);
    const revision = result?.revision || result?.verification?.revision || "";
    const readKey = [
      name,
      path,
      args.startLine ?? result?.startLine ?? "",
      args.endLine ?? result?.endLine ?? "",
    ].join(":");
    const searchKey = [
      name,
      args.query ?? result?.query ?? "",
      args.path ?? result?.path ?? "",
      args.scope ?? "",
      args.include ?? "",
    ].join(":");
    return {
      name,
      args,
      resultRoot,
      result,
      success,
      error,
      errorCode:
        typeof error === "string" ? error : error?.code || error?.message || "",
      path,
      newPath,
      revision,
      readKey,
      searchKey,
    };
  }

  groupModelContextEntries(messages = []) {
    const entries = [];
    let exchangeIndex = 0;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message?.role === "assistant" && Array.isArray(message.tool_calls)) {
        const calls = message.tool_calls;
        const expectedIds = new Set(
          calls
            .map((call) => call?.id)
            .filter((id) => typeof id === "string" && id),
        );
        const toolMessages = [];
        let cursor = index + 1;
        while (messages[cursor]?.role === "tool") {
          toolMessages.push(messages[cursor]);
          cursor += 1;
        }
        const resultIds = toolMessages.map((tool) => tool?.tool_call_id);
        const protocolValid =
          calls.length > 0 &&
          expectedIds.size === calls.length &&
          toolMessages.length === calls.length &&
          resultIds.every((id) => expectedIds.has(id)) &&
          new Set(resultIds).size === resultIds.length;
        const toolById = new Map(
          toolMessages.map((tool) => [tool.tool_call_id, tool]),
        );
        entries.push({
          kind: "tool_exchange",
          start: index,
          end: cursor - 1,
          messages: [message, ...toolMessages],
          assistant: message,
          calls,
          toolMessages,
          tools: calls.map((call) =>
            this.getContextToolMetadata(call, toolById.get(call.id)),
          ),
          protocolValid,
          exchangeIndex,
          keep: protocolValid,
          reasons: protocolValid ? [] : ["invalid_tool_exchange"],
          compactResults: false,
        });
        exchangeIndex += 1;
        index = cursor - 1;
        continue;
      }
      entries.push({
        kind: message?.role === "tool" ? "orphan_tool" : "message",
        start: index,
        end: index,
        messages: [message],
        message,
        keep: message?.role !== "tool",
        reasons: message?.role === "tool" ? ["orphan_tool_result"] : [],
      });
    }
    return entries;
  }

  compactToolResultForModel(toolName, content, options = {}) {
    const root = this.parseContextJSON(content);
    if (!root || typeof root !== "object") return content;
    const payload = root.result ?? root;
    if (!payload || typeof payload !== "object") return content;
    const isWrite = new Set([
      "modify_file",
      "modify_active_file",
      "replace_text",
      "create_file",
      "rename_file",
    ]).has(toolName);
    const isRead = new Set(["read_file", "read_active_file"]).has(toolName);
    const isSearch = new Set([
      "search_project_files",
      "search_active_file",
    ]).has(toolName);
    const isNavigation = new Set([
      "list_project_files",
      "get_project_map",
      "get_editor_context",
      "get_cursor",
      "read_selection",
    ]).has(toolName);
    if (!isWrite && !options.metadataOnly) return content;

    const keys = isWrite
      ? [
          "success",
          "operation",
          "path",
          "oldPath",
          "newPath",
          "created",
          "renamed",
          "match",
          "nearLine",
          "revision",
          "additions",
          "deletions",
          "range",
        ]
      : isRead
        ? [
            "success",
            "path",
            "startLine",
            "endLine",
            "totalLines",
            "truncated",
            "revision",
          ]
        : isSearch
          ? ["success", "query", "path", "totalMatches", "total"]
          : isNavigation
            ? ["success", "path", "total", "hasActiveFile", "file", "cursor"]
            : ["success", "path", "code", "message"];
    const summary = {};
    for (const key of keys) {
      if (payload[key] !== undefined) summary[key] = payload[key];
    }
    const error = root.error || payload.error;
    if (error !== undefined) summary.error = error;
    if (isWrite && payload.verification) {
      const verification = payload.verification;
      summary.verification = {};
      for (const key of [
        "verified",
        "path",
        "revision",
        "startLine",
        "endLine",
      ]) {
        if (verification[key] !== undefined) {
          summary.verification[key] = verification[key];
        }
      }
    }
    if (options.metadataOnly) summary.contentOmitted = true;
    const compact = Object.prototype.hasOwnProperty.call(root, "result")
      ? {
          success: root.success !== false,
          ...(root.error !== undefined ? { error: root.error } : {}),
          result: summary,
        }
      : summary;
    return JSON.stringify(compact);
  }

  buildModelContext(messages = this.messages, config = {}) {
    const options = this.getContextCompactionConfig(config);
    if (!options.enabled) {
      this.lastContextMetrics = {
        fullMessages: messages.length,
        modelMessages: messages.length,
        estimatedFullTokens: this.estimateTokens(messages, options.charsPerToken),
        estimatedModelTokens: this.estimateTokens(messages, options.charsPerToken),
        contextWindow: config.contextWindow ?? null,
        inputBudget: null,
        disabled: true,
      };
      return messages.map((message) => ({ ...message }));
    }

    const state = config.contextState;
    const hasCurrentState =
      state &&
      (state.writesSucceeded > 0 ||
        state.pendingValidation === true ||
        state.lastModificationError);
    const contextMessages = hasCurrentState
      ? [
          ...messages,
          {
            role: "system",
            content: `[NCE CURRENT TASK STATE]\n${JSON.stringify(state)}`,
          },
        ]
      : messages;
    const entries = this.groupModelContextEntries(contextMessages);
    const exchangeCount = entries.filter(
      (entry) => entry.kind === "tool_exchange",
    ).length;
    const hotExchangeStart = Math.max(
      0,
      exchangeCount - options.recentIterations,
    );
    const firstHotIndex =
      entries.find(
        (entry) =>
          entry.kind === "tool_exchange" &&
          entry.exchangeIndex >= hotExchangeStart,
      )?.start ?? messages.length;
    const readTools = new Set(["read_file", "read_active_file"]);
    const searchTools = new Set([
      "search_project_files",
      "search_active_file",
    ]);
    const navigationTools = new Set([
      "list_project_files",
      "get_project_map",
      "get_editor_context",
      "get_cursor",
      "read_selection",
    ]);
    const writeTools = new Set([
      "modify_file",
      "modify_active_file",
      "replace_text",
      "create_file",
      "rename_file",
    ]);
    const laterWrites = new Set();
    const latestReads = new Set();
    const latestSearches = new Set();
    const latestNavigation = new Set();
    const laterSuccessfulWrites = new Set();
    const activeErrors = new Set();
    const runtimeSystems = new Set();
    const userMessageIndexes = entries
      .filter(
        (entry) =>
          entry.kind === "message" && entry.message?.role === "user",
      )
      .map((entry) => entry.start);
    const firstUserIndex = userMessageIndexes[0] ?? -1;
    const lastUserIndex = userMessageIndexes.at(-1) ?? -1;
    let hasLaterToolExchange = false;
    const counters = {
      removedReasoningMessages: 0,
      removedStaleReads: 0,
      deduplicatedTools: 0,
      compactedToolResults: 0,
      removedResolvedErrors: 0,
      removedObsoleteRuntimeMessages: 0,
      removedForBudget: 0,
      invalidToolExchanges: 0,
    };

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      entry.recent = entry.start >= firstHotIndex;
      entry.critical = false;
      entry.priority = 60;
      if (!entry.keep) {
        if (entry.kind === "tool_exchange") counters.invalidToolExchanges += 1;
        continue;
      }
      if (entry.kind === "message") {
        const message = entry.message;
        if (entry.start === 0 && message?.role === "system") {
          entry.critical = true;
          entry.reasons.push("primary_system_prompt");
        } else if (
          message?.role === "system" &&
          String(message.content || "").startsWith(
            "[NCE CURRENT TASK STATE]",
          )
        ) {
          entry.critical = true;
          entry.reasons.push("current_task_state");
        } else if (message?.role === "user") {
          entry.priority = 80;
          if (entry.start === firstUserIndex || entry.start === lastUserIndex) {
            entry.critical = true;
            entry.reasons.push(
              entry.start === lastUserIndex
                ? "current_user_goal"
                : "original_user_goal",
            );
          } else {
            entry.reasons.push("user_constraint");
          }
        } else if (message?.role === "system") {
          const signature = String(message.content || "");
          entry.priority = 20;
          const resolvedRuntimeMessage =
            ((signature.includes("Aucun outil d'écriture") ||
              signature.includes("VALIDATION POST-MODIFICATION")) &&
              laterSuccessfulWrites.size > 0) ||
            ((signature.includes("Les lectures ont été exécutées") ||
              signature.includes("Une seule écriture a été exécutée")) &&
              hasLaterToolExchange);
          if (runtimeSystems.has(signature) || resolvedRuntimeMessage) {
            entry.keep = false;
            entry.reasons.push("obsolete_runtime_message");
            counters.removedObsoleteRuntimeMessages += 1;
          } else {
            runtimeSystems.add(signature);
            entry.reasons.push(entry.recent ? "recent" : "runtime_message");
          }
        } else if (message?.role === "assistant") {
          entry.priority = 10;
          const hasDurableContent =
            (typeof message.content === "string" &&
              message.content.trim().length > 0) ||
            (Array.isArray(message.content) && message.content.length > 0);
          if (!hasDurableContent && message.reasoning) {
            entry.keep = false;
            entry.reasons.push("historical_reasoning");
          } else {
            entry.reasons.push(
              entry.recent ? "recent" : "intermediate_assistant",
            );
          }
        }
        continue;
      }

      hasLaterToolExchange = true;

      const hasWrite = entry.tools.some((tool) => writeTools.has(tool.name));
      const unresolvedErrors = [];
      let staleReadCount = 0;
      let duplicateCount = 0;
      let resolvedErrorCount = 0;
      let droppableToolCount = 0;
      for (const tool of [...entry.tools].reverse()) {
        let toolIsDroppable = false;
        const paths = [tool.path, tool.newPath].filter(Boolean);
        const errorKey = [tool.name, tool.path, tool.errorCode].join(":");
        if (writeTools.has(tool.name)) {
          if (tool.success) {
            for (const path of paths) {
              laterWrites.add(path);
              laterSuccessfulWrites.add(path);
            }
          } else {
            const resolved = paths.some((path) =>
              laterSuccessfulWrites.has(path),
            );
            if (resolved) {
              resolvedErrorCount += 1;
              toolIsDroppable = true;
            } else if (!activeErrors.has(errorKey)) {
              activeErrors.add(errorKey);
              unresolvedErrors.push(tool);
            } else {
              duplicateCount += 1;
              toolIsDroppable = true;
            }
          }
        } else if (!tool.success) {
          if (!activeErrors.has(errorKey)) {
            activeErrors.add(errorKey);
            unresolvedErrors.push(tool);
          } else {
            duplicateCount += 1;
            toolIsDroppable = true;
          }
        }
        if (readTools.has(tool.name) && tool.success) {
          if (tool.path && laterWrites.has(tool.path)) {
            staleReadCount += 1;
            toolIsDroppable = true;
          } else if (latestReads.has(tool.readKey)) {
            duplicateCount += 1;
            toolIsDroppable = true;
          }
          else latestReads.add(tool.readKey);
        }
        if (searchTools.has(tool.name) && tool.success) {
          if (latestSearches.has(tool.searchKey)) {
            duplicateCount += 1;
            toolIsDroppable = true;
          }
          else latestSearches.add(tool.searchKey);
        }
        if (navigationTools.has(tool.name) && tool.success) {
          const navigationKey = `${tool.name}:${tool.path || tool.searchKey}`;
          if (latestNavigation.has(navigationKey)) {
            duplicateCount += 1;
            toolIsDroppable = true;
          }
          else latestNavigation.add(navigationKey);
        }
        if (toolIsDroppable) droppableToolCount += 1;
      }
      if (
        droppableToolCount === entry.tools.length &&
        staleReadCount > 0
      ) {
        entry.keep = false;
        entry.reasons.push("stale_read");
        counters.removedStaleReads += staleReadCount;
      } else if (
        droppableToolCount === entry.tools.length &&
        duplicateCount > 0
      ) {
        entry.keep = false;
        entry.reasons.push("duplicate_tool_exchange");
        counters.deduplicatedTools += duplicateCount;
      } else if (droppableToolCount === entry.tools.length) {
        entry.keep = false;
        entry.reasons.push("resolved_error");
        counters.removedResolvedErrors += resolvedErrorCount;
      } else if (
        hasWrite &&
        entry.tools.some(
          (tool) => writeTools.has(tool.name) && tool.success,
        )
      ) {
        entry.critical = true;
        entry.compactResults = true;
        entry.reasons.push("successful_write");
      } else if (unresolvedErrors.length > 0) {
        entry.critical = true;
        entry.compactResults = true;
        entry.reasons.push("unresolved_error");
      } else if (entry.tools.some((tool) => navigationTools.has(tool.name))) {
        entry.priority = 30;
        entry.reasons.push(entry.recent ? "recent" : "navigation_result");
      } else if (entry.tools.some((tool) => searchTools.has(tool.name))) {
        entry.priority = 40;
        entry.reasons.push(entry.recent ? "recent" : "search_result");
      } else if (entry.tools.some((tool) => readTools.has(tool.name))) {
        entry.priority = 50;
        entry.reasons.push(entry.recent ? "recent" : "current_file_read");
      } else {
        entry.reasons.push(entry.recent ? "recent" : "tool_result");
      }
    }

    const contextWindow = Number.isFinite(config.contextWindow)
      ? Math.max(1, Math.floor(config.contextWindow))
      : null;
    const maxOutputTokens = Number.isFinite(config.maxTokens)
      ? Math.max(0, Math.floor(config.maxTokens))
      : 0;
    const inputBudget = contextWindow
      ? Math.max(
          1,
          contextWindow - maxOutputTokens - options.safetyMarginTokens,
        )
      : null;
    const estimatedFullTokens = this.estimateTokens(
      messages,
      options.charsPerToken,
    );
    const usageRatio = inputBudget
      ? estimatedFullTokens / inputBudget
      : 0;
    const level =
      usageRatio >= options.criticalLimitRatio
        ? "critical"
        : usageRatio >= options.hardLimitRatio
          ? "hard"
          : usageRatio >= options.softLimitRatio
            ? "moderate"
            : "light";

    for (const entry of entries) {
      if (!entry.keep || entry.critical || entry.recent) continue;
      if (
        level === "moderate" &&
        entry.kind === "message" &&
        ["assistant", "system"].includes(entry.message?.role)
      ) {
        entry.keep = false;
        entry.reasons.push("adaptive_moderate");
      } else if (
        ["hard", "critical"].includes(level) &&
        ((entry.kind === "message" &&
          ["assistant", "system"].includes(entry.message?.role)) ||
          entry.priority <= 40)
      ) {
        entry.keep = false;
        entry.reasons.push(`adaptive_${level}`);
      } else if (
        ["hard", "critical"].includes(level) &&
        entry.kind === "tool_exchange" &&
        entry.tools.some((tool) => readTools.has(tool.name))
      ) {
        entry.compactResults = true;
        entry.metadataOnly = true;
        entry.reasons.push("old_read_metadata_only");
      }
    }

    const renderEntry = (entry, trackMetrics = false) => {
      if (!entry.keep) return [];
      if (entry.kind !== "tool_exchange") {
        const message = { ...entry.message };
        if (Object.prototype.hasOwnProperty.call(message, "reasoning")) {
          delete message.reasoning;
        }
        return [message];
      }
      const assistant = { ...entry.assistant };
      if (Object.prototype.hasOwnProperty.call(assistant, "reasoning")) {
        delete assistant.reasoning;
      }
      const toolById = new Map(
        entry.toolMessages.map((message) => [message.tool_call_id, message]),
      );
      const callById = new Map(entry.calls.map((call) => [call.id, call]));
      const results = entry.toolMessages.map((original) => {
        const call = callById.get(original.tool_call_id);
        const compactedContent =
          entry.compactResults || entry.metadataOnly
            ? this.compactToolResultForModel(call.function.name, original.content, {
                metadataOnly: entry.metadataOnly,
              })
            : original.content;
        if (trackMetrics && compactedContent !== original.content) {
          counters.compactedToolResults += 1;
        }
        return { ...original, content: compactedContent };
      });
      return [assistant, ...results];
    };
    const render = (trackMetrics = false) =>
      entries.flatMap((entry) => renderEntry(entry, trackMetrics));
    let modelMessages = render();
    let estimatedModelTokens = this.estimateTokens(
      modelMessages,
      options.charsPerToken,
    );

    if (inputBudget && estimatedModelTokens > inputBudget) {
      for (const entry of entries) {
        if (
          entry.keep &&
          !entry.critical &&
          !entry.recent &&
          entry.kind === "tool_exchange" &&
          entry.tools.some((tool) => readTools.has(tool.name))
        ) {
          entry.compactResults = true;
          entry.metadataOnly = true;
          entry.reasons.push("budget_read_metadata_only");
        }
      }
      modelMessages = render();
      estimatedModelTokens = this.estimateTokens(
        modelMessages,
        options.charsPerToken,
      );
    }
    if (inputBudget && estimatedModelTokens > inputBudget) {
      const candidates = entries
        .filter((entry) => entry.keep && !entry.critical)
        .sort(
          (left, right) =>
            left.priority - right.priority ||
            Number(left.recent) - Number(right.recent) ||
            left.start - right.start,
        );
      const entryTokenCosts = new Map(
        entries
          .filter((entry) => entry.keep)
          .map((entry) => [
            entry,
            this.estimateTokens(
              renderEntry(entry),
              options.charsPerToken,
            ),
          ]),
      );
      let projectedTokens = [...entryTokenCosts.values()].reduce(
        (total, tokens) => total + tokens,
        0,
      );
      for (const entry of candidates) {
        if (projectedTokens <= inputBudget) break;
        entry.keep = false;
        entry.reasons.push("input_budget");
        counters.removedForBudget += 1;
        projectedTokens -= entryTokenCosts.get(entry) || 0;
      }
    }

    counters.removedReasoningMessages = messages.filter(
      (message) =>
        message?.role === "assistant" &&
        Object.prototype.hasOwnProperty.call(message, "reasoning"),
    ).length;
    counters.compactedToolResults = 0;
    modelMessages = render(true);
    estimatedModelTokens = this.estimateTokens(
      modelMessages,
      options.charsPerToken,
    );

    const metrics = {
      fullMessages: messages.length,
      modelMessages: modelMessages.length,
      estimatedFullTokens,
      estimatedModelTokens,
      ...counters,
      contextWindow,
      inputBudget,
      usageRatio: Number(usageRatio.toFixed(3)),
      level,
    };
    for (const entry of entries) {
      entry.classification = entry.critical
        ? "CRITICAL"
        : entry.recent
          ? "RECENT"
          : entry.kind === "tool_exchange" ||
              entry.message?.role === "user"
            ? "IMPORTANT"
            : "DROPPABLE";
    }
    this.lastContextMetrics = metrics;
    if (options.logMetrics) console.info("[NCE Agent context]", metrics);
    if (options.debugDecisions) {
      console.debug(
        "[NCE Agent context decisions]",
        entries.map((entry) => ({
          start: entry.start,
          end: entry.end,
          kind: entry.kind,
          classification: entry.classification,
          status: entry.keep
            ? entry.compactResults || entry.metadataOnly
              ? "COMPACTED"
              : "KEPT"
            : "DROPPED",
          reasons: entry.reasons,
        })),
      );
    }
    return modelMessages;
  }

  normalizeMessagesForProvider(messages = []) {
    if (!Array.isArray(messages)) {
      throw this.createMessageSerializationError(
        -1,
        null,
        "messages",
        messages,
        "un tableau est requis",
      );
    }
    return messages.map((message, messageIndex) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        throw this.createMessageSerializationError(
          messageIndex,
          null,
          "message",
          message,
          "un objet est requis",
        );
      }
      const normalized = { ...message };
      if (Object.prototype.hasOwnProperty.call(message, "tool_calls")) {
        if (!Array.isArray(message.tool_calls)) {
          throw this.createMessageSerializationError(
            messageIndex,
            null,
            "tool_calls",
            message.tool_calls,
            "un tableau est requis",
          );
        }
        normalized.tool_calls = message.tool_calls.map(
          (toolCall, toolCallIndex) => {
            if (
              !toolCall ||
              typeof toolCall !== "object" ||
              Array.isArray(toolCall) ||
              !toolCall.function ||
              typeof toolCall.function !== "object" ||
              Array.isArray(toolCall.function)
            ) {
              throw this.createMessageSerializationError(
                messageIndex,
                toolCallIndex,
                "tool_calls.function",
                toolCall?.function,
                "un objet function est requis",
              );
            }
            const toolName = toolCall.function.name;
            if (typeof toolCall.id !== "string" || !toolCall.id.trim()) {
              throw this.createMessageSerializationError(
                messageIndex,
                toolCallIndex,
                "tool_calls.id",
                toolCall.id,
                "un identifiant non vide est requis",
                { toolName },
              );
            }
            if (typeof toolName !== "string" || !toolName.trim()) {
              throw this.createMessageSerializationError(
                messageIndex,
                toolCallIndex,
                "tool_calls.function.name",
                toolName,
                "un nom non vide est requis",
                { toolName },
              );
            }
            return {
              id: toolCall.id.trim(),
              type: "function",
              function: {
                name: toolName.trim(),
                arguments: this.normalizeToolArgumentsForProvider(
                  toolCall.function.arguments,
                  messageIndex,
                  toolCallIndex,
                  toolName,
                ),
              },
            };
          },
        );
      }
      if (message.role === "tool") {
        normalized.content = this.normalizeToolContentForProvider(
          message.content,
          messageIndex,
        );
      }
      return normalized;
    });
  }

  debugToolMessage(toolCall, messageIndex, context = {}) {
    console.debug("[NCE Tool Message]", {
      toolName: toolCall.function.name,
      toolCallId: toolCall.id,
      argumentsType: typeof toolCall.function.arguments,
      argumentsPreview: this.getSafeValuePreview(
        toolCall.function.arguments,
      ),
      messageIndex,
      source: context.source || "run_loop",
      iteration: context.iteration ?? null,
      provider: context.provider || this.runConfig?.providerId || null,
      model: context.model || this.runConfig?.model || this.model || null,
    });
  }

  createAssistantToolCallMessage(assistantMessage, toolCalls, context = {}) {
    const finalizedCalls = this.finalizeToolCalls(toolCalls, context);
    const message = {
      role: "assistant",
      content: assistantMessage?.content ?? null,
      ...(assistantMessage?.reasoning
        ? { reasoning: assistantMessage.reasoning }
        : {}),
      tool_calls: finalizedCalls,
    };
    const messageIndex = this.messages.length;
    finalizedCalls.forEach((toolCall) =>
      this.debugToolMessage(toolCall, messageIndex, context),
    );
    return message;
  }

  createToolResultMessage(toolCallId, result, options = {}) {
    if (typeof toolCallId !== "string" || !toolCallId.trim()) {
      throw this.createMessageSerializationError(
        this.messages.length,
        null,
        "tool_call_id",
        toolCallId,
        "un identifiant non vide est requis",
      );
    }
    return {
      role: "tool",
      tool_call_id: toolCallId.trim(),
      content:
        options.contentIsSerialized && typeof result === "string"
          ? result
          : JSON.stringify(
              this.normalizeToolResultForHistory(result) ?? null,
            ),
    };
  }
  unwrapModelTransportResult(result) {
    if (
      result?.success === false ||
      (result?.error && !result?.choices && !result?.message)
    ) {
      const payload = result?.error || result;
      const error = new Error(
        typeof payload === "string"
          ? payload
          : payload?.message || "Le provider a refusé la requête.",
      );
      error.status =
        result?.status ||
        result?.statusCode ||
        payload?.status ||
        payload?.code;
      error.code = payload?.code || result?.code;
      error.body = result;
      error.response = result?.response || null;
      throw error;
    }
    return result;
  }
  getModelRequestState(config) {
    if (
      this.modelRequestState &&
      this.modelRequestState.runId === config.runId &&
      this.modelRequestState.sessionId === config.sessionId
    ) {
      return this.modelRequestState;
    }
    const currentConfig = {
      ...config,
      provider: config.provider ? { ...config.provider } : null,
    };
    const key = `${config.providerId}:${config.model}`;
    this.modelRequestState = {
      runId: config.runId,
      sessionId: config.sessionId,
      currentConfig,
      fallbackQueue: Array.isArray(config.fallbackChain)
        ? config.fallbackChain.map((candidate) => ({ ...candidate }))
        : [],
      fallbackIndex: 0,
      triedCandidates: new Set([key]),
      unhealthyModels: new Set(),
      failures: [],
      providerRetryCount: 0,
      modelFallbackCount: 0,
      authenticationCancelledProviders: new Set(),
    };
    return this.modelRequestState;
  }
  getHeaderValue(response, name) {
    const headers = response?.headers;
    if (!headers) return null;
    if (typeof headers.get === "function") return headers.get(name);
    const target = name.toLowerCase();
    const key = Object.keys(headers).find(
      (headerName) => headerName.toLowerCase() === target,
    );
    return key ? headers[key] : null;
  }
  parseRetryAfterMs(value) {
    if (value === null || value === undefined || value === "") return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(String(value));
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
  }
  classifyModelError(error, response = null, request = {}) {
    const body = error?.body ?? response?.body ?? error?.data ?? null;
    const providerError = body?.error || body || {};
    const metadata =
      providerError?.metadata || body?.metadata || error?.metadata || {};
    const possibleStatus = [
      response?.status,
      error?.status,
      error?.statusCode,
      providerError?.status,
      typeof providerError?.code === "number" ? providerError.code : null,
    ].find((value) => Number.isFinite(Number(value)));
    const statusCode =
      possibleStatus === undefined ? null : Number(possibleStatus);
    let serializedBody = "";
    try {
      serializedBody = typeof body === "string" ? body : JSON.stringify(body);
    } catch {
      serializedBody = "";
    }
    const technicalMessage = [error?.message, serializedBody]
      .filter(Boolean)
      .join(" | ")
      .slice(0, 12000);
    const text = technicalMessage.toLowerCase();
    const code = String(
      providerError?.code || error?.code || metadata?.provider_error_code || "",
    );
    const configuredProvider =
      request.providerId || request.provider?.id || "unknown";
    const upstreamProvider =
      metadata?.provider_name || metadata?.upstream_provider || null;
    const model = request.model || "unknown";
    const modelName = request.modelConfig?.name || model;
    const retryAfterMetadata = this.parseRetryAfterMs(
      metadata?.retry_after_seconds,
    );
    const retryAfterHeader = this.parseRetryAfterMs(
      this.getHeaderValue(response || error?.response, "Retry-After"),
    );
    const retryAfterMs = retryAfterMetadata ?? retryAfterHeader;
    let category = "UNKNOWN";

    if (
      /context.{0,30}(length|window)|too many tokens|maximum context|token limit/.test(
        text,
      )
    ) {
      category = "CONTEXT_LENGTH_EXCEEDED";
    } else if (/no tokens available|no available tokens/.test(text)) {
      category = "NO_TOKENS_AVAILABLE";
    } else if (
      /quota|billing|insufficient[_ ]credits|credit balance/.test(text)
    ) {
      category = "QUOTA_EXCEEDED";
    } else if (
      statusCode === 401 ||
      /invalid api key|unauthorized|authentication/.test(text)
    ) {
      category = "AUTH_ERROR";
    } else if (statusCode === 403 || /forbidden|permission denied/.test(text)) {
      category = "PERMISSION_ERROR";
    } else if (
      /model.{0,30}(not found|does not exist|deprecated|removed)|invalid model/.test(
        text,
      ) ||
      statusCode === 404
    ) {
      category = "MODEL_NOT_FOUND";
    } else if (/no capacity|no slots|shared pool|saturat|overload/.test(text)) {
      category = statusCode === 429 ? "RATE_LIMIT" : "NO_CAPACITY";
    } else if (
      /model.{0,30}(unavailable|not available)|provider.{0,30}unavailable/.test(
        text,
      )
    ) {
      category = "MODEL_UNAVAILABLE";
    } else if (
      statusCode === 429 ||
      /rate.?limit|too many requests/.test(text)
    ) {
      category = "RATE_LIMIT";
    } else if (
      statusCode === 408 ||
      error?.name === "TimeoutError" ||
      /timed? ?out|timeout|etimedout/.test(text)
    ) {
      category = "TIMEOUT";
    } else if (
      ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(
        String(error?.code || "").toUpperCase(),
      ) ||
      /failed to fetch|network error|dns/.test(text)
    ) {
      category = "NETWORK_ERROR";
    } else if (
      statusCode === 502 ||
      statusCode === 504 ||
      /upstream/.test(text)
    ) {
      category = "UPSTREAM_ERROR";
    } else if (statusCode === 503) {
      category = "MODEL_UNAVAILABLE";
    } else if (statusCode !== null && statusCode >= 500) {
      category = "SERVER_ERROR";
    } else if ([400, 409, 422].includes(statusCode)) {
      category = "INVALID_REQUEST";
    }

    const retryable = new Set([
      "RATE_LIMIT",
      "MODEL_UNAVAILABLE",
      "NO_CAPACITY",
      "NO_TOKENS_AVAILABLE",
      "TIMEOUT",
      "NETWORK_ERROR",
      "UPSTREAM_ERROR",
      "SERVER_ERROR",
    ]).has(category);
    const fallbackRecommended =
      retryable ||
      new Set([
        "MODEL_NOT_FOUND",
        "CONTEXT_LENGTH_EXCEEDED",
        "AUTH_ERROR",
        "PERMISSION_ERROR",
        "QUOTA_EXCEEDED",
      ]).has(category);
    const providerName = request.provider?.name || configuredProvider;
    const messages = {
      RATE_LIMIT: `${modelName} est temporairement limité par ${providerName}.`,
      MODEL_UNAVAILABLE: `${modelName} est temporairement indisponible.`,
      MODEL_NOT_FOUND: `Le modèle ${modelName} n'existe plus ou n'est pas accessible.`,
      NO_CAPACITY: `${modelName} n'a actuellement aucune capacité disponible.`,
      NO_TOKENS_AVAILABLE: `${modelName} n'a actuellement aucun jeton disponible.`,
      QUOTA_EXCEEDED: `Le quota du compte ${providerName} est dépassé.`,
      AUTH_ERROR: `Clé API invalide ou absente pour ${providerName}.`,
      PERMISSION_ERROR: `Le compte ${providerName} n'a pas accès à ${modelName}.`,
      INVALID_REQUEST: `La requête envoyée à ${providerName} est invalide.`,
      TIMEOUT: `${providerName} ne répond pas dans le délai autorisé.`,
      NETWORK_ERROR: `La connexion à ${providerName} a échoué.`,
      UPSTREAM_ERROR: `Un provider en amont de ${providerName} est indisponible.`,
      SERVER_ERROR: `${providerName} rencontre une erreur temporaire.`,
      CONTEXT_LENGTH_EXCEEDED: `La requête dépasse la taille de contexte de ${modelName}.`,
      UNKNOWN: `La requête vers ${modelName} a échoué.`,
    };
    return {
      category,
      retryable,
      retryAfterMs,
      fallbackRecommended,
      userMessage: messages[category],
      technicalMessage: technicalMessage || "Unknown model error",
      provider: configuredProvider,
      configuredProvider,
      upstreamProvider,
      model,
      statusCode,
      code: code || category,
    };
  }
  getModelRetryDelay(classified, retryCount) {
    if (Number.isFinite(classified?.retryAfterMs)) {
      return Math.max(0, classified.retryAfterMs);
    }
    return [2000, 5000][Math.min(retryCount, 1)];
  }
  formatRetryDelay(delayMs) {
    const seconds = Math.max(0, delayMs) / 1000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
  }
  waitForModelRetry(delayMs, controller = this.abortController) {
    if (!delayMs) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        controller?.signal?.removeEventListener?.("abort", onAbort);
        resolve();
      }, delayMs);
      const onAbort = () => {
        clearTimeout(timeout);
        reject(this.abortError());
      };
      if (controller?.signal?.aborted) {
        onAbort();
        return;
      }
      controller?.signal?.addEventListener?.("abort", onAbort, { once: true });
    });
  }
  resolveFallbackConfig(candidate, baseConfig) {
    const providerId = candidate?.provider || candidate?.providerId;
    const model = candidate?.model;
    if (!providerId || !model) return null;
    let resolved = null;
    if (typeof this.modelConfigResolver === "function") {
      resolved = this.modelConfigResolver(
        baseConfig.agentId || this.agentId,
        providerId,
        model,
      );
    } else if (typeof AgentAI !== "undefined") {
      resolved = AgentAI.resolve(
        baseConfig.agentId || this.agentId,
        providerId,
        model,
      );
    }
    if (!resolved) return null;
    const provider = { ...resolved.provider };
    if (
      !provider.apiKey &&
      providerId === baseConfig.providerId &&
      baseConfig.provider?.apiKey
    ) {
      provider.apiKey = baseConfig.provider.apiKey;
    }
    return {
      ...baseConfig,
      ...resolved,
      agentId: baseConfig.agentId || resolved.agent?.id || this.agentId,
      providerId,
      provider,
      model,
      fallbackChain: baseConfig.fallbackChain,
    };
  }
  isCompatibleFallback(candidate, classified, currentConfig) {
    if (!candidate?.provider?.baseURL || !candidate?.model) return false;
    if (candidate.provider.requiresApiKey && !candidate.provider.apiKey) {
      return false;
    }
    if (this.getOpenAITools().length && candidate.supportsTools === false) {
      return false;
    }
    if (
      ["AUTH_ERROR", "PERMISSION_ERROR", "QUOTA_EXCEEDED"].includes(
        classified.category,
      ) &&
      candidate.providerId === currentConfig.providerId
    ) {
      return false;
    }
    if (classified.category === "CONTEXT_LENGTH_EXCEEDED") {
      return (
        Number.isFinite(candidate.contextWindow) &&
        Number.isFinite(currentConfig.contextWindow) &&
        candidate.contextWindow > currentConfig.contextWindow
      );
    }
    return true;
  }
  takeNextFallback(state, classified, baseConfig) {
    if (
      state.modelFallbackCount >=
      (baseConfig.maxModelFallbacks ?? this.maxModelFallbacks)
    ) {
      return null;
    }
    while (state.fallbackIndex < state.fallbackQueue.length) {
      const candidate = state.fallbackQueue[state.fallbackIndex++];
      const key = `${candidate.provider || candidate.providerId}:${candidate.model}`;
      if (state.triedCandidates.has(key) || state.unhealthyModels.has(key)) {
        continue;
      }
      state.triedCandidates.add(key);
      let resolved = null;
      try {
        resolved = this.resolveFallbackConfig(candidate, baseConfig);
      } catch (error) {
        console.warn("[NCE Agent model] fallback configuration ignored", {
          provider: candidate.provider || candidate.providerId,
          model: candidate.model,
          error: error?.message || String(error),
        });
        continue;
      }
      if (
        !this.isCompatibleFallback(resolved, classified, state.currentConfig)
      ) {
        continue;
      }
      return resolved;
    }
    return null;
  }
  applyActiveModelConfig(runConfig, activeConfig) {
    const previousPrompt = runConfig.systemPrompt;
    for (const key of [
      "providerId",
      "provider",
      "model",
      "modelFamily",
      "systemPrompt",
      "supportsTools",
      "supportsToolChoice",
      "contextWindow",
    ]) {
      if (activeConfig[key] !== undefined) runConfig[key] = activeConfig[key];
    }
    if (
      activeConfig.systemPrompt &&
      activeConfig.systemPrompt !== previousPrompt &&
      this.messages[0]?.role === "system"
    ) {
      this.messages[0] = {
        ...this.messages[0],
        content: this.buildSystemMessage(
          runConfig.editorContext || {},
          activeConfig.systemPrompt,
        ),
      };
    }
  }
  getModelDisplayName(config) {
    return config?.modelConfig?.name || config?.model || "Le modèle";
  }
  emitModelStatus(event, config) {
    this.callbacks.onModelStatus?.(event, {
      sessionId: config.sessionId ?? this.currentSessionId,
      runId: config.runId ?? this.runId,
    });
  }
  debugModelError(classified, counters = {}) {
    console.warn("[NCE Agent model]", {
      provider: classified.provider,
      upstreamProvider: classified.upstreamProvider,
      model: classified.model,
      status: classified.statusCode,
      code: classified.code,
      classification: classified.category,
      retryable: classified.retryable,
      retryAfterMs: classified.retryAfterMs,
      retryCount: counters.retryCount || 0,
      fallbackCount: counters.fallbackCount || 0,
      technicalMessage: classified.technicalMessage,
    });
  }
  createFinalModelError(classified, state) {
    const configurationCategory = new Set([
      "AUTH_ERROR",
      "PERMISSION_ERROR",
      "QUOTA_EXCEEDED",
      "INVALID_REQUEST",
      "CONTEXT_LENGTH_EXCEEDED",
    ]).has(classified.category);
    const exhausted = state.modelFallbackCount > 0 && !configurationCategory;
    const details = exhausted
      ? {
          ...classified,
          category: "ALL_MODELS_UNAVAILABLE",
          code: "ALL_MODELS_UNAVAILABLE",
          retryable: false,
          fallbackRecommended: false,
          userMessage:
            "Aucun modèle configuré n'est actuellement disponible. Réessaie plus tard ou sélectionne un autre provider.",
        }
      : classified;
    const error = new Error(details.userMessage);
    error.name = "AgentModelError";
    error.isAgentModelError = true;
    Object.assign(error, details, {
      failures: state.failures.map((failure) => ({ ...failure })),
      providerRetryCount: state.providerRetryCount,
      modelFallbackCount: state.modelFallbackCount,
    });
    this.emitModelStatus(
      {
        kind: "error",
        classification: details,
        userMessage: details.userMessage,
      },
      state.currentConfig || this.runConfig || {},
    );
    return error;
  }
  sanitizeProviderForIPC() {
    if (!this.provider) return null;
    const provider = { ...this.provider };
    delete provider.apiKey;
    return provider;
  }

  parseResponse(result, context = {}) {
    const message = result?.choices?.[0]?.message || result?.message;
    if (!message || typeof message !== "object")
      throw new Error("Réponse IA invalide.");
    const content = message.content;
    const text = Array.isArray(content)
      ? content
          .map((part) => (typeof part === "string" ? part : part?.text || ""))
          .join("")
      : typeof content === "string"
        ? content
        : "";
    const reasoning = this.extractReasoning(message);
    const toolCalls = this.finalizeToolCalls(message.tool_calls, context);
    const finishReason = this.normalizeFinishReason(result, message, toolCalls);
    return {
      text,
      reasoning,
      toolCalls,
      finishReason,
      assistantMessage: {
        role: "assistant",
        content: content || null,
        ...(reasoning ? { reasoning } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
    };
  }
  extractReasoning(message) {
    const value =
      message.reasoning_content ??
      message.reasoning ??
      message.additional_kwargs?.reasoning;
    if (typeof value === "string") return value.trim();
    if (value === null || value === undefined) return "";
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  getOpenAITools() {
    const permissions = this.runConfig?.permissions ?? this.permissions;
    const hasActiveFile = Boolean(this.editor?.tabManager?.activeFile);
    const hiddenCompatibilityWriteTools = new Set([
      "modify_active_file",
      "replace_text",
    ]);
    const activeFileReadTools = new Set([
      "read_active_file",
      "search_active_file",
    ]);
    return [...this.tools.values()]
      .filter((tool) => tool.enabled)
      .filter((tool) => permissions === "code" || tool.readOnly)
      .filter(
        (tool) =>
          !hiddenCompatibilityWriteTools.has(tool.name) &&
          (hasActiveFile || !activeFileReadTools.has(tool.name)),
      )
      .map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
  }

  async executeToolCall(call, executionContext = {}) {
    const name = call?.function?.name;
    const toolCallId = typeof call?.id === "string" ? call.id : "";
    if (toolCallId && this.executedToolCalls.has(toolCallId)) {
      return this.executedToolCalls.get(toolCallId);
    }
    const activeFileTools = new Set([
      "read_active_file",
      "search_active_file",
      "modify_active_file",
      "replace_text",
    ]);
    if (activeFileTools.has(name) && !this.editor?.tabManager?.activeFile) {
      const result = {
        success: false,
        error: {
          code: "NO_ACTIVE_FILE",
          message:
            "Aucun fichier n'est ouvert. Utilisez les outils workspace avec un chemin de fichier.",
        },
      };
      this.debugTool(name, {}, result);
      return result;
    }
    const tool = this.getTool(name);
    if (!tool)
      return {
        success: false,
        error: {
          code: "TOOL_NOT_FOUND",
          message: `Outil inconnu : ${name || "(sans nom)"}`,
        },
      };
    if (!tool.enabled)
      return {
        success: false,
        error: { code: "TOOL_DISABLED", message: `Outil désactivé : ${name}` },
      };
    const permissions = this.runConfig?.permissions ?? this.permissions;
    if (permissions === "read" && !tool.readOnly) {
      return {
        success: false,
        error: {
          code: "TOOL_NOT_ALLOWED",
          message: `L'outil ${name} n'est pas autorisé dans ce mode.`,
        },
      };
    }
    let args = {};
    try {
      const raw = call.function.arguments;
      args =
        typeof raw === "string"
          ? raw.trim()
            ? JSON.parse(raw)
            : {}
          : raw || {};
    } catch {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "Arguments JSON invalides.",
        },
      };
    }
    if (!args || typeof args !== "object" || Array.isArray(args))
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "Les arguments doivent être un objet.",
        },
      };

    const normalizedArgs = { ...args };
    for (const [key, rule] of Object.entries(
      tool.parameters?.properties || {},
    )) {
      if (!(key in normalizedArgs)) continue;
      const value = normalizedArgs[key];
      if (
        rule.type === "integer" &&
        typeof value === "string" &&
        /^-?\d+$/.test(value.trim())
      ) {
        normalizedArgs[key] = Number.parseInt(value, 10);
      }
      if (
        rule.type === "number" &&
        typeof value === "string" &&
        value.trim() !== ""
      ) {
        const asNumber = Number(value);
        if (Number.isFinite(asNumber)) normalizedArgs[key] = asNumber;
      }
    }

    const validation = this.validateTool(tool, normalizedArgs);
    if (!validation.valid) {
      const result = { success: false, error: validation.error };
      this.debugTool(name, normalizedArgs, result);
      return result;
    }
    const callbackContext = {
      sessionId: executionContext.sessionId ?? this.currentSessionId,
      runId: executionContext.runId ?? this.runId,
      toolCallId: toolCallId || null,
    };
    this.callbacks.onToolStart?.(name, normalizedArgs, callbackContext);
    try {
      const rawResult = await tool.execute(normalizedArgs, {
        editor: this.editor,
        agent: this,
        signal: this.abortController?.signal,
      });
      const result = this.limitResult(
        this.normalizeToolResultForHistory(rawResult),
      );
      const toolResult =
        result && result.success === false ? result : { success: true, result };
      const callbackResult =
        result && result.success === false
          ? result
          : { success: true, result };
      this.debugTool(name, normalizedArgs, toolResult, {
        activePath: this.editor?.tabManager?.activeFile?.path || null,
        activeTabId: this.editor?.tabManager?.activeFile?.id || null,
      });
      this.callbacks.onToolEnd?.(
        name,
        toolResult,
        callbackContext,
        callbackResult,
      );
      if (toolCallId) this.executedToolCalls.set(toolCallId, toolResult);
      return toolResult;
    } catch (error) {
      const result = {
        success: false,
        error: {
          code: this.isAbortError(error)
            ? "USER_ABORTED"
            : error?.code || "INTERNAL_ERROR",
          message: error?.message || String(error),
        },
      };
      this.debugTool(name, normalizedArgs, result, {
        activePath: this.editor?.tabManager?.activeFile?.path || null,
        activeTabId: this.editor?.tabManager?.activeFile?.id || null,
      });
      this.callbacks.onToolEnd?.(name, result, callbackContext);
      if (toolCallId) this.executedToolCalls.set(toolCallId, result);
      return result;
    }
  }
  validateTool(tool, args) {
    const schema = tool.parameters || {};
    if (schema.type && schema.type !== "object") {
      return { valid: false, error: "Schéma d'arguments invalide." };
    }
    for (const key of schema.required || []) {
      if (args[key] === undefined || args[key] === null) {
        return {
          valid: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: `Argument obligatoire manquant : ${key}`,
          },
        };
      }
    }
    for (const [key, rule] of Object.entries(schema.properties || {})) {
      if (args[key] === undefined) continue;
      const value = args[key];
      const coercedNumber =
        rule.type === "integer" || rule.type === "number"
          ? Number(value)
          : null;
      const typeValid =
        !rule.type ||
        (rule.type === "string" && typeof value === "string") ||
        (rule.type === "integer" &&
          (Number.isInteger(value) ||
            (typeof value === "string" && /^-?\d+$/.test(value.trim())))) ||
        (rule.type === "number" &&
          ((typeof value === "number" && Number.isFinite(value)) ||
            (typeof value === "string" &&
              value.trim() !== "" &&
              Number.isFinite(coercedNumber)))) ||
        (rule.type === "boolean" && typeof value === "boolean") ||
        (rule.type === "object" &&
          value &&
          typeof value === "object" &&
          !Array.isArray(value));
      if (!typeValid)
        return {
          valid: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: `Argument invalide : ${key}`,
          },
        };
      if (rule.enum && !rule.enum.includes(value))
        return {
          valid: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: `Valeur interdite : ${key}`,
          },
        };
      if (rule.minimum !== undefined && value < rule.minimum)
        return {
          valid: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: `Valeur trop petite : ${key}`,
          },
        };
      if (rule.maximum !== undefined && value > rule.maximum)
        return {
          valid: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: `Valeur trop grande : ${key}`,
          },
        };
      if (rule.minLength !== undefined && value.length < rule.minLength)
        return {
          valid: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: `Texte trop court : ${key}`,
          },
        };
      if (rule.maxLength !== undefined && value.length > rule.maxLength)
        return {
          valid: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: `Texte trop long : ${key}`,
          },
        };
    }
    return { valid: true };
  }
  async getContext() {
    let custom = {};
    if (this.contextProvider)
      try {
        custom = (await this.contextProvider(this.editor)) || {};
      } catch (error) {
        console.warn("[Agent] contextProvider failed:", error);
      }
    return {
      ...this.buildEditorContext(),
      ...(typeof custom === "object" ? custom : {}),
    };
  }
  buildEditorContext() {
    const file = this.editor?.tabManager?.activeFile;
    if (!file)
      return {
        hasActiveFile: false,
        file: null,
        cursor: null,
        selection: null,
      };
    const root = this.editor?.fileExplorer?.rootPath;
    const cursor = this.editor?.cursorController;
    let selection = null;
    try {
      const controller = this.editor?.selectController;
      const text = controller?.getSelectedText
        ? controller.getSelectedText()
        : controller?.containsSelected;
      if (typeof text === "string" && text)
        selection = { content: this.truncate(text, 2000) };
    } catch {
      selection = null;
    }
    return {
      hasActiveFile: true,
      file: {
        name: file.name || "Unknown",
        path: this.toProjectRelativePath(file.path, root) || file.name || "",
        language: file.language || "text",
      },
      cursor: cursor
        ? { row: cursor.row ?? 1, column: cursor.column ?? 0 }
        : null,
      selection,
    };
  }
  buildSystemMessage(context, systemPrompt = this.systemPrompt) {
    return `${systemPrompt}\n\nCONTEXTE ACTUEL DE L'ÉDITEUR :\n${JSON.stringify(context)}`;
  }
  appendHistory(history) {
    if (!Array.isArray(history)) return;
    const fullHistory = [...history];
    while (fullHistory[0]?.role === "tool") fullHistory.shift();
    for (const [historyIndex, message] of fullHistory.entries()) {
      if (message?.role === "user" && typeof message.content === "string") {
        this.messages.push({
          role: "user",
          content: message.content,
        });
        continue;
      }
      if (
        message?.role === "assistant" &&
        (typeof message.content === "string" ||
          message.content === null ||
          Array.isArray(message.tool_calls))
      ) {
        const assistantMessage = {
          role: "assistant",
          content:
            typeof message.content === "string"
              ? message.content
              : (message.content ?? null),
          ...(message.reasoning ? { reasoning: message.reasoning } : {}),
        };
        if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
          this.messages.push(
            this.createAssistantToolCallMessage(
              assistantMessage,
              message.tool_calls,
              {
                source: "conversation_history",
                messageIndex: historyIndex,
              },
            ),
          );
        } else {
          this.messages.push(assistantMessage);
        }
        continue;
      }
      if (
        message?.role === "tool" &&
        typeof message.tool_call_id === "string"
      ) {
        this.messages.push(
          this.createToolResultMessage(
            message.tool_call_id,
            message.content,
            { contentIsSerialized: typeof message.content === "string" },
          ),
        );
      }
    }
  }
  truncate(value, max) {
    const text = value === null || value === undefined ? "" : String(value);
    return text.length <= max
      ? text
      : `${text.slice(0, Math.max(0, max - 32))}\n\n[... contenu tronqué par NCE ...]`;
  }
  getContentRevision(value) {
    const text = typeof value === "string" ? value : "";
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }
  createFileReadContext(absolutePath, content, startLine, endLine, source) {
    const lines = String(content).split(/\r?\n/);
    const safeStartLine = Math.max(1, startLine || 1);
    const safeEndLine = Math.min(
      lines.length,
      Math.max(safeStartLine, endLine || safeStartLine),
    );
    const rangeContent = lines.slice(safeStartLine - 1, safeEndLine).join("\n");
    const visibleContent = this.truncate(rangeContent, 4000);
    const context = {
      path: absolutePath,
      startLine: safeStartLine,
      endLine: safeEndLine,
      content: visibleContent,
      revision: this.getContentRevision(content),
      timestamp: Date.now(),
      version: ++this.fileContextVersion,
      source,
      truncated: visibleContent !== rangeContent,
    };
    this.readFileContexts.set(absolutePath, context);
    return context;
  }
  validateFileReadContext(absolutePath, currentText, oldText) {
    const context = this.readFileContexts.get(absolutePath);
    if (!context) {
      return {
        valid: false,
        error: {
          code: "FILE_CONTEXT_REQUIRED",
          message: "Read the current file before modifying it.",
        },
      };
    }
    const currentRevision = this.getContentRevision(currentText);
    if (context.revision !== currentRevision) {
      this.readFileContexts.delete(absolutePath);
      return {
        valid: false,
        error: {
          code: "STALE_CONTEXT",
          message: "The file changed since it was read. Read it again.",
          expectedRevision: context.revision,
          actualRevision: currentRevision,
        },
      };
    }
    if (oldText.includes("[... contenu tronqué par NCE ...]")) {
      return {
        valid: false,
        error: {
          code: "INVALID_OLD_TEXT",
          message: "oldText cannot contain NCE's truncation marker.",
        },
      };
    }
    const oldTextWasRead =
      oldText.length > 0
        ? context.content.includes(oldText.replace(/\r\n?/g, "\n"))
        : context.startLine === 1;
    if (!oldTextWasRead) {
      return {
        valid: false,
        error: {
          code: "FILE_CONTEXT_REQUIRED",
          message:
            "Read the current file section containing oldText before modifying it.",
        },
      };
    }
    return { valid: true, context, currentRevision };
  }
  buildModificationVerification(
    absolutePath,
    content,
    changedStartIndex,
    replacementText,
  ) {
    const startLine = content.slice(0, changedStartIndex).split(/\r?\n/).length;
    const replacementLines = replacementText.split(/\r?\n/).length;
    const totalLines = content.split(/\r?\n/).length;
    const verificationStartLine = Math.max(1, startLine - 10);
    const verificationEndLine = Math.min(
      totalLines,
      startLine + Math.max(1, replacementLines) + 10,
    );
    const context = this.createFileReadContext(
      absolutePath,
      content,
      verificationStartLine,
      verificationEndLine,
      "post-write-verification",
    );
    return {
      verified: true,
      startLine: context.startLine,
      endLine: context.endLine,
      revision: context.revision,
      content: context.content,
    };
  }
  normalizeLineEndingsWithBoundaries(value) {
    const source = typeof value === "string" ? value : "";
    let normalized = "";
    const boundaries = [0];

    for (let index = 0; index < source.length; ) {
      if (source[index] === "\r") {
        index += source[index + 1] === "\n" ? 2 : 1;
        normalized += "\n";
      } else {
        normalized += source[index];
        index += 1;
      }
      boundaries.push(index);
    }
    return { normalized, boundaries };
  }
  findUniqueTextMatch(content, searchText, nearLine) {
    const source = typeof content === "string" ? content : "";
    const search = typeof searchText === "string" ? searchText : "";
    if (!search) return { status: "missing", occurrences: 0 };

    const findMatches = (haystack, needle) => {
      const matches = [];
      let cursor = 0;
      while (cursor <= haystack.length - needle.length) {
        const index = haystack.indexOf(needle, cursor);
        if (index === -1) break;
        matches.push(index);
        cursor = index + needle.length;
      }
      return matches;
    };

    const exactMatches = findMatches(source, search);
    const hasCarriageReturns = source.includes("\r") || search.includes("\r");
    if (exactMatches.length === 1 && !hasCarriageReturns) {
      return {
        status: "unique",
        startIndex: exactMatches[0],
        endIndex: exactMatches[0] + search.length,
        match: "exact",
      };
    }
    if (exactMatches.length > 1) {
      return this.selectMatchNearLine(source, search, exactMatches, nearLine);
    }

    const normalizedSource = this.normalizeLineEndingsWithBoundaries(source);
    const normalizedSearch = search.replace(/\r\n?|\n/g, "\n");
    const normalizedMatches = findMatches(
      normalizedSource.normalized,
      normalizedSearch,
    );
    if (normalizedMatches.length > 1) {
      return this.selectMatchNearLine(
        source,
        search,
        normalizedMatches.map((index) => normalizedSource.boundaries[index]),
        nearLine,
        normalizedSearch.length,
        normalizedMatches.map(
          (index) =>
            normalizedSource.boundaries[index + normalizedSearch.length],
        ),
      );
    }
    if (exactMatches.length === 1) {
      return {
        status: "unique",
        startIndex: exactMatches[0],
        endIndex: exactMatches[0] + search.length,
        match: "exact",
      };
    }
    if (normalizedMatches.length === 1) {
      const start = normalizedMatches[0];
      const end = start + normalizedSearch.length;
      return {
        status: "unique",
        startIndex: normalizedSource.boundaries[start],
        endIndex: normalizedSource.boundaries[end],
        match: "normalized-line-endings",
      };
    }
    return { status: "missing", occurrences: 0 };
  }
  selectMatchNearLine(
    source,
    search,
    matches,
    nearLine,
    matchLength,
    endIndexes = [],
  ) {
    const occurrences = matches.map((startIndex) => ({
      startIndex,
      line: source.slice(0, startIndex).split(/\r?\n/).length,
    }));
    const validNearLine = Number.isInteger(nearLine) && nearLine > 0;
    if (!validNearLine) {
      return {
        status: "ambiguous",
        occurrences: occurrences.length,
        nearestLines: occurrences.map((item) => item.line),
      };
    }
    const ranked = occurrences
      .map((item) => ({ ...item, distance: Math.abs(item.line - nearLine) }))
      .sort((left, right) => left.distance - right.distance);
    if (
      ranked.length === 0 ||
      (ranked[1] && ranked[0].distance === ranked[1].distance)
    ) {
      return {
        status: "ambiguous",
        occurrences: occurrences.length,
        nearestLines: ranked.map((item) => item.line),
      };
    }
    const selected = ranked[0];
    const length = matchLength || search.length;
    return {
      status: "unique",
      startIndex: selected.startIndex,
      endIndex:
        endIndexes[matches.indexOf(selected.startIndex)] ??
        selected.startIndex + length,
      match: "near-line",
      nearLine: selected.line,
    };
  }
  adaptReplacementLineEndings(value, content) {
    const replacement = typeof value === "string" ? value : "";
    const source = typeof content === "string" ? content : "";
    const crlfCount = (source.match(/\r\n/g) || []).length;
    const lfCount = (source.match(/\n/g) || []).length - crlfCount;
    if (crlfCount <= lfCount) return replacement.replace(/\r\n?|\n/g, "\n");
    return replacement.replace(/\r\n?|\n/g, "\r\n");
  }
  limitResult(result) {
    const maxContent = 4000;
    if (typeof result === "string") return this.truncate(result, maxContent);
    if (!result || typeof result !== "object") return result;
    const limited = { ...result };
    for (const key of ["content", "beforeText", "afterText"]) {
      if (
        typeof limited[key] === "string" &&
        limited[key].length > maxContent
      ) {
        limited[key] = this.truncate(limited[key], maxContent);
        limited.truncated = true;
      }
    }
    if (Array.isArray(limited.results) && limited.results.length > 100) {
      limited.results = limited.results.slice(0, 100);
      limited.truncated = true;
    }
    return limited;
  }
  abortError() {
    return new DOMException(
      "L'exécution de l'agent a été annulée.",
      "AbortError",
    );
  }
  isAbortError(error) {
    return error?.name === "AbortError" || this.stopRequested;
  }
  async waitForEditorReady(timeout = 3000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      const writer = this.editor?.writerController;
      const lineController = this.editor?.lineController;
      if (writer?.replaceRange && lineController?.getContent) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }
  lineColumnToIndex(lines, lineNumber, columnNumber) {
    const source = Array.isArray(lines) ? lines : [];
    if (
      !Number.isInteger(lineNumber) ||
      !Number.isInteger(columnNumber) ||
      lineNumber < 1 ||
      lineNumber > source.length ||
      columnNumber < 0 ||
      columnNumber > (source[lineNumber - 1] || "").length
    ) {
      return null;
    }
    const lineIndex = lineNumber - 1;
    const column = columnNumber;
    const offset = source
      .slice(0, lineIndex)
      .reduce((total, line) => total + line.length + 1, 0);
    return offset + Math.min(column, (source[lineIndex] || "").length);
  }
  getStrictRange(text, args = {}) {
    const lines = String(text).split("\n");
    const values = [
      args.startLine,
      args.startColumn,
      args.endLine,
      args.endColumn,
    ];
    if (!values.every((value) => Number.isInteger(value))) {
      return {
        valid: false,
        error: {
          code: "INVALID_RANGE",
          message: "Les coordonnées doivent être des entiers.",
        },
      };
    }
    const { startLine, startColumn, endLine, endColumn } = args;
    if (
      startLine < 1 ||
      endLine < startLine ||
      startLine > lines.length ||
      endLine > lines.length ||
      startColumn < 0 ||
      endColumn < 0
    ) {
      return {
        valid: false,
        error: {
          code: "INVALID_RANGE",
          message: "La plage ne correspond pas aux lignes du fichier.",
        },
      };
    }
    if (
      startColumn > lines[startLine - 1].length ||
      endColumn > lines[endLine - 1].length ||
      (startLine === endLine && endColumn < startColumn)
    ) {
      return {
        valid: false,
        error: {
          code: "INVALID_RANGE",
          message: "Une colonne dépasse la longueur de sa ligne.",
        },
      };
    }
    const lineStart = lines
      .slice(0, startLine - 1)
      .reduce((total, line) => total + line.length + 1, 0);
    const endStart = lines
      .slice(0, endLine - 1)
      .reduce((total, line) => total + line.length + 1, 0);
    const startIndex = lineStart + startColumn;
    const endIndex = endStart + endColumn;
    return {
      valid: true,
      startIndex,
      endIndex,
      actualText: text.slice(startIndex, endIndex),
      startLine,
      startColumn,
      endLine,
      endColumn,
    };
  }
  adjustRangeForMissingIndentation(text, args, range) {
    if (!range || args.startColumn !== 0 || args.startLine !== args.endLine) {
      return range;
    }
    const line = String(text).split("\n")[args.startLine - 1] || "";
    const indentation = line.match(/^[ \t]*/)?.[0] || "";
    if (!indentation || typeof args.expectedText !== "string") return range;
    const content = line.slice(
      indentation.length,
      indentation.length + args.expectedText.length,
    );
    if (args.expectedText !== content) return range;
    return {
      ...range,
      startColumn: indentation.length,
      startIndex: range.startIndex + indentation.length,
      endColumn: range.endColumn + indentation.length,
      endIndex: range.endIndex + indentation.length,
      actualText: args.expectedText,
    };
  }
  toProjectRelativePath(filePath, rootPath) {
    if (typeof filePath !== "string") return "";
    const path = filePath.replace(/\\/g, "/");
    const root =
      typeof rootPath === "string"
        ? rootPath.replace(/\\/g, "/").replace(/\/+$/, "")
        : "";
    const normalizedPath = AgentPath.normalize(path);
    const normalizedRoot = AgentPath.normalize(root);
    const rootPrefix =
      normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`)
        ? normalizedRoot
        : null;
    return rootPrefix
      ? normalizedPath.slice(rootPrefix.length + 1)
      : normalizedPath;
  }

  registerEditorTools() {
    this.registerTool("get_editor_context", {
      description: "Obtenir le contexte minimal de l'éditeur.",
      execute: () => this.buildEditorContext(),
    });
    this.registerTool("get_cursor", {
      description: "Obtenir la position du curseur.",
      execute: () => ({
        available: Boolean(this.editor?.cursorController),
        position: this.editor?.cursorController
          ? {
              row: this.editor.cursorController.row ?? 1,
              column: this.editor.cursorController.column ?? 0,
            }
          : null,
      }),
    });
    this.registerTool("read_selection", {
      description: "Lire la sélection actuelle.",
      execute: () => this.readSelection(),
    });
    this.registerTool("read_active_file", {
      description: "Lire une portion du fichier actif.",
      parameters: {
        type: "object",
        properties: {
          startLine: { type: "integer" },
          endLine: { type: "integer" },
        },
      },
      execute: (args) => this.readActiveFile(args),
    });
    this.registerTool("search_active_file", {
      description: "Rechercher dans le fichier actif.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 500 },
          offset: { type: "integer", minimum: 0, maximum: 100000 },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["query"],
      },
      execute: (args) => this.searchActiveFile(args),
    });
    this.registerTool("create_file", {
      description:
        "Crée un nouveau fichier dans le workspace. Utilise ce tool uniquement si le fichier n'existe pas déjà. Ne l'utilise pas pour modifier un fichier existant : utilise modify_file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
            description: "Chemin du nouveau fichier relatif au workspace.",
          },
          content: {
            type: "string",
            maxLength: 500000,
            description: "Contenu initial du fichier. Vide par défaut.",
          },
          overwrite: {
            type: "boolean",
            description:
              "Écrase explicitement un fichier existant. false par défaut; préfère modify_file pour un fichier existant.",
          },
        },
        required: ["path"],
      },
      execute: (args) => this.createWorkspaceFile(args),
    });
    this.registerTool("rename_file", {
      description:
        "Renomme ou déplace un fichier existant dans le workspace. Si le fichier est importé ailleurs, recherche ses références et mets à jour les chemins concernés.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
            description: "Chemin actuel du fichier dans le workspace.",
          },
          newPath: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
            description:
              "Nouveau chemin du fichier dans le workspace. Le dossier parent doit exister.",
          },
        },
        required: ["path", "newPath"],
      },
      execute: (args) => this.renameWorkspaceFile(args),
    });
    this.registerTool("modify_file", {
      description: `
Modifier un fichier du workspace, même s'il n'est pas actif.

Règles de sécurité :
- Le chemin peut être relatif au projet ou absolu.
- Le fichier doit rester dans le workspace ouvert.
- Utilise cet outil pour toute modification, y compris celle du fichier actif.
- oldText doit correspondre à une seule occurrence exacte; sinon la modification est refusée.
- Copie oldText depuis le dernier résultat read_file et choisis un fragment minimal mais unique.
- Une lecture récente de la zone contenant oldText est obligatoire; sinon FILE_CONTEXT_REQUIRED est retourné.
- Ne copie jamais le marqueur de troncature ajouté par NCE dans oldText.
- Les différences CRLF/LF sont normalisées automatiquement, mais aucun autre écart de contenu n'est accepté.
- N'envoie pas de coordonnées : NCE calcule les positions automatiquement.
- Après modification, la commande retourne le chemin relatif et les contenus avant/après.
`,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Chemin du fichier à modifier, relatif au workspace ou absolu.",
          },
          oldText: {
            type: "string",
            description: "Texte exact à remplacer dans le fichier cible.",
          },
          newText: {
            type: "string",
            description: "Nouveau texte exact à enregistrer.",
          },
          nearLine: {
            type: "integer",
            minimum: 1,
            description:
              "Numéro de ligne approximatif 1-based. Sert uniquement à choisir une occurrence en cas d'ambiguïté.",
          },
          revision: {
            type: "string",
            description:
              "Révision retournée par read_file. Le write est refusé si le fichier a changé depuis cette lecture.",
          },
          text: {
            type: "string",
            description: "Alias de newText pour compatibilité.",
          },
        },
        required: ["path", "oldText", "newText"],
      },
      execute: (args) => this.modifyFile(args),
    });
    this.registerTool("modify_active_file", {
      description: `
Modifier précisément une plage du fichier actif.

IMPORTANT :
- Les lignes sont numérotées à partir de 1.
- Les colonnes sont numérotées à partir de 0.
- column 0 correspond au premier caractère de la ligne.
- Une colonne égale à la longueur de la ligne correspond à la fin de la ligne.
- La plage [startLine:startColumn, endLine:endColumn] est remplacée par text.
- start et end sont inclusifs/exclusifs comme une plage JavaScript : le caractère à endColumn n'est PAS remplacé.
- Pour remplacer toute une ligne, utilise startColumn=0 et endColumn=longueur exacte de la ligne.
- Pour INSÉRER du texte sans supprimer de texte, start et end doivent être exactement identiques.
- Pour supprimer du texte, utilise text="".
- Ne devine jamais les coordonnées : lis d'abord le contenu actuel avec read_active_file.
- Après une lecture, utilise exactement les numéros de lignes et colonnes correspondant au contenu lu.
- expectedText doit contenir exactement le texte actuellement présent dans la plage.
- expectedText doit normalement inclure les espaces et tabulations au début de ligne ; si startColumn=0 et qu'il les omet, ils sont conservés automatiquement.
- Si expectedText ne correspond pas, le remplacement sera refusé.
- Pour une modification normale, fournis oldText et newText : les coordonnées seront calculées automatiquement.
- N'envoie jamais une plage partielle ou des valeurs undefined : utilise soit oldText/newText, soit les quatre coordonnées startLine, startColumn, endLine et endColumn.
`,
      parameters: {
        type: "object",
        properties: {
          oldText: {
            type: "string",
            description:
              "Texte exact à remplacer. Une seule occurrence doit exister.",
          },
          newText: {
            type: "string",
            description: "Nouveau texte exact qui remplacera oldText.",
          },
          startLine: {
            type: "integer",
            minimum: 1,
            description: "Numéro de ligne 1-based.",
          },

          startColumn: {
            type: "integer",
            minimum: 0,
            description: "Colonne 0-based. 0 = début de ligne.",
          },

          endLine: {
            type: "integer",
            minimum: 1,
            description: "Numéro de ligne 1-based.",
          },

          endColumn: {
            type: "integer",
            minimum: 0,
            description:
              "Colonne 0-based et exclusive. Une valeur égale à la longueur de la ligne signifie la fin de la ligne.",
          },

          expectedText: {
            type: "string",
            description:
              "Contenu exact attendu dans la plage avant le remplacement.",
          },

          text: {
            type: "string",
            description:
              "Texte de remplacement, conservé pour compatibilité si newText n'est pas fourni.",
          },
        },
      },
      execute: (args) => this.modifyActiveFile(args),
    });
    this.registerTool("replace_text", {
      description:
        "Remplacer une seule occurrence exacte dans le fichier actif. Préférer cet outil pour les modifications simples.",
      parameters: {
        type: "object",
        properties: {
          oldText: { type: "string", description: "Texte exact à remplacer." },
          newText: { type: "string", description: "Nouveau texte." },
        },
        required: ["oldText", "newText"],
      },
      execute: (args) => this.replaceText(args),
    });
    this.registerTool("read_file", {
      description: "Lire un fichier du projet.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
        },
        required: ["path"],
      },
      execute: (args) => this.readFile(args.path, args),
    });
    this.registerTool("get_project_map", {
      description:
        "Retourne une carte compacte de la structure du projet avec les fichiers, leur langage et leur nombre de lignes. Utilise ce tool pour comprendre rapidement l'organisation générale du workspace avant une exploration détaillée.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            maxLength: 4000,
            description:
              "Sous-dossier relatif au workspace. La racine du projet est utilisée par défaut.",
          },
          maxDepth: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            description: "Profondeur maximale de l'arborescence. 6 par défaut.",
          },
        },
      },
      readOnly: true,
      execute: (args) => this.getProjectMap(args),
    });
    this.registerTool("list_project_files", {
      description: "Lister les fichiers du projet.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      execute: (args) => this.listProjectFiles(args.path),
    });
    this.registerTool("search_project_files", {
      description: "Rechercher dans le projet.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      execute: (args) => this.searchProjectFiles(args),
    });
  }
  shouldPersistAgentEdit(filePath) {
    const file =
      typeof filePath === "string"
        ? this.editor?.tabManager?.getFileByPath?.(filePath)
        : null;
    if (file && typeof file.autoSave === "boolean") {
      return file.autoSave === true;
    }
    return false;
  }
  getWorkspaceFileTarget(filePath) {
    const input = typeof filePath === "string" ? filePath.trim() : "";
    const root = this.editor?.fileExplorer?.rootPath;
    if (
      !input ||
      /[\\/]$/.test(input) ||
      input.includes("\0") ||
      typeof root !== "string" ||
      !root.trim()
    ) {
      return {
        valid: false,
        error: {
          code: "INVALID_PATH",
          message: "Un chemin de fichier et un workspace ouvert sont requis.",
          path: input,
        },
      };
    }
    const absolutePath = this.resolveWorkspacePath(input, root);
    if (!absolutePath) {
      return {
        valid: false,
        error: {
          code: "OUTSIDE_WORKSPACE",
          message: "Le chemin doit rester dans le workspace ouvert.",
          path: input,
        },
      };
    }
    if (
      AgentPath.normalize(absolutePath) === AgentPath.normalize(root) ||
      !AgentPath.basename(absolutePath)
    ) {
      return {
        valid: false,
        error: {
          code: "INVALID_PATH",
          message: "Le chemin doit désigner un fichier.",
          path: input,
        },
      };
    }
    return {
      valid: true,
      input,
      root: AgentPath.normalize(root),
      absolutePath,
      relativePath: this.toProjectRelativePath(absolutePath, root),
      parentPath: AgentPath.dirname(absolutePath),
      fileName: AgentPath.basename(absolutePath),
    };
  }
  getFileOperationError(result, fallbackCode, fallbackMessage, path) {
    const code = typeof result?.code === "string" ? result.code : fallbackCode;
    return {
      code,
      message:
        typeof result?.error === "string" && result.error
          ? result.error
          : fallbackMessage,
      path,
    };
  }
  async refreshWorkspaceFolders(paths = []) {
    const explorer = this.editor?.fileExplorer;
    if (typeof explorer?.refreshFolder !== "function") return;
    const uniquePaths = [...new Set(paths.filter(Boolean))];
    for (const folderPath of uniquePaths) {
      await explorer.refreshFolder(folderPath);
    }
  }
  async createWorkspaceFile(args = {}) {
    const target = this.getWorkspaceFileTarget(args.path);
    if (!target.valid) return { success: false, error: target.error };

    const content = typeof args.content === "string" ? args.content : "";
    const overwrite = args.overwrite === true;
    const exists = await this.api?.pathExists?.(target.absolutePath);
    if (exists && !overwrite) {
      return {
        success: false,
        error: {
          code: "FILE_ALREADY_EXISTS",
          message:
            "Le fichier existe déjà. Utilisez modify_file pour le modifier.",
          path: target.relativePath,
        },
      };
    }

    const openFile = this.editor?.tabManager?.getFileByPath?.(
      target.absolutePath,
    );
    if (exists && overwrite && openFile && !openFile.isSaved) {
      return {
        success: false,
        error: {
          code: "PERMISSION_DENIED",
          message:
            "Le fichier ouvert contient des modifications non sauvegardées et ne peut pas être écrasé.",
          path: target.relativePath,
        },
      };
    }

    let snapshotKey = null;
    if (exists && overwrite) {
      const previous = (
        await this.api?.getFileContent?.([target.absolutePath])
      )?.[target.absolutePath];
      if (typeof previous !== "string") {
        return {
          success: false,
          error: {
            code: "CREATE_FAILED",
            message: "Le contenu existant n'a pas pu être sauvegardé.",
            path: target.relativePath,
          },
        };
      }
      const readContextValidation = this.validateFileReadContext(
        target.absolutePath,
        previous,
        "",
      );
      if (!readContextValidation.valid) {
        return {
          success: false,
          error: {
            ...readContextValidation.error,
            path: target.relativePath,
          },
        };
      }
      snapshotKey = `create:${target.absolutePath}:${Date.now()}:${Math.random()}`;
      this.fileSnapshots.set(snapshotKey, previous);
    }

    const operation = await this.api?.createFile?.(
      target.parentPath,
      target.fileName,
      content,
      overwrite,
    );
    if (!operation?.success) {
      if (snapshotKey) this.fileSnapshots.delete(snapshotKey);
      return {
        success: false,
        error: this.getFileOperationError(
          operation,
          "CREATE_FAILED",
          "La création du fichier a échoué.",
          target.relativePath,
        ),
      };
    }

    if (openFile && overwrite) {
      openFile.isLoaded = false;
      await this.editor?.tabManager?.reloadFileFromDisk?.(target.absolutePath);
    }
    await this.refreshWorkspaceFolders([target.parentPath]);
    const verifiedContent = (
      await this.api?.getFileContent?.([target.absolutePath])
    )?.[target.absolutePath];
    if (typeof verifiedContent !== "string" || verifiedContent !== content) {
      return {
        success: false,
        error: {
          code: "CREATE_VERIFICATION_FAILED",
          message:
            "Le contenu du fichier créé ne correspond pas au contenu demandé.",
          path: target.relativePath,
        },
      };
    }
    const verificationContext = this.createFileReadContext(
      target.absolutePath,
      verifiedContent,
      1,
      Math.min(200, verifiedContent.split(/\r?\n/).length),
      "post-create-verification",
    );
    let openedInTabManager = false;
    if (
      !exists &&
      typeof this.editor?.tabManager?.openFileWithPath === "function"
    ) {
      await this.editor.tabManager.openFileWithPath(target.absolutePath);
      openedInTabManager = true;
      const createdFile = this.editor.tabManager.getFileByPath?.(
        target.absolutePath,
      );
      if (createdFile) {
        this.markFileDiffHighlights("", verifiedContent, createdFile);
        this.editor?.lineController?.markDirtyAll?.();
        this.editor?.lineController?.refresh?.(true);
      }
    }
    return {
      success: true,
      operation: "create",
      path: target.relativePath,
      absolutePath: target.absolutePath,
      created: !exists,
      overwritten: Boolean(exists && overwrite),
      openedInTabManager,
      snapshotKey,
      verification: {
        verified: true,
        revision: verificationContext.revision,
        content: verificationContext.content,
      },
    };
  }
  async renameWorkspaceFile(args = {}) {
    const source = this.getWorkspaceFileTarget(args.path);
    if (!source.valid) return { success: false, error: source.error };
    const destination = this.getWorkspaceFileTarget(args.newPath);
    if (!destination.valid) {
      return { success: false, error: destination.error };
    }
    if (
      AgentPath.normalize(source.absolutePath) ===
      AgentPath.normalize(destination.absolutePath)
    ) {
      return {
        success: false,
        error: {
          code: "INVALID_PATH",
          message: "Le nouveau chemin doit être différent du chemin actuel.",
          path: destination.relativePath,
        },
      };
    }
    if (!(await this.api?.pathExists?.(source.absolutePath))) {
      return {
        success: false,
        error: {
          code: "FILE_NOT_FOUND",
          message: "Le fichier source n'existe pas.",
          path: source.relativePath,
        },
      };
    }
    if (await this.api?.pathExists?.(destination.absolutePath)) {
      return {
        success: false,
        error: {
          code: "DESTINATION_EXISTS",
          message: "La destination existe déjà.",
          path: destination.relativePath,
        },
      };
    }
    if (!(await this.api?.pathExists?.(destination.parentPath))) {
      return {
        success: false,
        error: {
          code: "PARENT_NOT_FOUND",
          message: "Le dossier de destination n'existe pas.",
          path: destination.relativePath,
        },
      };
    }

    const operation = await this.api?.renameEntry?.(
      source.absolutePath,
      destination.absolutePath,
    );
    if (!operation?.success) {
      return {
        success: false,
        error: this.getFileOperationError(
          operation,
          "RENAME_FAILED",
          "Le renommage du fichier a échoué.",
          source.relativePath,
        ),
      };
    }

    const tabManager = this.editor?.tabManager;
    await tabManager?.updateFilePath?.(
      source.absolutePath,
      destination.absolutePath,
    );
    const explorer = this.editor?.fileExplorer;
    if (
      AgentPath.normalize(explorer?.activeFilePath || "") ===
      AgentPath.normalize(source.absolutePath)
    ) {
      explorer.activeFilePath = destination.absolutePath;
    }
    if (this.readFileContexts.has(source.absolutePath)) {
      this.readFileContexts.set(
        destination.absolutePath,
        this.readFileContexts.get(source.absolutePath),
      );
      this.readFileContexts.delete(source.absolutePath);
    }
    await this.refreshWorkspaceFolders([
      source.parentPath,
      destination.parentPath,
    ]);
    const sourceStillExists = await this.api?.pathExists?.(source.absolutePath);
    const destinationExists = await this.api?.pathExists?.(
      destination.absolutePath,
    );
    if (sourceStillExists || !destinationExists) {
      return {
        success: false,
        error: {
          code: "RENAME_VERIFICATION_FAILED",
          message: "Le renommage n'a pas pu être vérifié dans le workspace.",
          path: source.relativePath,
          newPath: destination.relativePath,
        },
      };
    }
    const renamedContent = (
      await this.api?.getFileContent?.([destination.absolutePath])
    )?.[destination.absolutePath];
    let verification = { verified: true };
    if (typeof renamedContent === "string") {
      const verificationContext = this.createFileReadContext(
        destination.absolutePath,
        renamedContent,
        1,
        Math.min(200, renamedContent.split(/\r?\n/).length),
        "post-rename-verification",
      );
      verification = {
        verified: true,
        revision: verificationContext.revision,
        content: verificationContext.content,
      };
    }
    return {
      success: true,
      operation: "rename",
      oldPath: source.relativePath,
      newPath: destination.relativePath,
      oldAbsolutePath: source.absolutePath,
      newAbsolutePath: destination.absolutePath,
      renamed: true,
      verification,
    };
  }
  async readSelection() {
    const controller = this.editor?.selectController;
    const text = controller?.getSelectedText
      ? controller.getSelectedText()
      : controller?.containsSelected;
    return typeof text === "string" && text
      ? { success: true, content: this.truncate(text, 2000) }
      : { success: false, error: "Aucune sélection active." };
  }
  async replaceText(args = {}) {
    if (typeof args.oldText !== "string" || typeof args.newText !== "string") {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "oldText et newText doivent être des chaînes.",
        },
      };
    }
    return this.modifyActiveFile({
      oldText: args.oldText,
      newText: args.newText,
    });
  }
  async modifyFile(args = {}) {
    const relativePath = typeof args.path === "string" ? args.path.trim() : "";
    if (!relativePath) {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "Le chemin du fichier est obligatoire.",
        },
      };
    }

    const root = this.editor?.fileExplorer?.rootPath;
    const absolutePath = this.resolveWorkspacePath(relativePath, root);
    if (!absolutePath) {
      return {
        success: false,
        error: {
          code: "INVALID_PATH",
          message: "Chemin hors du workspace.",
        },
      };
    }

    const oldText = typeof args.oldText === "string" ? args.oldText : "";
    const newText =
      typeof args.newText === "string"
        ? args.newText
        : typeof args.text === "string"
          ? args.text
          : "";
    const nearLine =
      Number.isInteger(args.nearLine) && args.nearLine > 0
        ? args.nearLine
        : undefined;

    if (typeof oldText !== "string" || typeof newText !== "string") {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "oldText et newText doivent être des chaînes.",
        },
      };
    }

    const requestKey = JSON.stringify({
      path: absolutePath,
      oldText,
      newText,
      nearLine: nearLine ?? null,
      revision: args.revision ?? null,
    });
    if (this.executedModificationRequests.has(requestKey)) {
      return {
        success: false,
        error: {
          code: "DUPLICATE_MODIFICATION",
          message: "Cette modification de fichier a déjà été exécutée.",
        },
      };
    }

    const tabManager = this.editor?.tabManager;
    const alreadyOpen = tabManager?.getFileByPath?.(absolutePath);
    if (alreadyOpen) {
      await this.editor?.fileLoader?.waitForFileLoaded?.(alreadyOpen);
    }
    if (!alreadyOpen && typeof this.api?.pathExists === "function") {
      const exists = await this.api.pathExists(absolutePath);
      if (!exists) {
        return {
          success: false,
          error: {
            code: "FILE_NOT_FOUND",
            message: `Le fichier n'existe pas : ${relativePath}`,
            path: relativePath,
          },
        };
      }
    }

    const persistToDisk = this.shouldPersistAgentEdit(absolutePath);
    const currentText = alreadyOpen
      ? alreadyOpen.lines.map((line) => line.getText()).join("\n")
      : (await this.api?.getFileContent?.([absolutePath]))?.[absolutePath];
    if (typeof currentText !== "string") {
      return {
        success: false,
        error: {
          code: "READ_FAILED",
          message: `Impossible de lire le fichier : ${relativePath}`,
        },
      };
    }
    const readContextValidation = this.validateFileReadContext(
      absolutePath,
      currentText,
      oldText,
    );
    if (!readContextValidation.valid) {
      return {
        success: false,
        error: {
          ...readContextValidation.error,
          path: this.toProjectRelativePath(absolutePath, root),
        },
      };
    }
    if (this.readAfterFailurePaths.has(absolutePath)) {
      return {
        success: false,
        error: {
          code: "READ_AFTER_NO_MATCH",
          message:
            "Relisez ce fichier avec read_file avant de réessayer après NO_MATCH.",
          path: this.toProjectRelativePath(absolutePath, root),
        },
      };
    }
    const currentRevision = readContextValidation.currentRevision;
    if (
      typeof args.revision === "string" &&
      args.revision !== currentRevision
    ) {
      return {
        success: false,
        error: {
          code: "STALE_CONTEXT",
          message: "Le fichier a changé depuis sa dernière lecture.",
          path: this.toProjectRelativePath(absolutePath, root),
          expectedRevision: args.revision,
          actualRevision: currentRevision,
        },
      };
    }
    const replacementText = this.adaptReplacementLineEndings(
      newText,
      currentText,
    );
    const editorUpdatedText = (updatedText) =>
      updatedText.replace(/\r\n?/g, "\n");

    if (oldText.length === 0 && replacementText === "") {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "Le remplacement ne peut pas être vide si oldText est vide.",
        },
      };
    }
    if (
      oldText.length > 0 &&
      replacementText.includes(`${oldText}${oldText}`)
    ) {
      return {
        success: false,
        error: {
          code: "SUSPECTED_DUPLICATION",
          message:
            "The replacement contains two consecutive copies of oldText.",
        },
      };
    }

    if (oldText.length === 0) {
      const updatedText = `${replacementText}${currentText}`;
      const normalizedUpdatedText = editorUpdatedText(updatedText);
      const result = {
        success: true,
        operation: "replace",
        path: this.toProjectRelativePath(absolutePath, root),
        absolutePath,
        beforeText: currentText,
        afterText: updatedText,
        match: "insert-start",
        nearLine: nearLine ?? null,
        revision: this.getContentRevision(updatedText),
      };

      if (tabManager && !alreadyOpen) {
        await tabManager.openFileWithPath(absolutePath);
      }
      const openFile = tabManager?.getFileByPath?.(absolutePath);
      if (!openFile) {
        this.executedModificationRequests.delete(requestKey);
        return {
          success: false,
          error: {
            code: "TARGET_FILE_NOT_OPEN",
            message: `Le fichier cible n'a pas pu être ouvert : ${relativePath}`,
          },
        };
      }
      if (
        AgentPath.normalize(openFile.path) !== AgentPath.normalize(absolutePath)
      ) {
        this.executedModificationRequests.delete(requestKey);
        return {
          success: false,
          error: {
            code: "TARGET_PATH_MISMATCH",
            message: `Le tab ouvert ne correspond pas au fichier cible : ${relativePath}`,
          },
        };
      }
      if (openFile) {
        openFile.isLoaded = false;
        await tabManager.setFocusFile(openFile);
        this.editor.lineController?.loadContent?.(normalizedUpdatedText);
        if (openFile) {
          openFile.lines = normalizedUpdatedText
            .split("\n")
            .map((line) => new LineNode(line));
          openFile.totalLines = openFile.lines.length;
          openFile.maxLineLength = 0;
        }
        const writtenText = openFile.lines
          .map((line) => line.getText())
          .join("\n");
        if (writtenText !== normalizedUpdatedText) {
          this.editor.lineController?.loadContent?.(
            editorUpdatedText(currentText),
          );
          return {
            success: false,
            error: {
              code: "VERIFICATION_FAILED",
              message:
                "Le contenu écrit ne correspond pas au remplacement demandé.",
              path: relativePath,
            },
          };
        }
        this.markFileDiffHighlights(currentText, updatedText, openFile);
        if (this.editor.lineController?.refresh) {
          this.editor.lineController.refresh(true);
        }
        openFile.setIsSaved(false);
        if (persistToDisk && typeof this.api?.saveFile === "function") {
          const savedPath = await this.api.saveFile(absolutePath, updatedText);
          if (savedPath !== absolutePath) {
            return {
              success: false,
              error: {
                code: "SAVE_FAILED",
                message: `Le fichier n'a pas pu être sauvegardé : ${relativePath}`,
                path: relativePath,
              },
            };
          }
        }
      }
      result.revision = this.getContentRevision(normalizedUpdatedText);
      result.verification = this.buildModificationVerification(
        absolutePath,
        normalizedUpdatedText,
        0,
        replacementText,
      );
      this.executedModificationRequests.set(requestKey, result);
      return result;
    }

    const textMatch = this.findUniqueTextMatch(currentText, oldText, nearLine);
    if (textMatch.status === "missing") {
      this.readAfterFailurePaths.add(absolutePath);
      return {
        success: false,
        error: {
          code: "NO_MATCH",
          message:
            "Aucune occurrence trouvée pour oldText. Relisez le fichier et copiez un fragment minimal depuis le dernier résultat de read_file.",
          path: this.toProjectRelativePath(absolutePath, root),
          nearLine: nearLine ?? null,
          readRequired: true,
          hint: "Relisez la zone autour de nearLine et utilisez un oldText exact.",
        },
      };
    }

    if (textMatch.status === "ambiguous") {
      return {
        success: false,
        error: {
          code: "AMBIGUOUS_MATCH",
          message:
            "oldText est présent plusieurs fois dans ce fichier. Le remplacement est refusé.",
          occurrences: textMatch.occurrences,
          nearestLines: textMatch.nearestLines || [],
        },
      };
    }

    const updatedText =
      currentText.slice(0, textMatch.startIndex) +
      replacementText +
      currentText.slice(textMatch.endIndex);
    const normalizedUpdatedText = editorUpdatedText(updatedText);

    const result = {
      success: true,
      operation: "replace",
      path: this.toProjectRelativePath(absolutePath, root),
      absolutePath,
      beforeText: currentText,
      afterText: updatedText,
      match: textMatch.match,
      nearLine: nearLine ?? null,
      revision: this.getContentRevision(updatedText),
    };

    if (tabManager && !alreadyOpen) {
      await tabManager.openFileWithPath(absolutePath);
    }
    const openFile = tabManager?.getFileByPath?.(absolutePath);
    if (!openFile) {
      this.executedModificationRequests.delete(requestKey);
      return {
        success: false,
        error: {
          code: "TARGET_FILE_NOT_OPEN",
          message: `Le fichier cible n'a pas pu être ouvert : ${relativePath}`,
        },
      };
    }
    if (
      AgentPath.normalize(openFile.path) !== AgentPath.normalize(absolutePath)
    ) {
      this.executedModificationRequests.delete(requestKey);
      return {
        success: false,
        error: {
          code: "TARGET_PATH_MISMATCH",
          message: `Le tab ouvert ne correspond pas au fichier cible : ${relativePath}`,
        },
      };
    }
    if (openFile) {
      openFile.isLoaded = false;
      await tabManager.setFocusFile(openFile);
      this.editor.lineController?.loadContent?.(normalizedUpdatedText);
      if (openFile) {
        openFile.lines = normalizedUpdatedText
          .split("\n")
          .map((line) => new LineNode(line));
        openFile.totalLines = openFile.lines.length;
        openFile.maxLineLength = 0;
      }
      const writtenText = openFile.lines
        .map((line) => line.getText())
        .join("\n");
      if (writtenText !== normalizedUpdatedText) {
        this.editor.lineController?.loadContent?.(
          editorUpdatedText(currentText),
        );
        return {
          success: false,
          error: {
            code: "VERIFICATION_FAILED",
            message:
              "Le contenu écrit ne correspond pas au remplacement demandé.",
            path: relativePath,
          },
        };
      }
      this.markFileDiffHighlights(currentText, updatedText, openFile);
      if (this.editor.lineController?.refresh) {
        this.editor.lineController.refresh(true);
      }
      openFile.setIsSaved(false);
      if (persistToDisk && typeof this.api?.saveFile === "function") {
        const savedPath = await this.api.saveFile(absolutePath, updatedText);
        if (savedPath !== absolutePath) {
          return {
            success: false,
            error: {
              code: "SAVE_FAILED",
              message: `Le fichier n'a pas pu être sauvegardé : ${relativePath}`,
              path: relativePath,
            },
          };
        }
      }
    }
    result.revision = this.getContentRevision(normalizedUpdatedText);
    result.verification = this.buildModificationVerification(
      absolutePath,
      normalizedUpdatedText,
      editorUpdatedText(currentText.slice(0, textMatch.startIndex)).length,
      replacementText.replace(/\r\n?/g, "\n"),
    );
    this.executedModificationRequests.set(requestKey, result);
    return result;
  }
  restoreActiveFileSnapshot(content) {
    const lineController = this.editor?.lineController;
    if (typeof lineController?.loadContent !== "function") return false;
    lineController.loadContent(content);
    lineController.markDirtyAll?.();
    lineController.refresh?.(true);
    return true;
  }
  async readActiveFile(args = {}) {
    const controller = this.editor?.lineController;
    const file = this.editor?.tabManager?.activeFile;
    if (!file || !controller)
      return { success: false, error: "Aucun fichier actif." };
    await this.editor?.fileLoader?.waitForFileLoaded?.(file);
    const lines = controller.getContent().split("\n");
    const startLine =
      Number.isInteger(args.startLine) && args.startLine > 0
        ? args.startLine
        : 1;
    const endLine = Math.min(
      Number.isInteger(args.endLine) ? args.endLine : startLine + 149,
      startLine + 199,
      lines.length,
    );
    const content = lines.slice(startLine - 1, endLine).join("\n");
    const fullContent = lines.join("\n");
    const readContext = this.createFileReadContext(
      AgentPath.normalize(file.path),
      fullContent,
      startLine,
      endLine,
      "read_active_file",
    );
    return {
      success: true,
      path: this.toProjectRelativePath(
        file.path,
        this.editor?.fileExplorer?.rootPath,
      ),
      startLine,
      endLine,
      totalLines: lines.length,
      truncated: endLine < lines.length,
      revision: readContext.revision,
      content: readContext.content,
    };
  }
  async searchActiveFile(args = {}) {
    const controller = this.editor?.searchController;
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!controller?.search)
      return { success: false, error: "SearchController indisponible." };
    if (!query) return { success: false, error: "Requête vide." };
    controller.search(query);
    const results = Array.isArray(controller.results)
      ? controller.results.slice(0, 50)
      : [];
    return {
      success: true,
      query,
      totalMatches: controller.results?.length || 0,
      results: results.map(({ row, column, length }) => ({
        row,
        column,
        length,
      })),
    };
  }
  async readFile(filePath, options = {}) {
    const root = this.editor?.fileExplorer?.rootPath;
    const absolute = this.resolveWorkspacePath(filePath, root);
    if (!absolute)
      return {
        success: false,
        error: { code: "INVALID_PATH", message: "Chemin hors du workspace." },
      };
    const openFile = this.editor?.tabManager?.getFileByPath?.(absolute);
    if (openFile) {
      await this.editor?.fileLoader?.waitForFileLoaded?.(openFile);
    }
    const content = openFile
      ? openFile.lines.map((line) => line.getText()).join("\n")
      : (await this.api?.getFileContent?.([absolute]))?.[absolute];
    if (typeof content === "string") {
      this.readAfterFailurePaths.delete(absolute);
      const totalLines = content.split(/\r?\n/).length;
      const startLine =
        Number.isInteger(options.startLine) && options.startLine > 0
          ? options.startLine
          : 1;
      const endLine = Math.min(
        Number.isInteger(options.endLine) && options.endLine >= startLine
          ? options.endLine
          : startLine + 199,
        totalLines,
      );
      const readContext = this.createFileReadContext(
        absolute,
        content,
        startLine,
        endLine,
        "read_file",
      );
      return {
        success: true,
        path: filePath,
        startLine,
        endLine,
        totalLines,
        revision: readContext.revision,
        truncated: endLine < totalLines || readContext.truncated,
        content: readContext.content,
      };
    }
    return {
      success: false,
      error: `Impossible de lire le fichier: ${filePath}`,
    };
  }
  async listProjectFiles(path = "") {
    const root = this.editor?.fileExplorer?.rootPath;
    if (!root) return { success: false, error: "Pas de projet ouvert." };
    const target = path ? this.resolveWorkspacePath(path, root) : root;
    if (!target)
      return {
        success: false,
        error: { code: "INVALID_PATH", message: "Chemin hors du workspace." },
      };
    const files = await this.api?.getFolderContent?.(target);
    return Array.isArray(files)
      ? {
          success: true,
          path,
          total: files.length,
          files: files.slice(0, 200).map((item) => ({
            name: item.name,
            type: item.type,
            path: this.toProjectRelativePath(item.path, root),
          })),
        }
      : { success: false, error: "Impossible de lire le dossier." };
  }
  async getProjectMap(args = {}) {
    const root = this.editor?.fileExplorer?.rootPath;
    if (!root) return { success: false, error: "Pas de projet ouvert." };
    const requestedPath =
      typeof args.path === "string" ? args.path.trim() : "";
    const target = requestedPath
      ? this.resolveWorkspacePath(requestedPath, root)
      : AgentPath.normalize(root);
    if (!target) {
      return {
        success: false,
        error: { code: "INVALID_PATH", message: "Chemin hors du workspace." },
      };
    }
    if (typeof this.api?.getProjectMap !== "function") {
      return {
        success: false,
        error: {
          code: "PROJECT_MAP_UNAVAILABLE",
          message: "Le service de carte du projet est indisponible.",
        },
      };
    }
    const maxDepth = Number.isInteger(args.maxDepth) ? args.maxDepth : 6;
    const map = await this.api.getProjectMap(root, target, {
      maxDepth,
      maxFiles: 1000,
    });
    if (!map?.success || !Array.isArray(map.entries)) {
      return map || {
        success: false,
        error: {
          code: "PROJECT_MAP_FAILED",
          message: "Impossible de construire la carte du projet.",
        },
      };
    }
    const entries = await this.addProjectMapLanguages(map.entries);
    const tree = this.buildProjectMapTree(entries);
    const rootLabel = `${AgentPath.basename(target) || "project"}/`;
    return {
      success: true,
      root: map.root,
      files: map.files,
      directories: map.directories,
      truncated: map.truncated === true,
      maxDepth: map.maxDepth,
      maxFiles: map.maxFiles,
      tree,
      text: this.formatProjectMapText(rootLabel, tree, map),
    };
  }
  async addProjectMapLanguages(entries = []) {
    const languageByExtension = new Map();
    const enriched = [];
    for (const entry of entries) {
      if (entry?.type !== "file") {
        enriched.push({ ...entry, children: [] });
        continue;
      }
      const extension = this.getProjectMapExtension(entry.name);
      if (!languageByExtension.has(extension)) {
        languageByExtension.set(
          extension,
          await this.detectProjectMapLanguage(entry.name, extension),
        );
      }
      enriched.push({
        name: entry.name,
        path: entry.path,
        relativePath: entry.relativePath,
        type: "file",
        language: languageByExtension.get(extension),
        lineCount: Number.isInteger(entry.lineCount) ? entry.lineCount : null,
        binary: entry.binary === true,
      });
    }
    return enriched;
  }
  getProjectMapExtension(fileName) {
    const name = typeof fileName === "string" ? fileName.toLowerCase() : "";
    const index = name.lastIndexOf(".");
    return index > 0 ? name.slice(index) : "";
  }
  async detectProjectMapLanguage(fileName, extension) {
    const specificLanguages = {
      ".jsx": "javascriptreact",
      ".tsx": "typescriptreact",
      ".cjs": "javascript",
      ".scss": "scss",
      ".md": "markdown",
      ".c": "c",
      ".h": "cpp",
      ".cpp": "cpp",
      ".cc": "cpp",
      ".cxx": "cpp",
      ".hpp": "cpp",
      ".sh": "shell",
      ".sql": "sql",
      ".rs": "rust",
      ".go": "go",
    };
    if (specificLanguages[extension]) return specificLanguages[extension];
    const detected = await this.editor?.highlightController?.detectLanguage?.(
      fileName,
    );
    const normalized =
      typeof detected === "string" ? detected.trim().toLowerCase() : "";
    return normalized && normalized !== "plaintext" ? normalized : "unknown";
  }
  buildProjectMapTree(entries = []) {
    const root = { children: [], directories: new Map() };
    for (const entry of entries) {
      const parts = String(entry.relativePath || entry.name || "")
        .split("/")
        .filter(Boolean);
      if (!parts.length) continue;
      let parent = root;
      for (let index = 0; index < parts.length; index += 1) {
        const name = parts[index];
        const isLeaf = index === parts.length - 1;
        if (isLeaf && entry.type === "file") {
          parent.children.push({ ...entry, name });
          continue;
        }
        let directory = parent.directories.get(name);
        if (!directory) {
          const directoryPath = parts.slice(0, index + 1).join("/");
          directory = {
            name,
            path:
              entry.type === "directory" && isLeaf
                ? entry.path
                : directoryPath,
            type: "directory",
            children: [],
            directories: new Map(),
          };
          parent.directories.set(name, directory);
          parent.children.push(directory);
        }
        parent = directory;
      }
    }
    const stripIndexes = (nodes) =>
      nodes.map((node) =>
        node.type === "directory"
          ? {
              name: node.name,
              path: node.path,
              type: "directory",
              children: stripIndexes(node.children),
            }
          : node,
      );
    return stripIndexes(root.children);
  }
  formatProjectMapText(rootLabel, tree, map = {}) {
    const lines = [rootLabel];
    const append = (nodes, prefix = "") => {
      nodes.forEach((node, index) => {
        const last = index === nodes.length - 1;
        const branch = last ? "└─ " : "├─ ";
        if (node.type === "directory") {
          lines.push(`${prefix}${branch}${node.name}/`);
          append(node.children, `${prefix}${last ? "   " : "│  "}`);
          return;
        }
        const details = node.binary
          ? "binary · lines unavailable"
          : `${node.language} · ${node.lineCount === null ? "lines unavailable" : `${node.lineCount} ${node.lineCount === 1 ? "line" : "lines"}`}`;
        lines.push(`${prefix}${branch}${node.name} [${details}]`);
      });
    };
    append(tree);
    if (map.truncated) {
      lines.push(
        `\nMap truncated after ${map.maxFiles} files or depth ${map.maxDepth}. Use path to inspect a narrower directory.`,
      );
    }
    return lines.join("\n");
  }
  async searchProjectFiles(args = {}) {
    const root = this.editor?.fileExplorer?.rootPath;
    if (!root || !args.query)
      return { success: false, error: "Projet ou requête indisponible." };
    return this.editor.api.searchInFiles(root, args.query, {
      ...args,
      offset: args.offset,
      limit: args.limit,
    });
  }
  resolveWorkspacePath(filePath, rootPath) {
    if (typeof filePath !== "string" || typeof rootPath !== "string")
      return null;

    const root = AgentPath.normalize(rootPath);
    const candidate = AgentPath.isAbsolute(filePath)
      ? AgentPath.normalize(filePath)
      : AgentPath.normalize(`${root}/${filePath}`);
    const relative = AgentPath.relative(root, candidate);

    if (!relative || relative === ".") return candidate;
    if (relative.startsWith("..") || AgentPath.isAbsolute(relative))
      return null;
    return candidate;
  }
  markFileDiffHighlights(beforeText, afterText, file) {
    if (!file || !Array.isArray(file.lines)) return;

    const originalText =
      file.diffSnapshot === null ? beforeText : file.diffSnapshot;
    if (originalText === afterText) {
      for (const line of file.lines) {
        if (line && typeof line === "object") {
          line.diffState = null;
          line.diffSegments = [];
        }
      }
      file.diffSnapshot = null;
      file.diffActive = false;
      file.diffRows = [];
      return;
    }

    file.diffSnapshot = originalText;
    file.diffActive = true;
    file.diffRows = [];
    const beforeLines = originalText === "" ? [] : originalText.split(/\r?\n/);
    const afterLines = afterText === "" ? [] : afterText.split(/\r?\n/);
    const rows = beforeLines.length + 1;
    const cols = afterLines.length + 1;
    const lcs = Array.from({ length: rows }, () => Array(cols).fill(0));

    for (
      let beforeIndex = beforeLines.length - 1;
      beforeIndex >= 0;
      beforeIndex -= 1
    ) {
      for (
        let afterIndex = afterLines.length - 1;
        afterIndex >= 0;
        afterIndex -= 1
      ) {
        lcs[beforeIndex][afterIndex] =
          beforeLines[beforeIndex] === afterLines[afterIndex]
            ? lcs[beforeIndex + 1][afterIndex + 1] + 1
            : Math.max(
                lcs[beforeIndex + 1][afterIndex],
                lcs[beforeIndex][afterIndex + 1],
              );
      }
    }

    let beforeIndex = 0;
    let documentIndex = 0;
    let afterIndex = 0;
    while (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
      if (
        beforeIndex < beforeLines.length &&
        afterIndex < afterLines.length &&
        beforeLines[beforeIndex] === afterLines[afterIndex]
      ) {
        file.diffRows.push({
          type: "unchanged",
          text: afterLines[afterIndex],
          documentIndex,
        });
        beforeIndex += 1;
        afterIndex += 1;
        documentIndex += 1;
      } else if (
        beforeIndex < beforeLines.length &&
        (afterIndex >= afterLines.length ||
          lcs[beforeIndex + 1][afterIndex] >= lcs[beforeIndex][afterIndex + 1])
      ) {
        file.diffRows.push({
          type: "removed",
          text: beforeLines[beforeIndex],
          documentIndex: null,
        });
        beforeIndex += 1;
      } else {
        file.diffRows.push({
          type: "added",
          text: afterLines[afterIndex],
          documentIndex,
        });
        afterIndex += 1;
        documentIndex += 1;
      }
    }

    for (const line of file.lines) {
      if (line && typeof line === "object") {
        line.diffState = null;
        line.diffSegments = [];
      }
    }

    if (beforeText === afterText) {
      file.diffRows = [];
    }
  }
  validateActiveFileSyntax() {
    try {
      const editor = this.editor;
      const lineController = editor?.lineController;
      const file = editor?.tabManager?.activeFile;
      const source =
        typeof lineController?.getContent === "function"
          ? lineController.getContent()
          : "";
      if (!source.trim()) {
        return { valid: true, error: null };
      }
      const fileName = file?.path || file?.name || "";
      const extension = fileName.split(".").pop()?.toLowerCase() || "";
      const language = String(file?.language || "").toLowerCase();
      const isJavaScript =
        ["javascript", "js", "jsx", "mjs", "cjs"].includes(language) ||
        ["js", "jsx", "mjs", "cjs"].includes(extension);
      if (!isJavaScript) {
        return { valid: true, error: null };
      }
      new Function(`"use strict";\n${source}`);
      return { valid: true, error: null, fileName };
    } catch (error) {
      return {
        valid: false,
        error: error?.message || String(error),
      };
    }
  }
  async repairBrokenFileAfterEdit(args = {}, maxPasses = 3) {
    let currentArgs = args;
    let pass = 0;
    let lastResult = null;

    while (pass < maxPasses) {
      pass += 1;
      const result = await this.modifyActiveFile(currentArgs);
      if (!result?.success) {
        return {
          success: false,
          error: result?.error || { code: "EDIT_FAILED" },
        };
      }

      const validation = this.validateActiveFileSyntax();
      if (validation.valid) {
        lastResult = {
          success: true,
          result,
          validation,
          passes: pass,
        };
        break;
      }

      const errorMessage = validation.error;
      const fileContent = this.editor?.lineController?.getContent?.() || "";
      const snippet = (fileContent || "").slice(0, 4000);

      currentArgs = {
        ...currentArgs,
        oldText: snippet,
        newText: snippet,
      };

      if (
        typeof currentArgs.newText === "string" &&
        currentArgs.newText.includes(errorMessage)
      ) {
        break;
      }

      if (pass >= maxPasses) {
        return {
          success: false,
          error: {
            code: "SYNTAX_REPAIR_LIMIT_REACHED",
            message: errorMessage,
          },
        };
      }

      lastResult = {
        success: false,
        result,
        validation,
        passes: pass,
      };
    }

    return (
      lastResult || { success: false, error: { code: "NO_REPAIR_ATTEMPT" } }
    );
  }
  async modifyActiveFile(args = {}) {
    const editorReady = await this.waitForEditorReady();
    const file = this.editor?.tabManager?.activeFile;
    const writer = this.editor?.writerController;
    const lineController = this.editor?.lineController;
    if (!editorReady || !file || !writer?.replaceRange || !lineController) {
      return {
        success: false,
        error: {
          code: "EDITOR_NOT_READY",
          message:
            "L'éditeur n'est pas prêt pour une modification. Réessayez lorsque le fichier actif est chargé.",
        },
      };
    }

    await this.editor?.fileLoader?.waitForFileLoaded?.(file);

    const beforeText =
      typeof lineController.getContent === "function"
        ? lineController.getContent()
        : "";
    const cursorBefore = this.editor?.cursorController
      ? {
          row: this.editor.cursorController.row ?? 1,
          column: this.editor.cursorController.column ?? 0,
        }
      : null;
    const replacementText =
      typeof args.newText === "string"
        ? args.newText
        : typeof args.text === "string"
          ? args.text
          : "";
    const requestKey = JSON.stringify({
      oldText: typeof args.oldText === "string" ? args.oldText : null,
      newText: replacementText,
      startLine: args.startLine ?? null,
      startColumn: args.startColumn ?? null,
      endLine: args.endLine ?? null,
      endColumn: args.endColumn ?? null,
    });
    if (this.executedModificationRequests.has(requestKey)) {
      return {
        success: false,
        error: {
          code: "DUPLICATE_MODIFICATION",
          message: "Cette demande de modification a déjà été exécutée.",
        },
      };
    }
    const sourceText =
      typeof args.oldText === "string"
        ? args.oldText
        : typeof args.expectedText === "string"
          ? args.expectedText
          : "";
    if (
      sourceText.length > 0 &&
      replacementText.includes(`${sourceText}${sourceText}`)
    ) {
      return {
        success: false,
        error: {
          code: "SUSPECTED_DUPLICATION",
          message:
            "Le nouveau texte contient deux occurrences consécutives du texte remplacé. La modification est refusée.",
        },
      };
    }
    const hasTextMatch = typeof args.oldText === "string";
    const hasCoordinateFallback =
      Number.isInteger(args.startLine) &&
      Number.isInteger(args.startColumn) &&
      Number.isInteger(args.endLine) &&
      Number.isInteger(args.endColumn);
    const hasAnyCoordinate = [
      args.startLine,
      args.startColumn,
      args.endLine,
      args.endColumn,
    ].some((value) => value !== undefined);

    if (hasAnyCoordinate && !hasCoordinateFallback && !hasTextMatch) {
      return {
        success: false,
        error: {
          code: "INVALID_RANGE",
          message:
            "La plage est incomplète. Fournissez startLine, startColumn, endLine et endColumn, ou utilisez oldText/newText.",
        },
      };
    }

    let resolvedRange = null;

    if (hasTextMatch) {
      if (args.oldText.length === 0) {
        resolvedRange = {
          startLine: 1,
          startColumn: 0,
          endLine: 1,
          endColumn: 0,
          startIndex: 0,
          endIndex: 0,
          text: replacementText,
        };
      }
      const matches = [];
      let cursor = 0;
      while (
        args.oldText.length > 0 &&
        cursor <= beforeText.length - args.oldText.length
      ) {
        const index = beforeText.indexOf(args.oldText, cursor);
        if (index === -1) break;
        matches.push(index);
        cursor = index + args.oldText.length;
      }

      if (args.oldText.length > 0 && matches.length === 0) {
        if (!hasCoordinateFallback) {
          return {
            success: false,
            error: {
              code: "NO_MATCH",
              message: "Aucune occurrence exacte trouvée pour oldText.",
            },
          };
        }
      } else if (args.oldText.length > 0 && matches.length > 1) {
        return {
          success: false,
          error: {
            code: "AMBIGUOUS_MATCH",
            message:
              "oldText est présent plusieurs fois. Le remplacement est refusé pour éviter une corruption.",
            occurrences: matches.length,
          },
        };
      } else if (args.oldText.length > 0) {
        const startIndex = matches[0];
        const endIndex = startIndex + args.oldText.length;
        const startBefore = beforeText.slice(0, startIndex);
        const endBefore = beforeText.slice(0, endIndex);
        resolvedRange = {
          startLine: startBefore.split("\n").length,
          startColumn: startBefore.split("\n").pop().length,
          endLine: endBefore.split("\n").length,
          endColumn: endBefore.split("\n").pop().length,
          startIndex,
          endIndex,
          text: replacementText,
        };
      }
    }

    if (!resolvedRange && hasCoordinateFallback) {
      const strictRange = this.getStrictRange(beforeText, args);
      if (!strictRange.valid)
        return { success: false, error: strictRange.error };
      const adjustedRange =
        typeof args.expectedText === "string"
          ? this.adjustRangeForMissingIndentation(beforeText, args, strictRange)
          : strictRange;
      if (
        typeof args.expectedText !== "string" ||
        adjustedRange.actualText !== args.expectedText
      ) {
        return {
          success: false,
          error: {
            code: "CONTENT_MISMATCH",
            message:
              "Le contenu réel de la plage ne correspond pas à expectedText.",
            expectedText: args.expectedText ?? "",
            actualText: adjustedRange.actualText,
          },
        };
      }
      resolvedRange = { ...adjustedRange, text: replacementText };
    }

    if (
      !resolvedRange ||
      !Object.prototype.hasOwnProperty.call(resolvedRange, "text")
    ) {
      return {
        success: false,
        error: {
          code: "INVALID_REPLACEMENT",
          message:
            "Aucun remplacement valide n'a été fourni. Passez oldText/newText ou une plage de coordonnées valide.",
        },
      };
    }

    if (
      typeof args.expectedText === "string" &&
      beforeText.slice(resolvedRange.startIndex, resolvedRange.endIndex) !==
        args.expectedText
    ) {
      return {
        success: false,
        error: {
          code: "CONTENT_MISMATCH",
          message:
            "Le contenu réel de la plage ne correspond pas à expectedText.",
          expectedText: args.expectedText,
          actualText: beforeText.slice(
            resolvedRange.startIndex,
            resolvedRange.endIndex,
          ),
        },
      };
    }

    const afterText = `${beforeText.slice(0, resolvedRange.startIndex)}${resolvedRange.text}${beforeText.slice(resolvedRange.endIndex)}`;

    let replaceResult;
    try {
      replaceResult = writer.replaceRange(
        resolvedRange.text,
        resolvedRange.startLine,
        resolvedRange.startColumn,
        resolvedRange.endLine,
        resolvedRange.endColumn,
      );
    } catch (error) {
      this.restoreActiveFileSnapshot(beforeText);
      return {
        success: false,
        error: {
          code: "WRITE_FAILED",
          message:
            error?.message || "Le remplacement a provoqué une exception.",
        },
      };
    }

    if (!replaceResult) {
      this.restoreActiveFileSnapshot(beforeText);
      return {
        success: false,
        error: {
          code: "WRITE_FAILED",
          message: "Le remplacement n'a pas été appliqué.",
        },
      };
    }

    const writtenText =
      typeof lineController.getContent === "function"
        ? lineController.getContent()
        : "";
    if (writtenText !== afterText) {
      if (typeof lineController.loadContent === "function") {
        lineController.loadContent(beforeText);
      }
      return {
        success: false,
        error: {
          code: "MODIFICATION_VERIFICATION_FAILED",
          message:
            "Le remplacement n'a pas été vérifié dans le fichier. La modification a été annulée.",
          expectedText: afterText,
          actualText: writtenText,
        },
      };
    }

    this.markFileDiffHighlights(beforeText, afterText, file);
    if (typeof lineController.refresh === "function") {
      lineController.refresh(true);
    }
    file.setIsSaved(false);
    const result = {
      success: true,
      operation: "replace",
      path: this.toProjectRelativePath(
        file.path,
        this.editor?.fileExplorer?.rootPath,
      ),
      range: {
        startLine: resolvedRange.startLine,
        startColumn: resolvedRange.startColumn,
        endLine: resolvedRange.endLine,
        endColumn: resolvedRange.endColumn,
      },
      beforeText,
      afterText,
      cursorBefore,
      match: hasTextMatch ? "exact" : "coordinates",
    };
    this.executedModificationRequests.set(requestKey, result);
    return result;
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { Agent, AgentPath };
}
