class SelectController {
  constructor(e) {
    this.editor = e;
    this.isMouseDown = false;
    this.containsSelected = [];

    this.lastClick = 0;
    this.clickCount = 0;

    this.selectOutput = getElement(".editor-select-output");

    //column start | column end
    this.createSelectEl = (columnS, columnE, row, classes, value) => {
      let div = document.createElement("div");

      let x = this.editor.cursor.columnToX(columnS);
      let y = this.editor.cursor.rowToY(row + 1) - 2;
      let width = columnE * this.editor.cursor.leterSize;
      let height = 23;

      div.className = classes;
      div.dataset.line = row;
      div.dataset.value = value;

      div.style.position = "absolute";
      div.style.left = x + "px";
      div.style.top = y + "px";
      div.style.width = width + "px";
      div.style.height = height + "px";

      this.selectOutput.appendChild(div);
      this.refreshContaisSelected();
      this.refreshStartEndSelect();
    };

    this.unSelectAll = () => {
      this.containsSelected = "";
      this.selectOutput.innerHTML = "";
    };

    this.selectAll = () => {
      this.unSelectAll();
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

      this.createSelectEl(x, wordOBJ.innerText.length, y, "selected", wordOBJ.innerText);
      this.editor.cursor.setCursorPosition(y, x + wordOBJ.innerText.length - 1);
    };

    this.unSelectLine = (index) => {
      let els = getElements(".selected");
      for (let el of els) {
        if (el.dataset.line == index) el.remove();
      }
    };
    this.selectLine = (index) => {
      this.unSelectLine(index);
      let lines = this.editor.lineController.lines;
      this.createSelectEl(1, lines[index].length, index, "selected", lines[index]);
      let x = 0;
      if (index == lines.length - 1) x = lines[index].length;
      this.editor.cursor.setCursorPosition(index + 2, x);
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

    this.getTextSelectedLine = (index) => {
      let els = [];

      for (let el of getElements(".selected")) {
        if (el.dataset.line == index) els.push(el);
      }
      els.sort((a, b) => {
        let aLeft = parseInt(window.getComputedStyle(a).left, 10);
        let bLeft = parseInt(window.getComputedStyle(b).left, 10);
        return aLeft - bLeft;
      });

      let c = "";
      for (let el of els) {
        c += el.dataset.value;
      }

      return c;
    };

    this.refreshContaisSelected = () => {
      this.containsSelected = "";

      for (let i in this.editor.lineController.lines) {
        let t = this.getTextSelectedLine(i);
        this.containsSelected += t;
        if (i != this.editor.lineController.lines.length && t)
          this.containsSelected += "\n";
      }
    };
    this.refreshStartEndSelect = () => {
      let a = 0;
      let b = 0;
    };
    this.cursorMove = (event) => {
      if (this.isMouseDown) {
        this.endSelect = [this.editor.cursor.column, this.editor.cursor.row];
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
