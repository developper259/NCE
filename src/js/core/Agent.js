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
    this.largeFileWriting = {
      recommendedChunkCharacters: 10000,
      maxChunkCharacters: 12000,
      maxRecoveryAttempts: 2,
    };
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
      warmIterations: 6,
      maxPreviouslyReadFiles: 100,
      softLimitRatio: 0.4,
      hardLimitRatio: 0.7,
      criticalLimitRatio: 0.85,
      safetyMarginTokens: 8192,
      charsPerToken: 4,
      logMetrics: true,
      debugDecisions: false,
    };
    this.lastContextMetrics = null;
    this.lastRunMetrics = null;
    this.cumulativeEstimatedPromptTokens = 0;
    this.cumulativeActualPromptTokens = 0;
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
    this.largeWriteState = null;
    this.fileKnowledge = new FileKnowledge(this);
    this.toolSerialization = new ToolSerialization(this);
    this.toolRegistry = new ToolRegistry(this);
    this.toolExecutor = new ToolExecutor(this);
    this.contextManager = new ContextManager(this);
    this.modelClient = new ModelClient(this);
    this.agentProgress = new AgentProgress(this);
    this.agentRunner = new AgentRunner(this);
    this.largeFileWriter = new LargeFileWriter(this);
    this.fileContextManager = new FileContextManager(this);
    this.workspaceFileManager = new WorkspaceFileManager(this);
    this.activeFileManager = new ActiveFileManager(this);
    this.projectExplorer = new ProjectExplorer(this);
    this.editorToolRegistry = new EditorToolRegistry(this);
    this.tools = this.toolRegistry.tools;
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
  debugTool(...args) {
    return this.toolExecutor.debugTool(...args);
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
    if (
      config.largeFileWriting &&
      typeof config.largeFileWriting === "object"
    ) {
      const largeFileWriting = config.largeFileWriting;
      if (Number.isFinite(largeFileWriting.recommendedChunkCharacters)) {
        this.largeFileWriting.recommendedChunkCharacters = Math.max(
          1000,
          Math.floor(largeFileWriting.recommendedChunkCharacters),
        );
      }
      if (Number.isFinite(largeFileWriting.maxChunkCharacters)) {
        this.largeFileWriting.maxChunkCharacters = Math.max(
          this.largeFileWriting.recommendedChunkCharacters,
          Math.floor(largeFileWriting.maxChunkCharacters),
        );
      }
      if (Number.isFinite(largeFileWriting.maxRecoveryAttempts)) {
        this.largeFileWriting.maxRecoveryAttempts = Math.max(
          0,
          Math.floor(largeFileWriting.maxRecoveryAttempts),
        );
      }
      this.updateLargeFileToolDefinitions();
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
  registerTool(...args) {
    return this.toolRegistry.registerTool(...args);
  }
  unregisterTool(...args) {
    return this.toolRegistry.unregisterTool(...args);
  }
  getTool(...args) {
    return this.toolRegistry.getTool(...args);
  }
  validateTool(...args) {
    return this.toolRegistry.validateTool(...args);
  }
  createRunConfig(...args) {
    return this.agentRunner.createRunConfig(...args);
  }

  async execute(...args) {
    return this.agentRunner.execute(...args);
  }
  run(...args) {
    return this.agentRunner.run(...args);
  }
  stop(...args) {
    return this.agentRunner.stop(...args);
  }

  detectModificationIntent(...args) {
    return this.agentRunner.detectModificationIntent(...args);
  }

  requestsFullCodeResponse(...args) {
    return this.agentRunner.requestsFullCodeResponse(...args);
  }

  isLikelyFullFileDump(...args) {
    return this.agentRunner.isLikelyFullFileDump(...args);
  }

  buildSuccessfulWriteFallback(...args) {
    return this.agentRunner.buildSuccessfulWriteFallback(...args);
  }

  assertRunActive(...args) {
    return this.agentRunner.assertRunActive(...args);
  }

  createModelOutputContext(...args) {
    return this.agentRunner.createModelOutputContext(...args);
  }

  normalizeModelOutput(...args) {
    return this.agentRunner.normalizeModelOutput(...args);
  }

  emitModelOutput(...args) {
    return this.agentRunner.emitModelOutput(...args);
  }

  resolveToolChoice(...args) {
    return this.agentRunner.resolveToolChoice(...args);
  }

  normalizeFinishReason(...args) {
    return this.agentRunner.normalizeFinishReason(...args);
  }

  evaluateIterationOutcome(...args) {
    return this.agentRunner.evaluateIterationOutcome(...args);
  }

  debugIterationDecision(...args) {
    return this.agentRunner.debugIterationDecision(...args);
  }

  createIncompleteGenerationError(...args) {
    return this.agentRunner.createIncompleteGenerationError(...args);
  }

  createIterationFailure(...args) {
    return this.agentRunner.createIterationFailure(...args);
  }

  createMaxIterationsError(...args) {
    return this.agentRunner.createMaxIterationsError(...args);
  }

  appendIncompleteContinuation(...args) {
    return this.agentRunner.appendIncompleteContinuation(...args);
  }

  toolResultConfirmsValidation(...args) {
    return this.agentRunner.toolResultConfirmsValidation(...args);
  }

  createLargeWriteRuntimeState(...args) {
    return this.largeFileWriter.createLargeWriteRuntimeState(...args);
  }
  getLargeWriteContextState(...args) {
    return this.largeFileWriter.getLargeWriteContextState(...args);
  }
  debugLargeWrite(...args) {
    return this.largeFileWriter.debugLargeWrite(...args);
  }
  extractTruncatedLargeWritePath(...args) {
    return this.largeFileWriter.extractTruncatedLargeWritePath(...args);
  }
  activateLargeWriteRecovery(...args) {
    return this.largeFileWriter.activateLargeWriteRecovery(...args);
  }
  pathsReferToSameFile(...args) {
    return this.largeFileWriter.pathsReferToSameFile(...args);
  }
  getLargeWriteExpectedAction(...args) {
    return this.largeFileWriter.getLargeWriteExpectedAction(...args);
  }
  selectLargeWriteToolCall(...args) {
    return this.largeFileWriter.selectLargeWriteToolCall(...args);
  }
  buildLargeWriteActionInstruction(...args) {
    return this.largeFileWriter.buildLargeWriteActionInstruction(...args);
  }
  createLargeWriteProtocolError(...args) {
    return this.largeFileWriter.createLargeWriteProtocolError(...args);
  }
  updateLargeWriteStateAfterTool(...args) {
    return this.largeFileWriter.updateLargeWriteStateAfterTool(...args);
  }
  async runLoop(...args) {
    return this.agentRunner.runLoop(...args);
  }

  async requestModel(...args) {
    return this.modelClient.requestModel(...args);
  }
  async requestSingleModel(...args) {
    return this.modelClient.requestSingleModel(...args);
  }
  isPlainObject(...args) {
    return this.toolSerialization.isPlainObject(...args);
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

  assertJsonSafeArguments(...args) {
    return this.toolSerialization.assertJsonSafeArguments(...args);
  }
  parseCanonicalToolArguments(...args) {
    return this.toolSerialization.parseCanonicalToolArguments(...args);
  }
  createToolCallValidationError(toolCall, toolCallIndex, reason, context = {}) {
    return createToolCallValidationError(
      this,
      toolCall,
      toolCallIndex,
      reason,
      context,
    );
  }

  isRecoverableLargeWriteToolCallError(error, result = null) {
    if (error?.code !== "TOOL_CALL_FINALIZATION_FAILED") return false;
    if (!new Set(["create_file", "write_file_chunk"]).has(error.toolName)) {
      return false;
    }
    const reason = String(error.reason || error.message || "");
    const message = result?.choices?.[0]?.message || result?.message;
    const finishReason = this.normalizeFinishReason(result, message, []);
    const explicitlyTruncatedJson =
      /unterminated string|unexpected end(?: of json)?|end of (?:json )?input|json[^\n]{0,30}(?:incomplete|truncated)|incomplete json/i.test(
        reason,
      );
    const stopsBeforeObjectEnd =
      error.valueType === "string" && error.argumentsLastCharacter !== "}";
    const likelyTruncatedAtPosition =
      stopsBeforeObjectEnd &&
      /expected[^\n]{0,80}(?:property|delimiter|comma|position|end)/i.test(
        reason,
      );
    const truncatedJson =
      explicitlyTruncatedJson ||
      likelyTruncatedAtPosition ||
      (finishReason === "length" && stopsBeforeObjectEnd);
    if (!truncatedJson) return false;
    error.finishReason = finishReason;
    error.category = "LARGE_WRITE_TRUNCATED";
    error.largeWriteTruncated = true;
    return true;
  }

  buildLargeWriteRecoveryInstruction(toolName = "create_file", state = null) {
    const chunkLimit =
      state?.maxChunkChars || this.largeFileWriting.recommendedChunkCharacters;
    const target = state?.path ? ` Target: ${state.path}.` : "";
    const nextTool = state?.firstChunkCreated
      ? "Call write_file_chunk now with the next chunk and the last returned revision."
      : "Call create_file now with the first chunk only.";
    return `LARGE_WRITE_REQUIRED:${target} The previous ${toolName} call was truncated because it was too large. Chunking is now mandatory; do not reconsider or explain the strategy. ${nextTool} Then use write_file_chunk for every remaining chunk, keep each content chunk <= ${chunkLimit} characters, and finish with read_file validation. Do not retry the full file and do not repeat previous reads or searches.`;
  }

  createLargeWriteRecoveryError(cause, attempts, limit) {
    const error = new Error(
      `La création du gros fichier a été arrêtée après ${attempts} tentatives de récupération : le modèle continue à produire un appel ${cause?.toolName || "d'écriture"} tronqué.`,
    );
    error.name = "AgentLargeWriteRecoveryError";
    error.code = "LARGE_WRITE_RECOVERY_EXHAUSTED";
    error.category = "LARGE_WRITE_RECOVERY_EXHAUSTED";
    error.toolName = cause?.toolName || null;
    error.attempts = attempts;
    error.maxRecoveryAttempts = limit;
    error.cause = cause;
    error.userMessage =
      "Le modèle n'a pas réussi à découper la création du gros fichier en appels valides.";
    return error;
  }

  finalizeToolCall(...args) {
    return this.toolSerialization.finalizeToolCall(...args);
  }
  finalizeToolCalls(...args) {
    return this.toolSerialization.finalizeToolCalls(...args);
  }
  createMessageSerializationError(
    messageIndex,
    toolCallIndex,
    field,
    value,
    reason,
    details = {},
  ) {
    return createMessageSerializationError(
      this,
      messageIndex,
      toolCallIndex,
      field,
      value,
      reason,
      details,
    );
  }
  normalizeToolArgumentsForProvider(...args) {
    return this.toolSerialization.normalizeToolArgumentsForProvider(...args);
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
            this.normalizeToolResultForHistory(key, `${path}.key`, seen) ??
              null,
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
      const error = new TypeError(
        `${path} contient un objet complexe non pris en charge`,
      );
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

  normalizeToolContentForProvider(...args) {
    return this.contextManager.normalizeToolContentForProvider(...args);
  }
  getContextCompactionConfig(...args) {
    return this.contextManager.getContextCompactionConfig(...args);
  }
  estimateTokens(...args) {
    return this.contextManager.estimateTokens(...args);
  }
  parseContextJSON(...args) {
    return this.contextManager.parseContextJSON(...args);
  }
  getContextToolMetadata(...args) {
    return this.contextManager.getContextToolMetadata(...args);
  }
  groupModelContextEntries(...args) {
    return this.contextManager.groupModelContextEntries(...args);
  }
  compactToolResultForModel(...args) {
    return this.contextManager.compactToolResultForModel(...args);
  }
  compactWriteToolCallForModel(...args) {
    return this.contextManager.compactWriteToolCallForModel(...args);
  }
  getContextBudget(...args) {
    return this.contextManager.getContextBudget(...args);
  }
  getContextTokenBreakdown(...args) {
    return this.contextManager.getContextTokenBreakdown(...args);
  }
  buildModelContext(...args) {
    return this.contextManager.buildModelContext(...args);
  }
  normalizeMessagesForProvider(...args) {
    return this.contextManager.normalizeMessagesForProvider(...args);
  }
  debugToolMessage(toolCall, messageIndex, context = {}) {
    console.debug("[NCE Tool Message]", {
      toolName: toolCall.function.name,
      toolCallId: toolCall.id,
      argumentsType: typeof toolCall.function.arguments,
      argumentsPreview: this.getSafeValuePreview(toolCall.function.arguments),
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
          : JSON.stringify(this.normalizeToolResultForHistory(result) ?? null),
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
  recordModelPromptUsage(result) {
    const usage = result?.usage || result?.data?.usage || null;
    const actualPromptTokens = Number(
      usage?.prompt_tokens ?? usage?.input_tokens ?? usage?.promptTokens,
    );
    if (Number.isFinite(actualPromptTokens) && actualPromptTokens >= 0) {
      this.cumulativeActualPromptTokens += actualPromptTokens;
    }
    if (this.lastContextMetrics) {
      this.lastContextMetrics.actualPromptTokens = Number.isFinite(
        actualPromptTokens,
      )
        ? actualPromptTokens
        : null;
      this.lastContextMetrics.cumulativeEstimatedPromptTokens =
        this.cumulativeEstimatedPromptTokens;
      this.lastContextMetrics.cumulativeActualPromptTokens =
        this.cumulativeActualPromptTokens;
      if (this.contextCompaction.logMetrics) {
        console.info("[NCE Agent context usage]", {
          estimatedPromptTokens: this.lastContextMetrics.estimatedModelTokens,
          actualPromptTokens: this.lastContextMetrics.actualPromptTokens,
          cumulativeEstimatedPromptTokens: this.cumulativeEstimatedPromptTokens,
          cumulativeActualPromptTokens: this.cumulativeActualPromptTokens,
        });
      }
    }
    return result;
  }
  getModelRequestState(...args) {
    return this.modelClient.getModelRequestState(...args);
  }
  getHeaderValue(...args) {
    return this.modelClient.getHeaderValue(...args);
  }
  parseRetryAfterMs(...args) {
    return this.modelClient.parseRetryAfterMs(...args);
  }
  classifyModelError(...args) {
    return this.modelClient.classifyModelError(...args);
  }
  getModelRetryDelay(classified, retryCount) {
    if (Number.isFinite(classified?.retryAfterMs)) {
      return Math.max(0, classified.retryAfterMs);
    }
    const exponentialDelay = 1000 * 2 ** Math.max(0, retryCount || 0);
    return exponentialDelay + Math.floor(Math.random() * 251);
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
      [
        "AUTH_ERROR",
        "PERMISSION_ERROR",
        "QUOTA_EXCEEDED",
        "QUOTA_EXHAUSTED",
        "CREDITS_EXHAUSTED",
      ].includes(classified.category) &&
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
      const candidateProviderId = candidate.provider || candidate.providerId;
      const key = `${candidateProviderId}:${candidate.model}`;
      if (state.triedCandidates.has(key) || state.unhealthyModels.has(key)) {
        continue;
      }
      if (state.blockedProviders?.has(candidateProviderId)) continue;
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
  forceLargeWriteModelFallback(runConfig, largeWrite, cause = null) {
    const requestState = this.getModelRequestState(runConfig);
    const current = requestState.currentConfig || runConfig;
    const classified = {
      category: "LARGE_WRITE_PROTOCOL_FAILED",
      code: "LARGE_WRITE_PROTOCOL_FAILED",
      retryable: false,
      fallbackRecommended: true,
      provider: current.providerId,
      configuredProvider: current.providerId,
      upstreamProvider: null,
      model: current.model,
      statusCode: null,
      technicalMessage: cause?.message || "Large write protocol failed",
      userMessage: `${this.getModelDisplayName(current)} n'a pas respecté le protocole d'écriture progressive.`,
    };
    const fallback = this.takeNextFallback(requestState, classified, runConfig);
    if (!fallback) return false;
    requestState.unhealthyModels.add(`${current.providerId}:${current.model}`);
    requestState.currentConfig = fallback;
    requestState.modelFallbackCount += 1;
    this.applyActiveModelConfig(runConfig, fallback);
    largeWrite.fallbackCount += 1;
    this.emitModelStatus(
      {
        kind: "fallback",
        classification: classified,
        fromProvider: current.providerId,
        fromModel: current.model,
        toProvider: fallback.providerId,
        toModel: fallback.model,
        userMessage: `${this.getModelDisplayName(current)} n'a pas respecté le chunking. Basculement vers ${this.getModelDisplayName(fallback)}…`,
      },
      runConfig,
    );
    this.debugLargeWrite(largeWrite, "fallback", {
      fromModel: current.model,
      toModel: fallback.model,
    });
    return true;
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
      "maxOutputTokens",
      "maxTokens",
      "modelConfig",
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
  getModelDisplayName(...args) {
    return this.modelClient.getModelDisplayName(...args);
  }
  emitModelStatus(...args) {
    return this.modelClient.emitModelStatus(...args);
  }
  debugModelError(...args) {
    return this.modelClient.debugModelError(...args);
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
  getOpenAITools(...args) {
    return this.toolRegistry.getOpenAITools(...args);
  }
  async executeToolCall(...args) {
    return this.toolExecutor.executeToolCall(...args);
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
          this.createToolResultMessage(message.tool_call_id, message.content, {
            contentIsSerialized: typeof message.content === "string",
          }),
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
  getContentRevision(...args) {
    return this.fileContextManager.getContentRevision(...args);
  }
  createFileReadContext(...args) {
    return this.fileContextManager.createFileReadContext(...args);
  }
  validateFileReadContext(...args) {
    return this.fileContextManager.validateFileReadContext(...args);
  }
  buildModificationVerification(...args) {
    return this.fileContextManager.buildModificationVerification(...args);
  }
  normalizeLineEndingsWithBoundaries(...args) {
    return this.fileContextManager.normalizeLineEndingsWithBoundaries(...args);
  }
  findUniqueTextMatch(...args) {
    return this.fileContextManager.findUniqueTextMatch(...args);
  }
  selectMatchNearLine(...args) {
    return this.fileContextManager.selectMatchNearLine(...args);
  }
  adaptReplacementLineEndings(...args) {
    return this.fileContextManager.adaptReplacementLineEndings(...args);
  }
  limitResult(...args) {
    return this.toolExecutor.limitResult(...args);
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
  async waitForEditorReady(...args) {
    return this.fileContextManager.waitForEditorReady(...args);
  }
  lineColumnToIndex(...args) {
    return this.fileContextManager.lineColumnToIndex(...args);
  }
  getStrictRange(...args) {
    return this.fileContextManager.getStrictRange(...args);
  }
  adjustRangeForMissingIndentation(...args) {
    return this.fileContextManager.adjustRangeForMissingIndentation(...args);
  }
  toProjectRelativePath(...args) {
    return this.fileContextManager.toProjectRelativePath(...args);
  }

  getCreateFileToolDescription(...args) {
    return this.editorToolRegistry.getCreateFileToolDescription(...args);
  }

  getWriteFileChunkToolDescription(...args) {
    return this.editorToolRegistry.getWriteFileChunkToolDescription(...args);
  }

  updateLargeFileToolDefinitions(...args) {
    return this.editorToolRegistry.updateLargeFileToolDefinitions(...args);
  }

  registerEditorTools(...args) {
    return this.editorToolRegistry.registerEditorTools(...args);
  }
  shouldPersistAgentEdit(...args) {
    return this.workspaceFileManager.shouldPersistAgentEdit(...args);
  }
  getWorkspaceFileTarget(...args) {
    return this.workspaceFileManager.getWorkspaceFileTarget(...args);
  }
  getFileOperationError(...args) {
    return this.workspaceFileManager.getFileOperationError(...args);
  }
  async refreshWorkspaceFolders(...args) {
    return this.workspaceFileManager.refreshWorkspaceFolders(...args);
  }
  async createWorkspaceFile(...args) {
    return this.workspaceFileManager.createWorkspaceFile(...args);
  }
  async writeWorkspaceFileChunk(...args) {
    return this.workspaceFileManager.writeWorkspaceFileChunk(...args);
  }
  async renameWorkspaceFile(...args) {
    return this.workspaceFileManager.renameWorkspaceFile(...args);
  }
  async readSelection(...args) {
    return this.activeFileManager.readSelection(...args);
  }
  async replaceText(...args) {
    return this.activeFileManager.replaceText(...args);
  }
  async modifyFile(...args) {
    return this.workspaceFileManager.modifyFile(...args);
  }
  restoreActiveFileSnapshot(...args) {
    return this.activeFileManager.restoreActiveFileSnapshot(...args);
  }
  async readActiveFile(...args) {
    return this.activeFileManager.readActiveFile(...args);
  }
  async searchActiveFile(...args) {
    return this.activeFileManager.searchActiveFile(...args);
  }
  async readFile(...args) {
    return this.workspaceFileManager.readFile(...args);
  }
  async listProjectFiles(...args) {
    return this.workspaceFileManager.listProjectFiles(...args);
  }
  async getProjectMap(...args) {
    return this.projectExplorer.getProjectMap(...args);
  }
  async addProjectMapLanguages(...args) {
    return this.projectExplorer.addProjectMapLanguages(...args);
  }
  getProjectMapExtension(...args) {
    return this.projectExplorer.getProjectMapExtension(...args);
  }
  async detectProjectMapLanguage(...args) {
    return this.projectExplorer.detectProjectMapLanguage(...args);
  }
  buildProjectMapTree(...args) {
    return this.projectExplorer.buildProjectMapTree(...args);
  }
  formatProjectMapText(...args) {
    return this.projectExplorer.formatProjectMapText(...args);
  }
  async searchProjectFiles(...args) {
    return this.projectExplorer.searchProjectFiles(...args);
  }
  resolveWorkspacePath(...args) {
    return this.workspaceFileManager.resolveWorkspacePath(...args);
  }
  markFileDiffHighlights(...args) {
    return this.activeFileManager.markFileDiffHighlights(...args);
  }
  validateActiveFileSyntax(...args) {
    return this.activeFileManager.validateActiveFileSyntax(...args);
  }
  async repairBrokenFileAfterEdit(...args) {
    return this.activeFileManager.repairBrokenFileAfterEdit(...args);
  }
  async modifyActiveFile(...args) {
    return this.activeFileManager.modifyActiveFile(...args);
  }
}

window.Agent = Agent;
