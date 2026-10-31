import { uriToPath, validateRange } from "./LspText";
import type { LspSession } from "./LspSession";
import type {
  LspCodeAction,
  LspCompletionItem,
  LspDocumentSymbol,
  LspHoverResult,
  LspLocation,
  LspRenamePreparation,
  LspSignatureHelp,
  LspTextEdit,
  LspWorkspaceEdit,
  LspWorkspaceFileEdit,
  LspWorkspaceSymbol,
} from "./LspTypes";

export interface LspRoute {
  session: LspSession;
  priority: number;
}

const MAX_COMPLETION_ITEMS = 200;
const MAX_LOCATIONS = 200;
const MAX_SYMBOLS = 500;
const MAX_CODE_ACTIONS = 100;

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function documentationText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const object = asObject(value);
  if (object && typeof object.value === "string") return object.value;
  return undefined;
}

function normalizeTextEdit(value: unknown): LspTextEdit | null {
  const object = asObject(value);
  if (!object) return null;
  if (validateRange(object.range) && typeof object.newText === "string")
    return { range: object.range, newText: object.newText };
  if (validateRange(object.replace) && typeof object.newText === "string")
    return { range: object.replace, newText: object.newText };
  if (validateRange(object.insert) && typeof object.newText === "string")
    return { range: object.insert, newText: object.newText };
  return null;
}

function normalizeTextEdits(value: unknown): LspTextEdit[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeTextEdit(entry))
    .filter((entry): entry is LspTextEdit => Boolean(entry));
}

function workspaceEditFrom(value: unknown, source: string): LspWorkspaceEdit | null {
  const object = asObject(value);
  if (!object) return null;
  const files = new Map<string, LspWorkspaceFileEdit>();
  const add = (uriValue: unknown, editsValue: unknown, versionValue?: unknown) => {
    const edits = normalizeTextEdits(editsValue);
    if (!edits.length) return;
    if (typeof uriValue !== "string") {
      const error: any = new Error("The language server returned an edit without a document URI.");
      error.code = "LSP_INVALID_PATH";
      throw error;
    }
    const filePath = uriToPath(uriValue);
    if (!filePath) {
      const error: any = new Error("The language server returned an edit for an unsupported document URI.");
      error.code = "LSP_INVALID_PATH";
      throw error;
    }
    const existing = files.get(filePath);
    const version = Number.isSafeInteger(versionValue) ? Number(versionValue) : null;
    if (existing) {
      existing.edits.push(...edits);
      if (existing.version === null && version !== null) existing.version = version;
      return;
    }
    files.set(filePath, { path: filePath, uri: uriValue, version, edits });
  };

  const changes = asObject(object.changes);
  if (changes) {
    for (const [uri, edits] of Object.entries(changes)) add(uri, edits);
  }
  if (Array.isArray(object.documentChanges)) {
    for (const entry of object.documentChanges) {
      const change = asObject(entry);
      if (!change) continue;
      if (change.kind === "create" || change.kind === "rename" || change.kind === "delete")
        throw new Error("Resource operations in workspace edits are not supported.");
      const textDocument = asObject(change.textDocument);
      add(textDocument?.uri, change.edits, textDocument?.version);
    }
  }
  if (!files.size) return null;
  return { files: [...files.values()], source };
}

function capabilitiesFor(route: LspRoute, feature: keyof LspSession["capabilities"]): boolean {
  return Boolean(route.session.capabilities[feature]);
}

function sortedRoutes(routes: LspRoute[]): LspRoute[] {
  return [...routes].sort((left, right) =>
    right.priority - left.priority ||
    left.session.serverId.localeCompare(right.session.serverId));
}

function normalizeLocation(value: unknown): LspLocation | null {
  const object = asObject(value);
  if (!object) return null;
  const uri = typeof object.uri === "string"
    ? object.uri
    : typeof object.targetUri === "string"
      ? object.targetUri
      : null;
  const range = validateRange(object.range)
    ? object.range
    : validateRange(object.targetSelectionRange)
      ? object.targetSelectionRange
      : validateRange(object.targetRange)
        ? object.targetRange
        : null;
  if (!uri || !range || !uriToPath(uri)) return null;
  return { uri, range };
}

function locationResults(value: unknown): LspLocation[] {
  if (Array.isArray(value))
    return value
      .map((entry) => normalizeLocation(entry))
      .filter((entry): entry is LspLocation => Boolean(entry));
  const single = normalizeLocation(value);
  return single ? [single] : [];
}

function normalizeDocumentSymbol(value: unknown, source: string): LspDocumentSymbol | null {
  const object = asObject(value);
  if (!object || typeof object.name !== "string" || !Number.isSafeInteger(object.kind))
    return null;
  const location = asObject(object.location);
  const range = validateRange(object.range)
    ? object.range
    : location && validateRange(location.range)
      ? location.range
      : null;
  if (!range) return null;
  const selectionRange = validateRange(object.selectionRange) ? object.selectionRange : range;
  const children = Array.isArray(object.children)
    ? object.children
        .map((child: unknown) => normalizeDocumentSymbol(child, source))
        .filter((child: LspDocumentSymbol | null): child is LspDocumentSymbol => Boolean(child))
    : [];
  const symbol: LspDocumentSymbol = {
    name: object.name.slice(0, 512),
    kind: Number(object.kind),
    range,
    selectionRange,
    source,
    children,
  };
  if (typeof object.detail === "string") symbol.detail = object.detail.slice(0, 512);
  return symbol;
}

function flattenDocumentSymbols(
  symbols: LspDocumentSymbol[],
  output: LspDocumentSymbol[] = [],
): LspDocumentSymbol[] {
  for (const symbol of symbols) {
    output.push(symbol);
    flattenDocumentSymbols(symbol.children, output);
  }
  return output;
}

function normalizeCompletionItem(value: unknown, source: string): LspCompletionItem | null {
  const object = asObject(value);
  if (!object || typeof object.label !== "string" || !object.label) return null;
  const item: LspCompletionItem = { label: object.label.slice(0, 1_024), source };
  if (Number.isSafeInteger(object.kind)) item.kind = Number(object.kind);
  if (typeof object.detail === "string") item.detail = object.detail.slice(0, 2_048);
  const documentation = documentationText(object.documentation);
  if (documentation) item.documentation = documentation.slice(0, 8_192);
  if (typeof object.insertText === "string") item.insertText = object.insertText;
  if (typeof object.filterText === "string") item.filterText = object.filterText;
  if (typeof object.sortText === "string") item.sortText = object.sortText;
  if (Number.isSafeInteger(object.insertTextFormat)) item.insertTextFormat = Number(object.insertTextFormat);
  if (object.data !== undefined) item.data = object.data;
  const textEdit = normalizeTextEdit(object.textEdit);
  if (textEdit) item.textEdit = textEdit;
  const additional = normalizeTextEdits(object.additionalTextEdits);
  if (additional.length) item.additionalTextEdits = additional.slice(0, 20);
  return item;
}

function hoverContents(value: unknown): string {
  if (typeof value === "string") return value;
  const object = asObject(value);
  if (object) return documentationText(object) || "";
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        const nested = asObject(entry);
        return nested ? documentationText(nested) || "" : "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

export class LspFeatureRouter {
  normalizeWorkspaceEdit(value: unknown, source: string): LspWorkspaceEdit | null {
    return workspaceEditFrom(value, source);
  }

  async completion(
    routes: LspRoute[],
    params: unknown,
    signal?: AbortSignal,
  ): Promise<{ items: LspCompletionItem[]; incomplete: boolean }> {
    const capable = sortedRoutes(routes.filter((route) =>
      capabilitiesFor(route, "completion")));
    const results = await Promise.allSettled(capable.map((route) =>
      route.session.request<any>("textDocument/completion", params, { signal })));
    const items: LspCompletionItem[] = [];
    const seen = new Set<string>();
    let incomplete = false;
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status !== "fulfilled") continue;
      const payload = result.value;
      const source = capable[index].session.serverId;
      if (payload?.isIncomplete === true) incomplete = true;
      const entries = Array.isArray(payload) ? payload : payload?.items;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const item = normalizeCompletionItem(entry, source);
        if (!item) continue;
        const key = `${item.label}\u0000${item.kind ?? ""}\u0000${item.detail ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(item);
        if (items.length >= MAX_COMPLETION_ITEMS) return { items, incomplete };
      }
    }
    return { items, incomplete };
  }

  async resolveCompletion(route: LspRoute, item: LspCompletionItem): Promise<LspCompletionItem> {
    if (!route.session.capabilities.completionResolve) return item;
    const result = await route.session.request<any>("completionItem/resolve", {
      label: item.label,
      kind: item.kind,
      detail: item.detail,
      documentation: item.documentation
        ? { kind: "markdown", value: item.documentation }
        : undefined,
      insertText: item.insertText,
      filterText: item.filterText,
      sortText: item.sortText,
      data: item.data,
    });
    const normalized = normalizeCompletionItem(result, route.session.serverId);
    return normalized ? { ...normalized, id: item.id } : item;
  }

  async hover(routes: LspRoute[], params: unknown, signal?: AbortSignal): Promise<LspHoverResult | null> {
    for (const route of sortedRoutes(routes.filter((entry) =>
      capabilitiesFor(entry, "hover")))) {
      try {
        const result = await route.session.request<any>("textDocument/hover", params, { signal });
        const contents = hoverContents(result?.contents);
        if (!contents) continue;
        return {
          contents,
          range: validateRange(result?.range) ? result.range : undefined,
          source: route.session.serverId,
        };
      } catch {
        continue;
      }
    }
    return null;
  }

  async locations(
    routes: LspRoute[],
    params: unknown,
    capability: "definition" | "declaration" | "implementation" | "typeDefinition",
    signal?: AbortSignal,
  ): Promise<LspLocation[]> {
    const capable = sortedRoutes(routes.filter((route) =>
      capabilitiesFor(route, capability)));
    const results = await Promise.allSettled(capable.map((route) =>
      route.session.request<any>(`textDocument/${capability}`, params, { signal })));
    const locations: LspLocation[] = [];
    const seen = new Set<string>();
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      for (const location of locationResults(result.value)) {
        const key = `${location.uri}\u0000${JSON.stringify(location.range)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        locations.push(location);
        if (locations.length >= MAX_LOCATIONS) return locations;
      }
    }
    return locations;
  }

  async references(
    routes: LspRoute[],
    params: unknown,
    signal?: AbortSignal,
  ): Promise<Array<{ source: string; locations: LspLocation[] }>> {
    const capable = sortedRoutes(routes.filter((route) =>
      capabilitiesFor(route, "references")));
    const results = await Promise.allSettled(capable.map((route) =>
      route.session.request<any>("textDocument/references", params, { signal })));
    const groups: Array<{ source: string; locations: LspLocation[] }> = [];
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status !== "fulfilled" || !Array.isArray(result.value)) continue;
      const locations = result.value
        .map((entry: unknown) => normalizeLocation(entry))
        .filter((entry: LspLocation | null): entry is LspLocation => Boolean(entry))
        .slice(0, MAX_LOCATIONS);
      if (locations.length)
        groups.push({ source: capable[index].session.serverId, locations });
    }
    return groups;
  }

  async prepareRename(
    routes: LspRoute[],
    params: unknown,
    signal?: AbortSignal,
  ): Promise<LspRenamePreparation | null> {
    const route = sortedRoutes(routes.filter((entry) =>
      capabilitiesFor(entry, "rename")))
      .find((entry) => entry.session.capabilities.prepareRename) ||
      sortedRoutes(routes.filter((entry) => capabilitiesFor(entry, "rename")))[0];
    if (!route) return null;
    try {
      const result = await route.session.request<any>("textDocument/prepareRename", params, { signal });
      if (!result) return null;
      if (validateRange(result))
        return { range: result, placeholder: "", source: route.session.serverId };
      if (validateRange(result.range))
        return {
          range: result.range,
          placeholder: typeof result.placeholder === "string" ? result.placeholder : "",
          source: route.session.serverId,
        };
      return null;
    } catch {
      return null;
    }
  }

  async rename(
    routes: LspRoute[],
    params: unknown,
    signal?: AbortSignal,
  ): Promise<LspWorkspaceEdit | null> {
    const route = sortedRoutes(routes.filter((entry) =>
      capabilitiesFor(entry, "rename")))[0];
    if (!route) return null;
    const result = await route.session.request<any>("textDocument/rename", params, { signal });
    return workspaceEditFrom(result, route.session.serverId);
  }

  async codeActions(
    routes: LspRoute[],
    params: unknown,
    signal?: AbortSignal,
  ): Promise<LspCodeAction[]> {
    const capable = sortedRoutes(routes.filter((route) =>
      capabilitiesFor(route, "codeAction")));
    const results = await Promise.allSettled(capable.map((route) =>
      route.session.request<any>("textDocument/codeAction", params, { signal })));
    const actions: LspCodeAction[] = [];
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status !== "fulfilled" || !Array.isArray(result.value)) continue;
      const source = capable[index].session.serverId;
      for (const entry of result.value) {
        const object = asObject(entry);
        if (!object || typeof object.title !== "string") continue;
        const action: LspCodeAction = {
          title: object.title.slice(0, 512),
          source,
          isPreferred: object.isPreferred === true,
        };
        if (typeof object.kind === "string") action.kind = object.kind;
        if (object.data !== undefined) action.data = object.data;
        const edit = workspaceEditFrom(object.edit, source);
        if (edit) action.edit = edit;
        const command = asObject(object.command);
        if (command && typeof command.command === "string") {
          action.command = {
            title: typeof command.title === "string" ? command.title : object.title,
            command: command.command,
            arguments: Array.isArray(command.arguments) ? command.arguments : undefined,
          };
        }
        actions.push(action);
        if (actions.length >= MAX_CODE_ACTIONS) return actions;
      }
    }
    return actions;
  }

  async resolveCodeAction(
    route: LspRoute,
    action: LspCodeAction,
  ): Promise<LspCodeAction> {
    if (!route.session.capabilities.codeActionResolve) return action;
    const result = await route.session.request<any>("codeAction/resolve", {
      title: action.title,
      kind: action.kind,
      data: action.data,
      isPreferred: action.isPreferred,
    });
    const object = asObject(result);
    if (!object) return action;
    const resolved: LspCodeAction = { ...action };
    const edit = workspaceEditFrom(object.edit, route.session.serverId);
    if (edit) resolved.edit = edit;
    const command = asObject(object.command);
    if (command && typeof command.command === "string") {
      resolved.command = {
        title: typeof command.title === "string" ? command.title : action.title,
        command: command.command,
        arguments: Array.isArray(command.arguments) ? command.arguments : undefined,
      };
    }
    return resolved;
  }

  async formatting(
    routes: LspRoute[],
    params: { textDocument: unknown; options: unknown },
    range: unknown | null,
    signal?: AbortSignal,
  ): Promise<{ edits: LspTextEdit[]; source: string } | null> {
    const method = range ? "rangeFormatting" : "formatting";
    const route = sortedRoutes(routes.filter((entry) =>
      capabilitiesFor(entry, method)))[0];
    if (!route) return null;
    const requestParams = range
      ? { ...params, range, options: params.options }
      : params;
    const result = await route.session.request<any>(
      range ? "textDocument/rangeFormatting" : "textDocument/formatting",
      requestParams,
      { signal },
    );
    return {
      edits: normalizeTextEdits(result),
      source: route.session.serverId,
    };
  }

  async documentSymbols(
    routes: LspRoute[],
    params: unknown,
    signal?: AbortSignal,
  ): Promise<LspDocumentSymbol[]> {
    const capable = sortedRoutes(routes.filter((route) =>
      capabilitiesFor(route, "documentSymbols")));
    const results = await Promise.allSettled(capable.map((route) =>
      route.session.request<any>("textDocument/documentSymbol", params, { signal })));
    const symbols: LspDocumentSymbol[] = [];
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status !== "fulfilled" || !Array.isArray(result.value)) continue;
      const source = capable[index].session.serverId;
      const normalized = result.value
        .map((entry) => normalizeDocumentSymbol(entry, source))
        .filter((entry): entry is LspDocumentSymbol => Boolean(entry));
      flattenDocumentSymbols(normalized, symbols);
      if (symbols.length >= MAX_SYMBOLS) return symbols.slice(0, MAX_SYMBOLS);
    }
    return symbols;
  }

  async workspaceSymbols(
    routes: LspRoute[],
    query: string,
    signal?: AbortSignal,
  ): Promise<LspWorkspaceSymbol[]> {
    const capable = sortedRoutes(routes.filter((route) =>
      capabilitiesFor(route, "workspaceSymbols")));
    const results = await Promise.allSettled(capable.map((route) =>
      route.session.request<any>("workspace/symbol", { query }, { signal })));
    const symbols: LspWorkspaceSymbol[] = [];
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status !== "fulfilled" || !Array.isArray(result.value)) continue;
      const source = capable[index].session.serverId;
      for (const entry of result.value) {
        const object = asObject(entry);
        if (!object || typeof object.name !== "string" || !Number.isSafeInteger(object.kind))
          continue;
        const location = normalizeLocation(object.location);
        if (!location) continue;
        const symbol: LspWorkspaceSymbol = {
          name: object.name.slice(0, 512),
          kind: Number(object.kind),
          location,
          source,
        };
        if (typeof object.containerName === "string")
          symbol.containerName = object.containerName.slice(0, 256);
        symbols.push(symbol);
        if (symbols.length >= MAX_SYMBOLS) return symbols;
      }
    }
    return symbols;
  }

  async signatureHelp(
    routes: LspRoute[],
    params: unknown,
    signal?: AbortSignal,
  ): Promise<LspSignatureHelp | null> {
    for (const route of sortedRoutes(routes.filter((entry) =>
      capabilitiesFor(entry, "signatureHelp")))) {
      try {
        const result = await route.session.request<any>("textDocument/signatureHelp", params, { signal });
        if (!Array.isArray(result?.signatures) || !result.signatures.length) continue;
        const signatures = result.signatures.map((signature: any) => ({
          label: String(signature?.label || "").slice(0, 4_096),
          documentation: documentationText(signature?.documentation)?.slice(0, 8_192),
          parameters: Array.isArray(signature?.parameters)
            ? signature.parameters.map((parameter: any) => ({
                label: parameter?.label,
                documentation: documentationText(parameter?.documentation)?.slice(0, 4_096),
              }))
            : [],
        }));
        return {
          signatures,
          activeSignature: Number.isSafeInteger(result.activeSignature) ? result.activeSignature : 0,
          activeParameter: Number.isSafeInteger(result.activeParameter) ? result.activeParameter : 0,
          source: route.session.serverId,
        };
      } catch {
        continue;
      }
    }
    return null;
  }
}
