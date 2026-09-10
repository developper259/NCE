class StatesManager {
  constructor(editor) {
    this.editor = editor;
  }

  async save() {
    try {
      const currentState = this.getState();
      return await this.editor.api.saveEditorState(
        JSON.stringify(currentState),
      );
    } catch (error) {
      console.error("Failed to serialize editor state:", error);
      return false;
    }
  }

  getState() {
    return {
      tabManager: this.getTabManagerState(),
      sidebar: this.getSidebarState(),
      fileExplorer: this.getFileExplorerState(),
      agent: this.getAgentState(),
    };
  }

  getAgentState() {
    const agentSidebar = this.editor.agentSidebar;
    if (!agentSidebar || typeof agentSidebar.getConfigState !== "function") {
      return null;
    }

    return agentSidebar.getConfigState();
  }

  getTabManagerState() {
    const tabManager = this.editor.tabManager;
    if (!tabManager) return null;

    const tabs = tabManager.tabs.map((tab) =>
      tab.type === TAB_TYPES.SETTINGS
        ? { id: tab.id, type: TAB_TYPES.SETTINGS }
        : {
            id: tab.id,
            type: TAB_TYPES.FILE,
            name: tab.name,
            path: tab.path,

            row: tab.row,
            column: tab.column,

            offsetX: tab.offsetX,
            offsetY: tab.offsetY,
            startIndex: tab.startIndex,
            maxLineLength: tab.maxLineLength,
            totalLines: tab.totalLines,

            startSelect: tab.startSelect,
            endSelect: tab.endSelect,
            selectedLines: tab._selectedLines
              ? Array.from(tab._selectedLines.entries())
              : [],
          },
    );

    return {
      activeTab: tabManager.activeTab
        ? {
            id: tabManager.activeTab.id,
          }
        : null,
      activeFile: tabManager.activeFile
        ? { id: tabManager.activeFile.id }
        : null,
      tabs,
      // Kept for consumers written against the pre-generic tab state shape.
      files: tabs.filter((tab) => tab.type === TAB_TYPES.FILE),
    };
  }

  getSidebarState() {
    const sidebarManager = this.editor.sidebarManager;
    if (!sidebarManager) return null;

    const leftOpen =
      sidebarManager.leftSidebar?.classList.contains("open") || false;
    const rightOpen =
      sidebarManager.rightSidebar?.classList.contains("open") || false;

    return {
      leftOpen,
      rightOpen,
      leftActiveMenu: sidebarManager.leftActiveMenu
        ? {
            id: sidebarManager.leftActiveMenu.id,
            title: sidebarManager.leftActiveMenu.title,
            position: sidebarManager.leftActiveMenu.position,
            isOpen: sidebarManager.leftActiveMenu.isOpen,
          }
        : null,
      rightActiveMenu: sidebarManager.rightActiveMenu
        ? {
            id: sidebarManager.rightActiveMenu.id,
            title: sidebarManager.rightActiveMenu.title,
            position: sidebarManager.rightActiveMenu.position,
            isOpen: sidebarManager.rightActiveMenu.isOpen,
          }
        : null,
      activeMenu: sidebarManager.activeMenu
        ? {
            id: sidebarManager.activeMenu.id,
            title: sidebarManager.activeMenu.title,
            position: sidebarManager.activeMenu.position,
            isOpen: sidebarManager.activeMenu.isOpen,
          }
        : null,
    };
  }

  getFileExplorerState() {
    const fileExplorer = this.editor.fileExplorer;
    if (!fileExplorer) return null;

    const expandedSet = fileExplorer.getExpandedPaths(fileExplorer.files);

    return {
      rootPath: fileExplorer.rootPath,
      projectName: fileExplorer.projectName,
      activeFilePath: fileExplorer.activeFilePath,
      projectExpanded: fileExplorer.projectExpanded,
      expandedPaths: Array.from(expandedSet),
    };
  }

  async loadStates(state) {
    if (!state) return;

    if (state.tabManager) {
      await this.loadTabManagerState(state.tabManager);
    }

    if (state.sidebar) this.loadSidebarState(state.sidebar);

    if (state.fileExplorer) {
      try {
        await this.loadFileExplorerState(state.fileExplorer);
      } catch (error) {
        console.error("Failed to restore File Explorer state:", error);
      }
    }

    if (state.agent) {
      Promise.resolve(
        this.editor.agentSidebar?.loadConfigState?.(state.agent),
      ).catch((error) =>
        console.error("Failed to restore Agent state:", error),
      );
    }
  }

  async loadTabManagerState(tabState) {
    const tabManager = this.editor.tabManager;
    if (!tabManager) return;

    let activeTabToFocus = null;
    const savedTabs = Array.isArray(tabState.tabs)
      ? tabState.tabs
      : Array.isArray(tabState.files)
        ? tabState.files
        : [];
    const savedActiveTab = tabState.activeTab || tabState.activeFile;

    for (const fileData of savedTabs) {
      if (!fileData) continue;
      try {
        if (fileData.type === TAB_TYPES.SETTINGS) {
          const settingsTab = new SettingsTab(fileData.id);
          tabManager.tabs.push(settingsTab);
          if (fileData.id >= tabManager.idCounter)
            tabManager.idCounter = fileData.id;
          if (savedActiveTab?.id === fileData.id)
            activeTabToFocus = settingsTab;
          continue;
        }
        let file = new FileNode(
          this.editor,
          fileData.id,
          fileData.name,
          fileData.path,
        );

        if (fileData.id >= tabManager.idCounter) {
          tabManager.idCounter = fileData.id;
        }

        file.row = fileData.row;
        file.column = fileData.column;

        file.offsetX = fileData.offsetX || 0;
        file.offsetY = fileData.offsetY || 0;
        file.startIndex = fileData.startIndex || 0;
        file.maxLineLength = fileData.maxLineLength || 0;
        file.totalLines = fileData.totalLines || 0;

        file.startSelect = fileData.startSelect;
        file.endSelect = fileData.endSelect;

        if (fileData.selectedLines && Array.isArray(fileData.selectedLines)) {
          file._selectedLines = new Map(fileData.selectedLines);
        } else {
          file._selectedLines = new Map();
        }

        tabManager.tabs.push(file);

        if (savedActiveTab && file.id === savedActiveTab.id) {
          activeTabToFocus = file;
        }
      } catch (error) {
        console.error(
          "Failed to restore tab:",
          fileData.path || fileData.name,
          error,
        );
      }
    }

    if (activeTabToFocus) {
      if (activeTabToFocus.type === TAB_TYPES.FILE) {
        await tabManager.setFocusFile(activeTabToFocus);
      } else {
        await tabManager.setFocusTab(activeTabToFocus);
      }

      if (
        activeTabToFocus.type === TAB_TYPES.FILE &&
        this.editor.selectController &&
        activeTabToFocus._selectedLines.size > 0
      ) {
        this.editor.selectController.refreshContaisSelected();
        this.editor.selectController.refreshSelectionDOM();
      }
    }
  }

  loadSidebarState(sidebarState) {
    const sidebarManager = this.editor.sidebarManager;
    if (!sidebarManager) return;

    const leftMenu = sidebarState.leftActiveMenu || sidebarState.activeMenu;
    const rightMenu = sidebarState.rightActiveMenu;

    if (leftMenu && leftMenu.position === "left") {
      sidebarManager.openMenu(leftMenu.id);
    } else {
      sidebarManager.closeSidebar("left");
    }

    if (rightMenu && rightMenu.position === "right") {
      sidebarManager.openMenu(rightMenu.id);
    } else {
      sidebarManager.closeSidebar("right");
    }
  }

  async loadFileExplorerState(explorerState) {
    const fileExplorer = this.editor.fileExplorer;
    if (!fileExplorer || !explorerState.rootPath) return;

    fileExplorer.projectExpanded = explorerState.projectExpanded;
    if (!(await fileExplorer.loadProject(explorerState.rootPath))) return;
    fileExplorer.activeFilePath = explorerState.activeFilePath;

    if (explorerState.expandedPaths && explorerState.expandedPaths.length > 0) {
      const expandedSet = new Set(explorerState.expandedPaths);
      await fileExplorer.restoreExpandedFolders(
        fileExplorer.files,
        expandedSet,
      );
    }
  }
}
