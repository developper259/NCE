import type {
  WorkspaceRegexMatch,
} from "./WorkspaceRegexExecutor";
import { onParentMessage, sendToParent } from "./WorkerParentPort";

interface RegexRequest {
  operation: "find" | "replace";
  source: string;
  flags: string;
  text: string;
  multiline?: boolean;
  maxMatches?: number;
  replacement?: string;
}

interface RegexWorkerMessage {
  type: "execute";
  id: number;
  request: RegexRequest;
}

function advanceRegexIndexSafely(
  value: string,
  utf16Offset: number,
  unicode: boolean,
): number {
  if (utf16Offset >= value.length) return value.length + 1;
  if (!unicode) return utf16Offset + 1;
  const codePoint = value.codePointAt(utf16Offset);
  return utf16Offset + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1);
}

function collectMatches(
  regex: RegExp,
  text: string,
  maxMatches: number,
  line?: number,
  lineOffset = 0,
): WorkspaceRegexMatch[] {
  const matches: WorkspaceRegexMatch[] = [];
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while (matches.length < maxMatches && (match = regex.exec(text)) !== null) {
    matches.push({
      index: lineOffset + match.index,
      length: match[0].length,
      ...(line === undefined ? {} : { line, column: match.index }),
    });
    if (!regex.global) break;
    if (match[0].length === 0)
      regex.lastIndex = advanceRegexIndexSafely(text, match.index, regex.unicode);
  }
  regex.lastIndex = 0;
  return matches;
}

function findMatches(request: RegexRequest): WorkspaceRegexMatch[] {
  const limit = Math.max(1, Math.min(50000, Math.floor(request.maxMatches || 50000)));
  const regex = new RegExp(request.source, request.flags);
  if (request.multiline)
    return collectMatches(regex, request.text, limit);

  const matches: WorkspaceRegexMatch[] = [];
  const lines = request.text.split(/\r?\n/);
  let lineOffset = 0;
  for (let lineIndex = 0; lineIndex < lines.length && matches.length < limit; lineIndex++) {
    const line = lines[lineIndex];
    matches.push(...collectMatches(
      regex,
      line,
      limit - matches.length,
      lineIndex + 1,
      lineOffset,
    ));
    lineOffset += line.length;
    if (request.text.startsWith("\r\n", lineOffset)) lineOffset += 2;
    else if (request.text[lineOffset] === "\n") lineOffset += 1;
  }
  return matches;
}

function countMatches(regex: RegExp, text: string): number {
  regex.lastIndex = 0;
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    count++;
    if (!regex.global) break;
    if (match[0].length === 0)
      regex.lastIndex = advanceRegexIndexSafely(text, match.index, regex.unicode);
  }
  regex.lastIndex = 0;
  return count;
}

onParentMessage((message: RegexWorkerMessage) => {
  if (message?.type !== "execute" || !Number.isSafeInteger(message.id)) return;
  try {
    const { request } = message;
    if (
      !request ||
      typeof request.source !== "string" ||
      typeof request.flags !== "string" ||
      typeof request.text !== "string"
    ) throw new Error("Invalid regex work request.");

    if (request.operation === "find") {
      sendToParent({
        id: message.id,
        success: true,
        matches: findMatches(request),
      });
      return;
    }

    if (request.operation === "replace" && typeof request.replacement === "string") {
      const regex = new RegExp(request.source, request.flags);
      const replacements = countMatches(regex, request.text);
      const content = request.text.replace(regex, request.replacement);
      sendToParent({
        id: message.id,
        success: true,
        content,
        replacements,
      });
      return;
    }

    throw new Error("Unsupported regex work operation.");
  } catch (error) {
    sendToParent({
      id: message.id,
      success: false,
      error: {
        code: error instanceof SyntaxError ? "INVALID_REGEX" : undefined,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

process.on("disconnect", () => process.exit(0));
sendToParent({ type: "ready" });
