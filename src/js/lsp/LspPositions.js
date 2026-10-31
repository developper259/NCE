const LspPositions = {
  documentText(file) {
    if (!file || !Array.isArray(file.lines)) return "";
    const text = file.lines.map((line) => line.getText()).join("\n");
    return file.hasFinalNewline ? `${text}\n` : text;
  },

  position(row, column) {
    return {
      line: Math.max(0, row - 1),
      character: Math.max(0, column),
    };
  },

  range(start, end) {
    return { start: LspPositions.position(start.row, start.column), end: LspPositions.position(end.row, end.column) };
  },

  isValidRange(range) {
    return Boolean(
      range &&
      Number.isSafeInteger(range.start?.line) &&
      range.start.line >= 0 &&
      Number.isSafeInteger(range.start?.character) &&
      range.start.character >= 0 &&
      Number.isSafeInteger(range.end?.line) &&
      range.end.line >= 0 &&
      Number.isSafeInteger(range.end?.character) &&
      range.end.character >= 0,
    );
  },

  editorRange(range, lineCount) {
    if (!LspPositions.isValidRange(range)) return null;
    const startRow = Math.min(Math.max(range.start.line + 1, 1), lineCount);
    const endRow = Math.min(Math.max(range.end.line + 1, startRow), lineCount);
    return {
      start: { row: startRow, column: range.start.character },
      end: { row: endRow, column: range.end.character },
    };
  },

  isWordCharacter(character) {
    if (!character) return false;
    try {
      return /[\p{L}\p{N}_$]/u.test(character);
    } catch {
      return /[A-Za-z0-9_$]/.test(character);
    }
  },

  wordRangeAt(text, column) {
    const value = String(text || "");
    const target = Math.min(Math.max(column, 0), value.length);
    let start = target;
    let end = target;
    while (start > 0 && LspPositions.isWordCharacter(value[start - 1])) start -= 1;
    while (end < value.length && LspPositions.isWordCharacter(value[end])) end += 1;
    if (start === end) {
      if (end < value.length) end += 1;
      else if (start > 0) start -= 1;
    }
    return { start, end, text: value.slice(start, end) };
  },

  changeForEdit(file, payload) {
    if (
      !payload ||
      payload.batch === true ||
      !Number.isSafeInteger(payload.beforeRow) ||
      !Number.isSafeInteger(payload.beforeColumn) ||
      typeof payload.beforeText !== "string" ||
      typeof payload.afterText !== "string"
    ) {
      return [{ text: LspPositions.documentText(file) }];
    }
    const beforeLines = payload.beforeText.split("\n");
    const start = { line: payload.beforeRow - 1, character: payload.beforeColumn };
    const end = beforeLines.length === 1
      ? { line: start.line, character: start.character + beforeLines[0].length }
      : { line: start.line + beforeLines.length - 1, character: beforeLines[beforeLines.length - 1].length };
    return [{ range: { start, end }, text: payload.afterText }];
  },

  severityClass(severity) {
    if (severity === 1) return "error";
    if (severity === 2) return "warning";
    if (severity === 3) return "info";
    return "hint";
  },

  severityLabel(severity) {
    if (severity === 1) return "Error";
    if (severity === 2) return "Warning";
    if (severity === 3) return "Information";
    return "Hint";
  },

  uriToPath(uri) {
    if (typeof uri !== "string" || !uri.startsWith("file://")) return null;
    try {
      const parsed = new URL(uri);
      let pathname = decodeURIComponent(parsed.pathname);
      if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
      return pathname;
    } catch {
      return null;
    }
  },
};
