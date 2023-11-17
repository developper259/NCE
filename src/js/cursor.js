class Cursor {
  constructor(e) {
    this.mX = 10;
    this.mY = 7;
    this.mpY = 21;
    this.mpX = 10;
    this.cD = document.querySelector(".editor-caret");
    this.editor = e;
    //y
    this.row = 1;
    //x
    this.column = 0;

    this.onClick = (event) => {
      const x =
        event.clientX - this.editor.output.getBoundingClientRect().left - this.mX;
      const y =
        event.clientY - this.editor.output.getBoundingClientRect().top - this.mY;

      this.row = round((y - baseY) / posY + 1);

      this.setCursorPosition(this.row, this.column);

      if (!this.cD.classList.contains("caret-enable"))
        this.cD.classList.add("caret-enable");
    };
    this.caretFrame = () => {
      if (this.cD.style.display == "block" || !this.editor.selected)
      this.cD.style.display = "none";
      else this.cD.style.display = "block";
    };
    this.setCursorPosition = (row, column) => {

      if (row > this.editor.lineController.maxIndex) row = this.editor.lineController.maxIndex;

      const placeY = baseY + posY * row - this.mpY;
      const placeX = baseX + column;

      this.cD.style.left = placeX + "px";
      this.cD.style.top = placeY + "px";

      this.row = row;
      this.column = column;

      this.editor.lineController.setFocusLine(this.row);
    };

    this.getCursorPosition = () => {
      return [this.row, this.column];
    };

    this.setCursorPosition(this.row, this.column);

    addInterval(this.caretFrame, 500);

    addEvent("click", this.onClick, this.editor.output);
  }
}
