function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.prototype.toString.call(value) === "[object Object]";
}

function assertJsonSafeArguments(
  value,
  path = "function.arguments",
  seen = new Set(),
) {
  if (value === null) return;
  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") return;
  if (valueType === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError(`${path} contient un nombre non fini`);
  }
  if (
    valueType === "undefined" ||
    valueType === "function" ||
    valueType === "symbol" ||
    valueType === "bigint"
  ) {
    throw new TypeError(`${path} contient une valeur ${valueType}`);
  }
  if (seen.has(value)) {
    throw new TypeError(`${path} contient une référence circulaire`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertJsonSafeArguments(entry, `${path}[${index}]`, seen),
    );
    seen.delete(value);
    return;
  }
  if (!isPlainObject(value)) {
    throw new TypeError(`${path} contient un objet complexe non autorisé`);
  }
  for (const [key, entry] of Object.entries(value)) {
    assertJsonSafeArguments(entry, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function repairJsonStringControlCharacters(raw) {
  let inString = false;
  let escaped = false;
  let repaired = "";
  const escapes = { 8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r" };
  for (const character of raw) {
    if (escaped) {
      repaired += character;
      escaped = false;
    } else if (inString && character === "\\") {
      repaired += character;
      escaped = true;
    } else if (character === '"') {
      inString = !inString;
      repaired += character;
    } else if (inString && character.charCodeAt(0) <= 31) {
      const code = character.charCodeAt(0);
      repaired += escapes[code] || `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      repaired += character;
    }
  }
  return repaired;
}

function parseCanonicalToolArguments(value, metrics = null) {
  if (value === null || value === undefined || value === "") return {};
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (initialError) {
      if (metrics) metrics.toolArgumentRepairAttempts++;
      const repaired = repairJsonStringControlCharacters(value);
      try {
        if (repaired === value) throw initialError;
        parsed = JSON.parse(repaired);
        if (metrics) metrics.toolArgumentRepairSuccesses++;
      } catch (parseError) {
        throw createToolArgumentParseError(parseError, repaired.length);
      }
    }
  }
  if (!isPlainObject(parsed)) {
    throw new TypeError("les arguments doivent représenter un objet JSON");
  }
  assertJsonSafeArguments(parsed);
  return parsed;
}

function normalizeToolArgumentsForProvider(
  value,
  messageIndex,
  toolCallIndex,
  toolName = null,
  agent = null,
) {
  try {
    return JSON.stringify(parseCanonicalToolArguments(value));
  } catch (error) {
    if (agent?.createMessageSerializationError) {
      throw agent.createMessageSerializationError(
        messageIndex,
        toolCallIndex,
        "function.arguments",
        value,
        error?.message || "JSON non sérialisable",
        { toolName },
      );
    }
    throw error;
  }
}

function finalizeToolCall(
  toolCall,
  toolCallIndex = 0,
  context = {},
  agent = null,
) {
  try {
    if (!isPlainObject(toolCall))
      throw new TypeError("tool_call doit être un objet");
    if (typeof toolCall.id !== "string" || !toolCall.id.trim()) {
      throw new TypeError("id manquant ou invalide");
    }
    if (!isPlainObject(toolCall.function)) {
      throw new TypeError("function doit être un objet");
    }
    if (
      typeof toolCall.function.name !== "string" ||
      !toolCall.function.name.trim()
    ) {
      throw new TypeError("function.name manquant ou invalide");
    }
    const args = parseCanonicalToolArguments(
      toolCall.function.arguments,
      agent?.agentProgress?.metrics,
    );
    return {
      id: toolCall.id.trim(),
      type: "function",
      function: {
        name: toolCall.function.name.trim(),
        arguments: JSON.stringify(args),
      },
    };
  } catch (error) {
    if (agent?.createToolCallValidationError) {
      throw agent.createToolCallValidationError(
        toolCall,
        toolCallIndex,
        error?.message,
        {
          ...context,
          argumentErrorCode: error.code,
          errorPosition: error.errorPosition,
        },
      );
    }
    throw error;
  }
}

function finalizeToolCalls(toolCalls, context = {}, agent = null) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((toolCall, toolCallIndex) =>
    finalizeToolCall(toolCall, toolCallIndex, context, agent),
  );
}

class ToolSerialization {
  constructor(agent) {
    this.agent = agent;
  }
  isPlainObject(value) {
    return isPlainObject(value);
  }
  assertJsonSafeArguments(
    value,
    path = "function.arguments",
    seen = new Set(),
  ) {
    return assertJsonSafeArguments(value, path, seen);
  }
  parseCanonicalToolArguments(value) {
    return parseCanonicalToolArguments(value, this.agent?.agentProgress?.metrics);
  }
  finalizeToolCall(toolCall, toolCallIndex = 0, context = {}) {
    return finalizeToolCall(toolCall, toolCallIndex, context, this.agent);
  }
  finalizeToolCalls(toolCalls, context = {}) {
    return finalizeToolCalls(toolCalls, context, this.agent);
  }
  normalizeToolArgumentsForProvider(
    value,
    messageIndex,
    toolCallIndex,
    toolName = null,
  ) {
    return normalizeToolArgumentsForProvider(
      value,
      messageIndex,
      toolCallIndex,
      toolName,
      this.agent,
    );
  }
}

window.ToolSerialization = ToolSerialization;
window.isPlainObject = isPlainObject;
window.assertJsonSafeArguments = assertJsonSafeArguments;
window.parseCanonicalToolArguments = parseCanonicalToolArguments;
window.repairJsonStringControlCharacters = repairJsonStringControlCharacters;
window.finalizeToolCall = finalizeToolCall;
window.finalizeToolCalls = finalizeToolCalls;
window.normalizeToolArgumentsForProvider = normalizeToolArgumentsForProvider;
