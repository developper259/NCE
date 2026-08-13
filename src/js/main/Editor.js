class Editor {
  constructor() {
    this.isOnInit = true;
    this.isOnRefresh = false;

    this.mainSection = getElement(".main-section");
    this.output = getElement(".editor-output");
    this.editorOBJ = getElement(".editor");
    this.emptyMenuOBJ = getElement(".empty-menu");
    this.fileManagerOBJ = getElement(".file-manager");
    this.cD = getElement(".editor-caret");

    this.selected = false;
    this.isActive = false;
    this.panel = undefined;

    this.baseX = 50; // left margin
    this.baseY = 2; // top margin
    this.posY = 23; // size of a line
    this.letterSize = 10.8; // size of leter     (fs : 20 -> 12, fs : 18 -> 10.8)

    this.api = window.api;

    this.emptyMenu = new EmptyMenu(this);

    this.tabManager = new tabManager(this);
    this.scrollerManager = new ScrollerManager(this);
    this.sidebarManager = new SidebarManager(this);
    this.threadManager = new ThreadManager();
    this.fileLoader = new FileLoader(this);
    this.statesManager = new StatesManager(this);
    this.threadManager = new ThreadManager();
    this.contextMenuManager = new ContextMenuManager();

    this.fileExplorer = new FileExplorer(this);
    this.searchSidebar = new SearchSidebar(this);
    this.sidebarManager.registerMenu(this.fileExplorer);
    this.sidebarManager.registerMenu(this.searchSidebar);

    this.writerController = new WriterController(this);
    this.lineController = new LineController(this);
    this.selectController = new SelectController(this);
    this.cursorController = new CursorController(this);
    this.keyBindingController = new keyBindingController(this);
    this.highlightController = new HighlightController(this);
    this.searchController = new SearchController(this);

    this.events = new Events(this);
    this.keyBinding = new KeyBinding(this);

    this.command = new Command(this);
    this.Ccmd = new CMD(this);
    this.Cconfig_space = new Config_space(this);
    this.savePopupManager = new SavePopupManager(this, this.tabManager);
    this.bottomBar = new BottomBar(this);
    this.sidebarResizer = new SidebarResizer(this);

    this.writerController.insertMode = true;

    this.initQuitEvent();
    this.initLoadState();
  }

  refreshAll() {
    this.isOnRefresh = true;

    this.emptyMenu.refresh();
    this.tabManager.refresh();
    this.cursorController.updateCaretPosition();
    this.lineController.refresh(true);
    this.lineController.restoreScroll();
    this.scrollerManager.refreshAll();
    this.bottomBar.refresh();
    this.sidebarManager.refreshAll();

    this.isOnRefresh = false;
  }

  hideAll() {
    this.mainSection.style.display = "none";
  }

  showAll() {
    this.mainSection.style.display = "block";
  }

  reset() {
    this.isActive = false;
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
    this.isActive = true;
    if (this.editorOBJ.classList.contains("editor-empty")) {
      this.editorOBJ.classList.remove("editor-empty");
    }
    if (!this.selected) {
      this.setSelected(true);
    }

    if (this.tabManager) this.tabManager.show();

    if (this.lineController) {
      if (!this.lineController.isSized()) this.lineController.resize();
      this.lineController.show();
    }
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
      this.cursorController.disable();
    }
  }

  setSelected(selected) {
    if (this.selected == selected) return;

    this.selected = selected;
    if (selected) this.events.callEvent(Events.CURSOR_ENABLED);
    else this.events.callEvent(Events.CURSOR_DISABLED);
  }

  updateBaseX(forcedWidth) {
    if (forcedWidth !== undefined) {
      this.baseX = forcedWidth + 10;
    } else {
      const lineNumbers = document.querySelector(".line-numbers");
      if (!lineNumbers) return;
      this.baseX = lineNumbers.offsetWidth + 10;
    }

    this.output.style.left = `${this.baseX}px`;
    this.output.style.width = `calc(100% - ${this.baseX}px)`;
  }

  initQuitEvent() {
    this.api.onSaveRequest(() => {
      this.statesManager.save();
    });
  }

  initLoadState() {
    let loaded = false;
    const apply = async (state) => {
      if (!state || loaded) {
        if (this.isOnInit)
          this.events.callEvent(Events.ON_LOADED, {
            isStateLoaded: false,
          });
        this.reset();
        return;
      }
      loaded = true;
      await this.statesManager.loadStates(state);
      if (this.isOnInit)
        this.events.callEvent(Events.ON_LOADED, {
          isStateLoaded: true,
        });
    };

    this.api.onLoadState(apply);
    this.api.loadEditorState().then(apply);
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
