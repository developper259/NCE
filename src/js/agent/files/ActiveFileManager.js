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
    const startLine =
      Number.isInteger(args.startLine) && args.startLine > 0
        ? args.startLine
        : 1;
    const endLine = Math.min(
      Number.isInteger(args.endLine) ? args.endLine : startLine + 149,
      startLine + 199,
      lines.length,
    );
    const content = lines.slice(startLine - 1, endLine).join("\n");
    const fullContent = lines.join("\n");
    const readContext = this.agent.createFileReadContext(
      AgentPath.normalize(file.path),
      fullContent,
      startLine,
      endLine,
      "read_active_file",
    );
    return {
      success: true,
      path: this.agent.toProjectRelativePath(
        file.path,
        this.agent.editor?.fileExplorer?.rootPath,
      ),
      startLine,
      endLine,
      totalLines: lines.length,
      truncated: endLine < lines.length,
      revision: readContext.revision,
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
    const rows = beforeLines.length + 1;
    const cols = afterLines.length + 1;
    const lcs = Array.from({ length: rows }, () => Array(cols).fill(0));

    for (
      let beforeIndex = beforeLines.length - 1;
      beforeIndex >= 0;
      beforeIndex -= 1
    ) {
      for (
        let afterIndex = afterLines.length - 1;
        afterIndex >= 0;
        afterIndex -= 1
      ) {
        lcs[beforeIndex][afterIndex] =
          beforeLines[beforeIndex] === afterLines[afterIndex]
            ? lcs[beforeIndex + 1][afterIndex + 1] + 1
            : Math.max(
                lcs[beforeIndex + 1][afterIndex],
                lcs[beforeIndex][afterIndex + 1],
              );
      }
    }

    let beforeIndex = 0;
    let documentIndex = 0;
    let afterIndex = 0;
    while (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
      if (
        beforeIndex < beforeLines.length &&
        afterIndex < afterLines.length &&
        beforeLines[beforeIndex] === afterLines[afterIndex]
      ) {
        file.diffRows.push({
          type: "unchanged",
          text: afterLines[afterIndex],
          documentIndex,
        });
        beforeIndex += 1;
        afterIndex += 1;
        documentIndex += 1;
      } else if (
        beforeIndex < beforeLines.length &&
        (afterIndex >= afterLines.length ||
          lcs[beforeIndex + 1][afterIndex] >= lcs[beforeIndex][afterIndex + 1])
      ) {
        file.diffRows.push({
          type: "removed",
          text: beforeLines[beforeIndex],
          documentIndex: null,
        });
        beforeIndex += 1;
      } else {
        file.diffRows.push({
          type: "added",
          text: afterLines[afterIndex],
          documentIndex,
        });
        afterIndex += 1;
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
      const fileContent = this.agent.editor?.lineController?.getContent?.() || "";
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
          ? this.agent.adjustRangeForMissingIndentation(beforeText, args, strictRange)
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
      cursorBefore,
      match: hasTextMatch ? "exact" : "coordinates",
    };
    this.agent.executedModificationRequests.set(requestKey, result);
    return result;
  }

}

window.ActiveFileManager = ActiveFileManager;
