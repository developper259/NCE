class CursorController {
  constructor(e) {
    this.editor = e;
    this._row = 0;
    this._column = 0;
    this.mX = 10; // diff X axis
    this.mY = 7; // diff Y axis
    this.mpY = 19; // diff on calcul Y axis
    this.mpX = 10; // diff on calcul X axis

    this.editor.cD.style.height = this.editor.posY + "px";
    this.editor.cD.style.marginLeft = this.mpX + "px";
  }

  get row() {
    return this.editor.tabManager.activeFile?.row;
  }

  set row(value) {
    if (this.editor.tabManager.activeFile) {
      this.editor.tabManager.activeFile.row = value;
    }
  }

  get column() {
    return this.editor.tabManager.activeFile?.column;
  }

  set column(value) {
    if (this.editor.tabManager.activeFile) {
      this.editor.tabManager.activeFile.column = value;
    }
  }

  enable() {
    if (this.editor.cD) {
      this.editor.cD.style.display = "block";
    }
  }

  disable() {
    if (this.editor.cD) {
      this.editor.cD.style.display = "none";
    }
  }

  rowToY(row) {
    const lc = this.editor.lineController;
    const displayIndex = lc.getDisplayIndexForCursor(row);
    const screenRow = displayIndex - lc.startIndex;
    return lc.getLineTop(screenRow) + 4;
  }

  columnToX(viewColumn) {
    const offsetXChars = this.editor.lineController.offsetX || 0;
    return (
      this.editor.baseX +
      (viewColumn - 1 - offsetXChars) * this.editor.letterSize +
      1
    );
  }

  yToRow(y) {
    return roundY((y - this.editor.baseY) / this.editor.posY) + 1;
  }

  xToColumn(x) {
    return roundX(x / this.editor.letterSize);
  }

  columnFromSelectObj(obj) {
    const offsetXChars = this.editor.lineController.offsetX || 0;
    return (
      this.xToColumn(
        parseInt(window.getComputedStyle(obj).left, 10) - this.editor.baseX,
      ) + offsetXChars
    );
  }

  lengthFromSelectObj(obj) {
    return (
      parseInt(window.getComputedStyle(obj).width, 10) / this.editor.letterSize
    );
  }

  isNewPosition(row, realColumn) {
    return this.column !== realColumn || this.row !== row;
  }

  normalizePosition(row, column) {
    const lc = this.editor.lineController;

    if (row > lc.lines.length - 1) row = lc.lines.length;
    if (row <= 0) row = 1;

    const line = lc.lines[row - 1] ? lc.lines[row - 1].getText() : "";
    if (column < 0) column = 0;
    if (column > line.length) column = line.length;

    return { row: row, column: column };
  }

  onClick(event) {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.keyBinding.historyX = undefined;

    const rect = this.editor.domManager.getOutputRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top - this.mY;

    const scrollOffsetY = this.editor.lineController.getScrollOffsetY();
    const scrollOffsetXChars = this.editor.lineController.offsetX || 0;

    const displayIndex = this.yToRow(localY + scrollOffsetY) - 1;
    const displayRow = this.editor.lineController.getDisplayRow(displayIndex);
    if (!displayRow || displayRow.documentIndex === null) return;
    const targetRow = displayRow.documentIndex + 1;
    const targetViewColumn = this.xToColumn(localX) + scrollOffsetXChars;

    const posReal = this.getPosition(targetRow, targetViewColumn);
    if (!posReal) return;

    if (this.isNewPosition(posReal.row, posReal.column)) {
      this.setCursorPosition(posReal.row, posReal.column);
    }

    return posReal;
  }

  setCursorPosition(r, c) {
    if (!this.editor.tabManager.activeFile) return;

    const { row, column } = this.normalizePosition(r, c);

    this.editor.focusOutput();

    if (this.isNewPosition(row, column)) {
      this.row = row;
      this.column = column;

      this.editor.lineController.setFocusLine(this.row);
      this.editor.setSelected(true);

      if (!this.editor.isOnInit) {
        this.editor.events.callEvent(Events.CURSOR_CHANGE, {
          row: this.row,
          column: this.column,
        });
      }
    }

    this.updateCaretPosition();
  }

  isRowVisible(row) {
    const lc = this.editor.lineController;
    const displayIndex = lc.getDisplayIndexForCursor(row);
    const screenRow = displayIndex - lc.startIndex;
    if (screenRow < 0 || screenRow >= lc.maxViewLines) return false;

    const top = lc.getLineTop(screenRow) - lc.offsetY;
    const bottom = top + this.editor.posY;
    const viewport = lc.getViewportHeight();
    return bottom > 0 && top < viewport;
  }

  updateCaretPosition() {
    if (!this.editor.tabManager.activeFile) {
      this.disable();
      return;
    }

    if (!this.isRowVisible(this.row)) {
      this.disable();
      return;
    }

    const viewPos = this.getViewPosition(this.row, this.column);

    const placeY =
      this.rowToY(this.row) - 4 - this.editor.lineController.offsetY;
    const placeX = this.columnToX(viewPos.column);

    this.enable();
    this.editor.cD.style.left = `${placeX}px`;
    this.editor.cD.style.top = `${placeY}px`;
  }

  getViewPosition(row, realColumn) {
    if (!this.editor.tabManager.activeFile) return { row: 1, column: 0 };

    const lc = this.editor.lineController;
    row = Math.max(1, Math.min(row, lc.lines.length));

    const lineNode = lc.lines[row - 1];
    if (!lineNode) return { row, column: 0 };

    const line = lineNode.getText();
    const safeRealCol = Math.max(0, Math.min(realColumn, line.length));

    const viewColumn = realColumnToViewColumn(line, safeRealCol);

    return { row: row, column: viewColumn };
  }

  getPosition(row, viewColumn) {
    if (!this.editor.tabManager.activeFile) return { row: 1, column: 0 };

    const lc = this.editor.lineController;
    row = Math.max(1, Math.min(row, lc.lines.length));

    const lineNode = lc.lines[row - 1];
    if (!lineNode) return { row, column: 0 };

    const line = lineNode.getText();
    return {
      row: row,
      column: viewColumnToRealColumn(line, viewColumn),
    };
  }

  getCursorPosition() {
    return { row: this.row, column: this.column };
  }

  getCursorReelPosition() {
    return { row: this.row, column: this.column };
  }

  getBeforeLetter() {
    const pos = this.getCursorPosition();
    const line = this.getLine();
    if (!line || pos.column <= 0) return undefined;

    return line[pos.column - 1];
  }

  getAfterLetter() {
    const pos = this.getCursorPosition();
    const line = this.getLine();
    if (!line || pos.column >= line.length) return undefined;

    return line[pos.column];
  }

  getLine() {
    if (!this.editor.lineController?.lines) return "";
    const lineNode = this.editor.lineController.lines[this.row - 1];
    return lineNode ? lineNode.getText() : "";
  }

  getBeforeLine() {
    if (!this.editor.lineController?.lines) return undefined;
    const lineNode = this.editor.lineController.lines[this.row - 2];
    return lineNode ? lineNode.getText() : undefined;
  }

  getAfterLine() {
    if (!this.editor.lineController?.lines) return undefined;
    const lineNode = this.editor.lineController.lines[this.row];
    return lineNode ? lineNode.getText() : undefined;
  }

  getIndexWord() {
    const line = this.getLine();
    if (!line) return -1;

    const words = this.editor.writerController.splitWord(line);
    if (!words || words.length === 0) return -1;

    const pos = this.getCursorPosition();
    let count = 0;

    for (let i = 0; i < words.length; i++) {
      count += words[i].length;
      if (pos.column <= count) {
        return i;
      }
    }

    return words.length - 1;
  }

  getWord() {
    const line = this.getLine();
    if (!line) return undefined;

    const words = this.editor.writerController.splitWord(line);
    const index = this.getIndexWord();

    return index !== -1 ? words[index] : undefined;
  }

  getBeforeWord() {
    const line = this.getLine();
    if (!line) return undefined;

    const words = this.editor.writerController.splitWord(line);
    const index = this.getIndexWord();

    return index > 0 ? words[index - 1] : undefined;
  }

  getAfterWord() {
    const line = this.getLine();
    if (!line) return undefined;

    const words = this.editor.writerController.splitWord(line);
    const index = this.getIndexWord();

    return index !== -1 && index < words.length - 1
      ? words[index + 1]
      : undefined;
  }
}
