class Editor {
  constructor() {
    this.mainSection = getElement(".main-section");
    this.output = getElement(".editor-output");
    this.editorOBJ = getElement(".editor");

    this.hideAll();

    this.selected = false;
    this.panel = undefined;

    this.baseX = 50; // left margin (2 represents the difference left margin)
    this.baseY = 2; // top margin
    this.posY = 23; // size of a line
    this.letterSize = 10.8; // size of leter     (fs : 20 -> 12, fs : 18 -> 10.8)

    this.languages = [new PlainText(this), new Javascript(this)];

    this.api = window.api;

    this.emptyMenu = new EmptyMenu(this);

    this.tabManager = new tabManager(this);
    this.scrollerManager = new ScrollerManager(this);
    this.sidebarManager = new SidebarManager();

    this.fileExplorer = new FileExplorer(this);
    this.sidebarManager.registerMenu(this.fileExplorer);

    this.writerController = new WriterController(this);
    this.lineController = new LineController(this);
    this.selectController = new SelectController(this);
    this.keyBindingController = new keyBindingController(this);
    this.languageController = new LanguageController(this);

    this.events = new Events(this);
    this.keyBinding = new KeyBinding(this);
    this.cursor = new Cursor(this);

    this.command = new Command(this);
    this.Ccmd = new CMD(this);
    this.Clangague = new Langague(this);
    this.Cconfig_space = new Config_space(this);
    this.savePopupManager = new SavePopupManager(this, this.tabManager);
    this.bottomBar = new BottomBar(this);

    this.writerController.insertMode = true;

    this.reset();
    this.showAll();

    this.sidebarManager.openMenu('file-explorer');
  }

  refreshAll() {
    this.emptyMenu.refresh();
    this.scrollerManager.refreshAll();
    this.bottomBar.refresh();
    this.lineController.initLineOutput();
    this.lineController.initNumberLines();
    this.lineController.restoreScroll();
    this.selectController.refreshStartEndSelect();
    this.tabManager.refresh();
    if (this.tabManager.activeFile)
      this.tabManager.activeFile.language.refreshAll();
  }

  hideAll() {
    this.mainSection.style.display = "none";
  }

  showAll() {
    this.mainSection.style.display = "block";
  }

  reset() {
    if (this.emptyMenu) this.emptyMenu.refresh();
    if (this.tabManager) this.tabManager.hide();

    if (this.lineController) this.lineController.hide();
    if (this.bottomBar) this.bottomBar.hide();

    if (!this.editorOBJ.classList.contains("editor-empty")) {
      this.editorOBJ.classList.add("editor-empty");
    }
    if (this.selected) {
      this.setSelected(false);
    }

    if (this.emptyMenu) this.emptyMenu.show();
  }

  reactive() {
    if (this.editorOBJ.classList.contains("editor-empty")) {
      this.editorOBJ.classList.remove("editor-empty");
    }
    if (!this.selected) {
      this.setSelected(true);
    }

    if (this.tabManager) this.tabManager.show();

    if (this.lineController) this.lineController.show();
    if (this.bottomBar) this.bottomBar.show();

    if (this.emptyMenu) this.emptyMenu.hide();
  }

  onClick(e) {
    const t = e.target;
    const c = t.classList;
    if (
      c.contains("editor-select") ||
      c.contains("editor-el") ||
      c.contains("editor")
    ) {
      this.setSelected(true);
    } else {
      if (c.contains("command-el") || c.contains("command-el-title")) return;
      this.setSelected(false);
    }
  }

  setSelected(selected) {
    if (this.selected == selected) return;

    if (selected) this.events.callEvent(Events.CURSOR_ENABLED);
    else this.events.callEvent(Events.CURSOR_DISABLED);
    this.selected = selected;
  }
}

var editor = null;

document.addEventListener(
  "DOMContentLoaded",
  (event) => {
    editor = new Editor();
  },
  window,
);
