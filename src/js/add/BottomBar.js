class BottomBar {
  constructor(e) {
    this.editor = e;

    this.line = 0;
    this.column = 0;
    this.scrollersValue = {
      "code-type": {
        instance: this.editor.Clangague,
      },
    };

    this.cursorOBJ = getElement(".bottomBar-cursorPos");
    this.scrollers = getElements(".scroller-open");

    this.refresh = () => {
      this.cursorOBJ.innerText = `Line ${this.line}, Column ${this.column}`;

      for (let scroller of this.scrollers) {
        let instance = this.scrollersValue[scroller.id].instance;
        scroller.innerText = instance.values[instance.value];
        scroller.addEventListener("click", instance.active);
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
