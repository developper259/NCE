class ContextManager {
  constructor(agent) {
    this.agent = agent;
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

  getContextCompactionConfig(config = {}) {
    const source = {
      ...this.agent.contextCompaction,
      ...(config.contextCompaction || {}),
    };
    const number = (value, fallback, minimum = 0) =>
      Number.isFinite(value) ? Math.max(minimum, value) : fallback;
    const softLimitRatio = Math.min(1, number(source.softLimitRatio, 0.4));
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
      warmIterations: Math.max(
        Math.floor(number(source.recentIterations, 2, 1)),
        Math.floor(number(source.warmIterations, 6, 1)),
      ),
      maxPreviouslyReadFiles: Math.max(
        1,
        Math.floor(number(source.maxPreviouslyReadFiles, 100, 1)),
      ),
      softLimitRatio,
      hardLimitRatio,
      criticalLimitRatio,
      safetyMarginTokens: Math.floor(number(source.safetyMarginTokens, 8192)),
      charsPerToken: number(source.charsPerToken, 4, 1),
      logMetrics: source.logMetrics !== false,
      debugDecisions: source.debugDecisions === true,
    };
  }

  estimateTokens(
    value,
    charsPerToken = this.agent.contextCompaction.charsPerToken,
  ) {
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

  getContextBudget(config, options) {
    const contextWindow = Number.isFinite(config.contextWindow)
      ? Math.max(1, Math.floor(config.contextWindow))
      : null;
    const outputReserve = Number.isFinite(config.maxTokens)
      ? Math.max(0, Math.floor(config.maxTokens))
      : 0;
    const budgetKnown = contextWindow !== null;
    return {
      contextWindow,
      outputReserve,
      budgetKnown,
      inputBudget: budgetKnown
        ? Math.max(
            1,
            contextWindow - outputReserve - options.safetyMarginTokens,
          )
        : null,
    };
  }

  getContextToolMetadata(toolCall, toolMessage = null) {
    const name = toolCall?.function?.name || "";
    const args = this.parseContextJSON(toolCall?.function?.arguments) || {};
    const resultRoot = this.parseContextJSON(toolMessage?.content);
    const result = resultRoot?.result ?? resultRoot ?? {};
    const success = resultRoot?.success !== false && result?.success !== false;
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
    const noNewInformation =
      result?.alreadyKnown === true || result?.noNewInformation === true;
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
      noNewInformation,
      readKey,
      searchKey,
    };
  }

  getContextTokenBreakdown(messages = [], toolSchemas = [], charsPerToken = 4) {
    const breakdown = {
      systemPrompt: 0,
      runtimeMessages: 0,
      userMessages: 0,
      assistantMessages: 0,
      reasoning: 0,
      toolCalls: 0,
      readResults: 0,
      searchResults: 0,
      projectMaps: 0,
      listings: 0,
      writeResults: 0,
      otherToolResults: 0,
      toolSchemas:
        Array.isArray(toolSchemas) && toolSchemas.length
          ? this.estimateTokens(toolSchemas, charsPerToken)
          : 0,
    };

    const toolNames = new Map();
    let sawPrimarySystem = false;
    for (const message of messages) {
      if (message?.role === "assistant" && Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (call?.id) toolNames.set(call.id, call?.function?.name || "");
        }
      }
    }

    const reads = new Set(["read_file", "read_active_file"]);
    const searches = new Set(["search_project_files", "search_active_file"]);
    const writes = new Set([
      "modify_file",
      "modify_active_file",
      "replace_text",
      "create_file",
      "write_file_chunk",
      "rename_file",
    ]);

    for (const message of messages) {
      let tokens = this.estimateTokens(message, charsPerToken);
      let reasoningTokens = 0;
      if (
        message?.role === "assistant" &&
        Object.prototype.hasOwnProperty.call(message, "reasoning")
      ) {
        reasoningTokens = this.estimateTokens(message.reasoning, charsPerToken);
        const withoutReasoning = { ...message };
        delete withoutReasoning.reasoning;
        tokens = this.estimateTokens(withoutReasoning, charsPerToken);
      }

      if (message?.role === "system") {
        const key = sawPrimarySystem ? "runtimeMessages" : "systemPrompt";
        breakdown[key] += tokens;
        sawPrimarySystem = true;
      } else if (message?.role === "user") {
        breakdown.userMessages += tokens;
      } else if (message?.role === "assistant") {
        if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
          breakdown.toolCalls += tokens;
        } else {
          breakdown.assistantMessages += tokens;
        }
        breakdown.reasoning += reasoningTokens;
      } else if (message?.role === "tool") {
        const name = toolNames.get(message.tool_call_id) || "";
        if (reads.has(name)) breakdown.readResults += tokens;
        else if (searches.has(name)) breakdown.searchResults += tokens;
        else if (name === "get_project_map") breakdown.projectMaps += tokens;
        else if (name === "list_project_files") breakdown.listings += tokens;
        else if (writes.has(name)) breakdown.writeResults += tokens;
        else breakdown.otherToolResults += tokens;
      }
    }

    return breakdown;
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
      "write_file_chunk",
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
          "previousRevision",
          "appendedChars",
          "totalChars",
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

  compactWriteToolCallForModel(toolCall) {
    const writeTools = new Set(["create_file", "write_file_chunk"]);
    const name = toolCall?.function?.name || "";
    if (!writeTools.has(name)) return toolCall;

    const args = this.parseContextJSON(toolCall?.function?.arguments);
    if (!args || typeof args !== "object") return toolCall;

    const compactArgs = {};
    for (const key of [
      "path",
      "newPath",
      "expectedRevision",
      "revision",
      "nearLine",
      "overwrite",
    ]) {
      if (args[key] !== undefined) compactArgs[key] = args[key];
    }

    for (const key of [
      "content",
      "oldText",
      "newText",
      "text",
      "expectedText",
    ]) {
      if (typeof args[key] === "string") {
        compactArgs[`${key}Characters`] = args[key].length;
      }
    }

    compactArgs.contentOmitted = true;
    return {
      ...toolCall,
      function: {
        ...toolCall.function,
        arguments: JSON.stringify(compactArgs),
      },
    };
  }

  buildModelContext(messages = this.agent.messages, config = {}) {
    const options = this.getContextCompactionConfig(config);
    const toolSchemas = Array.isArray(config.toolSchemas)
      ? config.toolSchemas
      : [];
    const toolSchemaTokens = toolSchemas.length
      ? this.estimateTokens(toolSchemas, options.charsPerToken)
      : 0;
    const { contextWindow, outputReserve, budgetKnown, inputBudget } =
      this.getContextBudget(config, options);

    const estimatedFullMessageTokens = this.estimateTokens(
      messages,
      options.charsPerToken,
    );
    const estimatedFullTokens = estimatedFullMessageTokens + toolSchemaTokens;
    const initialUsageRatio = budgetKnown
      ? estimatedFullTokens / inputBudget
      : null;
    const pressureLevel = !budgetKnown
      ? "conservative"
      : initialUsageRatio >= options.criticalLimitRatio
        ? "critical"
        : initialUsageRatio >= options.hardLimitRatio
          ? "hard"
          : initialUsageRatio >= options.softLimitRatio
            ? "moderate"
            : "light";

    if (!options.enabled) {
      const modelMessages = messages.map((message) => ({ ...message }));
      const estimatedModelMessageTokens = this.estimateTokens(
        modelMessages,
        options.charsPerToken,
      );
      const tokenBreakdown = this.getContextTokenBreakdown(
        modelMessages,
        toolSchemas,
        options.charsPerToken,
      );
      const metrics = {
        fullMessages: messages.length,
        modelMessages: modelMessages.length,
        estimatedFullMessageTokens,
        estimatedModelMessageTokens,
        estimatedFullTokens,
        estimatedModelTokens: estimatedModelMessageTokens + toolSchemaTokens,
        messageTokens: estimatedModelMessageTokens,
        toolSchemaTokens,
        totalEstimatedInputTokens:
          estimatedModelMessageTokens + toolSchemaTokens,
        systemPromptTokens: tokenBreakdown.systemPrompt,
        tokenBreakdown,
        contextWindow,
        maxOutputTokens: config.maxOutputTokens ?? null,
        outputReserve,
        safetyMarginTokens: options.safetyMarginTokens,
        inputBudget,
        budgetKnown,
        usageRatio:
          initialUsageRatio === null
            ? null
            : Number(initialUsageRatio.toFixed(3)),
        level: pressureLevel,
        disabled: true,
        readKnowledge: this.agent.fileKnowledge?.getMetrics?.() || null,
        runtime: this.agent.agentProgress?.getMetrics?.() || null,
      };
      if (config.trackCumulative === true) {
        this.agent.cumulativeEstimatedPromptTokens +=
          metrics.estimatedModelTokens;
        metrics.cumulativeEstimatedPromptTokens =
          this.agent.cumulativeEstimatedPromptTokens;
        metrics.cumulativeActualPromptTokens =
          this.agent.cumulativeActualPromptTokens;
      }
      this.agent.lastContextMetrics = metrics;
      return modelMessages;
    }

    const state = config.contextState;
    const hasCurrentState =
      state &&
      (state.writesSucceeded > 0 ||
        state.pendingValidation === true ||
        state.lastModificationError ||
        state.largeWrite?.active === true ||
        state.fileKnowledge?.files?.length > 0 ||
        state.fileKnowledge?.projectStructureRevision > 0 ||
        state.fileKnowledge?.workspaceContentRevision > 0 ||
        state.progress?.phase !== "discover" ||
        state.progress?.awaitingProgress === true);
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
    const warmExchangeStart = Math.max(
      0,
      exchangeCount - options.warmIterations,
    );
    const firstHotIndex =
      entries.find(
        (entry) =>
          entry.kind === "tool_exchange" &&
          entry.exchangeIndex >= hotExchangeStart,
      )?.start ?? messages.length;
    const firstWarmIndex =
      entries.find(
        (entry) =>
          entry.kind === "tool_exchange" &&
          entry.exchangeIndex >= warmExchangeStart,
      )?.start ?? firstHotIndex;

    const readTools = new Set(["read_file", "read_active_file"]);
    const searchTools = new Set(["search_project_files", "search_active_file"]);
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
      "write_file_chunk",
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
        (entry) => entry.kind === "message" && entry.message?.role === "user",
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
      compactedToolCalls: 0,
      removedResolvedErrors: 0,
      removedObsoleteRuntimeMessages: 0,
      removedForBudget: 0,
      invalidToolExchanges: 0,
      removedOldReads: 0,
      removedOldSearches: 0,
      removedOldProjectMaps: 0,
      removedOldListings: 0,
      summarizedReadFiles: 0,
      omittedReadFiles: 0,
    };
    const previouslyReadFiles = new Map();
    const toolTypes = {};

    for (const entry of entries) {
      if (entry.kind !== "tool_exchange") continue;
      for (const tool of entry.tools) {
        const name = tool.name || "unknown";
        toolTypes[name] = (toolTypes[name] || 0) + 1;
      }
    }

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      entry.recent = entry.start >= firstHotIndex;
      entry.tier = entry.recent
        ? "HOT"
        : entry.start >= firstWarmIndex
          ? "WARM"
          : "COLD";
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
          String(message.content || "").startsWith("[NCE CURRENT TASK STATE]")
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
          if (tool.noNewInformation) {
            duplicateCount += 1;
            toolIsDroppable = true;
          } else if (tool.path && laterWrites.has(tool.path)) {
            staleReadCount += 1;
            toolIsDroppable = true;
          } else if (latestReads.has(tool.readKey)) {
            duplicateCount += 1;
            toolIsDroppable = true;
          } else {
            latestReads.add(tool.readKey);
          }
        }
        if (searchTools.has(tool.name) && tool.success) {
          if (tool.noNewInformation) {
            duplicateCount += 1;
            toolIsDroppable = true;
          } else if (latestSearches.has(tool.searchKey)) {
            duplicateCount += 1;
            toolIsDroppable = true;
          } else {
            latestSearches.add(tool.searchKey);
          }
        }
        if (navigationTools.has(tool.name) && tool.success) {
          const navigationKey = `${tool.name}:${tool.path || tool.searchKey}`;
          if (tool.noNewInformation) {
            duplicateCount += 1;
            toolIsDroppable = true;
          } else if (latestNavigation.has(navigationKey)) {
            duplicateCount += 1;
            toolIsDroppable = true;
          } else {
            latestNavigation.add(navigationKey);
          }
        }
        if (toolIsDroppable) droppableToolCount += 1;
      }

      if (droppableToolCount === entry.tools.length && staleReadCount > 0) {
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
        entry.tools.some((tool) => writeTools.has(tool.name) && tool.success)
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
        const names = new Set(entry.tools.map((tool) => tool.name));
        if (entry.tier === "COLD") {
          entry.keep = false;
          entry.reasons.push("cold_navigation");
          if (names.has("get_project_map")) counters.removedOldProjectMaps += 1;
          if (names.has("list_project_files")) counters.removedOldListings += 1;
          if (!names.has("get_project_map") && !names.has("list_project_files"))
            counters.removedOldListings += 1;
        } else {
          entry.reasons.push(entry.recent ? "recent" : "navigation_result");
        }
      } else if (entry.tools.some((tool) => searchTools.has(tool.name))) {
        entry.priority = 40;
        if (entry.tier === "COLD") {
          entry.keep = false;
          entry.reasons.push("cold_search");
          counters.removedOldSearches += 1;
        } else {
          entry.reasons.push(entry.recent ? "recent" : "search_result");
        }
      } else if (entry.tools.some((tool) => readTools.has(tool.name))) {
        entry.priority = 50;
        if (entry.tier === "COLD") {
          entry.keep = false;
          entry.reasons.push("cold_read_summarized");
          counters.removedOldReads += 1;
          for (const tool of entry.tools) {
            if (readTools.has(tool.name) && tool.path) {
              previouslyReadFiles.set(tool.path, {
                path: tool.path,
                ...(tool.revision ? { revision: tool.revision } : {}),
              });
            }
          }
        } else {
          entry.reasons.push(entry.recent ? "recent" : "current_file_read");
        }
      } else {
        entry.reasons.push(entry.recent ? "recent" : "tool_result");
      }
    }

    for (const entry of entries) {
      if (!entry.keep || entry.critical || entry.recent) continue;
      if (
        pressureLevel === "moderate" &&
        entry.kind === "message" &&
        ["assistant", "system"].includes(entry.message?.role)
      ) {
        entry.keep = false;
        entry.reasons.push("adaptive_moderate");
      } else if (
        ["hard", "critical"].includes(pressureLevel) &&
        ((entry.kind === "message" &&
          ["assistant", "system"].includes(entry.message?.role)) ||
          entry.priority <= 40)
      ) {
        entry.keep = false;
        entry.reasons.push(`adaptive_${pressureLevel}`);
      } else if (
        ["hard", "critical"].includes(pressureLevel) &&
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
        if (
          Object.prototype.hasOwnProperty.call(message, "reasoning") &&
          !(config.modelConfig?.requiresReasoningReplay && entry.tier === "HOT")
        ) {
          delete message.reasoning;
        }
        return [message];
      }

      const assistant = {
        ...entry.assistant,
        tool_calls: entry.compactResults
          ? entry.calls.map((call) => this.compactWriteToolCallForModel(call))
          : entry.calls.map((call) => ({
              ...call,
              function: { ...call.function },
            })),
      };
      if (
        Object.prototype.hasOwnProperty.call(assistant, "reasoning") &&
        !(config.modelConfig?.requiresReasoningReplay && entry.tier === "HOT")
      ) {
        delete assistant.reasoning;
      }
      if (trackMetrics && entry.compactResults) {
        counters.compactedToolCalls += entry.calls.filter(
          (call, index) =>
            assistant.tool_calls[index]?.function?.arguments !==
            call?.function?.arguments,
        ).length;
      }

      const toolById = new Map(
        entry.toolMessages.map((message) => [message.tool_call_id, message]),
      );
      const callById = new Map(entry.calls.map((call) => [call.id, call]));
      const results = entry.toolMessages.map((original) => {
        const call = callById.get(original.tool_call_id);
        const compactedContent =
          entry.compactResults || entry.metadataOnly
            ? this.compactToolResultForModel(
                call.function.name,
                original.content,
                {
                  metadataOnly: entry.metadataOnly,
                },
              )
            : original.content;
        if (trackMetrics && compactedContent !== original.content) {
          counters.compactedToolResults += 1;
        }
        return { ...original, content: compactedContent };
      });
      return [assistant, ...results];
    };

    const render = (trackMetrics = false) => {
      const rendered = entries.flatMap((entry) =>
        renderEntry(entry, trackMetrics),
      );
      if (previouslyReadFiles.size > 0) {
        const allFiles = [...previouslyReadFiles.values()];
        const files = allFiles.slice(0, options.maxPreviouslyReadFiles);
        counters.summarizedReadFiles = files.length;
        counters.omittedReadFiles = allFiles.length - files.length;
        const summary = {
          role: "system",
          content: `[NCE PREVIOUSLY READ FILES]\n${JSON.stringify({ files, omittedCount: counters.omittedReadFiles })}`,
        };
        const insertionIndex = rendered[0]?.role === "system" ? 1 : 0;
        rendered.splice(insertionIndex, 0, summary);
      }
      return rendered;
    };

    let modelMessages = render();
    let estimatedModelTokens = this.estimateTokens(
      modelMessages,
      options.charsPerToken,
    );
    if (inputBudget && estimatedModelTokens + toolSchemaTokens > inputBudget) {
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

    if (inputBudget && estimatedModelTokens + toolSchemaTokens > inputBudget) {
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
            this.estimateTokens(renderEntry(entry), options.charsPerToken),
          ]),
      );
      let projectedTokens = estimatedModelTokens + toolSchemaTokens;
      for (const entry of candidates) {
        if (projectedTokens <= inputBudget) break;
        entry.keep = false;
        entry.reasons.push("input_budget");
        counters.removedForBudget += 1;
        projectedTokens -= entryTokenCosts.get(entry) || 0;
      }
    }

    counters.compactedToolResults = 0;
    counters.compactedToolCalls = 0;
    modelMessages = render(true);
    const preservedReasoning = modelMessages.filter(
      (message) =>
        message?.role === "assistant" &&
        Object.prototype.hasOwnProperty.call(message, "reasoning"),
    ).length;
    counters.removedReasoningMessages = Math.max(
      0,
      messages.filter(
        (message) =>
          message?.role === "assistant" &&
          Object.prototype.hasOwnProperty.call(message, "reasoning"),
      ).length - preservedReasoning,
    );

    const estimatedModelMessageTokens = this.estimateTokens(
      modelMessages,
      options.charsPerToken,
    );
    estimatedModelTokens = estimatedModelMessageTokens + toolSchemaTokens;
    const usageRatio = budgetKnown ? estimatedModelTokens / inputBudget : null;
    const tokenBreakdown = this.getContextTokenBreakdown(
      modelMessages,
      toolSchemas,
      options.charsPerToken,
    );

    const metrics = {
      fullMessages: messages.length,
      modelMessages: modelMessages.length,
      estimatedFullTokens,
      estimatedFullMessageTokens,
      estimatedModelTokens,
      estimatedModelMessageTokens,
      messageTokens: estimatedModelMessageTokens,
      toolSchemaTokens,
      totalEstimatedInputTokens: estimatedModelTokens,
      systemPromptTokens: tokenBreakdown.systemPrompt,
      tokenBreakdown,
      toolTypes,
      ...counters,
      contextWindow,
      maxOutputTokens: config.maxOutputTokens ?? null,
      outputReserve,
      safetyMarginTokens: options.safetyMarginTokens,
      inputBudget,
      budgetKnown,
      initialUsageRatio:
        initialUsageRatio === null
          ? null
          : Number(initialUsageRatio.toFixed(3)),
      usageRatio: usageRatio === null ? null : Number(usageRatio.toFixed(3)),
      level: pressureLevel,
      budgetExceeded: budgetKnown && estimatedModelTokens > inputBudget,
      cumulativeEstimatedPromptTokens:
        this.agent.cumulativeEstimatedPromptTokens,
      cumulativeActualPromptTokens: this.agent.cumulativeActualPromptTokens,
      readKnowledge: this.agent.fileKnowledge?.getMetrics?.() || null,
      runtime: this.agent.agentProgress?.getMetrics?.() || null,
    };

    if (config.trackCumulative === true) {
      this.agent.cumulativeEstimatedPromptTokens += estimatedModelTokens;
      metrics.cumulativeEstimatedPromptTokens =
        this.agent.cumulativeEstimatedPromptTokens;
    }

    for (const entry of entries) {
      entry.classification = entry.critical ? "CRITICAL" : entry.tier || "COLD";
    }

    this.agent.lastContextMetrics = metrics;
    if (options.logMetrics) console.info("[NCE Agent context]", metrics);
    if (options.logMetrics) {
      console.info("[NCE Agent context breakdown]", tokenBreakdown);
    }
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

  normalizeToolContentForProvider(value, messageIndex) {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return "";
    try {
      const serialized = JSON.stringify(
        this.agent.normalizeToolResultForHistory(value, "content"),
      );
      if (typeof serialized !== "string") throw new TypeError("résultat vide");
      return serialized;
    } catch (error) {
      throw this.agent.createMessageSerializationError(
        messageIndex,
        null,
        "content",
        value,
        error?.message || "JSON non sérialisable",
      );
    }
  }

  normalizeMessagesForProvider(messages = []) {
    if (!Array.isArray(messages)) {
      throw this.agent.createMessageSerializationError(
        -1,
        null,
        "messages",
        messages,
        "un tableau est requis",
      );
    }

    return messages.map((message, messageIndex) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        throw this.agent.createMessageSerializationError(
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
          throw this.agent.createMessageSerializationError(
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
              throw this.agent.createMessageSerializationError(
                messageIndex,
                toolCallIndex,
                "tool_calls.function",
                toolCall?.function,
                "un objet function est requis",
              );
            }

            const toolName = toolCall.function.name;
            if (typeof toolCall.id !== "string" || !toolCall.id.trim()) {
              throw this.agent.createMessageSerializationError(
                messageIndex,
                toolCallIndex,
                "tool_calls.id",
                toolCall.id,
                "un identifiant non vide est requis",
                { toolName },
              );
            }

            if (typeof toolName !== "string" || !toolName.trim()) {
              throw this.agent.createMessageSerializationError(
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
                arguments: this.agent.normalizeToolArgumentsForProvider(
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
}

window.ContextManager = ContextManager;
