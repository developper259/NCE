class AgentModelError extends Error {
  constructor(message, code = "MODEL_ERROR", category = code) {
    super(message);
    this.name = "AgentModelError";
    this.code = code;
    this.category = category;
    this.userMessage = message;
  }
}

function createToolArgumentParseError(parseError, argumentsLength) {
  // Engine diagnostics may contain source code or secrets. Keep only the
  // category and position in the JSON representation that failed parsing.
  const reason = String(parseError.message);
  const position = reason.match(/at position (\d+)/i)?.[1];
  const errorPosition = position === undefined ? null : Number(position);
  const incomplete =
    /^(?:unterminated string|unexpected end)/i.test(reason) ||
    errorPosition === argumentsLength;
  const error = new SyntaxError(
    incomplete ? "Incomplete JSON arguments" : "Malformed JSON arguments",
  );
  error.code = incomplete
    ? "TOOL_ARGUMENTS_TRUNCATED"
    : "TOOL_ARGUMENTS_MALFORMED";
  error.errorPosition = errorPosition;
  return error;
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
  const truncated =
    context.finishReason === "length" ||
    context.argumentErrorCode === "TOOL_ARGUMENTS_TRUNCATED" ||
    truncatedLargeWriteArguments;
  error.code = truncated
    ? "TOOL_ARGUMENTS_TRUNCATED"
    : context.argumentErrorCode === "TOOL_ARGUMENTS_MALFORMED"
      ? "TOOL_ARGUMENTS_MALFORMED"
      : "TOOL_CALL_FINALIZATION_FAILED";
  error.category = error.code;
  error.originalCode = "TOOL_CALL_FINALIZATION_FAILED";
  error.toolProtocolFailure = true;
  error.retryable = [
    "TOOL_ARGUMENTS_TRUNCATED", "TOOL_ARGUMENTS_MALFORMED",
  ].includes(error.code);
  error.errorPosition = context.errorPosition ?? null;
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
  error.userMessage = truncated
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
    argumentsLength: error.argumentsLength,
    errorPosition: error.errorPosition,
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
