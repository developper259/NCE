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
      let difY = 4;
      let difX = 1;

      let x = this.editor.cursor.columnToX(columnS);
      let y = this.editor.cursor.rowToY(row + 1) - difY;
      let width = columnE * this.editor.cursor.leterSize - difX;
      let height = 21 + difY;

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

      this.createSelectEl(
        x,
        wordOBJ.innerText.length,
        y,
        "selected",
        wordOBJ.innerText
      );
      this.editor.cursor.setCursorPosition(y + 1, x + wordOBJ.innerText.length - 1);
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
      this.createSelectEl(
        1,
        lines[index].length,
        index,
        "selected",
        lines[index]
      );
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
      let els = getElements(".selected");
      let i = 0;
      let lastEl;
      //width
      let lastElW;

      for (let el of els) {
        el.removeAttribute("class");
        let classes = el.classList;
        classes.add("selected");

        // 1 element selected
        if (els.length == 1) classes.add("selected-all");
        // more element selected
        else {
          if (i != 0) lastElW = parseInt(window.getComputedStyle(lastEl).width);
          let elW = parseInt(window.getComputedStyle(el).width);
          if (i == 0) {
            classes.add("selected-start");
          }
          if (i == els.length - 1) {
            if (lastElW < elW) classes.add("selected-end-all");
            else classes.add("selected-end-bottom");
          }
          else {
            let nextEl = els[i + 1];
            let nextElW = parseInt(window.getComputedStyle(nextEl).width);
            if ((!lastElW || lastElW < elW) && elW > nextElW) {
              classes.add("selected-end")
            }else{
              if (!lastElW || lastElW < elW) {
                classes.add("selected-end-top")
              }else{
                classes.add("selected-reverse-top");
              }
              if (elW > nextElW) {
                classes.add("selected-end-bottom")
              }else{
                classes.add("selected-reverse-bottom");
              }
            }
          }
          
        }
        lastEl = el;
        i++;
      }
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
    this.cursorDisabled = (event) => {
      let els = getElements(".selected");

      for (let el of els) {
        let classes = el.classList;
        classes.remove("selected");
        classes.add("selected-afk");
      }
    };
    this.cursorEnabled = (event) => {
      let els = getElements(".selected");

      for (let el of els) {
        let classes = el.classList;
        classes.remove("selected-afk");
        classes.add("selected");
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
    addEvent("cursordisabled", this.cursorDisabled, document);
    addEvent("cursorenabled", this.cursorEnabled, document);
  }
}
