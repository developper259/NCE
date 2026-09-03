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
}
