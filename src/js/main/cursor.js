class Cursor {
  constructor(e) {
    this.editor = e;
    this.mX = 10;
    this.mY = 7;
    this.mpY = 21;
    this.mpX = 10;
    this.leterSize = 12;
    this.cD = document.querySelector(".editor-caret");
    //y
    this.row = 1;
    //x
    this.column = 1;

    this.rowToY = (row) => {
      return baseY + posY * row - this.mpY;
    };
    this.columnToX = (column) => {
      return baseX + (column - 1) * this.leterSize + 1;
    };
    this.yToRow = (y) => {
      return roundY((y - baseY) / posY) + 1;
    };
    this.xToColumn = (x) => {
      return roundX((x - baseX) / this.leterSize) + 1;
    };

    this.onClick = (event) => {
      const x =
        event.clientX -
        this.editor.output.getBoundingClientRect().left -
        this.mX;
      const y =
        event.clientY -
        this.editor.output.getBoundingClientRect().top -
        this.mY;

      let row = this.yToRow(y);
      let column = this.xToColumn(x);

      if (row <= 0) row = 1;
      if (row > this.editor.lineController.maxIndex)
        row = this.editor.lineController.maxIndex;
      const l = this.editor.lineController.lines[row - 1].length;
      if (column > l) column = l;

      if (this.row != row || this.column != column)
        this.editor.output.dispatchEvent(
          new CustomEvent("cursormove", {
            detail: { row: row, column: column },
          })
        );
      this.row = row;
      this.column = column;

      this.setCursorPosition(row, column);

      if (!this.cD.classList.contains("caret-enable"))
        this.cD.classList.add("caret-enable");
    };
    this.caretFrame = () => {
      if (this.cD.style.display == "block" || !this.editor.selected)
        this.cD.style.display = "none";
      else this.cD.style.display = "block";
    };
    this.setCursorPosition = (y, x) => {
      if (y <= 0) y = 1;
      if (y > this.editor.lineController.maxIndex)
        y = this.editor.lineController.maxIndex;
      let l = this.editor.lineController.lines[y - 1];
      if (l == undefined) l = 0;
      else l = l.length;
      if (x > l) x = l;

      const placeY = this.rowToY(y);
      const placeX = this.columnToX(x);

      this.cD.style.left = placeX + "px";
      this.cD.style.top = placeY + "px";

      this.row = y;
      this.column = x;

      this.editor.lineController.setFocusLine(this.row);
      this.editor.output.dispatchEvent(
        new CustomEvent("cursorchange", {
          detail: { row: y, column: x },
        })
      );
    };

    this.getCursorPosition = () => {
      return [this.row, this.column];
    };

    this.getBeforeLetter = () => {
      const l = this.editor.lineController.lines[this.row - 1];
      return l[this.column];
    };
    this.getAfterLetter = () => {
      const l = this.editor.lineController.lines[this.row - 1];
      return l[this.column + 1];
    };
    this.getLine = () => {
      const l = this.editor.lineController.lines[this.row - 1];
      return l;
    };
    this.getBeforeLine = () => {
      const l = this.editor.lineController.lines[this.row - 2];
      return l;
    };
    this.getAfterLine = () => {
      const l = this.editor.lineController.lines[this.row];
      return l;
    };
    this.getIndexWord = () => {
      const l = this.editor.lineController.lines[this.row - 1];
      const words = this.editor.writerController.splitWord(l);
      let count = 0;

      for (let i = 0; i < words.length; i++) {
        const word = words[i];
        count += word.length;
        if (this.column - count <= 0) return i;
      }
    };
    this.getWord = () => {
      const l = this.editor.lineController.lines[this.row - 1];
      const words = this.editor.writerController.splitWord(l);

      return words[this.getIndexWord()];
    };
    this.getBeforeWord = () => {
      const l = this.editor.lineController.lines[this.row - 1];
      const words = this.editor.writerController.splitWord(l);

      return words[this.getIndexWord() - 1];
    };
    this.getAfterWord = () => {
      const l = this.editor.lineController.lines[this.row - 1];
      const words = this.editor.writerController.splitWord(l);

      return words[this.getIndexWord() + 1];
    };

    addInterval(this.caretFrame, 500);

    addEvent("click", this.onClick, this.editor.output);
  }
}
