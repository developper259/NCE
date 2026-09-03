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

    if (
      this.isClosingCharacter(character) &&
      context.after === character
    ) {
      return this.skipClosingCharacter(context);
    }

    if (this.isOpeningCharacter(character)) {
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
    if (
      !context ||
      context.selection ||
      !this.isOpeningCharacter(context.before) ||
      this.getClosingPair(context.before) !== context.after
    ) {
      return false;
    }

    const result = this.editor.writerController.deleteRange(
      { row: context.row, column: context.column - 1 },
      { row: context.row, column: context.column + 1 },
    );
    if (!result) return false;

    this.editor.lineController.refresh();
    this.editor.cursorController.setCursorPosition(result.row, result.column);
    return true;
  }

  handleEnter(event) {
    if (this.shouldIgnoreCommandEvent(event)) return false;

    const context = this.getTypingContext();
    if (
      !context ||
      context.selection ||
      context.before !== "{" ||
      context.after !== "}"
    ) {
      return false;
    }

    this.editor.writerController.write("\n\n");
    this.editor.cursorController.setCursorPosition(context.row + 1, 0);
    return true;
  }

  getIndentation() {
    return " ".repeat(CONFIG_GET("tab_width"));
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
