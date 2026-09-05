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
      selection: select.containsSelected || "",
      selectionRange: select.getLogicalSelection(),
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
      character.length !== 1 ||
      this.shouldIgnoreCharacterEvent(event)
    ) {
      return false;
    }

    const context = this.getTypingContext();
    if (!context) return false;

    if (context.selection && this.isOpeningCharacter(character)) {
      return this.wrapSelection(character, context);
    }

    if (character === "}" && this.handleClosingIndent(character, context)) {
      return true;
    }

    if (
      this.isClosingCharacter(character) &&
      context.after === character
    ) {
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
      open + context.selection + close,
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

    const context = this.getTypingContext();
    if (!context || context.selection) return false;

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
    if (!this.isWhitespaceOnly(indentationBeforeCaret) || context.column === 0) {
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

    const context = this.getTypingContext();
    if (!context) return false;
    if (context.selection && context.selectionRange) {
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
      const anchor = select.containsSelected
        ? select.startSelect
        : { row: context.row, column: context.column };
      if (!anchor) return false;
      select.setSelection(anchor, { row: context.row, column: targetColumn });
      return true;
    }

    if (select.containsSelected) select.unSelectAll();
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
    const configuredWidth = Number(CONFIG_GET("tab_width"));
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
      width +=
        character === "\t" ? tabWidth - (width % tabWidth) : 1;
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
    if (character !== "}" || context.selection) return false;

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
}
