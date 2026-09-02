class ModelClient {
  constructor(agent) {
    this.agent = agent;
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
      modelFallbackCount: 0,
      authenticationCancelledProviders: new Set(),
      blockedProviders: new Map(),
    };
    return this.agent.modelRequestState;
  }

  getModelDisplayName(config) {
    return config?.modelConfig?.name || config?.model || "Le modèle";
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
      configuredProvider === "openrouter"
        ? "OpenRouter"
        : configuredProvider;
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
    if (
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
      /(quota.{0,40}(exceeded|exhausted)|daily limit|free[._ -]?models?[._ -]?per[._ -]?day|usage limit|budget exceeded|available tokens?.{0,40}(exhausted|zero|none))/i.test(
        text,
      )
    ) {
      category = "QUOTA_EXHAUSTED";
    } else if (
      is429 &&
      /(model.{0,100}(rate.?limit|too many requests)|rate.?limit.{0,100}model)/.test(
        text,
      )
    ) {
      category = "MODEL_RATE_LIMITED";
    } else if (
      is429 &&
      (upstreamProvider || /upstream.{0,100}(rate.?limit|too many requests)/.test(text))
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
        "UNKNOWN_429",
        "MODEL_UNAVAILABLE",
        "NETWORK_ERROR",
      ].includes(category) || statusCode === 503;

    const providerGlobal = [
      "AUTH_ERROR",
      "PERMISSION_ERROR",
      "QUOTA_EXHAUSTED",
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
          : category === "QUOTA_EXHAUSTED"
            ? "Le quota disponible pour ce provider est épuisé."
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
      technicalMessage: classified.technicalMessage,
    });
  }

  emitModelStatus(event, config) {
    this.agent.callbacks.onModelStatus?.(event, {
      sessionId: config.sessionId ?? this.agent.currentSessionId,
      runId: config.runId ?? this.agent.runId,
    });
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
    if (Number.isFinite(config.maxTokens))
      payload.max_tokens = config.maxTokens;

    this.agent.agentProgress?.recordModelAttempt?.();

    const sanitizedProvider = { ...provider };
    delete sanitizedProvider.apiKey;

    if (typeof this.agent.api?.aiChat === "function") {
      const result = await this.agent.api.aiChat({
        provider: sanitizedProvider,
        payload,
      });
      return this.agent.recordModelPromptUsage(
        this.agent.unwrapModelTransportResult(result),
      );
    }
    if (typeof this.agent.api?.requestAI === "function") {
      const result = await this.agent.api.requestAI({
        provider: sanitizedProvider,
        payload,
      });
      return this.agent.recordModelPromptUsage(
        this.agent.unwrapModelTransportResult(result),
      );
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

      return this.agent.recordModelPromptUsage(await response.json());
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

  async requestModel(
    controller = this.agent.abortController,
    runConfig = this.agent.runConfig,
  ) {
    const config = runConfig || this.agent.createRunConfig();
    const state = this.getModelRequestState(config);
    let retryCount = 0;

    while (state.currentConfig) {
      const activeConfig = state.currentConfig;
      try {
        const result = await this.requestSingleModel(controller, activeConfig);
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
            replacementKey =
              await this.agent.callbacks.onAuthenticationRequired(classified, {
                sessionId: config.sessionId ?? this.agent.currentSessionId,
                runId: config.runId ?? this.agent.runId,
                providerId: activeConfig.providerId,
              });
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

        const retryDelay = this.agent.getModelRetryDelay(
          classified,
          retryCount,
        );
        const mayRetry =
          classified.retryable &&
          state.providerRetryCount <
            (config.maxProviderRetries ?? this.agent.maxProviderRetries) &&
          retryDelay <= (config.maxRetryDelayMs ?? this.agent.maxRetryDelayMs);

        if (mayRetry) {
          retryCount += 1;
          state.providerRetryCount += 1;
          this.agent.agentProgress?.recordModelRetry?.();
          this.emitModelStatus(
            {
              kind: "retry",
              classification: classified,
              delayMs: retryDelay,
              attempt: retryCount,
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

        const fallback = classified.fallbackRecommended
          ? this.agent.takeNextFallback(state, classified, config)
          : null;
        if (fallback) {
          const previous = activeConfig;
          state.currentConfig = fallback;
          state.modelFallbackCount += 1;
          this.agent.agentProgress?.recordModelFallback?.();
          retryCount = 0;
          this.agent.applyActiveModelConfig(config, fallback);
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
  }
}

window.ModelClient = ModelClient;
