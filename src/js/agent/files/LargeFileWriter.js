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
      recoveryAttempts: Number.isInteger(source?.recoveryAttempts)
        ? source.recoveryAttempts
        : 0,
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
      fallbackCount: Number.isInteger(source?.fallbackCount)
        ? source.fallbackCount
        : 0,
      firstChunkCreated: source?.firstChunkCreated === true,
      currentRevision: source?.currentRevision || null,
      chunksApplied: Number.isInteger(source?.chunksApplied)
        ? source.chunksApplied
        : 0,
      validationPending: source?.validationPending === true,
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
      recoveryAttempts: state.recoveryAttempts,
      planningRetryCount: state.planningRetryCount,
      firstChunkCreated: state.firstChunkCreated,
      currentRevision: state.currentRevision,
      chunksApplied: state.chunksApplied,
      validationPending: state.validationPending,
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

  getToolCallStrategySignature(name, args = {}) {
    const path = AgentPath.normalize(args?.path || args?.oldPath || "");
    const signature = {
      tool: name || null,
      path,
      args: args || {},
    };
    try {
      return JSON.stringify(signature);
    } catch {
      return `${name}:${path}:${String(args)}`;
    }
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
      return {};
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
    const dynamicTarget = Math.max(
      1000,
      Math.min(3000, Math.floor(recommended * 0.4)),
    );
    const suggestion =
      tool === "write_file_chunk"
        ? "réduire la taille du chunk et respecter expectedRevision"
        : "créer le fichier vide ou une très petite première portion puis continuer avec write_file_chunk";
    return `[NCE WRITE STRATEGY RECOVERY]\nYour current write strategy has failed 3 consecutive times.\nDo not repeat the same tool call or the same payload strategy.\nRe-evaluate the current file state and choose a materially different approach.\nCurrent objective: ${tool}${path ? ` @ ${path}` : ""}\nPrevious failure: ${failure}\nTool limits: create_file/write_file_chunk recommended <= ${recommended} chars, hard max = ${limit} chars; dynamic recovery target should be <= ${dynamicTarget} chars.\nRecommended alternatives: ${suggestion}.\nContinue with the SAME model.\nDo not exceed the hard limit and do not repeat the same request.`;
  }

  requestStrategyReplan(state, error = null, result = null) {
    if (!state) return null;
    const maxStrategyReplans = Number.isInteger(state?.maxStrategyReplans)
      ? state.maxStrategyReplans
      : Number.isInteger(this.agent?.largeFileWriting?.maxStrategyReplans)
        ? this.agent.largeFileWriting.maxStrategyReplans
        : 3;
    if (state.strategyReplanCount >= maxStrategyReplans) {
      const exhausted = this.agent.createLargeWriteRecoveryError(
        error,
        state.recoveryAttempts,
        state.maxRecoveryAttempts ||
          this.agent.largeFileWriting.maxRecoveryAttempts,
      );
      exhausted.code = "WRITE_RECOVERY_EXHAUSTED";
      exhausted.category = "WRITE_RECOVERY_EXHAUSTED";
      throw exhausted;
    }
    state.strategyFailures = 0;
    state.strategyReplanRequired = true;
    state.strategyReplanCount = Number.isInteger(state.strategyReplanCount)
      ? state.strategyReplanCount + 1
      : 1;
    state.strategySignature = this.getToolCallStrategySignature(
      error?.toolName || state.toolName || "create_file",
      this.extractToolCallArgsFromError(error, result) || {},
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
    state.recoveryAttempts += 1;
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
          args.content.length > state.maxChunkChars)
      ) {
        if (typeof args.content === "string") {
          oversizedCall = {
            name,
            path: AgentPath.normalize(args.path || ""),
            contentChars: args.content.length,
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
        state.state = "ACTIVE_APPEND";
        state.completed = false;
        state.firstChunkCreated = true;
        state.validationPending = true;
        state.recoveryAttempts = 0;
        state.planningRetryCount = 0;
        state.chunksApplied += inferredExistingFirstChunk ? 2 : 1;
        state.currentRevision = payload?.revision || state.currentRevision;
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
          state.currentRevision = payload.revision;
          state.validationPending = true;
          this.debugLargeWrite(state, "validate", {
            tool: name,
            errorCode: "REVISION_CHANGED_DURING_VALIDATION",
          });
          return;
        }
        state.validationPending = false;
        state.completed = true;
        state.active = false;
        state.state = "COMPLETE";
        state.currentRevision = payload?.revision || state.currentRevision;
        this.debugLargeWrite(state, "complete", { tool: name });
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
        state.recoveryAttempts += 1;
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
