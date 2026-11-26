import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IpcHandlerRegistrar } from "../manager/IpcRouter";
import type { PathAccess } from "../manager/PathAccess";
import { LspDiagnosticsStore } from "./LspDiagnosticsStore";
import { LspDocumentStore, type LspOpenDocument } from "./LspDocumentStore";
import { resolveServerExecutable, type LspExecutableResolution, type ManagedToolPort, type InternalRuntimePort } from "./LspExecutableResolver";
import { LspFeatureRouter, type LspRoute } from "./LspFeatureRouter";
import { LspSession, type LspSessionState } from "./LspSession";
import {
  getServerDefinitions,
  getServerDefinition,
  languageIdForPath,
  resolveServerRoot,
  serversForLanguage,
  normalizeServerId,
  SERVER_ID_ALIASES,
  type LspServerDefinition,
} from "./LspServerRegistry";
import { sanitizeLspSettings } from "./LspSettings";
import { isPosition, isRange, pathToUri, uriToPath, validateRange } from "./LspText";
import type {
  LspCodeAction,
  LspDiagnostic,
  LspDocumentChange,
  LspDocumentInfo,
  LspErrorCode,
  LspFailure,
  LspResult,
  LspEmptyResult,
  LspServerConfiguration,
  LspServerRoute,
  LspStatusSnapshot,
  LspWorkspaceEdit,
  LspWorkspaceFileEdit,
} from "./LspTypes";

const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_CHANGES = 200;
const MAX_DIAGNOSTIC_CONTEXT = 500;
const MAX_WORKSPACE_FILES = 100;
const MAX_WORKSPACE_EDITS = 5_000;
const ACTION_TOKEN_TTL_MS = 5 * 60_000;

class LspManagerError extends Error {
  readonly code: LspErrorCode;

  constructor(code: LspErrorCode, message: string) {
    super(message);
    this.name = "LspManagerError";
    this.code = code;
  }
}

interface ServerAttempt {
  key: string;
  serverId: string;
  serverName: string;
  root: string;
  state: "starting" | "initializing" | "ready" | "failed" | "unavailable" | "stopped" | "stopping";
  error: string | null;
}

interface CachedAction {
  action: LspCodeAction;
  routeKey: string;
  expiresAt: number;
}

interface CachedCompletion {
  item: import("./LspTypes").LspCompletionItem;
  routeKey: string;
  expiresAt: number;
}

export interface LspManagerOptions {
  getWorkspaceRoot: () => string | null | undefined;
  pathAccess?: Pick<PathAccess, "isAuthorized">;
  getSettings: () => unknown;
  send?: (channel: string, payload: unknown) => void;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  getTabSize?: () => number;
  requestTimeoutMs?: number;
  maxDocumentBytes?: number;
  /** Resolves executables NCE installed itself; absent means PATH-only resolution. */
  managedTools?: ManagedToolPort | null;
  /** Standalone Node.js runtime for managed script servers. */
  internalRuntime?: InternalRuntimePort | null;
  onLog?: (serverId: string, level: "info" | "warn" | "error", message: string) => void;
}

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function failure(code: LspErrorCode, error: string): LspFailure {
  return { success: false, code, error };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const LSP_ERROR_CODES = new Set<LspErrorCode>([
  "LSP_DISABLED", "LSP_UNSUPPORTED_LANGUAGE", "LSP_SERVER_NOT_FOUND",
  "LSP_SERVER_START_FAILED", "LSP_INITIALIZE_FAILED", "LSP_SERVER_UNAVAILABLE",
  "LSP_TIMEOUT", "LSP_REQUEST_FAILED", "LSP_INVALID_ARGUMENT", "LSP_INVALID_PATH",
  "LSP_DOCUMENT_NOT_OPEN", "LSP_NO_PROVIDER",
]);

function toFailure(error: unknown): LspFailure {
  if (error instanceof LspManagerError) return failure(error.code, error.message);
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && LSP_ERROR_CODES.has(code as LspErrorCode))
    return failure(code as LspErrorCode, message);
  const name = error instanceof Error ? error.name : "";
  if (name === "JsonRpcTimeoutError") return failure("LSP_TIMEOUT", message);
  if (name === "JsonRpcCancelledError") return failure("LSP_REQUEST_FAILED", message);
  if (name === "JsonRpcResponseError") return failure("LSP_REQUEST_FAILED", message);
  return failure("LSP_REQUEST_FAILED", message || "The language server request failed.");
}

export class LspManager {
  private readonly options: LspManagerOptions;
  private readonly documents = new LspDocumentStore();
  private readonly diagnostics = new LspDiagnosticsStore();
  private readonly router = new LspFeatureRouter();
  private readonly sessions = new Map<string, LspSession>();
  /** How each live session was launched, so an inventory change can be matched. */
  private readonly sessionSources = new Map<string, LspExecutableResolution>();
  private readonly attempts = new Map<string, ServerAttempt>();
  private readonly associations = new Map<string, Set<string>>();
  private readonly pending = new Map<string, Set<string>>();
  private readonly resolutions = new Map<string, Promise<LspExecutableResolution>>();
  private readonly actionTokens = new Map<string, CachedAction>();
  private readonly completionTokens = new Map<string, CachedCompletion>();
  private readonly pendingApplyEdits = new Map<string, {
    resolve: (result: { applied: boolean; failureReason?: string }) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private generation = 0;
  private statusSequence = 0;
  private disposed = false;
  private ipc?: IpcHandlerRegistrar;

  constructor(options: LspManagerOptions) {
    this.options = options;
  }

  handleIPC(ipc: IpcHandlerRegistrar): void {
    this.ipc = ipc;
    ipc.handle("Lsp:status", async () => this.getStatus());
    ipc.handle("Lsp:openDocument", async (_event, payload) => this.openDocument(payload));
    ipc.handle("Lsp:changeDocument", async (_event, payload) => this.changeDocument(payload));
    ipc.handle("Lsp:saveDocument", async (_event, payload) => this.saveDocument(payload));
    ipc.handle("Lsp:closeDocument", async (_event, payload) => this.closeDocument(payload));
    ipc.handle("Lsp:completion", async (_event, payload) => this.completion(payload));
    ipc.handle("Lsp:resolveCompletion", async (_event, payload) => this.resolveCompletion(payload));
    ipc.handle("Lsp:hover", async (_event, payload) => this.hover(payload));
    ipc.handle("Lsp:definition", async (_event, payload) => this.locations(payload, "definition"));
    ipc.handle("Lsp:declaration", async (_event, payload) => this.locations(payload, "declaration"));
    ipc.handle("Lsp:implementation", async (_event, payload) => this.locations(payload, "implementation"));
    ipc.handle("Lsp:typeDefinition", async (_event, payload) => this.locations(payload, "typeDefinition"));
    ipc.handle("Lsp:references", async (_event, payload) => this.references(payload));
    ipc.handle("Lsp:prepareRename", async (_event, payload) => this.prepareRename(payload));
    ipc.handle("Lsp:rename", async (_event, payload) => this.rename(payload));
    ipc.handle("Lsp:codeActions", async (_event, payload) => this.codeActions(payload));
    ipc.handle("Lsp:resolveCodeAction", async (_event, payload) => this.resolveCodeAction(payload));
    ipc.handle("Lsp:executeCodeAction", async (_event, payload) => this.executeCodeAction(payload));
    ipc.handle("Lsp:format", async (_event, payload) => this.format(payload));
    ipc.handle("Lsp:documentSymbols", async (_event, payload) => this.documentSymbols(payload));
    ipc.handle("Lsp:workspaceSymbols", async (_event, payload) => this.workspaceSymbols(payload));
    ipc.handle("Lsp:signatureHelp", async (_event, payload) => this.signatureHelp(payload));
    ipc.handle("Lsp:restartServer", async (_event, payload) => this.restartServer(payload));
    ipc.handle("Lsp:applyEditResult", async (_event, payload) => this.finishApplyEdit(payload));
  }

  /** Called when the workspace changes; every session belongs to one workspace. */
  async handleWorkspaceChanged(): Promise<void> {
    if (this.disposed) return;
    this.generation += 1;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.sessionSources.clear();
    this.associations.clear();
    this.pending.clear();
    this.attempts.clear();
    this.actionTokens.clear();
    this.completionTokens.clear();
    this.rejectPendingApplyEdits("The language workspace changed.");
    this.documents.clear();
    this.diagnostics.clearAll();
    await Promise.allSettled(sessions.map((session) => session.stop()));
    if (this.disposed) return;
    this.emitReset();
    this.emitDiagnostics();
    void this.emitStatus();
  }

  async refreshSettings(): Promise<void> {
    if (this.disposed) return;
    // A settings change is broadcast to every window. Restarting every server
    // in every window would kill healthy sessions that have nothing to do with
    // the changed setting. Recompute each live session's resolution and only
    // restart the ones that actually changed.
    const settings = this.settings();
    this.resolutions.clear();
    const doomed: Array<[string, LspSession]> = [];
    for (const [key, session] of this.sessions) {
      const definition = getServerDefinition(session.serverId);
      if (!definition) {
        doomed.push([key, session]);
        continue;
      }
      const previous = this.sessionSources.get(key);
      const next = await this.resolveExecutable(definition, settings);
      if (this.disposed) return;
      if (!next.available || !this.serverEnabled(definition, settings) ||
          !this.sameResolution(previous, next)) {
        doomed.push([key, session]);
      }
    }
    if (doomed.length) {
      this.generation += 1;
      for (const [key] of doomed) {
        this.sessions.delete(key);
        this.sessionSources.delete(key);
        this.attempts.delete(key);
        this.pending.delete(key);
        this.forgetAssociations(key);
        this.diagnostics.clearServer(key);
      }
      this.rejectPendingApplyEdits("The language server settings changed.");
      await Promise.allSettled(doomed.map(([, session]) => session.stop()));
      if (this.disposed) return;
      // Only tell the renderer to drop state for the sessions that actually
      // changed; unrelated servers keep their diagnostics and documents.
      this.emitReset();
      this.emitDiagnostics();
      // The renderer's reset drops every document, so re-synchronize all of
      // them. attachOpenDocuments is idempotent: sessions that were not
      // restarted already hold their associations and get no second didOpen.
      await this.attachOpenDocuments([...getServerDefinitions()]);
    }
    void this.emitStatus();
  }

  private sameResolution(
    previous: LspExecutableResolution | undefined,
    next: LspExecutableResolution,
  ): boolean {
    if (!previous) return false;
    return previous.available === next.available &&
      previous.command === next.command &&
      previous.source === next.source &&
      JSON.stringify(previous.args) === JSON.stringify(next.args) &&
      JSON.stringify(previous.initializationOptions ?? {}) === JSON.stringify(next.initializationOptions ?? {});
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.sessionSources.clear();
    this.associations.clear();
    this.pending.clear();
    this.attempts.clear();
    this.actionTokens.clear();
    this.completionTokens.clear();
    this.rejectPendingApplyEdits("The language workspace changed.");
    this.documents.clear();
    this.diagnostics.clearAll();
    await Promise.allSettled(sessions.map((session) => session.stop()));
  }

  async openDocument(payload: unknown): Promise<LspResult<LspDocumentInfo>> {
    try {
      const input = asObject(payload);
      const text = input?.text;
      if (typeof text !== "string" || text.includes("\0"))
        throw new LspManagerError("LSP_INVALID_ARGUMENT", "A document text is required.");
      if (Buffer.byteLength(text, "utf8") > (this.options.maxDocumentBytes ?? MAX_DOCUMENT_BYTES))
        throw new LspManagerError("LSP_INVALID_ARGUMENT", "This file is too large to synchronize with a language server.");
      const target = await this.authorizeFile(input?.path, { requireFile: true });
      const languageId = languageIdForPath(target.path);
      if (!languageId)
        return { success: true, supported: false, languageId: null, servers: [] };
      const settings = this.settings();
      if (!settings.enabled)
        return { success: true, supported: false, languageId: null, servers: [] };
      // Capture the generation before any await: a reset that lands during
      // resolution must invalidate this open, not be silently outrun by it.
      const generation = this.generation;
      const definitions = serversForLanguage(languageId)
        .filter((definition) => this.serverEnabled(definition, settings));
      // A language NCE supports with no active server is not synchronized. The
      // document is still registered, with an empty association set, so feature
      // requests answer LSP_NO_PROVIDER (an honest "nothing to ask") instead of
      // LSP_DOCUMENT_NOT_OPEN (which claims the renderer is out of sync).
      if (!definitions.length) {
        this.detachDocument(target.path, { clearDiagnostics: false });
        this.documents.open(target.path, pathToUri(target.path), languageId, text);
        this.associations.set(target.path, new Set());
        void this.emitStatus();
        return { success: true, supported: true, languageId, path: target.path, servers: [] };
      }

      this.detachDocument(target.path, { clearDiagnostics: false });
      const document = this.documents.open(target.path, pathToUri(target.path), languageId, text);
      this.associations.set(target.path, new Set());
      const servers: LspServerRoute[] = [];
      for (const definition of definitions) {
        const root = await resolveServerRoot(definition, target.path, target.workspace);
        const key = this.sessionKey(definition.id, root);
        const resolution = await this.resolveExecutable(definition, settings);
        // Opening awaits executable and root resolution. A settings or workspace
        // reset during that window clears the store and bumps the generation, so
        // this document no longer exists. Report the supersession instead of
        // returning a success for a document the manager has already dropped.
        if (this.isSuperseded(generation)) {
          this.documents.close(target.path);
          this.associations.delete(target.path);
          return { success: false, code: "LSP_OPEN_SUPERSEDED", error: "The language workspace changed while the document was opening. It will be synchronized again." };
        }
        if (!resolution.available) {
          this.attempts.set(key, {
            key,
            serverId: definition.id,
            serverName: definition.name,
            root,
            state: "unavailable",
            error: resolution.error,
          });
          continue;
        }
        const attached = await this.attachDocumentToServer(
          definition,
          root,
          resolution,
          document,
          target.workspace,
        );
        if (!attached) continue;
        servers.push({
          serverId: definition.id,
          serverName: definition.name,
          priority: definition.priority,
        });
      }
      if (this.isSuperseded(generation)) {
        this.documents.close(target.path);
        this.associations.delete(target.path);
        return { success: false, code: "LSP_OPEN_SUPERSEDED", error: "The language workspace changed while the document was opening. It will be synchronized again." };
      }
      void this.emitStatus();
      return { success: true, supported: true, languageId, path: target.path, servers };
    } catch (error) {
      return toFailure(error);
    }
  }

  async changeDocument(payload: unknown): Promise<LspResult<{ version: number }>> {
    try {
      const input = asObject(payload);
      const target = await this.authorizeFile(input?.path, { allowMissing: true });
      const document = this.documents.get(target.path);
      if (!document)
        throw new LspManagerError("LSP_DOCUMENT_NOT_OPEN", "This document is not synchronized with a language server.");
      const changes = this.parseChanges(input?.changes);
      const result = this.documents.change(target.path, changes, this.options.maxDocumentBytes ?? MAX_DOCUMENT_BYTES);
      if (!result)
        throw new LspManagerError("LSP_DOCUMENT_NOT_OPEN", "This document is not synchronized with a language server.");
      for (const key of this.associations.get(target.path) || []) {
        const session = this.sessions.get(key);
        if (session?.state === "ready") session.changeDocument(result.document, result.applied);
      }
      return { success: true, version: result.document.version };
    } catch (error) {
      return toFailure(error);
    }
  }

  async saveDocument(payload: unknown): Promise<LspEmptyResult> {
    try {
      const input = asObject(payload);
      const target = await this.authorizeFile(input?.path, { allowMissing: true });
      const document = this.documents.save(
        target.path,
        typeof input?.text === "string" ? input.text : undefined,
      );
      if (!document)
        throw new LspManagerError("LSP_DOCUMENT_NOT_OPEN", "This document is not synchronized with a language server.");
      for (const key of this.associations.get(target.path) || []) {
        const session = this.sessions.get(key);
        if (session?.state === "ready") session.saveDocument(document);
      }
      return { success: true };
    } catch (error) {
      return toFailure(error);
    }
  }

  async closeDocument(payload: unknown): Promise<LspEmptyResult> {
    try {
      const input = asObject(payload);
      const target = await this.authorizeFile(input?.path, { allowMissing: true });
      this.detachDocument(target.path, { clearDiagnostics: true });
      return { success: true };
    } catch (error) {
      return toFailure(error);
    }
  }

  async completion(payload: unknown): Promise<LspResult<{ items: unknown[]; incomplete: boolean }>> {
    try {
      const { document, routes } = await this.featureContext(payload, { position: true });
      if (!routes.some((route) => route.session.capabilities.completion))
        throw new LspManagerError("LSP_NO_PROVIDER", "No language server provides completion for this document.");
      const input = asObject(payload);
      const context = input?.triggerKind !== undefined
        ? {
            triggerKind: Number(input.triggerKind),
            ...(typeof input.triggerCharacter === "string"
              ? { triggerCharacter: input.triggerCharacter.slice(0, 8) }
              : {}),
          }
        : undefined;
      const result = await this.router.completion(
        routes,
        {
          textDocument: { uri: document.uri },
          position: input?.position,
          ...(context ? { context } : {}),
        },
      );
      for (const item of result.items) {
        const token = randomUUID();
        item.id = token;
        this.completionTokens.set(token, {
          item,
          routeKey: this.routeKeyFor(document.path, item.source) || "",
          expiresAt: Date.now() + ACTION_TOKEN_TTL_MS,
        });
      }
      this.pruneCompletionTokens();
      return { success: true, items: result.items, incomplete: result.incomplete };
    } catch (error) {
      return toFailure(error);
    }
  }

  async resolveCompletion(payload: unknown): Promise<LspResult<{ item: unknown }>> {
    try {
      const id = asObject(payload)?.id;
      if (typeof id !== "string")
        throw new LspManagerError("LSP_INVALID_ARGUMENT", "Unknown completion item.");
      const cached = this.completionTokens.get(id);
      if (!cached || cached.expiresAt < Date.now()) {
        this.completionTokens.delete(id);
        throw new LspManagerError("LSP_INVALID_ARGUMENT", "This completion item expired.");
      }
      const route = this.routeByKey(cached.routeKey);
      if (!route)
        throw new LspManagerError("LSP_SERVER_UNAVAILABLE", "The language server for this completion is no longer running.");
      const item = await this.router.resolveCompletion(route, cached.item);
      cached.item = item;
      return { success: true, item };
    } catch (error) {
      return toFailure(error);
    }
  }

  async hover(payload: unknown): Promise<LspResult<{ hover: unknown }>> {
    try {
      const { document, routes } = await this.featureContext(payload, { position: true });
      if (!routes.some((route) => route.session.capabilities.hover))
        throw new LspManagerError("LSP_NO_PROVIDER", "No language server provides hover information.");
      const input = asObject(payload);
      const routed = await this.router.hover(routes, {
        textDocument: { uri: document.uri },
        position: input?.position,
      });
      if ("error" in routed) throw routed.error;
      return { success: true, hover: routed.value };
    } catch (error) {
      return toFailure(error);
    }
  }

  async locations(
    payload: unknown,
    capability: "definition" | "declaration" | "implementation" | "typeDefinition",
  ): Promise<LspResult<{ locations: unknown[] }>> {
    try {
      const { document, routes } = await this.featureContext(payload, { position: true });
      if (!routes.some((route) => route.session.capabilities[capability]))
        throw new LspManagerError("LSP_NO_PROVIDER", `No language server provides ${capability}.`);
      const input = asObject(payload);
      const locations = await this.router.locations(routes, {
        textDocument: { uri: document.uri },
        position: input?.position,
      }, capability);
      return { success: true, locations: await this.decorateLocations(locations) };
    } catch (error) {
      return toFailure(error);
    }
  }

  async references(payload: unknown): Promise<LspResult<{ groups: unknown[]; total: number }>> {
    try {
      const { document, routes } = await this.featureContext(payload, { position: true });
      if (!routes.some((route) => route.session.capabilities.references))
        throw new LspManagerError("LSP_NO_PROVIDER", "No language server provides references.");
      const input = asObject(payload);
      const groups = await this.router.references(routes, {
        textDocument: { uri: document.uri },
        position: input?.position,
        context: { includeDeclaration: input?.includeDeclaration !== false },
      });
      const decorated = await Promise.all(groups.map(async (group) => ({
        ...group,
        locations: await this.decorateLocations(group.locations),
      })));
      const total = decorated.reduce((count, group) => count + group.locations.length, 0);
      return { success: true, groups: decorated, total };
    } catch (error) {
      return toFailure(error);
    }
  }

  async prepareRename(payload: unknown): Promise<LspResult<{ preparation: unknown }>> {
    try {
      const { document, routes } = await this.featureContext(payload, { position: true });
      if (!routes.some((route) => route.session.capabilities.rename))
        throw new LspManagerError("LSP_NO_PROVIDER", "No language server provides rename.");
      const input = asObject(payload);
      const routed = await this.router.prepareRename(routes, {
        textDocument: { uri: document.uri },
        position: input?.position,
      });
      if ("error" in routed) throw routed.error;
      return { success: true, preparation: routed.value };
    } catch (error) {
      return toFailure(error);
    }
  }

  async rename(payload: unknown): Promise<LspResult<{ edit: LspWorkspaceEdit | null }>> {
    try {
      const { document, routes } = await this.featureContext(payload, { position: true });
      if (!routes.some((route) => route.session.capabilities.rename))
        throw new LspManagerError("LSP_NO_PROVIDER", "No language server provides rename.");
      const input = asObject(payload);
      const newName = input?.newName;
      if (typeof newName !== "string" || !newName.trim() || newName.length > 512 || newName.includes("\0"))
        throw new LspManagerError("LSP_INVALID_ARGUMENT", "A valid new symbol name is required.");
      const edit = await this.router.rename(routes, {
        textDocument: { uri: document.uri },
        position: input?.position,
        newName,
      });
      const sanitized = await this.sanitizeWorkspaceEdit(edit);
      return { success: true, edit: sanitized };
    } catch (error) {
      return toFailure(error);
    }
  }

  async codeActions(payload: unknown): Promise<LspResult<{ actions: LspCodeAction[] }>> {
    try {
      const { document, routes } = await this.featureContext(payload, { position: false, range: true });
      if (!routes.some((route) => route.session.capabilities.codeAction))
        throw new LspManagerError("LSP_NO_PROVIDER", "No language server provides code actions.");
      const input = asObject(payload);
      const range = input?.range;
      if (!validateRange(range))
        throw new LspManagerError("LSP_INVALID_ARGUMENT", "A valid range is required for code actions.");
      const context = asObject(input?.context);
      const diagnostics = this.parseDiagnosticContext(context?.diagnostics);
      const actions = await this.router.codeActions(routes, {
        textDocument: { uri: document.uri },
        range,
        context: {
          diagnostics,
          ...(context && Array.isArray(context.only)
            ? { only: context.only.filter((value: unknown) => typeof value === "string") }
            : {}),
          ...(context && Number.isSafeInteger(context.triggerKind)
            ? { triggerKind: context.triggerKind }
            : {}),
        },
      });
      for (const action of actions) {
        const token = randomUUID();
        action.id = token;
        this.actionTokens.set(token, {
          action,
          routeKey: this.routeKeyFor(document.path, action.source) || "",
          expiresAt: Date.now() + ACTION_TOKEN_TTL_MS,
        });
      }
      this.pruneActionTokens();
      return { success: true, actions };
    } catch (error) {
      return toFailure(error);
    }
  }

  async resolveCodeAction(payload: unknown): Promise<LspResult<{ action: LspCodeAction }>> {
    try {
      const token = this.actionToken(asObject(payload)?.id);
      const route = this.routeByKey(token.routeKey);
      if (!route)
        throw new LspManagerError("LSP_SERVER_UNAVAILABLE", "The language server for this action is no longer running.");
      const action = await this.router.resolveCodeAction(route, token.action);
      if (action.edit) {
        const sanitized = await this.sanitizeWorkspaceEdit(action.edit);
        if (sanitized) action.edit = sanitized;
      }
      action.id = token.action.id;
      token.action = action;
      return { success: true, action };
    } catch (error) {
      return toFailure(error);
    }
  }

  async executeCodeAction(payload: unknown): Promise<LspResult<{ edit: LspWorkspaceEdit | null }>> {
    try {
      const token = this.actionToken(asObject(payload)?.id);
      const action = token.action;
      if (action.edit) return { success: true, edit: action.edit };
      if (!action.command)
        throw new LspManagerError("LSP_INVALID_ARGUMENT", "This action has no edit or command.");
      const route = this.routeByKey(token.routeKey);
      if (!route)
        throw new LspManagerError("LSP_SERVER_UNAVAILABLE", "The language server for this action is no longer running.");
      const result = await route.session.request<unknown>("workspace/executeCommand", {
        command: action.command.command,
        arguments: action.command.arguments ?? [],
      });
      const edit = this.router.normalizeWorkspaceEdit(result, route.session.serverId);
      const sanitized = edit ? await this.sanitizeWorkspaceEdit(edit) : null;
      return { success: true, edit: sanitized };
    } catch (error) {
      return toFailure(error);
    }
  }

  async format(payload: unknown): Promise<LspResult<{ edit: LspWorkspaceEdit | null }>> {
    try {
      const { document, routes } = await this.featureContext(payload, { position: false, range: false });
      const input = asObject(payload);
      const range = input?.range;
      if (range !== undefined && !validateRange(range))
        throw new LspManagerError("LSP_INVALID_ARGUMENT", "A valid formatting range is required.");
      const capable = routes.some((route) =>
        route.session.capabilities[range ? "rangeFormatting" : "formatting"]);
      if (!capable)
        throw new LspManagerError("LSP_NO_PROVIDER", "No language server provides formatting.");
      const tabSize = Math.max(1, Math.min(16, Math.round(this.options.getTabSize?.() ?? 2)));
      const result = await this.router.formatting(routes, {
        textDocument: { uri: document.uri },
        options: { tabSize, insertSpaces: true },
      }, range ?? null);
      if (!result || !result.edits.length)
        return { success: true, edit: null };
      const edit: LspWorkspaceEdit = {
        source: result.source,
        files: [{
          path: document.path,
          uri: document.uri,
          version: document.version,
          edits: result.edits,
        }],
      };
      const sanitized = await this.sanitizeWorkspaceEdit(edit);
      return { success: true, edit: sanitized };
    } catch (error) {
      return toFailure(error);
    }
  }

  async documentSymbols(payload: unknown): Promise<LspResult<{ symbols: unknown[] }>> {
    try {
      const { document, routes } = await this.featureContext(payload, { position: false });
      if (!routes.some((route) => route.session.capabilities.documentSymbols))
        throw new LspManagerError("LSP_NO_PROVIDER", "No language server provides document symbols.");
      const symbols = await this.router.documentSymbols(routes, {
        textDocument: { uri: document.uri },
      });
      return { success: true, symbols };
    } catch (error) {
      return toFailure(error);
    }
  }

  async workspaceSymbols(payload: unknown): Promise<LspResult<{ symbols: unknown[] }>> {
    try {
      const input = asObject(payload);
      const query = typeof input?.query === "string" ? input.query.slice(0, 256) : "";
      const target = await this.authorizeFile(input?.path, { allowMissing: true });
      const document = this.documents.get(target.path);
      if (!document)
        throw new LspManagerError("LSP_DOCUMENT_NOT_OPEN", "Open a supported document before searching workspace symbols.");
      const routes = this.routesFor(target.path);
      if (!routes.some((route) => route.session.capabilities.workspaceSymbols))
        throw new LspManagerError("LSP_NO_PROVIDER", "No language server provides workspace symbols.");
      const symbols = await this.router.workspaceSymbols(routes, query);
      const decorated = await Promise.all(symbols.map(async (symbol) => ({
        ...symbol,
        location: (await this.decorateLocations([symbol.location]))[0],
      })));
      return { success: true, symbols: decorated };
    } catch (error) {
      return toFailure(error);
    }
  }

  async signatureHelp(payload: unknown): Promise<LspResult<{ help: unknown }>> {
    try {
      const { document, routes } = await this.featureContext(payload, { position: true });
      if (!routes.some((route) => route.session.capabilities.signatureHelp))
        throw new LspManagerError("LSP_NO_PROVIDER", "No language server provides signature help.");
      const input = asObject(payload);
      const signatureContext = asObject(input?.context);
      const routed = await this.router.signatureHelp(routes, {
        textDocument: { uri: document.uri },
        position: input?.position,
        ...(signatureContext ? { context: signatureContext } : {}),
      });
      if ("error" in routed) throw routed.error;
      return { success: true, help: routed.value };
    } catch (error) {
      return toFailure(error);
    }
  }

  async restartServer(payload: unknown): Promise<LspEmptyResult> {
    try {
      const input = asObject(payload);
      const requestedId = input?.serverId;
      if (typeof requestedId !== "string")
        throw new LspManagerError("LSP_INVALID_ARGUMENT", "Unknown language server.");
      // Legacy ids such as `basedpyright` are accepted elsewhere in settings;
      // restartServer must normalize them too or it rejects a valid server.
      const serverId = normalizeServerId(requestedId);
      if (!getServerDefinition(serverId))
        throw new LspManagerError("LSP_INVALID_ARGUMENT", "Unknown language server.");
      const previousAttempts = new Map<string, ServerAttempt>();
      for (const [key, attempt] of this.attempts) {
        if (attempt.serverId !== serverId) continue;
        previousAttempts.set(key, attempt);
        this.attempts.delete(key);
      }
      for (const key of [...this.resolutions.keys()]) {
        if (key.startsWith(`${serverId}:`)) this.resolutions.delete(key);
      }
      const sessions = [...this.sessions.values()].filter((session) => session.serverId === serverId);
      for (const session of sessions) {
        this.sessions.delete(session.key);
        this.sessionSources.delete(session.key);
        this.attempts.delete(session.key);
        this.diagnostics.clearServer(session.key);
        for (const [documentPath, keys] of this.associations) {
          keys.delete(session.key);
          if (!keys.size) this.associations.delete(documentPath);
        }
        this.pending.delete(session.key);
      }
      await Promise.allSettled(sessions.map((session) => session.stop()));
      this.emitDiagnostics();
      const settings = this.settings();
      for (const document of this.documents.all()) {
        const definition = getServerDefinition(serverId);
        if (!definition || !definition.languages.includes(document.languageId)) continue;
        if (!this.serverEnabled(definition, settings)) continue;
        const workspace = await this.getWorkspace();
        if (!workspace) continue;
        const root = await resolveServerRoot(definition, document.path, workspace);
        const resolution = await this.resolveExecutable(definition, settings);
        if (!resolution.available) {
          this.attempts.set(this.sessionKey(definition.id, root), {
            key: this.sessionKey(definition.id, root),
            serverId: definition.id,
            serverName: definition.name,
            root,
            state: "unavailable",
            error: resolution.error,
          });
          continue;
        }
        await this.attachDocumentToServer(definition, root, resolution, document, workspace);
      }
      // With no open document to re-attach, keep the previous failure reason:
      // dropping it would hide an unavailable server from the Problems panel.
      for (const [key, attempt] of previousAttempts) {
        if (!this.sessions.has(key) && !this.attempts.has(key)) this.attempts.set(key, attempt);
      }
      void this.emitStatus();
      return { success: true };
    } catch (error) {
      return toFailure(error);
    }
  }

  handleFileSystemEvent(event: string, filePath: string): void {
    if (this.disposed || typeof filePath !== "string" || !path.isAbsolute(filePath)) return;
    if (this.isNceStatePath(filePath)) return;
    const type = event === "add" || event === "addDir" ? 1
      : event === "change" ? 2
        : event === "unlink" || event === "unlinkDir" || event === "root-deleted" ? 3
          : 0;
    if (!type) return;
    let uri: string;
    try {
      uri = pathToUri(filePath);
    } catch {
      return;
    }
    for (const session of this.sessions.values()) {
      if (session.state !== "ready") continue;
      if (!isInside(session.root, filePath)) continue;
      session.notifyWatchedFileChanges([{ uri, type: type as 1 | 2 | 3 }]);
    }
  }

  async getStatus(): Promise<LspResult<LspStatusSnapshot>> {
    try {
      const settings = this.settings();
      const definitions = await Promise.all(getServerDefinitions().map(async (definition) => {
        const resolution = await this.resolveExecutable(definition, settings);
        return {
          id: definition.id,
          name: definition.name,
          languages: [...definition.languages],
          extensions: [...definition.extensions],
          defaultEnabled: definition.defaultEnabled,
          priority: definition.priority,
          enabled: this.serverEnabled(definition, settings),
          executable: resolution.command,
          args: [...resolution.args],
          source: resolution.source,
          available: resolution.available,
          error: resolution.error,
          description: definition.description,
          requiresConfiguration: definition.requiresConfiguration === true,
        };
      }));
      const workspace = await this.getWorkspace();
      const liveKeys = new Set<string>();
      const sessions: LspStatusSnapshot["sessions"] = [];
      for (const [key, session] of this.sessions) {
        liveKeys.add(key);
        sessions.push(this.sessionView(session, key));
      }
      for (const [key, attempt] of this.attempts) {
        if (liveKeys.has(key)) continue;
        sessions.push({
          serverId: attempt.serverId,
          serverName: attempt.serverName,
          root: attempt.root,
          state: attempt.state === "unavailable" ? "failed" : attempt.state as LspSessionState,
          error: attempt.error,
          documents: 0,
          capabilities: {
            completion: false, completionResolve: false, hover: false, definition: false, references: false,
            rename: false, codeAction: false, formatting: false, rangeFormatting: false,
            documentSymbols: false, workspaceSymbols: false, signatureHelp: false,
            completionTriggerCharacters: [], signatureHelpTriggerCharacters: [],
          },
        });
      }
      return {
        success: true,
        enabled: settings.enabled,
        workspace,
        servers: definitions,
        sessions,
      };
    } catch (error) {
      return toFailure(error);
    }
  }

  private sessionView(session: LspSession, key: string): LspStatusSnapshot["sessions"][number] {
    const documents = [...(this.associations.values())]
      .filter((keys) => keys.has(key)).length;
    const capabilities = session.capabilities;
    return {
      serverId: session.serverId,
      serverName: session.serverName,
      root: session.root,
      state: session.state,
      error: session.error,
      documents,
      capabilities: {
        completion: capabilities.completion,
        completionResolve: capabilities.completionResolve,
        hover: capabilities.hover,
        definition: capabilities.definition,
        references: capabilities.references,
        rename: capabilities.rename,
        codeAction: capabilities.codeAction,
        formatting: capabilities.formatting,
        rangeFormatting: capabilities.rangeFormatting,
        documentSymbols: capabilities.documentSymbols,
        workspaceSymbols: capabilities.workspaceSymbols,
        signatureHelp: capabilities.signatureHelp,
        completionTriggerCharacters: [...capabilities.completionTriggerCharacters],
        signatureHelpTriggerCharacters: [...capabilities.signatureHelpTriggerCharacters],
      },
    };
  }

  private settings() {
    return sanitizeLspSettings(this.options.getSettings());
  }

  private serverEnabled(definition: LspServerDefinition, settings: ReturnType<LspManager["settings"]>): boolean {
    if (!settings.enabled) return false;
    const override = this.serverSettings(definition, settings);
    return override?.enabled ?? definition.defaultEnabled;
  }

  private serverConfiguration(
    definition: LspServerDefinition,
    settings: ReturnType<LspManager["settings"]>,
  ): LspServerConfiguration | undefined {
    return this.serverSettings(definition, settings);
  }

  /**
   * Settings for a server, honouring legacy ids.
   *
   * A configuration written before a server was renamed (for example
   * `basedpyright` for `pyright`) must keep working, so the current id is tried
   * first and the legacy alias second.
   */
  private serverSettings(
    definition: LspServerDefinition,
    settings: ReturnType<LspManager["settings"]>,
  ): LspServerConfiguration | undefined {
    const direct = settings.servers[definition.id];
    if (direct) return direct;
    for (const [legacyId, currentId] of Object.entries(SERVER_ID_ALIASES)) {
      if (currentId !== definition.id) continue;
      const legacy = settings.servers[legacyId];
      if (legacy) return legacy;
    }
    return undefined;
  }

  private resolveExecutable(
    definition: LspServerDefinition,
    settings: ReturnType<LspManager["settings"]>,
  ): Promise<LspExecutableResolution> {
    const key = `${definition.id}:${JSON.stringify(this.serverSettings(definition, settings) || {})}`;
    let resolution = this.resolutions.get(key);
    if (!resolution) {
      resolution = resolveServerExecutable({
        definition,
        configuration: this.serverConfiguration(definition, settings),
        env: this.options.env ?? process.env,
        platform: this.options.platform ?? process.platform,
        managed: this.options.managedTools ?? null,
        internalRuntime: this.options.internalRuntime ?? null,
      });
      this.resolutions.set(key, resolution);
    }
    return resolution;
  }

  /**
   * Drop cached executable resolutions. Called when the managed package
   * inventory changes: a negative resolution must not survive an installation,
   * and a positive one must not survive an uninstall.
   */
  invalidateResolutions(serverId?: string): void {
    if (!serverId) {
      this.resolutions.clear();
      return;
    }
    for (const key of [...this.resolutions.keys()]) {
      if (key.startsWith(`${serverId}:`)) this.resolutions.delete(key);
    }
  }

  /**
   * React to a change in the managed package inventory.
   *
   * Two cases must be handled, and they are not the same:
   *
   * - A server whose launch depends on a changed package is torn down so the
   *   next request re-resolves it. This covers installs, upgrades and repairs.
   * - A server that was launched from a managed installation which is now gone
   *   (or no longer usable) must be stopped and have its diagnostics cleared.
   *   Uninstalling a language server used to leave its process running and its
   *   problems still listed in the Problems panel, describing a server that no
   *   longer existed.
   *
   * Only servers whose launch actually depends on the changed package are
   * affected, so installing an unrelated package never tears down healthy
   * sessions.
   */
  async handleManagedPackagesChanged(packageIds: Iterable<string> = []): Promise<void> {
    if (this.disposed) return;
    const changed = new Set(packageIds);

    // An empty set means "the inventory moved, but not which package": a
    // reconcile or a manual refresh. It must not be read as "every managed
    // server changed", or refreshing the inventory would kill every healthy
    // language server. In that case only servers that can no longer be
    // resolved are stopped.
    const affected = changed.size
      ? getServerDefinitions().filter((definition) => {
        const spec = definition.managed;
        if (!spec) return false;
        return changed.has(spec.packageId)
          || (spec.runtimePackageId ? changed.has(spec.runtimePackageId) : false)
          || (spec.dependencyPackageIds ?? []).some((id) => changed.has(id));
      })
      : [];

    // Servers worth retrying after the inventory settles. On a refresh the
    // caller could not name a package, so every managed server is a candidate:
    // an install that landed during a reconcile must still be picked up.
    const retryable = changed.size
      ? affected
      : getServerDefinitions().filter((definition) => Boolean(definition.managed));

    // A session launched from a managed installation that is gone, or that can
    // no longer be resolved, is dead even when its server is not in the changed
    // set: the executable it is running from may have been deleted.
    const orphaned = new Set<string>();
    for (const [key, resolution] of this.sessionSources) {
      if (resolution.source !== "managed") continue;
      const serverId = this.sessions.get(key)?.serverId;
      if (!serverId) continue;
      const stillUsable = await this.managedLaunchStillUsable(serverId);
      if (!stillUsable) orphaned.add(serverId);
    }

    // A changed inventory invalidates every cached launch decision, including
    // when the caller could not say which package moved: a negative resolution
    // must not survive an install.
    this.resolutions.clear();

    const affectedIds = new Set(affected.map((definition) => definition.id));
    // Only a session that actually launched from the managed installation is
    // invalidated by it. A server the user pointed at their own executable does
    // not depend on the package and must survive an unrelated install.
    const doomed = [...this.sessions.entries()]
      .filter(([key, session]) => {
        if (orphaned.has(session.serverId)) return true;
        if (!affectedIds.has(session.serverId)) return false;
        return this.sessionSources.get(key)?.source === "managed";
      });

    if (doomed.length) {
      // Sessions for the changed servers are stopped; the documents they served
      // are re-attached below against the fresh resolution. A server that is no
      // longer installed simply cannot be restarted, and reports that when
      // asked.
      this.generation += 1;
      for (const [key, session] of doomed) {
        this.sessions.delete(key);
        this.sessionSources.delete(key);
        this.attempts.delete(key);
        this.pending.delete(key);
        // Associations are indexed by document path, each holding a set of
        // session keys. Deleting by session key was a no-op, so healthy
        // documents stayed associated with a stopped session and were never
        // re-attached after a managed package change.
        this.forgetAssociations(key);
        // Diagnostics are stored under the session key (`serverId::root`), not
        // the bare server id: clearing by server id removed nothing, which is
        // why an uninstalled server's problems stayed in the Problems panel.
        this.diagnostics.clearServer(key);
      }
      this.rejectPendingApplyEdits("The managed language server changed.");
      await Promise.allSettled(doomed.map(([, session]) => session.stop()));
      if (this.disposed) return;
      this.emitDiagnostics();
    }

    // An install is the mirror image of an uninstall: there is no session to
    // tear down, because the server could not be resolved when the document was
    // opened. Without this the open document stayed unsynchronized until the
    // window was reloaded.
    await this.attachOpenDocuments(retryable);
    if (this.disposed) return;
    void this.emitStatus();
  }

  /**
   * Attach already-open documents to servers that can now be launched.
   *
   * Only documents that are not already served by the server are touched, so
   * this is safe to call when nothing changed. A document whose server is still
   * unavailable is left alone: the next open or restart reports the reason.
   */
  private async attachOpenDocuments(definitions: LspServerDefinition[]): Promise<void> {
    if (!definitions.length) return;
    const settings = this.settings();
    const workspace = await this.getWorkspace();
    if (!workspace) return;
    for (const definition of definitions) {
      if (!this.serverEnabled(definition, settings)) continue;
      for (const document of this.documents.all()) {
        if (!definition.languages.includes(document.languageId)) continue;
        const root = await resolveServerRoot(definition, document.path, workspace);
        const key = this.sessionKey(definition.id, root);
        // Already served: nothing to do. Re-attaching would send a second
        // didOpen for a document the session already has.
        if (this.associations.get(document.path)?.has(key)) continue;
        const resolution = await this.resolveExecutable(definition, settings);
        if (this.disposed) return;
        if (!resolution.available) continue;
        await this.attachDocumentToServer(definition, root, resolution, document, workspace);
      }
    }
  }

  /**
   * Whether a session's managed launch can still be resolved.
   *
   * Only called for sessions that were launched from a managed installation, so
   * "no longer installed by NCE" is not a neutral state here: it means the
   * package was uninstalled and the executable the session is running from is
   * gone. Any unavailable resolution therefore counts as orphaned.
   *
   * A server with no managed spec, or an inventory read that fails, is left
   * alone: PATH and custom configurations are not the inventory's business, and
   * a transient read failure must not tear down a working session.
   */
  private async managedLaunchStillUsable(serverId: string): Promise<boolean> {
    const definition = getServerDefinition(serverId);
    const spec = definition?.managed;
    if (!spec) return true;
    const managed = this.options.managedTools;
    if (!managed) return true;
    try {
      const resolution = await managed.resolve(spec.packageId, spec.entryPoint);
      if (!resolution.available) return false;
      // A runtime dependency can disappear while the server binary itself is
      // still present. The TypeScript SDK is the concrete case: its path was
      // injected at initialize time and cannot be changed afterwards.
      for (const dependencyId of spec.dependencyPackageIds ?? []) {
        const dependency = await managed.resolve(dependencyId);
        if (!dependency.available) return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  private sessionKey(serverId: string, root: string): string {
    return `${serverId}::${root}`;
  }

  /**
   * True when a settings or workspace reset happened while an asynchronous
   * operation was in flight. Such an operation must not report success and must
   * not attach anything to the sessions created after the reset.
   */
  private isSuperseded(generation: number): boolean {
    return this.disposed || generation !== this.generation;
  }

  private async attachDocumentToServer(
    definition: LspServerDefinition,
    root: string,
    resolution: LspExecutableResolution,
    document: LspOpenDocument,
    workspaceRoot: string,
  ): Promise<boolean> {
    const key = this.sessionKey(definition.id, root);
    const existing = this.sessions.get(key);
    if (existing && (existing.state === "failed" || existing.state === "stopped"))
      return false;
    let pending = this.pending.get(key);
    if (!pending) {
      pending = new Set();
      this.pending.set(key, pending);
    }
    pending.add(document.path);
    if (!existing) {
      void this.startSession(definition, root, resolution, workspaceRoot);
      return true;
    }
    if (existing.state === "ready") this.flushDocument(key, existing, document.path);
    return true;
  }

  private async startSession(
    definition: LspServerDefinition,
    root: string,
    resolution: LspExecutableResolution,
    workspaceRoot: string,
  ): Promise<void> {
    if (this.sessions.has(this.sessionKey(definition.id, root))) return;
    const generation = this.generation;
    const key = this.sessionKey(definition.id, root);
    const session = new LspSession({
      definition,
      executable: resolution,
      root,
      workspaceRoot,
      // Resolution-time options (for example the managed `tsserver.path`) win
      // over the static definition defaults.
      initializationOptions: resolution.initializationOptions
        ? { ...(definition.initializationOptions ?? {}), ...resolution.initializationOptions }
        : definition.initializationOptions,
      events: {
        onStatus: (updated) => {
          if (this.sessions.get(key) !== updated) return;
          this.attempts.set(key, {
            key,
            serverId: updated.serverId,
            serverName: updated.serverName,
            root: updated.root,
            state: updated.state,
            error: updated.error,
          });
          if (updated.state === "failed" || updated.state === "stopped") {
            this.diagnostics.clearServer(key);
            this.forgetAssociations(key);
            this.pending.delete(key);
            this.emitDiagnostics();
          }
          void this.emitStatus();
        },
        onDiagnostics: (serverKey, uri, version, diagnostics) => {
          const owner = this.sessions.get(key);
          if (serverKey !== key || !owner) return;
          void this.handleDiagnostics(serverKey, uri, version, diagnostics, owner);
        },
        onLog: (serverKey, level, message) => {
          this.options.onLog?.(serverKey, level, message);
        },
        onProgress: (serverKey, progress) => {
          this.options.send?.("Lsp:progress", { serverId: serverKey, ...progress });
        },
        onMessage: (serverKey, type, message) => {
          this.options.send?.("Lsp:message", { serverId: serverKey, type, message });
        },
      },
      env: this.options.env,
      platform: this.options.platform,
      requestTimeoutMs: this.options.requestTimeoutMs,
      applyWorkspaceEdit: (edit) => this.applyServerWorkspaceEdit(edit, definition.id),
    });
    this.sessions.set(key, session);
    this.sessionSources.set(key, resolution);
    this.diagnostics.setServerName(key, definition.name);
    this.attempts.set(key, {
      key,
      serverId: definition.id,
      serverName: definition.name,
      root,
      state: "starting",
      error: null,
    });
    void this.emitStatus();
    try {
      await session.start();
      if (generation !== this.generation || this.sessions.get(key) !== session) {
        await session.stop();
        return;
      }
      this.attempts.set(key, {
        key,
        serverId: definition.id,
        serverName: definition.name,
        root,
        state: "ready",
        error: null,
      });
      const pending = this.pending.get(key);
      if (pending) {
        for (const documentPath of [...pending]) {
          this.flushDocument(key, session, documentPath);
        }
      }
      void this.emitStatus();
    } catch (error) {
      if (generation !== this.generation || this.sessions.get(key) !== session) return;
      this.attempts.set(key, {
        key,
        serverId: definition.id,
        serverName: definition.name,
        root,
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      this.pending.delete(key);
      void this.emitStatus();
    }
  }

  private flushDocument(key: string, session: LspSession, documentPath: string): void {
    if (session.state !== "ready") return;
    const document = this.documents.get(documentPath);
    if (!document) {
      this.pending.get(key)?.delete(documentPath);
      return;
    }
    let keys = this.associations.get(documentPath);
    if (!keys) {
      keys = new Set();
      this.associations.set(documentPath, keys);
    }
    if (!keys.has(key)) {
      keys.add(key);
      session.openDocument(document);
    }
    this.pending.get(key)?.delete(documentPath);
  }

  private detachDocument(documentPath: string, options: { clearDiagnostics: boolean }): void {
    const keys = this.associations.get(documentPath);
    const document = this.documents.get(documentPath);
    if (keys && document) {
      for (const key of keys) {
        const session = this.sessions.get(key);
        if (session?.state === "ready") session.closeDocument(document.uri, documentPath);
        if (options.clearDiagnostics) this.diagnostics.clearDocument(document.uri, key);
      }
    }
    this.associations.delete(documentPath);
    for (const pending of this.pending.values()) pending.delete(documentPath);
    if (document) this.documents.close(documentPath);
    if (options.clearDiagnostics) this.emitDiagnostics();
  }

  private forgetAssociations(key: string): void {
    for (const [documentPath, keys] of this.associations) {
      keys.delete(key);
      if (!keys.size) this.associations.delete(documentPath);
    }
    this.pending.delete(key);
  }

  private async featureContext(
    payload: unknown,
    requirements: { position?: boolean; range?: boolean },
  ): Promise<{ document: LspOpenDocument; routes: LspRoute[] }> {
    const input = asObject(payload);
    const target = await this.authorizeFile(input?.path, { allowMissing: true });
    const document = this.documents.get(target.path);
    if (!document)
      throw new LspManagerError("LSP_DOCUMENT_NOT_OPEN", "This document is not synchronized with a language server.");
    if (requirements.position && !isPosition(input?.position))
      throw new LspManagerError("LSP_INVALID_ARGUMENT", "A valid document position is required.");
    if (requirements.range && !isRange(input?.range))
      throw new LspManagerError("LSP_INVALID_ARGUMENT", "A valid document range is required.");
    const routes = this.routesFor(target.path);
    if (!routes.length)
      throw new LspManagerError("LSP_NO_PROVIDER", "No language server is ready for this document.");
    return { document, routes };
  }

  private routesFor(documentPath: string): LspRoute[] {
    const routes: LspRoute[] = [];
    for (const key of this.associations.get(documentPath) || []) {
      const session = this.sessions.get(key);
      if (!session || session.state !== "ready") continue;
      routes.push({ session, priority: session.definition.priority });
    }
    return routes.sort((left, right) =>
      right.priority - left.priority ||
      left.session.serverId.localeCompare(right.session.serverId));
  }

  private routeKeyFor(documentPath: string, serverId: string): string | null {
    for (const key of this.associations.get(documentPath) || []) {
      const session = this.sessions.get(key);
      if (session?.serverId === serverId) return key;
    }
    return null;
  }

  private routeByKey(key: string): LspRoute | null {
    const session = this.sessions.get(key);
    if (!session || session.state !== "ready") return null;
    return { session, priority: session.definition.priority };
  }

  private parseChanges(value: unknown): LspDocumentChange[] {
    if (!Array.isArray(value) || !value.length || value.length > MAX_CHANGES)
      throw new LspManagerError("LSP_INVALID_ARGUMENT", "Invalid document change list.");
    return value.map((entry) => {
      const change = asObject(entry);
      if (!change || typeof change.text !== "string" || change.text.length > (this.options.maxDocumentBytes ?? MAX_DOCUMENT_BYTES))
        throw new LspManagerError("LSP_INVALID_ARGUMENT", "Invalid document change.");
      if (change.range !== undefined && !validateRange(change.range))
        throw new LspManagerError("LSP_INVALID_ARGUMENT", "Invalid document change range.");
      return {
        ...(change.range === undefined ? {} : { range: change.range }),
        text: change.text,
        ...(Number.isSafeInteger(change.rangeLength)
          ? { rangeLength: Number(change.rangeLength) }
          : {}),
      };
    });
  }

  private parseDiagnosticContext(value: unknown): LspDiagnostic[] {
    if (!Array.isArray(value)) return [];
    const output: LspDiagnostic[] = [];
    for (const entry of value.slice(0, MAX_DIAGNOSTIC_CONTEXT)) {
      const item = asObject(entry);
      if (!item || !validateRange(item.range) || typeof item.message !== "string") continue;
      output.push({
        range: item.range,
        message: item.message.slice(0, 8_192),
        ...(Number.isSafeInteger(item.severity) ? { severity: item.severity } : {}),
        ...(typeof item.source === "string" ? { source: item.source.slice(0, 256) } : {}),
        ...(typeof item.code === "string" || typeof item.code === "number"
          ? { code: item.code }
          : {}),
      });
    }
    return output;
  }

  private async authorizeFile(
    value: unknown,
    options: { requireFile?: boolean; allowMissing?: boolean } = {},
  ): Promise<{ path: string; workspace: string }> {
    if (typeof value !== "string" || !value.trim() || value.includes("\0") || !path.isAbsolute(value))
      throw new LspManagerError("LSP_INVALID_PATH", "A valid absolute file path is required.");
    if (this.isNceStatePath(value))
      throw new LspManagerError("LSP_INVALID_PATH", "NCE workspace state cannot be edited.");
    const workspace = await this.getWorkspace();
    if (!workspace)
      throw new LspManagerError("LSP_SERVER_UNAVAILABLE", "Open a workspace before using language servers.");
    const canonical = await this.canonicalFile(value, options.allowMissing === true);
    if (!canonical)
      throw new LspManagerError("LSP_INVALID_PATH", "The file cannot be resolved.");
    if (!isInside(workspace, canonical))
      throw new LspManagerError("LSP_INVALID_PATH", "The file must remain inside the workspace.");
    if (this.options.pathAccess) {
      const authorized = await this.options.pathAccess.isAuthorized(canonical, {
        allowMissing: options.allowMissing === true,
        requireFile: options.requireFile === true,
      });
      if (!authorized)
        throw new LspManagerError("LSP_INVALID_PATH", "The file is not authorized for this window.");
    }
    return { path: canonical, workspace };
  }

  private async getWorkspace(): Promise<string | null> {
    const raw = this.options.getWorkspaceRoot();
    if (typeof raw !== "string" || !raw.trim() || raw.includes("\0")) return null;
    try {
      const resolved = await fs.realpath(raw);
      const stats = await fs.stat(resolved);
      return stats.isDirectory() ? resolved : null;
    } catch {
      return null;
    }
  }

  private async canonicalFile(value: string, allowMissing: boolean): Promise<string | null> {
    try {
      return await fs.realpath(value);
    } catch {
      if (!allowMissing) return null;
      try {
        const parent = await fs.realpath(path.dirname(value));
        return path.join(parent, path.basename(value));
      } catch {
        return null;
      }
    }
  }

  private isNceStatePath(value: string): boolean {
    const portable = (this.options.platform ?? process.platform) === "win32";
    return value.split(/[\\/]/).some((segment) =>
      portable ? segment.toLowerCase() === ".nce" : segment === ".nce");
  }

  private async sanitizeWorkspaceEdit(edit: LspWorkspaceEdit | null): Promise<LspWorkspaceEdit | null> {
    if (!edit || (!edit.files.length && !(edit.resources || []).length)) return null;
    const rawResources = edit.resources || [];
    if (edit.files.length > MAX_WORKSPACE_FILES || rawResources.length > MAX_WORKSPACE_FILES)
      throw new LspManagerError("LSP_REQUEST_FAILED", "The server returned too many files to edit.");
    const createdTargets = new Set<string>();
    for (const resource of rawResources) {
      if (resource.kind === "create" || resource.kind === "rename")
        createdTargets.add(path.resolve(resource.path));
    }
    const resources: import("./LspTypes").LspWorkspaceResourceOperation[] = [];
    for (const resource of rawResources) {
      const options = resource.options
        ? {
            ...(resource.options.overwrite === true ? { overwrite: true } : {}),
            ...(resource.options.ignoreIfExists === true ? { ignoreIfExists: true } : {}),
            ...(resource.options.recursive === true ? { recursive: true } : {}),
          }
        : undefined;
      if (resource.kind === "create") {
        const target = await this.authorizeFile(resource.path, { allowMissing: true });
        resources.push({
          kind: "create",
          path: target.path,
          uri: pathToUri(target.path),
          ...(options && Object.keys(options).length ? { options } : {}),
        });
        continue;
      }
      if (resource.kind === "rename") {
        const previous = await this.authorizeFile(resource.oldPath, { requireFile: true });
        const target = await this.authorizeFile(resource.path, { allowMissing: true });
        if (previous.path === target.path)
          throw new LspManagerError("LSP_REQUEST_FAILED", "The rename source and target are identical.");
        resources.push({
          kind: "rename",
          path: target.path,
          uri: pathToUri(target.path),
          oldPath: previous.path,
          oldUri: pathToUri(previous.path),
          ...(options && Object.keys(options).length ? { options } : {}),
        });
        continue;
      }
      const target = await this.authorizeFile(resource.path, { requireFile: true });
      resources.push({
        kind: "delete",
        path: target.path,
        uri: pathToUri(target.path),
        ...(options && Object.keys(options).length ? { options } : {}),
      });
    }
    const files: LspWorkspaceFileEdit[] = [];
    let editCount = 0;
    for (const file of edit.files) {
      const created = createdTargets.has(path.resolve(file.path));
      const target = await this.authorizeFile(file.path, {
        allowMissing: created,
        requireFile: !created,
      });
      const edits = Array.isArray(file.edits) ? file.edits : [];
      for (const change of edits) {
        if (!validateRange(change.range) || typeof change.newText !== "string")
          throw new LspManagerError("LSP_REQUEST_FAILED", "The server returned an invalid text edit.");
        editCount += 1;
        if (editCount > MAX_WORKSPACE_EDITS)
          throw new LspManagerError("LSP_REQUEST_FAILED", "The server returned too many text edits.");
      }
      const openDocument = this.documents.get(target.path);
      if (openDocument && Number.isSafeInteger(file.version) && file.version !== openDocument.version) {
        throw new LspManagerError(
          "LSP_REQUEST_FAILED",
          "The language server returned an edit for an outdated document version.",
        );
      }
      files.push({
        path: target.path,
        uri: pathToUri(target.path),
        version: openDocument ? openDocument.version : null,
        edits,
      });
    }
    return {
      source: edit.source,
      files,
      ...(resources.length ? { resources } : {}),
    };
  }

  private actionToken(id: unknown): CachedAction {
    if (typeof id !== "string")
      throw new LspManagerError("LSP_INVALID_ARGUMENT", "Unknown code action.");
    const token = this.actionTokens.get(id);
    if (!token || token.expiresAt < Date.now()) {
      this.actionTokens.delete(id);
      throw new LspManagerError("LSP_INVALID_ARGUMENT", "This code action expired.");
    }
    return token;
  }

  private pruneCompletionTokens(): void {
    const now = Date.now();
    for (const [id, token] of this.completionTokens) {
      if (token.expiresAt < now) this.completionTokens.delete(id);
    }
    while (this.completionTokens.size > 512) {
      const oldest = this.completionTokens.keys().next().value;
      if (oldest === undefined) break;
      this.completionTokens.delete(oldest);
    }
  }

  private pruneActionTokens(): void {
    const now = Date.now();
    for (const [id, token] of this.actionTokens) {
      if (token.expiresAt < now) this.actionTokens.delete(id);
    }
    while (this.actionTokens.size > 128) {
      const oldest = this.actionTokens.keys().next().value;
      if (oldest === undefined) break;
      this.actionTokens.delete(oldest);
    }
  }

  private async handleDiagnostics(
    serverKey: string,
    uri: string,
    version: number | null,
    diagnostics: LspDiagnostic[],
    owner: LspSession,
  ): Promise<void> {
    if (this.disposed) return;
    const uriPath = uriToPath(uri);
    if (!uriPath) return;
    let documentPath = path.normalize(uriPath);
    try {
      documentPath = await fs.realpath(documentPath);
    } catch {
      // Keep the normalized URI path so late diagnostics for deleted files can
      // still be dropped by the open-document lookup below.
    }
    const document = this.documents.get(documentPath);
    if (!document) return;
    // A server that has been stopped can still have a notification in flight.
    // Publishing it would put diagnostics back into the Problems panel for a
    // session that no longer exists, which is exactly the state teardown is
    // trying to clear. The check is repeated after the awaits above because a
    // teardown can land while this handler is resolving the document path.
    // Identity, not just presence: a replacement session can occupy the same
    // key while an old notification is still resolving its document path.
    if (this.sessions.get(serverKey) !== owner) return;
    if (version !== null && version > document.version) return;
    if (!this.diagnostics.publish(uri, serverKey, version, diagnostics)) return;
    this.emitDiagnostics();
  }

  private async decorateLocations<T extends { uri: string }>(
    locations: T[],
  ): Promise<Array<T & { path: string | null; authorized: boolean }>> {
    return Promise.all(locations.map(async (location) => {
      const resolved = uriToPath(location.uri);
      if (!resolved) return { ...location, path: null, authorized: false };
      let authorized = false;
      if (this.options.pathAccess) {
        try {
          authorized = await this.options.pathAccess.isAuthorized(resolved, { requireFile: true });
        } catch {
          authorized = false;
        }
      } else {
        const workspace = await this.getWorkspace();
        authorized = Boolean(workspace && isInside(workspace, resolved));
      }
      return { ...location, path: resolved, authorized };
    }));
  }

  private async applyServerWorkspaceEdit(
    rawEdit: unknown,
    serverId: string,
  ): Promise<{ applied: boolean; failureReason?: string }> {
    const edit = this.router.normalizeWorkspaceEdit(rawEdit, serverId);
    if (!edit) return { applied: false, failureReason: "The server did not provide any editable change." };
    let sanitized: LspWorkspaceEdit | null = null;
    try {
      sanitized = await this.sanitizeWorkspaceEdit(edit);
    } catch (error) {
      return {
        applied: false,
        failureReason: error instanceof Error ? error.message : String(error),
      };
    }
    if (!sanitized || !this.options.send)
      return { applied: false, failureReason: "No renderer is available to apply the edit." };
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApplyEdits.delete(id);
        resolve({ applied: false, failureReason: "The editor did not respond in time." });
      }, 10_000);
      this.pendingApplyEdits.set(id, { resolve, timer });
      this.options.send?.("Lsp:applyEditRequest", { id, edit: sanitized });
    });
  }

  private finishApplyEdit(payload: unknown): LspEmptyResult {
    const input = asObject(payload);
    const id = input?.id;
    if (typeof id !== "string")
      return failure("LSP_INVALID_ARGUMENT", "Unknown workspace edit request.");
    const pending = this.pendingApplyEdits.get(id);
    if (!pending) return failure("LSP_INVALID_ARGUMENT", "This workspace edit request expired.");
    this.pendingApplyEdits.delete(id);
    clearTimeout(pending.timer);
    const applied = input?.applied === true;
    pending.resolve({
      applied,
      ...(applied ? {} : {
        failureReason: typeof input?.failureReason === "string"
          ? input.failureReason.slice(0, 512)
          : "The editor rejected the workspace edit.",
      }),
    });
    return { success: true };
  }

  private rejectPendingApplyEdits(reason: string): void {
    for (const [id, pending] of this.pendingApplyEdits) {
      clearTimeout(pending.timer);
      pending.resolve({ applied: false, failureReason: reason });
      this.pendingApplyEdits.delete(id);
    }
  }

  private emitDiagnostics(): void {
    if (this.disposed || !this.options.send) return;
    const pathsByUri = new Map(this.documents.all().map((document) => [document.uri, document.path]));
    const documents = this.diagnostics.aggregate().map((entry) => ({
      ...entry,
      path: pathsByUri.get(entry.uri) || uriToPath(entry.uri),
    }));
    this.options.send("Lsp:diagnostics", { documents });
  }

  private emitReset(): void {
    this.options.send?.("Lsp:reset", {});
  }

  private async emitStatus(): Promise<void> {
    if (this.disposed || !this.options.send) return;
    const generation = this.generation;
    const sequence = ++this.statusSequence;
    const result = await this.getStatus();
    if (!result.success || sequence !== this.statusSequence || generation !== this.generation)
      return;
    this.options.send("Lsp:status", result);
  }
}
