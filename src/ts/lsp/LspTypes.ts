export type LspErrorCode =
  | "LSP_DISABLED"
  | "LSP_UNSUPPORTED_LANGUAGE"
  | "LSP_SERVER_NOT_FOUND"
  | "LSP_SERVER_START_FAILED"
  | "LSP_INITIALIZE_FAILED"
  | "LSP_SERVER_UNAVAILABLE"
  | "LSP_TIMEOUT"
  | "LSP_REQUEST_FAILED"
  | "LSP_INVALID_ARGUMENT"
  | "LSP_INVALID_PATH"
  | "LSP_DOCUMENT_NOT_OPEN"
  | "LSP_NO_PROVIDER";

export interface LspFailure {
  success: false;
  code: LspErrorCode;
  error: string;
}

export type LspResult<T> = ({ success: true } & T) | LspFailure;

export type LspEmptyResult = { success: true } | LspFailure;

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
  path?: string | null;
  authorized?: boolean;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: 1 | 2 | 3 | 4;
  code?: string | number;
  source?: string;
  message: string;
  tags?: number[];
  data?: unknown;
}

export interface LspDiagnosticWithSource extends LspDiagnostic {
  serverId: string;
  serverName: string;
}

export interface LspServerDefinitionView {
  id: string;
  name: string;
  languages: string[];
  extensions: string[];
  defaultEnabled: boolean;
  priority: number;
  enabled: boolean;
  executable: string | null;
  available: boolean;
  error: string | null;
  description: string;
}

export interface LspServerSessionView {
  serverId: string;
  serverName: string;
  root: string;
  state:
    | "starting"
    | "initializing"
    | "ready"
    | "stopping"
    | "stopped"
    | "failed";
  error: string | null;
  documents: number;
  capabilities: {
    completion: boolean;
    hover: boolean;
    definition: boolean;
    references: boolean;
    rename: boolean;
    codeAction: boolean;
    formatting: boolean;
    rangeFormatting: boolean;
    documentSymbols: boolean;
    workspaceSymbols: boolean;
    signatureHelp: boolean;
  };
}

export interface LspStatusSnapshot {
  enabled: boolean;
  workspace: string | null;
  servers: LspServerDefinitionView[];
  sessions: LspServerSessionView[];
}

export interface LspDocumentChange {
  range?: LspRange;
  text: string;
  rangeLength?: number;
}

export interface LspCompletionItem {
  id?: string;
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string;
  insertText?: string;
  filterText?: string;
  sortText?: string;
  textEdit?: LspTextEdit;
  additionalTextEdits?: LspTextEdit[];
  insertTextFormat?: number;
  data?: unknown;
  source: string;
}

export interface LspHoverResult {
  contents: string;
  range?: LspRange;
  source: string;
}

export interface LspReferenceGroup {
  uri: string;
  source: string;
  locations: LspLocation[];
}

export interface LspRenamePreparation {
  range: LspRange;
  placeholder: string;
  source: string;
}

export interface LspWorkspaceFileEdit {
  path: string;
  uri: string;
  version: number | null;
  edits: LspTextEdit[];
}

export interface LspWorkspaceEdit {
  files: LspWorkspaceFileEdit[];
  source: string;
}

export interface LspCodeAction {
  id?: string;
  title: string;
  kind?: string;
  source: string;
  isPreferred: boolean;
  data?: unknown;
  edit?: LspWorkspaceEdit;
  command?: { title: string; command: string; arguments?: unknown[] };
}

export interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  source: string;
  children: LspDocumentSymbol[];
}

export interface LspWorkspaceSymbol {
  name: string;
  kind: number;
  location: LspLocation;
  containerName?: string;
  source: string;
}

export interface LspSignatureHelp {
  signatures: Array<{
    label: string;
    documentation?: string;
    parameters: Array<{ label: string | [number, number]; documentation?: string }>;
  }>;
  activeSignature: number;
  activeParameter: number;
  source: string;
}

export interface LspServerRoute {
  serverId: string;
  serverName: string;
  priority: number;
}

export interface LspDocumentInfo {
  success: true;
  supported: boolean;
  languageId: string | null;
  path?: string;
  servers: LspServerRoute[];
}

export interface LspApplyConfiguration {
  serverId: string;
  enabled?: boolean;
  path?: string;
  args?: string[];
}

export interface LspServerConfiguration {
  enabled?: boolean;
  path?: string;
  args?: string[];
}

export interface LspSettingsValue {
  enabled: boolean;
  servers: Record<string, LspServerConfiguration>;
}

export interface LspRawPosition {
  line: unknown;
  character: unknown;
}

export interface LspRawRange {
  start: LspRawPosition;
  end: LspRawPosition;
}
