class BottomBar {
  constructor(e) {
    this.editor = e;

    this.cursorOBJ = getElement(".bottomBar-cursorPos");
    this.configSpaceElement = getElement("#config-space");

    this.refreshScrollers();
  }

  openConfigSpace() {
    const current = Number(CONFIG_GET("tab_width"));
    const items = Array.from({ length: 8 }, (_, index) => {
      const value = index + 1;
      return {
        id: String(value),
        label: `Spaces: ${value}`,
        data: value,
      };
    });

    this.editor.quickPanel.open({
      id: "config-space",
      mode: "pick",
      title: "Select Tab Size",
      placeholder: "Select Tab Size",
      selectedId: String(current),
      items,
      onAccept: (item) => {
        CONFIG_SET("tab_width", item.data);
        this.refreshScrollers();
        this.editor.lineController.refreshTabWidth();
      },
    });
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
      r = `Line ${this.editor.cursorController.row}, Column ${this.editor.cursorController.column}`;
    } else {
      if (countLine > 1) r += countLine + " lines, ";
      r +=
        this.editor.selectController.containsSelected.length +
        " characters selected";
    }

    this.cursorOBJ.innerText = r;
  }

  refreshScrollers() {
    if (!this.configSpaceElement) return;
    const title = this.configSpaceElement.querySelector(".scroller-title");
    if (title) title.innerText = `Spaces: ${CONFIG_GET("tab_width")}`;
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
