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
      return result;
    }

    const tool = this.agent.getTool(name);
    if (!tool) {
      return {
        success: false,
        error: {
          code: "TOOL_NOT_FOUND",
          message: `Outil inconnu : ${name || "(sans nom)"}`,
        },
      };
    }

    if (!tool.enabled) {
      return {
        success: false,
        error: { code: "TOOL_DISABLED", message: `Outil désactivé : ${name}` },
      };
    }

    const permissions =
      this.agent.runConfig?.permissions ?? this.agent.permissions;
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

    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "Les arguments doivent être un objet.",
        },
      };
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
      return result;
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
      const result = this.limitResult(
        this.agent.normalizeToolResultForHistory(rawResult),
      );
      const toolResult =
        result && result.success === false ? result : { success: true, result };
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
      const result = {
        success: false,
        error: {
          code: this.agent.isAbortError(error)
            ? "USER_ABORTED"
            : error?.code || "INTERNAL_ERROR",
          message: error?.message || String(error),
        },
      };
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
