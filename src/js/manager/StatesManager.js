class StatesManager {
  constructor(editor) {
    this.editor = editor;
    this.globalVersion = 2;
    this.workspaceVersion = 1;
    this.lastWorkspace = null;
    this.noWorkspaceState = null;
    this.restoreGeneration = 0;
    this.persistenceSuspended = false;
  }

  async save() {
    if (this.persistenceSuspended) return true;
    const root = this.editor.fileExplorer?.rootPath || null;
    try {
      if (root && !(await this.saveWorkspaceState(root))) return false;
      if (!root) this.noWorkspaceState = this.getNoWorkspaceState();
      this.lastWorkspace = root;
      return await this.saveGlobalState();
    } catch (error) {
      console.error("Failed to serialize editor state:", error);
      return false;
    }
  }

  getState() {
    return {
      tabManager: this.getTabManagerState(),
      sidebar: this.getSidebarState(),
      fileExplorer: this.getLegacyFileExplorerState(),
      agent: this.getAgentState(),
    };
  }

  getGlobalState() {
    const hasWorkspace = Boolean(this.editor.fileExplorer?.rootPath);
    return {
      version: this.globalVersion,
      lastWorkspace: this.lastWorkspace,
      agent: this.getAgentState(),
      noWorkspaceState: this.noWorkspaceState ||
        (hasWorkspace ? null : this.getNoWorkspaceState()),
    };
  }

  getNoWorkspaceState() {
    return {
      tabManager: this.getTabManagerState(null),
      sidebar: this.getSidebarState(),
    };
  }

  getWorkspaceState(root = this.editor.fileExplorer?.rootPath) {
    if (!root) return null;
    return {
      version: this.workspaceVersion,
      tabManager: this.getTabManagerState(root),
      sidebar: this.getSidebarState(),
      fileExplorer: this.getFileExplorerState(root),
    };
  }

  async saveGlobalState() {
    return this.editor.api.saveEditorState(JSON.stringify(this.getGlobalState()));
  }

  async saveWorkspaceState(root = this.editor.fileExplorer?.rootPath) {
    const state = this.getWorkspaceState(root);
    if (!state || typeof this.editor.api.saveWorkspaceState !== "function")
      return false;
    const success = await this.editor.api.saveWorkspaceState(root, state);
    console.info("[NCE Workspace State]", {
      action: "save", root,
      tabs: state.tabManager?.tabs?.length || 0,
      expandedFolders: state.fileExplorer?.expandedPaths?.length || 0,
      success: success !== false,
    });
    return success !== false;
  }

  getAgentState() {
    return this.editor.agentSidebar?.getConfigState?.() || null;
  }

  getTabManagerState(root = undefined) {
    const manager = this.editor.tabManager;
    if (!manager) return null;
    const tabs = manager.tabs.flatMap((tab) => {
      if (tab.type === TAB_TYPES.SETTINGS)
        return [{ id: tab.id, type: TAB_TYPES.SETTINGS }];
      const serializedPath = root === undefined
        ? tab.path
        : root
          ? this.toWorkspaceRelative(tab.path, root)
          : tab.path || null;
      if (root && tab.path && serializedPath === null) return [];
      return [{
        id: tab.id, type: TAB_TYPES.FILE, name: tab.name, path: serializedPath,
        row: tab.row, column: tab.column,
        offsetX: tab.offsetX, offsetY: tab.offsetY,
        startIndex: tab.startIndex, maxLineLength: tab.maxLineLength,
        totalLines: tab.totalLines,
        startSelect: tab.startSelect, endSelect: tab.endSelect,
        selectedLines: tab._selectedLines
          ? Array.from(tab._selectedLines.entries()) : [],
      }];
    });
    const ids = new Set(tabs.map((tab) => tab.id));
    return {
      activeTab: ids.has(manager.activeTab?.id) ? { id: manager.activeTab.id } : null,
      activeFile: ids.has(manager.activeFile?.id) ? { id: manager.activeFile.id } : null,
      tabs,
      files: tabs.filter((tab) => tab.type === TAB_TYPES.FILE),
    };
  }

  getSidebarState() {
    const manager = this.editor.sidebarManager;
    if (!manager) return null;
    const menu = (value) => value ? {
      id: value.id, title: value.title, position: value.position,
      isOpen: value.isOpen,
    } : null;
    return {
      leftOpen: manager.leftSidebar?.classList.contains("open") || false,
      rightOpen: manager.rightSidebar?.classList.contains("open") || false,
      leftActiveMenu: menu(manager.leftActiveMenu),
      rightActiveMenu: menu(manager.rightActiveMenu),
      activeMenu: menu(manager.activeMenu),
    };
  }

  getLegacyFileExplorerState() {
    const explorer = this.editor.fileExplorer;
    if (!explorer) return null;
    return {
      rootPath: explorer.rootPath, projectName: explorer.projectName,
      activeFilePath: explorer.activeFilePath,
      projectExpanded: explorer.projectExpanded,
      expandedPaths: Array.from(explorer.getExpandedPaths?.(explorer.files) || []),
    };
  }

  getFileExplorerState(root) {
    const explorer = this.editor.fileExplorer;
    if (!explorer) return null;
    return {
      activeFilePath: this.toWorkspaceRelative(explorer.activeFilePath, root),
      projectExpanded: explorer.projectExpanded,
      expandedPaths: Array.from(explorer.getExpandedPaths?.(explorer.files) || [])
        .flatMap((candidate) => {
          const relative = this.toWorkspaceRelative(candidate, root);
          return relative === null ? [] : [relative];
        }),
    };
  }

  toWorkspaceRelative(candidate, root) {
    if (!candidate) return null;
    const normalizedRoot = NCEPath.normalize(root);
    const normalized = NCEPath.normalize(candidate);
    if (!NCEPath.isInside(normalized, normalizedRoot)) return null;
    return normalized.slice(normalizedRoot.length).replace(/^\/+/, "");
  }

  resolveWorkspacePath(relative, root) {
    if (typeof relative !== "string" || !relative || /^(?:[A-Za-z]:|\/|\\)/.test(relative))
      return null;
    const normalized = NCEPath.normalize(relative);
    if (normalized.split("/").some((part) => part === "..")) return null;
    const absolute = `${NCEPath.normalize(root)}/${normalized}`;
    return root.includes("\\") ? absolute.replace(/\//g, "\\") : absolute;
  }

  async loadStates(state) {
    if (!state) return this.restoreNoWorkspaceState(null);
    const globalState = state.version === this.globalVersion
      ? state : await this.migrateLegacyState(state);
    this.lastWorkspace = globalState.lastWorkspace || null;
    this.noWorkspaceState = globalState.noWorkspaceState || null;
    if (globalState.agent) {
      await Promise.resolve(this.editor.agentSidebar?.loadConfigState?.(globalState.agent))
        .catch((error) => console.error("Failed to restore Agent state:", error));
    }
    if (this.lastWorkspace) {
      const opened = await this.editor.fileExplorer?.loadProject?.(this.lastWorkspace);
      if (opened) return this.loadWorkspaceState(this.lastWorkspace);
      this.lastWorkspace = null;
      await this.saveGlobalState();
    }
    return this.restoreNoWorkspaceState(this.noWorkspaceState);
  }

  async migrateLegacyState(legacy) {
    const root = legacy.fileExplorer?.rootPath || null;
    const globalState = {
      version: this.globalVersion, lastWorkspace: root,
      agent: legacy.agent || null,
      noWorkspaceState: root ? null : {
        tabManager: legacy.tabManager || null, sidebar: legacy.sidebar || null,
      },
    };
    if (root && typeof this.editor.api.saveWorkspaceState === "function") {
      await this.editor.api.saveWorkspaceState(root, {
        version: this.workspaceVersion,
        tabManager: this.relativizeLegacyTabs(legacy.tabManager, root),
        sidebar: legacy.sidebar || null,
        fileExplorer: {
          activeFilePath: this.toWorkspaceRelative(legacy.fileExplorer?.activeFilePath, root),
          projectExpanded: legacy.fileExplorer?.projectExpanded,
          expandedPaths: (legacy.fileExplorer?.expandedPaths || []).flatMap((candidate) => {
            const relative = this.toWorkspaceRelative(candidate, root);
            return relative === null ? [] : [relative];
          }),
        },
      });
    }
    await this.editor.api?.saveEditorState?.(JSON.stringify(globalState));
    return globalState;
  }

  relativizeLegacyTabs(tabState, root) {
    if (!tabState) return null;
    const tabs = (tabState.tabs || tabState.files || []).flatMap((tab) => {
      if (tab.type === TAB_TYPES.SETTINGS) return [{ ...tab }];
      const relative = this.toWorkspaceRelative(tab.path, root);
      return relative === null ? [] : [{ ...tab, path: relative }];
    });
    const ids = new Set(tabs.map((tab) => tab.id));
    const active = tabState.activeTab || tabState.activeFile;
    return {
      activeTab: ids.has(active?.id) ? { id: active.id } : null,
      activeFile: ids.has(tabState.activeFile?.id) ? { id: tabState.activeFile.id } : null,
      tabs,
    };
  }

  async loadWorkspaceState(root) {
    const generation = ++this.restoreGeneration;
    let state = null;
    try { state = await this.editor.api.loadWorkspaceState?.(root); }
    catch (error) { console.warn("[NCE Workspace State] load failed", error); }
    if (generation !== this.restoreGeneration) return false;
    if (!state || state.version !== this.workspaceVersion) {
      if (state?.version)
        console.warn("[NCE Workspace State] Unsupported version", state.version);
      state = { version: this.workspaceVersion };
    }
    return this.restoreWorkspaceState(state, root);
  }

  async restoreWorkspaceState(state, root) {
    await this.loadTabManagerState(state.tabManager, root);
    this.loadSidebarState(state.sidebar);
    await this.loadFileExplorerState(state.fileExplorer, root);
    console.info("[NCE Workspace State]", {
      action: "restore", root,
      restoredTabs: this.editor.tabManager?.tabs?.length || 0,
      sidebarRestored: Boolean(state.sidebar),
    });
    return true;
  }

  async restoreNoWorkspaceState(state) {
    await this.loadTabManagerState(state?.tabManager || null, null);
    this.loadSidebarState(state?.sidebar || null);
    return true;
  }

  async loadTabManagerState(tabState, root = undefined) {
    const manager = this.editor.tabManager;
    if (!manager) return;
    manager.tabs = [];
    manager.activeTab = null;
    let active = null;
    const savedTabs = tabState?.tabs || tabState?.files || [];
    const savedActive = tabState?.activeTab || tabState?.activeFile;
    for (const data of savedTabs) {
      if (!data) continue;
      try {
        let tab;
        if (data.type === TAB_TYPES.SETTINGS) tab = new SettingsTab(data.id);
        else {
          const filePath = root === undefined ? data.path
            : root ? this.resolveWorkspacePath(data.path, root) : data.path || null;
          if (root && !filePath) continue;
          const fileOperations = this.editor.fileExplorer?.fileOperations;
          if (filePath && fileOperations?.pathStatus) {
            const status = await fileOperations.pathStatus(filePath);
            if (!status?.exists || status.isDirectory) continue;
          }
          tab = new FileNode(this.editor, data.id, data.name, filePath);
          Object.assign(tab, {
            row: data.row, column: data.column,
            offsetX: data.offsetX || 0, offsetY: data.offsetY || 0,
            startIndex: data.startIndex || 0,
            maxLineLength: data.maxLineLength || 0,
            totalLines: data.totalLines || 0,
            startSelect: data.startSelect, endSelect: data.endSelect,
            _selectedLines: new Map(Array.isArray(data.selectedLines) ? data.selectedLines : []),
          });
        }
        manager.tabs.push(tab);
        manager.idCounter = Math.max(manager.idCounter, Number(data.id) || 0);
        if (savedActive?.id === data.id) active = tab;
      } catch (error) {
        console.warn("Failed to restore tab:", data.path || data.name, error);
      }
    }
    active ||= manager.tabs[0] || null;
    if (active?.type === TAB_TYPES.FILE) await manager.setFocusFile(active);
    else if (active) await manager.setFocusTab(active);
    else manager.refresh?.();
  }

  loadSidebarState(state) {
    const manager = this.editor.sidebarManager;
    if (!manager || !state) return;
    const restore = (side, menu, open) => {
      try {
        if (
          open &&
          menu?.position === side &&
          (!manager.menus || manager.menus.has(menu.id))
        ) manager.openMenu(menu.id);
        else manager.closeSidebar(side);
      } catch { manager.closeSidebar(side); }
    };
    restore("left", state.leftActiveMenu || state.activeMenu, state.leftOpen);
    restore("right", state.rightActiveMenu, state.rightOpen);
  }

  async loadFileExplorerState(state, root = this.editor.fileExplorer?.rootPath) {
    const explorer = this.editor.fileExplorer;
    if (!explorer || !root || !state) return;
    explorer.projectExpanded = state.projectExpanded !== false;
    explorer.activeFilePath = this.resolveWorkspacePath(state.activeFilePath, root);
    const expanded = new Set((state.expandedPaths || []).flatMap((relative) => {
      const absolute = this.resolveWorkspacePath(relative, root);
      return absolute ? [absolute] : [];
    }));
    await explorer.restoreExpandedFolders?.(explorer.files, expanded);
    explorer.refresh?.();
  }
}
