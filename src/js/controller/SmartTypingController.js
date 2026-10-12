class SmartTypingController {
  constructor(e) {
    this.editor = e;
    this.defaultPairs = [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: "{", close: "}" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: "`", close: "`" },
    ];
    this.openingPairs = new Map(
      this.defaultPairs.map((pair) => [pair.open, pair.close]),
    );
    this.closingCharacters = new Set(
      this.defaultPairs.map((pair) => pair.close),
    );
  }

  getPairs() {
    return this.defaultPairs;
  }

  getClosingPair(character) {
    return this.openingPairs.get(character);
  }

  isOpeningCharacter(character) {
    return this.openingPairs.has(character);
  }

  isClosingCharacter(character) {
    return this.closingCharacters.has(character);
  }

  getTypingContext() {
    const file = this.editor.tabManager.activeFile;
    const cursor = this.editor.cursorController;
    const select = this.editor.selectController;

    if (!file || !cursor || !select) return null;

    const row = cursor.row;
    const column = cursor.column;
    const lineNode = this.editor.lineController.lines[row - 1];
    const line = lineNode ? lineNode.getText() : "";

    return {
      row,
      column,
      line,
      before: column > 0 ? line[column - 1] : "",
      after: column < line.length ? line[column] : "",
      hasSelection: select.hasActiveSelection?.() === true,
      selectionRange: select.getLogicalSelection(),
    };
  }

  getTypingContexts() {
    const multi = this.editor.multiCursorController;
    const selections = multi?.getSelections?.() || [];
    if (selections.length < 2) {
      const context = this.getTypingContext();
      return context ? [context] : [];
    }
    return selections.map((selection) => {
      const context = this.getTypingContext();
      if (!context) return null;
      const range = multi.getRange(selection);
      const lineNode = this.editor.lineController.lines[selection.active.row - 1];
      const line = lineNode?.getText?.() || "";
      const hasSelection = multi.isSelected(selection);
      return {
        ...context,
        cursorId: selection.id,
        row: selection.active.row,
        column: selection.active.column,
        line,
        before: selection.active.column > 0 ? line[selection.active.column - 1] : "",
        after: selection.active.column < line.length ? line[selection.active.column] : "",
        hasSelection,
        selectionRange: hasSelection ? {
          startRow: range.start.row,
          startColumn: range.start.column,
          endRow: range.end.row,
          endColumn: range.end.column,
        } : null,
        selection,
      };
    }).filter(Boolean);
  }

  getContextEdit(context, text, options = {}) {
    const range = context.selectionRange;
    return {
      id: context.cursorId,
      cursorId: context.cursorId,
      start: range
        ? { row: range.startRow, column: range.startColumn }
        : { row: context.row, column: context.column },
      end: range
        ? { row: range.endRow, column: range.endColumn }
        : { row: context.row, column: context.column },
      text,
      ...options,
    };
  }

  applyMultiEdits(edits, source = "typing") {
    const file = this.editor.tabManager.activeFile;
    const result = this.editor.writerController.applyBatchEdits(edits, {
      source,
      primaryId: file?._multiCursorPrimaryId,
      ensureVisible: true,
    });
    return result !== null;
  }

  updateMultiSelections(selections) {
    const multi = this.editor.multiCursorController;
    const file = this.editor.tabManager.activeFile;
    if (!multi?.setSelections?.(selections, {
      file,
      primaryId: file?._multiCursorPrimaryId,
      ensureVisible: true,
    })) return false;
    const primary = multi.getPrimarySelection(file);
    this.editor.cursorController.setCursorPosition(
      primary.active.row,
      primary.active.column,
      { emitEvent: false, syncMultiCursor: false },
    );
    this.editor.selectController?.refreshSelectionDOM?.();
    return true;
  }

  handleMultiCharacter(character, contexts) {
    const multi = this.editor.multiCursorController;
    const edits = [];
    let allSkippedClosers = true;

    for (const context of contexts) {
      if (context.hasSelection && this.isOpeningCharacter(character)) {
        const range = context.selectionRange;
        const selected = this.editor.writerController.getTextInRange(
          { row: range.startRow, column: range.startColumn },
          { row: range.endRow, column: range.endColumn },
        );
        edits.push(this.getContextEdit(context, `${character}${selected}${this.getClosingPair(character)}`));
        allSkippedClosers = false;
        continue;
      }

      if (character === "}" && this.getClosingIndentEdit(context)) {
        edits.push(this.getClosingIndentEdit(context));
        allSkippedClosers = false;
        continue;
      }

      if (this.isClosingCharacter(character) && context.after === character && !context.hasSelection) {
        const lineNode = this.editor.lineController.lines[context.row - 1];
        const next = lineNode?.getPositionIndex?.()?.next(context.column) ?? context.column + 1;
        edits.push({
          id: context.cursorId,
          cursorId: context.cursorId,
          start: { row: context.row, column: context.column },
          end: { row: context.row, column: next },
          text: character,
        });
        continue;
      }

      allSkippedClosers = false;
      if (this.isOpeningCharacter(character) &&
          (!this.isQuote(character) || this.shouldAutoCloseQuote(context))) {
        edits.push(this.getContextEdit(
          context,
          character + this.getClosingPair(character),
          { cursorOffset: character.length },
        ));
      } else {
        edits.push(this.getContextEdit(context, character));
      }
    }

    if (allSkippedClosers) {
      const nextSelections = multi.getSelections().map((selection) => {
        const context = contexts.find((candidate) => candidate.cursorId === selection.id);
        const lineNode = this.editor.lineController.lines[selection.active.row - 1];
        const column = lineNode?.getPositionIndex?.()?.next(selection.active.column) ?? selection.active.column + 1;
        const active = context?.after === character
          ? { row: selection.active.row, column }
          : selection.active;
        return { ...selection, anchor: { ...active }, active: { ...active } };
      });
      return this.updateMultiSelections(nextSelections);
    }
    return this.applyMultiEdits(edits, "typing");
  }

  getClosingIndentEdit(context) {
    if (context.hasSelection || context.column === 0) return null;
    const beforeCaret = context.line.slice(0, context.column);
    if (!this.isWhitespaceOnly(beforeCaret)) return null;
    const startColumn = this.getPreviousIndentColumn(beforeCaret);
    const endColumn = context.after === "}"
      ? (this.editor.lineController.lines[context.row - 1]?.getPositionIndex?.()?.next(context.column) ?? context.column + 1)
      : context.column;
    return {
      id: context.cursorId,
      cursorId: context.cursorId,
      start: { row: context.row, column: startColumn },
      end: { row: context.row, column: endColumn },
      text: "}",
      cursorOffset: 1,
    };
  }

  isCompositionEvent(event) {
    return Boolean(event?.isComposing || event?.keyCode === 229);
  }

  shouldIgnoreCharacterEvent(event) {
    if (!event || this.isCompositionEvent(event)) return Boolean(event);

    const usesAltGraph =
      (typeof event.getModifierState === "function" &&
        event.getModifierState("AltGraph")) ||
      (event.ctrlKey && event.altKey);

    return Boolean(event.metaKey || (event.ctrlKey && !usesAltGraph));
  }

  shouldIgnoreCommandEvent(event) {
    return Boolean(
      event &&
      (this.isCompositionEvent(event) ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey),
    );
  }

  handleCharacter(character, event) {
    if (
      typeof character !== "string" ||
      (character.length !== 1 && character !== " ") ||
      this.shouldIgnoreCharacterEvent(event)
    ) {
      return false;
    }

    const context = this.getTypingContext();
    if (!context) return false;

    const contexts = this.getTypingContexts();
    if (contexts.length > 1) return this.handleMultiCharacter(character, contexts);

    if (context.hasSelection && this.isOpeningCharacter(character)) {
      return this.wrapSelection(character, context);
    }

    if (character === "}" && this.handleClosingIndent(character, context)) {
      return true;
    }

    if (this.isClosingCharacter(character) && context.after === character) {
      return this.skipClosingCharacter(context);
    }

    if (this.isOpeningCharacter(character)) {
      if (this.isQuote(character) && !this.shouldAutoCloseQuote(context)) {
        return false;
      }
      return this.insertPair(character, context);
    }

    return false;
  }

  insertPair(open, context) {
    const close = this.getClosingPair(open);
    if (!close) return false;

    this.editor.writerController.write(open + close);
    this.editor.cursorController.setCursorPosition(
      context.row,
      context.column + open.length,
    );
    return true;
  }

  skipClosingCharacter(context) {
    this.editor.cursorController.setCursorPosition(
      context.row,
      context.column + 1,
    );
    return true;
  }

  wrapSelection(open, context) {
    const close = this.getClosingPair(open);
    const range = context.selectionRange;
    if (!close || !range) return false;

    const result = this.editor.writerController.replaceRange(
      open + this.editor.selectController.getSelectedText() + close,
      range.startRow,
      range.startColumn,
      range.endRow,
      range.endColumn,
    );
    if (!result) return false;

    this.editor.lineController.setFocusLine(result.row);
    this.editor.cursorController.setCursorPosition(result.row, result.column);
    return true;
  }

  handleBackspace(event) {
    if (this.shouldIgnoreCommandEvent(event)) return false;

    const multi = this.editor.multiCursorController;
    const selections = multi?.getSelections?.() || [];
    if (selections.length > 1) {
      const contexts = new Map(this.getTypingContexts().map((context) => [context.cursorId, context]));
      const edits = selections.map((selection) => {
        const range = multi.getRange(selection);
        let start = range.start;
        let end = range.end;
        if (!multi.isSelected(selection)) {
          const context = contexts.get(selection.id);
          if (!context) return null;
          if (
            this.isOpeningCharacter(context.before) &&
            this.getClosingPair(context.before) === context.after
          ) {
            const lineNode = this.editor.lineController.lines[context.row - 1];
            start = {
              row: context.row,
              column: lineNode?.getPositionIndex?.()?.previous(context.column) ?? context.column - 1,
            };
            end = {
              row: context.row,
              column: lineNode?.getPositionIndex?.()?.next(context.column) ?? context.column + 1,
            };
          } else {
            const before = context.line.slice(0, context.column);
            if (context.column > 0 && this.isWhitespaceOnly(before)) {
              start = { row: context.row, column: this.getPreviousIndentColumn(before) };
            } else if (context.column > 0) {
              const lineNode = this.editor.lineController.lines[context.row - 1];
              start = {
                row: context.row,
                column: lineNode?.getPositionIndex?.()?.previous(context.column) ?? context.column - 1,
              };
            } else if (context.row > 1) {
              const previous = this.editor.lineController.lines[context.row - 2];
              start = { row: context.row - 1, column: previous?.getText?.().length || 0 };
            }
          }
        }
        return {
          id: selection.id,
          cursorId: selection.id,
          start,
          end,
          text: "",
        };
      });
      if (edits.some((edit) => !edit)) return false;
      return this.applyMultiEdits(edits, "delete");
    }

    const context = this.getTypingContext();
    if (!context || context.hasSelection) return false;

    if (
      this.isOpeningCharacter(context.before) &&
      this.getClosingPair(context.before) === context.after
    ) {
      return this.deleteAndPlaceCursor(
        { row: context.row, column: context.column - 1 },
        { row: context.row, column: context.column + 1 },
      );
    }

    const indentationBeforeCaret = context.line.slice(0, context.column);
    if (
      !this.isWhitespaceOnly(indentationBeforeCaret) ||
      context.column === 0
    ) {
      return false;
    }

    const startColumn = this.getPreviousIndentColumn(indentationBeforeCaret);
    return this.deleteAndPlaceCursor(
      { row: context.row, column: startColumn },
      { row: context.row, column: context.column },
    );
  }

  handleEnter(event) {
    if (this.shouldIgnoreCommandEvent(event)) return false;

    const multi = this.editor.multiCursorController;
    const selections = multi?.getSelections?.() || [];
    if (selections.length > 1) {
      const contexts = this.getTypingContexts();
      const edits = contexts.map((context) => this.getEnterEdit(context));
      if (edits.some((edit) => !edit)) return false;
      return this.applyMultiEdits(edits, "enter");
    }

    const context = this.getTypingContext();
    if (!context) return false;
    if (context.hasSelection && context.selectionRange) {
      return this.replaceSelectionWithLineBreak(context.selectionRange);
    }

    const indentation = this.getLineIndentation(context.line);
    const beforeCaret = context.line.slice(0, context.column);
    const afterCaret = context.line.slice(context.column);
    const contentBeforeCaret = beforeCaret.slice(indentation.length);

    if (
      contentBeforeCaret.trim() === "/**" &&
      this.isWhitespaceOnly(afterCaret)
    ) {
      const middleIndentation = indentation + " ";
      this.editor.writerController.write(
        `\n${middleIndentation}* \n${middleIndentation}*/`,
      );
      this.placeCursor(context.row + 1, middleIndentation.length + 2);
      return true;
    }

    const lineComment = this.getLineCommentContinuation(
      contentBeforeCaret,
      afterCaret,
    );
    if (lineComment === "stop") {
      return this.replaceCurrentLine(
        context,
        `${indentation}\n${indentation}`,
        context.row + 1,
        indentation.length,
      );
    }
    if (lineComment) {
      this.editor.writerController.write(`\n${indentation}${lineComment}`);
      return true;
    }

    const blockComment = this.getBlockCommentContinuation(
      contentBeforeCaret,
      context.row,
    );
    if (blockComment) {
      this.editor.writerController.write(`\n${indentation}${blockComment}`);
      return true;
    }

    if (this.isBetweenStructuralPair(context.before, context.after)) {
      const innerIndentation = indentation + this.getIndentUnit();
      this.editor.writerController.write(
        `\n${innerIndentation}\n${indentation}`,
      );
      this.placeCursor(context.row + 1, innerIndentation.length);
      return true;
    }

    const nextIndentation = this.shouldIncreaseIndent(beforeCaret)
      ? indentation + this.getIndentUnit()
      : indentation;

    this.editor.writerController.write(`\n${nextIndentation}`);
    return true;
  }

  handleHome(shiftKey = false, event) {
    if (this.shouldIgnoreCommandEvent(event)) return false;

    const multi = this.editor.multiCursorController;
    const selections = multi?.getSelections?.() || [];
    if (selections.length > 1) {
      const contexts = new Map(this.getTypingContexts().map((context) => [context.cursorId, context]));
      const next = selections.map((selection) => {
        const context = contexts.get(selection.id);
        if (!context) return selection;
        const indentationColumn = this.getLineIndentation(context.line).length;
        const targetColumn = this.isWhitespaceOnly(context.line)
          ? 0
          : context.column === indentationColumn ? 0 : indentationColumn;
        return {
          ...selection,
          anchor: shiftKey ? { ...selection.anchor } : { row: context.row, column: targetColumn },
          active: { row: context.row, column: targetColumn },
        };
      });
      return this.updateMultiSelections(next);
    }

    const context = this.getTypingContext();
    if (!context) return false;

    const indentationColumn = this.getLineIndentation(context.line).length;
    const targetColumn = this.isWhitespaceOnly(context.line)
      ? 0
      : context.column === indentationColumn
        ? 0
        : indentationColumn;
    const select = this.editor.selectController;

    if (shiftKey && typeof select.setSelection === "function") {
      const anchor = select.hasActiveSelection?.()
        ? select.startSelect
        : { row: context.row, column: context.column };
      if (!anchor) return false;
      select.setSelection(anchor, { row: context.row, column: targetColumn });
      return true;
    }

    if (select.hasActiveSelection?.()) select.unSelectAll();
    this.placeCursor(context.row, targetColumn);
    return true;
  }

  handlePaste(text, event) {
    if (
      this.isCompositionEvent(event) ||
      typeof text !== "string" ||
      (!text.includes("\n") && !text.includes("\r"))
    ) {
      return false;
    }

    const context = this.getTypingContext();
    if (!context) return false;

    const normalizedText = text.replace(/\r\n?/g, "\n");
    const lines = normalizedText.split("\n");
    const commonIndentation = this.getCommonIndentationWidth(lines);
    const multi = this.editor.multiCursorController;
    const selections = multi?.getSelections?.() || [];
    if (selections.length > 1) {
      const normalizedLines = lines.map((line) =>
        this.isWhitespaceOnly(line) ? "" : this.removeIndentationWidth(line, commonIndentation),
      );
      const edits = selections.map((selection) => {
        const range = multi.getRange(selection);
        const row = range.start.row;
        const column = range.start.column;
        const destinationLine = this.editor.lineController.lines[row - 1]?.getText?.() || "";
        const destinationIndentation = this.getPasteDestinationIndentation(destinationLine, column);
        const transformed = normalizedLines.map((line, index) =>
          index === 0 || line === "" ? line : destinationIndentation + line,
        ).join("\n");
        return {
          id: selection.id,
          cursorId: selection.id,
          start: range.start,
          end: range.end,
          text: transformed,
        };
      });
      return this.applyMultiEdits(edits, "paste");
    }
    const insertionRow = context.selectionRange
      ? context.selectionRange.startRow
      : context.row;
    const insertionColumn = context.selectionRange
      ? context.selectionRange.startColumn
      : context.column;
    const destinationLineNode =
      this.editor.lineController.lines[insertionRow - 1];
    const destinationLine = destinationLineNode
      ? destinationLineNode.getText()
      : "";
    const destinationIndentation = this.getPasteDestinationIndentation(
      destinationLine,
      insertionColumn,
    );
    const normalizedLines = lines.map((line) =>
      this.isWhitespaceOnly(line)
        ? ""
        : this.removeIndentationWidth(line, commonIndentation),
    );
    const transformed = normalizedLines
      .map((line, index) =>
        index === 0 || line === "" ? line : destinationIndentation + line,
      )
      .join("\n");

    if (context.selectionRange) {
      const range = context.selectionRange;
      const result = this.editor.writerController.replaceRange(
        transformed,
        range.startRow,
        range.startColumn,
        range.endRow,
        range.endColumn,
        { preserveViewport: true },
      );
      if (!result) return false;
      this.placeCursor(result.row, result.column);
      return true;
    }

    this.editor.writerController.write(transformed);
    return true;
  }

  getIndentUnit() {
    const configuredWidth = Number(SETTINGS_GET("editor.tabWidth"));
    const width =
      Number.isFinite(configuredWidth) && configuredWidth > 0
        ? Math.floor(configuredWidth)
        : 2;
    return " ".repeat(width);
  }

  getIndentation() {
    return this.getIndentUnit();
  }

  getLineIndentation(line) {
    let index = 0;
    while (
      index < line.length &&
      (line[index] === " " || line[index] === "\t")
    ) {
      index++;
    }
    return line.slice(0, index);
  }

  isWhitespaceOnly(text) {
    for (const character of text) {
      if (character !== " " && character !== "\t") return false;
    }
    return true;
  }

  isQuote(character) {
    return character === '"' || character === "'" || character === "`";
  }

  isEscapedAt(line, column) {
    let slashCount = 0;
    for (let index = column - 1; index >= 0 && line[index] === "\\"; index--) {
      slashCount++;
    }
    return slashCount % 2 === 1;
  }

  shouldAutoCloseQuote(context) {
    return !this.isEscapedAt(context.line, context.column);
  }

  isStructuralOpening(character) {
    return character === "{" || character === "[" || character === "(";
  }

  isBetweenStructuralPair(before, after) {
    return (
      this.isStructuralOpening(before) && this.getClosingPair(before) === after
    );
  }

  shouldIncreaseIndent(textBeforeCaret) {
    let index = textBeforeCaret.length - 1;
    while (
      index >= 0 &&
      (textBeforeCaret[index] === " " || textBeforeCaret[index] === "\t")
    ) {
      index--;
    }
    return index >= 0 && this.isStructuralOpening(textBeforeCaret[index]);
  }

  getLineCommentContinuation(contentBeforeCaret, contentAfterCaret) {
    if (!contentBeforeCaret.startsWith("//")) return "";
    if (!this.isWhitespaceOnly(contentAfterCaret)) return "// ";
    return contentBeforeCaret.slice(2).trim() ? "// " : "stop";
  }

  getBlockCommentContinuation(contentBeforeCaret, row) {
    const trimmed = contentBeforeCaret.trimStart();
    if (trimmed.startsWith("*/")) return "";
    if (trimmed.startsWith("/*")) return " * ";
    if (trimmed.startsWith("*") && this.hasAdjacentBlockCommentLine(row)) {
      return "* ";
    }
    return "";
  }

  hasAdjacentBlockCommentLine(row) {
    if (row <= 1) return false;
    const previousLineNode = this.editor.lineController.lines[row - 2];
    const previousLine = previousLineNode ? previousLineNode.getText() : "";
    const previousContent = previousLine.trimStart();
    return (
      previousContent.startsWith("/*") ||
      (previousContent.startsWith("*") && !previousContent.startsWith("*/"))
    );
  }

  getPreviousIndentColumn(indentation) {
    if (indentation.endsWith("\t")) return indentation.length - 1;

    const width = this.getIndentUnit().length;
    let trailingSpaces = 0;
    for (
      let index = indentation.length - 1;
      index >= 0 && indentation[index] === " ";
      index--
    ) {
      trailingSpaces++;
    }
    const spacesToRemove = trailingSpaces % width || width;
    return indentation.length - Math.min(trailingSpaces, spacesToRemove);
  }

  getPasteDestinationIndentation(line, insertionColumn) {
    const prefix = line.slice(0, insertionColumn);
    if (this.isWhitespaceOnly(prefix)) return prefix;
    return this.getLineIndentation(line);
  }

  getIndentationWidth(line) {
    const tabWidth = this.getIndentUnit().length;
    const indentation = this.getLineIndentation(line);
    let width = 0;

    for (const character of indentation) {
      width += character === "\t" ? tabWidth - (width % tabWidth) : 1;
    }
    return width;
  }

  removeIndentationWidth(line, widthToRemove) {
    if (widthToRemove <= 0) return line;

    const tabWidth = this.getIndentUnit().length;
    let width = 0;
    let index = 0;

    while (
      index < line.length &&
      (line[index] === " " || line[index] === "\t")
    ) {
      const characterWidth =
        line[index] === "\t" ? tabWidth - (width % tabWidth) : 1;
      if (width + characterWidth > widthToRemove) {
        const remainingWidth = width + characterWidth - widthToRemove;
        return " ".repeat(remainingWidth) + line.slice(index + 1);
      }
      width += characterWidth;
      index++;
      if (width === widthToRemove) break;
    }

    return line.slice(index);
  }

  getCommonIndentationWidth(lines) {
    let minimum = Infinity;
    for (const line of lines) {
      if (this.isWhitespaceOnly(line)) continue;
      minimum = Math.min(minimum, this.getIndentationWidth(line));
    }
    return minimum === Infinity ? 0 : minimum;
  }

  handleClosingIndent(character, context) {
    if (character !== "}" || context.hasSelection) return false;

    const beforeCaret = context.line.slice(0, context.column);
    if (!this.isWhitespaceOnly(beforeCaret) || context.column === 0) {
      return false;
    }

    const startColumn = this.getPreviousIndentColumn(beforeCaret);
    const endColumn =
      context.after === character ? context.column + 1 : context.column;
    const result = this.editor.writerController.replaceRange(
      beforeCaret.slice(0, startColumn) + character,
      context.row,
      0,
      context.row,
      endColumn,
      { preserveViewport: true },
    );
    if (!result) return false;
    this.placeCursor(result.row, result.column);
    return true;
  }

  replaceCurrentLine(context, text, cursorRow, cursorColumn) {
    const result = this.editor.writerController.replaceRange(
      text,
      context.row,
      0,
      context.row,
      context.line.length,
      { preserveViewport: true },
    );
    if (!result) return false;
    this.placeCursor(cursorRow, cursorColumn);
    return true;
  }

  replaceSelectionWithLineBreak(range) {
    const lineNode = this.editor.lineController.lines[range.startRow - 1];
    const line = lineNode ? lineNode.getText() : "";
    const indentation = this.getLineIndentation(line);
    const result = this.editor.writerController.replaceRange(
      `\n${indentation}`,
      range.startRow,
      range.startColumn,
      range.endRow,
      range.endColumn,
      { preserveViewport: true },
    );
    if (!result) return false;
    this.placeCursor(result.row, result.column);
    return true;
  }

  deleteAndPlaceCursor(start, end) {
    const result = this.editor.writerController.deleteRange(start, end);
    if (!result) return false;
    this.editor.lineController.refresh();
    this.placeCursor(result.row, result.column);
    return true;
  }

  placeCursor(row, column) {
    this.editor.lineController.setFocusLine?.(row);
    this.editor.cursorController.setCursorPosition(row, column);
  }

  getSelectedLineRange() {
    const select = this.editor.selectController;
    const range = select.getLogicalSelection();
    if (!range || range.startRow === range.endRow) return null;

    const firstRow = range.startRow;
    let lastRow = range.endRow;

    if (range.endColumn === 0 && lastRow > firstRow) {
      lastRow--;
    }

    if (lastRow <= firstRow) return null;

    return { firstRow, lastRow };
  }

  getUnindentLength(line, indentation) {
    if (line.startsWith(indentation)) return indentation.length;
    if (indentation === "\t") return line.startsWith("\t") ? 1 : 0;

    let length = 0;
    while (length < indentation.length && line[length] === " ") length++;
    return length;
  }

  adjustSelectionPosition(position, firstRow, lastRow, deltas) {
    if (!position || position.row < firstRow || position.row > lastRow) {
      return position ? { ...position } : null;
    }

    const delta = deltas[position.row - firstRow] || 0;
    return {
      row: position.row,
      column:
        delta >= 0
          ? position.column + delta
          : Math.max(0, position.column + delta),
    };
  }

  handleTab(shiftKey = false, event) {
    if (this.shouldIgnoreCommandEvent(event)) return false;

    const multi = this.editor.multiCursorController;
    const selections = multi?.getSelections?.() || [];
    if (selections.length > 1) {
      return this.handleMultiTab(shiftKey, selections);
    }

    const selectedRange = this.getSelectedLineRange();
    if (!selectedRange) return false;

    const { firstRow, lastRow } = selectedRange;
    const lineController = this.editor.lineController;
    const selectController = this.editor.selectController;
    const indentation = this.getIndentation();
    const lines = lineController.lines
      .slice(firstRow - 1, lastRow)
      .map((line) => line.getText());
    const deltas = [];

    const updatedLines = lines.map((line) => {
      if (!shiftKey) {
        deltas.push(indentation.length);
        return indentation + line;
      }

      const removedLength = this.getUnindentLength(line, indentation);
      deltas.push(-removedLength);
      return line.slice(removedLength);
    });

    if (shiftKey && deltas.every((delta) => delta === 0)) return true;

    const anchor = this.adjustSelectionPosition(
      selectController.startSelect,
      firstRow,
      lastRow,
      deltas,
    );
    const focus = this.adjustSelectionPosition(
      selectController.endSelect || {
        row: this.editor.cursorController.row,
        column: this.editor.cursorController.column,
      },
      firstRow,
      lastRow,
      deltas,
    );
    const lastLine = lines[lines.length - 1];
    const result = this.editor.writerController.replaceRange(
      updatedLines.join("\n"),
      firstRow,
      0,
      lastRow,
      lastLine.length,
      { preserveViewport: true },
    );
    if (!result || !anchor || !focus) return false;

    selectController.setSelection(anchor, focus);
    return true;
  }

  getEnterEdit(context) {
    const range = context.selectionRange;
    if (context.hasSelection && range) {
      const indentation = this.getLineIndentation(
        this.editor.lineController.lines[range.startRow - 1]?.getText?.() || "",
      );
      return this.getContextEdit(context, `\n${indentation}`, {
        cursorOffset: 1 + indentation.length,
      });
    }

    const indentation = this.getLineIndentation(context.line);
    const beforeCaret = context.line.slice(0, context.column);
    const afterCaret = context.line.slice(context.column);
    const contentBeforeCaret = beforeCaret.slice(indentation.length);
    if (
      contentBeforeCaret.trim() === "/**" &&
      this.isWhitespaceOnly(afterCaret)
    ) {
      const middleIndentation = indentation + " ";
      const text = `\n${middleIndentation}* \n${middleIndentation}*/`;
      return this.getContextEdit(context, text, {
        cursorOffset: 1 + middleIndentation.length + 2,
      });
    }

    const lineComment = this.getLineCommentContinuation(contentBeforeCaret, afterCaret);
    if (lineComment === "stop") {
      const text = `${indentation}\n${indentation}`;
      return {
        id: context.cursorId,
        cursorId: context.cursorId,
        start: { row: context.row, column: 0 },
        end: { row: context.row, column: context.line.length },
        text,
        cursorOffset: text.length,
      };
    }
    if (lineComment)
      return this.getContextEdit(context, `\n${indentation}${lineComment}`);

    const blockComment = this.getBlockCommentContinuation(contentBeforeCaret, context.row);
    if (blockComment)
      return this.getContextEdit(context, `\n${indentation}${blockComment}`);

    if (this.isBetweenStructuralPair(context.before, context.after)) {
      const innerIndentation = indentation + this.getIndentUnit();
      return this.getContextEdit(
        context,
        `\n${innerIndentation}\n${indentation}`,
        { cursorOffset: 1 + innerIndentation.length },
      );
    }
    const nextIndentation = this.shouldIncreaseIndent(beforeCaret)
      ? indentation + this.getIndentUnit()
      : indentation;
    return this.getContextEdit(context, `\n${nextIndentation}`);
  }

  handleMultiTab(shiftKey, selections) {
    const multi = this.editor.multiCursorController;
    const lineRows = new Set();
    const isMultilineSelection = selections.some((selection) =>
      multi.isSelected(selection) && multi.getRange(selection).start.row < multi.getRange(selection).end.row,
    );
    if (!shiftKey && !isMultilineSelection) {
      this.editor.writerController.write(this.getIndentUnit());
      return true;
    }

    for (const selection of selections) {
      if (!multi.isSelected(selection)) {
        if (shiftKey) lineRows.add(selection.active.row);
        continue;
      }
      const range = multi.getRange(selection);
      if (!shiftKey && range.start.row === range.end.row) continue;
      let lastRow = range.end.row;
      if (range.end.column === 0 && lastRow > range.start.row) lastRow--;
      for (let row = range.start.row; row <= lastRow; row++) lineRows.add(row);
    }
    if (!lineRows.size) {
      if (shiftKey) return true;
      this.editor.writerController.write(this.getIndentUnit());
      return true;
    }

    const lineController = this.editor.lineController;
    const indentation = this.getIndentUnit();
    const changes = [];
    for (const row of [...lineRows].sort((a, b) => a - b)) {
      const line = lineController.lines[row - 1]?.getText?.();
      if (typeof line !== "string") return false;
      if (shiftKey) {
        const removedLength = this.getUnindentLength(line, indentation);
        if (removedLength === 0) continue;
        changes.push({ row, oldText: line, newText: line.slice(removedLength), delta: -removedLength });
      } else {
        changes.push({ row, oldText: line, newText: indentation + line, delta: indentation.length });
      }
    }
    if (!changes.length) return true;

    const edits = changes.map((change) => ({
      start: { row: change.row, column: 0 },
      end: { row: change.row, column: change.oldText.length },
      text: change.newText,
    }));
    const byRow = new Map(changes.map((change) => [change.row, change]));
    const resultSelections = selections.map((selection) => {
      const adjust = (position) => {
        const change = byRow.get(position.row);
        if (!change) return { ...position };
        return { row: position.row, column: Math.max(0, position.column + change.delta) };
      };
      return {
        ...selection,
        anchor: adjust(selection.anchor),
        active: adjust(selection.active),
      };
    });
    const file = this.editor.tabManager.activeFile;
    const result = this.editor.writerController.applyBatchEdits(edits, {
      source: shiftKey ? "unindent" : "indent",
      primaryId: file?._multiCursorPrimaryId,
      resultSelections,
      ensureVisible: true,
    });
    return result !== null;
  }
}
