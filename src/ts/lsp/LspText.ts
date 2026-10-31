import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { LspPosition, LspRange, LspTextEdit } from "./LspTypes";

export interface LineSpan {
  /** Offset of the first UTF-16 code unit of the line. */
  start: number;
  /** Offset just past the last content code unit (CR of CRLF excluded). */
  end: number;
}

export function lineSpans(text: string): LineSpan[] {
  const spans: LineSpan[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") continue;
    const end = index > start && text[index - 1] === "\r" ? index - 1 : index;
    spans.push({ start, end });
    start = index + 1;
  }
  spans.push({ start, end: text.length });
  return spans;
}

export function pathToUri(absolutePath: string): string {
  return pathToFileURL(absolutePath).href;
}

export function uriToPath(uri: string): string | null {
  if (typeof uri !== "string" || !uri.startsWith("file:")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

export function isPosition(value: unknown): value is LspPosition {
  if (!value || typeof value !== "object") return false;
  const position = value as LspPosition;
  return (
    Number.isSafeInteger(position.line) &&
    position.line >= 0 &&
    Number.isSafeInteger(position.character) &&
    position.character >= 0
  );
}

export function isRange(value: unknown): value is LspRange {
  if (!value || typeof value !== "object") return false;
  const range = value as LspRange;
  return isPosition(range.start) && isPosition(range.end);
}

export function positionToOffset(
  text: string,
  position: LspPosition,
  spans = lineSpans(text),
): number {
  if (spans.length === 0) return 0;
  const line = Math.min(Math.max(position.line, 0), spans.length - 1);
  const span = spans[line];
  const character = Math.min(Math.max(position.character, 0), span.end - span.start);
  return span.start + character;
}

export function offsetToPosition(text: string, offset: number): LspPosition {
  const spans = lineSpans(text);
  const target = Math.min(Math.max(offset, 0), text.length);
  let low = 0;
  let high = spans.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if (spans[middle].start <= target) low = middle;
    else high = middle - 1;
  }
  return { line: low, character: target - spans[low].start };
}

export function rangeToOffsets(
  text: string,
  range: LspRange,
  spans = lineSpans(text),
): { start: number; end: number } {
  const start = positionToOffset(text, range.start, spans);
  const end = Math.max(start, positionToOffset(text, range.end, spans));
  return { start, end };
}

export function validateRange(value: unknown): value is LspRange {
  return isRange(value);
}

export function applyTextChange(
  text: string,
  range: LspRange | null,
  newText: string,
): string {
  if (!range) return newText;
  const spans = lineSpans(text);
  const { start, end } = rangeToOffsets(text, range, spans);
  return text.slice(0, start) + newText + text.slice(end);
}

export function applyTextEdits(text: string, edits: LspTextEdit[]): string {
  if (!edits.length) return text;
  const spans = lineSpans(text);
  const resolved = edits.map((edit, index) => {
    const offsets = rangeToOffsets(text, edit.range, spans);
    return { ...offsets, newText: edit.newText, index };
  });
  resolved.sort((left, right) =>
    right.start - left.start || right.end - left.end || right.index - left.index);
  let output = text;
  let previousStart = text.length + 1;
  for (const edit of resolved) {
    if (edit.end > previousStart)
      throw new Error("Overlapping text edits were rejected.");
    output = output.slice(0, edit.start) + edit.newText + output.slice(edit.end);
    previousStart = edit.start;
  }
  return output;
}

/** Resolve a workspace path from an LSP URI, rejecting non-file URIs. */
export function workspaceUriToPath(uri: unknown): string | null {
  if (typeof uri !== "string") return null;
  const resolved = uriToPath(uri);
  if (!resolved) return null;
  return path.normalize(resolved);
}
