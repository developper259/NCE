class BottomBar {
  constructor(e) {
    this.editor = e;

    this.scrollersValue = {
      "code-type": {
        instance: this.editor.Clangague,
      },
      "config-space": {
        instance: this.editor.Cconfig_space,
      },
    };

    this.cursorOBJ = getElement(".bottomBar-cursorPos");
    this.scrollers = getElements(".scroller-open");

    addEvent("onEvent", this.refresh.bind(this), this.editor.output);
  }

  refresh() {
    if (!this.editor.fileManager.activeFile) return;

    let leftBottomBar = getElement(".bottomBar .left");
    let middleBottomBar = getElement(".bottomBar .middle");
    let rightBottomBar = getElement(".bottomBar .right");

    leftBottomBar.style.display = "flex";
    middleBottomBar.style.display = "flex";
    rightBottomBar.style.display = "flex";

    this.refreshCursorOBJ();

    for (let key in this.scrollersValue) {
      let instance = this.scrollersValue[key].instance;
      instance.refresh();
    }

    for (let scroller of this.scrollers) {
      let instance = this.scrollersValue[scroller.id].instance;
      let title = scroller.childNodes[1];
      title.innerText = instance.values[instance.value];
      scroller.addEventListener("click", instance.active);
    }
  }

  refreshCursorOBJ() {
    if (!this.editor.fileManager.activeFile) return;
    this.editor.selectController.refreshStartEndSelect();

    let r = "";
    let countLine = this.editor.selectController.getNumberLineSelected();

    if (!countLine) {
      r = `Line ${this.editor.cursor.row}, Column ${this.editor.cursor.column}`;
    } else {
      if (countLine > 1) r += countLine + " lines, ";
      r +=
        this.editor.selectController.containsSelected.length +
        " characters selected";
    }

    this.cursorOBJ.innerText = r;
  }
}
