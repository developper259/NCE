const baseX = 39;
const baseY = 2;
const posY = 25;

class lineController {
  constructor(e) {
    this.lines = [
      'var   hello="bonjour les copains!!"',
      "2*8viurhviuruevoeubvebveuvbeurbveubv",
      "3vkiejoiejierhi",
      "3vkiejoiejierhiurh",
      "4444",
    ];
    this.maxIndex = this.lines.length;
    this.index = 0;
    this.editor = e;

    this.getIndex = () => {
      return this.index;
    };
    this.setIndex = (i) => {
      this.index = i;
    };

    this.setFocusLine = (index) => {
      const oldLine = document.querySelector(".line-selected");

      if (oldLine != null) oldLine.classList.remove("line-selected");

      const newLine = this.getLineNumberOBJ(index - 1);

      if (newLine == null) return;

      newLine.classList.add("line-selected");
      this.setIndex(index);
    };

    this.addLine = (txt, index) => {
      this.lines = [
                    ...this.lines.slice(0, index),
                    txt,
                    ...this.lines.slice(index)
                   ];
      this.refresh();
    };

    this.changeLine = (txt, index) => {
      this.lines[index] = txt;
      this.refresh();
    }

    this.supLine = (index) => {
      if (index > this.maxIndex) return;
      this.maxIndex -= 1;
      this.lines.splice(index, 1);
      this.refresh();
    };

    this.refreshLine = () => {
      let parser = new DOMParser();
      const lines = document.querySelectorAll(".editor-output .line");

      if (this.lines.length != this.maxIndex) this.maxIndex = this.lines.length;

        this.editor.output.innerHTML = "";
        for (var i = 0; i < this.lines.length; i++) {
          let doc = parser.parseFromString(
            this.editor.writerController.toHTML(this.lines[i]),
            "text/html",
          );
          let lineOBJ = doc
            .createRange()
            .createContextualFragment(doc.body.innerHTML).firstElementChild;

          this.editor.output.appendChild(lineOBJ);

          const x = baseX;
          const y = baseY + posY * i;

          lineOBJ.style.position = "absolute";
          lineOBJ.style.top = y + "px";
          lineOBJ.style.left = x + "px";
        }
      if (this.lines.length == 0)
        this.editor.output.innerHTML = '<div class="line editor-select"></div>';
    };

    this.refreshNumberLines = () => {
      const lineN = document.querySelector(".line-numbers");
      let linesN = lineN.querySelectorAll(".line-el");

      if (this.maxIndex == 0) this.maxIndex = this.lines.length;

      if (this.maxIndex == 0) this.maxIndex = 1;
      if (this.maxIndex != linesN.length) {
        lineN.innerHTML = Array.from(
          { length: this.maxIndex },
          (_, index) => `<span class="line-el editor-el">${index + 1}</span>`,
        ).join("");

        linesN = lineN.querySelectorAll(".line-el");

        for (let i = 0; i < linesN.length; i++) {
          const line = linesN[i];

          const y = baseY + posY * i;
          line.style.top = y + "px";

          line.addEventListener("click", (event) => {
            let lineOBJ = this.editor.selectController.getSelectOBJLine(i);
            this.editor.selectController.unSelectAll();

            if (lineOBJ == undefined) this.editor.selectController.selectLine(i);
            else this.editor.cursor.setCursorPosition(i + 1, 0);
          });
        }
      }
    };

    this.getLineOBJ = (index) => {
      const lines = document.querySelectorAll(".editor-output .line");
      return lines[index];
    };

    this.getLineNumberOBJ = (index) => {
      const lines = document.querySelectorAll(".line-el");
      return lines[index];
    };

    this.getWordOBJ = (row, column) => {
      if (row == null || column == null) return;
      const l = getElements(".line")[row - 1];
      const words = l.querySelectorAll(".line-word");
      return words[column];
    };

    this.getLetterOBJ = (row, column) => {
      if (row == null || column == null) return;
      const l = getElements(".line")[row - 1];
      const letters = l.querySelectorAll(".line-letter");
      return letters[column];
    };

    this.refresh = () => {
      this.refreshLine();
      this.refreshNumberLines();
    };

    this.refresh();
  }
}
