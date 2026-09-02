class ToolExecutor {
  constructor(agent) {
    this.agent = agent;
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

  limitResult(result) {
    const maxContent = 4000;
    if (typeof result === "string")
      return this.agent.truncate(result, maxContent);
    if (!result || typeof result !== "object") return result;

    const limited = { ...result };
    for (const key of ["content", "beforeText", "afterText"]) {
      if (
        typeof limited[key] === "string" &&
        limited[key].length > maxContent
      ) {
        limited[key] = this.agent.truncate(limited[key], maxContent);
        limited.truncated = true;
      }
    }

    if (Array.isArray(limited.results) && limited.results.length > 100) {
      limited.results = limited.results.slice(0, 100);
      limited.truncated = true;
    }

    return limited;
  }

  getToolResultMeta(name, result) {
    const writeTools = new Set([
      "modify_file",
      "modify_active_file",
      "replace_text",
      "create_file",
      "write_file_chunk",
      "rename_file",
      "delete_file",
    ]);
    const readTools = new Set(["read_file", "read_active_file"]);
    const searchTools = new Set([
      "search_project_files",
      "search_active_file",
    ]);
    const navigationTools = new Set([
      "get_project_map",
      "list_project_files",
      "get_editor_context",
      "get_cursor",
      "read_selection",
    ]);
    const isValidationTool =
      /(?:^|_)(?:test|tests|build|lint|check|validate|validation|diagnostic|compile|typecheck)(?:_|$)/i.test(
        name || "",
      );
    const toolCategory =
      name === "task_complete"
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
    const informationStatus =
      toolCategory === "completion" && result?.success !== false
        ? "task_complete"
        : toolCategory === "validation" && result?.success === false
          ? "error_discovered"
          : toolCategory === "validation"
            ? "validation_progress"
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
                  : ["read", "search", "navigation"].includes(toolCategory)
                    ? "new"
                    : "neutral";
    return {
      informationStatus,
      toolCategory,
      actualExecution:
        !["already_known", "repeated_redundant", "task_complete"].includes(
          informationStatus,
        ),
      cached: result?.cached === true,
      informationSource: result?.informationSource || null,
      informationSignature:
        result?.readSignature ||
        (toolCategory === "validation" || result?.success === false
          ? this.getInformationSignature(name, result)
          : null),
    };
  }

  getInformationSignature(name, result) {
    const error = result?.error;
    const errorCode =
      typeof error === "object" ? error?.code || "" : "";
    const errorMessage =
      typeof error === "string" ? error : error?.message || "";
    const outcome = result?.success === false ? "failed" : "succeeded";
    return `${name || "unknown"}:${outcome}:${errorCode}:${errorMessage}`.slice(
      0,
      1000,
    );
  }

  attachMeta(name, result) {
    return { ...result, meta: this.getToolResultMeta(name, result) };
  }

  async executeToolCall(call, executionContext = {}) {
    const name = call?.function?.name;
    const toolCallId = typeof call?.id === "string" ? call.id : "";

    if (toolCallId && this.agent.executedToolCalls.has(toolCallId)) {
      return this.agent.executedToolCalls.get(toolCallId);
    }

    const activeFileTools = new Set([
      "read_active_file",
      "search_active_file",
      "modify_active_file",
      "replace_text",
    ]);

    if (
      activeFileTools.has(name) &&
      !this.agent.editor?.tabManager?.activeFile
    ) {
      const result = {
        success: false,
        error: {
          code: "NO_ACTIVE_FILE",
          message:
            "Aucun fichier n'est ouvert. Utilisez les outils workspace avec un chemin de fichier.",
        },
      };
      this.debugTool(name, {}, result);
      return this.attachMeta(name, result);
    }

    const tool = this.agent.getTool(name);
    if (!tool) {
      return this.attachMeta(name, {
        success: false,
        error: {
          code: "TOOL_NOT_FOUND",
          message: `Outil inconnu : ${name || "(sans nom)"}`,
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

    this.agent.callbacks.onToolStart?.(name, normalizedArgs, callbackContext);

    try {
      const rawResult = await tool.execute(normalizedArgs, {
        editor: this.agent.editor,
        agent: this.agent,
        signal: this.agent.abortController?.signal,
      });
      if (rawResult?.success !== false) {
        this.agent.fileKnowledge.observeWrite(name, normalizedArgs, rawResult);
      }
      const result = this.limitResult(
        this.agent.normalizeToolResultForHistory(rawResult),
      );
      const meta = this.getToolResultMeta(name, result);
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

      this.agent.callbacks.onToolEnd?.(
        name,
        toolResult,
        callbackContext,
        callbackResult,
      );

      if (toolCallId) this.agent.executedToolCalls.set(toolCallId, toolResult);
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
      this.agent.callbacks.onToolEnd?.(name, result, callbackContext);
      if (toolCallId) this.agent.executedToolCalls.set(toolCallId, result);
      return result;
    }
  }
}

window.ToolExecutor = ToolExecutor;
