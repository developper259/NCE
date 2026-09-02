class AgentRunner {
  constructor(agent) {
    this.agent = agent;
  }

  createRunConfig(overrides = {}) {
    const provider = this.agent.provider ? { ...this.agent.provider } : null;
    const providerId =
      overrides.providerId ||
      (provider && typeof provider.id === "string" ? provider.id : null) ||
      this.agent.runConfig?.providerId ||
      "unknown";
    const config = {
      sessionId: overrides.sessionId ?? this.agent.currentSessionId ?? null,
      runId: overrides.runId ?? this.agent.runId,
      agentId: overrides.agentId ?? this.agent.agentId,
      providerId,
      provider: provider ? { ...provider } : null,
      model: overrides.model ?? this.agent.model,
      temperature: Number.isFinite(this.agent.temperature)
        ? this.agent.temperature
        : undefined,
      maxTokens: Number.isFinite(this.agent.maxTokens) ? this.agent.maxTokens : undefined,
      maxIterations: Number.isFinite(this.agent.maxIterations)
        ? this.agent.maxIterations
        : undefined,
      maxIncompleteContinuations: Number.isFinite(
        this.agent.maxIncompleteContinuations,
      )
        ? this.agent.maxIncompleteContinuations
        : undefined,
      largeFileWriting: { ...this.agent.largeFileWriting },
      permissions: this.agent.permissions || "read",
      systemPrompt: this.agent.systemPrompt || "",
      modelFamily: this.agent.modelFamily,
      modelConfig: this.agent.modelConfig ? { ...this.agent.modelConfig } : null,
      contextWindow: this.agent.contextWindow,
      maxOutputTokens: Number.isFinite(this.agent.modelConfig?.maxOutputTokens)
        ? this.agent.modelConfig.maxOutputTokens
        : null,
      contextCompaction: { ...this.agent.contextCompaction },
      supportsTools: this.agent.supportsTools && provider?.supportsTools !== false,
      supportsToolChoice:
        this.agent.supportsToolChoice && provider?.supportsToolChoice !== false,
      fallbackChain: this.agent.fallbackChain.map((candidate) => ({ ...candidate })),
      maxProviderRetries: this.agent.maxProviderRetries,
      maxModelFallbacks: this.agent.maxModelFallbacks,
      maxRetryDelayMs: this.agent.maxRetryDelayMs,
    };
    return config;
  }

  async execute(userMessage, options = {}) {
    if (this.agent.isRunning && !this.agent.stopRequested)
      throw new Error("Un agent est déjà en cours d'exécution.");
    if (typeof userMessage !== "string" || !userMessage.trim())
      throw new TypeError("Le message utilisateur est obligatoire.");
    this.agent.isRunning = true;
    this.agent.stopRequested = false;
    this.agent.abortController = new AbortController();
    const runId = ++this.agent.runId;
    const controller = this.agent.abortController;
    const runContext = { sessionId: options.sessionId || null, runId };
    this.agent.currentSessionId = runContext.sessionId;
    const runConfig = this.agent.createRunConfig({
      sessionId: runContext.sessionId,
      runId,
      agentId: options.agentId || null,
      providerId: options.providerId || this.agent.provider?.id || null,
      model: this.agent.model,
    });
    this.agent.runConfig = runConfig;
    this.agent.executedToolCalls = new Map();
    this.agent.executedModificationRequests = new Map();
    this.agent.readFileContexts = new Map();
    this.agent.fileContextVersion = 0;
    this.agent.readAfterFailurePaths = new Set();
    this.agent.fileKnowledge.reset();
    this.agent.modelRequestState = null;
    this.agent.modelRequestCounter = 0;
    this.agent.modelOutputStates = new Map();
    this.agent.largeWriteState = null;
    this.agent.lastContextMetrics = null;
    this.agent.cumulativeEstimatedPromptTokens = 0;
    this.agent.cumulativeActualPromptTokens = 0;
    try {
      const editorContext = await this.agent.getContext();
      runConfig.editorContext = editorContext;
      this.agent.messages = [
        {
          role: "system",
          content: this.agent.buildSystemMessage(
            editorContext,
            runConfig.systemPrompt,
          ),
        },
      ];
      const modificationHint = this.agent.detectModificationIntent(userMessage);
      const requiresModification =
        runConfig.permissions === "code" && modificationHint;
      this.agent.agentProgress.reset({ requiresModification });
      if (modificationHint) {
        this.agent.messages.push({
          role: "system",
          content:
            "PRIORITÉ: cette requête nécessite une modification du projet. Utilise un outil de modification si possible et réponds avec le résultat réel de la modification.",
        });
      }
      this.agent.appendHistory(options.history);
      this.agent.messages.push({ role: "user", content: userMessage });
      const result = await this.agent.runLoop(runId, controller, runConfig, {
        requiresModification,
        allowsFullCodeResponse: this.agent.requestsFullCodeResponse(userMessage),
      });
      result.metrics = this.agent.agentProgress.getMetrics();
      this.agent.lastRunMetrics = result.metrics;
      this.agent.callbacks.onFinish?.(result, runContext);
      return result;
    } catch (error) {
      this.agent.lastRunMetrics = this.agent.agentProgress.getMetrics();
      if (!this.agent.isAbortError(error) && runId === this.agent.runId)
        this.agent.callbacks.onError?.(error, runContext);
      throw error;
    } finally {
      if (runId === this.agent.runId) {
        this.agent.largeWriteState = null;
        this.agent.isRunning = false;
        this.agent.abortController = null;
        this.agent.currentSessionId = null;
        this.agent.runConfig = null;
      }
    }
  }

  run(userMessage, options = {}) {
    return this.agent.execute(userMessage, options);
  }

  stop() {
    this.agent.stopRequested = true;
    if (this.agent.largeWriteState?.active) {
      this.agent.largeWriteState.active = false;
      this.agent.largeWriteState.state = "ABORTED";
      this.agent.largeWriteState.decision = "fail";
    }
    this.agent.abortController?.abort();
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

  assertRunActive(runId, controller = this.agent.abortController) {
    if (
      this.agent.stopRequested ||
      runId !== this.agent.runId ||
      controller?.signal?.aborted
    ) {
      throw this.agent.abortError();
    }
  }

  createModelOutputContext(runId, phase = "main") {
    this.agent.modelRequestCounter += 1;
    return {
      sessionId: this.agent.currentSessionId,
      runId,
      requestId: `${runId}:${phase}:${this.agent.modelRequestCounter}`,
    };
  }

  normalizeModelOutput(value, context = {}, mode = "snapshot") {
    if (typeof value !== "string" || !value) {
      return { delta: "", fullText: "", reset: false, revision: 0 };
    }
    const channel = context.channel || "text";
    const requestId = context.requestId || "legacy";
    const key = `${context.runId ?? ""}:${requestId}:${channel}`;
    let state = this.agent.modelOutputStates.get(key);
    if (!state) {
      state = { fullText: "", revision: 0 };
      this.agent.modelOutputStates.set(key, state);
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
    this.agent.assertRunActive(context.runId);
    const normalized = this.agent.normalizeModelOutput(
      value,
      { ...context, channel },
      mode,
    );
    if (!normalized.delta && !normalized.reset) return;
    const callback =
      channel === "reasoning"
        ? this.agent.callbacks.onReasoning
        : this.agent.callbacks.onToken;
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
    if (
      toolCalls.length > 0 ||
      ["tool_calls", "function_call"].includes(reason)
    ) {
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
    if (
      ["stop", "end_turn", "stop_sequence", "eos", "eos_token", "end"].includes(
        reason,
      )
    ) {
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
    requiresExplicitCompletion = false,
    taskComplete = false,
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
    if (requiresExplicitCompletion && !taskComplete) {
      return { action: "continue", reason: "task_not_complete" };
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
      this.agent.messages.push({ role: "assistant", content: parsed.text });
    }
    this.agent.messages.push({
      role: "system",
      content:
        decisionReason === "reasoning_without_final_text"
          ? "Continue l'exécution. Tu as produit un raisonnement intermédiaire sans action ni réponse finale. Ne répète pas les étapes déjà effectuées."
          : decisionReason === "post_write_validation_pending"
            ? "Continue l'exécution. Une modification a réussi mais sa validation reste incomplète. Relis le fichier concerné et vérifie le résultat réel avant de répondre."
            : decisionReason === "task_not_complete"
              ? "[NCE TASK COMPLETION] The task has not been marked complete. Continue from the current state. Implement or validate what remains, then call task_complete only when the requested work is actually finished."
            : "Continue la tâche à partir de l'état actuel. La génération précédente s'est terminée avant sa finalisation. Ne répète pas les étapes déjà effectuées et utilise les tools nécessaires.",
    });
  }

  validateTaskCompletion({
    requiresModification = false,
    successfulWriteCount = 0,
    validationPending = false,
    unresolvedWriteFailure = false,
    unresolvedValidationFailure = false,
  } = {}) {
    if (requiresModification && successfulWriteCount === 0) {
      return {
        accepted: false,
        reason: "required_write_missing",
        message:
          "La tâche demande une modification du workspace, mais aucune écriture n'a encore réussi.",
      };
    }
    if (unresolvedWriteFailure) {
      return {
        accepted: false,
        reason: "write_failure_unresolved",
        message:
          "Un échec d'écriture reste non résolu. Corrige-le avant de terminer.",
      };
    }
    if (unresolvedValidationFailure || validationPending) {
      return {
        accepted: false,
        reason: "validation_unresolved",
        message:
          "Une validation requise ou un échec de validation reste non résolu.",
      };
    }
    return { accepted: true, reason: "task_complete" };
  }

  buildTaskCompletionResponse(completion = {}, fallback = "") {
    const summary = String(completion.summary || fallback || "Tâche terminée.").trim();
    const validation = String(completion.validation || "").trim();
    return validation ? `${summary}\n\nValidation : ${validation}` : summary;
  }

  clearProgressDirectives() {
    this.agent.messages = this.agent.messages.filter(
      (message) => {
        if (message?.role !== "system") return true;
        const content = String(message.content || "");
        return !(
          content.startsWith("[NCE PROGRESS DIRECTIVE]") ||
          content.startsWith("[NCE TASK COMPLETION]")
        );
      },
    );
  }

  toolResultConfirmsValidation(toolPayload) {
    return toolPayload?.verification?.verified === true;
  }

  async runLoop(runId, controller, runConfig = this.agent.runConfig, runState = {}) {
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
    let unresolvedWriteFailure = false;
    let unresolvedValidationFailure = false;
    const requiresExplicitCompletion =
      runConfig?.permissions === "code" &&
      runConfig?.supportsTools !== false &&
      this.agent.getTool("task_complete")?.enabled === true;
    runState.taskComplete = false;
    const largeWrite = this.agent.createLargeWriteRuntimeState(
      runConfig,
      runState.largeWrite,
    );
    runState.largeWrite = largeWrite;
    runState.progress = this.agent.agentProgress;
    this.agent.largeWriteState = largeWrite;
    const pendingValidationPaths = new Set();
    const maxIterations = runConfig?.maxIterations ?? this.agent.maxIterations;
    const maxIncompleteContinuations =
      runConfig?.maxIncompleteContinuations ?? this.agent.maxIncompleteContinuations;
    const maxLargeWriteRecoveryAttempts =
      runConfig?.largeFileWriting?.maxRecoveryAttempts ??
      this.agent.largeFileWriting.maxRecoveryAttempts;
    const writeTools = new Set([
      "modify_file",
      "create_file",
      "write_file_chunk",
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
    try {
      while (true) {
        const iteration = toolIterations + 1;
        modelTurn += 1;
        this.agent.fileKnowledge.setIteration(iteration);
        this.agent.assertRunActive(runId, controller);
        runConfig.contextState = {
          writesSucceeded: successfulWriteCount,
          successfulWrites: successfulWrites.map((write) => ({ ...write })),
          pendingValidation: validationPending,
          pendingValidationPaths: [...pendingValidationPaths],
          taskComplete: runState.taskComplete,
          requiresExplicitCompletion,
          lastModificationError:
            failedModifications[failedModifications.length - 1] || null,
          largeWrite: this.agent.getLargeWriteContextState(largeWrite),
          fileKnowledge: this.agent.fileKnowledge.getContextState(),
          progress: this.agent.agentProgress.getContextState(),
        };
        const outputContext = this.agent.createModelOutputContext(runId, "main");
        this.agent.agentProgress.recordModelRequest();
        const modelResponse = await this.agent.requestModel(controller, runConfig);
        this.agent.assertRunActive(runId, controller);
        let parsed;
        try {
          parsed = this.agent.parseResponse(modelResponse, {
            source: "provider_response",
            iteration,
            runId,
            provider: runConfig?.providerId,
            model: runConfig?.model,
          });
        } catch (error) {
          if (
            !this.agent.isRecoverableLargeWriteToolCallError(error, modelResponse)
          ) {
            throw error;
          }
          if (largeWrite.recoveryAttempts >= maxLargeWriteRecoveryAttempts) {
            if (
              this.agent.forceLargeWriteModelFallback(runConfig, largeWrite, error)
            ) {
              largeWrite.recoveryAttempts = 0;
              largeWrite.planningRetryCount = 0;
              this.agent.messages.push({
                role: "system",
                content: this.agent.buildLargeWriteActionInstruction(largeWrite),
              });
              continue;
            }
            largeWrite.active = false;
            largeWrite.state = "FAILED";
            this.agent.debugLargeWrite(largeWrite, "fail", {
              reason: "recovery_exhausted",
            });
            throw this.agent.createLargeWriteRecoveryError(
              error,
              largeWrite.recoveryAttempts,
              maxLargeWriteRecoveryAttempts,
            );
          }
          this.agent.activateLargeWriteRecovery(largeWrite, error, modelResponse);
          this.agent.messages.push({
            role: "system",
            content: this.agent.buildLargeWriteRecoveryInstruction(
              error.toolName,
              largeWrite,
            ),
          });
          continue;
        }
        finalResponse = parsed.text || "";
        finalReasoning = parsed.reasoning || finalReasoning;
        if (largeWrite.active) {
          const selection = this.agent.selectLargeWriteToolCall(
            parsed.toolCalls,
            largeWrite,
          );
          if (!selection.call) {
            if (parsed.reasoning) {
              this.agent.emitModelOutput(
                "reasoning",
                parsed.reasoning,
                outputContext,
                "snapshot",
              );
            }
            if (largeWrite.planningRetryCount < 1) {
              largeWrite.planningRetryCount += 1;
              this.agent.messages.push({
                role: "system",
                content: this.agent.buildLargeWriteActionInstruction(
                  largeWrite,
                  true,
                ),
              });
              this.agent.debugLargeWrite(largeWrite, selection.expected.decision, {
                reasoningOnly:
                  Boolean(parsed.reasoning) && parsed.toolCalls.length === 0,
                action: "force_write_tool",
              });
              continue;
            }
            if (
              this.agent.forceLargeWriteModelFallback(
                runConfig,
                largeWrite,
                this.agent.createLargeWriteProtocolError(largeWrite),
              )
            ) {
              largeWrite.planningRetryCount = 0;
              largeWrite.recoveryAttempts = 0;
              this.agent.messages.push({
                role: "system",
                content: this.agent.buildLargeWriteActionInstruction(largeWrite),
              });
              continue;
            }
            largeWrite.active = false;
            largeWrite.state = "FAILED";
            this.agent.debugLargeWrite(largeWrite, "fail", {
              reasoningOnly:
                Boolean(parsed.reasoning) && parsed.toolCalls.length === 0,
              reason: "write_tool_missing_after_directive",
            });
            throw this.agent.createLargeWriteProtocolError(
              largeWrite,
              "write_tool_missing_after_directive",
            );
          }
          parsed.toolCalls = [selection.call];
          this.agent.debugLargeWrite(
            largeWrite,
            selection.call.function.name === "read_file"
              ? "validate"
              : selection.expected.decision,
            {
              tool: selection.call.function.name,
            },
          );
        }
        let outcome = this.agent.evaluateIterationOutcome({
          finishReason: parsed.finishReason,
          hasReasoning: Boolean(parsed.reasoning),
          hasText: Boolean(parsed.text.trim()),
          toolCallCount: parsed.toolCalls.length,
          requiresModification,
          modificationPerformed: successfulWriteCount > 0,
          validationPending,
          requiresExplicitCompletion,
          taskComplete: runState.taskComplete,
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
        this.agent.debugIterationDecision({
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
          this.agent.emitModelOutput(
            "reasoning",
            parsed.reasoning,
            outputContext,
            "snapshot",
          );
        }
        if (
          parsed.text &&
          !(
            requiresExplicitCompletion &&
            !runState.taskComplete &&
            parsed.toolCalls.length === 0
          ) &&
          (!requiresModification ||
            (parsed.toolCalls.length > 0 && !finalSummaryRequested))
        ) {
          this.agent.emitModelOutput(
            "assistant",
            parsed.text,
            outputContext,
            "snapshot",
          );
        }
        const noActionProgress = this.agent.agentProgress.handleModelNoAction({
          iteration,
          hasToolCalls: parsed.toolCalls.length > 0,
          hasReasoning: Boolean(parsed.reasoning),
          hasText: Boolean(parsed.text.trim()),
          modificationPerformed: successfulWriteCount > 0,
        });
        if (noActionProgress.action === "directive") {
          this.agent.messages.push({
            role: "system",
            content: noActionProgress.content,
          });
          continue;
        }
        if (outcome.action === "fail") {
          if (outcome.reason === "max_iterations_reached") {
            throw this.agent.createMaxIterationsError(toolIterations, maxIterations);
          }
          if (outcome.reason === "required_write_not_performed") {
            this.agent.emitModelOutput(
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
                message:
                  "Aucun outil d'écriture n'a réussi pour cette demande.",
              },
              iterations: iteration,
            };
          }
          throw this.agent.createIterationFailure(parsed.finishReason);
        }
        if (outcome.action === "continue") {
          if (outcome.reason === "required_write_missing") {
            this.agent.emitModelOutput(
              "assistant",
              parsed.text,
              outputContext,
              "snapshot",
            );
            missingWriteRetries += 1;
            this.agent.messages.push({
              role: "system",
              content:
                "La demande nécessite une modification réelle du projet. Aucun outil d'écriture n'a encore réussi. N'envoie pas le code dans le chat : utilise modify_file, create_file, write_file_chunk ou rename_file.",
            });
            continue;
          }
          incompleteContinuations += 1;
          if (incompleteContinuations > maxIncompleteContinuations) {
            throw this.agent.createIncompleteGenerationError(
              outcome.reason,
              incompleteContinuations,
              maxIncompleteContinuations,
            );
          }
          this.agent.appendIncompleteContinuation(parsed, outcome.reason);
          continue;
        }
        if (outcome.action === "finish") {
          incompleteContinuations = 0;
          if (requiresModification && successfulWriteCount > 0) {
            const looksLikeDump = this.agent.isLikelyFullFileDump(parsed.text);
            if (
              looksLikeDump &&
              !allowsFullCodeResponse &&
              !finalSummaryRequested
            ) {
              finalSummaryRequested = true;
              finalResponse = "";
              this.agent.messages.push({
                role: "system",
                content:
                  "Les modifications ont déjà été appliquées avec succès. Ne renvoie pas le contenu complet des fichiers. Fournis uniquement un résumé concis des changements et des vérifications, sans appeler de tool.",
              });
              continue;
            }
            if (looksLikeDump && !allowsFullCodeResponse) {
              finalResponse =
                this.agent.buildSuccessfulWriteFallback(successfulWrites);
            }
            if (finalResponse) {
              this.agent.emitModelOutput(
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
        this.agent.messages.push(
          this.agent.createAssistantToolCallMessage(
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
        let progressDecision = { action: "none", level: 0 };
        let completionRequest = null;
        for (const call of executableToolCalls) {
          this.agent.assertRunActive(runId, controller);
          const toolResult = await this.agent.executeToolCall(call, {
            sessionId: this.agent.currentSessionId,
            runId,
          });
          this.agent.assertRunActive(runId, controller);
          this.agent.messages.push(this.agent.createToolResultMessage(call.id, toolResult));

          const toolPayload = toolResult?.result ?? toolResult;
          const toolProgress = this.agent.agentProgress.consumeTool(
            call?.function?.name,
            toolResult?.meta,
            iteration,
          );
          if (toolProgress.action === "progress") {
            this.clearProgressDirectives();
            progressDecision = { action: "none", level: 0 };
          } else if (
            toolProgress.action === "directive" &&
            toolProgress.level >= (progressDecision.level || 0)
          ) {
            progressDecision = toolProgress;
          }
          let toolArgs = {};
          try {
            toolArgs = this.agent.parseCanonicalToolArguments(
              call?.function?.arguments,
            );
          } catch {
            toolArgs = {};
          }
          if (
            call?.function?.name === "task_complete" &&
            toolResult?.success === true &&
            toolPayload?.taskCompleteRequested === true
          ) {
            completionRequest = {
              summary: toolPayload.summary || toolArgs.summary || "",
              validation: toolPayload.validation || toolArgs.validation || "",
            };
          }
          this.agent.updateLargeWriteStateAfterTool(
            largeWrite,
            call,
            toolResult,
            toolArgs,
          );
          const modificationTool =
            call?.function?.name === "modify_active_file" ||
            call?.function?.name === "replace_text" ||
            call?.function?.name === "modify_file";
          if (writeTools.has(call?.function?.name) && toolResult?.success) {
            successfulWriteCount += 1;
            unresolvedWriteFailure = false;
            missingWriteRetries = 0;
            const affectedPath = AgentPath.normalize(
              toolPayload?.newPath ||
                toolPayload?.path ||
                toolArgs?.newPath ||
                toolArgs?.path ||
                "",
            );
            if (this.agent.toolResultConfirmsValidation(toolPayload)) {
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
            writeTools.has(call?.function?.name) &&
            toolResult?.success === false
          ) {
            unresolvedWriteFailure = true;
          } else if (
            ["read_file", "read_active_file"].includes(call?.function?.name) &&
            toolResult?.success
          ) {
            const readPath = AgentPath.normalize(
              toolArgs?.path ||
                toolPayload?.path ||
                this.agent.editor?.tabManager?.activeFile?.path ||
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
            unresolvedWriteFailure = true;
            if (retryableErrorCodes.has(toolPayload?.error?.code)) {
              modificationFailures += 1;
            }
            const failureMessage =
              toolPayload?.error?.message || "échec de modification";
            failedModifications.push(
              `${call?.function?.name || "outil de modification"}: ${failureMessage}`,
            );
          } else if (modificationTool && toolResult?.success) {
            modificationFailures = 0;
            unresolvedWriteFailure = false;
            failedModifications.pop();
          }

          if (toolResult?.meta?.toolCategory === "validation") {
            unresolvedValidationFailure = toolResult?.success === false;
            if (toolResult?.success) {
              pendingValidationPaths.clear();
              validationPending = false;
            }
          }

          const toolName = call?.function?.name;
          if (toolName === "modify_active_file" && toolResult?.success) {
            const validation = this.agent.validateActiveFileSyntax();
            if (!validation.valid) {
              if (postEditRepairAttempts >= 3) {
                throw new Error(
                  `La validation du fichier échoue après correction automatique : ${validation.error}`,
                );
              }
              postEditRepairAttempts += 1;
              const activePath = AgentPath.normalize(
                this.agent.editor?.tabManager?.activeFile?.path || "",
              );
              pendingValidationPaths.add(activePath || "[active-file]");
              validationPending = true;
              this.agent.messages.push({
                role: "system",
                content: `VALIDATION POST-MODIFICATION : le fichier modifié contient une erreur de syntaxe (${validation.error}). Lis le code actuel, corrige immédiatement la cause et réapplique une modification valide avant de répondre.`,
              });
            }
          }
        }
        if (completionRequest) {
          const completion = this.validateTaskCompletion({
            requiresModification,
            successfulWriteCount,
            validationPending,
            unresolvedWriteFailure,
            unresolvedValidationFailure,
          });
          if (completion.accepted) {
            runState.taskComplete = true;
            this.agent.agentProgress.recordTaskCompletion(
              iteration,
              true,
              completion.reason,
            );
            this.clearProgressDirectives();
            return {
              response: this.buildTaskCompletionResponse(
                completionRequest,
                finalResponse ||
                  (successfulWriteCount > 0
                    ? this.agent.buildSuccessfulWriteFallback(successfulWrites)
                    : "Tâche terminée."),
              ),
              reasoning: finalReasoning,
              taskComplete: true,
              validation: completionRequest.validation || "",
              iterations: iteration,
            };
          }
          this.agent.agentProgress.recordTaskCompletion(
            iteration,
            false,
            completion.reason,
          );
          this.agent.messages.push({
            role: "system",
            content: `[NCE TASK COMPLETION] task_complete was not accepted: ${completion.message} Continue the task and call task_complete again after resolving it.`,
          });
        }
        if (progressDecision.action === "directive") {
          this.agent.messages.push({
            role: "system",
            content: progressDecision.content,
          });
        }
        if (hasReadCall && hasWriteCall) {
          this.agent.messages.push({
            role: "system",
            content:
              "Les lectures ont été exécutées. Décide des écritures au prochain tour avec leur résultat.",
          });
        } else if (
          hasWriteCall &&
          orderedToolCalls.filter((call) =>
            writeTools.has(call?.function?.name),
          ).length > executableToolCalls.length
        ) {
          this.agent.messages.push({
            role: "system",
            content:
              "Une seule écriture a été exécutée. Réévalue les écritures restantes au prochain tour à partir du résultat réel.",
          });
        }
        toolIterations += 1;
      }
    } catch (error) {
      if (largeWrite.active) {
        largeWrite.active = false;
        largeWrite.state = this.agent.isAbortError(error) ? "ABORTED" : "FAILED";
        this.agent.debugLargeWrite(largeWrite, "fail", {
          reason: this.agent.isAbortError(error)
            ? "user_aborted"
            : error?.code || "run_failed",
        });
      }
      throw error;
    }
  }

}

window.AgentRunner = AgentRunner;
