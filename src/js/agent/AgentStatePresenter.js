const AgentStatePresenter = {
  ICONS: Object.freeze({
    loading: "fi fi-rr-refresh",
    context: "fi fi-rr-document",
    unavailable: "fi fi-rr-cloud-disabled",
    warning: "fi fi-rr-triangle-warning",
    error: "fi fi-rr-cross-circle",
    retry: "fi fi-rr-rotate-right",
    configure: "fi fi-rr-key",
    details: "fi fi-rr-angle-small-down",
  }),

  MAX_DETAIL_LENGTH: 4000,

  redact(value) {
    if (typeof value !== "string" || !value) return "";
    const redacted = value
      .replace(/\bAuthorization\s*:\s*(?:Bearer\s+)?[^\s,;"']+/gi, "Authorization: [redacted]")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "sk-[redacted]")
      .replace(/\b[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted-token]")
      .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|password)\s*[:=]\s*)([^\s,;"']+)/gi,
        "$1[redacted]");
    return redacted.slice(0, this.MAX_DETAIL_LENGTH);
  },

  text(value) {
    return typeof value === "string" ? value.trim() : "";
  },

  normalizeError(error, { providerName = "" } = {}) {
    const source = error && typeof error === "object" ? error : {};
    const code = this.text(source.code);
    const category = this.text(source.category) || code;
    const statusCode = Number.isFinite(Number(source.statusCode))
      ? Number(source.statusCode)
      : null;
    const provider = this.redact(
      this.text(source.providerName) ||
      this.text(source.provider?.name) ||
      this.text(source.providerId) ||
      this.text(source.provider?.id) ||
      providerName,
    );
    const model = this.redact(this.text(source.model) || this.text(source.modelId));
    return {
      code,
      category,
      statusCode,
      provider,
      model,
      retryable: source.retryable !== false,
      userMessage: this.redact(
        this.text(source.userMessage) ||
        this.text(source.message) ||
        "La requête vers le modèle a échoué.",
      ),
      technicalMessage: this.redact(this.text(source.technicalMessage)),
      providerRetryCount: Number.isFinite(Number(source.providerRetryCount))
        ? Number(source.providerRetryCount) : 0,
      modelFallbackCount: Number.isFinite(Number(source.modelFallbackCount))
        ? Number(source.modelFallbackCount) : 0,
      failureCount: Array.isArray(source.failures) ? source.failures.length : 0,
    };
  },

  detailsFromInfo(info) {
    const details = [];
    if (!info) return details;
    if (info.code) details.push({ label: "Code", value: info.code });
    if (info.category && info.category !== info.code)
      details.push({ label: "Catégorie", value: info.category });
    if (info.provider) details.push({ label: "Fournisseur", value: info.provider });
    if (info.model) details.push({ label: "Modèle", value: info.model });
    if (info.statusCode) details.push({ label: "Statut HTTP", value: String(info.statusCode) });
    if (info.providerRetryCount)
      details.push({ label: "Nouvelles tentatives fournisseur", value: String(info.providerRetryCount) });
    if (info.modelFallbackCount)
      details.push({ label: "Basculements de modèle", value: String(info.modelFallbackCount) });
    if (info.failureCount)
      details.push({ label: "Échecs enregistrés", value: String(info.failureCount) });
    if (info.technicalMessage)
      details.push({ label: "Message technique", value: info.technicalMessage });
    return details;
  },

  classifyRequestError(info, { canRetry = false, retrying = false, providerRequiresKey = false } = {}) {
    const category = info?.category || info?.code || "UNKNOWN";
    const retryAction = canRetry
      ? {
          id: "retry",
          label: retrying ? "Nouvelle tentative…" : "Réessayer",
          icon: this.ICONS.retry,
          primary: true,
          disabled: retrying,
        }
      : null;
    const configureAction = providerRequiresKey
      ? {
          id: "configure",
          label: "Configurer la clé",
          icon: this.ICONS.configure,
          primary: true,
          disabled: retrying,
        }
      : null;
    const base = {
      variant: "error",
      icon: this.ICONS.error,
      live: "assertive",
      hint: "",
      actions: [],
      details: this.detailsFromInfo(info),
    };

    if (["AUTH_ERROR", "PERMISSION_ERROR"].includes(category)) {
      return {
        ...base,
        variant: "unavailable",
        icon: this.ICONS.unavailable,
        title: "L'agent n'est pas disponible",
        description: info?.provider
          ? `Le fournisseur ${info.provider} refuse l'authentification. Vérifiez la clé API associée.`
          : "Le fournisseur refuse l'authentification. Vérifiez la clé API associée.",
        hint: "La requête n'a pas été envoyée au modèle.",
        actions: [configureAction, retryAction].filter(Boolean),
      };
    }

    if ([
      "ALL_MODELS_UNAVAILABLE", "MODEL_UNAVAILABLE", "MODEL_NOT_FOUND",
      "NO_CAPACITY", "QUOTA_EXHAUSTED", "CREDITS_EXHAUSTED", "NO_TOKENS_AVAILABLE",
    ].includes(category)) {
      return {
        ...base,
        variant: "unavailable",
        icon: this.ICONS.unavailable,
        title: "L'agent n'est pas disponible",
        description: info?.provider
          ? `Aucun modèle utilisable pour ${info.provider} pour le moment.`
          : "Aucun modèle utilisable pour le moment.",
        hint: "Sélectionnez un autre fournisseur ou modèle, puis réessayez.",
        actions: [retryAction].filter(Boolean),
      };
    }

    if (["MODEL_RATE_LIMITED", "UPSTREAM_RATE_LIMITED", "RATE_LIMITED", "UNKNOWN_429"].includes(category)) {
      return {
        ...base,
        variant: "warning",
        icon: this.ICONS.warning,
        title: "L'agent est temporairement limité",
        description: "Le fournisseur limite les requêtes ou le quota est atteint.",
        hint: "Patientez un instant avant de réessayer.",
        actions: [retryAction].filter(Boolean),
      };
    }

    if (category === "CONTEXT_LENGTH_EXCEEDED") {
      return {
        ...base,
        variant: "warning",
        icon: this.ICONS.warning,
        title: "Le contexte est trop volumineux",
        description: "La conversation dépasse la taille acceptée par le modèle.",
        hint: "Démarrez une nouvelle conversation ou retirez du contexte.",
        actions: [],
      };
    }

    if (["NETWORK_ERROR", "TIMEOUT"].includes(category)) {
      return {
        ...base,
        variant: "error",
        icon: this.ICONS.error,
        title: "La requête n'a pas abouti",
        description: "Le fournisseur n'a pas répondu. Vérifiez la connexion puis réessayez.",
        actions: [retryAction].filter(Boolean),
      };
    }

    if (category === "INVALID_REQUEST") {
      return {
        ...base,
        variant: "warning",
        icon: this.ICONS.warning,
        title: "La requête a été refusée",
        description: info?.userMessage || "Le fournisseur a refusé la requête.",
        hint: "Vérifiez le modèle sélectionné et le contenu de la demande.",
        actions: [retryAction].filter(Boolean),
      };
    }

    return {
      ...base,
      title: "Une erreur est survenue",
      description: info?.userMessage || "La requête vers le modèle a échoué.",
      actions: [retryAction].filter(Boolean),
    };
  },

  classifyConversationError({ reason = "", retrying = false } = {}) {
    const retryAction = {
      id: "retry",
      label: retrying ? "Nouvelle tentative…" : "Réessayer",
      icon: this.ICONS.retry,
      primary: true,
      disabled: retrying,
    };
    const base = {
      icon: this.ICONS.error,
      variant: "error",
      live: "assertive",
      title: "Impossible de charger la conversation",
      hint: "",
      actions: [],
      details: [],
    };
    if (reason === "INSECURE_STORAGE_BACKEND") {
      return {
        ...base,
        variant: "warning",
        icon: this.ICONS.warning,
        description: "Le stockage sécurisé des conversations n'est pas disponible sur ce système.",
        hint: "Les conversations restent dans cette session ; aucune nouvelle tentative ne changera le stockage.",
        actions: [],
      };
    }
    if (reason === "ENCRYPTION_UNAVAILABLE") {
      return {
        ...base,
        description: "Le chiffrement local est indisponible. La conversation n'a pas pu être relue.",
        hint: "Vérifiez le trousseau du système, puis réessayez.",
        actions: [retryAction],
        details: [{ label: "Cause", value: "ENCRYPTION_UNAVAILABLE" }],
      };
    }
    if (reason === "NOT_FOUND") {
      return {
        ...base,
        variant: "warning",
        icon: this.ICONS.warning,
        description: "Cette conversation n'a pas été retrouvée dans le stockage local.",
        hint: "L'historique local n'a pas été supprimé.",
        actions: [retryAction],
        details: [{ label: "Cause", value: "NOT_FOUND" }],
      };
    }
    return {
      ...base,
      description: "La conversation n'a pas pu être relue depuis le stockage local.",
      hint: "L'historique local est conservé sur le disque.",
      actions: [retryAction],
      details: [{ label: "Cause", value: reason || "STORE_ERROR" }],
    };
  },

  classifyContextError({ reason = "", labels = [] } = {}) {
    const details = labels.length
      ? [{ label: "Éléments concernés", value: labels.join(", ") }]
      : [];
    if (reason === "WORKSPACE_CHANGED") {
      return {
        variant: "warning",
        icon: this.ICONS.warning,
        live: "polite",
        title: "Le contexte n'a pas pu être chargé",
        description: "Le workspace a changé pendant la préparation du contexte.",
        hint: "L'agent continue avec le contexte disponible.",
        actions: [],
        details,
      };
    }
    return {
      variant: "warning",
      icon: this.ICONS.warning,
      live: "polite",
      title: "Impossible de charger le contexte",
      description: "Certains éléments du contexte n'ont pas pu être lus.",
      hint: "L'agent continue avec le contexte disponible.",
      actions: [],
      details: reason ? [{ label: "Cause", value: reason }, ...details] : details,
    };
  },

  createThinkingState() {
    return {
      variant: "loading",
      icon: this.ICONS.loading,
      live: "polite",
      title: "L'agent réfléchit…",
      description: "Analyse de votre demande et préparation de la réponse.",
      hint: "",
      actions: [],
      details: [],
    };
  },
};
