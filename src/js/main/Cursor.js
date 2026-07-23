class Cursor {
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

  rowToY(row) {
    const lc = this.editor.lineController;
    const screenRow = row - 1 - lc.startIndex;
    return lc.getLineTop(screenRow) + 4;
  }

  columnToX(column) {
    const offsetXChars = this.editor.lineController.offsetX || 0;
    return (
      this.editor.baseX +
      (column - 1 - offsetXChars) * this.editor.letterSize +
      1
    );
  }

  yToRow(y) {
    return roundY((y - this.editor.baseY) / this.editor.posY) + 1;
  }

  xToColumn(x) {
    return roundX(x / this.editor.letterSize) + 1;
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

  isNewPosition(column, row) {
    return this.column !== column || this.row !== row;
  }

  onClick(event) {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.keyBinding.historyX = undefined;

    const rect = this.editor.output.getBoundingClientRect();
    const localX = event.clientX - rect.left - this.mX;
    const localY = event.clientY - rect.top - this.mY;

    const scrollOffsetY = this.editor.lineController.getScrollOffsetY();
    const scrollOffsetXChars = this.editor.lineController.offsetX || 0;

    const targetRow = this.yToRow(localY + scrollOffsetY);
    const targetColumn = this.xToColumn(localX) + scrollOffsetXChars;

    const posReal = this.getReelPosition(targetRow, targetColumn);
    if (!posReal) return;

    const line = this.editor.lineController.lines[posReal.row - 1];
    if (line) {
      const ch = line[posReal.column - 1];
      if (ch === "\t") {
        const tabWidth = CONFIG_GET("tab_width");
        let nbTab = 0;
        const limit = Math.min(posReal.column, line.length);
        for (let i = 0; i < limit; i++) {
          if (line.charCodeAt(i) === 9) nbTab++; // 9 == charCode of tab
        }
        const adjustedCol = posReal.column + (nbTab * tabWidth - nbTab);
        const calc = ((targetColumn - adjustedCol) / tabWidth) * -1;
        if (calc > 0.5) posReal.column -= 1;
      }
    }

    const pos = this.getPosition(posReal.row, posReal.column);
    if (!pos) return;
    const row = pos.row;
    const column = pos.column;
    if (this.isNewPosition(row, column)) {
      this.setCursorPosition(posReal.row, posReal.column);
    }

    return pos;
  }

  setCursorPosition(row, column) {
    if (!this.editor.tabManager.activeFile) return;

    const pos = this.getPosition(row, column);
    if (!pos) return;
    row = pos.row;
    column = pos.column;

    if (this.isNewPosition(row, column)) {
      this.row = row;
      this.column = column;

      this.editor.lineController.setFocusLine(this.row);

      this.editor.setSelected(true);
      
      if (!this.editor.isOnInit) {
        this.editor.events.callEvent(Events.CURSOR_CHANGE, { row, column });
      }
    }

    this.updateCaretPosition();
  }

  isRowVisible(row) {
    const lc = this.editor.lineController;
    const screenRow = row - 1 - lc.startIndex;
    if (screenRow < 0 || screenRow >= lc.maxViewLines) return false;

    const top = lc.getLineTop(screenRow);
    const bottom = top + this.editor.posY;
    const viewport = lc.outputHeight;
    return bottom > 0 && top < viewport;
  }

  updateCaretPosition() {
    if (!this.editor.tabManager.activeFile) {
      if (this.editor.cD) {
        this.editor.cD.style.display = "none";
      }
      return;
    }

    if (!this.isRowVisible(this.row)) {
      this.editor.cD.style.display = "none";
      return;
    }

    const placeY = this.rowToY(this.row) - 4;
    const placeX = this.columnToX(this.column);

    this.editor.cD.style.display = "block";
    this.editor.cD.style.left = `${placeX}px`;
    this.editor.cD.style.top = `${placeY}px`;
  }

  getPosition(row, column) {
    // visible position of cursor == column
    if (!this.editor.tabManager.activeFile) return;
    if (row <= 0) row = 1;
    if (row > this.editor.lineController.lines.length) {
      row = this.editor.lineController.lines.length;
    }

    const line = this.editor.lineController.lines[row - 1];
    if (line == undefined) return;
    let lineLength = this.editor.lineController.getViewLineLength(row - 1);

    if (column < 0) column = 0;
    if (column > lineLength) column = lineLength;
    if (column > lineLength) {
      column = lineLength;
    }

    if (line.includes("\t")) {
      let i = 0;
      let a = 0;
      for (let c of line) {
        if (a >= column) break;
        if (c === "\t") {
          i += CONFIG_GET("tab_width");
        } else i++;
        a++;
      }
      column = i;
    }

    return { row: row, column: column };
  }

  getReelPosition(row, column) {
    // real position of cursor == x
    if (!this.editor.tabManager.activeFile) return;
    if (row <= 0) row = 1;
    if (row > this.editor.lineController.lines.length) {
      row = this.editor.lineController.lines.length;
    }

    const line = this.editor.lineController.lines[row - 1];
    if (line == undefined) return { row: 1, column: 0 };
    let lineLength = this.editor.lineController.getViewLineLength(row - 1);

    if (column < 0) column = 0;
    if (column > lineLength) column = lineLength;
    if (column > lineLength) {
      column = lineLength;
    }

    if (line.includes("\t")) {
      let a = 0;
      let i = 0;
      for (let c of line) {
        if (i >= column) break;
        if (c === "\t") {
          i += CONFIG_GET("tab_width");
        } else i++;
        a++;
      }
      column = a;
    }
    return { row: row, column: column };
  }

  getCursorReelPosition() {
    return this.getReelPosition(this.row, this.column);
  }

  getCursorPosition() {
    return this.getPosition(this.row, this.column);
  }

  getBeforeLetter() {
    const pos = this.getCursorReelPosition();
    if (!pos) return undefined;

    const line = this.getLine();
    if (!line || pos.column <= 0) return undefined;

    return line[pos.column - 1];
  }

  getAfterLetter() {
    const pos = this.getCursorReelPosition();
    if (!pos) return undefined;

    const line = this.getLine();
    if (!line || pos.column >= line.length) return undefined;

    return line[pos.column];
  }

  getLine() {
    if (!this.editor.lineController?.lines) return "";
    return this.editor.lineController.lines[this.row - 1] || "";
  }

  getBeforeLine() {
    if (!this.editor.lineController?.lines) return undefined;
    return this.editor.lineController.lines[this.row - 2];
  }

  getAfterLine() {
    if (!this.editor.lineController?.lines) return undefined;
    return this.editor.lineController.lines[this.row];
  }

  getIndexWord() {
    const line = this.getLine();
    if (!line) return -1;

    const words = this.editor.writerController.splitWord(line);
    if (!words || words.length === 0) return -1;

    const pos = this.getCursorReelPosition();
    if (!pos) return -1;

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
