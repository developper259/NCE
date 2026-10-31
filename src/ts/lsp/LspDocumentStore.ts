import { applyTextChange } from "./LspText";
import type { LspDocumentChange } from "./LspTypes";

export interface LspOpenDocument {
  path: string;
  uri: string;
  languageId: string;
  version: number;
  text: string;
  openedAt: number;
}

/** Keeps the exact editor buffer that language servers have been told about. */
export class LspDocumentStore {
  private readonly documents = new Map<string, LspOpenDocument>();

  open(
    path: string,
    uri: string,
    languageId: string,
    text: string,
  ): LspOpenDocument {
    const existing = this.documents.get(path);
    const document: LspOpenDocument = {
      path,
      uri,
      languageId,
      version: existing ? existing.version + 1 : 1,
      text,
      openedAt: existing?.openedAt ?? Date.now(),
    };
    this.documents.set(path, document);
    return document;
  }

  change(
    path: string,
    changes: LspDocumentChange[],
    maxBytes?: number,
  ): { document: LspOpenDocument; applied: LspDocumentChange[] } | null {
    const document = this.documents.get(path);
    if (!document) return null;
    let text = document.text;
    for (const change of changes) {
      if (typeof change?.text !== "string")
        throw new Error("Invalid document change payload.");
      text = applyTextChange(text, change.range || null, change.text);
    }
    if (maxBytes !== undefined && Buffer.byteLength(text, "utf8") > maxBytes)
      throw new Error("This file is too large to synchronize with a language server.");
    document.text = text;
    document.version += 1;
    return { document, applied: changes };
  }

  save(path: string, text?: string): LspOpenDocument | null {
    const document = this.documents.get(path);
    if (!document) return null;
    if (typeof text === "string") document.text = text;
    return document;
  }

  close(path: string): LspOpenDocument | null {
    const document = this.documents.get(path) || null;
    this.documents.delete(path);
    return document;
  }

  get(path: string): LspOpenDocument | null {
    return this.documents.get(path) || null;
  }

  all(): LspOpenDocument[] {
    return [...this.documents.values()];
  }

  clear(): void {
    this.documents.clear();
  }

  get size(): number {
    return this.documents.size;
  }
}
