import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { killProcessTree } from "../manager/GitProcess";
import { JsonRpcConnection, JSON_RPC_METHOD_NOT_FOUND } from "./JsonRpcConnection";
import type { LspExecutableResolution } from "./LspExecutableResolver";
import type { LspServerDefinition } from "./LspServerRegistry";
import { isRange, pathToUri } from "./LspText";
import type { LspDiagnostic, LspDocumentChange } from "./LspTypes";
import type { LspOpenDocument } from "./LspDocumentStore";

export type LspSessionState =
  | "starting"
  | "initializing"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

export interface LspSessionCapabilities {
  syncKind: 0 | 1 | 2;
  saveIncludeText: boolean;
  completion: boolean;
  completionTriggerCharacters: string[];
  completionResolve: boolean;
  hover: boolean;
  definition: boolean;
  declaration: boolean;
  implementation: boolean;
  typeDefinition: boolean;
  references: boolean;
  rename: boolean;
  prepareRename: boolean;
  codeAction: boolean;
  codeActionResolve: boolean;
  formatting: boolean;
  rangeFormatting: boolean;
  documentSymbols: boolean;
  workspaceSymbols: boolean;
  signatureHelp: boolean;
}

export interface LspSessionEvents {
  onStatus: (session: LspServerSessionLike) => void;
  onDiagnostics: (
    serverKey: string,
    uri: string,
    version: number | null,
    diagnostics: LspDiagnostic[],
  ) => void;
  onLog: (serverKey: string, level: "info" | "warn" | "error", message: string) => void;
}

export interface LspServerSessionLike {
  key: string;
  serverId: string;
  serverName: string;
  root: string;
  state: LspSessionState;
  error: string | null;
  capabilities: LspSessionCapabilities;
}

const INITIALIZE_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_DIAGNOSTICS_PER_PUBLISH = 2_000;
const MAX_DIAGNOSTIC_MESSAGE = 8_192;
const MAX_LOG_BUFFER = 200;

const EMPTY_CAPABILITIES: LspSessionCapabilities = {
  syncKind: 0,
  saveIncludeText: false,
  completion: false,
  completionTriggerCharacters: [],
  completionResolve: false,
  hover: false,
  definition: false,
  declaration: false,
  implementation: false,
  typeDefinition: false,
  references: false,
  rename: false,
  prepareRename: false,
  codeAction: false,
  codeActionResolve: false,
  formatting: false,
  rangeFormatting: false,
  documentSymbols: false,
  workspaceSymbols: false,
  signatureHelp: false,
};

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function supports(value: unknown): boolean {
  return Boolean(value);
}

function normalizeCapabilities(source: Record<string, any>): LspSessionCapabilities {
  const sync = source.textDocumentSync;
  const syncObject = asObject(sync);
  const syncKind = syncObject
    ? Number(syncObject.change)
    : Number(sync);
  const completion = asObject(source.completionProvider);
  const rename = asObject(source.renameProvider);
  const codeAction = asObject(source.codeActionProvider);
  return {
    syncKind: syncKind === 2 ? 2 : syncKind === 1 ? 1 : 0,
    saveIncludeText: Boolean(asObject(syncObject?.save)?.includeText),
    completion: supports(source.completionProvider),
    completionTriggerCharacters: completion && Array.isArray(completion.triggerCharacters)
      ? completion.triggerCharacters.filter((value: unknown): value is string =>
          typeof value === "string" && value.length <= 8).slice(0, 16)
      : [],
    completionResolve: Boolean(completion?.resolveProvider),
    hover: supports(source.hoverProvider),
    definition: supports(source.definitionProvider),
    declaration: supports(source.declarationProvider),
    implementation: supports(source.implementationProvider),
    typeDefinition: supports(source.typeDefinitionProvider),
    references: supports(source.referencesProvider),
    rename: supports(source.renameProvider),
    prepareRename: Boolean(rename?.prepareProvider),
    codeAction: supports(source.codeActionProvider),
    codeActionResolve: Boolean(codeAction?.resolveProvider),
    formatting: supports(source.documentFormattingProvider),
    rangeFormatting: supports(source.documentRangeFormattingProvider),
    documentSymbols: supports(source.documentSymbolProvider),
    workspaceSymbols: supports(source.workspaceSymbolProvider),
    signatureHelp: supports(source.signatureHelpProvider),
  };
}

function sanitizeDiagnostics(raw: unknown): { diagnostics: LspDiagnostic[]; version: number | null } {
  const payload = asObject(raw);
  if (!payload || !Array.isArray(payload.diagnostics))
    return { diagnostics: [], version: null };
  const version = Number.isSafeInteger(payload.version) && payload.version >= 0
    ? Number(payload.version)
    : null;
  const diagnostics: LspDiagnostic[] = [];
  for (const entry of payload.diagnostics) {
    if (diagnostics.length >= MAX_DIAGNOSTICS_PER_PUBLISH) break;
    const item = asObject(entry);
    if (!item || !isRange(item.range) || typeof item.message !== "string") continue;
    const severity = [1, 2, 3, 4].includes(Number(item.severity))
      ? Number(item.severity) as 1 | 2 | 3 | 4
      : undefined;
    const code = typeof item.code === "string" || typeof item.code === "number"
      ? item.code
      : undefined;
    diagnostics.push({
      range: item.range,
      severity,
      code,
      source: typeof item.source === "string" ? item.source.slice(0, 256) : undefined,
      message: item.message.slice(0, MAX_DIAGNOSTIC_MESSAGE),
      tags: Array.isArray(item.tags)
        ? item.tags.filter((value: unknown) => Number.isSafeInteger(value)).slice(0, 8)
        : undefined,
      data: item.data,
    });
  }
  return { diagnostics, version };
}

export interface LspSessionOptions {
  definition: LspServerDefinition;
  executable: LspExecutableResolution;
  root: string;
  workspaceRoot: string;
  events: LspSessionEvents;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  initializationOptions?: Record<string, unknown>;
  requestTimeoutMs?: number;
}

export class LspSession implements LspServerSessionLike {
  readonly key: string;
  readonly definition: LspServerDefinition;
  readonly serverId: string;
  readonly serverName: string;
  readonly root: string;
  readonly workspaceRoot: string;
  state: LspSessionState = "starting";
  error: string | null = null;
  capabilities: LspSessionCapabilities = { ...EMPTY_CAPABILITIES };
  capabilitiesRaw: Record<string, any> = {};
  private readonly options: LspSessionOptions;
  private readonly platform: NodeJS.Platform;
  private process: ChildProcess | null = null;
  private connection: JsonRpcConnection | null = null;
  private readyResolvers: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private startupSettled = false;
  private readonly logs: string[] = [];
  private stopping: Promise<void> | null = null;
  private readonly openDocuments = new Set<string>();

  constructor(options: LspSessionOptions) {
    this.options = options;
    this.definition = options.definition;
    this.serverId = options.definition.id;
    this.serverName = options.definition.name;
    this.root = options.root;
    this.workspaceRoot = options.workspaceRoot;
    this.platform = options.platform ?? process.platform;
    this.key = `${this.serverId}::${this.root}`;
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }

  get documentCount(): number {
    return this.openDocuments.size;
  }

  recentLogs(): string[] {
    return [...this.logs];
  }

  async start(): Promise<void> {
    if (this.state !== "starting") return;
    if (!this.options.executable.available || !this.options.executable.command)
      throw new Error(this.options.executable.error || "The language server executable is unavailable.");
    const env = { ...(this.options.env ?? process.env) };
    delete env.ELECTRON_RUN_AS_NODE;
    let child: ChildProcess;
    try {
      child = spawn(this.options.executable.command, this.options.executable.args, {
        cwd: this.root,
        env,
        shell: false,
        windowsHide: true,
        detached: this.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.fail(`Unable to start ${this.serverName}: ${String(error)}`);
      throw error;
    }
    this.process = child;
    if (!child.stdout || !child.stderr || !child.stdin)
      throw new Error("Language server stdio streams are unavailable.");
    this.connection = new JsonRpcConnection({
      input: child.stdout,
      output: child.stdin,
      requestTimeoutMs: this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      onNotification: (method, params) => this.handleNotification(method, params),
      onRequest: (method, params) => this.handleServerRequest(method, params),
      onProtocolError: (error) => {
        this.log("error", error.message);
        this.fail(error.message);
      },
    });
    this.connection.start();
    child.stderr.on("data", (chunk: Buffer) => this.handleStderr(chunk));
    child.on("error", (error) => {
      if (this.state === "stopped" || this.state === "stopping") return;
      this.fail(`Language server process error: ${error.message}`);
      this.rejectReady(error);
    });
    child.on("exit", (code, signal) => {
      const wasStopping = this.state === "stopping" || this.state === "stopped";
      this.connection?.dispose(new Error(`Language server exited (${code ?? signal ?? "unknown"}).`));
      this.connection = null;
      this.process = null;
      if (wasStopping) {
        this.state = "stopped";
        this.emitStatus();
        return;
      }
      this.fail(`Language server exited unexpectedly (${code ?? signal ?? "unknown"}).`);
      this.rejectReady(new Error(this.error || "Language server exited during initialization."));
    });

    this.state = "initializing";
    this.emitStatus();
    try {
      await this.initialize();
      if (this.state !== "initializing") {
        await this.stop();
        throw new Error(`The ${this.serverName} session stopped during initialization.`);
      }
      this.state = "ready";
      this.emitStatus();
      this.resolveReady();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.state === "stopped") return;
    this.state = "stopping";
    this.emitStatus();
    this.stopping = (async () => {
      const connection = this.connection;
      const child = this.process;
      if (connection && !connection.isClosed) {
        try {
          await connection.request("shutdown", null, { timeoutMs: SHUTDOWN_TIMEOUT_MS });
        } catch {
          // A server may already be gone; exit/kill below still applies.
        }
        try { connection.notify("exit", null); } catch {}
        connection.dispose();
      }
      this.connection = null;
      if (child) {
        const exited = new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            killProcessTree(child, "SIGKILL", this.platform);
            resolve();
          }, 1_500);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        if (child.exitCode === null && child.signalCode === null)
          killProcessTree(child, "SIGTERM", this.platform);
        await exited;
      }
      this.process = null;
      this.state = "stopped";
      this.openDocuments.clear();
      this.emitStatus();
    })();
    return this.stopping;
  }

  async waitUntilReady(): Promise<void> {
    if (this.state === "ready") return;
    if (this.state === "failed" || this.state === "stopped")
      throw new Error(this.error || `The ${this.serverName} session is not available.`);
    return new Promise<void>((resolve, reject) => {
      this.readyResolvers.push({ resolve, reject });
    });
  }

  openDocument(document: LspOpenDocument): void {
    this.openDocuments.add(document.path);
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri: document.uri,
        languageId: document.languageId,
        version: document.version,
        text: document.text,
      },
    });
  }

  changeDocument(document: LspOpenDocument, changes: LspDocumentChange[]): void {
    if (this.capabilities.syncKind === 0) return;
    const contentChanges = this.capabilities.syncKind === 1
      ? [{ text: document.text }]
      : changes.map((change) => ({
          range: change.range,
          rangeLength: change.rangeLength,
          text: change.text,
        }));
    this.notify("textDocument/didChange", {
      textDocument: { uri: document.uri, version: document.version },
      contentChanges,
    });
  }

  saveDocument(document: LspOpenDocument): void {
    this.notify("textDocument/didSave", {
      textDocument: { uri: document.uri },
      ...(this.capabilities.saveIncludeText ? { text: document.text } : {}),
    });
  }

  closeDocument(uri: string, path: string): void {
    this.openDocuments.delete(path);
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  request<T = unknown>(
    method: string,
    params: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (!this.connection || this.state !== "ready" || this.connection.isClosed)
      return Promise.reject(new Error(`The ${this.serverName} session is not ready.`));
    return this.connection.request<T>(method, params, options);
  }

  notify(method: string, params: unknown): void {
    if (!this.connection || this.connection.isClosed) return;
    this.connection.notify(method, params);
  }

  private async initialize(): Promise<void> {
    const workspaceUri = pathToUri(this.root);
    const result = await this.connection!.request<any>("initialize", {
      processId: process.pid,
      clientInfo: { name: "NCE", version: "1.0.0" },
      rootUri: workspaceUri,
      rootPath: this.root,
      workspaceFolders: [{ uri: workspaceUri, name: path.basename(this.root) || this.root }],
      capabilities: {
        workspace: {
          applyEdit: true,
          workspaceEdit: { documentChanges: false },
          workspaceFolders: true,
          configuration: true,
          didChangeWatchedFiles: { dynamicRegistration: false },
        },
        textDocument: {
          synchronization: { dynamicRegistration: false, willSave: false, didSave: true },
          completion: {
            dynamicRegistration: false,
            contextSupport: true,
            completionItem: {
              snippetSupport: false,
              insertReplaceSupport: false,
              documentationFormat: ["markdown", "plaintext"],
              resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
            },
          },
          hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
          definition: { dynamicRegistration: false, linkSupport: false },
          declaration: { dynamicRegistration: false, linkSupport: false },
          implementation: { dynamicRegistration: false, linkSupport: false },
          typeDefinition: { dynamicRegistration: false, linkSupport: false },
          references: { dynamicRegistration: false },
          rename: { dynamicRegistration: false, prepareSupport: true, honorsChangeAnnotations: false },
          codeAction: {
            dynamicRegistration: false,
            isPreferredSupport: true,
            resolveSupport: { properties: ["edit", "command"] },
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: [
                  "quickfix", "refactor", "refactor.extract", "refactor.inline",
                  "refactor.rewrite", "source", "source.organizeImports", "source.fixAll",
                ],
              },
            },
          },
          formatting: { dynamicRegistration: false },
          rangeFormatting: { dynamicRegistration: false },
          documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: false },
          signatureHelp: {
            dynamicRegistration: false,
            contextSupport: true,
            signatureInformation: {
              documentationFormat: ["markdown", "plaintext"],
              activeParameterSupport: true,
            },
          },
          publishDiagnostics: {
            relatedInformation: false,
            versionSupport: true,
            tagSupport: { valueSet: [1, 2] },
          },
        },
      },
      initializationOptions: this.options.initializationOptions ?? this.definition.initializationOptions ?? {},
      trace: "off",
    }, { timeoutMs: INITIALIZE_TIMEOUT_MS });
    const capabilities = asObject(result?.capabilities);
    if (!capabilities)
      throw new Error("The language server returned invalid initialization capabilities.");
    if (capabilities.positionEncoding && capabilities.positionEncoding !== "utf-16")
      throw new Error(`Unsupported position encoding: ${capabilities.positionEncoding}`);
    this.capabilitiesRaw = capabilities;
    this.capabilities = normalizeCapabilities(capabilities);
    this.notify("initialized", {});
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "textDocument/publishDiagnostics") {
      const payload = asObject(params);
      if (!payload || typeof payload.uri !== "string") return;
      const { diagnostics, version } = sanitizeDiagnostics(payload);
      this.options.events.onDiagnostics(this.key, payload.uri, version, diagnostics);
      return;
    }
    if (method === "window/logMessage") {
      const payload = asObject(params);
      const message = typeof payload?.message === "string" ? payload.message : "";
      if (message) this.log(payload?.type === 1 ? "error" : payload?.type === 2 ? "warn" : "info", message);
      return;
    }
    if (method === "window/showMessage") {
      const payload = asObject(params);
      if (typeof payload?.message === "string")
        this.log(payload?.type === 1 ? "error" : payload?.type === 2 ? "warn" : "info", payload.message);
      return;
    }
    if (method === "$/progress" || method === "telemetry/event") return;
  }

  private async handleServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === "workspace/configuration") {
      const items = asObject(params)?.items;
      return Array.isArray(items) ? items.map(() => null) : [];
    }
    if (method === "workspace/workspaceFolders") {
      return [{ uri: pathToUri(this.root), name: path.basename(this.root) || this.root }];
    }
    if (method === "workspace/applyEdit") {
      return { applied: false, failureReason: "NCE applies workspace edits in the editor renderer." };
    }
    if (
      method === "client/registerCapability" ||
      method === "client/unregisterCapability" ||
      method === "window/workDoneProgress/create" ||
      method === "workspace/semanticTokens/refresh" ||
      method === "workspace/codeLens/refresh" ||
      method === "workspace/inlayHint/refresh"
    ) return null;
    if (method === "window/showMessageRequest") return null;
    const error: any = new Error(`Unsupported language server request: ${method}`);
    error.code = JSON_RPC_METHOD_NOT_FOUND;
    throw error;
  }

  private handleStderr(chunk: Buffer): void {
    const text = chunk.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.log("info", trimmed.slice(0, 4_096));
    }
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    const line = `[${new Date().toISOString()}] ${message}`;
    this.logs.push(line);
    if (this.logs.length > MAX_LOG_BUFFER) this.logs.splice(0, this.logs.length - MAX_LOG_BUFFER);
    this.options.events.onLog(this.key, level, line);
  }

  private fail(message: string): void {
    if (this.state === "stopped" || this.state === "stopping") return;
    this.error = message;
    this.state = "failed";
    this.connection?.dispose(new Error(message));
    this.connection = null;
    this.emitStatus();
    this.rejectReady(new Error(message));
  }

  private resolveReady(): void {
    if (this.startupSettled) return;
    this.startupSettled = true;
    for (const entry of this.readyResolvers.splice(0)) entry.resolve();
  }

  private rejectReady(error: Error): void {
    if (this.startupSettled) return;
    this.startupSettled = true;
    for (const entry of this.readyResolvers.splice(0)) entry.reject(error);
  }

  private emitStatus(): void {
    this.options.events.onStatus(this);
  }
}

