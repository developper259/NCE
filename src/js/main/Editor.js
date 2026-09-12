class Editor {
  constructor() {
    this.isOnInit = true;
    this.isOnRefresh = false;
    this.isButtonChangePosition = false;
    this.autoSaveEnabled = SETTINGS_GET("files.autoSave") === true;

    this.domManager = new DOMManager(this);

    this.mainSection = this.domManager.getElement(".main-section");
    this.editorOBJ = this.domManager.getElement(".editor");
    this.emptyMenuOBJ = this.domManager.getElement(".empty-menu");
    this.fileManagerOBJ = this.domManager.getElement(".file-manager");
    this.cD = this.domManager.getElement(".editor-caret");

    this.output = this.domManager.getElement(".editor-output");
    this.lineNumberOutput = this.domManager.getElement(".line-numbers");
    this.selectOutput = this.domManager.getElement(".editor-select-highlight");
    this.searchOutput = this.domManager.getElement(".editor-search-highlight");

    this.selected = false;
    this.isActive = false;

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
    this.fileLoader = new FileLoader(this);
    this.statesManager = new StatesManager(this);
    this.contextMenuManager = new ContextMenuManager(this);
    this.contextMenuManager.setMenu(
      "tab",
      buildTabContextMenu(this.tabManager),
    );
    this.contextMenuManager.setMenu(
      "output",
      buildOutputContextMenu(this),
    );
    this.quickPanel = new QuickPanel(this);
    this.quickOpen = new QuickOpen(this);
    this.goToLine = new GoToLine(this);

    this.agent = new Agent(this);

    this.fileExplorer = new FileExplorer(this);
    this.searchSidebar = new SearchSidebar(this);
    this.agentSidebar = new AgentSidebar(this);

    this.sidebarManager.registerMenu(this.fileExplorer);
    this.sidebarManager.registerMenu(this.searchSidebar);
    this.sidebarManager.registerMenu(this.agentSidebar);

    this.writerController = new WriterController(this);
    this.historyController = new HistoryController(this);
    this.lineController = new LineController(this);
    this.selectController = new SelectController(this);
    this.cursorController = new CursorController(this);
    this.highlightController = new HighlightController(this);
    this.searchController = new SearchController(this);
    this.smartTypingController = new SmartTypingController(this);

    this.output.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const file = this.tabManager.activeFile;
      const hasSelection =
        this.selectController.hasActiveSelection?.() === true;
      this.contextMenuManager.openContextMenu("output", {
        isFile: Boolean(file),
        file,
        filePath: file?.hasPath?.() ? file.path : "",
        rootPath: this.fileExplorer?.rootPath || "",
        selectedText: hasSelection
          ? String(this.selectController.containsSelected || "")
          : "",
      });
    });

    this.events = new Events(this);
    this.keyBinding = new KeyBinding(this);
    this.savePopupManager = new SavePopup(this, this.tabManager);
    this.bottomBar = new BottomBar(this);
    this.titleBar = new TitleBar(this);
    this.sidebarResizer = new SidebarResizer(this);
    this.settingsView = new SettingsView(this);

    this.writerController.insertMode = true;

    this.domManager.init();
    if (this.lineController) {
      this.lineController.syncDimensions();
    }

    this.initQuitEvent();
    this.api.onAutoSaveToggleRequested?.(() => this.toggleAutoSave());
    this.api.onOpenSettingsRequested?.(() => this.openSettings());
    this.initLoadState();
    this.api.rendererReady?.().catch?.((error) => {
      console.error("[Startup] rendererReady failed", error);
    });
  }

  refreshAll() {
    this.isOnRefresh = true;

    this.emptyMenu.refresh();
    this.tabManager.refresh();
    this.refreshMainContent();
    if (!this.tabManager.activeFile) {
      this.titleBar?.refresh();
      this.isOnRefresh = false;
      return;
    }
    this.cursorController.updateCaretPosition();
    this.lineController.refresh(true);
    this.lineController.restoreScroll();
    this.scrollerManager.refreshAll();
    this.bottomBar.refresh();
    this.sidebarManager.refreshAll();

    this.isOnRefresh = false;
  }

  getAutoSaveState() {
    return this.autoSaveEnabled === true;
  }

  setAutoSaveState(enabled, { persist = true } = {}) {
    this.autoSaveEnabled = enabled === true;
    this.titleBar?.refreshAutoSaveState?.();
    if (persist) {
      const synchronization = SETTINGS_SET(
        "files.autoSave",
        this.autoSaveEnabled,
      );
      synchronization?.catch?.((error) =>
        console.error("[Auto Save] menu synchronization failed", error),
      );
    }
    this.settingsView?.sync("files.autoSave");
    return this.autoSaveEnabled;
  }

  toggleAutoSave() {
    return this.setAutoSaveState(!this.getAutoSaveState());
  }

  openSettings() {
    return this.tabManager.openSettings();
  }

  refreshMainContent() {
    const settingsActive =
      this.tabManager.activeTab?.type === TAB_TYPES.SETTINGS;
    this.editorOBJ.classList.toggle("editor-settings-active", settingsActive);
    if (settingsActive) {
      this.settingsView?.show();
      this.bottomBar?.hide();
      this.cursorController?.disable();
      this.setSelected(false);
    } else {
      this.settingsView?.hide();
      if (this.tabManager.activeFile) this.bottomBar?.show();
    }
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
      this.setSelected(false);
      if (!this.isButtonChangePosition) {
        this.cursorController.disable();
      } else {
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
    this.api.onSaveRequest(async () => {
      try {
        const closed = await this.tabManager.prepareForQuit();
        if (!closed) {
          await this.api.cancelQuit?.();
          return;
        }
        const saved = await this.statesManager.save();
        if (saved !== false) await this.api.approveQuit?.();
        else await this.api.cancelQuit?.();
      } catch (error) {
        console.error("Failed to prepare quit:", error);
        await this.api.cancelQuit?.();
      }
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
    this.api
      .loadEditorState()
      .then(apply)
      .catch((error) => {
        console.error("[Startup] state restore failed", error);
        if (this.isOnInit) {
          this.events.callEvent(Events.ON_LOADED, { isStateLoaded: false });
        }
        this.reset();
      });
  }
}

var editor = null;

document.addEventListener(
  "DOMContentLoaded",
  async (event) => {
    try {
      SETTINGS_INITIALIZE(await window.api.getSettings());
    } catch (error) {
      console.error("[Startup] settings load failed; using defaults", error);
    }
    editor = new Editor();
  },
  window,
);
