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

    this.initButton();
  }

  initButton() {
    for (let scroller of this.scrollers) {
      const instance = this.scrollersValue[scroller.id].instance;
      instance.refresh();

      let title = scroller.childNodes[1];
      title.innerText = instance.values[instance.value];
    }
  }

  refresh() {
    if (!this.editor.tabManager.activeFile) return;

    this.refreshCursorOBJ();
    this.refreshScrollers();
  }

  refreshCursorOBJ() {
    if (!this.editor.tabManager.activeFile) return;

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

  refreshScrollers() {
    for (let scroller of this.scrollers) {
      let instance = this.scrollersValue[scroller.id].instance;
      let title = scroller.childNodes[1];
      title.innerText = instance.values[instance.value];
    }
  }

  hide() {
    const leftBottomBar = getElement(".bottomBar .left");
    const middleBottomBar = getElement(".bottomBar .middle");
    const rightBottomBar = getElement(".bottomBar .right");

    leftBottomBar.style.display = "none";
    middleBottomBar.style.display = "none";
    rightBottomBar.style.display = "none";
  }

  show() {
    const leftBottomBar = getElement(".bottomBar .left");
    const middleBottomBar = getElement(".bottomBar .middle");
    const rightBottomBar = getElement(".bottomBar .right");

    leftBottomBar.style.display = "flex";
    middleBottomBar.style.display = "flex";
    rightBottomBar.style.display = "flex";
  }
}
