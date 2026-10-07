class Editor {
  constructor() {
    this.isOnInit = true;
    this.isOnRefresh = false;
    this.isButtonChangePosition = false;
    this.autoSaveEnabled = SETTINGS_GET("files.autoSave") === true;

    this.domManager = new DOMManager(this);

    this.mainSection = this.domManager.getElement(".main-section");
    this.editorOBJ = this.domManager.getElement(".editor");
    this.themeManager = new ThemeManager(this);
    this.themeManager.init();
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
    this.contextMenuManager.setMenu("output", buildOutputContextMenu(this));
    this.contextMenuManager.setMenu("input", buildInputContextMenu(this));
    this.contextMenuManager.setMenu(
      "empty-menu",
      buildEmptyMenuContextMenu(this),
    );
    this.quickPanel = new QuickPanel(this);
    this.quickOpen = new QuickOpen(this);
    this.goToLine = new GoToLine(this);

    this.agent = null;

    this.fileExplorer = new FileExplorer(this);
    this.searchSidebar = new SearchSidebar(this);
    this.agentSidebar = new LazyAgentSidebar(this);

    this.sidebarManager.registerMenu(this.fileExplorer);
    this.sidebarManager.registerMenu(this.searchSidebar);
    this.sidebarManager.registerMenu(this.agentSidebar);
    this.contextMenuManager.setMenu(
      "sidebar-selector-empty",
      buildSidebarSelectorEmptyContextMenu(this.sidebarManager),
    );
    this.contextMenuManager.setMenu(
      "sidebar-selector-icon",
      buildSidebarSelectorIconContextMenu(this.sidebarManager),
    );
    this.contextMenuManager.setMenu(
      "sidebar-title",
      buildSidebarTitleContextMenu(this.sidebarManager),
    );

    this.writerController = new WriterController(this);
    this.historyController = new HistoryController(this);
    this.lineController = new LineController(this);
    this.selectController = new SelectController(this);
    this.cursorController = new CursorController(this);
    this.highlightController = new HighlightController(this);
    this.searchController = new SearchController(this);
    this.smartTypingController = new SmartTypingController(this);

    this.events = new Events(this);
    this.events.init();
    this.keyBinding = new KeyBinding(this);
    this.savePopupManager = new SavePopup(this, this.tabManager);
    this.bottomBar = new BottomBar(this);
    this.titleBar = new TitleBar(this);
    this.sidebarResizer = new SidebarResizer(this);
    this._settingsView = null;
    this._pictureView = null;
    this._markdownView = null;

    this.writerController.insertMode = true;

    this.domManager.init();
    this.tabManager.initScroller();
    if (this.lineController) {
      this.lineController.syncDimensions();
    }

    this.initQuitEvent();
    this.api.onAutoSaveToggleRequested?.(() => this.toggleAutoSave());
    this.api.onOpenSettingsRequested?.(() => this.openSettings());
    this.api.onKeybindingActionRequested?.((action, modifiers) =>
      this.keyBindingManager.executeAction(action, modifiers),
    );
    this.api.onOpenRecentFolderRequested?.((folderPath) =>
      this.openRecentFolder(folderPath),
    );
    this.api.onRecentFoldersChanged?.((folders) =>
      this.titleBar?.setRecentFolders(folders),
    );
    this.api.onSettingsChanged?.((settings) =>
      this.applySettingsSnapshot(settings),
    );
    this.initLoadState();
    this.api.rendererReady?.().catch?.((error) => {
      console.error("[Startup] rendererReady failed", error);
    });
  }

  refreshAll({ renderSidebarContent = true } = {}) {
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
    if (typeof this.scrollerManager.refreshActive === "function") {
      this.scrollerManager.refreshActive();
    } else {
      this.scrollerManager.refreshAll();
    }
    this.bottomBar.refresh();
    this.sidebarManager.refreshAll({
      renderActiveMenu: renderSidebarContent,
    });

    this.isOnRefresh = false;
  }

  commitStartupState() {
    this.isOnRefresh = true;
    this.tabManager.refresh();
    this.refreshMainContent();

    if (!this.tabManager.activeFile) {
      this.isOnRefresh = false;
      return;
    }

    this.cursorController.updateCaretPosition();
    this.lineController.refresh(true);
    this.lineController.restoreScroll();
    this.scrollerManager.refreshAll();
    this.isOnRefresh = false;
  }

  getAutoSaveState() {
    return this.autoSaveEnabled === true;
  }

  setAutoSaveState(enabled, { persist = true } = {}) {
    const previousState = this.autoSaveEnabled === true;
    this.autoSaveEnabled = enabled === true;
    this.titleBar?.refreshAutoSaveState?.();
    if (previousState !== this.autoSaveEnabled) {
      if (typeof this.tabManager?.refreshTabStates === "function") {
        this.tabManager.refreshTabStates();
      } else {
        this.tabManager?.refresh?.();
      }
      if (typeof this.titleBar?.refreshDocumentTitle === "function") {
        this.titleBar.refreshDocumentTitle();
      } else {
        this.titleBar?.refresh?.();
      }
    }
    if (persist) {
      const synchronization = SETTINGS_SET(
        "files.autoSave",
        this.autoSaveEnabled,
      );
      synchronization?.catch?.((error) =>
        console.error("[Auto Save] menu synchronization failed", error),
      );
    }
    this._settingsView?.sync("files.autoSave");
    return this.autoSaveEnabled;
  }

  toggleAutoSave() {
    return this.setAutoSaveState(!this.getAutoSaveState());
  }

  applySettingsSnapshot(settings) {
    SETTINGS_INITIALIZE(settings);
    this.setAutoSaveState(SETTINGS_GET("files.autoSave"), { persist: false });
    this.themeManager?.syncFromSettings?.(SETTINGS_GET("appearance.theme"));
    this.agentSidebar?.refreshModelSelector?.();
    this._settingsView?.sync?.("agent.hiddenModels");
    void this.refreshSettingsJsonTab();
  }

  async refreshSettingsJsonTab() {
    const settingsPath = await this.api.getSettingsPath?.();
    if (!settingsPath) return;
    await this.tabManager.reloadFileFromDisk(settingsPath);
  }

  async openSettings(category) {
    const tab = await this.tabManager.openSettings();
    if (category) this.getSettingsView().openCategory(category);
    return tab;
  }

  getSettingsView() {
    if (!this._settingsView) this._settingsView = new SettingsView(this);
    return this._settingsView;
  }

  getPictureView() {
    if (!this._pictureView) this._pictureView = new PictureView(this);
    return this._pictureView;
  }

  getMarkdownView() {
    if (!this._markdownView) this._markdownView = new MarkdownView(this);
    return this._markdownView;
  }

  async ensureAgentSidebar() {
    await ensureAgentBundle();
    if (this.agentSidebar instanceof AgentSidebar) return this.agentSidebar;

    const lazySidebar = this.agentSidebar;
    const sidebar = new AgentSidebar(this);
    const wasOpen = lazySidebar?.isOpen === true;
    this.agentSidebar = sidebar;
    this.sidebarManager.registerMenu(sidebar);
    if (this.sidebarManager.leftActiveMenu === lazySidebar)
      this.sidebarManager.leftActiveMenu = sidebar;
    if (this.sidebarManager.rightActiveMenu === lazySidebar)
      this.sidebarManager.rightActiveMenu = sidebar;
    if (this.sidebarManager.activeMenu === lazySidebar)
      this.sidebarManager.activeMenu = sidebar;

    if (lazySidebar?.pendingConfigState)
      await sidebar.loadConfigState(lazySidebar.pendingConfigState);
    if (lazySidebar?.pendingScrollState) sidebar.restoreScrollState();
    if (wasOpen) {
      sidebar.open();
      this.sidebarManager.renderMenuContent(sidebar);
    }
    this.sidebarManager.renderTabSelector();
    return sidebar;
  }

  ensureAgent() {
    if (!this.agent) {
      if (typeof Agent === "undefined") {
        throw new Error("Load the Agent feature bundle before creating Agent");
      }
      this.agent = new Agent(this);
    }
    return this.agent;
  }

  destroy() {
    this.quickPanel?.destroy?.();
    this.fileExplorer?.destroy?.();
    this.searchSidebar?.destroy?.();
    this.agentSidebar?.destroy?.();
    this._settingsView?.destroy?.();
    this._pictureView?.destroy?.();
    this._markdownView?.destroy?.();
    this.tabManager?.destroy?.();
    this.sidebarManager?.destroy?.();
    this.lineController?.outputScroller?.destroy?.();
    this.scrollerManager?.destroyAll?.();
    this.domManager?.destroy?.();
  }

  async openSettingsJson() {
    const settingsPath = await this.api.getSettingsPath?.();
    if (!settingsPath) return null;
    return this.tabManager.openFileWithPath(settingsPath);
  }

  openRecentFolder(folderPath) {
    return this.fileExplorer.openRecentFolder(folderPath);
  }

  clearRecentFolders() {
    return this.api.clearRecentFolders();
  }

  refreshMainContent() {
    const type = this.tabManager.activeTab?.type;
    const settingsActive = type === TAB_TYPES.SETTINGS;
    const pictureActive = type === TAB_TYPES.PICTURE;
    const markdownActive = type === TAB_TYPES.MARKDOWN;
    this.editorOBJ.classList.toggle("editor-settings-active", settingsActive);
    this.editorOBJ.classList.toggle("editor-picture-active", pictureActive);
    this.editorOBJ.classList.toggle("editor-markdown-active", markdownActive);
    if (settingsActive) {
      this.getSettingsView().show();
      this._pictureView?.hide();
      this._markdownView?.hide();
      this.bottomBar?.hide();
      this.cursorController?.disable();
      this.setSelected(false);
    } else if (pictureActive) {
      this._settingsView?.hide();
      this._markdownView?.hide();
      this.getPictureView().show(this.tabManager.activeTab);
      this.bottomBar?.showImagePreview();
      this.cursorController?.disable();
      this.setSelected(false);
    } else if (markdownActive) {
      this._settingsView?.hide();
      this._pictureView?.hide();
      const activeTab = this.tabManager.activeTab;
      if (typeof MarkdownView !== "undefined") {
        this.getMarkdownView().show(activeTab);
      } else {
        void ensureMarkdownBundle().then(() => {
          if (this.tabManager.activeTab?.type === TAB_TYPES.MARKDOWN)
            this.getMarkdownView().show(this.tabManager.activeTab);
        }).catch((error) => console.error("Failed to load Markdown feature:", error));
      }
      this.bottomBar?.showMarkdownPreview();
      this.cursorController?.disable();
      this.setSelected(false);
    } else {
      this._settingsView?.hide();
      this._pictureView?.hide();
      this._markdownView?.hide();
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
        await Promise.race([
          this.agentSidebar?.flushAllConversationSaves?.(),
          new Promise((resolve) => setTimeout(resolve, 1800)),
        ]);
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
      if (loaded) return;
      if (!state) {
        if (this.isOnInit)
          this.events.callEvent(Events.ON_LOADED, {
            isStateLoaded: false,
          });
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
