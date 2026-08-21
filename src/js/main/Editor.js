class Editor {
  constructor() {
    this.isOnInit = true;
    this.isOnRefresh = false;
    this.isButtonChangePosition = false;

    this.domManager = new DOMManager(this);

    this.mainSection = this.domManager.getElement(".main-section");
    this.output = this.domManager.getElement(".editor-output");
    this.editorOBJ = this.domManager.getElement(".editor");
    this.emptyMenuOBJ = this.domManager.getElement(".empty-menu");
    this.fileManagerOBJ = this.domManager.getElement(".file-manager");
    this.cD = this.domManager.getElement(".editor-caret");

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
    this.keyBindingManager = new KeyBindingManager(this);
    this.scrollerManager = new ScrollerManager(this);
    this.sidebarManager = new SidebarManager(this);
    this.threadManager = new ThreadManager();
    this.fileLoader = new FileLoader(this);
    this.statesManager = new StatesManager(this);
    this.threadManager = new ThreadManager();
    this.contextMenuManager = new ContextMenuManager();

    this.fileExplorer = new FileExplorer(this);
    this.searchSidebar = new SearchSidebar(this);
    this.agentSidebar = new AgentSidebar(this);

    this.sidebarManager.registerMenu(this.fileExplorer);
    this.sidebarManager.registerMenu(this.searchSidebar);
    this.sidebarManager.registerMenu(this.agentSidebar);

    this.writerController = new WriterController(this);
    this.lineController = new LineController(this);
    this.selectController = new SelectController(this);
    this.cursorController = new CursorController(this);
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

    this.domManager.init();
    if (this.lineController) {
      this.lineController.syncDimensions();
    }

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

  focusOutput() {

    this.output.focus({
      preventScroll: true,
    });

    this.setSelected(true);
    this.cursorController.enable();
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
      if (!this.isButtonChangePosition) {
        this.cursorController.disable();
      }else{
        this.isButtonChangePosition = false;
      }
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

      if (this.domManager) {
        this.domManager.setLineNumberWidth(forcedWidth);
      }
    } else {
      if (this.domManager) {
        this.baseX = this.domManager.getOutputX();
      }
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
