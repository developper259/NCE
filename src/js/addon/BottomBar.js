class BottomBar {
  constructor(e) {
    this.editor = e;

    this.cursorOBJ = getElement(".bottomBar-cursorPos");
    this.cursorStatusElement = getElement(".bottomBar-cursor-status");
    this.languageElement = getElement("#language");
    this.configSpaceElement = getElement("#config-space");

    this.refreshLanguage();
    this.refreshScrollers();
  }

  async openLanguage() {
    const file = this.editor.tabManager.activeFile;
    if (!file) return;

    const languages =
      await this.editor.highlightController.getSupportedLanguage();
    const items = (Array.isArray(languages) ? languages : [])
      .filter((language) => typeof language === "string" && language.length > 0)
      .map((language) => ({
        id: language.toLowerCase(),
        label: language,
        data: language,
      }));

    this.editor.quickPanel.open({
      id: "language",
      mode: "pick",
      title: "Select Language",
      placeholder: "Select Language",
      selectedId: String(file.language || "Plaintext").toLowerCase(),
      items,
      onAccept: (item) => {
        file.language = item.data;
        this.refreshLanguage();
        this.editor.highlightController.reset();
      },
    });
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
        this.editor.lineController.refresh(true);
      },
    });
  }

  refresh() {
    if (!this.editor.tabManager.activeFile) return;

    this.refreshCursorOBJ();
    this.refreshLanguage();
    this.refreshScrollers();
  }

  refreshCursorOBJ() {
    if (!this.editor.tabManager.activeFile) return;

    if (this.editor.tabManager.activeFile.loadError) {
      this.cursorOBJ.innerText = "";
      this.cursorStatusElement.style.display = "none";
      return;
    }

    this.cursorStatusElement.style.display = "";

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

  refreshLanguage() {
    if (!this.languageElement) return;
    const title = this.languageElement.querySelector(".scroller-title");
    const language = this.editor.tabManager.activeFile?.language || "Plaintext";
    if (title) title.innerText = language;
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
