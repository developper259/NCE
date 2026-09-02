class ToolRegistry {
  constructor(agent) {
    this.agent = agent;
    this.tools = new Map();
  }

  registerTool(name, definition) {
    if (
      typeof name !== "string" ||
      !name.trim() ||
      !definition ||
      typeof definition.execute !== "function"
    ) {
      throw new TypeError(`Définition invalide pour l'outil "${name}".`);
    }

    const parameters = definition.parameters || {
      type: "object",
      properties: {},
    };

    if (
      !this.agent.isPlainObject(parameters) ||
      parameters.type !== "object" ||
      !this.agent.isPlainObject(parameters.properties || {})
    ) {
      throw new TypeError(
        `Le schema de l'outil "${name}" doit avoir une racine object JSON Schema.`,
      );
    }

    const tool = {
      name,
      description: definition.description || "",
      parameters,
      execute: definition.execute,
      readOnly:
        definition.readOnly === true ||
        (typeof AgentAI !== "undefined" &&
          AgentAI.readOnlyTools?.includes(name)),
      codeOnly: definition.codeOnly === true,
      enabled: definition.enabled !== false,
    };

    this.tools.set(name, tool);
    return tool;
  }

  unregisterTool(name) {
    return this.tools.delete(name);
  }

  getTool(name) {
    return this.tools.get(name);
  }

  validateTool(tool, args) {
    const schema = tool.parameters || {};
    if (schema.type && schema.type !== "object") {
      return { valid: false, error: "Schéma d'arguments invalide." };
    }

    for (const key of schema.required || []) {
      if (args[key] === undefined || args[key] === null) {
        return {
          valid: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: `Argument obligatoire manquant : ${key}`,
          },
        };
      }
    }

    for (const [key, rule] of Object.entries(schema.properties || {})) {
      if (args[key] === undefined) continue;
      const value = args[key];
      const coercedNumber =
        rule.type === "integer" || rule.type === "number"
          ? Number(value)
          : null;
      const typeValid =
        !rule.type ||
        (rule.type === "string" && typeof value === "string") ||
        (rule.type === "integer" &&
          (Number.isInteger(value) ||
            (typeof value === "string" && /^-?\d+$/.test(value.trim())))) ||
        (rule.type === "number" &&
          ((typeof value === "number" && Number.isFinite(value)) ||
            (typeof value === "string" &&
              value.trim() !== "" &&
              Number.isFinite(coercedNumber)))) ||
        (rule.type === "boolean" && typeof value === "boolean") ||
        (rule.type === "object" &&
          value &&
          typeof value === "object" &&
          !Array.isArray(value));

      if (!typeValid) {
        return {
          valid: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: `Argument invalide : ${key}`,
          },
        };
      }

      if (rule.enum && !rule.enum.includes(value)) {
        return {
          valid: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: `Valeur interdite : ${key}`,
          },
        };
      }

      if (rule.minimum !== undefined && value < rule.minimum) {
        return {
          valid: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: `Valeur trop petite : ${key}`,
          },
        };
      }

      if (rule.maximum !== undefined && value > rule.maximum) {
        return {
          valid: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: `Valeur trop grande : ${key}`,
          },
        };
      }

      if (rule.minLength !== undefined && value.length < rule.minLength) {
        return {
          valid: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: `Texte trop court : ${key}`,
          },
        };
      }

      if (rule.maxLength !== undefined && value.length > rule.maxLength) {
        return {
          valid: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: `Texte trop long : ${key}`,
          },
        };
      }
    }

    return { valid: true };
  }

  getOpenAITools() {
    const permissions =
      this.agent.runConfig?.permissions ?? this.agent.permissions;
    const hasActiveFile = Boolean(this.agent.editor?.tabManager?.activeFile);
    const hiddenCompatibilityWriteTools = new Set([
      "modify_active_file",
      "replace_text",
    ]);
    const activeFileReadTools = new Set([
      "read_active_file",
      "search_active_file",
    ]);

    return [...this.tools.values()]
      .filter((tool) => tool.enabled)
      .filter((tool) => permissions === "code" || tool.readOnly)
      .filter((tool) => permissions === "code" || !tool.codeOnly)
      .filter(
        (tool) =>
          !hiddenCompatibilityWriteTools.has(tool.name) &&
          (hasActiveFile || !activeFileReadTools.has(tool.name)),
      )
      .map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
  }
}

window.ToolRegistry = ToolRegistry;
