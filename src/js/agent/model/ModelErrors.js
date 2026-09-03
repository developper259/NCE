class AgentModelError extends Error {
  constructor(message, code = "MODEL_ERROR", category = code) {
    super(message);
    this.name = "AgentModelError";
    this.code = code;
    this.category = category;
    this.userMessage = message;
  }
}

function createToolCallValidationError(
  agent,
  toolCall,
  toolCallIndex,
  reason,
  context = {},
) {
  const toolName = toolCall?.function?.name || "(inconnu)";
  const value = toolCall?.function?.arguments;
  const reasonText = String(reason || "format incompatible");
  const truncatedLargeWriteArguments =
    new Set(["create_file", "write_file_chunk"]).has(toolName) &&
    typeof value === "string" &&
    value.trimEnd().slice(-1) !== "}" &&
    /unterminated string|unexpected end(?: of json)?|end of (?:json )?input|incomplete json|json[^\n]{0,30}truncated|expected[^\n]{0,80}(?:property|delimiter|comma|position|end)/i.test(
      reasonText,
    );
  const error = new Error(
    `Tool call invalide pour ${toolName} : ${reasonText}.`,
  );
  error.name = "AgentToolCallValidationError";
  error.code = truncatedLargeWriteArguments
    ? "TOOL_ARGUMENTS_TRUNCATED"
    : "TOOL_CALL_FINALIZATION_FAILED";
  error.category = error.code;
  error.originalCode = "TOOL_CALL_FINALIZATION_FAILED";
  error.toolProtocolFailure = true;
  error.retryable = truncatedLargeWriteArguments;
  error.messageIndex = Number.isInteger(context.messageIndex)
    ? context.messageIndex
    : null;
  error.toolCallIndex = Number.isInteger(toolCallIndex) ? toolCallIndex : null;
  error.toolName = toolName;
  error.field = "function.arguments";
  error.valueType =
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  error.argumentsLength = typeof value === "string" ? value.length : null;
  error.argumentsLastCharacter =
    typeof value === "string" ? value.trimEnd().slice(-1) : null;
  error.reason = reasonText;
  error.source = context.source || "provider_response";
  error.runId = context.runId ?? agent?.runId;
  error.userMessage = truncatedLargeWriteArguments
    ? `Les arguments de ${toolName} ont été tronqués avant la fin du JSON. Aucun contenu partiel n'a été exécuté.`
    : `Le modèle a produit un appel invalide pour l'outil ${toolName}.`;
  console.error("[NCE Tool Call invalid]", {
    code: error.code,
    messageIndex: error.messageIndex,
    toolCallIndex: error.toolCallIndex,
    toolName,
    field: error.field,
    valueType: error.valueType,
    reason: error.reason,
    argumentsPreview: agent?.getSafeValuePreview?.(value),
    source: error.source,
    runId: error.runId,
    provider: context.provider || agent?.runConfig?.providerId || null,
    model: context.model || agent?.runConfig?.model || agent?.model || null,
  });
  return error;
}

function createMessageSerializationError(
  agent,
  messageIndex,
  toolCallIndex,
  field,
  value,
  reason,
  details = {},
) {
  const valueType =
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const error = new Error(
    `Impossible de sérialiser le message ${messageIndex}${Number.isInteger(toolCallIndex) ? `, tool call ${toolCallIndex}` : ""} pour le provider.`,
  );
  error.name = "AgentMessageSerializationError";
  error.code = "MESSAGE_SERIALIZATION_FAILED";
  error.category = "MESSAGE_SERIALIZATION_FAILED";
  error.retryable = false;
  error.fallbackRecommended = false;
  error.userMessage = error.message;
  error.messageIndex = messageIndex;
  error.toolCallIndex = Number.isInteger(toolCallIndex) ? toolCallIndex : null;
  error.field = field;
  error.valueType = valueType;
  error.toolName = details.toolName || null;
  error.reason = reason || "format incompatible";
  error.valuePreview = agent?.getSafeValuePreview?.(value);
  error.runId = details.runId ?? agent?.runId;
  error.technicalMessage = `${field} contient une valeur de type ${valueType}${reason ? ` (${reason})` : ""}.`;
  console.error("[NCE Agent serialization]", {
    code: error.code,
    messageIndex: error.messageIndex,
    toolCallIndex: error.toolCallIndex,
    toolName: error.toolName,
    field: error.field,
    valueType: error.valueType,
    reason: error.reason,
    argumentsPreview: error.valuePreview,
    runId: error.runId,
    provider: agent?.runConfig?.providerId || agent?.provider?.id || null,
    model: agent?.runConfig?.model || agent?.model || null,
  });
  return error;
}

window.AgentModelError = AgentModelError;
window.createToolCallValidationError = createToolCallValidationError;
window.createMessageSerializationError = createMessageSerializationError;
