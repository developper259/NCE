class ActiveFileManager {
  constructor(agent) {
    this.agent = agent;
  }

  async readSelection() {
    const controller = this.agent.editor?.selectController;
    const text = controller?.getSelectedText
      ? controller.getSelectedText()
      : controller?.containsSelected;
    return typeof text === "string" && text
      ? { success: true, content: this.agent.truncate(text, 2000) }
      : { success: false, error: "Aucune sélection active." };
  }

  async replaceText(args = {}) {
    if (typeof args.oldText !== "string" || typeof args.newText !== "string") {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "oldText et newText doivent être des chaînes.",
        },
      };
    }
    return this.agent.modifyActiveFile({
      oldText: args.oldText,
      newText: args.newText,
    });
  }

  restoreActiveFileSnapshot(content) {
    const lineController = this.agent.editor?.lineController;
    if (typeof lineController?.loadContent !== "function") return false;
    lineController.loadContent(content);
    lineController.markDirtyAll?.();
    lineController.refresh?.(true);
    return true;
  }

  async readActiveFile(args = {}) {
    const controller = this.agent.editor?.lineController;
    const file = this.agent.editor?.tabManager?.activeFile;
    if (!file || !controller)
      return { success: false, error: "Aucun fichier actif." };
    await this.agent.editor?.fileLoader?.waitForFileLoaded?.(file);
    const lines = controller.getContent().split("\n");
    const requestedStartLine =
      Number.isInteger(args.startLine) && args.startLine > 0
        ? args.startLine
        : 1;
    const requestedEndLine = Math.min(
      Number.isInteger(args.endLine)
        ? args.endLine
        : requestedStartLine +
            (this.agent.toolLimits?.read_file?.defaultLines || 200) -
            1,
      requestedStartLine +
        (this.agent.toolLimits?.read_file?.defaultLines || 200) -
        1,
      lines.length,
    );
    const fullContent = lines.join("\n");
    const absolutePath = AgentPath.normalize(file.path);
    const readDecision = this.agent.fileKnowledge.checkRead(
      absolutePath,
      requestedStartLine,
      requestedEndLine,
      {
        toolName: "internal_active_read",
        startColumn: Number.isInteger(args.startColumn)
          ? Math.max(0, args.startColumn)
          : 0,
        currentRevision: this.agent.getContentRevision(fullContent),
      },
    );
    if (readDecision.alreadyKnown) {
      if (readDecision.cachedContext) {
        this.agent.restoreFileReadContext(
          absolutePath,
          readDecision.cachedContext,
          readDecision.entry.revision,
          "runtime-cache",
        );
      }
      return readDecision.result;
    }
    const readRange = readDecision.range || {
      startLine: requestedStartLine,
      endLine: requestedEndLine,
    };
    const startLine = readRange.startLine;
    const endLine = Math.min(readRange.endLine, lines.length);
    const startColumn = Number.isInteger(args.startColumn)
      ? Math.max(0, readDecision.range?.startColumn ?? args.startColumn)
      : 0;
    const firstLine = lines[startLine - 1] || "";
    if (startColumn > firstLine.length)
      return {
        success: false,
        error: {
          code: "INVALID_RANGE",
          message: "startColumn exceeds the line.",
        },
      };
    if (startColumn === firstLine.length) {
      if (startLine < endLine) {
        return this.readActiveFile({
          ...args,
          startLine: startLine + 1,
          startColumn: 0,
        });
      }
      return {
        success: true,
        readDecision: "NEW",
        path: this.agent.toProjectRelativePath(
          file.path,
          this.agent.editor?.fileExplorer?.rootPath,
        ),
        revision: this.agent.getContentRevision(fullContent),
        requestedRange: {
          startLine: requestedStartLine,
          endLine: requestedEndLine,
          startColumn,
        },
        deliveredRange: null,
        completeLineRange: null,
        content: "",
        hasMore: false,
        nextStartLine: null,
        nextStartColumn: null,
      };
    }
    const readLimit =
      this.agent.toolLimits?.read_file?.outputCharacters || 4000;
    if (startColumn > 0 || firstLine.length - startColumn > readLimit) {
      const content = firstLine.slice(startColumn, startColumn + readLimit);
      const endColumn = startColumn + content.length;
      const revision = this.agent.getContentRevision(fullContent);
      this.agent.fileKnowledge.recordPartialSegment(absolutePath, {
        revision,
        toolName: "internal_active_read",
        line: startLine,
        startColumn,
        endColumn,
        lineLength: firstLine.length,
        content,
        totalLines: lines.length,
        diskRead: false,
      });
      return {
        success: true,
        readDecision: "NEW",
        path: this.agent.toProjectRelativePath(
          file.path,
          this.agent.editor?.fileExplorer?.rootPath,
        ),
        revision,
        requestedRange: {
          startLine: requestedStartLine,
          endLine: requestedEndLine,
          startColumn,
        },
        deliveredRange: {
          startLine,
          endLine: startLine,
          startColumn,
          endColumn,
        },
        completeLineRange: null,
        partialSegment: {
          line: startLine,
          startColumn,
          endColumn,
          lineLength: firstLine.length,
        },
        lineTruncated: true,
        contentStartLine: startLine,
        contentEndLine: startLine,
        contentStartColumn: startColumn,
        contentEndColumn: endColumn,
        hasMore: endColumn < firstLine.length || startLine < endLine,
        nextStartLine:
          endColumn < firstLine.length
            ? startLine
            : startLine < endLine
              ? startLine + 1
              : null,
        nextStartColumn: endColumn < firstLine.length ? endColumn : 0,
        content,
      };
    }
    const readContext = this.agent.createFileReadContext(
      absolutePath,
      fullContent,
      startLine,
      endLine,
      "internal_active_read",
    );
    this.agent.fileKnowledge.recordRead(absolutePath, {
      revision: readContext.revision,
      toolName: "internal_active_read",
      startLine,
      endLine,
      requestedStartLine,
      requestedEndLine,
      totalLines: lines.length,
      diskRead: false,
      truncated: readContext.truncated,
      knowledgeEndLine: readContext.knowledgeEndLine,
      content: readContext.cacheContent,
    });
    return {
      success: true,
      readDecision: "NEW",
      path: this.agent.toProjectRelativePath(
        file.path,
        this.agent.editor?.fileExplorer?.rootPath,
      ),
      startLine,
      endLine: readContext.knowledgeEndLine ?? startLine,
      requestedRange: {
        startLine: requestedStartLine,
        endLine: requestedEndLine,
      },
      deliveredRange: {
        startLine,
        endLine: readContext.knowledgeEndLine ?? startLine,
      },
      completeLineRange: readContext.knowledgeEndLine
        ? { startLine, endLine: readContext.knowledgeEndLine }
        : null,
      totalLines: lines.length,
      truncated: endLine < lines.length || readContext.truncated,
      revision: readContext.revision,
      contentEndLine: readContext.knowledgeEndLine,
      informationSource: "editor",
      content: readContext.content,
    };
  }

  async searchActiveFile(args = {}) {
    const controller = this.agent.editor?.searchController;
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!controller?.search)
      return { success: false, error: "SearchController indisponible." };
    if (!query) return { success: false, error: "Requête vide." };
    controller.search(query);
    const results = Array.isArray(controller.results)
      ? controller.results.slice(0, 50)
      : [];
    return {
      success: true,
      query,
      totalMatches: controller.results?.length || 0,
      results: results.map(({ row, column, length }) => ({
        row,
        column,
        length,
      })),
    };
  }

  markFileDiffHighlights(beforeText, afterText, file) {
    if (!file || !Array.isArray(file.lines)) return;

    const originalText =
      file.diffSnapshot === null ? beforeText : file.diffSnapshot;
    if (originalText === afterText) {
      for (const line of file.lines) {
        if (line && typeof line === "object") {
          line.diffState = null;
          line.diffSegments = [];
        }
      }
      file.diffSnapshot = null;
      file.diffActive = false;
      file.diffRows = [];
      return;
    }

    file.diffSnapshot = originalText;
    file.diffActive = true;
    file.diffRows = [];
    const beforeLines = originalText === "" ? [] : originalText.split(/\r?\n/);
    const afterLines = afterText === "" ? [] : afterText.split(/\r?\n/);
    const operations = this.buildScalableLineDiff(beforeLines, afterLines);
    let documentIndex = 0;
    for (const operation of operations) {
      if (operation.type === "equal") {
        file.diffRows.push({
          type: "unchanged",
          text: operation.text,
          documentIndex,
        });
        documentIndex += 1;
      } else if (operation.type === "delete") {
        file.diffRows.push({
          type: "removed",
          text: operation.text,
          documentIndex: null,
        });
      } else {
        file.diffRows.push({
          type: "added",
          text: operation.text,
          documentIndex,
        });
        documentIndex += 1;
      }
    }

    for (const line of file.lines) {
      if (line && typeof line === "object") {
        line.diffState = null;
        line.diffSegments = [];
      }
    }

    if (beforeText === afterText) {
      file.diffRows = [];
    }
  }

  buildScalableLineDiff(beforeLines, afterLines) {
    const prefix = [];
    let prefixLength = 0;
    while (
      prefixLength < beforeLines.length &&
      prefixLength < afterLines.length &&
      beforeLines[prefixLength] === afterLines[prefixLength]
    ) {
      prefix.push({ type: "equal", text: beforeLines[prefixLength] });
      prefixLength += 1;
    }
    let suffixLength = 0;
    while (
      suffixLength < beforeLines.length - prefixLength &&
      suffixLength < afterLines.length - prefixLength &&
      beforeLines[beforeLines.length - suffixLength - 1] ===
        afterLines[afterLines.length - suffixLength - 1]
    )
      suffixLength += 1;

    const before = beforeLines.slice(
      prefixLength,
      beforeLines.length - suffixLength,
    );
    const after = afterLines.slice(
      prefixLength,
      afterLines.length - suffixLength,
    );
    const maxD = 2000;
    let frontier = new Map([[0, 0]]);
    const trace = [];
    let solution = null;
    for (let distance = 0; distance <= maxD && !solution; distance += 1) {
      trace.push(new Map(frontier));
      for (let k = -distance; k <= distance; k += 2) {
        const down =
          k === -distance ||
          (k !== distance &&
            (frontier.get(k - 1) || 0) < (frontier.get(k + 1) || 0));
        let x = down
          ? frontier.get(k + 1) || 0
          : (frontier.get(k - 1) || 0) + 1;
        let y = x - k;
        while (
          x < before.length &&
          y < after.length &&
          before[x] === after[y]
        ) {
          x += 1;
          y += 1;
        }
        frontier.set(k, x);
        if (x >= before.length && y >= after.length) {
          solution = distance;
          break;
        }
      }
    }

    const middle = [];
    if (solution === null) {
      console.warn("[NCE Diff] large diff fallback", {
        event: "large_diff_fallback",
        beforeLines: beforeLines.length,
        afterLines: afterLines.length,
      });
      for (const text of before) middle.push({ type: "delete", text });
      for (const text of after) middle.push({ type: "insert", text });
    } else {
      let x = before.length;
      let y = after.length;
      const reversed = [];
      for (let distance = solution; distance > 0; distance -= 1) {
        const previous = trace[distance];
        const k = x - y;
        const down =
          k === -distance ||
          (k !== distance &&
            (previous.get(k - 1) || 0) < (previous.get(k + 1) || 0));
        const previousK = down ? k + 1 : k - 1;
        const previousX = previous.get(previousK) || 0;
        const previousY = previousX - previousK;
        while (x > previousX && y > previousY) {
          reversed.push({ type: "equal", text: before[x - 1] });
          x -= 1;
          y -= 1;
        }
        if (down) reversed.push({ type: "insert", text: after[previousY] });
        else reversed.push({ type: "delete", text: before[previousX] });
        x = previousX;
        y = previousY;
      }
      while (x > 0 && y > 0) {
        reversed.push({ type: "equal", text: before[x - 1] });
        x -= 1;
        y -= 1;
      }
      while (x > 0) reversed.push({ type: "delete", text: before[--x] });
      while (y > 0) reversed.push({ type: "insert", text: after[--y] });
      middle.push(...reversed.reverse());
    }
    for (let index = 0; index < suffixLength; index += 1) {
      middle.push({
        type: "equal",
        text: afterLines[afterLines.length - suffixLength + index],
      });
    }
    return prefix.concat(middle);
  }

  validateActiveFileSyntax() {
    try {
      const editor = this.agent.editor;
      const lineController = editor?.lineController;
      const file = editor?.tabManager?.activeFile;
      const source =
        typeof lineController?.getContent === "function"
          ? lineController.getContent()
          : "";
      if (!source.trim()) {
        return { valid: true, error: null };
      }
      const fileName = file?.path || file?.name || "";
      const extension = fileName.split(".").pop()?.toLowerCase() || "";
      const language = String(file?.language || "").toLowerCase();
      const isJavaScript =
        ["javascript", "js", "jsx", "mjs", "cjs"].includes(language) ||
        ["js", "jsx", "mjs", "cjs"].includes(extension);
      if (!isJavaScript) {
        return { valid: true, error: null };
      }
      new Function(`"use strict";\n${source}`);
      return { valid: true, error: null, fileName };
    } catch (error) {
      return {
        valid: false,
        error: error?.message || String(error),
      };
    }
  }

  async repairBrokenFileAfterEdit(args = {}, maxPasses = 3) {
    let currentArgs = args;
    let pass = 0;
    let lastResult = null;

    while (pass < maxPasses) {
      pass += 1;
      const result = await this.agent.modifyActiveFile(currentArgs);
      if (!result?.success) {
        return {
          success: false,
          error: result?.error || { code: "EDIT_FAILED" },
        };
      }

      const validation = this.agent.validateActiveFileSyntax();
      if (validation.valid) {
        lastResult = {
          success: true,
          result,
          validation,
          passes: pass,
        };
        break;
      }

      const errorMessage = validation.error;
      const fileContent =
        this.agent.editor?.lineController?.getContent?.() || "";
      const snippet = (fileContent || "").slice(0, 4000);

      currentArgs = {
        ...currentArgs,
        oldText: snippet,
        newText: snippet,
      };

      if (
        typeof currentArgs.newText === "string" &&
        currentArgs.newText.includes(errorMessage)
      ) {
        break;
      }

      if (pass >= maxPasses) {
        return {
          success: false,
          error: {
            code: "SYNTAX_REPAIR_LIMIT_REACHED",
            message: errorMessage,
          },
        };
      }

      lastResult = {
        success: false,
        result,
        validation,
        passes: pass,
      };
    }

    return (
      lastResult || { success: false, error: { code: "NO_REPAIR_ATTEMPT" } }
    );
  }

  async modifyActiveFile(args = {}) {
    const editorReady = await this.agent.waitForEditorReady();
    const file = this.agent.editor?.tabManager?.activeFile;
    const writer = this.agent.editor?.writerController;
    const lineController = this.agent.editor?.lineController;
    if (!editorReady || !file || !writer?.replaceRange || !lineController) {
      return {
        success: false,
        error: {
          code: "EDITOR_NOT_READY",
          message:
            "L'éditeur n'est pas prêt pour une modification. Réessayez lorsque le fichier actif est chargé.",
        },
      };
    }

    await this.agent.editor?.fileLoader?.waitForFileLoaded?.(file);

    const beforeText =
      typeof lineController.getContent === "function"
        ? lineController.getContent()
        : "";
    const cursorBefore = this.agent.editor?.cursorController
      ? {
          row: this.agent.editor.cursorController.row ?? 1,
          column: this.agent.editor.cursorController.column ?? 0,
        }
      : null;
    const replacementText =
      typeof args.newText === "string"
        ? args.newText
        : typeof args.text === "string"
          ? args.text
          : "";
    const requestKey = JSON.stringify({
      oldText: typeof args.oldText === "string" ? args.oldText : null,
      newText: replacementText,
      startLine: args.startLine ?? null,
      startColumn: args.startColumn ?? null,
      endLine: args.endLine ?? null,
      endColumn: args.endColumn ?? null,
    });
    if (this.agent.executedModificationRequests.has(requestKey)) {
      return {
        success: false,
        error: {
          code: "DUPLICATE_MODIFICATION",
          message: "Cette demande de modification a déjà été exécutée.",
        },
      };
    }
    const sourceText =
      typeof args.oldText === "string"
        ? args.oldText
        : typeof args.expectedText === "string"
          ? args.expectedText
          : "";
    if (
      sourceText.length > 0 &&
      replacementText.includes(`${sourceText}${sourceText}`)
    ) {
      return {
        success: false,
        error: {
          code: "SUSPECTED_DUPLICATION",
          message:
            "Le nouveau texte contient deux occurrences consécutives du texte remplacé. La modification est refusée.",
        },
      };
    }
    const hasTextMatch = typeof args.oldText === "string";
    const hasCoordinateFallback =
      Number.isInteger(args.startLine) &&
      Number.isInteger(args.startColumn) &&
      Number.isInteger(args.endLine) &&
      Number.isInteger(args.endColumn);
    const hasAnyCoordinate = [
      args.startLine,
      args.startColumn,
      args.endLine,
      args.endColumn,
    ].some((value) => value !== undefined);

    if (hasAnyCoordinate && !hasCoordinateFallback && !hasTextMatch) {
      return {
        success: false,
        error: {
          code: "INVALID_RANGE",
          message:
            "La plage est incomplète. Fournissez startLine, startColumn, endLine et endColumn, ou utilisez oldText/newText.",
        },
      };
    }

    let resolvedRange = null;

    if (hasTextMatch) {
      if (args.oldText.length === 0) {
        resolvedRange = {
          startLine: 1,
          startColumn: 0,
          endLine: 1,
          endColumn: 0,
          startIndex: 0,
          endIndex: 0,
          text: replacementText,
        };
      }
      const matches = [];
      let cursor = 0;
      while (
        args.oldText.length > 0 &&
        cursor <= beforeText.length - args.oldText.length
      ) {
        const index = beforeText.indexOf(args.oldText, cursor);
        if (index === -1) break;
        matches.push(index);
        cursor = index + args.oldText.length;
      }

      if (args.oldText.length > 0 && matches.length === 0) {
        if (!hasCoordinateFallback) {
          return {
            success: false,
            error: {
              code: "NO_MATCH",
              message: "Aucune occurrence exacte trouvée pour oldText.",
            },
          };
        }
      } else if (args.oldText.length > 0 && matches.length > 1) {
        return {
          success: false,
          error: {
            code: "AMBIGUOUS_MATCH",
            message:
              "oldText est présent plusieurs fois. Le remplacement est refusé pour éviter une corruption.",
            occurrences: matches.length,
          },
        };
      } else if (args.oldText.length > 0) {
        const startIndex = matches[0];
        const endIndex = startIndex + args.oldText.length;
        const startBefore = beforeText.slice(0, startIndex);
        const endBefore = beforeText.slice(0, endIndex);
        resolvedRange = {
          startLine: startBefore.split("\n").length,
          startColumn: startBefore.split("\n").pop().length,
          endLine: endBefore.split("\n").length,
          endColumn: endBefore.split("\n").pop().length,
          startIndex,
          endIndex,
          text: replacementText,
        };
      }
    }

    if (!resolvedRange && hasCoordinateFallback) {
      const strictRange = this.agent.getStrictRange(beforeText, args);
      if (!strictRange.valid)
        return { success: false, error: strictRange.error };
      const adjustedRange =
        typeof args.expectedText === "string"
          ? this.agent.adjustRangeForMissingIndentation(
              beforeText,
              args,
              strictRange,
            )
          : strictRange;
      if (
        typeof args.expectedText !== "string" ||
        adjustedRange.actualText !== args.expectedText
      ) {
        return {
          success: false,
          error: {
            code: "CONTENT_MISMATCH",
            message:
              "Le contenu réel de la plage ne correspond pas à expectedText.",
            expectedText: args.expectedText ?? "",
            actualText: adjustedRange.actualText,
          },
        };
      }
      resolvedRange = { ...adjustedRange, text: replacementText };
    }

    if (
      !resolvedRange ||
      !Object.prototype.hasOwnProperty.call(resolvedRange, "text")
    ) {
      return {
        success: false,
        error: {
          code: "INVALID_REPLACEMENT",
          message:
            "Aucun remplacement valide n'a été fourni. Passez oldText/newText ou une plage de coordonnées valide.",
        },
      };
    }

    if (
      typeof args.expectedText === "string" &&
      beforeText.slice(resolvedRange.startIndex, resolvedRange.endIndex) !==
        args.expectedText
    ) {
      return {
        success: false,
        error: {
          code: "CONTENT_MISMATCH",
          message:
            "Le contenu réel de la plage ne correspond pas à expectedText.",
          expectedText: args.expectedText,
          actualText: beforeText.slice(
            resolvedRange.startIndex,
            resolvedRange.endIndex,
          ),
        },
      };
    }

    const afterText = `${beforeText.slice(0, resolvedRange.startIndex)}${resolvedRange.text}${beforeText.slice(resolvedRange.endIndex)}`;

    let replaceResult;
    try {
      replaceResult = writer.replaceRange(
        resolvedRange.text,
        resolvedRange.startLine,
        resolvedRange.startColumn,
        resolvedRange.endLine,
        resolvedRange.endColumn,
      );
    } catch (error) {
      this.agent.restoreActiveFileSnapshot(beforeText);
      return {
        success: false,
        error: {
          code: "WRITE_FAILED",
          message:
            error?.message || "Le remplacement a provoqué une exception.",
        },
      };
    }

    if (!replaceResult) {
      this.agent.restoreActiveFileSnapshot(beforeText);
      return {
        success: false,
        error: {
          code: "WRITE_FAILED",
          message: "Le remplacement n'a pas été appliqué.",
        },
      };
    }

    const writtenText =
      typeof lineController.getContent === "function"
        ? lineController.getContent()
        : "";
    if (writtenText !== afterText) {
      if (typeof lineController.loadContent === "function") {
        lineController.loadContent(beforeText);
      }
      return {
        success: false,
        error: {
          code: "MODIFICATION_VERIFICATION_FAILED",
          message:
            "Le remplacement n'a pas été vérifié dans le fichier. La modification a été annulée.",
          expectedText: afterText,
          actualText: writtenText,
        },
      };
    }

    this.agent.markFileDiffHighlights(beforeText, afterText, file);
    if (typeof lineController.refresh === "function") {
      lineController.refresh(true);
    }
    file.setIsSaved(false);
    const result = {
      success: true,
      operation: "replace",
      path: this.agent.toProjectRelativePath(
        file.path,
        this.agent.editor?.fileExplorer?.rootPath,
      ),
      range: {
        startLine: resolvedRange.startLine,
        startColumn: resolvedRange.startColumn,
        endLine: resolvedRange.endLine,
        endColumn: resolvedRange.endColumn,
      },
      beforeText,
      afterText,
      revision: this.agent.getContentRevision(afterText),
      cursorBefore,
      match: hasTextMatch ? "exact" : "coordinates",
    };
    this.agent.executedModificationRequests.set(requestKey, result);
    return result;
  }
}

window.ActiveFileManager = ActiveFileManager;
