class StatesManager {
  constructor(editor) {
    this.editor = editor;
  }

  save() {
    try {
      const currentState = this.getState();
      this.editor.api.saveEditorState(JSON.stringify(currentState));
    } catch (error) {
      console.error("Failed to serialize editor state:", error);
      this.editor.api.saveEditorState("{}");
    }
  }

  getState() {
    return {
      tabManager: this.getTabManagerState(),
      sidebar: this.getSidebarState(),
      fileExplorer: this.getFileExplorerState(),
    };
  }

  getTabManagerState() {
    const tabManager = this.editor.tabManager;
    if (!tabManager) return null;

    return {
      activeFile: tabManager.activeFile
        ? {
            id: tabManager.activeFile.id,
          }
        : null,
      files: tabManager.files.map((file) => ({
        id: file.id,
        name: file.name,
        path: file.path,

        row: file.row,
        column: file.column,

        offsetX: file.offsetX,
        offsetY: file.offsetY,
        startIndex: file.startIndex,
        maxLineLength: file.maxLineLength,
        totalLines: file.totalLines,

        startSelect: file.startSelect,
        endSelect: file.endSelect,
        selectedLines: file._selectedLines
          ? Array.from(file._selectedLines.entries())
          : [],
      })),
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

    if (state.fileExplorer) {
      await this.loadFileExplorerState(state.fileExplorer);
    }

    if (state.sidebar) {
      this.loadSidebarState(state.sidebar);
    }

    if (state.tabManager) {
      await this.loadTabManagerState(state.tabManager);
    }
  }

  async loadTabManagerState(tabState) {
    const tabManager = this.editor.tabManager;
    if (!tabManager) return;

    let activeFileToFocus = null;

    for (const fileData of tabState.files) {
      if (!fileData) continue;
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

      await file.loadLanguage();

      tabManager.files.push(file);

      if (tabState.activeFile && file.id === tabState.activeFile.id) {
        activeFileToFocus = file;
      }
    }

    if (activeFileToFocus) {
      tabManager.setFocusFile(activeFileToFocus);

      if (
        this.editor.selectController &&
        activeFileToFocus._selectedLines.size > 0
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

    fileExplorer.rootPath = explorerState.rootPath;
    fileExplorer.projectName = explorerState.projectName;
    fileExplorer.activeFilePath = explorerState.activeFilePath;
    fileExplorer.projectExpanded = explorerState.projectExpanded;

    await window.api.startWatching(fileExplorer.rootPath);

    await fileExplorer.loadFiles();

    if (explorerState.expandedPaths && explorerState.expandedPaths.length > 0) {
      const expandedSet = new Set(explorerState.expandedPaths);
      await fileExplorer.restoreExpandedFolders(
        fileExplorer.files,
        expandedSet,
      );
    }
  }
}
