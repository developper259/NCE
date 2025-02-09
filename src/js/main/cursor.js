class Cursor {
  constructor(e) {
    this.editor = e;
    this._row = 0;
    this._column = 0;
    this.mX = 10; // diff X axis
    this.mY = 7; // diff Y axis
    this.mpY = 19; // diff on calcul Y axis
    this.mpX = 10; // diff on calcul X axis
    this.cD = document.querySelector(".editor-caret");

    this.cD.style.height = this.editor.posY + "px";
    this.cD.style.marginLeft = this.mpX + "px";
  }

  get row() {
    return this.editor.fileManager.activeFile?.row;
  }

  set row(value) {
    if (this.editor.fileManager.activeFile) {
      this.editor.fileManager.activeFile.row = value;
    }
  }

  get column() {
    return this.editor.fileManager.activeFile?.column;
  }

  set column(value) {
    if (this.editor.fileManager.activeFile) {
      this.editor.fileManager.activeFile.column = value;
    }
  }

  rowToY(row) {
    return this.editor.baseY + this.editor.posY * row - this.mpY;
  }

  columnToX(column) {
    return this.editor.baseX + (column - 1) * this.editor.letterSize + 1;
  }

  yToRow(y) {
    return roundY((y - this.editor.baseY) / this.editor.posY) + 1;
  }

  xToColumn(x) {
    return roundX(x / this.editor.letterSize) + 1;
  }

  onClick(event) {
    if (!this.editor.fileManager.activeFile) return;
    this.editor.keyBinding.historyX = undefined;
    const x =
      event.clientX - this.editor.output.getBoundingClientRect().left - this.mX;
    const y =
      event.clientY - this.editor.output.getBoundingClientRect().top - this.mY;

    const posReal = this.getPositionReverse(this.yToRow(y), this.xToColumn(x));
    if (!posReal) return;

    if (this.editor.lineController.lines[posReal.row - 1]) {
      const c =
        this.editor.lineController.lines[posReal.row - 1][posReal.column - 1];
      if (c === "\t") {
        const nbTab = getOccurrence(
          "\t",
          this.editor.lineController.lines[posReal.row - 1].slice(
            0,
            posReal.column
          )
        );
        const calc =
          ((this.xToColumn(x) -
            (posReal.column + (nbTab * CONFIG_GET("tab_width") - nbTab))) /
            CONFIG_GET("tab_width")) *
          -1;
        if (calc > 0.5) posReal.column -= 1;
      }
    }
    const pos = this.getPosition(posReal.row, posReal.column);
    if (!pos) return;
    const row = pos.row;
    const column = pos.column;

    if (
      this.row !== row ||
      this.column !== column ||
      this.column == 0 ||
      this.row == 0
    ) {
      CALLEVENT("cursormove", { row, column });
      this.setCursorPosition(posReal.row, posReal.column);
    }
  }

  setCursorPosition(row, column) {
    if (!this.editor.fileManager.activeFile) return;

    const pos = this.getPosition(row, column);
    if (!pos) return;
    row = pos.row;
    column = pos.column;

    if (
      this.row !== row ||
      this.column !== column ||
      this.column == 0 ||
      this.row == 0
    ) {
      const placeY = this.rowToY(row) - 4;
      const placeX = this.columnToX(column);

      this.cD.style.display = "block";
      this.cD.style.left = `${placeX}px`;
      this.cD.style.top = `${placeY}px`;

      this.row = row;
      this.column = column;

      this.editor.lineController.setFocusLine(this.row);

      this.editor.setSelected(true);
      CALLEVENT("cursorchange", { row, column });
    }
  }

  getPosition(row, column) {
    if (!this.editor.fileManager.activeFile) return;
    if (row <= 0) row = 1;
    if (row > this.editor.lineController.maxIndex) {
      row = this.editor.lineController.maxIndex;
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

  getPositionReverse(row, column) {
    if (!this.editor.fileManager.activeFile) return;
    if (row <= 0) row = 1;
    if (row > this.editor.lineController.maxIndex) {
      row = this.editor.lineController.maxIndex;
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

  getCursorPositionReverse() {
    return this.getPositionReverse(this.row, this.column);
  }
  getCursorPosition() {
    return this.getPosition(this.row, this.column);
  }

  getBeforeLetter() {
    const pos = this.getCursorPositionReverse();
    const line = this.editor.lineController.lines[this.row - 1];
    return line[pos.column];
  }

  getAfterLetter() {
    const pos = this.getCursorPositionReverse();
    const line = this.editor.lineController.lines[this.row - 1];
    return line[pos.column + 1];
  }

  getLine() {
    return this.editor.lineController.lines[this.row - 1];
  }

  getBeforeLine() {
    return this.editor.lineController.lines[this.row - 2];
  }

  getAfterLine() {
    return this.editor.lineController.lines[this.row];
  }

  getIndexWord() {
    const line = this.editor.lineController.lines[this.row - 1];
    if (!line) return;
    const words = this.editor.writerController.splitWord(line);
    const pos = this.getCursorPositionReverse();
    let count = 0;

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      count += word.length;
      if (pos.column - count <= 0) return i;
    }
  }

  getWord() {
    const line = this.editor.lineController.lines[this.row - 1];
    const words = this.editor.writerController.splitWord(line);
    return words[this.getIndexWord()];
  }

  getBeforeWord() {
    const line = this.editor.lineController.lines[this.row - 1];
    const words = this.editor.writerController.splitWord(line);
    return words[this.getIndexWord() - 1];
  }

  getAfterWord() {
    const line = this.editor.lineController.lines[this.row - 1];
    const words = this.editor.writerController.splitWord(line);
    return words[this.getIndexWord() + 1];
  }
}
