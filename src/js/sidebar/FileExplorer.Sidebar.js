class FileExplorer extends Sidebar {
  constructor(editor) {
    super("file-explorer", "File Explorer", "fi fi-rr-folder", "left", editor);

    this.activeFilePath = null;
    this.files = [];
    this.rootPath = "";
    this.projectName = "";

    this.projectExpanded = true;
    this.isLoaded = false;
    this.isStale = false;
    this.staleFolderPaths = new Set();
    this.workspaceSwitching = false;
    this.pendingScrollTop = 0;
    this.visibleRows = [];
    this.visibleRowByPath = new Map();
    this.shell = null;
    this.projectHeader = null;
    this.projectArrow = null;
    this.projectTitle = null;
    this.workspaceModeBadge = null;
    this.workspaceIndexStats = null;
    this.largeWorkspaceMode = false;
    this.workspaceModeDialog = null;
    this.workspaceModeDialogValues = new Map();
    this.workspaceModeDialogPreviousFocus = null;
    this.workspaceModeFocusGeneration = 0;
    this.onWorkspaceModeDialogClick = (event) => {
      if (event.target === this.workspaceModeDialog)
        this.closeWorkspaceModeDialog();
    };
    this.onWorkspaceModeDialogClose = () =>
      this.restoreWorkspaceModeDialogFocus();
    this.deleteDialog = null;
    this.deleteDialogTitle = null;
    this.deleteDialogSubtitle = null;
    this.deleteDialogMessage = null;
    this.deleteDialogItemIcon = null;
    this.deleteDialogItemName = null;
    this.deleteDialogCheckboxLabel = null;
    this.deleteDialogCheckbox = null;
    this.deleteDialogCancelButton = null;
    this.deleteDialogDeleteButton = null;
    this.deleteDialogSession = null;
    this.deleteDialogFocusGeneration = 0;
    this.deleteProgressPreviousFocus = null;
    this.deleteWorkspaceGeneration = 0;
    this.pendingDeleteOperation = null;
    this.localRemovalTargets = new Map();
    this.deleteExplorerDestroyed = false;
    this.onDeleteDialogCancel = (event) => {
      event.preventDefault();
      this.finishDeleteConfirmation({ confirmed: false, dontAskAgain: false });
    };
    this.onDeleteDialogClose = () => this.completeDeleteConfirmation();
    this.onDeleteDialogClick = (event) => {
      if (event.target === this.deleteDialog)
        this.finishDeleteConfirmation({ confirmed: false, dontAskAgain: false });
    };
    this.onDeleteDialogCancelClick = () =>
      this.finishDeleteConfirmation({ confirmed: false, dontAskAgain: false });
    this.onDeleteDialogDeleteClick = () =>
      this.finishDeleteConfirmation({
        confirmed: true,
        dontAskAgain: this.deleteDialogCheckbox?.checked === true,
      });
    this.onDeleteWindowPageHide = () => {
      this.deleteExplorerDestroyed = true;
      this.invalidateDeleteContext({ restoreFocus: false });
    };
    window.addEventListener?.("pagehide", this.onDeleteWindowPageHide, { once: true });
    this.treeEmptyState = null;
    this.treeEmptyMessage = null;
    this.openFolderButton = null;
    this.treeViewport = null;
    this.treeLayer = null;
    this.treeLayerFast = null;
    this.virtualScroller = typeof FileExplorerScroller === "function"
      ? new FileExplorerScroller(editor, this) : null;
    this.scrollSaveTimer = null;
    this.onVirtualScroll = () => {
      this.pendingScrollTop = this.virtualScroller?.scrollTop || 0;
      clearTimeout(this.scrollSaveTimer);
      const root = this.rootPath;
      if (!root) return;
      this.scrollSaveTimer = setTimeout(() => {
        this.scrollSaveTimer = null;
        if (root !== this.rootPath) return;
        Promise.resolve(this.editor.statesManager?.saveWorkspaceState?.(root)).catch(() => {});
      }, 250);
    };

    this.clipboard = null;

    this.editingState = null;

    this.fileOperations = new FileOperations();

    this.setupFileSystemWatcher();
    this.unsubscribeWorkspaceIndexStats = window.api.onWorkspaceIndexStats?.((stats) =>
      this.applyWorkspaceIndexStats(stats),
    ) || null;

    this.initContextMenu();
  }

  initContextMenu() {
    this.editor.contextMenuManager.setMenu(
      "file-explorer-file",
      buildFileContextMenu(this),
    );
    this.editor.contextMenuManager.setMenu(
      "file-explorer-folder",
      buildFolderContextMenu(this),
    );
    this.editor.contextMenuManager.setMenu(
      "file-explorer-background",
      buildBackgroundContextMenu(this),
    );
    this.editor.contextMenuManager.setMenu(
      "file-explorer-project",
      buildProjectContextMenu(this),
    );
  }

  setupFileSystemWatcher() {
    this.unsubscribeFileSystemWatcher = window.api.onFileSystemChange((data) => {
      Promise.resolve(this.handleFileSystemChanges(data)).catch((error) =>
        console.error("Error handling filesystem changes:", error),
      );
    });
  }

  async handleFileSystemChanges(changes) {
    if (!this.rootPath || !Array.isArray(changes) || changes.length === 0) {
      return;
    }

    this.editor.quickOpen?.invalidate(this.rootPath);

    if (changes.some((change) => change.event === "root-deleted")) {
      await this.invalidateWorkspace();
      return;
    }

    const directoryPaths = new Set();
    for (const change of changes) {
      const isLocalRemoval =
        (change.event === "unlink" || change.event === "unlinkDir") &&
        [...(this.localRemovalTargets?.keys?.() || [])].some((removedPath) =>
          NCEPath.isInside(change.filePath, removedPath),
        );
      if (isLocalRemoval) continue;
      if (change.event === "change") {
        this.editor.agent?.fileKnowledge?.invalidateFile?.(
          change.filePath,
          null,
          "external_change",
        );
        this.editor.tabManager.reloadFileFromDisk(change.filePath);
      } else if (change.event === "add") {
        this.editor.agent?.fileKnowledge?.invalidateFile?.(
          change.filePath,
          null,
          "external_add",
        );
      } else if (change.event === "unlink" || change.event === "unlinkDir") {
        if (change.event === "unlink") {
          this.editor.agent?.fileKnowledge?.invalidateFile?.(
            change.filePath,
            null,
            "external_unlink",
          );
        }
        this.editor.tabManager.markFileAsDeleted(change.filePath);
        if (
          this.editingState?.target?.path &&
          NCEPath.isInside(this.editingState.target.path, change.filePath)
        ) {
          this.cancelEdit({ refresh: false });
        }
      }

      if (["add", "unlink", "addDir", "unlinkDir"].includes(change.event)) {
        if (typeof change.dirPath === "string" && change.dirPath)
          directoryPaths.add(change.dirPath);
      } else if (
        change.event === "index-reconciled" &&
        Array.isArray(change.changedDirectories)
      ) {
        for (const dirPath of change.changedDirectories) {
          if (typeof dirPath === "string" && dirPath)
            directoryPaths.add(dirPath);
        }
      }
    }

    const workspaceDirPaths = [...directoryPaths].filter((dirPath) =>
      NCEPath.isInside(dirPath, this.rootPath),
    );
    const rootChanged = workspaceDirPaths.some((dirPath) =>
      NCEPath.equals(dirPath, this.rootPath),
    );
    if (rootChanged) {
      await this.loadFiles(new Set(), { preserveExpandedContents: true });
    }

    const nestedDirectoryPaths = workspaceDirPaths.filter((dirPath) =>
      !NCEPath.equals(dirPath, this.rootPath),
    );
    const refreshed = await Promise.all(nestedDirectoryPaths.map((dirPath) =>
      this.refreshFolderIfLoaded(dirPath),
    ));
    nestedDirectoryPaths.forEach((dirPath, index) => {
      if (!refreshed[index]) {
        if (!this.staleFolderPaths) this.staleFolderPaths = new Set();
        this.staleFolderPaths.add(NCEPath.comparisonKey(dirPath));
      }
    });
    if (rootChanged || refreshed.some(Boolean)) this.refresh();
  }

  refreshFolderIfLoaded(dirPath) {
    const refreshRecursive = async (files) => {
      for (const file of files) {
        if (file.type === "folder" && NCEPath.equals(file.path, dirPath)) {
          if (file.expanded) {
            file.children = await this.loadFolderContent(dirPath);
            return true;
          }
        }
        if (file.children && await refreshRecursive(file.children)) {
          return true;
        }
      }
      return false;
    };

    return refreshRecursive(this.files);
  }

  async loadFiles(expandedPaths = new Set(), { preserveExpandedContents = false } = {}) {
    const rootPath = this.rootPath;
    if (!rootPath) return false;
    this.isStale = true;
    try {
      const status = await this.fileOperations.pathStatus(rootPath);
      if (!status?.exists) {
        if (status?.code !== "SOURCE_NOT_FOUND") {
          console.error("Unable to inspect workspace:", status);
          return false;
        }
        await this.invalidateWorkspace();
        return false;
      }
      if (!status.isDirectory) {
        await this.invalidateWorkspace();
        return false;
      }
      const items = await window.api.getFolderContent(rootPath);
      if (rootPath !== this.rootPath) return false;
      const finalStatus =
        items.length === 0
          ? await this.fileOperations.pathStatus(rootPath)
          : status;
      if (!finalStatus?.exists) {
        if (finalStatus?.code === "SOURCE_NOT_FOUND") {
          await this.invalidateWorkspace();
        } else {
          console.error(
            "Unable to verify workspace after refresh:",
            finalStatus,
          );
        }
        return false;
      }
      const existingByPath = preserveExpandedContents
        ? new Map(this.files.map((item) => [item.path, item]))
        : null;
      const newFiles = items
        .filter((item) => item.name !== ".nce")
        .map((item) => {
          const previous = existingByPath?.get(item.path);
          return {
            name: item.name,
            type: item.type,
            path: item.path,
            expanded: previous?.type === "folder" ? previous.expanded : false,
            children: item.type === "folder"
              ? previous?.type === "folder" ? previous.children : []
              : undefined,
          };
        });

      if (expandedPaths.size > 0) {
        await this.restoreExpandedFolders(newFiles, expandedPaths);
      }

      this.files = newFiles;
      this.isLoaded = true;
      this.isStale = false;
      if (preserveExpandedContents) {
        const rootKey = NCEPath.comparisonKey(rootPath);
        const existingRootFolders = newFiles
          .filter((item) => item.type === "folder")
          .map((item) => NCEPath.comparisonKey(item.path));
        for (const stalePath of this.staleFolderPaths || []) {
          if (
            stalePath === rootKey ||
            !existingRootFolders.some((folderPath) =>
              stalePath === folderPath || stalePath.startsWith(`${folderPath}/`),
            )
          ) this.staleFolderPaths.delete(stalePath);
        }
      } else {
        this.staleFolderPaths?.clear();
      }
      return true;
    } catch (error) {
      console.error("Error loading files:", error);
      const status = await this.fileOperations.pathStatus(rootPath);
      if (!status?.exists && status?.code === "SOURCE_NOT_FOUND") {
        await this.invalidateWorkspace();
      }
      return false;
    }
  }

  async loadProject(projectPath, { deferRefresh = false } = {}) {
    if (!projectPath) return false;
    if (this.rootPath && !NCEPath.equals(projectPath, this.rootPath))
      this.invalidateDeleteContext({ restoreFocus: false });
    const status = await this.fileOperations.pathStatus(projectPath);
    if (!status?.exists || !status.isDirectory) {
      if (status?.code && status.code !== "SOURCE_NOT_FOUND")
        console.error("Unable to open workspace:", status);
      return false;
    }

    if (!NCEPath.equals(projectPath, this.rootPath)) {
      this.clearWorkspaceIndexStats();
    }
    this.rootPath = projectPath;
    this.projectName = NCEPath.basename(projectPath) || "Project";

    try {
      await window.api.startWatching(projectPath);
    } catch (error) {
      console.error("Unable to watch workspace:", error);
      await this.invalidateWorkspace();
      return false;
    }

    if (!(await this.loadFiles())) return false;
    this.requestWorkspaceIndexStats(projectPath);
    if (!deferRefresh) this.refresh();

    this.editor.agentSidebar?.manualContextManager?.handleWorkspaceChanged(this.rootPath);

    this.editor.events.callEvent(Events.ON_OPEN_PROJECT, {
      rootPath: this.rootPath,
      projectName: this.projectName,
    });
    return true;
  }

  resetWorkspaceState() {
    this.invalidateDeleteContext({ restoreFocus: false });
    this.editor.quickOpen?.invalidate(this.rootPath);
    this.cancelEdit({ refresh: false });
    this.rootPath = "";
    this.projectName = "";
    this.clearWorkspaceIndexStats();
    this.files = [];
    this.activeFilePath = null;
    this.isLoaded = false;
    this.isStale = false;
    this.staleFolderPaths?.clear();
    this.clipboard = null;
    this.pendingScrollTop = 0;
    if (this.virtualScroller) this.virtualScroller.scrollTop = 0;
  }

  async invalidateWorkspace() {
    this.invalidateDeleteContext({ restoreFocus: false });
    if (!this.rootPath) return;
    this.editor.agent?.stop?.();
    const previousRootPath = this.rootPath;
    const previousProjectName = this.projectName;
    try {
      await window.api.stopWatching();
    } catch (error) {
      console.error("Error stopping invalid workspace watcher:", error);
    }
    this.resetWorkspaceState();
    this.refresh();
    if (Events.ON_CLOSE_PROJECT) {
      this.editor.events.callEvent(Events.ON_CLOSE_PROJECT, {
        rootPath: previousRootPath,
        projectName: previousProjectName,
      });
    }
  }

  async loadFolderContent(folderPath) {
    try {
      const items = await window.api.getFolderContent(folderPath);
      this.staleFolderPaths?.delete(NCEPath.comparisonKey(folderPath));
      return items.map((item) => ({
        name: item.name,
        type: item.type,
        path: item.path,
        expanded: false,
        children: item.type === "folder" ? [] : undefined,
      }));
    } catch (error) {
      this.staleFolderPaths?.add(NCEPath.comparisonKey(folderPath));
      console.error("Error loading folder content:", error);
      return [];
    }
  }

  async closeProject({ switching = false } = {}) {
    this.invalidateDeleteContext({ restoreFocus: false });
    if (!this.rootPath) return;

    if (!switching) {
      if (!(await this.editor.tabManager.prepareForQuit())) return false;
      if (!(await this.editor.statesManager.saveWorkspaceState(this.rootPath))) return false;
      this.editor.bottomPanelManager?.suspendWorkspaceSwitch?.();
      this.editor.statesManager.persistenceSuspended = true;
      try {
        await this.editor.tabManager.closeFiles({ skipPrepare: true });
      } finally {
        this.editor.statesManager.persistenceSuspended = false;
      }
    }

    this.editor.agent?.stop?.();
    await window.api.stopWatching();

    const previousRootPath = this.rootPath;
    const previousProjectName = this.projectName;

    this.resetWorkspaceState();

    this.editor.agentSidebar?.manualContextManager?.handleWorkspaceChanged(null);

    this.refresh();

    if (Events.ON_CLOSE_PROJECT) {
      this.editor.events.callEvent(Events.ON_CLOSE_PROJECT, {
        rootPath: previousRootPath,
        projectName: previousProjectName,
      });
    }
    if (!switching) {
      await this.editor.statesManager.restoreNoWorkspaceState(
        this.editor.statesManager.noWorkspaceState,
      );
      this.editor.statesManager.lastWorkspace = null;
      await this.editor.statesManager.saveGlobalState();
    }
    return true;
  }

  render() {
    this.ensureShell();
    if (this.activeFilePath) {
      if (!this.editor.tabManager.getFileByPath(this.activeFilePath)) {
        this.activeFilePath = null;
      }
    }

    this.rebuildVisibleRows();
    this.projectTitle.textContent = this.projectName
      ? this.projectName.toUpperCase()
      : "NO FOLDER OPENED";
    this.updateWorkspaceModeBadge();
    this.projectHeader.setAttribute("aria-expanded", String(this.projectExpanded));
    this.projectArrow.classList.toggle("expanded", this.projectExpanded);
    this.projectArrow.setAttribute("aria-hidden", "true");
    this.treeViewport.hidden = !this.projectExpanded;

    if (!this.rootPath) {
      this.renderNoFolderState();
    } else if (this.files.length === 0) {
      this.renderEmptyFolderState();
    } else {
      this.treeEmptyState.hidden = true;
      this.treeLayer.hidden = false;
    }
    return this.shell;
  }

  applyWorkspaceIndexStats(stats) {
    if (!stats || typeof stats.root !== "string" || !this.rootPath ||
        !NCEPath.equals(stats.root, this.rootPath) ||
        !Number.isSafeInteger(stats.fileCount) ||
        !Number.isSafeInteger(stats.directoryCount) ||
        !Number.isFinite(stats.totalIndexedBytes)) return false;
    this.workspaceIndexStats = stats;
    this.largeWorkspaceMode = stats.largeWorkspaceMode === true;
    this.updateWorkspaceModeBadge();
    return true;
  }

  clearWorkspaceIndexStats() {
    this.workspaceIndexStats = null;
    this.largeWorkspaceMode = false;
    this.updateWorkspaceModeBadge();
  }

  formatIndexedSize(bytes) {
    const size = Math.max(0, Number(bytes) || 0);
    if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(1)} GiB`;
    if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MiB`;
    if (size >= 1024) return `${(size / 1024).toFixed(1)} KiB`;
    return `${Math.round(size)} B`;
  }

  updateWorkspaceModeBadge() {
    const badge = this.workspaceModeBadge;
    const stats = this.workspaceIndexStats;
    if (badge) {
      const size = this.formatIndexedSize(stats?.totalIndexedBytes);
      const explanation = this.largeWorkspaceMode
        ? `Large Workspace Mode is active (${Number(stats?.fileCount || 0).toLocaleString()} files, ${Number(stats?.directoryCount || 0).toLocaleString()} directories, ${size} indexed). Click for details; all editor features remain available.`
        : "";
      badge.hidden = !this.largeWorkspaceMode;
      badge.textContent = this.largeWorkspaceMode ? "LARGE WORKSPACE MODE" : "";
      badge.title = explanation;
      badge.setAttribute(
        "aria-label",
        this.largeWorkspaceMode
          ? "Large Workspace Mode. Show workspace indexing details."
          : "",
      );
      badge.setAttribute(
        "aria-expanded",
        String(this.workspaceModeDialog?.open === true),
      );
    }

    if (!this.largeWorkspaceMode) {
      this.closeWorkspaceModeDialog();
      return;
    }
    if (this.workspaceModeDialog?.open) this.updateWorkspaceModeDialogStats();
  }

  ensureWorkspaceModeDialog() {
    if (this.workspaceModeDialog) return this.workspaceModeDialog;
    if (!document.body) return null;

    const dialog = document.createElement("dialog");
    dialog.className = "file-explorer-large-workspace-dialog";
    dialog.id = "file-explorer-large-workspace-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "large-workspace-dialog-title");
    dialog.setAttribute("aria-describedby", "large-workspace-dialog-description");

    const content = document.createElement("div");
    content.className = "file-explorer-large-workspace-dialog-content";
    const heading = document.createElement("h2");
    heading.id = "large-workspace-dialog-title";
    heading.textContent = "Large Workspace Mode";
    const description = document.createElement("p");
    description.id = "large-workspace-dialog-description";
    description.textContent =
      "NCE detected a large workspace and automatically adjusts background operations to reduce unnecessary resource usage.";

    const stats = document.createElement("dl");
    stats.className = "file-explorer-large-workspace-stats";
    const statLabels = [
      ["files", "Files indexed"],
      ["directories", "Directories"],
      ["size", "Indexed size"],
      ["status", "Index status"],
    ];
    this.workspaceModeDialogValues = new Map();
    for (const [key, label] of statLabels) {
      const term = document.createElement("dt");
      term.textContent = label;
      const value = document.createElement("dd");
      value.dataset.stat = key;
      stats.append(term, value);
      this.workspaceModeDialogValues.set(key, value);
    }

    const optimizationsHeading = document.createElement("h3");
    optimizationsHeading.textContent = "Background optimizations";
    const optimizations = document.createElement("ul");
    optimizations.className = "file-explorer-large-workspace-optimizations";
    for (const detail of [
      "Index change notifications are batched and debounced for 500 ms (150 ms in normal mode).",
      "Indexing uses up to 4 concurrent file probes (8 in normal mode).",
      "Up to 4 search result sessions are cached for this workspace (8 in normal mode).",
    ]) {
      const item = document.createElement("li");
      item.textContent = detail;
      optimizations.appendChild(item);
    }

    const availability = document.createElement("p");
    availability.className = "file-explorer-large-workspace-availability";
    availability.textContent = "All editor features remain available.";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "file-explorer-large-workspace-close";
    closeButton.textContent = "Got it";
    closeButton.autofocus = true;
    closeButton.addEventListener("click", () => this.closeWorkspaceModeDialog());

    content.append(
      heading,
      description,
      stats,
      optimizationsHeading,
      optimizations,
      availability,
      closeButton,
    );
    dialog.appendChild(content);
    dialog.addEventListener("click", this.onWorkspaceModeDialogClick);
    dialog.addEventListener("close", this.onWorkspaceModeDialogClose);
    document.body.appendChild(dialog);
    this.workspaceModeDialog = dialog;
    return dialog;
  }

  updateWorkspaceModeDialogStats() {
    const stats = this.workspaceIndexStats;
    if (!stats || !this.workspaceModeDialogValues.size) return false;
    this.workspaceModeDialogValues.get("files").textContent =
      Number(stats.fileCount).toLocaleString();
    this.workspaceModeDialogValues.get("directories").textContent =
      Number(stats.directoryCount).toLocaleString();
    this.workspaceModeDialogValues.get("size").textContent =
      this.formatIndexedSize(stats.totalIndexedBytes);
    this.workspaceModeDialogValues.get("status").textContent =
      stats.ready === true ? "Ready" : "Updating";
    return true;
  }

  showWorkspaceModeDialog() {
    if (!this.largeWorkspaceMode || !this.workspaceIndexStats) return false;
    const dialog = this.ensureWorkspaceModeDialog();
    if (!dialog) return false;
    this.updateWorkspaceModeDialogStats();
    if (dialog.open) return true;
    this.workspaceModeFocusGeneration++;
    this.workspaceModeDialogPreviousFocus = document.activeElement;
    dialog.showModal();
    this.workspaceModeBadge?.setAttribute("aria-expanded", "true");
    this.workspaceModeDialog.querySelector(".file-explorer-large-workspace-close")?.focus();
    return true;
  }

  handleWorkspaceModeKeyDown(event) {
    if (this.workspaceModeDialog?.open && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closeWorkspaceModeDialog();
      return true;
    }
    if (event.target !== this.workspaceModeBadge ||
        (event.key !== "Enter" && event.key !== " ")) return false;
    event.preventDefault();
    event.stopPropagation();
    this.showWorkspaceModeDialog();
    return true;
  }

  closeWorkspaceModeDialog() {
    const dialog = this.workspaceModeDialog;
    if (dialog?.open) dialog.close();
    else this.restoreWorkspaceModeDialogFocus();
    this.workspaceModeBadge?.setAttribute("aria-expanded", "false");
    return Boolean(dialog);
  }

  restoreWorkspaceModeDialogFocus() {
    // A close event from an older dialog session can arrive after a rapid
    // reopen; leave the new session's focus target for its own close event.
    if (this.workspaceModeDialog?.open) return;
    const previousFocus = this.workspaceModeDialogPreviousFocus;
    if (!previousFocus) return;
    this.workspaceModeDialogPreviousFocus = null;
    const generation = this.workspaceModeFocusGeneration =
      (this.workspaceModeFocusGeneration || 0) + 1;
    const isAvailable = (element) => element?.isConnected &&
      !element.hidden &&
      !element.closest?.('[hidden], [aria-hidden="true"], dialog:not([open])');
    const restoreFocus = () => {
      if (generation !== this.workspaceModeFocusGeneration) return;
      if (this.workspaceModeDialog?.open || this.editor?.quickPanel?.isOpen?.()) return;
      const activeModal = [...(document.querySelectorAll?.(
        '[aria-modal="true"]:not(dialog), dialog[open]',
      ) || [])].some((modal) => {
        if (modal.open === true) return true;
        if (modal.hidden || modal.getAttribute?.("aria-hidden") === "true")
          return false;
        return !modal.closest?.('[hidden], [aria-hidden="true"]');
      });
      if (activeModal) return;

      const focusTarget = isAvailable(previousFocus)
        ? previousFocus
        : isAvailable(this.projectHeader) ? this.projectHeader : null;
      const activeElement = document.activeElement;
      if (activeElement !== previousFocus &&
          activeElement !== document.body &&
          activeElement !== focusTarget &&
          !activeElement?.closest?.("dialog:not([open])")) return;
      if (typeof focusTarget?.focus === "function")
        focusTarget.focus({ preventScroll: true });
    };
    if (typeof requestAnimationFrame === "function")
      requestAnimationFrame(restoreFocus);
    else
      restoreFocus();
    this.workspaceModeBadge?.setAttribute("aria-expanded", "false");
  }

  destroyWorkspaceModeDialog() {
    const dialog = this.workspaceModeDialog;
    if (!dialog) return;
    this.workspaceModeFocusGeneration++;
    this.workspaceModeDialogPreviousFocus = null;
    if (dialog.open) dialog.close();
    dialog.removeEventListener("click", this.onWorkspaceModeDialogClick);
    dialog.removeEventListener("close", this.onWorkspaceModeDialogClose);
    dialog.remove();
    this.workspaceModeDialog = null;
    this.workspaceModeDialogValues.clear();
  }

  requestWorkspaceIndexStats(rootPath) {
    if (typeof window.api.getWorkspaceIndexStats !== "function") return;
    Promise.resolve(window.api.getWorkspaceIndexStats(rootPath)).then((stats) => {
      if (NCEPath.equals(this.rootPath, rootPath))
        this.applyWorkspaceIndexStats(stats);
    }).catch(() => {});
  }

  ensureShell() {
    if (this.shell) return this.shell;

    const container = document.createElement("div");
    container.className = "file-explorer-container";

    const mainTitle = document.createElement("div");
    mainTitle.className = "sidebar-main-title";
    mainTitle.textContent = "EXPLORER";
    container.appendChild(mainTitle);

    const projectHeader = document.createElement("div");
    projectHeader.className = "sidebar-project-header";
    projectHeader.setAttribute("role", "button");
    projectHeader.tabIndex = 0;
    projectHeader.setAttribute("aria-expanded", String(this.projectExpanded));
    const arrow = document.createElement("i");
    arrow.className = "folder-arrow fi fi-rr-angle-small-right";
    projectHeader.appendChild(arrow);
    const title = document.createElement("span");
    projectHeader.appendChild(title);
    const workspaceModeBadge = document.createElement("button");
    workspaceModeBadge.type = "button";
    workspaceModeBadge.className = "file-explorer-large-workspace";
    workspaceModeBadge.hidden = true;
    workspaceModeBadge.setAttribute("aria-haspopup", "dialog");
    workspaceModeBadge.setAttribute("aria-controls", "file-explorer-large-workspace-dialog");
    projectHeader.appendChild(workspaceModeBadge);
    projectHeader.addEventListener("click", () => {
      this.projectExpanded = !this.projectExpanded;
      this.refresh();
    });
    projectHeader.addEventListener("keydown", (event) => {
      if (event.target !== projectHeader ||
          (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      this.projectExpanded = !this.projectExpanded;
      this.refresh();
    });
    workspaceModeBadge.addEventListener("click", (event) => {
      event.stopPropagation();
      this.showWorkspaceModeDialog();
    });
    projectHeader.addEventListener("contextmenu", (event) => {
      if (!this.rootPath) return;
      event.preventDefault();
      this.editor.contextMenuManager.openContextMenu(
        "file-explorer-project",
        null,
      );
    });
    container.appendChild(projectHeader);

    const viewport = document.createElement("div");
    viewport.className = "file-tree file-tree-viewport";
    viewport.setAttribute("role", "tree");
    viewport.setAttribute("aria-label", "File Explorer");
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state-message";
    const emptyMessage = document.createElement("span");
    emptyState.appendChild(emptyMessage);
    const openFolderButton = document.createElement("button");
    openFolderButton.className = "open-folder-btn";
    openFolderButton.textContent = "Open Folder";
    openFolderButton.addEventListener("click", () => this.selectFolder());
    emptyState.appendChild(openFolderButton);
    viewport.appendChild(emptyState);

    const layer = document.createElement("div");
    layer.className = "file-tree-render-layer";
    viewport.appendChild(layer);
    viewport.addEventListener("contextmenu", (event) => {
      if (!event.target.closest?.(".file-item") && this.rootPath) {
        event.preventDefault();
        this.editor.contextMenuManager.openContextMenu(
          "file-explorer-background",
          null,
        );
      }
    });
    viewport.addEventListener("click", (event) => {
      const item = event.target.closest?.(".file-item");
      if (!item || item.classList.contains("editing")) return;
      const file = this.visibleRowByPath?.get(item.dataset.path);
      if (!file) return;
      event.stopPropagation();
      item.focus?.({ preventScroll: true });
      if (file.type === "folder") this.toggleFolder(file.path);
      else this.openFile(file.path);
    });
    viewport.addEventListener("contextmenu", (event) => {
      const item = event.target.closest?.(".file-item");
      if (!item) return;
      const file = this.visibleRowByPath?.get(item.dataset.path);
      if (!file) return;
      event.preventDefault();
      event.stopPropagation();
      item.focus?.({ preventScroll: true });
      this.editor.contextMenuManager.openContextMenu(
        file.type === "folder" ? "file-explorer-folder" : "file-explorer-file",
        file,
      );
    });
    viewport.addEventListener("keydown", (event) => {
      const current = event.target.closest?.(".file-item");
      if (!current || current.classList.contains("editing")) return;
      const rows = [...(this.treeLayer?.querySelectorAll?.(".file-item") || [])];
      const currentIndex = rows.indexOf(current);
      let nextIndex = currentIndex;
      if (event.key === "ArrowDown") nextIndex = Math.min(rows.length - 1, currentIndex + 1);
      else if (event.key === "ArrowUp") nextIndex = Math.max(0, currentIndex - 1);
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = rows.length - 1;
      else if (event.key === "Enter" || event.key === " ") {
        const file = this.visibleRowByPath?.get(current.dataset.path);
        if (!file) return;
        event.preventDefault();
        event.stopPropagation();
        if (file.type === "folder") this.toggleFolder(file.path);
        else this.openFile(file.path);
        return;
      } else return;
      if (nextIndex !== currentIndex && rows[nextIndex]) {
        event.preventDefault();
        event.stopPropagation();
        rows[nextIndex].focus({ preventScroll: true });
      }
    });
    container.appendChild(viewport);

    this.shell = container;
    this.projectHeader = projectHeader;
    this.projectArrow = arrow;
    this.projectTitle = title;
    this.workspaceModeBadge = workspaceModeBadge;
    this.treeEmptyState = emptyState;
    this.treeEmptyMessage = emptyMessage;
    this.openFolderButton = openFolderButton;
    this.treeViewport = viewport;
    this.treeLayer = layer;
    this.treeLayerFast = this.editor.domManager.wrapFastNode(layer);
    return container;
  }

  refresh() {
    this.pendingScrollTop = this.virtualScroller?.scrollTop ?? this.pendingScrollTop;
    const content = this.render();
    if (this.isOpen && this.element && content.parentNode !== this.element) {
      this.element.replaceChildren(content);
    }
    if (this.isOpen && this.virtualScroller) {
      this.virtualScroller.attach(this.treeViewport, this.treeLayer);
      this.virtualScroller.scrollTop = this.pendingScrollTop;
      this.virtualScroller.invalidateRows();
    }
  }

  restoreScrollState(state, { deferRefresh = false } = {}) {
    this.pendingScrollTop = Number.isFinite(state?.scrollTop)
      ? Math.max(0, state.scrollTop) : 0;
    if (this.virtualScroller) {
      this.virtualScroller.scrollTop = this.pendingScrollTop;
      if (!deferRefresh) this.virtualScroller.refresh();
    }
  }

  rebuildVisibleRows() {
    const rows = [];
    const byPath = new Map();
    if (this.projectExpanded && this.rootPath) {
      const visit = (files, depth) => {
        for (const file of files) {
          rows.push({ file, depth });
          if (file.path) byPath.set(file.path, file);
          if (file.type === "folder" && file.expanded && file.children) {
            visit(file.children, depth + 1);
          }
        }
      };
      visit(this.files || [], 0);
    }
    this.visibleRows = rows;
    this.visibleRowByPath = byPath;
    return rows;
  }

  renderVirtualRows(startIndex, count) {
    if (!this.treeLayer) return;
    const domManager = this.editor.domManager;
    const fragment = domManager.createFragment();
    for (let index = startIndex; index < startIndex + count; index++) {
      const row = this.visibleRows[index];
      if (!row) break;
      if (this.editingState?.target === row.file) {
        this.renderEditableRow(row.file, row.depth, fragment);
      } else {
        fragment.appendChild(this.createFileRow(row.file, row.depth));
      }
    }
    if (this.treeLayerFast) this.treeLayerFast.replaceChildren(fragment);
    else domManager.replaceChildren(this.treeLayer, fragment);
  }

  renderNoFolderState() {
    this.treeEmptyMessage.textContent = "You have not yet opened a folder.";
    this.openFolderButton.hidden = false;
    this.treeEmptyState.hidden = false;
    this.treeLayer.hidden = true;
  }

  renderEmptyFolderState() {
    this.treeEmptyMessage.textContent = "Folder empty";
    this.openFolderButton.hidden = true;
    this.treeEmptyState.hidden = false;
    this.treeLayer.hidden = true;
  }

  createFileRow(file, depth) {
    const createElement = (tagName) => this.editor.domManager.createFastElement(tagName);
    const fileItem = createElement("div");
    fileItem.setClassName(`file-item ${file.type}`);
    fileItem.setDataset("path", file.path);
    fileItem.setAttribute("tabindex", "0");
    fileItem.setAttribute("role", "treeitem");
    fileItem.setAttribute("aria-label", `${file.type}: ${file.name}`);
    if (file.type === "folder")
      fileItem.setAttribute("aria-expanded", String(file.expanded === true));
    fileItem.setCSSVariable("--depth", depth);
    fileItem.toggleClass("active-file", file.path === this.activeFilePath);

    if (file.type === "folder") {
      const arrowElement = createElement("i");
      arrowElement.setClassName(`folder-arrow fi fi-rr-angle-small-right ${file.expanded ? "expanded" : ""}`);
      fileItem.appendChild(arrowElement);

      const iconElement = createElement("i");
      iconElement.setClassName("fi fi-rr-folder file-icon");
      fileItem.appendChild(iconElement);
    } else {
      const spacer = createElement("span");
      spacer.setClassName("file-spacer");
      fileItem.appendChild(spacer);

      const iconElement = createElement("i");
      iconElement.setClassName(`${this.getFileIcon(file.name)} file-icon`);
      fileItem.appendChild(iconElement);
    }

    const nameElement = createElement("span");
    nameElement.setClassName("file-name");
    nameElement.setTextContent(file.name);
    fileItem.appendChild(nameElement);

    return fileItem.domNode;
  }

  renderEditableRow(file, depth, container) {
    const domManager = this.editor.domManager;
    const fileItemFast = domManager.createFastElement("div");
    fileItemFast.setClassName(`file-item ${file.type} editing`);
    fileItemFast.setCSSVariable("--depth", depth);
    const fileItem = fileItemFast.domNode;

    const spacerFast = domManager.createFastElement("span");
    spacerFast.setClassName("file-spacer");
    fileItemFast.appendChild(spacerFast);

    const iconElement = domManager.createFastElement("i");
    iconElement.setClassName(
      file.type === "folder"
        ? "fi fi-rr-folder file-icon"
        : `${this.getFileIcon(file.name || "")} file-icon`,
    );
    fileItemFast.appendChild(iconElement);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "file-name-input";
    input.value = file.name || "";
    input.spellcheck = false;
    fileItemFast.appendChild(input);
    container.appendChild(fileItemFast.domNode);

    if (this.editingState?.target === file) this.editingState.input = input;

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        this.commitEdit(input.value, file);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.cancelEdit();
      }
    });
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("input", () => {
      if (this.editingState?.target !== file) return;
      this.editingState.invalid = false;
      input.classList?.remove?.("invalid");
    });
    input.addEventListener("blur", () => this.commitEdit(input.value, file));

    requestAnimationFrame(() => {
      if (
        this.editingState?.target !== file ||
        this.editingState?.input !== input
      )
        return;
      input.focus();
      const dotIndex = (file.name || "").lastIndexOf(".");
      if (file.type === "file" && dotIndex > 0) {
        input.setSelectionRange(0, dotIndex);
      } else {
        input.select();
      }
    });
  }

  setActiveFile(path) {
    if (!this.rootPath) return;
    const previous = this.activeFilePath;
    this.activeFilePath = path;
    const mounted = this.treeLayer
      ? this.editor.domManager?.getElements?.(".file-item", this.treeLayer) || [] : [];
    for (const item of mounted) {
      const fastItem = this.editor.domManager.wrapFastNode(item);
      if (item.dataset.path === previous) fastItem?.toggleClass("active-file", false);
      if (item.dataset.path === path) fastItem?.toggleClass("active-file", true);
    }
  }

  revealRow(file) {
    const scroller = this.virtualScroller;
    if (!scroller || !scroller.maxViewRows) return;
    const index = this.visibleRows.findIndex((row) => row.file === file);
    if (index < 0) return;
    scroller.totalVisibleRows = this.visibleRows.length;
    const last = scroller.startIndex + scroller.maxViewRows - 1;
    if (index < scroller.startIndex) scroller.setScrollTop(index * scroller.rowHeight);
    else if (index > last) {
      scroller.setScrollTop((index - scroller.maxViewRows + 1) * scroller.rowHeight);
    }
  }

  async onOpen({ restoring = false } = {}) {
    if (restoring) return;
    if (this.rootPath && (!this.isLoaded || this.isStale)) {
      const expandedSet = this.getExpandedPaths(this.files);
      await this.loadFiles(expandedSet);
    }
    this.refresh();
  }

  destroy() {
    this.deleteExplorerDestroyed = true;
    this.invalidateDeleteContext({ restoreFocus: false });
    window.removeEventListener?.("pagehide", this.onDeleteWindowPageHide);
    this.destroyDeleteDialog();
    for (const timer of this.localRemovalTargets?.values?.() || [])
      clearTimeout(timer);
    this.localRemovalTargets?.clear?.();
    this.unsubscribeFileSystemWatcher?.();
    this.unsubscribeFileSystemWatcher = null;
    this.unsubscribeWorkspaceIndexStats?.();
    this.unsubscribeWorkspaceIndexStats = null;
    clearTimeout(this.scrollSaveTimer);
    this.scrollSaveTimer = null;
    this.virtualScroller?.destroy();
    this.virtualScroller = null;
    this.destroyWorkspaceModeDialog();
    this.shell?.remove();
    this.shell = null;
    this.treeViewport = null;
    this.treeLayer = null;
    this.treeLayerFast = null;
  }

  async selectFolder() {
    const folderPath = await window.api.selectFolder();
    if (!folderPath) return false;
    return this.requestWorkspaceSwitch(folderPath);
  }

  async openRecentFolder(folderPath) {
    return this.requestWorkspaceSwitch(folderPath, { fromRecent: true });
  }

  async requestWorkspaceSwitch(folderPath, { fromRecent = false } = {}) {
    if (!folderPath || this.workspaceSwitching) return false;
    this.invalidateDeleteContext({ restoreFocus: false });
    this.workspaceSwitching = true;

    try {
      return await this.performWorkspaceSwitch(folderPath, { fromRecent });
    } finally {
      this.workspaceSwitching = false;
    }
  }

  async performWorkspaceSwitch(folderPath, { fromRecent = false } = {}) {
    const status = await this.fileOperations.pathStatus(folderPath);
    if (!status?.exists || !status.isDirectory || status.readable === false) {
      if (
        fromRecent &&
        ((!status?.exists && status?.code === "SOURCE_NOT_FOUND") ||
          (status?.exists && !status.isDirectory))
      ) {
        await this.editor.api.removeRecentFolder?.(folderPath);
      }
      return false;
    }

    if (this.rootPath && NCEPath.equals(folderPath, this.rootPath)) {
      await this.editor.api.addRecentFolder?.(folderPath);
      return true;
    }

    if (!(await this.editor.tabManager.prepareForQuit())) return false;

    const previousRoot = this.rootPath;
    const previousPanelKey = this.editor.bottomPanelManager?.workspaceKey ||
      (previousRoot ? NCEPath.comparisonKey(previousRoot) : "no-workspace");
    const previousPanelState = this.editor.bottomPanelManager?.getPanelState?.() || null;
    if (previousRoot) {
      // Persist the current workspace while its tabs, explorer and sidebar are
      // still intact. A failed snapshot must not partially switch workspaces.
      const saved =
        await this.editor.statesManager.saveWorkspaceState(previousRoot);
      if (saved === false) return false;
    } else {
      this.editor.statesManager.noWorkspaceState =
        this.editor.statesManager.getNoWorkspaceState();
    }
    this.editor.bottomPanelManager?.suspendWorkspaceSwitch?.();
    this.editor.statesManager.persistenceSuspended = true;
    let opened = false;
    try {
      await this.editor.tabManager.closeFiles({ skipPrepare: true });
      this.editor.searchSidebar?.resetWorkspace?.();
      if (this.rootPath) await this.closeProject({ switching: true });

      this.isLoaded = false;
      opened = await this.loadProject(folderPath, { deferRefresh: true });
    } finally {
      this.editor.statesManager.persistenceSuspended = false;
    }

    if (!opened) {
      if (previousRoot) {
        const restoredRoot = await this.loadProject(previousRoot, { deferRefresh: true });
        if (restoredRoot) {
          await this.editor.statesManager.loadWorkspaceState(previousRoot);
        } else if (previousPanelState) {
          this.editor.bottomPanelManager?.restoreState?.(
            previousPanelState,
            previousPanelKey,
            previousRoot,
          );
        }
      } else {
        if (this.rootPath) await this.closeProject({ switching: true });
        await this.editor.statesManager.restoreNoWorkspaceState(
          this.editor.statesManager.noWorkspaceState,
        );
      }
      return false;
    }

    await this.editor.statesManager.loadWorkspaceState(folderPath);
    this.editor.statesManager.lastWorkspace = folderPath;
    const stateSaved = await this.editor.statesManager.saveGlobalState();
    await this.editor.api.addRecentFolder?.(folderPath);
    return stateSaved !== false;
  }

  async toggleFolder(folderPath) {
    const toggle = async (files) => {
      for (const file of files) {
        if (NCEPath.equals(file.path, folderPath) && file.type === "folder") {
          file.expanded = !file.expanded;
          if (
            file.expanded &&
            (!file.children || file.children.length === 0 ||
              this.staleFolderPaths?.has(NCEPath.comparisonKey(file.path)))
          ) {
            file.children = await this.loadFolderContent(folderPath);
          }
          return true;
        }
        if (file.children && (await toggle(file.children))) {
          return true;
        }
      }
      return false;
    };
    await toggle(this.files);
    this.refresh();
  }

  async openFile(filePath) {
    this.editor.tabManager.openFileWithPath(filePath);
    this.setActiveFile(filePath);
  }

  async restoreExpandedFolders(files, expandedSet) {
    if (!expandedSet || !files || expandedSet.size === 0) return;
    for (const file of files) {
      if (file.type === "folder" && expandedSet.has(file.path)) {
        file.expanded = true;
        file.children = await this.loadFolderContent(file.path);
        if (file.children && file.children.length > 0) {
          await this.restoreExpandedFolders(file.children, expandedSet);
        }
      }
    }
  }

  getExpandedPaths(files, pathsSet = new Set()) {
    if (!files) return pathsSet;
    for (const file of files) {
      if (file.type === "folder" && file.expanded) {
        pathsSet.add(file.path);
        if (file.children) {
          this.getExpandedPaths(file.children, pathsSet);
        }
      }
    }
    return pathsSet;
  }

  getFileIcon(filename) {
    const ext = filename.split(".").pop().toLowerCase();
    return USERCONFIG_FILE_ICONS[ext] || USERCONFIG_FILE_ICONS.default;
  }

  findFileByPath(files, targetPath) {
    for (const file of files) {
      if (file.path === targetPath) return file;
      if (file.children) {
        const found = this.findFileByPath(file.children, targetPath);
        if (found) return found;
      }
    }
    return null;
  }

  removePlaceholder(target) {
    const removeRecursive = (files) => {
      const idx = files.indexOf(target);
      if (idx !== -1) {
        files.splice(idx, 1);
        return true;
      }
      for (const f of files) {
        if (f.children && removeRecursive(f.children)) return true;
      }
      return false;
    };
    removeRecursive(this.files);
  }

  async refreshFolder(folderPath) {
    if (NCEPath.equals(folderPath, this.rootPath)) {
      await this.loadFiles(this.getExpandedPaths(this.files));
    } else {
      const folder = this.findFileByPath(this.files, folderPath);
      if (folder) {
        folder.children = await this.loadFolderContent(folderPath);
      }
    }
    this.refresh();
  }

  async expandPathSegments(basePath, segments) {
    let currentPath = basePath;

    for (const segment of segments) {
      currentPath = `${currentPath}/${segment}`;
      const folder = this.findFileByPath(this.files, currentPath);
      if (!folder) break;
      folder.expanded = true;
      folder.children = await this.loadFolderContent(currentPath);
    }

    this.refresh();
  }

  async startCreateEntry(parentPath, entryType) {
    this.cancelEdit({ refresh: false });
    let childrenArray;

    if (parentPath === this.rootPath) {
      childrenArray = this.files;
    } else {
      const folder = this.findFileByPath(this.files, parentPath);
      if (!folder) return;
      if (!folder.expanded) {
        folder.expanded = true;
        folder.children = await this.loadFolderContent(parentPath);
      }
      childrenArray = folder.children;
    }

    const placeholder = {
      name: "",
      type: entryType,
      path: null,
      isNew: true,
      parentPath,
      expanded: false,
      children: entryType === "folder" ? [] : undefined,
    };

    childrenArray.unshift(placeholder);
    this.editingState = {
      mode: "create",
      status: "editing",
      target: placeholder,
      input: null,
    };
    this.refresh();
    this.revealRow(placeholder);
  }

  startRename(file) {
    this.cancelEdit({ refresh: false });
    this.editingState = {
      mode: "rename",
      status: "editing",
      target: file,
      input: null,
    };
    this.refresh();
    this.revealRow(file);
  }

  cancelEdit({ refresh = true } = {}) {
    const target = this.editingState?.target;
    this.editingState = null;
    if (target?.isNew) this.removePlaceholder(target);
    if (refresh) this.refresh();
  }

  recoverEdit(message) {
    const session = this.editingState;
    if (!session) return;
    session.status = "recovering";
    alert(message);
    if (this.editingState !== session) return;
    session.status = "editing";
    session.input?.focus();
    session.input?.select();
  }

  markEditInvalid(message) {
    const session = this.editingState;
    if (!session) return;
    session.status = "editing";
    session.invalid = true;
    session.error = message || "Invalid file name";
    session.input?.classList?.add?.("invalid");
    session.input?.focus?.();
    session.input?.select?.();
  }

  isInvalidNameError(result) {
    const code = String(result?.code || "").toLowerCase();
    const message = String(result?.error || "").toLowerCase();
    return (
      code.includes("name") ||
      code.includes("path") ||
      (message.includes("invalid") &&
        (message.includes("name") || message.includes("path")))
    );
  }

  async commitEdit(rawValue, target) {
    const session = this.editingState;
    if (!session || session.target !== target || session.status !== "editing")
      return;
    session.status = "committing";
    const name = rawValue.trim();

    if (!name) {
      if (target.isNew) {
        this.cancelEdit();
        return;
      }
      this.markEditInvalid("Invalid file name");
      return;
    }

    if (target.isNew) {
      const parentPath = target.parentPath;
      try {
        const result =
          target.type === "folder"
            ? await this.fileOperations.createFolder(parentPath, name)
            : await this.fileOperations.createFile(parentPath, name);

        if (!result?.success) {
          const message = result?.error || "Impossible de créer l’élément.";
          if (this.isInvalidNameError(result)) {
            this.markEditInvalid(message);
            return;
          }
          this.recoverEdit(message);
          return;
        }

        this.editingState = null;
        await this.refreshFolder(parentPath);

        const segments = name.split("/").filter(Boolean);
        const foldersToExpand =
          target.type === "folder" ? segments : segments.slice(0, -1);
        if (foldersToExpand.length > 0) {
          await this.expandPathSegments(parentPath, foldersToExpand);
        }

        if (target.type === "file") {
          this.openFile(result.path);
        }
      } catch (error) {
        console.error("Error creating entry:", error);
        this.recoverEdit(error?.message || "Impossible de créer l'élément.");
      }
      return;
    }

    if (name === target.name) {
      this.cancelEdit();
      return;
    }

    if (name === "." || name === ".." || /[\\/\0]/.test(name)) {
      this.markEditInvalid("Invalid file name");
      return;
    }

    const parentDir = NCEPath.dirname(target.path);
    const separator = String(target.path).includes("\\") ? "\\" : "/";
    const newPath = `${parentDir}${parentDir.endsWith(separator) ? "" : separator}${name}`;

    try {
      const result = await this.fileOperations.rename(target.path, newPath);
      if (!result?.success) {
        if (result?.code === "SOURCE_NOT_FOUND") {
          this.cancelEdit({ refresh: false });
          await this.refreshFolder(parentDir);
          return;
        }
        if (this.isInvalidNameError(result)) {
          this.markEditInvalid(result?.error || "Invalid file name");
          return;
        }
        this.recoverEdit(result?.error || "Impossible de renommer l'élément.");
        return;
      }

      const oldPath = target.path;
      if (NCEPath.isInside(this.activeFilePath, oldPath))
        this.activeFilePath = NCEPath.rebase(
          this.activeFilePath,
          oldPath,
          newPath,
        );
      await this.editor.tabManager.updateFilePath(oldPath, newPath);

      target.name = name;
      target.path = newPath;
      this.editingState = null;
      await this.refreshFolder(parentDir);
      this.refresh();
    } catch (error) {
      console.error("Error renaming entry:", error);
      this.cancelEdit();
    }
  }

  ensureDeleteDialog() {
    if (this.deleteDialog) return this.deleteDialog;
    if (!document.body || typeof document.createElement !== "function")
      return null;

    const dialog = document.createElement("dialog");
    dialog.className = "file-explorer-delete-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "file-explorer-delete-title");
    dialog.setAttribute(
      "aria-describedby",
      "file-explorer-delete-subtitle file-explorer-delete-message",
    );

    const content = document.createElement("div");
    content.className = "file-explorer-delete-dialog-content";
    const heading = document.createElement("div");
    heading.className = "file-explorer-delete-heading";
    const trashBadge = document.createElement("span");
    trashBadge.className = "file-explorer-delete-trash-badge";
    trashBadge.setAttribute("aria-hidden", "true");
    const trashIcon = document.createElement("i");
    trashIcon.className = "fi fi-rr-trash";
    trashBadge.appendChild(trashIcon);
    const titleGroup = document.createElement("div");
    titleGroup.className = "file-explorer-delete-title-group";
    const title = document.createElement("h2");
    title.id = "file-explorer-delete-title";
    const subtitle = document.createElement("p");
    subtitle.id = "file-explorer-delete-subtitle";
    subtitle.className = "file-explorer-delete-subtitle";
    subtitle.textContent = "This action cannot be undone.";
    titleGroup.append(title, subtitle);
    heading.append(trashBadge, titleGroup);
    const message = document.createElement("p");
    message.className = "file-explorer-delete-description";
    message.id = "file-explorer-delete-message";

    const item = document.createElement("div");
    item.className = "file-explorer-delete-item";
    const itemIcon = document.createElement("i");
    itemIcon.setAttribute("aria-hidden", "true");
    const itemName = document.createElement("span");
    itemName.className = "file-explorer-delete-item-name";
    item.append(itemIcon, itemName);

    const checkboxLabel = document.createElement("label");
    checkboxLabel.className = "nce-checkbox file-explorer-delete-checkbox";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = false;
    const checkboxBox = document.createElement("span");
    checkboxBox.className = "nce-checkbox-box";
    checkboxBox.setAttribute("aria-hidden", "true");
    const checkboxIcon = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    checkboxIcon.setAttribute("viewBox", "0 0 16 16");
    checkboxIcon.setAttribute("focusable", "false");
    const checkboxTick = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "path",
    );
    checkboxTick.setAttribute("d", "M3.25 8.25 6.5 11.5 12.75 4.75");
    checkboxIcon.appendChild(checkboxTick);
    checkboxBox.appendChild(checkboxIcon);
    const checkboxText = document.createElement("span");
    checkboxText.className = "nce-checkbox-text";
    checkboxText.textContent = "Don't ask again";
    checkboxLabel.append(checkbox, checkboxBox, checkboxText);

    const actions = document.createElement("div");
    actions.className = "file-explorer-delete-actions";
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "file-explorer-delete-cancel";
    cancelButton.textContent = "Cancel";
    cancelButton.autofocus = true;
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "file-explorer-delete-confirm danger";
    deleteButton.textContent = "Delete";
    actions.append(cancelButton, deleteButton);
    content.append(heading, message, item, checkboxLabel, actions);
    dialog.appendChild(content);

    dialog.addEventListener("cancel", this.onDeleteDialogCancel);
    dialog.addEventListener("close", this.onDeleteDialogClose);
    dialog.addEventListener("click", this.onDeleteDialogClick);
    cancelButton.addEventListener("click", this.onDeleteDialogCancelClick);
    deleteButton.addEventListener("click", this.onDeleteDialogDeleteClick);
    document.body.appendChild(dialog);

    this.deleteDialog = dialog;
    this.deleteDialogTitle = title;
    this.deleteDialogSubtitle = subtitle;
    this.deleteDialogMessage = message;
    this.deleteDialogItemIcon = itemIcon;
    this.deleteDialogItemName = itemName;
    this.deleteDialogCheckboxLabel = checkboxLabel;
    this.deleteDialogCheckbox = checkbox;
    this.deleteDialogCancelButton = cancelButton;
    this.deleteDialogDeleteButton = deleteButton;
    return dialog;
  }

  showDeleteConfirmation(file, { action = "trash" } = {}) {
    const dialog = this.ensureDeleteDialog();
    if (!dialog || dialog.open || this.deleteDialogSession) {
      return Promise.resolve({ confirmed: false, dontAskAgain: false });
    }

    const isFolder = file.type === "folder";
    const isTrash = action === "trash";
    this.deleteDialog.setAttribute("data-mode", isTrash ? "trash" : "permanent");
    this.deleteDialogTitle.textContent = isTrash
      ? "Move to Trash"
      : "Delete Permanently";
    this.deleteDialogSubtitle.hidden = isTrash;
    this.deleteDialogSubtitle.textContent = "This action cannot be undone.";
    this.deleteDialogSubtitle.removeAttribute("aria-live");
    this.deleteDialogMessage.textContent = isTrash
      ? isFolder
        ? "Move this folder and its contents to the Trash?"
        : "Move this file to the Trash?"
      : isFolder
        ? "Permanently delete this folder? All files and subfolders inside will also be permanently deleted."
        : "Permanently delete this file?";
    this.deleteDialogItemIcon.className = isFolder
      ? "fi fi-rr-folder file-explorer-delete-folder-icon"
      : "fi fi-rr-file file-explorer-delete-file-icon";
    this.deleteDialogItemName.textContent = file.name;
    this.deleteDialogItemName.title = file.name;
    this.deleteDialogCheckboxLabel.hidden = !isTrash;
    this.deleteDialogDeleteButton.textContent = isTrash
      ? "Move to Trash"
      : "Delete Permanently";
    this.deleteDialogDeleteButton.className = isTrash
      ? "file-explorer-delete-confirm"
      : "file-explorer-delete-confirm danger";
    this.deleteDialogCheckbox.checked = false;
    this.deleteDialogCancelButton.disabled = false;
    this.deleteDialogDeleteButton.disabled = false;

    return new Promise((resolve) => {
      const session = {
        resolve,
        result: null,
        previousFocus: document.activeElement,
        restoreFocus: true,
        completed: false,
      };
      this.deleteDialogSession = session;
      try {
        dialog.showModal();
        this.deleteDialogCancelButton.focus({ preventScroll: true });
      } catch (error) {
        console.error("Unable to open delete confirmation:", error);
        session.result = { confirmed: false, dontAskAgain: false };
        this.completeDeleteConfirmation();
      }
    });
  }

  handleDeleteDialogKeyDown(event) {
    if (!this.deleteDialog?.open) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation?.();
      event.stopPropagation?.();
      this.finishDeleteConfirmation({ confirmed: false, dontAskAgain: false });
    } else if (
      event.key === "Enter" &&
      (event.target === this.deleteDialogCancelButton ||
        event.target === this.deleteDialogDeleteButton)
    ) {
      event.preventDefault();
      event.target.click();
    }
    return true;
  }

  showDeleteProgress(action) {
    const dialog = this.ensureDeleteDialog();
    if (!dialog || dialog.open || this.deleteDialogSession) return false;
    const isTrash = action === "trash";
    this.deleteProgressPreviousFocus = document.activeElement;
    dialog.setAttribute("data-mode", isTrash ? "trash" : "permanent");
    dialog.setAttribute("aria-busy", "true");
    this.deleteDialogTitle.textContent = isTrash
      ? "Moving to Trash"
      : "Deleting Permanently";
    this.deleteDialogSubtitle.hidden = false;
    this.deleteDialogSubtitle.setAttribute("aria-live", "polite");
    this.deleteDialogSubtitle.textContent = isTrash
      ? "Moving item to the system Trash…"
      : "Deleting item permanently…";
    this.deleteDialogCheckboxLabel.hidden = true;
    this.deleteDialogCancelButton.disabled = true;
    this.deleteDialogDeleteButton.disabled = true;
    this.deleteDialogDeleteButton.textContent = isTrash ? "Moving…" : "Deleting…";
    try {
      dialog.showModal();
      return true;
    } catch (error) {
      dialog.removeAttribute("aria-busy");
      this.deleteProgressPreviousFocus = null;
      console.warn("Unable to show file-removal progress:", error);
      return false;
    }
  }

  closeDeleteProgress() {
    const dialog = this.deleteDialog;
    if (!dialog?.hasAttribute?.("aria-busy")) return false;
    if (dialog.open) dialog.close();
    dialog.removeAttribute("aria-busy");
    this.deleteDialogCancelButton.disabled = false;
    this.deleteDialogDeleteButton.disabled = false;
    const previousFocus = this.deleteProgressPreviousFocus;
    this.deleteProgressPreviousFocus = null;
    if (previousFocus) this.restoreDeleteDialogFocus({ previousFocus });
    return true;
  }

  handleFileExplorerRemovalShortcut(event) {
    if (event?.key !== "Delete" || event.altKey || event.ctrlKey || event.metaKey || event.repeat)
      return false;
    const item = event.target?.closest?.(".file-item");
    if (!item || !this.shell?.contains?.(item) || item.classList?.contains("editing"))
      return false;
    const file = this.visibleRowByPath?.get(item.dataset?.path);
    if (!file) return false;
    event.preventDefault();
    event.stopPropagation?.();
    if (event.shiftKey) void this.permanentlyDelete(file);
    else void this.moveToTrash(file);
    return true;
  }

  finishDeleteConfirmation(result, { restoreFocus = true } = {}) {
    const session = this.deleteDialogSession;
    if (!session || session.result) return false;
    session.result = result;
    session.restoreFocus = restoreFocus;
    if (this.deleteDialog?.open) this.deleteDialog.close();
    else this.completeDeleteConfirmation();
    return true;
  }

  completeDeleteConfirmation() {
    const session = this.deleteDialogSession;
    if (!session || session.completed) return false;
    this.deleteDialogSession = null;
    session.completed = true;
    const result = session.result || {
      confirmed: false,
      dontAskAgain: false,
    };
    if (session.restoreFocus) this.restoreDeleteDialogFocus(session);
    session.resolve(result);
    return true;
  }

  restoreDeleteDialogFocus(session) {
    const generation = this.deleteDialogFocusGeneration =
      (this.deleteDialogFocusGeneration || 0) + 1;
    const schedule = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (callback) => setTimeout(callback, 0);
    schedule(() => {
      if (generation !== this.deleteDialogFocusGeneration || this.deleteDialog?.open)
        return;
      if (this.editor?.quickPanel?.isOpen?.()) return;
      const activeModal = [...(document.querySelectorAll?.(
        '[aria-modal="true"]:not(dialog), dialog[open]',
      ) || [])].some((modal) => {
        if (modal.open === true) return true;
        if (modal.hidden || modal.getAttribute?.("aria-hidden") === "true")
          return false;
        return !modal.closest?.('[hidden], [aria-hidden="true"]');
      });
      if (activeModal) return;

      const available = (element) => element?.isConnected &&
        !element.hidden &&
        !element.closest?.('[hidden], [aria-hidden="true"], dialog:not([open])');
      const focusTarget = available(session.previousFocus)
        ? session.previousFocus
        : available(this.projectHeader) ? this.projectHeader : null;
      const activeElement = document.activeElement;
      if (activeElement !== document.body &&
          activeElement !== session.previousFocus &&
          activeElement !== focusTarget &&
          !activeElement?.closest?.("dialog:not([open])")) return;
      focusTarget?.focus?.({ preventScroll: true });
    });
  }

  cancelDeleteConfirmation({ restoreFocus = true } = {}) {
    return this.finishDeleteConfirmation(
      { confirmed: false, dontAskAgain: false },
      { restoreFocus },
    );
  }

  invalidateDeleteContext({ restoreFocus = false } = {}) {
    this.deleteWorkspaceGeneration = (this.deleteWorkspaceGeneration || 0) + 1;
    this.cancelDeleteConfirmation({ restoreFocus });
  }

  destroyDeleteDialog() {
    const dialog = this.deleteDialog;
    if (!dialog) return;
    const session = this.deleteDialogSession;
    this.deleteDialogSession = null;
    if (session && !session.completed) {
      session.completed = true;
      session.resolve({ confirmed: false, dontAskAgain: false });
    }
    if (dialog.open) dialog.close();
    dialog.removeEventListener("cancel", this.onDeleteDialogCancel);
    dialog.removeEventListener("close", this.onDeleteDialogClose);
    dialog.removeEventListener("click", this.onDeleteDialogClick);
    this.deleteDialogCancelButton?.removeEventListener(
      "click",
      this.onDeleteDialogCancelClick,
    );
    this.deleteDialogDeleteButton?.removeEventListener(
      "click",
      this.onDeleteDialogDeleteClick,
    );
    dialog.remove();
    this.deleteDialog = null;
    this.deleteDialogTitle = null;
    this.deleteDialogSubtitle = null;
    this.deleteDialogMessage = null;
    this.deleteDialogItemIcon = null;
    this.deleteDialogItemName = null;
    this.deleteDialogCheckboxLabel = null;
    this.deleteDialogCheckbox = null;
    this.deleteDialogCancelButton = null;
    this.deleteDialogDeleteButton = null;
  }

  isDeleteRequestCurrent(rootPath, generation) {
    return !this.deleteExplorerDestroyed &&
      !this.workspaceSwitching &&
      generation === this.deleteWorkspaceGeneration &&
      NCEPath.equals(this.rootPath, rootPath);
  }

  async persistDeleteConfirmationChoice(settingKey, confirmation) {
    if (!confirmation?.dontAskAgain) return true;
    try {
      const saved = await SETTINGS_SET(settingKey, false);
      if (!saved)
        console.error(`[Settings] Could not save ${settingKey}.`);
      return saved;
    } catch (error) {
      console.error(`[Settings] Could not save ${settingKey}.`, error);
      return false;
    }
  }

  moveToTrash(file) {
    return this.runFileRemoval(file, "trash");
  }

  permanentlyDelete(file) {
    return this.runFileRemoval(file, "permanent-delete");
  }

  runFileRemoval(file, action) {
    if (
      !file ||
      !["file", "folder"].includes(file.type) ||
      typeof file.path !== "string" ||
      !file.path ||
      !this.rootPath ||
      this.workspaceSwitching ||
      this.deleteExplorerDestroyed ||
      NCEPath.equals(file.path, this.rootPath) ||
      !NCEPath.isInside(file.path, this.rootPath)
    ) return Promise.resolve(false);

    if (this.pendingDeleteOperation) {
      return NCEPath.equals(this.pendingDeleteOperation.path, file.path) &&
        this.pendingDeleteOperation.action === action
        ? this.pendingDeleteOperation.promise
        : Promise.resolve(false);
    }

    const rootPath = this.rootPath;
    const generation = this.deleteWorkspaceGeneration || 0;
    let promise;
    promise = this.performFileRemoval(file, action, rootPath, generation)
      .catch((error) => {
        console.error("Error deleting entry:", error);
        return false;
      })
      .finally(() => {
        if (this.pendingDeleteOperation?.promise === promise)
          this.pendingDeleteOperation = null;
      });
    this.pendingDeleteOperation = { path: file.path, action, promise };
    return promise;
  }

  async performFileRemoval(file, action, rootPath, generation) {
    if (!this.isDeleteRequestCurrent(rootPath, generation)) return false;

    const confirmMove = action === "trash" &&
      SETTINGS_GET("files.confirmMoveToTrash") !== false;
    // Keep a confirmation for every folder while confirmation is enabled, and
    // always for folders when disabled because their contents may be recursive.
    const confirmPermanent = action === "permanent-delete" &&
      (file.type === "folder" ||
        SETTINGS_GET("files.confirmPermanentDelete") !== false);
    if (confirmMove || confirmPermanent) {
      const confirmation = await this.showDeleteConfirmation(file, { action });
      if (!this.isDeleteRequestCurrent(rootPath, generation) ||
          !confirmation?.confirmed) return false;
      if (action === "trash") {
        const preferenceSaved = await this.persistDeleteConfirmationChoice(
          "files.confirmMoveToTrash",
          confirmation,
        );
        if (confirmation.dontAskAgain && !preferenceSaved) {
          if (typeof alert === "function")
            alert("The confirmation preference could not be saved. The item was not moved, and confirmations remain enabled.");
          return false;
        }
      }
      if (!this.isDeleteRequestCurrent(rootPath, generation)) return false;
    }

    if (
      typeof this.editor.tabManager.prepareFilesForDeletion === "function" &&
      !(await this.editor.tabManager.prepareFilesForDeletion(file.path))
    ) return false;
    if (!this.isDeleteRequestCurrent(rootPath, generation)) return false;

    this.showDeleteProgress(action);
    let result;
    try {
      result = action === "trash"
        ? await this.fileOperations.moveToTrash(file.path)
        : await this.fileOperations.permanentlyDelete(file.path);
    } catch (error) {
      console.warn("File removal IPC failed", {
        action,
        code: error?.code || "IPC_ERROR",
      });
      result = {
        success: false,
        code: "OPERATION_FAILED",
        error: action === "trash"
          ? "The system could not move this item to the Trash."
          : "The item could not be permanently deleted.",
      };
    } finally {
      this.closeDeleteProgress();
    }
    if (!result?.success) {
      if (result?.code === "SOURCE_NOT_FOUND") return false;
      if (typeof alert === "function") {
        alert(result?.error || (action === "trash"
          ? "Unable to move the item to the Trash."
          : "Unable to permanently delete the item."));
      }
      return false;
    }

    const removedPath = file.path;
    clearTimeout(this.localRemovalTargets.get(removedPath));
    let removalTimer;
    removalTimer = setTimeout(() => {
      if (this.localRemovalTargets.get(removedPath) === removalTimer)
        this.localRemovalTargets.delete(removedPath);
    }, 5000);
    removalTimer?.unref?.();
    this.localRemovalTargets.set(removedPath, removalTimer);
    this.editor.quickOpen?.invalidate?.(rootPath);
    this.editor.tabManager.markFileAsDeleted(file.path);
    if (this.isDeleteRequestCurrent(rootPath, generation))
      await this.refreshFolder(NCEPath.dirname(file.path));
    return true;
  }

  setClipboard(file, mode) {
    this.clipboard = {
      path: file.path,
      type: file.type,
      name: file.name,
      mode,
    };
  }

  async pasteEntry(targetFolderPath) {
    if (!this.clipboard || !targetFolderPath) return;

    if (
      this.clipboard.type === "folder" &&
      (targetFolderPath === this.clipboard.path ||
        NCEPath.isInside(targetFolderPath, this.clipboard.path))
    ) {
      alert("You can't paste a folder into itself.");
      return;
    }

    const separator = String(targetFolderPath).includes("\\") ? "\\" : "/";
    let destPath = `${targetFolderPath}${targetFolderPath.endsWith(separator) ? "" : separator}${this.clipboard.name}`;

    try {
      const exists = await this.fileOperations.pathExists(destPath);
      if (exists) {
        const isFile = this.clipboard.type === "file";
        const dotIndex = isFile ? this.clipboard.name.lastIndexOf(".") : -1;
        const ext = dotIndex > 0 ? this.clipboard.name.slice(dotIndex) : "";
        const base =
          dotIndex > 0
            ? this.clipboard.name.slice(0, dotIndex)
            : this.clipboard.name;
        destPath = `${targetFolderPath}${targetFolderPath.endsWith(separator) ? "" : separator}${base} copy${ext}`;
      }

      const sourcePath = this.clipboard.path;
      const sourceFile =
        this.clipboard.type === "file"
          ? this.editor.tabManager.getFileByPath?.(sourcePath)
          : null;
      let workingCopy;
      if (sourceFile?.isLoaded && !sourceFile.loadError) {
        if (typeof sourceFile.serializeContent !== "function") {
          alert("The open working copy cannot be copied safely.");
          return;
        }
        workingCopy = sourceFile.serializeContent();
      } else if (sourceFile?.isSaved === false) {
        alert(
          "The open working copy is not fully loaded and cannot be copied safely.",
        );
        return;
      }

      const result =
        this.clipboard.mode === "cut"
          ? await this.fileOperations.move(sourcePath, destPath)
          : await this.fileOperations.copy(sourcePath, destPath);

      if (!result?.success) {
        alert(result?.error || "Impossible de coller l'élément.");
        return;
      }

      if (workingCopy !== undefined) {
        const destination = await this.fileOperations.createFile(
          NCEPath.dirname(destPath),
          NCEPath.basename(destPath),
          workingCopy,
          true,
        );
        if (!destination?.success) {
          alert(destination?.error || "Unable to persist the working copy.");
          if (this.clipboard.mode === "cut")
            await this.editor.tabManager.updateFilePath(sourcePath, destPath);
          return;
        }
      }

      const sourceParent = NCEPath.dirname(sourcePath);

      if (this.clipboard.mode === "cut") {
        await this.editor.tabManager.updateFilePath(sourcePath, destPath);
        if (NCEPath.isInside(this.activeFilePath, sourcePath))
          this.activeFilePath = NCEPath.rebase(
            this.activeFilePath,
            sourcePath,
            destPath,
          );
        this.clipboard = null;
        await this.refreshFolder(sourceParent);
      }

      await this.refreshFolder(targetFolderPath);
    } catch (error) {
      console.error("Error pasting entry:", error);
    }
  }

  async duplicateEntry(file) {
    try {
      const result = await this.fileOperations.duplicate(file.path);
      if (!result?.success) {
        alert(result?.error || "Impossible de dupliquer l'élément.");
        return;
      }
      const parentPath = NCEPath.dirname(file.path);
      await this.refreshFolder(parentPath);
    } catch (error) {
      console.error("Error duplicating entry:", error);
    }
  }
}
FileExplorer.ROW_HEIGHT = 22;
