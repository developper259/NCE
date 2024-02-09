class SelectController {
  constructor(e) {
    this.editor = e;
    this.isMouseDown = false;
    this.containsSelected = [];

    this.lastClick = 0;
    this.clickCount = 0;

    this.selectOutput = getElement(".editor-select-output");

    //column start | column end
    this.createSelectEl = (columnS, columnE, row, classes) => {
      let div = document.createElement('div');

      let x = this.editor.cursor.columnToX(columnS);
      let y = this.editor.cursor.rowToY(row + 1) - 2;
      let width = columnE * this.editor.cursor.leterSize;
      let height = 23;

      div.className = classes;
      div.id = row;

      div.style.position = 'absolute';
      div.style.left = x + 'px';
      div.style.top = y + 'px';
      div.style.width = width + "px";
      div.style.height = height + "px";

      this.selectOutput.appendChild(div);
    };

    this.unSelectAll = () => {
      this.containsSelected = "";
      this.selectOutput.innerHTML = "";
    };

    this.selectAll = () => {
      for (let i = 0; i < this.editor.lineController.lines.length; i++) {
        this.selectLine(i);
      }
    };

    this.selectWord = (wordOBJ) => {
      const rect = wordOBJ.getBoundingClientRect();
      const editorRect = this.editor.output.getBoundingClientRect();

      let x = this.editor.cursor.xToColumn(rect.left - editorRect.left);
      let y = this.editor.cursor.yToRow(rect.top - editorRect.top);

      y -= 1;

      this.createSelectEl(x, wordOBJ.innerText.length, y, "selected");
      this.refreshContaisSelected();
      this.editor.cursor.setCursorPosition(y, x + wordOBJ.innerText.length - 1);
    };


    this.selectLine = (index) => {
      let lines = this.editor.lineController.lines;
      this.createSelectEl(1, lines[index].length, index, "selected");
      this.editor.cursor.setCursorPosition(index + 1, lines[index].length);
    };

    this.mouseDown = () => {
      if (new Date().getTime() - this.lastClickTime > 300) this.unSelectAll();
      this.startSelect = [this.editor.cursor.column, this.editor.cursor.row];
      this.isMouseDown = true;
    };
    this.mouseUp = () => {
      this.isMouseDown = false;

      if (this.containsSelected.length != 0) {
        this.endSelect = [this.editor.cursor.column, this.editor.cursor.row];
        this.refreshStartEndSelect();
        this.refreshContaisSelected();
      }
    };

    this.refreshContaisSelected = () => {
      this.containsSelected = "";
      

    };
    this.refreshStartEndSelect = () => {
      let a = 0;
      let b = 0;
      
    };
    this.cursorMove = (event) => {
      if (this.isMouseDown) {

        this.endSelect = [this.editor.cursor.column, this.editor.cursor.row];

        this.refreshStartEndSelect();
        this.refreshContaisSelected();
      }
    };
    this.mouseMove = (event) => {
      if (this.isMouseDown) {
        let cursor = this.editor.cursor;
        cursor.cD.style.display = "block";
        cursor.onClick(event);
      }
    };
    this.calcClick = () => {
      var currentTime = new Date().getTime();

      if (currentTime - this.lastClickTime < 300) {
        this.clickCount++;
      } else {
        this.clickCount = 1;
      }
      this.lastClickTime = currentTime;
    };
    this.mouseClick = (event) => {
      this.calcClick();

      if (this.clickCount == 2) {
        const word = this.editor.lineController.getWordOBJ(
          this.editor.cursor.row,
          this.editor.cursor.getIndexWord()
        );

        this.selectWord(word);
      } else if (this.clickCount == 3) {
        this.selectLine(this.editor.cursor.row - 1);
      } else if (this.clickCount >= 4) {
        this.selectAll();
      }
    };
    addEvent("mousedown", this.mouseDown, this.editor.output);
    addEvent("mouseup", this.mouseUp, document);
    addEvent("click", this.mouseClick);
    addEvent("cursormove", this.cursorMove, this.editor.output);
    addEvent("mousemove", this.mouseMove, this.editor.output);
  }
}
