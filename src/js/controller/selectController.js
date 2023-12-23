class SelectController {
  constructor(e) {
    this.editor = e;
    this.isMouseDown = false;
    this.containsSelected = "";

    this.lastClick = 0;
    this.clickCount = 0;

    this.unSelectAll = () => {
      let elements = getElements(".selected");
      for (let el of elements) {
        el.classList.remove("selected");
      }
      this.containsSelected = "";
    };

    this.selectAll = () => {
      let elements = getElements(".line-letter");
      for (let el of elements) {
        if (!el.classList.contains("selected")) el.classList.add("selected");
      }

      this.refreshStartEndSelect();
      this.refreshContaisSelected();
    };

    this.selectWord = (wordOBJ) => {
      if (!wordOBJ.classList.contains("line-letter")) {
        for (let letter of wordOBJ.childNodes) {
          if (!letter.classList.contains("selected"))
            letter.classList.add("selected");
        }
      } else {
        if (!wordOBJ.classList.contains("selected"))
          wordOBJ.classList.add("selected");
      }

      this.refreshStartEndSelect();
      this.refreshContaisSelected();
    };

    this.selectLine = (index) => {
      const lineOBJ = getElements(".line")[index - 1];

      const words = lineOBJ.childNodes;

      for (let word of words) {
        this.selectWord(word);
      }
    };

    this.mouseDown = () => {
      if (new Date().getTime() - this.lastClickTime > 300) this.unSelectAll();
      this.isMouseDown = true;
    };
    this.mouseUp = () => {
      this.isMouseDown = false;
      this.mouseClick()
    };

    this.refreshContaisSelected = () => {
      this.containsSelected = "";
      let elements = getElements(".selected");

      for (let el of elements) {
        const cl = el.classList;
        if (cl.contains("line-letter")) {
          this.containsSelected += el.innerText;
        }
      }
    };
    this.refreshStartEndSelect = () => {
      let lines = getElements(".line");

      for (var i = 0; i < lines.length; i++) {
        let lineOBJ = lines[i].querySelectorAll(".selected");
        let oldLineOBJ = lines[i - 1].querySelectorAll(".selected");
        let nextLineOBJ = lines[i + 1].querySelectorAll(".selected");
        let line = this.editor.lineController.lines[i];
        let oldLine = this.editor.lineController.lines[i - 1];
        let nextLine = this.editor.lineController.lines[i + 1];
        for (var a = 0; a < lineOBJ.length; a++) {
          let letter = lineOBJ[a];
          if (letter.classList.contains("selected-start-bottom")) letter.classList.remove("selected-start-bottom");
          if (letter.classList.contains("selected-start-top")) letter.classList.remove("selected-start-top");
          if (letter.classList.contains("selected-end-bottom")) letter.classList.remove("selected-end-bottom");
          if (letter.classList.contains("selected-end-top")) letter.classList.remove("selected-end-top");
          
          if (a === 0) {
            if (nextLine == undefined || nextLine.length == 0) letter.classList.add("selected-start-bottom");
            if (oldLine == undefined || oldLine.length == 0) letter.classList.add("selected-start-top");
          }
          if (a === lineOBJ.length - 1) {
            if (nextLine == undefined || nextLine.length < line.length) letter.classList.add("selected-end-bottom");
            if (oldLine == undefined || oldLine.length < line.length) letter.classList.add("selected-end-top");
          }
        }
      }
    };
    this.cursorMove = (event) => {
      if (this.isMouseDown) {
        let letter = this.editor.lineController.getLetterOBJ(event.detail.row, event.detail.column);
        if (letter == undefined || letter == null) return;
        if (letter.classList.contains("selected"))
          letter.classList.remove("selected");
        else letter.classList.add("selected");

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
        this.selectLine(this.editor.cursor.row);
      } else if (this.clickCount >= 4) {
        this.selectAll();
      }
    };
    addEvent("mousedown", this.mouseDown, this.editor.output);
    addEvent("mouseup", this.mouseUp, document);
    addEvent("cursormove", this.cursorMove, this.editor.output);
    addEvent("mousemove", this.mouseMove, this.editor.output);
  }
}
