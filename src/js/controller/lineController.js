const baseX = 39;
const baseY = 2;
const posY = 25;

class lineControler {
  constructor(e) {
    this.lines = [];
    this.lineNumbers = [];
    this.index = 0;
    this.editor = e;

    this.getIndex = () => {
      return this.index;
    };
    this.setIndex = (i) => {
      this.index = i;
    };

    this.changeLine = (index) => {
      const oldLine = document.querySelector(".line-selected");

      if (oldLine != null) oldLine.classList.remove("line-selected");

      this.lineNumbers[index - 1].classList.add("line-selected");
      this.setIndex(index);
    };

    this.addLine = () => {};

    this.replaceLines = () => {
      const lines = document.querySelectorAll(".editor-output .line");

      if (lines.length != this.lines.length) this.lines = lines;

      for (var i = 0; i < lines.length; i++) {
        const line = lines[i];

        const x = baseX;
        const y = baseY + posY * i;

        line.style.position = "absolute";
        line.style.top = y + "px";
        line.style.left = x + "px";
      }
      if (lines.length == 0) {

        this.editor.output.innerHTML = '<div class="line editor-select"></div>';
      }
    };

    this.replaceNumberLines = () => {
      const lineN = document.querySelector(".line-numbers");
      var linesN = lineN.querySelectorAll(".line-el");

      var count = this.lines.length;

      if (count == 0) count = 1;
      if (count != linesN.length) {
        lineN.innerHTML = Array.from(
          { length: count },
          (_, index) => `<span class="line-el">${index + 1}</span>`
        ).join("");

        linesN = lineN.querySelectorAll(".line-el");
        this.lineNumbers = linesN;

        for (var i = 0; i < linesN.length; i++) {
          const line = linesN[i];

          const y = baseY + posY * i;
          line.style.top = y + "px";
        }
      }
    };

    addInterval(() => {
      this.replaceLines();
      this.replaceNumberLines();
    }, 100);
  }
}
