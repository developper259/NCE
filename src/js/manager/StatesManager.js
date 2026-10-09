class StatesManager {
  constructor(editor) {
    this.editor = editor;
    this.globalVersion = 2;
    this.workspaceVersion = 2;
    this.lastWorkspace = null;
    this.noWorkspaceState = null;
    this.restoreGeneration = 0;
    this.restoredRecoverySnapshots = new Set();
    this.recoveringSnapshots = new Set();
    this.persistenceSuspended = false;
    this.globalSaveTimer = null;
    this.workspaceRoots = new Map();
    this.bottomPanelSaveTimers = new Map();
    this.workspaceSaveQueues = new Map();
    this.legacyBottomPanelState = null;
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
    if (this.globalSaveTimer !== null) clearTimeout(this.globalSaveTimer);
    this.globalSaveTimer = null;
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
      bottomPanel: this.getBottomPanelState("no-workspace"),
    };
  }

  getWorkspaceState(root = this.editor.fileExplorer?.rootPath) {
    if (!root) return null;
    return {
      version: this.workspaceVersion,
      tabManager: this.getTabManagerState(root),
      sidebar: this.getSidebarState(),
      fileExplorer: this.getFileExplorerState(root),
      search: this.getSearchState(),
      bottomPanel: this.getBottomPanelState(),
    };
  }

  async saveGlobalState() {
    return this.editor.api.saveEditorState(JSON.stringify(this.getGlobalState()));
  }

  getBottomPanelState(workspaceKey = this.editor.bottomPanelManager?.workspaceKey) {
    const panelManager = this.editor.bottomPanelManager;
    const state = panelManager?.getWorkspacePanelState?.(workspaceKey) ||
      panelManager?.getPanelState?.() || {
      visible: false,
      height: 250,
      activePanelId: "terminal",
      terminal: { version: 1, activeTabIndex: 0, tabs: [] },
    };
    return this.sanitizeBottomPanelState(state) || {
      visible: false,
      height: 250,
      activePanelId: "terminal",
      terminal: { version: 1, activeTabIndex: 0, tabs: [] },
    };
  }

  scheduleGlobalStateSave() {
    if (this.persistenceSuspended) return false;
    if (this.globalSaveTimer !== null) clearTimeout(this.globalSaveTimer);
    this.globalSaveTimer = setTimeout(() => {
      this.globalSaveTimer = null;
      void this.saveGlobalState().catch((error) =>
        console.error("Failed to save global editor state:", error),
      );
    }, 300);
    return true;
  }

  sanitizeBottomPanelState(value) {
    if (!this.isRecord(value)) return null;
    const height = Number.isFinite(value.height)
      ? Math.min(1200, Math.max(120, Math.round(value.height)))
      : 250;
    const terminalValue = this.isRecord(value.terminal) ? value.terminal : {};
    const tabs = Array.isArray(terminalValue.tabs)
      ? terminalValue.tabs.slice(0, 8).flatMap((tab) => {
          if (!this.isRecord(tab)) return [];
          const baseLabel = this.safeString(tab.baseLabel, 128);
          const customLabel = this.safeString(tab.customLabel, 80);
          if (tab.baseLabel !== undefined && !baseLabel) return [];
          if (tab.customLabel !== undefined && tab.customLabel !== null && !customLabel) return [];
          return [{
            baseLabel: baseLabel || "Terminal",
            customLabel: customLabel || null,
          }];
        })
      : [];
    const activeTabIndex = Number.isInteger(terminalValue.activeTabIndex)
      ? Math.min(Math.max(terminalValue.activeTabIndex, 0), Math.max(0, tabs.length - 1))
      : 0;
    return {
      visible: value.visible === true,
      height,
      activePanelId: value.activePanelId === "terminal" ? "terminal" : null,
      terminal: { version: 1, activeTabIndex, tabs },
    };
  }

  async saveWorkspaceState(root = this.editor.fileExplorer?.rootPath) {
    this.cancelBottomPanelStateSaveForRoot(root);
    return this.enqueueWorkspaceSave(root, async () => {
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
    });
  }

  cancelBottomPanelStateSaveForRoot(root) {
    if (!root) return false;
    const panelManager = this.editor.bottomPanelManager;
    let workspaceKey = panelManager?.workspaceKey;
    let workspaceRoot = workspaceKey && workspaceKey !== "no-workspace"
      ? panelManager.workspaceRoot || this.workspaceRoots.get(workspaceKey)
      : null;
    if (!workspaceRoot || !NCEPath.equals(workspaceRoot, root)) {
      workspaceKey = null;
      for (const [candidateKey, candidateRoot] of this.workspaceRoots) {
        if (NCEPath.equals(candidateRoot, root)) {
          workspaceKey = candidateKey;
          break;
        }
      }
    }
    if (!workspaceKey) return false;
    const timer = this.bottomPanelSaveTimers.get(workspaceKey);
    if (timer === undefined) return false;
    clearTimeout(timer);
    this.bottomPanelSaveTimers.delete(workspaceKey);
    return true;
  }

  enqueueWorkspaceSave(root, callback) {
    if (!root) return Promise.resolve(false);
    const key = NCEPath.comparisonKey(root);
    const previous = this.workspaceSaveQueues.get(key) || Promise.resolve(true);
    const current = previous.catch(() => false).then(callback);
    this.workspaceSaveQueues.set(key, current);
    return current.finally(() => {
      if (this.workspaceSaveQueues.get(key) === current)
        this.workspaceSaveQueues.delete(key);
    });
  }

  scheduleBottomPanelStateSave(workspaceKey = this.editor.bottomPanelManager?.workspaceKey) {
    if (this.persistenceSuspended || typeof workspaceKey !== "string") return false;
    const previous = this.bottomPanelSaveTimers.get(workspaceKey);
    if (previous !== undefined) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.bottomPanelSaveTimers.delete(workspaceKey);
      const manager = this.editor.bottomPanelManager;
      const state = this.sanitizeBottomPanelState(
        manager?.getWorkspacePanelState?.(workspaceKey),
      );
      if (!state) return;
      if (workspaceKey === "no-workspace") {
        this.noWorkspaceState = {
          ...(this.noWorkspaceState || this.getNoWorkspaceState()),
          bottomPanel: state,
        };
        this.scheduleGlobalStateSave();
        return;
      }
      const root = this.workspaceRoots.get(workspaceKey) ||
        manager?.getWorkspaceRoot?.(workspaceKey);
      if (!root) return;
      void this.saveWorkspaceBottomPanelState(root, state);
    }, 300);
    this.bottomPanelSaveTimers.set(workspaceKey, timer);
    return true;
  }

  async saveWorkspaceBottomPanelState(root, bottomPanel) {
    if (typeof this.editor.api.loadWorkspaceState !== "function" ||
        typeof this.editor.api.saveWorkspaceState !== "function") return false;
    return this.enqueueWorkspaceSave(root, async () => {
      let existing = null;
      try { existing = await this.editor.api.loadWorkspaceState(root); }
      catch (error) { console.warn("[NCE Workspace State] bottom panel load failed", error); }
      const base = this.sanitizeWorkspaceState(existing) || {
        version: this.workspaceVersion,
        tabManager: null,
        sidebar: null,
        fileExplorer: null,
        search: null,
        bottomPanel: null,
      };
      base.bottomPanel = this.sanitizeBottomPanelState(bottomPanel);
      return (await this.editor.api.saveWorkspaceState(root, base)) !== false;
    });
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
      if (tab.type === TAB_TYPES.PICTURE) {
        const serializedPath = root === undefined ? tab.path
          : root ? this.toWorkspaceRelative(tab.path, root) : tab.path || null;
        if (!serializedPath || (root && !this.toWorkspaceRelative(tab.path, root))) return [];
        return [{ id: tab.id, type: TAB_TYPES.PICTURE, path: serializedPath }];
      }
      if (tab.type === TAB_TYPES.MARKDOWN) {
        const serializedPath = root === undefined ? tab.path
          : root ? this.toWorkspaceRelative(tab.path, root) : tab.path || null;
        if (!serializedPath || (root && !this.toWorkspaceRelative(tab.path, root))) return [];
        return [{ id: tab.id, type: TAB_TYPES.MARKDOWN, path: serializedPath }];
      }
      const serializedPath = root === undefined
        ? tab.path
        : root
          ? this.toWorkspaceRelative(tab.path, root)
          : tab.path || null;
      if (root && tab.path && serializedPath === null) return [];
      return [{
        id: tab.id, type: TAB_TYPES.FILE, name: tab.name, path: serializedPath,
        recoveryUntitledId: !serializedPath &&
          /^[A-Za-z0-9._-]{1,160}$/.test(tab.recoveryUntitledId || "")
          ? tab.recoveryUntitledId : undefined,
        row: tab.row, column: tab.column,
        offsetX: tab.offsetX, offsetY: tab.offsetY,
        startIndex: tab.startIndex, maxLineLength: tab.maxLineLength,
        totalLines: tab.totalLines,
        startSelect: tab.startSelect, endSelect: tab.endSelect,
        searchReplaceValue: tab.searchReplaceValue || "",
        searchCurrentIndex: Number.isInteger(tab.searchCurrentIndex)
          ? tab.searchCurrentIndex : -1,
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
      scrollTop: Number.isFinite(explorer.virtualScroller?.scrollTop)
        ? explorer.virtualScroller.scrollTop : this.getSidebarScrollTop("left"),
      expandedPaths: Array.from(explorer.getExpandedPaths?.(explorer.files) || [])
        .flatMap((candidate) => {
          const relative = this.toWorkspaceRelative(candidate, root);
          return relative === null ? [] : [relative];
        }),
    };
  }

  getSearchState() {
    const searchSidebar = this.editor.searchSidebar;
    const query = searchSidebar?.query;
    return {
      query: typeof query === "string" ? query : "",
      sidebarExpanded: searchSidebar?.replaceExpanded === true,
      controller: this.editor.searchController?.getWorkspaceState?.() || null,
    };
  }

  getSidebarScrollTop(side) {
    const scroller = side === "left"
      ? this.editor.sidebarManager?.leftScroller
      : this.editor.sidebarManager?.rightScroller;
    const elementScrollTop = scroller?.menuOBJ?.scrollTop;
    if (Number.isFinite(elementScrollTop)) return Math.max(0, elementScrollTop);
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
    if (type !== TAB_TYPES.FILE && type !== TAB_TYPES.SETTINGS && type !== TAB_TYPES.PICTURE && type !== TAB_TYPES.MARKDOWN) return null;
    const id = this.safeInteger(value.id, -1, 1, 1_000_000);
    if (id < 1 || seenIds.has(id)) return null;
    if (type === TAB_TYPES.SETTINGS) {
      seenIds.add(id);
      return { id, type };
    }
    const path = value.path === null ? null : this.sanitizeWorkspacePath(value.path);
    if (value.path !== null && !path) return null;
    if (type === TAB_TYPES.PICTURE) {
      if (!path || !PictureView.isSupportedPath(path)) return null;
      const key = NCEPath.comparisonKey(path);
      if (seenPaths.has(key)) return null;
      seenPaths.add(key);
      seenIds.add(id);
      return { id, type, name: NCEPath.basename(path), path };
    }
    if (type === TAB_TYPES.MARKDOWN) {
      if (!path || !/\.md$/i.test(path)) return null;
      const key = NCEPath.comparisonKey(path);
      if (seenPaths.has(key)) return null;
      seenPaths.add(key);
      seenIds.add(id);
      return { id, type, name: NCEPath.basename(path), path };
    }
    if (path) {
      const key = NCEPath.comparisonKey(path);
      if (seenPaths.has(key)) return null;
      seenPaths.add(key);
    }
    // A persisted display name is never trusted. Named files derive it from the
    // validated path; untitled buffers use a fixed application-owned label.
    const name = path ? NCEPath.basename(path) : "New file";
    const recoveryUntitledId = !path &&
      typeof value.recoveryUntitledId === "string" &&
      /^[A-Za-z0-9._-]{1,160}$/.test(value.recoveryUntitledId)
      ? value.recoveryUntitledId : undefined;
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
      ...(recoveryUntitledId ? { recoveryUntitledId } : {}),
      row: this.safeInteger(value.row),
      column: this.safeInteger(value.column),
      offsetX: this.safeInteger(value.offsetX),
      offsetY: this.safeInteger(value.offsetY),
      startIndex: this.safeInteger(value.startIndex),
      maxLineLength: this.safeInteger(value.maxLineLength),
      totalLines: this.safeInteger(value.totalLines),
      startSelect: this.sanitizePosition(value.startSelect),
      endSelect: this.sanitizePosition(value.endSelect),
      searchReplaceValue: this.safeString(
        value.searchReplaceValue,
        this.workspaceLimits.pathLength,
      ) || "",
      searchCurrentIndex: this.safeInteger(value.searchCurrentIndex, -1, -1),
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
    const fileIds = new Set(tabs.filter((tab) => tab.type === TAB_TYPES.FILE).map((tab) => tab.id));
    return {
      activeTab: activeId(value.activeTab || value.activeFile),
      activeFile: fileIds.has(value.activeFile?.id) ? activeId(value.activeFile) : null,
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

  sanitizeSearchState(value) {
    const query = this.safeString(value?.query, this.workspaceLimits.pathLength);
    const controller = this.isRecord(value?.controller) ? value.controller : {};
    return {
      query: query || "",
      sidebarExpanded: value?.sidebarExpanded === true,
      controller: {
        query: this.safeString(controller.query, this.workspaceLimits.pathLength) || "",
        isVisible: controller.isVisible === true,
        isExpanded: controller.isExpanded === true,
        expandButtonActivated: controller.expandButtonActivated === true,
      },
    };
  }

  // SECURITY BOUNDARY: workspace.json is editable, untrusted local input.
  // Build a new allowlisted object; never merge parsed values into runtime objects.
  sanitizeWorkspaceState(value) {
    if (!this.isRecord(value) || ![1, this.workspaceVersion].includes(value.version)) return null;
    return {
      version: this.workspaceVersion,
      tabManager: this.sanitizeTabManager(value.tabManager),
      sidebar: this.sanitizeSidebarState(value.sidebar),
      fileExplorer: this.sanitizeExplorerState(value.fileExplorer),
      search: this.sanitizeSearchState(value.search),
      bottomPanel: this.sanitizeBottomPanelState(value.bottomPanel),
    };
  }

  async loadStates(state) {
    if (!state) {
      return this.restoreNoWorkspaceState(null);
    }
    const globalState = state.version === this.globalVersion
      ? state : await this.migrateLegacyState(state);
    this.lastWorkspace = globalState.lastWorkspace || null;
    this.legacyBottomPanelState = this.sanitizeBottomPanelState(globalState.bottomPanel);
    this.noWorkspaceState = this.sanitizeNoWorkspaceState(globalState.noWorkspaceState);
    if (!this.lastWorkspace && this.legacyBottomPanelState) {
      if (!this.noWorkspaceState?.bottomPanel) {
        this.noWorkspaceState = {
          ...(this.noWorkspaceState || {}),
          bottomPanel: this.legacyBottomPanelState,
        };
      }
      this.legacyBottomPanelState = null;
    }
    if (globalState.agent) {
      await Promise.resolve(this.editor.agentSidebar?.loadConfigState?.(globalState.agent))
        .catch((error) => console.error("Failed to restore Agent state:", error));
    }
    if (this.lastWorkspace) {
      const opened = await this.editor.fileExplorer?.loadProject?.(
        this.lastWorkspace,
        { deferRefresh: true },
      );
      if (opened) return this.loadWorkspaceState(this.lastWorkspace);
      this.lastWorkspace = null;
      this.legacyBottomPanelState = null;
      await this.saveGlobalState();
    }
    return this.restoreNoWorkspaceState(this.noWorkspaceState);
  }

  async migrateLegacyState(legacy) {
    const root = legacy.fileExplorer?.rootPath || null;
    this.legacyBottomPanelState = this.sanitizeBottomPanelState(legacy.bottomPanel);
    const globalState = {
      version: this.globalVersion, lastWorkspace: root,
      agent: legacy.agent || null,
      noWorkspaceState: root ? null : {
        tabManager: legacy.tabManager || null,
        sidebar: legacy.sidebar || null,
        ...(this.legacyBottomPanelState ? { bottomPanel: this.legacyBottomPanelState } : {}),
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
        bottomPanel: this.legacyBottomPanelState,
      });
      if (migratedWorkspace) {
        await this.editor.api.saveWorkspaceState(root, migratedWorkspace);
        this.legacyBottomPanelState = null;
      }
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
      if (tab.type === TAB_TYPES.PICTURE) {
        const relative = this.toWorkspaceRelative(tab.path, root);
        return relative && PictureView.isSupportedPath(relative)
          ? [{ id: tab.id, type: TAB_TYPES.PICTURE, path: relative }]
          : [];
      }
      if (tab.type === TAB_TYPES.MARKDOWN) {
        const relative = this.toWorkspaceRelative(tab.path, root);
        return relative && /\.md$/i.test(relative)
          ? [{ id: tab.id, type: TAB_TYPES.MARKDOWN, path: relative }]
          : [];
      }
      const relative = this.toWorkspaceRelative(tab.path, root);
      return relative === null ? [] : [{
        id: tab.id, type: TAB_TYPES.FILE, path: relative,
        row: tab.row, column: tab.column,
        offsetX: tab.offsetX, offsetY: tab.offsetY,
        startIndex: tab.startIndex, maxLineLength: tab.maxLineLength,
        totalLines: tab.totalLines,
        startSelect: tab.startSelect, endSelect: tab.endSelect,
        searchReplaceValue: tab.searchReplaceValue || "",
        searchCurrentIndex: Number.isInteger(tab.searchCurrentIndex)
          ? tab.searchCurrentIndex : -1,
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
    const metrics = this.editor.performanceMetrics;
    const measure = metrics?.begin("workspace.restore");
    metrics?.increment("workspace.restore.requests");
    const generation = ++this.restoreGeneration;
    try {
      let state = null;
      try { state = await this.editor.api.loadWorkspaceState?.(root); }
      catch (error) { console.warn("[NCE Workspace State] load failed", error); }
      if (generation !== this.restoreGeneration) return false;
      let workspaceScope = null;
      try { workspaceScope = await this.editor.api.getTerminalWorkspaceScope?.(); }
      catch (error) { console.warn("[Terminal] Workspace scope lookup failed", error); }
      if (generation !== this.restoreGeneration) return false;
      const workspaceKey = workspaceScope?.workspacePath &&
        NCEPath.equals(workspaceScope.workspacePath, root) &&
        typeof workspaceScope.workspaceKey === "string"
        ? workspaceScope.workspaceKey : NCEPath.comparisonKey(root);
      this.workspaceRoots.set(workspaceKey, root);
      if (!state || ![1, this.workspaceVersion].includes(state.version)) {
        if (state?.version)
          console.warn("[NCE Workspace State] Unsupported version", state.version);
        state = { version: this.workspaceVersion };
      }
      const needsUpgrade = state.version !== this.workspaceVersion;
      const safeState = this.sanitizeWorkspaceState(state) || {
        version: this.workspaceVersion,
        tabManager: null,
        sidebar: null,
        fileExplorer: null,
        bottomPanel: null,
      };
      if (!safeState.bottomPanel && this.legacyBottomPanelState) {
        safeState.bottomPanel = this.legacyBottomPanelState;
        this.legacyBottomPanelState = null;
      }
      const restored = await this.restoreWorkspaceState(safeState, root, workspaceKey);
      if (restored && generation === this.restoreGeneration) {
        if (needsUpgrade || safeState.bottomPanel) await this.saveWorkspaceState(root);
        await this.offerDirtyBufferRecovery(root, generation);
        if (generation === this.restoreGeneration)
          await this.offerDirtyBufferRecovery(null, generation);
      }
      if (restored) metrics?.mark("workspace.restore.complete");
      return restored;
    } finally {
      metrics?.end(measure);
    }
  }

  async restoreWorkspaceState(state, root, workspaceKey = NCEPath.comparisonKey(root)) {
    const safeState = this.sanitizeWorkspaceState(state) || {
      version: this.workspaceVersion,
      tabManager: null,
      sidebar: null,
      fileExplorer: null,
      bottomPanel: null,
    };
    await this.loadTabManagerState(safeState.tabManager, root);
    await this.loadFileExplorerState(safeState.fileExplorer, root);
    this.loadSidebarState(safeState.sidebar);
    this.editor.agentSidebar?.restoreScrollState?.();
    this.editor.searchSidebar?.restoreQueryState?.(safeState.search, {
      runSearch: safeState.sidebar?.leftOpen === true &&
        safeState.sidebar?.leftActiveMenuId === "search",
    });
    this.editor.searchController?.restoreWorkspaceState?.(
      safeState.search.controller,
    );
    this.editor.bottomPanelManager?.restoreState?.(
      safeState.bottomPanel,
      workspaceKey,
      root,
    );
    console.info("[NCE Workspace State]", {
      action: "restore", root,
      restoredTabs: this.editor.tabManager?.tabs?.length || 0,
      sidebarRestored: Boolean(safeState.sidebar),
    });
    return true;
  }

  async restoreNoWorkspaceState(state) {
    const metrics = this.editor.performanceMetrics;
    const measure = metrics?.begin("workspace.restore.noWorkspace");
    metrics?.increment("workspace.restore.noWorkspaceRequests");
    const generation = ++this.restoreGeneration;
    try {
      await this.loadTabManagerState(state?.tabManager || null, null);
      if (generation !== this.restoreGeneration) return false;
      this.loadSidebarState(state?.sidebar || null);
      this.editor.bottomPanelManager?.restoreState?.(
        this.sanitizeBottomPanelState(state?.bottomPanel),
        "no-workspace",
        null,
      );
      await this.offerDirtyBufferRecovery(null, generation);
      metrics?.mark("workspace.restore.noWorkspaceComplete");
      return true;
    } finally {
      metrics?.end(measure);
    }
  }

  sanitizeNoWorkspaceState(value) {
    if (!this.isRecord(value)) return null;
    return {
      tabManager: value.tabManager || null,
      sidebar: this.sanitizeSidebarState(value.sidebar),
      bottomPanel: this.sanitizeBottomPanelState(value.bottomPanel),
    };
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
        else if (data.type === TAB_TYPES.PICTURE) {
          const filePath = root === undefined ? data.path
            : root ? this.resolveWorkspacePath(data.path, root) : data.path || null;
          if (!filePath || !PictureView.isSupportedPath(filePath)) continue;
          const fileOperations = this.editor.fileExplorer?.fileOperations;
          if (root && typeof this.editor.api?.resolveWorkspaceStatePath === "function") {
            const canonical = await this.editor.api.resolveWorkspaceStatePath(root, data.path);
            if (!canonical || canonical.isDirectory || canonical.readable !== true) continue;
          } else if (fileOperations?.pathStatus) {
            const status = await fileOperations.pathStatus(filePath);
            if (!status?.exists || status.isDirectory || status.readable === false) continue;
          }
          tab = new PictureTab(runtimeId, filePath);
        }
        else if (data.type === TAB_TYPES.MARKDOWN) {
          const filePath = root === undefined ? data.path
            : root ? this.resolveWorkspacePath(data.path, root) : data.path || null;
          if (!filePath || !/\.md$/i.test(filePath)) continue;
          const fileOperations = this.editor.fileExplorer?.fileOperations;
          if (root && typeof this.editor.api?.resolveWorkspaceStatePath === "function") {
            const canonical = await this.editor.api.resolveWorkspaceStatePath(root, data.path);
            if (!canonical || canonical.isDirectory || canonical.readable !== true) continue;
          } else if (fileOperations?.pathStatus) {
            const status = await fileOperations.pathStatus(filePath);
            if (!status?.exists || status.isDirectory || status.readable === false) continue;
          }
          tab = new MarkdownTab(runtimeId, filePath);
        }
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
          if (!filePath && typeof data.recoveryUntitledId === "string" &&
              /^[A-Za-z0-9._-]{1,160}$/.test(data.recoveryUntitledId))
            tab.recoveryUntitledId = data.recoveryUntitledId;
          Object.assign(tab, {
            row: data.row, column: data.column,
            offsetX: data.offsetX || 0, offsetY: data.offsetY || 0,
            startIndex: data.startIndex || 0,
            maxLineLength: data.maxLineLength || 0,
            totalLines: data.totalLines || 0,
            startSelect: data.startSelect, endSelect: data.endSelect,
            searchReplaceValue: data.searchReplaceValue || "",
            searchCurrentIndex: Number.isInteger(data.searchCurrentIndex)
              ? data.searchCurrentIndex : -1,
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

  async offerDirtyBufferRecovery(root, generation = this.restoreGeneration) {
    const api = this.editor.api;
    if (typeof api?.listRecoverySnapshots !== "function" ||
        typeof api?.readRecoverySnapshot !== "function") return 0;
    let snapshots;
    try {
      snapshots = await api.listRecoverySnapshots(root || null);
    } catch (error) {
      console.warn("[NCE Recovery] Unable to list recovered buffers:", error);
      return 0;
    }
    if (generation !== this.restoreGeneration || !Array.isArray(snapshots) ||
        !snapshots.length) return 0;
    let restored = 0;
    for (const metadata of snapshots) {
      if (generation !== this.restoreGeneration) break;
      if (!metadata || typeof metadata.id !== "string" ||
          !/^[a-f0-9]{64}$/.test(metadata.id) ||
          typeof metadata.displayName !== "string" ||
          (metadata.kind !== "path" && metadata.kind !== "untitled")) continue;
      const recoveryKey = JSON.stringify([root || null, metadata.id]);
      if (this.restoredRecoverySnapshots.has(recoveryKey) ||
          this.recoveringSnapshots.has(recoveryKey)) continue;
      this.recoveringSnapshots.add(recoveryKey);
      this.editor.performanceMetrics?.increment("recovery.snapshots.offered");
      try {
        const recoveredPath = metadata.kind === "path"
          ? root
            ? (typeof metadata.relativePath === "string"
              ? this.resolveWorkspacePath(metadata.relativePath, root) : null)
            : (typeof metadata.filePath === "string" &&
              (metadata.filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(metadata.filePath))
              ? metadata.filePath : null)
          : null;
        const untitledId = metadata.kind === "untitled" &&
          typeof metadata.untitledId === "string" &&
          /^[A-Za-z0-9._-]{1,160}$/.test(metadata.untitledId)
          ? metadata.untitledId : `recovered-${metadata.id}`;
        let snapshot;
        try {
          snapshot = await api.readRecoverySnapshot(root || null, metadata.id);
        } catch {
          console.warn("[NCE Recovery] Unable to read a recovery record; it was preserved.");
        }
        if (generation !== this.restoreGeneration) break;
        if (!snapshot || typeof snapshot.content !== "string") continue;

        const manager = this.editor.tabManager;
        let existingTab = null;
        let existingFile = null;
        if (metadata.kind === "path" && recoveredPath) {
          existingTab = manager?.tabs?.find((tab) => tab.path &&
            NCEPath.equals(tab.path, recoveredPath)) || null;
          existingFile = existingTab?.type === TAB_TYPES.FILE
            ? existingTab : existingTab?.textTab || null;
        } else if (metadata.kind === "untitled") {
          existingFile = manager?.tabs?.find((tab) => tab.type === TAB_TYPES.FILE &&
            !tab.path && tab.recoveryUntitledId === untitledId) || null;
        }
        let file = existingFile;
        let diskChanged = metadata.diskChanged === true;
        const pathCanRestore = metadata.kind === "path" && recoveredPath &&
          metadata.diskMissing !== true;
        if (!file && pathCanRestore && generation === this.restoreGeneration) {
          try {
            if (existingTab?.type === TAB_TYPES.MARKDOWN) {
              await manager.setFocusTab?.(existingTab);
              file = await manager.switchActiveTabView?.("text");
            } else {
              file = manager.getFileByPath?.(recoveredPath) ||
                await manager.openFileWithPath?.(recoveredPath);
            }
          } catch { file = null; }
        }
        if (generation !== this.restoreGeneration) break;
        if (file && (file.type !== TAB_TYPES.FILE || file.loadError ||
            file.largeFileMode === true)) file = null;
        if (file) {
          file.recoverySnapshotId = metadata.id;
          file.recoveryPreviousSnapshotId = metadata.id;
          file.recoveryStoreRoot = root || null;
          try {
            await manager?.setFocusFile?.(file);
            if (generation !== this.restoreGeneration) break;
            await this.editor.fileLoader?.waitForFileLoaded?.(file);
          } catch { file = null; }
          if (generation !== this.restoreGeneration) break;
          if (file && metadata.diskFingerprint &&
              file.diskFingerprint !== metadata.diskFingerprint)
            diskChanged = true;
        }

        if (!file) {
          if (generation !== this.restoreGeneration) break;
          file = manager?.createEmptyFile?.() || null;
          if (file) {
            file.name = `${metadata.displayName} (Recovered)`;
            file.recoveryUntitledId = untitledId;
          }
        }
        if (generation !== this.restoreGeneration) break;
        if (!file || typeof file.restoreRecoveredContent !== "function") {
          console.warn("[NCE Recovery] Could not create a buffer for a recovery record.");
          continue;
        }
        const applied = file.restoreRecoveredContent(snapshot.content, {
          editVersion: snapshot.editVersion,
          diskChanged,
          snapshotId: metadata.id,
          storeRoot: root || null,
          untitledId: file.path ? null : untitledId,
          mergeBaseContent: snapshot.mergeBaseContent,
          mergeBaseFingerprint: snapshot.diskFingerprint,
        });
        if (!applied) continue;
        this.restoredRecoverySnapshots.add(recoveryKey);
        restored += 1;
        this.editor.performanceMetrics?.increment("recovery.snapshots.restored");
        this.editor.performanceMetrics?.mark("recovery.snapshot.restored");
      } finally {
        this.recoveringSnapshots.delete(recoveryKey);
      }
    }
    return restored;
  }

  async clearRecoverySnapshotsOnQuit() {
    const clearedFromTabs = await this.editor.tabManager?.clearRecoverySnapshots?.();
    if (clearedFromTabs === false) return false;
    const api = this.editor.api;
    if (typeof api?.listRecoverySnapshots !== "function" ||
        typeof api?.deleteRecoverySnapshot !== "function") return true;
    const workspaceRoot = this.editor.fileExplorer?.rootPath || null;
    const roots = workspaceRoot ? [workspaceRoot, null] : [null];
    for (const root of roots) {
      let snapshots;
      try { snapshots = await api.listRecoverySnapshots(root); }
      catch { return false; }
      if (!Array.isArray(snapshots)) continue;
      for (const snapshot of snapshots) {
        if (typeof snapshot?.id !== "string") continue;
        try {
          if (!(await api.deleteRecoverySnapshot(root, snapshot.id))) return false;
        } catch { return false; }
      }
    }
    return true;
  }

  loadSidebarState(state) {
    const manager = this.editor.sidebarManager;
    if (!manager || !state) return;
    const restore = (side, menuId, open) => {
      if (
        !open ||
        !menuId ||
        (manager.menus && !manager.menus.has(menuId))
      ) return;
      try {
        manager.openMenu(menuId, { restoring: true });
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
    explorer.restoreScrollState?.(state, { deferRefresh: true });
  }
}
