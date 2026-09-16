class ToolExecutor {
  constructor(agent) {
    this.agent = agent;
    this.mutationTail = Promise.resolve();
    this.mutationTailRunId = null;
  }

  stableStringify(value) {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => this.stableStringify(entry)).join(",")}]`;
    }
    if (value && typeof value === "object") {
      return `{${Object.keys(value)
        .sort()
        .map(
          (key) => `${JSON.stringify(key)}:${this.stableStringify(value[key])}`,
        )
        .join(",")}}`;
    }
    return JSON.stringify(value);
  }

  getCallIdentity(call, executionContext = {}) {
    let args;
    try {
      args = this.agent.parseCanonicalToolArguments(call?.function?.arguments);
    } catch {
      args = { invalidRawArguments: String(call?.function?.arguments || "") };
    }
    return `${executionContext.runId ?? this.agent.runId}:${call?.function?.name || ""}:${this.stableStringify(args)}`;
  }

  async acquireMutationLane(executionContext = {}) {
    let release;
    const previous = this.mutationTail;
    const previousRunId = this.mutationTailRunId;
    const requestedRunId = executionContext.runId ?? this.agent.runId;
    this.mutationTail = new Promise((resolve) => {
      release = resolve;
    });
    this.mutationTailRunId = requestedRunId;
    if (previousRunId !== null && previousRunId !== requestedRunId) {
      const timeoutMs = 250;
      let timeout;
      await Promise.race([
        previous,
        new Promise((resolve) => {
          timeout = setTimeout(resolve, timeoutMs);
        }),
      ]).finally(() => clearTimeout(timeout));
    } else {
      await previous;
    }
    if (
      this.agent.stopRequested ||
      (executionContext.runId !== undefined &&
        executionContext.runId !== this.agent.runId)
    ) {
      release();
      throw Object.assign(new Error("Le run Agent n'est plus actif."), {
        code: "RUN_ABORTED",
      });
    }
    return release;
  }

  async executeToolCall(call, executionContext = {}) {
    const name = call?.function?.name;
    const toolCallId = typeof call?.id === "string" ? call.id : "";
    const identity = this.getCallIdentity(call, executionContext);
    const cached = toolCallId
      ? this.agent.executedToolCalls.get(toolCallId)
      : null;
    if (cached) {
      if (cached.executionIdentity === identity) return cached;
      return this.attachMeta(name, {
        success: false,
        error: {
          code: "TOOL_CALL_ID_CONFLICT",
          message:
            "Le même identifiant tool a été réutilisé avec un appel différent.",
          category: "protocol",
          recoverable: true,
          retryStrategy: "replan",
        },
      });
    }

    const runId = executionContext.runId ?? this.agent.runId;
    const pendingIdentity = `${toolCallId || "anonymous"}:${identity}`;
    this.agent.runChangeTracker?.markPending?.(pendingIdentity, runId);
    let releaseMutation = null;
    try {
      const tool = this.agent.getTool(name);
      if (tool && (!tool.readOnly || tool.serializesWithMutations === true)) {
        try {
          releaseMutation = await this.acquireMutationLane(executionContext);
        } catch (error) {
          return this.attachMeta(name, {
            success: false,
            error: {
              code: error?.code || "RUN_ABORTED",
              message: error?.message || "Le run Agent n'est plus actif.",
            },
          });
        }
      }
      const toolResult = await this.executeToolCallInternal(
        call,
        executionContext,
      );
      if (toolCallId) {
        this.agent.executedToolCalls.set(toolCallId, {
          ...toolResult,
          executionIdentity: identity,
        });
      }
      const payload = toolResult?.result ?? toolResult;
      const args = (() => {
        try {
          return this.agent.parseCanonicalToolArguments(
            call?.function?.arguments,
          );
        } catch {
          return {};
        }
      })();
      const path =
        args.path || args.oldPath || payload?.path || payload?.oldPath || null;
      if (name === "run_tests" && payload?.status) {
        const validationRecord =
          this.agent.runChangeTracker?.recordValidation?.({
            status: payload.status,
            validationKind: payload.validationKind,
            projectRoot: payload.projectRoot || ".",
            target: payload.target || args.path || null,
            scope: payload.scope || null,
            reason: payload.reason || payload.error?.message || null,
            toolCallId,
          });
        if (validationRecord && payload && typeof payload === "object") {
          payload.validationId = validationRecord.id || null;
          payload.validationResolution = validationRecord.resolution || null;
        }
      }
      if (toolResult?.success === false && name !== "task_complete") {
        const code = payload?.error?.code || "TOOL_FAILED";
        this.agent.runChangeTracker?.addUnresolvedFailure?.({
          toolCallId,
          toolName: name,
          path,
          error: payload?.error || { code, message: "Tool failure" },
          blocking: ![
            "UNKNOWN_TOOL",
            "TOOL_DISABLED",
            "TOOL_NOT_ALLOWED",
            "INVALID_ARGUMENT",
          ].includes(code),
          recoveryAction: payload?.error?.retryStrategy || null,
        });
      } else if (toolResult?.success !== false) {
        this.agent.runChangeTracker?.resolveFailuresForTool?.(name, path);
        if (name === "read_file") {
          this.agent.runChangeTracker?.markFailuresRecoveryReady?.(path, [
            "STALE_REVISION",
            "OLD_TEXT_NOT_FOUND",
            "AMBIGUOUS_MATCH",
          ]);
        }
      }
      return toolResult;
    } finally {
      releaseMutation?.();
      this.agent.runChangeTracker?.clearPending?.(pendingIdentity, runId);
    }
  }

  getToolOutputLimit(name) {
    const configured = this.agent.toolLimits?.[name];
    if (!configured) return null;
    return {
      maxChars: configured.outputCharacters,
      maxResults: configured.maxResults,
      nextStartLine: name === "read_file",
      nextOffset: name === "search_code",
    };
  }

  getFileWritePayloadLimit(name) {
    if (!["create_file", "write_file_chunk"].includes(name)) return null;
    return Math.max(
      1,
      Math.floor(this.agent.largeFileWriting?.maxChunkCharacters || 10000),
    );
  }

  validateFileWritePayload(name, args = {}) {
    const hardLimit = this.getFileWritePayloadLimit(name);
    if (hardLimit === null) return { valid: true };
    const contentChars =
      typeof args.content === "string" ? args.content.length : 0;
    this.agent.agentProgress?.recordFileWriteRequest?.(name, contentChars);
    console.info("[NCE Agent write]", {
      tool: name,
      path: typeof args.path === "string" ? args.path : null,
      contentChars,
      strategy: name === "create_file" ? "initial" : "append_chunk",
    });
    if (typeof args.content !== "string" || contentChars <= hardLimit) {
      return { valid: true };
    }
    this.agent.agentProgress?.recordFileWriteOversizeRejected?.(name);
    return {
      valid: false,
      error: {
        code: "FILE_WRITE_CONTENT_TOO_LARGE",
        message: `content contient ${contentChars} caractères et dépasse la limite absolue de ${hardLimit}. N'essayez pas de renvoyer le fichier complet : utilisez create_file avec un contenu initial plus petit, puis write_file_chunk en portions sûres.`,
        path: typeof args.path === "string" ? args.path : null,
        actualCharacters: contentChars,
        maxCharacters: hardLimit,
        recovery: "chunked_write_required",
      },
    };
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
        expectedRevision: args?.expectedRevision ?? null,
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

  limitResult(name, result) {
    const maxContent = this.agent.toolLimits?.common?.pathCharacters || 4000;
    if (typeof result === "string")
      return this.agent.truncate(result, maxContent);
    if (!result || typeof result !== "object") return result;

    const limits = this.getToolOutputLimit(name) || {};
    const limited = { ...result };

    if (name === "read_file") {
      const readMaxChars = Number.isFinite(limits.maxChars)
        ? Math.max(1, limits.maxChars)
        : maxContent;
      if (typeof limited.content === "string") {
        if (limited.content.length > readMaxChars) {
          const prefix = limited.content.slice(0, readMaxChars);
          const lastNewline = prefix.lastIndexOf("\n");
          limited.content =
            lastNewline >= 0 ? prefix.slice(0, lastNewline) : prefix;
          limited.truncated = true;
          limited.hasMore = true;
          const firstLine = limited.contentStartLine || limited.startLine || 1;
          const firstColumn = Number.isInteger(limited.contentStartColumn)
            ? limited.contentStartColumn
            : Number.isInteger(limited.partialSegment?.startColumn)
              ? limited.partialSegment.startColumn
              : 0;
          if (lastNewline >= 0) {
            const completeLines = (
              prefix.slice(0, lastNewline + 1).match(/\n/g) || []
            ).length;
            limited.contentEndLine = firstLine + completeLines - 1;
            limited.completeLineRange = {
              startLine: firstLine,
              endLine: limited.contentEndLine,
            };
            limited.endLine = limited.contentEndLine;
            limited.nextStartLine = limited.contentEndLine + 1;
            limited.nextStartColumn = 0;
          } else {
            limited.contentEndLine = null;
            limited.completeLineRange = null;
            limited.lineTruncated = true;
            limited.partialSegment = {
              line: firstLine,
              startColumn: firstColumn,
              endColumn: firstColumn + prefix.length,
            };
            limited.nextStartLine = firstLine;
            limited.nextStartColumn = firstColumn + prefix.length;
          }
        } else if (
          !limited.partialSegment &&
          limited.lineTruncated !== true &&
          !Number.isInteger(limited.nextStartColumn) &&
          !Number.isInteger(limited.contentStartColumn) &&
          !Number.isInteger(limited.contentEndColumn)
        ) {
          limited.hasMore =
            Number.isInteger(limited.requestedEndLine) &&
            Number.isInteger(limited.contentEndLine) &&
            limited.contentEndLine < limited.requestedEndLine;
          limited.nextStartLine = limited.hasMore
            ? limited.contentEndLine + 1
            : null;
          limited.nextStartColumn = null;
        }
      }
      if (limited.success !== false && typeof limited.content === "string") {
        const requestedStart = Number.isInteger(limited.requestedStartLine)
          ? limited.requestedStartLine
          : limited.startLine;
        const requestedEnd = Number.isInteger(limited.requestedEndLine)
          ? limited.requestedEndLine
          : limited.endLine;
        if (
          Number.isInteger(requestedStart) &&
          Number.isInteger(requestedEnd)
        ) {
          limited.requestedRange = {
            startLine: requestedStart,
            endLine: requestedEnd,
            ...(Number.isInteger(limited.requestedStartColumn)
              ? { startColumn: limited.requestedStartColumn }
              : {}),
          };
        }
        const deliveredStart = Number.isInteger(limited.contentStartLine)
          ? limited.contentStartLine
          : limited.startLine;
        const deliveredEnd =
          limited.partialSegment?.line ||
          (Number.isInteger(limited.contentEndLine)
            ? limited.contentEndLine
            : limited.endLine);
        if (
          Number.isInteger(deliveredStart) &&
          Number.isInteger(deliveredEnd)
        ) {
          limited.deliveredRange = {
            startLine: deliveredStart,
            endLine: deliveredEnd,
            ...(limited.partialSegment
              ? {
                  startColumn: limited.partialSegment.startColumn,
                  endColumn: limited.partialSegment.endColumn,
                }
              : {}),
          };
          console.debug("[NCE Agent read]", {
            path: limited.path || null,
            revision: limited.revision || null,
            requestedRange: limited.requestedRange || null,
            deliveredRange: limited.deliveredRange,
            completeLineRange: limited.completeLineRange || null,
            partialSegment: limited.partialSegment || null,
            source: limited.informationSource || "unknown",
            charactersDelivered: limited.content.length,
          });
        }
      }
      return limited;
    }

    if (name === "search_code") {
      const searchMaxChars = Number.isFinite(limits.maxChars)
        ? Math.max(1, limits.maxChars)
        : maxContent;
      const maxResults = Number.isFinite(limits.maxResults)
        ? Math.max(1, limits.maxResults)
        : this.agent.toolLimits?.search_code?.maxResults || 100;
      if (
        Array.isArray(limited.results) &&
        limited.results.length > maxResults
      ) {
        limited.results = limited.results.slice(0, maxResults);
        limited.truncated = true;
        limited.hasMore = true;
        limited.nextOffset = Number.isInteger(limited.offset)
          ? Math.min(
              limited.offset + maxResults,
              limited.totalMatches || Infinity,
            )
          : maxResults;
      }
      for (const key of ["content", "text", "snippet", "preview"]) {
        if (
          typeof limited[key] === "string" &&
          limited[key].length > searchMaxChars
        ) {
          limited[key] = this.agent.truncate(limited[key], searchMaxChars);
          limited.truncated = true;
        }
      }
      return limited;
    }

    if (name === "get_project_map") {
      const mapMaxChars = Number.isFinite(limits.maxChars)
        ? Math.max(1, limits.maxChars)
        : this.agent.toolLimits?.get_project_map?.outputCharacters ||
          maxContent;
      if (
        typeof limited.text === "string" &&
        limited.text.length > mapMaxChars
      ) {
        limited.text = this.agent.truncate(limited.text, mapMaxChars);
        limited.truncated = true;
        limited.hasMore = true;
      }
      return limited;
    }

    if (name === "get_diff") {
      const diffMaxChars = Number.isFinite(limits.maxChars)
        ? Math.max(1, limits.maxChars)
        : this.agent.toolLimits?.get_diff?.outputCharacters || 12000;
      if (
        typeof limited.diff === "string" &&
        limited.diff.length > diffMaxChars
      ) {
        limited.diff = this.agent.truncate(limited.diff, diffMaxChars);
        limited.truncated = true;
        limited.hasMore = true;
      }
      return limited;
    }

    if (name === "run_tests") {
      const testMaxChars = Number.isFinite(limits.maxChars)
        ? Math.max(100, limits.maxChars)
        : maxContent;
      for (const key of ["output", "outputHead", "outputTail"]) {
        if (
          typeof limited[key] === "string" &&
          limited[key].length > testMaxChars
        ) {
          limited[key] = this.agent.truncate(limited[key], testMaxChars);
          limited.truncated = true;
        }
      }
      return limited;
    }

    for (const key of ["content", "beforeText", "afterText"]) {
      if (
        typeof limited[key] === "string" &&
        limited[key].length > maxContent
      ) {
        limited[key] = this.agent.truncate(limited[key], maxContent);
        limited.truncated = true;
      }
    }

    const genericMaxResults =
      this.agent.toolLimits?.search_code?.maxResults || 100;
    if (
      Array.isArray(limited.results) &&
      limited.results.length > genericMaxResults
    ) {
      limited.results = limited.results.slice(0, genericMaxResults);
      limited.truncated = true;
    }

    return limited;
  }

  getToolResultMeta(name, result) {
    const errorCode =
      typeof result?.error === "object" ? result.error.code || null : null;
    const toolUnavailable = new Set([
      "UNKNOWN_TOOL",
      "TOOL_NOT_FOUND",
      "TOOL_DISABLED",
      "TOOL_NOT_ALLOWED",
    ]).has(errorCode);
    const writeTools = new Set([
      "modify_file",
      "create_file",
      "write_file_chunk",
      "rename_file",
      "delete_file",
    ]);
    const readTools = new Set(["read_file"]);
    const searchTools = new Set(["search_code"]);
    const navigationTools = new Set(["get_project_map"]);
    const isValidationTool =
      /(?:^|_)(?:test|tests|build|lint|check|validate|validation|diagnostic|compile|typecheck)(?:_|$)/i.test(
        name || "",
      );
    const toolCategory = toolUnavailable
      ? "capability"
      : name === "task_complete"
        ? "completion"
        : isValidationTool
          ? "validation"
          : writeTools.has(name)
            ? "write"
            : readTools.has(name)
              ? "read"
              : searchTools.has(name)
                ? "search"
                : navigationTools.has(name)
                  ? "navigation"
                  : "other";
    const informationStatus = toolUnavailable
      ? "tool_unavailable"
      : toolCategory === "completion" && result?.success !== false
        ? "task_complete"
        : toolCategory === "validation" && result?.status === "PASSED"
          ? "validation_progress"
          : toolCategory === "validation" &&
              result?.status === "MULTIPLE_PROJECTS"
            ? "validation_selection_required"
            : toolCategory === "validation" &&
                result?.status === "UNSAVED_CHANGES"
              ? "validation_blocked"
              : toolCategory === "validation" &&
                  [
                    "NO_TEST_RUNNER",
                    "NO_TESTS",
                    "RUNTIME_UNAVAILABLE",
                    "DEPENDENCIES_UNAVAILABLE",
                  ].includes(result?.status)
                ? "validation_unavailable"
                : toolCategory === "validation" && result?.status === "TIMEOUT"
                  ? "error_discovered"
                  : toolCategory === "validation" && result?.status === "FAILED"
                    ? "error_discovered"
                    : toolCategory === "validation"
                      ? "error_discovered"
                      : result?.success === false
                        ? "error"
                        : result?.restoredFromCache === true
                          ? "restored"
                          : result?.repeatedRedundantAction === true
                            ? "repeated_redundant"
                            : result?.alreadyKnown === true ||
                                result?.noNewInformation === true
                              ? "already_known"
                              : toolCategory === "write"
                                ? "state_changed"
                                : ["read", "search", "navigation"].includes(
                                      toolCategory,
                                    )
                                  ? "new"
                                  : "neutral";
    return {
      informationStatus,
      toolCategory,
      succeeded: result?.success !== false,
      actualExecution:
        !toolUnavailable &&
        !["already_known", "repeated_redundant", "task_complete"].includes(
          informationStatus,
        ),
      errorCode,
      requestedToolAvailable: !toolUnavailable,
      cached: result?.cached === true,
      informationSource: result?.informationSource || null,
      validationStatus:
        toolCategory === "validation" ? result?.status || null : null,
      redundantRead:
        result?.reason === "same_revision_range_already_known"
          ? {
              path: result.path,
              revision: result.revision,
              range: result.requestedRange,
              coverage: result.coverage,
            }
          : null,
      informationSignature:
        result?.readSignature ||
        (toolCategory === "validation" || result?.success === false
          ? this.getInformationSignature(name, result)
          : null),
    };
  }

  getInformationSignature(name, result) {
    const error = result?.error;
    const errorCode = typeof error === "object" ? error?.code || "" : "";
    const errorMessage =
      typeof error === "string" ? error : error?.message || "";
    const outcome =
      result?.status || (result?.success === false ? "FAILED" : "OK");
    const runner = result?.runner?.name || result?.runner?.executable || "";
    const target =
      result?.scope?.target || result?.target || result?.requestedTarget || "";
    const projectRoot =
      result?.scope?.projectRoot || result?.projectRoot || ".";
    const validationKind = result?.validationKind || "";
    const changeVersion =
      this.agent.runChangeTracker?.current?.changeVersion ?? "";
    const summary = result?.summary || {};
    return `${name || "unknown"}:${outcome}:${validationKind}:${projectRoot}:${target}:${changeVersion}:${runner}:${summary.passed ?? ""}:${summary.failed ?? ""}:${errorCode}:${errorMessage}`.slice(
      0,
      1000,
    );
  }

  normalizeAgentError(error, fallbackCode = "TOOL_FAILED") {
    const source = error && typeof error === "object" ? error : {};
    const code = String(source.code || fallbackCode);
    const categoryByCode = {
      STALE_REVISION: "concurrency",
      REVISION_REQUIRED: "concurrency",
      OLD_TEXT_NOT_FOUND: "validation",
      AMBIGUOUS_MATCH: "validation",
      INVALID_ARGUMENT: "argument",
      UNKNOWN_TOOL: "capability",
      TOOL_DISABLED: "capability",
      TOOL_CALL_ID_CONFLICT: "protocol",
      RUN_ABORTED: "lifecycle",
      USER_ABORTED: "lifecycle",
      WORKSPACE_CHANGED: "lifecycle",
      CONTEXT_LENGTH_EXCEEDED: "context",
    };
    const retryByCode = {
      STALE_REVISION: "reread",
      OLD_TEXT_NOT_FOUND: "reread",
      AMBIGUOUS_MATCH: "replan",
      TOOL_CALL_ID_CONFLICT: "replan",
      CONTEXT_LENGTH_EXCEEDED: "compact",
      RUN_ABORTED: "abort",
      USER_ABORTED: "abort",
      WORKSPACE_CHANGED: "abort",
    };
    return {
      ...source,
      code,
      message: String(
        source.message ||
          (typeof error === "string" ? error : "Échec de l'outil."),
      ).slice(0, 2000),
      category: source.category || categoryByCode[code] || "filesystem",
      recoverable:
        source.recoverable ??
        ![
          "RUN_ABORTED",
          "USER_ABORTED",
          "WORKSPACE_CHANGED",
          "INTERNAL_ERROR",
        ].includes(code),
      retryStrategy: source.retryStrategy || retryByCode[code] || "replan",
    };
  }

  attachMeta(name, result) {
    const normalized =
      result?.success === false
        ? { ...result, error: this.normalizeAgentError(result.error) }
        : result;
    return { ...normalized, meta: this.getToolResultMeta(name, normalized) };
  }

  async executeToolCallInternal(call, executionContext = {}) {
    const name = call?.function?.name;
    const toolCallId = typeof call?.id === "string" ? call.id : "";

    const tool = this.agent.getTool(name);
    if (!tool) {
      const availableTools = this.agent.getAvailableToolNames?.() || [];
      console.info("[NCE Agent capability]", {
        tool: typeof name === "string" ? name : null,
        available: false,
        action: "rejected_unknown_tool",
      });
      return this.attachMeta(name, {
        success: false,
        error: {
          code: "UNKNOWN_TOOL",
          message:
            "The requested tool is not available in this environment. " +
            "Do not retry it. Use only the registered tools that are actually available.",
          requestedTool: name || null,
          availableTools,
        },
      });
    }

    if (!tool.enabled) {
      return this.attachMeta(name, {
        success: false,
        error: { code: "TOOL_DISABLED", message: `Outil désactivé : ${name}` },
      });
    }

    const permissions =
      this.agent.runConfig?.permissions ?? this.agent.permissions;
    if (permissions === "read" && !tool.readOnly) {
      return this.attachMeta(name, {
        success: false,
        error: {
          code: "TOOL_NOT_ALLOWED",
          message: `L'outil ${name} n'est pas autorisé dans ce mode.`,
        },
      });
    }

    if (!tool.readOnly) {
      if (
        executionContext.runId !== undefined &&
        (this.agent.stopRequested ||
          executionContext.runId !== this.agent.runId)
      ) {
        return this.attachMeta(name, {
          success: false,
          error: {
            code: "RUN_ABORTED",
            message: "Le run Agent associé à cette écriture n'est plus actif.",
          },
        });
      }
      const expectedRoot = this.agent.runConfig?.workspaceRoot;
      const currentRoot = this.agent.editor?.fileExplorer?.rootPath;
      if (
        typeof expectedRoot === "string" &&
        AgentPath.normalize(expectedRoot) !== AgentPath.normalize(currentRoot)
      ) {
        return this.attachMeta(name, {
          success: false,
          error: {
            code: "WORKSPACE_CHANGED",
            message: "Le workspace a changé depuis le démarrage du run Agent.",
          },
        });
      }
    }

    let args = {};
    try {
      args = this.agent.parseCanonicalToolArguments(call.function.arguments);
    } catch {
      return this.attachMeta(name, {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "Arguments JSON invalides.",
        },
      });
    }

    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return this.attachMeta(name, {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "Les arguments doivent être un objet.",
        },
      });
    }

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

    const writePayloadValidation = this.validateFileWritePayload(
      name,
      normalizedArgs,
    );
    if (!writePayloadValidation.valid) {
      const result = {
        success: false,
        error: writePayloadValidation.error,
      };
      this.debugTool(name, normalizedArgs, result, {
        rejectedBeforeExecution: true,
      });
      return this.attachMeta(name, result);
    }

    const validation = this.agent.validateTool(tool, normalizedArgs);
    if (!validation.valid) {
      const result = { success: false, error: validation.error };
      this.debugTool(name, normalizedArgs, result);
      return this.attachMeta(name, result);
    }

    const callbackContext = {
      sessionId: executionContext.sessionId ?? this.agent.currentSessionId,
      runId: executionContext.runId ?? this.agent.runId,
      toolCallId: toolCallId || null,
    };

    this.agent.safeInvokeCallback("onToolStart", [
      name,
      normalizedArgs,
      callbackContext,
    ]);

    try {
      const rawResult = await tool.execute(normalizedArgs, {
        editor: this.agent.editor,
        agent: this.agent,
        signal: this.agent.abortController?.signal,
      });
      if (rawResult?.success !== false) {
        this.agent.fileKnowledge.observeWrite(name, normalizedArgs, rawResult);
      }
      let result = this.limitResult(
        name,
        this.agent.normalizeToolResultForHistory(rawResult),
      );
      if (result?.success === false) {
        result = { ...result, error: this.normalizeAgentError(result.error) };
      }
      const meta = this.getToolResultMeta(name, result);
      if (
        name !== "read_file" &&
        [
          "new",
          "restored",
          "state_changed",
          "validation_progress",
          "error_discovered",
          "error_resolved",
        ].includes(meta.informationStatus)
      ) {
        this.agent.fileKnowledge.resetDuplicateReadSequence();
      }
      const toolResult =
        result && result.success === false
          ? { ...result, meta }
          : { success: true, result, meta };
      const callbackResult =
        result && result.success === false ? result : { success: true, result };

      this.debugTool(name, normalizedArgs, toolResult, {
        activePath: this.agent.editor?.tabManager?.activeFile?.path || null,
        activeTabId: this.agent.editor?.tabManager?.activeFile?.id || null,
      });

      this.agent.safeInvokeCallback("onToolEnd", [
        name,
        toolResult,
        callbackContext,
        callbackResult,
      ]);

      return toolResult;
    } catch (error) {
      const result = this.attachMeta(name, {
        success: false,
        error: {
          code: this.agent.isAbortError(error)
            ? "USER_ABORTED"
            : error?.code || "INTERNAL_ERROR",
          message: error?.message || String(error),
        },
      });
      this.debugTool(name, normalizedArgs, result, {
        activePath: this.agent.editor?.tabManager?.activeFile?.path || null,
        activeTabId: this.agent.editor?.tabManager?.activeFile?.id || null,
      });
      this.agent.safeInvokeCallback("onToolEnd", [
        name,
        result,
        callbackContext,
      ]);
      return result;
    }
  }
}

window.ToolExecutor = ToolExecutor;
