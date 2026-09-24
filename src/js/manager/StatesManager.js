class StatesManager {
  constructor(editor) {
    this.editor = editor;
    this.globalVersion = 2;
    this.workspaceVersion = 1;
    this.lastWorkspace = null;
    this.noWorkspaceState = null;
    this.restoreGeneration = 0;
    this.persistenceSuspended = false;
    this.workspaceLimits = Object.freeze({
      tabs: 256,
      expandedPaths: 2048,
      selectedLines: 2048,
      pathLength: 4096,
      nameLength: 256,
      menuIdLength: 128,
      numeric: 10_000_000,
    });
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
      agent: this.getAgentScrollState(),
      search: this.getSearchState(),
    };
  }

  async saveGlobalState() {
    return this.editor.api.saveEditorState(JSON.stringify(this.getGlobalState()));
  }

  async saveWorkspaceState(root = this.editor.fileExplorer?.rootPath) {
    const state = this.sanitizeWorkspaceState(this.getWorkspaceState(root));
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
    return {
      leftOpen: manager.leftSidebar?.classList.contains("open") || false,
      rightOpen: manager.rightSidebar?.classList.contains("open") || false,
      leftActiveMenuId: manager.leftActiveMenu?.id || null,
      rightActiveMenuId: manager.rightActiveMenu?.id || null,
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
      scrollTop: this.getSidebarScrollTop("left"),
      expandedPaths: Array.from(explorer.getExpandedPaths?.(explorer.files) || [])
        .flatMap((candidate) => {
          const relative = this.toWorkspaceRelative(candidate, root);
          return relative === null ? [] : [relative];
        }),
    };
  }

  getAgentScrollState() {
    return { scrollTop: this.getSidebarScrollTop("right") };
  }

  getSearchState() {
    const searchSidebar = this.editor.searchSidebar;
    const query = searchSidebar?.query;
    return {
      query: typeof query === "string" ? query : "",
      sidebarExpanded: searchSidebar?.replaceExpanded === true,
    };
  }

  getSidebarScrollTop(side) {
    const scroller = side === "left"
      ? this.editor.sidebarManager?.leftScroller
      : this.editor.sidebarManager?.rightScroller;
    return Number.isFinite(scroller?.scrollTop) ? Math.max(0, scroller.scrollTop) : 0;
  }

  toWorkspaceRelative(candidate, root) {
    if (!candidate) return null;
    const normalizedRoot = NCEPath.normalize(root);
    const normalized = NCEPath.normalize(candidate);
    if (!NCEPath.isInside(normalized, normalizedRoot)) return null;
    return normalized.slice(normalizedRoot.length).replace(/^\/+/, "");
  }

  resolveWorkspacePath(relative, root) {
    if (!this.isSafeRelativeWorkspacePath(relative))
      return null;
    const normalized = NCEPath.normalize(relative);
    if (normalized.split("/").some((part) => part === "..")) return null;
    const absolute = `${NCEPath.normalize(root)}/${normalized}`;
    return root.includes("\\") ? absolute.replace(/\//g, "\\") : absolute;
  }

  isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  safeInteger(value, fallback = 0, min = 0, max = this.workspaceLimits.numeric) {
    return Number.isSafeInteger(value) && value >= min && value <= max
      ? value : fallback;
  }

  safeString(value, maxLength) {
    return typeof value === "string" && value.length <= maxLength && !value.includes("\0")
      ? value : null;
  }

  isSafeRelativeWorkspacePath(value) {
    const safe = this.safeString(value, this.workspaceLimits.pathLength);
    if (!safe || /^(?:[A-Za-z]:|\/|\\|~|file:)/i.test(safe)) return false;
    const normalized = safe.replace(/\\/g, "/");
    return normalized.split("/").every((part) => part && part !== "." && part !== "..");
  }

  sanitizeWorkspacePath(value) {
    return this.isSafeRelativeWorkspacePath(value)
      ? value.replace(/\\/g, "/") : null;
  }

  sanitizeWorkspaceTab(value, seenIds, seenPaths) {
    if (!this.isRecord(value)) return null;
    const type = value.type;
    if (type !== TAB_TYPES.FILE && type !== TAB_TYPES.SETTINGS) return null;
    const id = this.safeInteger(value.id, -1, 1, 1_000_000);
    if (id < 1 || seenIds.has(id)) return null;
    if (type === TAB_TYPES.SETTINGS) {
      seenIds.add(id);
      return { id, type };
    }
    const path = value.path === null ? null : this.sanitizeWorkspacePath(value.path);
    if (value.path !== null && !path) return null;
    if (path) {
      const key = NCEPath.comparisonKey(path);
      if (seenPaths.has(key)) return null;
      seenPaths.add(key);
    }
    // A persisted display name is never trusted. Named files derive it from the
    // validated path; untitled buffers use a fixed application-owned label.
    const name = path ? NCEPath.basename(path) : "New file";
    const selectedLines = [];
    if (Array.isArray(value.selectedLines)) {
      for (const entry of value.selectedLines.slice(0, this.workspaceLimits.selectedLines)) {
        if (!Array.isArray(entry) || entry.length !== 2 || !this.isRecord(entry[1])) continue;
        const line = this.safeInteger(entry[0], -1);
        const startCol = this.safeInteger(entry[1].startCol, -1);
        const length = this.safeInteger(entry[1].length, -1);
        const endCol = this.safeInteger(entry[1].endCol, -1);
        if (line >= 0 && startCol >= 0 && (length >= 0 || endCol >= startCol)) {
          selectedLines.push([
            line,
            length >= 0 ? { startCol, length } : { startCol, endCol },
          ]);
        }
      }
    }
    seenIds.add(id);
    return {
      id, type, name, path,
      row: this.safeInteger(value.row),
      column: this.safeInteger(value.column),
      offsetX: this.safeInteger(value.offsetX),
      offsetY: this.safeInteger(value.offsetY),
      startIndex: this.safeInteger(value.startIndex),
      maxLineLength: this.safeInteger(value.maxLineLength),
      totalLines: this.safeInteger(value.totalLines),
      startSelect: this.sanitizePosition(value.startSelect),
      endSelect: this.sanitizePosition(value.endSelect),
      selectedLines,
    };
  }

  sanitizeTabManager(value) {
    if (!this.isRecord(value)) return null;
    const seenIds = new Set(), seenPaths = new Set();
    const rawTabs = Array.isArray(value.tabs)
      ? value.tabs : Array.isArray(value.files) ? value.files : [];
    const tabs = rawTabs.slice(0, this.workspaceLimits.tabs)
      .map((tab) => this.sanitizeWorkspaceTab(tab, seenIds, seenPaths))
      .filter(Boolean);
    const activeId = (candidate) => {
      const id = this.safeInteger(candidate?.id, -1, 1, 1_000_000);
      return seenIds.has(id) ? { id } : null;
    };
    return {
      activeTab: activeId(value.activeTab || value.activeFile),
      activeFile: activeId(value.activeFile),
      tabs,
    };
  }

  sanitizePosition(value) {
    if (!this.isRecord(value)) return null;
    const row = this.safeInteger(value.row, -1);
    const column = this.safeInteger(value.column, -1);
    return row >= 0 && column >= 0 ? { row, column } : null;
  }

  sanitizeSidebarState(value) {
    if (!this.isRecord(value)) return null;
    const legacyId = (entry) => this.isRecord(entry) ? entry.id : null;
    const menuId = (candidate, side) => {
      const id = this.safeString(candidate, this.workspaceLimits.menuIdLength);
      if (!id) return null;
      const menus = this.editor.sidebarManager?.menus;
      if (!menus) return null;
      const menu = menus.get(id);
      return menu && menu.position === side ? id : null;
    };
    return {
      leftOpen: value.leftOpen === true,
      rightOpen: value.rightOpen === true,
      leftActiveMenuId: menuId(
        value.leftActiveMenuId || legacyId(value.leftActiveMenu), "left",
      ),
      rightActiveMenuId: menuId(
        value.rightActiveMenuId || legacyId(value.rightActiveMenu), "right",
      ),
    };
  }

  sanitizeExplorerState(value) {
    if (!this.isRecord(value)) return null;
    const expandedPaths = [];
    if (Array.isArray(value.expandedPaths)) {
      for (const candidate of value.expandedPaths.slice(0, this.workspaceLimits.expandedPaths)) {
        const path = this.sanitizeWorkspacePath(candidate);
        if (path && !expandedPaths.includes(path)) expandedPaths.push(path);
      }
    }
    return {
      activeFilePath: this.sanitizeWorkspacePath(value.activeFilePath),
      projectExpanded: value.projectExpanded !== false,
      scrollTop: this.safeInteger(value.scrollTop),
      expandedPaths,
    };
  }

  sanitizeAgentState(value) {
    if (!this.isRecord(value)) return { scrollTop: 0 };
    return { scrollTop: this.safeInteger(value.scrollTop) };
  }

  sanitizeSearchState(value) {
    const query = this.safeString(value?.query, this.workspaceLimits.pathLength);
    return {
      query: query || "",
      sidebarExpanded: value?.sidebarExpanded === true,
    };
  }

  // SECURITY BOUNDARY: workspace.json is editable, untrusted local input.
  // Build a new allowlisted object; never merge parsed values into runtime objects.
  sanitizeWorkspaceState(value) {
    if (!this.isRecord(value) || value.version !== this.workspaceVersion) return null;
    return {
      version: this.workspaceVersion,
      tabManager: this.sanitizeTabManager(value.tabManager),
      sidebar: this.sanitizeSidebarState(value.sidebar),
      fileExplorer: this.sanitizeExplorerState(value.fileExplorer),
      agent: this.sanitizeAgentState(value.agent),
      search: this.sanitizeSearchState(value.search),
    };
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
      const migratedWorkspace = this.sanitizeWorkspaceState({
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
      if (migratedWorkspace)
        await this.editor.api.saveWorkspaceState(root, migratedWorkspace);
    }
    await this.editor.api?.saveEditorState?.(JSON.stringify(globalState));
    return globalState;
  }

  relativizeLegacyTabs(tabState, root) {
    if (!tabState) return null;
    const tabs = (tabState.tabs || tabState.files || []).flatMap((tab) => {
      if (!this.isRecord(tab)) return [];
      if (tab.type === TAB_TYPES.SETTINGS)
        return [{ id: tab.id, type: TAB_TYPES.SETTINGS }];
      const relative = this.toWorkspaceRelative(tab.path, root);
      return relative === null ? [] : [{
        id: tab.id, type: TAB_TYPES.FILE, path: relative,
        row: tab.row, column: tab.column,
        offsetX: tab.offsetX, offsetY: tab.offsetY,
        startIndex: tab.startIndex, maxLineLength: tab.maxLineLength,
        totalLines: tab.totalLines,
        startSelect: tab.startSelect, endSelect: tab.endSelect,
        selectedLines: tab.selectedLines,
      }];
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
    const safeState = this.sanitizeWorkspaceState(state) || {
      version: this.workspaceVersion,
      tabManager: null,
      sidebar: null,
      fileExplorer: null,
    };
    return this.restoreWorkspaceState(safeState, root);
  }

  async restoreWorkspaceState(state, root) {
    const safeState = this.sanitizeWorkspaceState(state) || {
      version: this.workspaceVersion,
      tabManager: null,
      sidebar: null,
      fileExplorer: null,
    };
    await this.loadTabManagerState(safeState.tabManager, root);
    this.loadSidebarState(safeState.sidebar);
    await this.loadFileExplorerState(safeState.fileExplorer, root);
    this.editor.agentSidebar?.restoreScrollState?.(safeState.agent);
    this.editor.searchSidebar?.restoreQueryState?.(safeState.search, {
      runSearch: safeState.sidebar?.leftOpen === true &&
        safeState.sidebar?.leftActiveMenuId === "search",
    });
    console.info("[NCE Workspace State]", {
      action: "restore", root,
      restoredTabs: this.editor.tabManager?.tabs?.length || 0,
      sidebarRestored: Boolean(safeState.sidebar),
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
        const runtimeId = manager.getNextID?.() || manager.idCounter + 1;
        manager.idCounter = Math.max(manager.idCounter, runtimeId);
        if (data.type === TAB_TYPES.SETTINGS) tab = new SettingsTab(runtimeId);
        else if (
          data.type === TAB_TYPES.FILE ||
          (root === undefined && data.type === undefined)
        ) {
          const filePath = root === undefined ? data.path
            : root ? this.resolveWorkspacePath(data.path, root) : data.path || null;
          if (root && !filePath) continue;
          const fileOperations = this.editor.fileExplorer?.fileOperations;
          if (filePath) {
            if (
              root &&
              typeof this.editor.api?.resolveWorkspaceStatePath === "function"
            ) {
              const canonical = await this.editor.api.resolveWorkspaceStatePath(
                root,
                data.path,
              );
              if (!canonical || canonical.isDirectory || canonical.readable !== true) continue;
            } else if (fileOperations?.pathStatus) {
              const status = await fileOperations.pathStatus(filePath);
              if (!status?.exists || status.isDirectory || status.readable === false) continue;
            }
          }
          tab = new FileNode(this.editor, runtimeId, data.name, filePath);
          Object.assign(tab, {
            row: data.row, column: data.column,
            offsetX: data.offsetX || 0, offsetY: data.offsetY || 0,
            startIndex: data.startIndex || 0,
            maxLineLength: data.maxLineLength || 0,
            totalLines: data.totalLines || 0,
            startSelect: data.startSelect, endSelect: data.endSelect,
            _selectedLines: new Map(Array.isArray(data.selectedLines) ? data.selectedLines : []),
          });
        } else continue;
        manager.tabs.push(tab);
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
    const restore = (side, menuId, open) => {
      try {
        if (
          open &&
          menuId &&
          (!manager.menus || manager.menus.has(menuId))
        ) manager.openMenu(menuId);
        else manager.closeSidebar(side);
      } catch { manager.closeSidebar(side); }
    };
    restore("left", state.leftActiveMenuId, state.leftOpen);
    restore("right", state.rightActiveMenuId, state.rightOpen);
  }

  async loadFileExplorerState(state, root = this.editor.fileExplorer?.rootPath) {
    const explorer = this.editor.fileExplorer;
    if (!explorer || !root || !state) return;
    explorer.projectExpanded = state.projectExpanded !== false;
    explorer.activeFilePath = null;
    const activeAbsolute = this.resolveWorkspacePath(state.activeFilePath, root);
    if (activeAbsolute) {
      const canonical = await this.editor.api?.resolveWorkspaceStatePath?.(
        root, state.activeFilePath,
      );
      if (typeof this.editor.api?.resolveWorkspaceStatePath === "function") {
        if (canonical && !canonical.isDirectory && canonical.readable === true)
          explorer.activeFilePath = activeAbsolute;
      } else explorer.activeFilePath = activeAbsolute;
    }
    const expanded = new Set();
    for (const relative of state.expandedPaths || []) {
      const absolute = this.resolveWorkspacePath(relative, root);
      if (!absolute) continue;
      const canonical = await this.editor.api?.resolveWorkspaceStatePath?.(root, relative);
      if (typeof this.editor.api?.resolveWorkspaceStatePath === "function") {
        if (canonical?.isDirectory && canonical.readable === true) expanded.add(absolute);
      } else expanded.add(absolute);
    }
    await explorer.restoreExpandedFolders?.(explorer.files, expanded);
    explorer.refresh?.();
    explorer.restoreScrollState?.(state);
  }
}
