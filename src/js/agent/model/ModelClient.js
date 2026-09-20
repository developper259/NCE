class ModelClient {
  constructor(agent) {
    this.agent = agent;
    this.requestAttempts = new Map();
  }

  normalizeModelUsage(usage) {
    if (!usage || typeof usage !== "object") return null;

    const normalizeTokenCount = (value) => {
      if (value == null || value === "") return null;
      const count = Number(value);
      return Number.isFinite(count) && count >= 0 ? count : null;
    };
    const inputTokens = normalizeTokenCount(
      usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens,
    );
    const outputTokens = normalizeTokenCount(
      usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens,
    );

    const providedTotal = normalizeTokenCount(
      usage.total_tokens ?? usage.totalTokens,
    );
    if (inputTokens == null && outputTokens == null && providedTotal == null) {
      return null;
    }
    const totalTokens =
      providedTotal != null
        ? providedTotal
        : inputTokens != null && outputTokens != null
          ? inputTokens + outputTokens
          : null;

    return {
      inputTokens,
      outputTokens,
      totalTokens,
    };
  }

  emitModelRequestEnd(
    requestId,
    attempt,
    config,
    status,
    result,
    startedAt,
    error = null,
  ) {
    const endedAt = Date.now();
    const durationMs = endedAt - startedAt;

    const normalizedUsage = this.normalizeModelUsage(
      result?.usage || result?.data?.usage,
    );

    const finishReason =
      this.agent.normalizeFinishReason?.(result, result?.message, []) || null;

    this.agent.emitEvent("model:request:end", {
      sessionId: config.sessionId ?? this.agent.currentSessionId,
      runId: config.runId,
      requestId,
      attempt,
      providerId: config.providerId,
      model: config.model,
      status,
      finishReason,
      usage: normalizedUsage,
      startedAt,
      endedAt,
      durationMs,
      error: error ? this.agent.normalizeObservableError(error) : null,
    });
  }

  allocateLogicalRequestId(config, phase = "main") {
    if (this.agent.pendingModelRequestId) {
      const requestId = this.agent.pendingModelRequestId;
      this.agent.pendingModelRequestId = null;
      return requestId;
    }
    this.agent.modelRequestCounter += 1;
    return `${config.runId}:${phase}:${this.agent.modelRequestCounter}`;
  }

  nextAttempt(requestId) {
    const attempt = (this.requestAttempts.get(requestId) || 0) + 1;
    this.requestAttempts.set(requestId, attempt);
    return attempt;
  }

  clearRequestAttempts(requestId) {
    if (requestId) this.requestAttempts.delete(requestId);
  }

  getModelRequestState(config) {
    if (
      this.agent.modelRequestState &&
      this.agent.modelRequestState.runId === config.runId &&
      this.agent.modelRequestState.sessionId === config.sessionId
    ) {
      return this.agent.modelRequestState;
    }

    const currentConfig = {
      ...config,
      provider: config.provider ? { ...config.provider } : null,
    };
    const key = `${config.providerId}:${config.model}`;
    this.agent.modelRequestState = {
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
      retryCountsByCandidate: new Map(),
      totalRetryCount: 0,
      contextRecoveries: new Map(),
      modelFallbackCount: 0,
      authenticationCancelledProviders: new Set(),
      blockedProviders: new Map(),
      previousOutputUsage: [],
    };
    return this.agent.modelRequestState;
  }

  getModelDisplayName(config) {
    return config?.modelConfig?.name || config?.model || "Le modèle";
  }

  buildProviderHeaders({ provider, apiKey = null, sessionId = null } = {}) {
    const isValidHeaderName = (name) =>
      /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": "nce-agent/0.0.1",
    };
    const requestHeaders = provider?.requestHeaders;
    const isPlainHeaders =
      requestHeaders &&
      typeof requestHeaders === "object" &&
      !Array.isArray(requestHeaders);

    if (isPlainHeaders) {
      for (const [name, value] of Object.entries(requestHeaders)) {
        if (
          typeof name !== "string" ||
          !name.trim() ||
          !isValidHeaderName(name.trim()) ||
          value === null ||
          value === undefined ||
          (typeof value !== "string" &&
            typeof value !== "number" &&
            typeof value !== "boolean" &&
            typeof value !== "bigint")
        ) {
          continue;
        }
        headers[name] = String(value);
      }
    }

    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === "authorization") delete headers[name];
    }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const sessionHeader = provider?.sessionHeader;
    if (
      typeof sessionHeader === "string" &&
      sessionHeader.trim() &&
      isValidHeaderName(sessionHeader.trim()) &&
      sessionId !== null &&
      sessionId !== undefined &&
      String(sessionId)
    ) {
      headers[sessionHeader.trim()] = String(sessionId);
    }

    return headers;
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
    const providerLabel =
      configuredProvider === "openrouter" ? "OpenRouter" : configuredProvider;
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

    const is429 = statusCode === 429 || /\b429\b/.test(text);
    let category = "UNKNOWN";
    if (code === "CONTEXT_LENGTH_EXCEEDED") {
      category = "CONTEXT_LENGTH_EXCEEDED";
    } else if (
      /context.{0,30}(length|window)|too many tokens|maximum context|token limit/.test(
        text,
      )
    ) {
      category = "CONTEXT_LENGTH_EXCEEDED";
    } else if (
      /(401|403|unauthorized|invalid api key|api key|auth|authentication)/.test(
        text,
      )
    ) {
      category = "AUTH_ERROR";
    } else if (
      is429 &&
      /(insufficient credits?|credits? exhausted|credit balance|not enough credits?|payment required)/.test(
        text,
      )
    ) {
      category = "CREDITS_EXHAUSTED";
    } else if (
      is429 &&
      /(account|monthly|provider|organization).{0,60}(quota|allowance).{0,30}(exhausted|exceeded)|quota.{0,30}(account|provider).{0,30}(exhausted|exceeded)/i.test(text)
    ) {
      category = "PROVIDER_QUOTA_EXHAUSTED";
    } else if (
      is429 &&
      /(quota.{0,40}(exceeded|exhausted)|daily limit|free[._ -]?models?[._ -]?per[._ -]?day|usage limit|budget exceeded|available tokens?.{0,40}(exhausted|zero|none))/i.test(text)
    ) {
      category = "TEMPORARY_QUOTA_LIMIT";
    } else if (
      is429 &&
      /(model.{0,100}(rate.?limit|too many requests)|rate.?limit.{0,100}model)/.test(
        text,
      )
    ) {
      category = "MODEL_RATE_LIMITED";
    } else if (
      is429 &&
      (upstreamProvider ||
        /upstream.{0,100}(rate.?limit|too many requests)/.test(text))
    ) {
      category = "UPSTREAM_RATE_LIMITED";
    } else if (is429 && /(rate.?limit|too many requests)/.test(text)) {
      category = "RATE_LIMITED";
    } else if (is429) {
      category = "UNKNOWN_429";
    } else if (/(404|not found|model.*not found|unknown model)/.test(text)) {
      category = "MODEL_NOT_FOUND";
    } else if (
      /(503|temporarily unavailable|overloaded|capacity|busy|try again)/.test(
        text,
      )
    ) {
      category = "MODEL_UNAVAILABLE";
    } else if (
      /(invalid request|bad request|malformed|schema|tool_call)/.test(text)
    ) {
      category = "INVALID_REQUEST";
    } else if (
      /(timeout|timed out|network|fetch|connection|websocket)/.test(text)
    ) {
      category = "NETWORK_ERROR";
    }

    const retryable =
      [
        "RATE_LIMITED",
        "TEMPORARY_QUOTA_LIMIT",
        "UNKNOWN_429",
        "MODEL_UNAVAILABLE",
        "NETWORK_ERROR",
      ].includes(category) || statusCode === 503;

    const failureOrigin =
      category === "CONTEXT_LENGTH_EXCEEDED" ? "context" : "provider";

    const providerGlobal = [
      "AUTH_ERROR",
      "PERMISSION_ERROR",
      "QUOTA_EXHAUSTED",
      "PROVIDER_QUOTA_EXHAUSTED",
      "CREDITS_EXHAUSTED",
    ].includes(category);
    const scope = providerGlobal
      ? "provider"
      : category === "MODEL_RATE_LIMITED"
        ? "model"
        : category === "UPSTREAM_RATE_LIMITED"
          ? "upstream"
          : is429
            ? "unknown"
            : null;

    const fallbackRecommended =
      [
        "MODEL_NOT_FOUND",
        "MODEL_UNAVAILABLE",
      "QUOTA_EXHAUSTED",
      "PROVIDER_QUOTA_EXHAUSTED",
        "CREDITS_EXHAUSTED",
        "MODEL_RATE_LIMITED",
        "UPSTREAM_RATE_LIMITED",
        "RATE_LIMITED",
        "UNKNOWN_429",
        "AUTH_ERROR",
      ].includes(category) || retryable;

    const userMessage =
      category === "AUTH_ERROR"
        ? `L'authentification du provider ${providerLabel} a échoué.`
        : category === "MODEL_NOT_FOUND"
          ? `Le modèle ${modelName} n'est pas disponible sur ${providerLabel}.`
          : category === "CREDITS_EXHAUSTED"
            ? `Les crédits ${providerLabel} disponibles sont épuisés.`
            : category === "PROVIDER_QUOTA_EXHAUSTED"
              ? "Le quota disponible pour ce provider est épuisé."
              : category === "TEMPORARY_QUOTA_LIMIT"
                ? "La limite de quota est temporaire. Réessaie dans quelques instants."
              : category === "MODEL_RATE_LIMITED"
                ? `Le modèle ${modelName} est temporairement limité.`
                : category === "UPSTREAM_RATE_LIMITED"
                  ? `Le service amont de ${providerLabel} est temporairement limité.`
                  : category === "RATE_LIMITED"
                    ? `${providerLabel} limite temporairement les requêtes. Réessaie dans quelques instants.`
                    : category === "UNKNOWN_429"
                      ? `${providerLabel} a refusé temporairement la requête avec une erreur 429.`
                      : category === "CONTEXT_LENGTH_EXCEEDED"
                        ? `Le contexte est trop large pour ${modelName}.`
                        : category === "MODEL_UNAVAILABLE"
                          ? `Le modèle ${modelName} est actuellement indisponible.`
                          : `Le provider ${providerLabel} a renvoyé une erreur inattendue.`;

    return {
      provider: configuredProvider,
      upstreamProvider,
      model: modelName,
      statusCode,
      code,
      category,
      retryable,
      fallbackRecommended,
      providerGlobal,
      scope,
      retryAfterMs,
      technicalMessage,
      userMessage,
      response,
      error,
      failureOrigin,
    };
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
      scope: classified.scope,
      providerGlobal: classified.providerGlobal,
      retryAfterMs: classified.retryAfterMs,
      retryCount: counters.retryCount || 0,
      fallbackCount: counters.fallbackCount || 0,
      technicalMessage: this.agent.sanitizeObservableText(
        classified.technicalMessage,
      ),
    });
  }

  emitModelStatus(event, config) {
    const classification = event?.classification
      ? {
          ...event.classification,
          technicalMessage: this.agent.sanitizeObservableText(
            event.classification.technicalMessage,
          ),
          userMessage: this.agent.sanitizeObservableText(
            event.classification.userMessage,
          ),
          error: event.classification.error
            ? this.agent.normalizeObservableError(event.classification.error)
            : null,
          response: undefined,
        }
      : event?.classification;
    this.agent.safeInvokeCallback("onModelStatus", [
      { ...event, classification },
      {
        sessionId: config.sessionId ?? this.agent.currentSessionId,
        runId: config.runId ?? this.agent.runId,
      },
    ]);
  }

  async requestSingleModel(controller, config) {
    const provider = config.provider || this.agent.provider;
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
    const providerTools =
      config.supportsTools !== false && provider.supportsTools !== false
        ? this.agent.getOpenAITools()
        : [];

    const modelContext = this.agent.buildModelContext(this.agent.messages, {
      ...config,
      toolSchemas: providerTools,
      trackCumulative: true,
    });
    const providerMessages =
      this.agent.normalizeMessagesForProvider(modelContext);
    if (config.contextState?.runtimeDirective) {
      providerMessages.push({
        role: "system",
        content: `[NCE CURRENT RUNTIME DIRECTIVE]\n${config.contextState.runtimeDirective}`,
      });
    }
    const liveEditorContext = await this.agent.getContext();
    providerMessages.push({
      role: "system",
      content: `CONTEXTE EDITEUR EPHEMERE (état actuel) :\n${JSON.stringify(liveEditorContext)}`,
    });
    this.agent.contextManager?.updateModelFileVisibility?.(providerMessages);
    const payload = {
      model: config.model,
      messages: providerMessages,
      stream: false,
    };

    if (providerTools.length) {
      payload.tools = providerTools;
      if (
        config.supportsToolChoice !== false &&
        provider.supportsToolChoice !== false
      ) {
        payload.tool_choice = this.agent.resolveToolChoice(
          this.agent.messages[this.agent.messages.length - 1]?.content || "",
        );
      }
    }

    if (Number.isFinite(config.temperature))
      payload.temperature = config.temperature;
    const responseBudget =
      this.agent.responseBudgetEstimator.estimateResponseBudget({
        agent: this.agent,
        model: config,
        runtimeState: config.contextState || {},
        previousUsage: this.agent.modelRequestState?.previousOutputUsage || [],
      });
    const messageTokens = this.agent.estimateTokens(providerMessages);
    const toolSchemaTokens = providerTools.length
      ? this.agent.estimateTokens(providerTools)
      : 0;
    const toolChoiceTokens = payload.tool_choice
      ? this.agent.estimateTokens(payload.tool_choice)
      : 0;
    const promptTokens = messageTokens + toolSchemaTokens + toolChoiceTokens;
    const safetyMargin = Math.max(
      0,
      config.responseBudget?.contextCompactionSafetyMarginTokens || 0,
    );
    const contextAllowance = Number.isFinite(responseBudget.contextWindow)
      ? responseBudget.contextWindow - promptTokens - safetyMargin
      : responseBudget.effectiveMaxOutputTokens;
    if (Number.isFinite(responseBudget.contextWindow) && contextAllowance < 1) {
      throw Object.assign(
        new Error("Le contexte doit être compacté avant la requête."),
        {
          code: "CONTEXT_LENGTH_EXCEEDED",
        },
      );
    }
    payload.max_tokens = Math.max(
      1,
      Math.min(responseBudget.effectiveMaxOutputTokens, contextAllowance),
    );
    config.effectiveMaxOutputTokens = payload.max_tokens;
    this.agent.lastContextMetrics = {
      ...(this.agent.lastContextMetrics || {}),
      messageTokens,
      toolSchemaTokens,
      toolChoiceTokens,
      estimatedInputTokens: promptTokens,
      requestedOutputTokens: payload.max_tokens,
      safetyMarginTokens: safetyMargin,
      contextWindow: responseBudget.contextWindow,
      hardOutputLimit: responseBudget.hardOutputLimit,
    };

    this.agent.agentProgress?.recordModelAttempt?.();

    const sanitizedProvider = { ...provider };
    delete sanitizedProvider.apiKey;
    const sessionId = config.sessionId ?? this.agent.currentSessionId ?? null;

    // Logical requestId is owned by requestModel(); attempt is global per requestId.
    const requestId =
      config._observabilityRequestId ||
      this.allocateLogicalRequestId(config, "main");
    // All local context/budget checks above have passed. Count the attempt only
    // now, when a provider transport is genuinely about to start.
    const currentAttempt = this.nextAttempt(requestId);

    const requestStartTime = Date.now();

    // Emit model:request:start event
    this.agent.emitEvent("model:request:start", {
      sessionId,
      runId: config.runId,
      requestId,
      attempt: currentAttempt,
      providerId: config.providerId,
      model: config.model,
      phase: "main",
      estimatedPromptTokens: promptTokens,
      contextWindow: responseBudget.contextWindow,
      requestedOutputTokens: payload.max_tokens,
      startedAt: requestStartTime,
    });

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), 60000);

    try {
      if (typeof this.agent.api?.aiChat === "function") {
        const result = await this.agent.api.aiChat({
          provider: sanitizedProvider,
          payload,
          sessionId,
        });
        const unwrapped = this.agent.unwrapModelTransportResult(result);
        this.recordPreviousOutputUsage(unwrapped);
        this.emitModelRequestEnd(
          requestId,
          currentAttempt,
          config,
          "success",
          unwrapped,
          requestStartTime,
        );
        return this.agent.recordModelPromptUsage(unwrapped, {
          sessionId,
          runId: config.runId,
          requestId,
        });
      }
      if (typeof this.agent.api?.requestAI === "function") {
        const result = await this.agent.api.requestAI({
          provider: sanitizedProvider,
          payload,
          sessionId,
        });
        const unwrapped = this.agent.unwrapModelTransportResult(result);
        this.recordPreviousOutputUsage(unwrapped);
        this.emitModelRequestEnd(
          requestId,
          currentAttempt,
          config,
          "success",
          unwrapped,
          requestStartTime,
        );
        return this.agent.recordModelPromptUsage(unwrapped, {
          sessionId,
          runId: config.runId,
          requestId,
        });
      }

      const headers = this.buildProviderHeaders({
        provider,
        apiKey: provider.apiKey,
        sessionId,
      });
      const url = `${provider.baseURL.replace(/\/+$/, "")}`;
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

      const result = await response.json();
      this.recordPreviousOutputUsage(result);
      this.emitModelRequestEnd(
        requestId,
        currentAttempt,
        config,
        "success",
        result,
        requestStartTime,
      );
      return this.agent.recordModelPromptUsage(result, {
        sessionId,
        runId: config.runId,
        requestId,
      });
    } catch (error) {
      const isTimeoutAbort =
        error?.name === "AbortError" &&
        !controller?.signal?.aborted &&
        timeoutController.signal.aborted;
      const isControllerAborted =
        this.agent.isAbortError?.(error) ||
        (error?.name === "AbortError" && controller?.signal?.aborted);

      this.emitModelRequestEnd(
        requestId,
        currentAttempt,
        config,
        isControllerAborted ? "aborted" : "failed",
        null,
        requestStartTime,
        error,
      );

      if (isTimeoutAbort) {
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

  recordPreviousOutputUsage(result) {
    const normalized = this.normalizeModelUsage(
      result?.usage || result?.data?.usage,
    );
    const tokens = normalized?.outputTokens;
    const history = this.agent.modelRequestState?.previousOutputUsage;
    if (Array.isArray(history) && Number.isFinite(tokens) && tokens >= 0) {
      history.push(tokens);
      if (history.length > 8) history.splice(0, history.length - 8);
    }
  }

  async requestModel(
    controller = this.agent.abortController,
    runConfig = this.agent.runConfig,
  ) {
    const config = runConfig || this.agent.createRunConfig();
    const state = this.getModelRequestState(config);
    state.currentConfig = {
      ...state.currentConfig,
      contextState: config.contextState,
    };
    let retryCount = 0;

    // One logical requestId for the whole retry/fallback chain.
    const requestId = this.allocateLogicalRequestId(config, "main");
    state.activeRequestId = requestId;
    this.agent.currentModelRequestId = requestId;

    const withObservability = (activeConfig) => ({
      ...activeConfig,
      _observabilityRequestId: requestId,
    });

    try {
      while (state.currentConfig) {
        const activeConfig = state.currentConfig;
        try {
          const result = await this.requestSingleModel(
            controller,
            withObservability(activeConfig),
          );
          this.agent.applyActiveModelConfig(config, activeConfig);
          return result;
        } catch (error) {
          if (this.agent.isAbortError(error) && controller?.signal?.aborted)
            throw error;
          if (error?.code === "MESSAGE_SERIALIZATION_FAILED") throw error;

          const classified = this.classifyModelError(error, error?.response, {
            provider: activeConfig.provider,
            providerId: activeConfig.providerId,
            model: activeConfig.model,
            modelConfig: activeConfig.modelConfig,
          });

          state.failures.push(classified);
          if (classified.statusCode === 429) {
            this.agent.agentProgress?.recordModel429?.();
          }
          if (classified.providerGlobal) {
            state.blockedProviders.set(
              activeConfig.providerId,
              classified.category,
            );
          }
          this.debugModelError(classified, {
            retryCount,
            fallbackCount: state.modelFallbackCount,
          });

          if (
            classified.category === "AUTH_ERROR" &&
            !state.authenticationCancelledProviders.has(
              activeConfig.providerId,
            ) &&
            typeof this.agent.callbacks.onAuthenticationRequired === "function"
          ) {
            let replacementKey = "";
            try {
              replacementKey = await this.agent.safeInvokeCallback(
                "onAuthenticationRequired",
                [
                  classified,
                  {
                    sessionId: config.sessionId ?? this.agent.currentSessionId,
                    runId: config.runId ?? this.agent.runId,
                    providerId: activeConfig.providerId,
                  },
                ],
                { awaitResult: true, fallback: "" },
              );
            } catch (authenticationError) {
              console.error(
                "[NCE Agent model] impossible de remplacer la clé API",
                authenticationError,
              );
            }
            this.agent.assertRunActive(config.runId, controller);
            if (typeof replacementKey === "string" && replacementKey.trim()) {
              const apiKey = replacementKey.trim();
              activeConfig.provider = { ...activeConfig.provider, apiKey };
              if (config.providerId === activeConfig.providerId) {
                config.provider = { ...config.provider, apiKey };
              }
              state.currentConfig = activeConfig;
              state.blockedProviders.delete(activeConfig.providerId);
              retryCount = 0;
              continue;
            }
            state.authenticationCancelledProviders.add(activeConfig.providerId);
          }

          const candidateKey = `${activeConfig.providerId}:${activeConfig.model}`;
          const candidateRetries =
            state.retryCountsByCandidate.get(candidateKey) || 0;
          if (
            classified.category === "CONTEXT_LENGTH_EXCEEDED" &&
            (state.contextRecoveries.get(candidateKey) || 0) < 1
          ) {
            classified.failureOrigin = "context";
            classified.contextRecoveryTried = true;
            classified.fallbackRecommended = false;
            state.contextRecoveries.set(candidateKey, 1);
            this.agent.contextManager.compactionState.compactionArmed = true;
            activeConfig.contextCompaction = {
              ...(activeConfig.contextCompaction || {}),
              enabled: true,
              triggerRatio: 0,
              hardRatio: 0,
              criticalRatio: 0,
              recentIterations: 1,
            };
            config.contextCompaction = { ...activeConfig.contextCompaction };
            this.agent.agentProgress.metrics.contextRecoveries =
              (this.agent.agentProgress.metrics.contextRecoveries || 0) + 1;
            continue;
          }
          if (
            classified.category === "CONTEXT_LENGTH_EXCEEDED" &&
            (state.contextRecoveries.get(candidateKey) || 0) >= 1
          ) {
            classified.failureOrigin = "context";
            classified.contextRecoveryTried = true;
            classified.fallbackRecommended = true;
          }
          const retryDelay = this.agent.getModelRetryDelay(
            classified,
            candidateRetries,
          );
          const totalRetryCap = Math.max(
            1,
            (config.maxProviderRetries ?? this.agent.maxProviderRetries) *
              ((config.maxModelFallbacks ?? this.agent.maxModelFallbacks) + 1),
          );
          const mayRetry =
            classified.retryable &&
            candidateRetries <
              (config.maxProviderRetries ?? this.agent.maxProviderRetries) &&
            state.totalRetryCount < totalRetryCap &&
            retryDelay <=
              (config.maxRetryDelayMs ?? this.agent.maxRetryDelayMs);

          if (mayRetry) {
            retryCount += 1;
            state.providerRetryCount += 1;
            state.totalRetryCount += 1;
            state.retryCountsByCandidate.set(candidateKey, candidateRetries + 1);
            this.agent.agentProgress?.recordModelRetry?.();

            const nextAttempt =
              (this.requestAttempts.get(requestId) || 0) + 1;

            // Emit model:retry only when the same provider/model will be retried.
            this.agent.emitEvent("model:retry", {
              sessionId: config.sessionId ?? this.agent.currentSessionId,
              runId: config.runId,
              requestId,
              providerId: activeConfig.providerId,
              model: activeConfig.model,
              attempt: nextAttempt,
              reason: classified.category,
              errorCode: classified.code,
              delayMs: retryDelay,
            });

            this.emitModelStatus(
              {
                kind: "retry",
                classification: classified,
                delayMs: retryDelay,
                attempt: nextAttempt,
                userMessage: `${classified.userMessage} Nouvelle tentative dans ${this.agent.formatRetryDelay(retryDelay)}…`,
              },
              config,
            );
            await this.agent.waitForModelRetry(retryDelay, controller);
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

          const fallback =
            this.agent.shouldFallbackModelForFailure(classified) &&
            classified.fallbackRecommended
              ? this.agent.takeNextFallback(state, classified, config)
              : null;
          if (fallback) {
            const previous = activeConfig;
            state.currentConfig = fallback;
            state.modelFallbackCount += 1;
            this.agent.agentProgress?.recordModelFallback?.();
            retryCount = 0;
            this.agent.applyActiveModelConfig(config, fallback);

            // Emit model:fallback only on a real provider/model switch.
            this.agent.emitEvent("model:fallback", {
              sessionId: config.sessionId ?? this.agent.currentSessionId,
              runId: config.runId,
              requestId,
              fromProvider: previous.providerId,
              fromModel: previous.model,
              toProvider: fallback.providerId,
              toModel: fallback.model,
              reason: classified.category,
            });

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

          throw this.agent.createFinalModelError(classified, state);
        }
      }

      throw this.agent.createFinalModelError(
        this.classifyModelError(new Error("Aucun modèle IA configuré."), null, {
          provider: config.provider,
          providerId: config.providerId,
          model: config.model,
          modelConfig: config.modelConfig,
        }),
        this.agent.modelRequestState,
      );
    } finally {
      this.clearRequestAttempts(requestId);
      if (this.agent.currentModelRequestId === requestId) {
        this.agent.currentModelRequestId = null;
      }
      if (state.activeRequestId === requestId) {
        state.activeRequestId = null;
      }
    }
  }
}

window.ModelClient = ModelClient;
