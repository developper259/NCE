class SelectController {
  constructor(e) {
    this.editor = e;
    this.isMouseDown = false;
    this.containsSelected = "";

    this.lastClick = 0;
    this.clickCount = 0;

    this.unSelectAll = () => {
      let elements = this.editor.output.querySelectorAll(".selected");
      for (let el of elements) {
        el.classList.remove("selected");
      }
      this.containsSelected = "";
    };

    this.selectAll = () => {
      let elements = this.editor.output.querySelectorAll(".line-letter");
      for (let el of elements) {
        if (!el.classList.contains("selected")) el.classList.add("selected");
      }
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
    };

    this.selectLine = (index) => {
      const lineOBJ = this.editor.output.querySelectorAll(".line")[index - 1];

      const words = lineOBJ.childNodes;

      for (let word of words) {
        this.selectWord(word);
      }
    };

    this.mouseDown = () => {
      if (this.clickCount != 1) return;
      this.isMouseDown = true;
    };
    this.mouseUp = () => {
      this.isMouseDown = false;
    };

    this.refreshContaisSelected = () => {
      this.containsSelected = "";
      let elements = this.editor.output.querySelectorAll(".selected");

      for (let el of elements) {
        const cl = el.classList;
        if (cl.contains("line-letter")) {
          this.containsSelected += el.innerText;
        }
      }
    };
    this.cursorMove = (event) => {
      if (this.isMouseDown) {
        let cursor = this.editor.cursor;
        let letter = cursor.getLetterOBJ(event.detail.row, event.detail.column);
        if (letter == undefined || letter == null) return;
        if (letter.classList.contains("selected"))
          letter.classList.remove("selected");
        else letter.classList.add("selected");

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
        this.unSelectAll();
        this.clickCount = 1;
      }
      this.lastClickTime = currentTime;
    };
    this.mouseClick = (event) => {
      this.calcClick();

      if (this.clickCount == 2) {
        const word = this.editor.cursor.getWordOBJ(
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
    addEvent("click", this.mouseClick, this.editor.output);
  }
}
