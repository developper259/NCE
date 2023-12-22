const baseX = 39;
const baseY = 2;
const posY = 25;

class lineController {
  constructor(e) {
    this.lines = ['var   hello="bonjour les copains!!"', "2*8", "3", "4"];
    this.maxIndex = 0;
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

    this.addLine = () => {
      this.maxIndex += 1;
    };

    this.supLine = (index) => {
      if (index > this.maxIndex) return;
      this.maxIndex -= 1;
    };

    this.replaceLines = () => {
      let parser = new DOMParser();
      const lines = document.querySelectorAll(".editor-output .line");

      if (this.lines.length != this.maxIndex) this.maxIndex = this.lines.length;

      if (lines.length != this.lines.length) {
        this.editor.output.innerHTML = "";
        for (var i = 0; i < this.lines.length; i++) {
          let doc = parser.parseFromString(
            this.editor.writerController.toHTML(this.lines[i]),
            "text/html"
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
      }
      if (this.lines.length == 0)
        this.editor.output.innerHTML = '<div class="line editor-select"></div>';
    };

    this.replaceNumberLines = () => {
      const lineN = document.querySelector(".line-numbers");
      let linesN = lineN.querySelectorAll(".line-el");

      if (this.maxIndex == 0) this.maxIndex = this.lines.length;

      if (this.maxIndex == 0) this.maxIndex = 1;
      if (this.maxIndex != linesN.length) {
        lineN.innerHTML = Array.from(
          { length: this.maxIndex },
          (_, index) => `<span class="line-el">${index + 1}</span>`
        ).join("");

        linesN = lineN.querySelectorAll(".line-el");

        for (var i = 0; i < linesN.length; i++) {
          const line = linesN[i];

          const y = baseY + posY * i;
          line.style.top = y + "px";
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
      const l = this.editor.output.querySelectorAll(".line")[row - 1];
      const words = l.querySelectorAll(".line-word");
      return words[column];
    };

    this.getLetterOBJ = (row, column) => {
      if (row == null || column == null) return;
      const l = this.editor.output.querySelectorAll(".line")[row - 1];
      const letters = l.querySelectorAll(".line-letter");
      return letters[column];
    }

    addInterval(() => {
      this.replaceLines();
      this.replaceNumberLines();
    }, 100);
  }
}
