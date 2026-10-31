import type { LspDiagnostic, LspDiagnosticWithSource } from "./LspTypes";

interface DiagnosticsEntry {
  version: number | null;
  diagnostics: LspDiagnostic[];
}

export interface AggregatedDiagnostics {
  uri: string;
  diagnostics: LspDiagnosticWithSource[];
}

export class LspDiagnosticsStore {
  private readonly byUri = new Map<string, Map<string, DiagnosticsEntry>>();
  private readonly serverNames = new Map<string, string>();

  setServerName(serverId: string, name: string): void {
    this.serverNames.set(serverId, name);
  }

  publish(
    uri: string,
    serverId: string,
    version: number | null,
    diagnostics: LspDiagnostic[],
  ): boolean {
    const entries = this.byUri.get(uri) || new Map<string, DiagnosticsEntry>();
    const previous = entries.get(serverId);
    if (
      previous &&
      previous.version !== null &&
      version !== null &&
      version < previous.version
    ) return false;
    if (!diagnostics.length) entries.delete(serverId);
    else entries.set(serverId, { version, diagnostics });
    if (entries.size) this.byUri.set(uri, entries);
    else this.byUri.delete(uri);
    return true;
  }

  clearAll(): void {
    this.byUri.clear();
  }

  clearServer(serverId: string): boolean {
    let changed = false;
    for (const [uri, entries] of this.byUri) {
      if (entries.delete(serverId)) changed = true;
      if (!entries.size) this.byUri.delete(uri);
    }
    return changed;
  }

  clearDocument(uri: string, serverId?: string): boolean {
    if (serverId) {
      const entries = this.byUri.get(uri);
      if (!entries?.delete(serverId)) return false;
      if (!entries.size) this.byUri.delete(uri);
      return true;
    }
    return this.byUri.delete(uri);
  }

  aggregate(): AggregatedDiagnostics[] {
    const output: AggregatedDiagnostics[] = [];
    for (const [uri, entries] of this.byUri) {
      const diagnostics: LspDiagnosticWithSource[] = [];
      for (const [serverId, entry] of entries) {
        const serverName = this.serverNames.get(serverId) || serverId;
        for (const diagnostic of entry.diagnostics) {
          diagnostics.push({ ...diagnostic, serverId, serverName });
        }
      }
      if (diagnostics.length) output.push({ uri, diagnostics });
    }
    return output;
  }
}
