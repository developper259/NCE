const AgentPath = {
  sep: "/",
  normalize(value) {
    if (typeof value !== "string") return "";
    let normalized = value.replace(/\\/g, "/");
    const driveMatch = normalized.match(/^([A-Za-z]:)/);
    const drive = driveMatch ? driveMatch[1].toUpperCase() : "";
    if (drive) normalized = normalized.slice(2);
    const absolute = normalized.startsWith("/");
    const segments = normalized.split("/").filter(Boolean);
    const stack = [];

    for (const segment of segments) {
      if (segment === ".") continue;
      if (segment === "..") {
        if (stack.length) {
          stack.pop();
        } else if (!absolute && !drive) {
          stack.push("..");
        }
        continue;
      }
      stack.push(segment);
    }

    const joined = stack.join("/");
    const prefix = absolute ? "/" : "";
    return `${prefix}${drive ? `${drive}/` : ""}${joined}`.replace(/\/+/g, "/");
  },
  isAbsolute(value) {
    if (typeof value !== "string") return false;
    const normalized = value.replace(/\\/g, "/");
    return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
  },
  resolve(...segments) {
    const safeSegments = segments.filter(
      (segment) => typeof segment === "string" && segment.length > 0,
    );
    if (!safeSegments.length) return "/";
    const joined = safeSegments
      .map((segment) => segment.replace(/\\/g, "/"))
      .join("/");
    return this.normalize(joined);
  },
  relative(from, to) {
    const base = this.normalize(from);
    const target = this.normalize(to);
    const baseParts = base.split("/").filter(Boolean);
    const targetParts = target.split("/").filter(Boolean);
    let index = 0;

    while (
      index < baseParts.length &&
      index < targetParts.length &&
      baseParts[index] === targetParts[index]
    ) {
      index += 1;
    }

    const up = Array(Math.max(0, baseParts.length - index)).fill("..");
    const down = targetParts.slice(index);
    const relative = [...up, ...down].join("/");
    return relative;
  },
};

class Agent {
  constructor(editor) {
    this.editor = editor;
    this.api = editor?.api || window.api;
    this.window = window;
    this.provider = null;
    this.model = null;
    this.tools = new Map();
    this.callbacks = {};
    this.contextProvider = null;
    this.abortController = null;
    this.currentSessionId = null;
    this.isRunning = false;
    this.stopRequested = false;
    this.runId = 0;
    this.maxIterations = 20;
    this.temperature = undefined;
    this.maxTokens = undefined;
    this.permissions = "code";
    this.messages = [];
    this.fileSnapshots = new Map();
    this.systemPrompt = "";
    this.registerEditorTools();
  }

  setWindow(value) {
    this.window = value || window;
    return this;
  }
  setProvider(provider) {
    if (!provider || typeof provider !== "object")
      throw new TypeError("Le provider doit être un objet.");
    this.provider = { ...provider };
    return this;
  }
  setModel(model) {
    if (typeof model !== "string" || !model.trim())
      throw new TypeError("Le modèle doit être une chaîne non vide.");
    this.model = model.trim();
    return this;
  }
  setSystemPrompt(prompt) {
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new TypeError("Le system prompt doit être une chaîne non vide.");
    }
    this.systemPrompt = prompt.trim();
    return this;
  }
  setConfig(config = {}) {
    if (Number.isFinite(config.maxIterations)) {
      this.maxIterations = Math.max(1, Math.floor(config.maxIterations));
    }
    if (Number.isFinite(config.temperature)) {
      this.temperature = Math.max(0, Math.min(2, config.temperature));
    }
    if (Number.isFinite(config.maxTokens)) {
      this.maxTokens = Math.max(1, Math.floor(config.maxTokens));
    }
    if (config.permissions === "read" || config.permissions === "code") {
      this.permissions = config.permissions;
    }
    return this;
  }
  setContextProvider(provider) {
    if (provider !== null && typeof provider !== "function")
      throw new TypeError("contextProvider doit être une fonction.");
    this.contextProvider = provider;
    return this;
  }
  setCallbacks(callbacks = {}) {
    for (const name of [
      "onToken",
      "onToolStart",
      "onToolEnd",
      "onError",
      "onFinish",
    ]) {
      if (name in callbacks) {
        if (callbacks[name] !== null && typeof callbacks[name] !== "function")
          throw new TypeError(`${name} doit être une fonction ou null.`);
        this.callbacks[name] = callbacks[name];
      }
    }
    return this;
  }
  registerTool(name, definition) {
    if (
      typeof name !== "string" ||
      !name.trim() ||
      !definition ||
      typeof definition.execute !== "function"
    )
      throw new TypeError(`Définition invalide pour l'outil "${name}".`);
    const tool = {
      name,
      description: definition.description || "",
      parameters: definition.parameters || { type: "object", properties: {} },
      execute: definition.execute,
      readOnly:
        definition.readOnly === true ||
        (typeof AgentAI !== "undefined" &&
          AgentAI.readOnlyTools?.includes(name)),
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

  async execute(userMessage, options = {}) {
    if (this.isRunning && !this.stopRequested)
      throw new Error("Un agent est déjà en cours d'exécution.");
    if (typeof userMessage !== "string" || !userMessage.trim())
      throw new TypeError("Le message utilisateur est obligatoire.");
    this.isRunning = true;
    this.stopRequested = false;
    this.abortController = new AbortController();
    const runId = ++this.runId;
    const controller = this.abortController;
    const runContext = { sessionId: options.sessionId || null, runId };
    this.currentSessionId = runContext.sessionId;
    try {
      const editorContext = await this.getContext();
      this.messages = [
        { role: "system", content: this.buildSystemMessage(editorContext) },
      ];
      this.appendHistory(options.history);
      this.messages.push({ role: "user", content: userMessage });
      const result = await this.runLoop(runId, controller);
      this.callbacks.onFinish?.(result, runContext);
      return result;
    } catch (error) {
      if (!this.isAbortError(error) && runId === this.runId)
        this.callbacks.onError?.(error, runContext);
      throw error;
    } finally {
      if (runId === this.runId) {
        this.isRunning = false;
        this.abortController = null;
        this.currentSessionId = null;
      }
    }
  }
  run(userMessage, options = {}) {
    return this.execute(userMessage, options);
  }
  stop() {
    this.stopRequested = true;
    this.abortController?.abort();
  }

  async runLoop(runId, controller) {
    let response = "";
    let reasoning = "";
    for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
      if (this.stopRequested || runId !== this.runId) throw this.abortError();
      const modelResponse = await this.requestModel(controller);
      if (this.stopRequested || runId !== this.runId) throw this.abortError();
      const parsed = this.parseResponse(modelResponse);
      response += parsed.text;
      reasoning += parsed.reasoning;
      if (parsed.text) {
        this.callbacks.onToken?.(parsed.text, {
          sessionId: this.currentSessionId,
          runId,
        });
      }
      if (!parsed.toolCalls.length)
        return { response, reasoning, iterations: iteration };
      this.messages.push(parsed.assistantMessage);
      for (const call of parsed.toolCalls) {
        if (this.stopRequested || runId !== this.runId) throw this.abortError();
        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(await this.executeToolCall(call)),
        });
      }
    }
    throw new Error(
      `Nombre maximal d'itérations atteint (${this.maxIterations}).`,
    );
  }

  async requestModel(controller = this.abortController) {
    if (!this.provider?.baseURL)
      throw new Error("Aucun provider IA configuré.");
    if (!this.model) throw new Error("Aucun modèle IA configuré.");
    const payload = {
      model: this.model,
      messages: this.messages,
      tools: this.getOpenAITools(),
      tool_choice: "auto",
      stream: false,
    };
    if (Number.isFinite(this.temperature))
      payload.temperature = this.temperature;
    if (Number.isFinite(this.maxTokens)) payload.max_tokens = this.maxTokens;
    const provider = this.sanitizeProviderForIPC();
    if (typeof this.api?.aiChat === "function")
      return this.api.aiChat({ provider, payload });
    if (typeof this.api?.requestAI === "function")
      return this.api.requestAI({ provider, payload });
    const headers = { "Content-Type": "application/json" };
    if (this.provider.apiKey)
      headers.Authorization = `Bearer ${this.provider.apiKey}`;
    const result = await fetch(
      `${this.provider.baseURL.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller?.signal,
      },
    );
    if (!result.ok)
      throw new Error(`Erreur API (${result.status}) : ${await result.text()}`);
    return result.json();
  }
  sanitizeProviderForIPC() {
    if (!this.provider) return null;
    const provider = { ...this.provider };
    delete provider.apiKey;
    return provider;
  }

  parseResponse(result) {
    const message = result?.choices?.[0]?.message || result?.message;
    if (!message || typeof message !== "object")
      throw new Error("Réponse IA invalide.");
    const content = message.content;
    const text = Array.isArray(content)
      ? content
          .map((part) => (typeof part === "string" ? part : part?.text || ""))
          .join("")
      : typeof content === "string"
        ? content
        : "";
    const reasoning = this.extractReasoning(message);
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls
      : [];
    return {
      text,
      reasoning,
      toolCalls,
      assistantMessage: {
        role: "assistant",
        content: content || null,
        ...(reasoning ? { reasoning } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
    };
  }
  extractReasoning(message) {
    const value =
      message.reasoning_content ??
      message.reasoning ??
      message.additional_kwargs?.reasoning;
    if (typeof value === "string") return value.trim();
    if (value === null || value === undefined) return "";
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  getOpenAITools() {
    return [...this.tools.values()]
      .filter((tool) => tool.enabled)
      .filter((tool) => this.permissions === "code" || tool.readOnly)
      .map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
  }

  async executeToolCall(call) {
    const name = call?.function?.name;
    const tool = this.getTool(name);
    if (!tool)
      return {
        success: false,
        error: {
          code: "TOOL_NOT_FOUND",
          message: `Outil inconnu : ${name || "(sans nom)"}`,
        },
      };
    if (!tool.enabled)
      return {
        success: false,
        error: { code: "TOOL_DISABLED", message: `Outil désactivé : ${name}` },
      };
    if (this.permissions === "read" && !tool.readOnly) {
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
    if (!args || typeof args !== "object" || Array.isArray(args))
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "Les arguments doivent être un objet.",
        },
      };

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

    const validation = this.validateTool(tool, normalizedArgs);
    if (!validation.valid) return { success: false, error: validation.error };
    const callbackContext = {
      sessionId: this.currentSessionId,
      runId: this.runId,
    };
    this.callbacks.onToolStart?.(name, normalizedArgs, callbackContext);
    try {
      const result = this.limitResult(
        await tool.execute(normalizedArgs, {
          editor: this.editor,
          agent: this,
          signal: this.abortController?.signal,
        }),
      );
      this.callbacks.onToolEnd?.(name, result, callbackContext);
      return { success: true, result };
    } catch (error) {
      const result = {
        success: false,
        error: {
          code: this.isAbortError(error) ? "USER_ABORTED" : "INTERNAL_ERROR",
          message: error?.message || String(error),
        },
      };
      this.callbacks.onToolEnd?.(name, result, callbackContext);
      return result;
    }
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
      if (!typeValid)
        return {
          valid: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: `Argument invalide : ${key}`,
          },
        };
      if (rule.enum && !rule.enum.includes(value))
        return {
          valid: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: `Valeur interdite : ${key}`,
          },
        };
      if (rule.minimum !== undefined && value < rule.minimum)
        return {
          valid: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: `Valeur trop petite : ${key}`,
          },
        };
      if (rule.maximum !== undefined && value > rule.maximum)
        return {
          valid: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: `Valeur trop grande : ${key}`,
          },
        };
      if (rule.minLength !== undefined && value.length < rule.minLength)
        return {
          valid: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: `Texte trop court : ${key}`,
          },
        };
      if (rule.maxLength !== undefined && value.length > rule.maxLength)
        return {
          valid: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: `Texte trop long : ${key}`,
          },
        };
    }
    return { valid: true };
  }
  async getContext() {
    let custom = {};
    if (this.contextProvider)
      try {
        custom = (await this.contextProvider(this.editor)) || {};
      } catch (error) {
        console.warn("[Agent] contextProvider failed:", error);
      }
    return {
      ...this.buildEditorContext(),
      ...(typeof custom === "object" ? custom : {}),
    };
  }
  buildEditorContext() {
    const file = this.editor?.tabManager?.activeFile;
    if (!file)
      return {
        hasActiveFile: false,
        file: null,
        cursor: null,
        selection: null,
      };
    const root = this.editor?.fileExplorer?.rootPath;
    const cursor = this.editor?.cursorController;
    let selection = null;
    try {
      const controller = this.editor?.selectController;
      const text = controller?.getSelectedText
        ? controller.getSelectedText()
        : controller?.containsSelected;
      if (typeof text === "string" && text)
        selection = { content: this.truncate(text, 2000) };
    } catch {
      selection = null;
    }
    return {
      hasActiveFile: true,
      file: {
        name: file.name || "Unknown",
        path: this.toProjectRelativePath(file.path, root) || file.name || "",
        language: file.language || "text",
      },
      cursor: cursor
        ? { row: cursor.row ?? 1, column: cursor.column ?? 0 }
        : null,
      selection,
    };
  }
  buildSystemMessage(context) {
    return `${this.systemPrompt}\n\nCONTEXTE ACTUEL DE L'ÉDITEUR :\n${JSON.stringify(context)}`;
  }
  appendHistory(history) {
    if (!Array.isArray(history)) return;
    for (const message of history.slice(-6))
      if (
        (message?.role === "user" || message?.role === "assistant") &&
        typeof message.content === "string"
      )
        this.messages.push({
          role: message.role,
          content: message.content.slice(0, 4000),
        });
  }
  truncate(value, max) {
    const text = value === null || value === undefined ? "" : String(value);
    return text.length <= max
      ? text
      : `${text.slice(0, Math.max(0, max - 32))}\n\n[... contenu tronqué par NCE ...]`;
  }
  limitResult(result) {
    const maxContent = 4000;
    if (typeof result === "string") return this.truncate(result, maxContent);
    if (!result || typeof result !== "object") return result;
    const limited = { ...result };
    for (const key of ["content", "beforeText", "afterText"]) {
      if (
        typeof limited[key] === "string" &&
        limited[key].length > maxContent
      ) {
        limited[key] = this.truncate(limited[key], maxContent);
        limited.truncated = true;
      }
    }
    if (Array.isArray(limited.results) && limited.results.length > 100) {
      limited.results = limited.results.slice(0, 100);
      limited.truncated = true;
    }
    return limited;
  }
  abortError() {
    return new DOMException(
      "L'exécution de l'agent a été annulée.",
      "AbortError",
    );
  }
  isAbortError(error) {
    return error?.name === "AbortError" || this.stopRequested;
  }
  lineColumnToIndex(lines, lineNumber, columnNumber) {
    const source = Array.isArray(lines) ? lines : [];
    const lineIndex = Math.min(
      Math.max(0, Number(lineNumber || 1) - 1),
      Math.max(0, source.length - 1),
    );
    const column = Math.max(0, Number(columnNumber) || 0);
    const offset = source
      .slice(0, lineIndex)
      .reduce((total, line) => total + line.length + 1, 0);
    return offset + Math.min(column, (source[lineIndex] || "").length);
  }
  toProjectRelativePath(filePath, rootPath) {
    if (typeof filePath !== "string") return "";
    const path = filePath.replace(/\\/g, "/");
    const root =
      typeof rootPath === "string"
        ? rootPath.replace(/\\/g, "/").replace(/\/+$/, "")
        : "";
    return root && path.startsWith(`${root}/`)
      ? path.slice(root.length + 1)
      : path;
  }

  registerEditorTools() {
    this.registerTool("get_editor_context", {
      description: "Obtenir le contexte minimal de l'éditeur.",
      execute: () => this.buildEditorContext(),
    });
    this.registerTool("get_cursor", {
      description: "Obtenir la position du curseur.",
      execute: () => ({
        available: Boolean(this.editor?.cursorController),
        position: this.editor?.cursorController
          ? {
              row: this.editor.cursorController.row ?? 1,
              column: this.editor.cursorController.column ?? 0,
            }
          : null,
      }),
    });
    this.registerTool("read_selection", {
      description: "Lire la sélection actuelle.",
      execute: () => this.readSelection(),
    });
    this.registerTool("read_active_file", {
      description: "Lire une portion du fichier actif.",
      parameters: {
        type: "object",
        properties: {
          startLine: { type: "integer" },
          endLine: { type: "integer" },
        },
      },
      execute: (args) => this.readActiveFile(args),
    });
    this.registerTool("search_active_file", {
      description: "Rechercher dans le fichier actif.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 500 },
          offset: { type: "integer", minimum: 0, maximum: 100000 },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["query"],
      },
      execute: (args) => this.searchActiveFile(args),
    });
    this.registerTool("modify_active_file", {
      description: "Modifier une plage du fichier actif.",
      parameters: {
        type: "object",
        properties: {
          startLine: { type: "integer" },
          startColumn: { type: "integer" },
          endLine: { type: "integer" },
          endColumn: { type: "integer" },
          text: { type: "string" },
        },
        required: ["startLine", "startColumn", "endLine", "endColumn", "text"],
      },
      execute: (args) => this.modifyActiveFile(args),
    });
    this.registerTool("read_file", {
      description: "Lire un fichier du projet.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      execute: (args) => this.readFile(args.path),
    });
    this.registerTool("list_project_files", {
      description: "Lister les fichiers du projet.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      execute: (args) => this.listProjectFiles(args.path),
    });
    this.registerTool("search_project_files", {
      description: "Rechercher dans le projet.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      execute: (args) => this.searchProjectFiles(args),
    });
  }
  async readSelection() {
    const controller = this.editor?.selectController;
    const text = controller?.getSelectedText
      ? controller.getSelectedText()
      : controller?.containsSelected;
    return typeof text === "string" && text
      ? { success: true, content: this.truncate(text, 2000) }
      : { success: false, error: "Aucune sélection active." };
  }
  async readActiveFile(args = {}) {
    const controller = this.editor?.lineController;
    const file = this.editor?.tabManager?.activeFile;
    if (!file || !controller)
      return { success: false, error: "Aucun fichier actif." };
    const lines = controller.getContent().split("\n");
    const startLine =
      Number.isInteger(args.startLine) && args.startLine > 0
        ? args.startLine
        : 1;
    const endLine = Math.min(
      Number.isInteger(args.endLine) ? args.endLine : startLine + 149,
      startLine + 199,
      lines.length,
    );
    return {
      success: true,
      path: this.toProjectRelativePath(
        file.path,
        this.editor?.fileExplorer?.rootPath,
      ),
      startLine,
      endLine,
      totalLines: lines.length,
      truncated: endLine < lines.length,
      content: this.truncate(
        lines.slice(startLine - 1, endLine).join("\n"),
        4000,
      ),
    };
  }
  async searchActiveFile(args = {}) {
    const controller = this.editor?.searchController;
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!controller?.search)
      return { success: false, error: "SearchController indisponible." };
    if (!query) return { success: false, error: "Requête vide." };
    controller.search(query);
    const results = Array.isArray(controller.results)
      ? controller.results.slice(0, 50)
      : [];
    return {
      success: true,
      query,
      totalMatches: controller.results?.length || 0,
      results: results.map(({ row, column, length }) => ({
        row,
        column,
        length,
      })),
    };
  }
  async readFile(filePath) {
    const root = this.editor?.fileExplorer?.rootPath;
    const absolute = this.resolveWorkspacePath(filePath, root);
    if (!absolute)
      return {
        success: false,
        error: { code: "INVALID_PATH", message: "Chemin hors du workspace." },
      };
    const result = await this.api?.getFileContent?.([absolute]);
    const content = result?.[absolute];
    return typeof content === "string"
      ? {
          success: true,
          path: filePath,
          totalLines: content.split(/\r?\n/).length,
          content: this.truncate(content, 4000),
        }
      : { success: false, error: `Impossible de lire le fichier: ${filePath}` };
  }
  async listProjectFiles(path = "") {
    const root = this.editor?.fileExplorer?.rootPath;
    if (!root) return { success: false, error: "Pas de projet ouvert." };
    const target = path ? this.resolveWorkspacePath(path, root) : root;
    if (!target)
      return {
        success: false,
        error: { code: "INVALID_PATH", message: "Chemin hors du workspace." },
      };
    const files = await this.api?.getFolderContent?.(target);
    return Array.isArray(files)
      ? {
          success: true,
          path,
          total: files.length,
          files: files.slice(0, 200).map((item) => ({
            name: item.name,
            type: item.type,
            path: this.toProjectRelativePath(item.path, root),
          })),
        }
      : { success: false, error: "Impossible de lire le dossier." };
  }
  async searchProjectFiles(args = {}) {
    const root = this.editor?.fileExplorer?.rootPath;
    if (!root || !args.query)
      return { success: false, error: "Projet ou requête indisponible." };
    return this.editor.api.searchInFiles(root, args.query, {
      ...args,
      offset: args.offset,
      limit: args.limit,
    });
  }
  resolveWorkspacePath(filePath, rootPath) {
    if (typeof filePath !== "string" || typeof rootPath !== "string")
      return null;

    const root = AgentPath.normalize(rootPath);
    const candidate = AgentPath.isAbsolute(filePath)
      ? AgentPath.normalize(filePath)
      : AgentPath.normalize(`${root}/${filePath}`);
    const relative = AgentPath.relative(root, candidate);

    if (!relative || relative === ".") return candidate;
    if (relative.startsWith("..") || AgentPath.isAbsolute(relative))
      return null;
    return candidate;
  }
  async modifyActiveFile(args) {
    const file = this.editor?.tabManager?.activeFile;
    const writer = this.editor?.writerController;
    const lineController = this.editor?.lineController;
    if (!file || !writer?.replaceRange || !lineController)
      throw new Error("WriterController indisponible.");
    const beforeText = lineController.getContent();
    const lines = beforeText.split("\n");
    const startIndex = this.lineColumnToIndex(
      lines,
      args.startLine,
      args.startColumn,
    );
    const endIndex = this.lineColumnToIndex(
      lines,
      args.endLine,
      args.endColumn,
    );
    const afterText = `${beforeText.slice(0, startIndex)}${args.text}${beforeText.slice(endIndex)}`;
    writer.replaceRange(
      args.text,
      args.startLine,
      args.startColumn,
      args.endLine,
      args.endColumn,
    );
    file.setIsSaved(false);
    return {
      success: true,
      operation: "replace",
      path: this.toProjectRelativePath(
        file.path,
        this.editor?.fileExplorer?.rootPath,
      ),
      range: args,
      beforeText,
      afterText,
    };
  }
}
