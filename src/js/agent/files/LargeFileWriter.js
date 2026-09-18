class LargeFileWriter {
  constructor(agent) {
    this.agent = agent;
  }

  createLargeWriteRuntimeState(runConfig = {}, source = null) {
    const configuredLimit =
      runConfig?.largeFileWriting?.maxChunkCharacters ??
      this.agent?.largeFileWriting?.maxChunkCharacters ??
      10000;
    const recommendedLimit =
      runConfig?.largeFileWriting?.recommendedChunkCharacters ??
      this.agent?.largeFileWriting?.recommendedChunkCharacters ??
      8000;
    return {
      active: source?.active === true,
      state:
        source?.active === true
          ? source?.firstChunkCreated === true
            ? "ACTIVE_APPEND"
            : "ACTIVE_NEEDS_CREATE"
          : "IDLE",
      path: AgentPath.normalize(source?.path || ""),
      toolName: source?.toolName || null,
      maxChunkChars: Math.max(1000, Math.floor(configuredLimit)),
      recommendedChunkChars: Math.max(
        1000,
        Math.min(configuredLimit, Math.floor(recommendedLimit)),
      ),
      recoveryTargetChars: Number.isFinite(source?.recoveryTargetChars)
        ? Math.max(1000, Math.floor(source.recoveryTargetChars))
        : null,
      minRecoveryChunkChars: Math.max(
        1000,
        Math.floor(
          runConfig?.largeFileWriting?.minRecoveryChunkCharacters ??
            this.agent?.largeFileWriting?.minRecoveryChunkCharacters ??
            1000,
        ),
      ),
      recoveryAttempts: Number.isInteger(source?.recoveryAttempts)
        ? source.recoveryAttempts
        : 0,
      maxRecoveryAttempts: Number.isInteger(
        runConfig?.largeFileWriting?.maxRecoveryAttempts ??
          this.agent?.largeFileWriting?.maxRecoveryAttempts,
      )
        ? Math.max(
            1,
            Math.floor(
              runConfig?.largeFileWriting?.maxRecoveryAttempts ??
                this.agent?.largeFileWriting?.maxRecoveryAttempts ??
                3,
            ),
          )
        : 3,
      planningRetryCount: Number.isInteger(source?.planningRetryCount)
        ? source.planningRetryCount
        : 0,
      strategyFailures: Number.isInteger(source?.strategyFailures)
        ? source.strategyFailures
        : 0,
      strategyReplanCount: Number.isInteger(source?.strategyReplanCount)
        ? source.strategyReplanCount
        : 0,
      strategyReplanRequired: source?.strategyReplanRequired === true,
      strategySignature: source?.strategySignature || null,
      failedStrategySignature: source?.failedStrategySignature || null,
      temporaryRecoveryMax: source?.temporaryRecoveryMax || null,
      totalWriteRecoveryEvents: source?.totalWriteRecoveryEvents || 0,
      consecutiveRejectedStrategies: source?.consecutiveRejectedStrategies || 0,
      lastFailure: source?.lastFailure || null,
      maxStrategyReplans: Number.isInteger(
        runConfig?.largeFileWriting?.maxStrategyReplans ??
          this.agent?.largeFileWriting?.maxStrategyReplans,
      )
        ? Math.max(
            0,
            Math.floor(
              runConfig?.largeFileWriting?.maxStrategyReplans ??
                this.agent?.largeFileWriting?.maxStrategyReplans ??
                3,
            ),
          )
        : 3,
      maxConsecutiveRejectedStrategies: Number.isInteger(
        runConfig?.largeFileWriting?.maxConsecutiveRejectedStrategies ??
          this.agent?.largeFileWriting?.maxConsecutiveRejectedStrategies,
      )
        ? Math.max(
            1,
            Math.floor(
              runConfig?.largeFileWriting?.maxConsecutiveRejectedStrategies ??
                this.agent?.largeFileWriting
                  ?.maxConsecutiveRejectedStrategies ??
                3,
            ),
          )
        : 3,
      fallbackCount: Number.isInteger(source?.fallbackCount)
        ? source.fallbackCount
        : 0,
      firstChunkCreated: source?.firstChunkCreated === true,
      currentRevision: source?.currentRevision || null,
      chunksApplied: Number.isInteger(source?.chunksApplied)
        ? source.chunksApplied
        : 0,
      validationPending: source?.validationPending === true,
      validationAttempts: Number.isInteger(source?.validationAttempts)
        ? source.validationAttempts
        : 0,
      lastValidationRevision: source?.lastValidationRevision || null,
      maxValidationAttempts: Number.isInteger(source?.maxValidationAttempts)
        ? Math.max(1, source.maxValidationAttempts)
        : 2,
      completed: source?.completed === true,
      decision: source?.decision || "none",
    };
  }

  getLargeWriteContextState(state) {
    if (!state) return null;
    return {
      active: state.active,
      state: state.state,
      path: state.path || null,
      maxChunkChars: state.maxChunkChars,
      recommendedChunkChars: state.recommendedChunkChars,
      temporaryRecoveryMax: state.temporaryRecoveryMax,
      effectiveChunkLimit: this.getEffectiveChunkLimit(state),
      hardLimitChars: this.getHardChunkLimit(state),
      modelTargetChars: this.getModelChunkTarget(state),
      nextAction: this.getNextAction(state),
      expectedRevision: state.currentRevision || null,
      lastFailure: state.lastFailure || null,
      strategyFailures: state.strategyFailures,
      strategyReplanCount: state.strategyReplanCount,
      strategyReplanRequired: state.strategyReplanRequired,
      recoveryAttempts: state.recoveryAttempts,
      planningRetryCount: state.planningRetryCount,
      firstChunkCreated: state.firstChunkCreated,
      currentRevision: state.currentRevision,
      chunksApplied: state.chunksApplied,
      validationPending: state.validationPending,
      validationAttempts: state.validationAttempts,
      lastValidationRevision: state.lastValidationRevision,
      maxValidationAttempts: state.maxValidationAttempts,
      completed: state.completed,
      decision: state.decision,
    };
  }

  debugLargeWrite(state, decision, details = {}) {
    if (!state) return;
    state.decision = decision;
    console.debug("[NCE Large Write]", {
      path: state.path || null,
      state: state.state,
      chunkLimit: state.maxChunkChars,
      recoveryAttempts: state.recoveryAttempts,
      planningRetryCount: state.planningRetryCount,
      strategyFailures: state.strategyFailures,
      strategyReplanCount: state.strategyReplanCount,
      currentRevision: state.currentRevision,
      chunksApplied: state.chunksApplied,
      validationPending: state.validationPending,
      decision,
      ...details,
    });
  }

  transitionLargeWriteState(state, nextState, decision, details = {}) {
    if (!state) return;
    const previousState = state.state;
    state.state = nextState;
    this.debugLargeWrite(state, decision, {
      transition: `${previousState}->${nextState}`,
      previousState,
      ...details,
    });
  }

  getToolCallStrategySignature(name, args = {}) {
    const path = AgentPath.normalize(
      args?.path || args?.pathHint || args?.oldPath || "",
    );
    const size = Number.isFinite(args?.contentLengthApprox)
      ? args.contentLengthApprox
      : typeof args?.content === "string"
        ? args.content.length
        : 0;
    const payloadSizeBucket = size > 0 ? Math.ceil(size / 500) * 500 : 0;
    return JSON.stringify({
      tool: name || null,
      path,
      strategyKind:
        name === "create_file" && size > 4000
          ? "large_create"
          : name === "create_file"
            ? "small_create"
            : name === "write_file_chunk"
              ? "chunk"
              : name,
      payloadSizeBucket,
    });
  }

  extractMalformedToolCallMetadata(
    rawArguments,
    toolName,
    finishReason = null,
  ) {
    const raw = typeof rawArguments === "string" ? rawArguments : "";
    const pathMatch = raw.match(/"path"\s*:\s*"((?:\\.|[^"\\])*)"/);
    let pathHint = "";
    if (pathMatch) {
      try {
        pathHint = AgentPath.normalize(JSON.parse(`"${pathMatch[1]}"`));
      } catch {
        /* hint only */
      }
    }
    const contentMatch = /"content"\s*:\s*"/.exec(raw);
    return {
      toolName,
      pathHint,
      rawArgumentsLength: raw.length,
      contentLengthApprox: contentMatch
        ? Math.max(0, raw.length - contentMatch.index - contentMatch[0].length)
        : 0,
      finishReason,
      parseStatus: "malformed",
      malformed: true,
    };
  }

  getRecoveryContentTarget(state, metadata = null) {
    const recommended = state?.recommendedChunkChars || 8000;
    const failures = Math.min(3, state?.strategyFailures || 0);
    const configured = Math.floor(
      recommended * [1, 0.75, 0.5, 0.375][failures],
    );
    const observed =
      metadata?.rawArgumentsLength > 0
        ? Math.floor(metadata.rawArgumentsLength * 0.5)
        : configured;
    return Math.max(
      1000,
      Math.min(configured, observed, state?.maxChunkChars || 10000),
    );
  }

  isRepeatedFailedStrategy(state, name, args) {
    if (!state?.strategyReplanRequired || !state.failedStrategySignature)
      return false;
    const previous = JSON.parse(state.failedStrategySignature);
    const current = JSON.parse(this.getToolCallStrategySignature(name, args));
    if (Number.isFinite(state?.temporaryRecoveryMax)) {
      const size = typeof args?.content === "string" ? args.content.length : 0;
      if (size <= state.temporaryRecoveryMax) return false;
    }
    return (
      previous.tool === current.tool &&
      previous.path === current.path &&
      previous.strategyKind === current.strategyKind &&
      (previous.strategyKind === "large_create" ||
        previous.payloadSizeBucket === current.payloadSizeBucket)
    );
  }

  resetStrategyAfterProgress(state, name, args) {
    state.strategyReplanRequired = false;
    state.strategyFailures = 0;
    state.consecutiveRejectedStrategies = 0;
    state.temporaryRecoveryMax = null;
    state.recoveryTargetChars = null;
    state.lastFailure = null;
    state.failedStrategySignature = null;
    state.strategySignature = this.getToolCallStrategySignature(name, args);
  }

  observeStrategyFailure(state, error, result = null) {
    if (!state) return;
    state.recoveryAttempts = Number.isInteger(state.recoveryAttempts)
      ? state.recoveryAttempts + 1
      : 1;
    state.strategyFailures = Number.isInteger(state.strategyFailures)
      ? state.strategyFailures + 1
      : 1;
    state.strategySignature = this.getToolCallStrategySignature(
      error?.toolName || state.toolName,
      this.extractToolCallArgsFromError(error, result) || {},
    );
    return state;
  }

  extractToolCallArgsFromError(error, result = null) {
    const message = result?.choices?.[0]?.message || result?.message || null;
    const toolCall = Array.isArray(message?.tool_calls)
      ? message.tool_calls[error?.toolCallIndex || 0]
      : null;
    if (!toolCall?.function?.arguments) return {};
    try {
      return this.agent.parseCanonicalToolArguments(
        toolCall.function.arguments,
      );
    } catch {
      return this.extractMalformedToolCallMetadata(
        toolCall.function.arguments,
        error?.toolName || toolCall.function.name,
        error?.finishReason,
      );
    }
  }

  buildWriteStrategyRecoveryInstruction(state, error = null) {
    const path = state?.path || error?.path || "";
    const tool = error?.toolName || state?.toolName || "write_file";
    const limit =
      state?.maxChunkChars || this.agent.largeFileWriting.maxChunkCharacters;
    const recommended =
      state?.recommendedChunkChars ||
      this.agent.largeFileWriting.recommendedChunkCharacters;
    const failure =
      error?.code || error?.category || "TOOL_ARGUMENTS_TRUNCATED";
    const dynamicTarget =
      state?.temporaryRecoveryMax || this.getRecoveryContentTarget(state);
    const suggestion =
      tool === "write_file_chunk"
        ? "réduire la taille du chunk et respecter expectedRevision"
        : "créer le fichier vide ou une très petite première portion puis continuer avec write_file_chunk";
    return `[NCE WRITE STRATEGY ENFORCEMENT]\nPrevious large write strategy failed 3 times and is now forbidden. Do not retry a large create_file payload.\nCurrent objective: ${tool}${path ? ` @ ${path}` : ""}\nPrevious failure: ${failure}\nHard limit: ${limit}; recommended model target: ${recommended}; recovery target: ${dynamicTarget}.\nCreate a minimal scaffold <= 2000 characters, preferably empty, then append with write_file_chunk in chunks <= 2000-3000 characters. Use the revision returned by every successful chunk. ${suggestion}. Continue with the SAME model.`;
  }

  getHardChunkLimit(state) {
    if (!state)
      return this.agent?.largeFileWriting?.maxChunkCharacters || 10000;
    return Math.max(
      state.minRecoveryChunkChars || 1000,
      state.maxChunkChars || 10000,
    );
  }

  getModelChunkTarget(state) {
    const hardLimit = this.getHardChunkLimit(state);
    const configuredTarget =
      state?.recoveryTargetChars || state?.recommendedChunkChars;
    return Math.max(
      1000,
      Math.min(hardLimit, configuredTarget || Math.floor(hardLimit * 0.8)),
    );
  }

  getEffectiveChunkLimit(state) {
    return this.getHardChunkLimit(state);
  }

  getNextAction(state) {
    if (!state?.firstChunkCreated) return "create_file";
    if (state.state === "FINAL_VALIDATION") return "read_file";
    return "write_file_chunk";
  }

  buildOversizedChunkRecoveryInstruction(state, attemptedCharacters) {
    const hardLimit = this.getHardChunkLimit(state);
    const target = this.getModelChunkTarget(state);
    const path = state?.path || "<path>";
    const revision = state?.currentRevision || "<current revision>";
    return `[NCE LARGE WRITE RECOVERY]\nFile: ${path}\nPrevious write_file_chunk was too large (${attemptedCharacters} characters).\nCurrent revision: ${revision}\nHard payload limit: ${hardLimit} characters.\nTarget approximately <= ${target} characters.\n\nNext action:\n${this.getNextAction(state)} only.\n\nUse the current revision returned by the previous successful write. Do not retry the previous oversized payload.`;
  }

  rejectOversizedChunk(state, call, attemptedCharacters) {
    let args = {};
    try {
      args = this.agent.parseCanonicalToolArguments(call?.function?.arguments);
    } catch {
      args = {};
    }
    const hardLimit = this.getHardChunkLimit(state);
    state.active = true;
    state.completed = false;
    state.validationPending = true;
    state.toolName = call?.function?.name || state.toolName;
    state.path = AgentPath.normalize(args.path || state.path || "");
    state.recoveryTargetChars = this.getModelChunkTarget(state);
    state.recoveryAttempts += 1;
    state.strategyFailures += 1;
    state.consecutiveRejectedStrategies += 1;
    state.lastFailure = "OVERSIZED_CHUNK";
    state.failedStrategySignature = this.getToolCallStrategySignature(
      state.toolName,
      { path: state.path, content: "x".repeat(attemptedCharacters) },
    );
    console.info("[NCE Large Write recovery]", {
      path: state.path || null,
      reason: "OVERSIZED_CHUNK",
      attemptedChars: attemptedCharacters,
      hardLimitChars: hardLimit,
      modelTargetChars: state.recoveryTargetChars,
      consecutiveRejectedStrategies: state.consecutiveRejectedStrategies,
      currentRevision: state.currentRevision || null,
      action: "request_smaller_chunk",
    });
    return {
      exhausted: state.recoveryAttempts > state.maxRecoveryAttempts,
      directive: this.buildOversizedChunkRecoveryInstruction(
        state,
        attemptedCharacters,
      ),
    };
  }

  requestStrategyReplan(state, error = null, result = null) {
    if (!state) return null;
    const maxStrategyReplans = Number.isInteger(state?.maxStrategyReplans)
      ? state.maxStrategyReplans
      : Number.isInteger(this.agent?.largeFileWriting?.maxStrategyReplans)
        ? this.agent.largeFileWriting.maxStrategyReplans
        : 3;
    if (state.strategyReplanCount >= maxStrategyReplans) {
      if (this.agent?.agentProgress?.metrics)
        this.agent.agentProgress.metrics.writeRecoveryExhausted += 1;
      const exhausted = this.agent.createLargeWriteRecoveryError(
        error,
        state.recoveryAttempts,
        state.maxRecoveryAttempts ||
          this.agent.largeFileWriting.maxRecoveryAttempts,
      );
      throw exhausted;
    }
    state.strategyFailures = 0;
    state.strategyReplanRequired = true;
    state.strategyReplanCount = Number.isInteger(state.strategyReplanCount)
      ? state.strategyReplanCount + 1
      : 1;
    state.failedStrategySignature = this.getToolCallStrategySignature(
      error?.toolName || state.toolName || "create_file",
      this.extractToolCallArgsFromError(error, result) || {},
    );
    state.temporaryRecoveryMax = Math.min(
      2500,
      this.getRecoveryContentTarget(
        state,
        this.extractToolCallArgsFromError(error, result),
      ),
    );
    return state;
  }

  extractTruncatedLargeWritePath(result, toolCallIndex = 0) {
    const message = result?.choices?.[0]?.message || result?.message;
    const call = Array.isArray(message?.tool_calls)
      ? message.tool_calls[toolCallIndex]
      : null;
    const raw = call?.function?.arguments;
    if (typeof raw !== "string") return "";
    const match = raw.match(/"path"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (!match) return "";
    try {
      const decoded = JSON.parse(`"${match[1]}"`);
      return typeof decoded === "string" ? AgentPath.normalize(decoded) : "";
    } catch {
      return "";
    }
  }

  activateLargeWriteRecovery(state, error, result) {
    const detectedPath = this.extractTruncatedLargeWritePath(
      result,
      error?.toolCallIndex || 0,
    );
    state.active = true;
    state.state = state.firstChunkCreated
      ? "ACTIVE_APPEND"
      : "ACTIVE_NEEDS_CREATE";
    state.completed = false;
    state.validationPending = true;
    state.toolName = error?.toolName || state.toolName;
    if (detectedPath) state.path = detectedPath;
    state.totalWriteRecoveryEvents += 1;
    state.recoveryAttempts = Math.min(
      state.maxRecoveryAttempts || 3,
      state.recoveryAttempts + 1,
    );
    this.debugLargeWrite(state, "retry_as_chunked_write", {
      finishReason: error?.finishReason || "unknown",
      classification: error?.category || "TOOL_ARGUMENTS_TRUNCATED",
    });
    console.info("[NCE Agent recovery]", {
      reason: "tool_arguments_truncated",
      tool: state.toolName,
      path: state.path || null,
      recoveryAttempt: state.recoveryAttempts,
    });
    return state;
  }

  pathsReferToSameFile(left, right) {
    const a = AgentPath.normalize(left || "");
    const b = AgentPath.normalize(right || "");
    if (!a || !b) return false;
    return AgentPath.samePath(a, b);
  }

  getLargeWriteExpectedAction(state) {
    if (!state?.firstChunkCreated) {
      return {
        tools: new Set(["create_file"]),
        decision: "expect_first_chunk",
      };
    }
    if (state.state === "FINAL_VALIDATION") {
      return {
        tools: new Set(["read_file"]),
        decision: "revalidate",
      };
    }
    return {
      tools: new Set(["write_file_chunk", "read_file"]),
      decision: state.validationPending ? "expect_next_chunk" : "validate",
    };
  }

  selectLargeWriteToolCall(toolCalls, state) {
    const expected = this.getLargeWriteExpectedAction(state);
    const candidates = [];
    let oversizedCall = null;
    for (const call of toolCalls || []) {
      const name = call?.function?.name;
      if (!expected.tools.has(name)) continue;
      let args = {};
      try {
        args = this.agent.parseCanonicalToolArguments(call.function.arguments);
      } catch {
        continue;
      }
      if (
        state.path &&
        args.path &&
        !this.pathsReferToSameFile(state.path, args.path)
      ) {
        continue;
      }
      if (
        ["create_file", "write_file_chunk"].includes(name) &&
        (typeof args.content !== "string" ||
          args.content.length > this.getEffectiveChunkLimit(state))
      ) {
        if (typeof args.content === "string") {
          oversizedCall = {
            call,
            args,
            name,
            path: AgentPath.normalize(args.path || ""),
            contentChars: args.content.length,
            reason: "OVERSIZED_CHUNK",
          };
        }
        continue;
      }
      candidates.push({ call, name });
    }
    candidates.sort((left, right) => {
      const priority = { create_file: 0, write_file_chunk: 0, read_file: 1 };
      return (priority[left.name] ?? 2) - (priority[right.name] ?? 2);
    });
    return {
      call: candidates[0]?.call || null,
      expected,
      oversizedCall,
    };
  }

  buildLargeWriteActionInstruction(state, repeated = false) {
    const target = state?.path ? ` pour ${state.path}` : "";
    if (!state?.firstChunkCreated) {
      return repeated
        ? `LARGE_WRITE_ACTIVE: cette stratégie d'écriture surdimensionnée a déjà échoué${target}. Ne la répète pas. Appelle create_file maintenant avec une première portion <= ${state.recommendedChunkChars} caractères, puis continue avec write_file_chunk. Ne planifie pas et ne relis pas le projet.`
        : this.agent.buildLargeWriteRecoveryInstruction("create_file", state);
    }
    return `LARGE_WRITE_ACTIVE: continue directement${target}. Appelle write_file_chunk avec la prochaine portion et expectedRevision=${state.currentRevision || "la dernière revision retournée"}, ou read_file uniquement si toutes les portions ont déjà été écrites et qu'il faut valider. Ne planifie pas et ne répète aucune recherche.`;
  }

  createLargeWriteProtocolError(state, reason = "write_tool_missing") {
    const error = new Error(
      "Le modèle n'a pas respecté le protocole de création progressive du gros fichier.",
    );
    error.name = "AgentLargeWriteProtocolError";
    error.code = "LARGE_WRITE_ACTION_REQUIRED";
    error.category = "LARGE_WRITE_ACTION_REQUIRED";
    error.reason = reason;
    error.path = state?.path || null;
    error.recoveryAttempts = state?.recoveryAttempts || 0;
    error.planningRetryCount = state?.planningRetryCount || 0;
    error.effectiveChunkLimit = this.getEffectiveChunkLimit(state);
    return error;
  }

  updateLargeWriteStateAfterTool(state, call, toolResult, toolArgs = {}) {
    if (!state) return;
    const name = call?.function?.name;
    const payload = toolResult?.result ?? toolResult;
    const success = toolResult?.success === true;
    const path = AgentPath.normalize(payload?.path || toolArgs?.path || "");
    const largeCreate =
      name === "create_file" &&
      typeof toolArgs.content === "string" &&
      toolArgs.content.length > state.recommendedChunkChars;
    if (
      success &&
      (state.active || largeCreate || name === "write_file_chunk")
    ) {
      if (name === "create_file" || name === "write_file_chunk") {
        const inferredExistingFirstChunk =
          name === "write_file_chunk" &&
          !state.active &&
          state.chunksApplied === 0;
        state.active = true;
        this.transitionLargeWriteState(
          state,
          "ACTIVE_APPEND",
          "expect_next_chunk",
          { tool: name },
        );
        state.completed = false;
        state.firstChunkCreated = true;
        state.validationPending = true;
        state.recoveryAttempts = 0;
        state.planningRetryCount = 0;
        state.consecutiveRejectedStrategies = 0;
        state.temporaryRecoveryMax = null;
        state.recoveryTargetChars = null;
        state.chunksApplied += inferredExistingFirstChunk ? 2 : 1;
        state.currentRevision = payload?.revision || state.currentRevision;
        state.lastFailure = null;
        if (path) state.path = path;
        this.debugLargeWrite(
          state,
          name === "create_file" ? "expect_next_chunk" : "expect_next_chunk",
          { tool: name, appendedChars: payload?.appendedChars ?? null },
        );
        return;
      }
      if (
        name === "read_file" &&
        state.firstChunkCreated &&
        (!state.path || this.pathsReferToSameFile(state.path, path))
      ) {
        if (
          state.currentRevision &&
          payload?.revision &&
          state.currentRevision !== payload.revision
        ) {
          state.lastValidationRevision = payload.revision;
          state.validationAttempts += 1;
          if (state.validationAttempts > state.maxValidationAttempts) {
            state.active = false;
            state.state = "FAILED";
            const error = new Error(
              "La revision du gros fichier reste instable pendant sa validation.",
            );
            error.name = "AgentLargeWriteValidationError";
            error.code = "LARGE_WRITE_VALIDATION_UNSTABLE";
            error.category = "LARGE_WRITE_VALIDATION_UNSTABLE";
            error.path = state.path || path || null;
            error.revision = payload.revision;
            error.validationAttempts = state.validationAttempts;
            throw error;
          }
          state.currentRevision = payload.revision;
          state.validationPending = false;
          this.transitionLargeWriteState(
            state,
            "FINAL_VALIDATION",
            "revalidate",
            {
              tool: name,
              errorCode: "REVISION_CHANGED_DURING_VALIDATION",
              validationRevision: payload.revision,
              validationAttempts: state.validationAttempts,
            },
          );
          return;
        }
        state.validationPending = false;
        state.validationAttempts = 0;
        state.lastValidationRevision =
          payload?.revision || state.currentRevision;
        state.completed = true;
        state.active = false;
        this.transitionLargeWriteState(state, "COMPLETE", "complete", {
          tool: name,
          validatedRevision: payload?.revision || state.currentRevision,
        });
        state.currentRevision = payload?.revision || state.currentRevision;
        return;
      }
    }
    if (
      toolResult?.success === false &&
      ["create_file", "write_file_chunk", "read_file"].includes(name)
    ) {
      if (payload?.error?.code === "FILE_WRITE_CONTENT_TOO_LARGE") {
        state.active = true;
        state.state = state.firstChunkCreated
          ? "ACTIVE_APPEND"
          : "ACTIVE_NEEDS_CREATE";
        state.completed = false;
        state.validationPending = true;
        state.toolName = name;
        state.totalWriteRecoveryEvents += 1;
        state.recoveryAttempts = Math.min(3, state.recoveryAttempts + 1);
        if (path) state.path = path;
        this.debugLargeWrite(state, "retry_as_chunked_write", {
          tool: name,
          reason: "content_too_large",
          contentChars: payload.error.actualCharacters || null,
        });
        console.info("[NCE Agent recovery]", {
          reason: "content_too_large",
          tool: name,
          path: state.path || null,
          recoveryAttempt: state.recoveryAttempts,
        });
        return {
          directive: this.agent.buildLargeWriteRecoveryInstruction(
            name,
            state,
            state.recoveryAttempts > 1,
          ),
        };
      }
      if (!state.active) return null;
      if (payload?.error?.actualRevision) {
        state.currentRevision = payload.error.actualRevision;
      }
      this.debugLargeWrite(state, "expect_next_chunk", {
        tool: name,
        errorCode: payload?.error?.code || "TOOL_FAILED",
      });
    }
    return null;
  }
}

window.LargeFileWriter = LargeFileWriter;
