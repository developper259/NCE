class BottomBar {
  constructor(e) {
    this.editor = e;

    this.line = 0;
    this.column = 0;

    this.scrollersValue = {
      "code-type": {
        value: 0,
        values: ["Plain-Text", "HTML", "CSS", "JavaScript"],
      },
    };

    this.cursorOBJ = getElement(".bottomBar-cursorPos");
    this.scrollers = getElements(".scroller-open");

    this.refresh = () => {
      this.cursorOBJ.innerText = `Line ${this.line}, Column ${this.column}`;

      for (let scroller of this.scrollers) {
        let table = this.scrollersValue[scroller.id];
        scroller.innerText = table.values[table.value];
      }
    };

    this.cursorChange = (e) => {
      this.line = e.detail.row;
      this.column = e.detail.column + 1;
      this.refresh();
    };

    addEvent("cursorchange", this.cursorChange, this.editor.output);
  }
}
