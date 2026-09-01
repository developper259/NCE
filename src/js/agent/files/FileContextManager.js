class FileContextManager {
  constructor(agent) {
    this.agent = agent;
  }

  getContentRevision(value) {
    const text = typeof value === "string" ? value : "";
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  createFileReadContext(absolutePath, content, startLine, endLine, source) {
    const lines = String(content).split(/\r?\n/);
    const safeStartLine = Math.max(1, startLine || 1);
    const safeEndLine = Math.min(
      lines.length,
      Math.max(safeStartLine, endLine || safeStartLine),
    );
    const rangeContent = lines.slice(safeStartLine - 1, safeEndLine).join("\n");
    const visibleContent = this.agent.truncate(rangeContent, 4000);
    const context = {
      path: absolutePath,
      startLine: safeStartLine,
      endLine: safeEndLine,
      content: visibleContent,
      revision: this.agent.getContentRevision(content),
      timestamp: Date.now(),
      version: ++this.agent.fileContextVersion,
      source,
      truncated: visibleContent !== rangeContent,
    };
    this.agent.readFileContexts.set(absolutePath, context);
    return context;
  }

  validateFileReadContext(absolutePath, currentText, oldText) {
    const context = this.agent.readFileContexts.get(absolutePath);
    if (!context) {
      return {
        valid: false,
        error: {
          code: "FILE_CONTEXT_REQUIRED",
          message: "Read the current file before modifying it.",
        },
      };
    }
    const currentRevision = this.agent.getContentRevision(currentText);
    if (context.revision !== currentRevision) {
      this.agent.readFileContexts.delete(absolutePath);
      return {
        valid: false,
        error: {
          code: "STALE_CONTEXT",
          message: "The file changed since it was read. Read it again.",
          expectedRevision: context.revision,
          actualRevision: currentRevision,
        },
      };
    }
    if (oldText.includes("[... contenu tronqué par NCE ...]")) {
      return {
        valid: false,
        error: {
          code: "INVALID_OLD_TEXT",
          message: "oldText cannot contain NCE's truncation marker.",
        },
      };
    }
    const oldTextWasRead =
      oldText.length > 0
        ? context.content.includes(oldText.replace(/\r\n?/g, "\n"))
        : context.startLine === 1;
    if (!oldTextWasRead) {
      return {
        valid: false,
        error: {
          code: "FILE_CONTEXT_REQUIRED",
          message:
            "Read the current file section containing oldText before modifying it.",
        },
      };
    }
    return { valid: true, context, currentRevision };
  }

  buildModificationVerification(
    absolutePath,
    content,
    changedStartIndex,
    replacementText,
  ) {
    const startLine = content.slice(0, changedStartIndex).split(/\r?\n/).length;
    const replacementLines = replacementText.split(/\r?\n/).length;
    const totalLines = content.split(/\r?\n/).length;
    const verificationStartLine = Math.max(1, startLine - 10);
    const verificationEndLine = Math.min(
      totalLines,
      startLine + Math.max(1, replacementLines) + 10,
    );
    const context = this.agent.createFileReadContext(
      absolutePath,
      content,
      verificationStartLine,
      verificationEndLine,
      "post-write-verification",
    );
    return {
      verified: true,
      startLine: context.startLine,
      endLine: context.endLine,
      revision: context.revision,
      content: context.content,
    };
  }

  normalizeLineEndingsWithBoundaries(value) {
    const source = typeof value === "string" ? value : "";
    let normalized = "";
    const boundaries = [0];

    for (let index = 0; index < source.length; ) {
      if (source[index] === "\r") {
        index += source[index + 1] === "\n" ? 2 : 1;
        normalized += "\n";
      } else {
        normalized += source[index];
        index += 1;
      }
      boundaries.push(index);
    }
    return { normalized, boundaries };
  }

  findUniqueTextMatch(content, searchText, nearLine) {
    const source = typeof content === "string" ? content : "";
    const search = typeof searchText === "string" ? searchText : "";
    if (!search) return { status: "missing", occurrences: 0 };

    const findMatches = (haystack, needle) => {
      const matches = [];
      let cursor = 0;
      while (cursor <= haystack.length - needle.length) {
        const index = haystack.indexOf(needle, cursor);
        if (index === -1) break;
        matches.push(index);
        cursor = index + needle.length;
      }
      return matches;
    };

    const exactMatches = findMatches(source, search);
    const hasCarriageReturns = source.includes("\r") || search.includes("\r");
    if (exactMatches.length === 1 && !hasCarriageReturns) {
      return {
        status: "unique",
        startIndex: exactMatches[0],
        endIndex: exactMatches[0] + search.length,
        match: "exact",
      };
    }
    if (exactMatches.length > 1) {
      return this.agent.selectMatchNearLine(source, search, exactMatches, nearLine);
    }

    const normalizedSource = this.agent.normalizeLineEndingsWithBoundaries(source);
    const normalizedSearch = search.replace(/\r\n?|\n/g, "\n");
    const normalizedMatches = findMatches(
      normalizedSource.normalized,
      normalizedSearch,
    );
    if (normalizedMatches.length > 1) {
      return this.agent.selectMatchNearLine(
        source,
        search,
        normalizedMatches.map((index) => normalizedSource.boundaries[index]),
        nearLine,
        normalizedSearch.length,
        normalizedMatches.map(
          (index) =>
            normalizedSource.boundaries[index + normalizedSearch.length],
        ),
      );
    }
    if (exactMatches.length === 1) {
      return {
        status: "unique",
        startIndex: exactMatches[0],
        endIndex: exactMatches[0] + search.length,
        match: "exact",
      };
    }
    if (normalizedMatches.length === 1) {
      const start = normalizedMatches[0];
      const end = start + normalizedSearch.length;
      return {
        status: "unique",
        startIndex: normalizedSource.boundaries[start],
        endIndex: normalizedSource.boundaries[end],
        match: "normalized-line-endings",
      };
    }
    return { status: "missing", occurrences: 0 };
  }

  selectMatchNearLine(
    source,
    search,
    matches,
    nearLine,
    matchLength,
    endIndexes = [],
  ) {
    const occurrences = matches.map((startIndex) => ({
      startIndex,
      line: source.slice(0, startIndex).split(/\r?\n/).length,
    }));
    const validNearLine = Number.isInteger(nearLine) && nearLine > 0;
    if (!validNearLine) {
      return {
        status: "ambiguous",
        occurrences: occurrences.length,
        nearestLines: occurrences.map((item) => item.line),
      };
    }
    const ranked = occurrences
      .map((item) => ({ ...item, distance: Math.abs(item.line - nearLine) }))
      .sort((left, right) => left.distance - right.distance);
    if (
      ranked.length === 0 ||
      (ranked[1] && ranked[0].distance === ranked[1].distance)
    ) {
      return {
        status: "ambiguous",
        occurrences: occurrences.length,
        nearestLines: ranked.map((item) => item.line),
      };
    }
    const selected = ranked[0];
    const length = matchLength || search.length;
    return {
      status: "unique",
      startIndex: selected.startIndex,
      endIndex:
        endIndexes[matches.indexOf(selected.startIndex)] ??
        selected.startIndex + length,
      match: "near-line",
      nearLine: selected.line,
    };
  }

  adaptReplacementLineEndings(value, content) {
    const replacement = typeof value === "string" ? value : "";
    const source = typeof content === "string" ? content : "";
    const crlfCount = (source.match(/\r\n/g) || []).length;
    const lfCount = (source.match(/\n/g) || []).length - crlfCount;
    if (crlfCount <= lfCount) return replacement.replace(/\r\n?|\n/g, "\n");
    return replacement.replace(/\r\n?|\n/g, "\r\n");
  }

  async waitForEditorReady(timeout = 3000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      const writer = this.agent.editor?.writerController;
      const lineController = this.agent.editor?.lineController;
      if (writer?.replaceRange && lineController?.getContent) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  lineColumnToIndex(lines, lineNumber, columnNumber) {
    const source = Array.isArray(lines) ? lines : [];
    if (
      !Number.isInteger(lineNumber) ||
      !Number.isInteger(columnNumber) ||
      lineNumber < 1 ||
      lineNumber > source.length ||
      columnNumber < 0 ||
      columnNumber > (source[lineNumber - 1] || "").length
    ) {
      return null;
    }
    const lineIndex = lineNumber - 1;
    const column = columnNumber;
    const offset = source
      .slice(0, lineIndex)
      .reduce((total, line) => total + line.length + 1, 0);
    return offset + Math.min(column, (source[lineIndex] || "").length);
  }

  getStrictRange(text, args = {}) {
    const lines = String(text).split("\n");
    const values = [
      args.startLine,
      args.startColumn,
      args.endLine,
      args.endColumn,
    ];
    if (!values.every((value) => Number.isInteger(value))) {
      return {
        valid: false,
        error: {
          code: "INVALID_RANGE",
          message: "Les coordonnées doivent être des entiers.",
        },
      };
    }
    const { startLine, startColumn, endLine, endColumn } = args;
    if (
      startLine < 1 ||
      endLine < startLine ||
      startLine > lines.length ||
      endLine > lines.length ||
      startColumn < 0 ||
      endColumn < 0
    ) {
      return {
        valid: false,
        error: {
          code: "INVALID_RANGE",
          message: "La plage ne correspond pas aux lignes du fichier.",
        },
      };
    }
    if (
      startColumn > lines[startLine - 1].length ||
      endColumn > lines[endLine - 1].length ||
      (startLine === endLine && endColumn < startColumn)
    ) {
      return {
        valid: false,
        error: {
          code: "INVALID_RANGE",
          message: "Une colonne dépasse la longueur de sa ligne.",
        },
      };
    }
    const lineStart = lines
      .slice(0, startLine - 1)
      .reduce((total, line) => total + line.length + 1, 0);
    const endStart = lines
      .slice(0, endLine - 1)
      .reduce((total, line) => total + line.length + 1, 0);
    const startIndex = lineStart + startColumn;
    const endIndex = endStart + endColumn;
    return {
      valid: true,
      startIndex,
      endIndex,
      actualText: text.slice(startIndex, endIndex),
      startLine,
      startColumn,
      endLine,
      endColumn,
    };
  }

  adjustRangeForMissingIndentation(text, args, range) {
    if (!range || args.startColumn !== 0 || args.startLine !== args.endLine) {
      return range;
    }
    const line = String(text).split("\n")[args.startLine - 1] || "";
    const indentation = line.match(/^[ \t]*/)?.[0] || "";
    if (!indentation || typeof args.expectedText !== "string") return range;
    const content = line.slice(
      indentation.length,
      indentation.length + args.expectedText.length,
    );
    if (args.expectedText !== content) return range;
    return {
      ...range,
      startColumn: indentation.length,
      startIndex: range.startIndex + indentation.length,
      endColumn: range.endColumn + indentation.length,
      endIndex: range.endIndex + indentation.length,
      actualText: args.expectedText,
    };
  }

  toProjectRelativePath(filePath, rootPath) {
    if (typeof filePath !== "string") return "";
    const path = filePath.replace(/\\/g, "/");
    const root =
      typeof rootPath === "string"
        ? rootPath.replace(/\\/g, "/").replace(/\/+$/, "")
        : "";
    const normalizedPath = AgentPath.normalize(path);
    const normalizedRoot = AgentPath.normalize(root);
    const rootPrefix =
      normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`)
        ? normalizedRoot
        : null;
    return rootPrefix
      ? normalizedPath.slice(rootPrefix.length + 1)
      : normalizedPath;
  }

}

window.FileContextManager = FileContextManager;
