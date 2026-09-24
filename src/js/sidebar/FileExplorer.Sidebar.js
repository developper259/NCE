class FileExplorer extends Sidebar {
  constructor(editor) {
    super("file-explorer", "File Explorer", "fi fi-rr-folder", "left", editor);

    this.activeFilePath = null;
    this.files = [];
    this.rootPath = "";
    this.projectName = "";

    this.projectExpanded = true;
    this.isLoaded = false;
    this.workspaceSwitching = false;
    this.pendingScrollTop = 0;

    this.clipboard = null;

    this.editingState = null;

    this.fileOperations = new FileOperations();

    this.setupFileSystemWatcher();

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
    window.api.onFileSystemChange((data) => {
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

    for (const change of changes) {
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
    }

    const dirPaths = new Set(changes.map((change) => change.dirPath));

    if (dirPaths.has(this.rootPath)) {
      await this.loadFiles(this.getExpandedPaths(this.files));
      this.refresh();
      return;
    }

    for (const dirPath of dirPaths) {
      this.refreshFolderIfLoaded(dirPath);
    }
  }

  refreshFolderIfLoaded(dirPath) {
    const refreshRecursive = (files) => {
      for (const file of files) {
        if (file.type === "folder" && file.path === dirPath) {
          if (file.expanded) {
            this.loadFolderContent(dirPath).then((newChildren) => {
              file.children = newChildren;
              this.refresh();
            });
            return true;
          }
        }
        if (file.children && refreshRecursive(file.children)) {
          return true;
        }
      }
      return false;
    };

    refreshRecursive(this.files);
  }

  async loadFiles(expandedPaths = new Set()) {
    const rootPath = this.rootPath;
    if (!rootPath) return false;
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
      const newFiles = items.map((item) => ({
        name: item.name,
        type: item.type,
        path: item.path,
        expanded: false,
        children: item.type === "folder" ? [] : undefined,
      }));

      if (expandedPaths.size > 0) {
        await this.restoreExpandedFolders(newFiles, expandedPaths);
      }

      this.files = newFiles;
      this.isLoaded = true;
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

  async loadProject(projectPath) {
    if (!projectPath) return false;
    const status = await this.fileOperations.pathStatus(projectPath);
    if (!status?.exists || !status.isDirectory) {
      if (status?.code && status.code !== "SOURCE_NOT_FOUND")
        console.error("Unable to open workspace:", status);
      return false;
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
    this.refresh();

    this.editor.events.callEvent(Events.ON_OPEN_PROJECT, {
      rootPath: this.rootPath,
      projectName: this.projectName,
    });
    return true;
  }

  resetWorkspaceState() {
    this.editor.quickOpen?.invalidate(this.rootPath);
    this.cancelEdit({ refresh: false });
    this.rootPath = "";
    this.projectName = "";
    this.files = [];
    this.activeFilePath = null;
    this.isLoaded = false;
    this.clipboard = null;
  }

  async invalidateWorkspace() {
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
      return items.map((item) => ({
        name: item.name,
        type: item.type,
        path: item.path,
        expanded: false,
        children: item.type === "folder" ? [] : undefined,
      }));
    } catch (error) {
      console.error("Error loading folder content:", error);
      return [];
    }
  }

  async closeProject({ switching = false } = {}) {
    if (!this.rootPath) return;

    if (!switching) {
      if (!(await this.editor.tabManager.prepareForQuit())) return false;
      await this.editor.statesManager.saveWorkspaceState(this.rootPath);
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
    if (this.activeFilePath) {
      if (!this.editor.tabManager.getFileByPath(this.activeFilePath)) {
        this.activeFilePath = null;
      }
    }

    const container = document.createElement("div");
    container.className = "file-explorer-container";
    const menu = this.editor.sidebarManager?.leftScroller?.menuOBJ;
    if (menu) menu.scrollTop = this.pendingScrollTop;

    const mainTitle = document.createElement("div");
    mainTitle.className = "sidebar-main-title";
    mainTitle.textContent = "EXPLORER";
    container.appendChild(mainTitle);

    const projectHeader = document.createElement("div");
    projectHeader.className = "sidebar-project-header";

    const arrow = document.createElement("i");
    arrow.className = `folder-arrow fi fi-rr-angle-small-right ${this.projectExpanded ? "expanded" : ""}`;
    projectHeader.appendChild(arrow);

    const titleSpan = document.createElement("span");
    titleSpan.textContent = this.projectName
      ? this.projectName.toUpperCase()
      : "NO FOLDER OPENED";
    projectHeader.appendChild(titleSpan);

    projectHeader.addEventListener("click", () => {
      this.projectExpanded = !this.projectExpanded;
      this.refresh();
    });

    projectHeader.addEventListener("contextmenu", (e) => {
      if (this.rootPath) {
        e.preventDefault();
        this.editor.contextMenuManager.openContextMenu(
          "file-explorer-project",
          null,
        );
      }
    });

    container.appendChild(projectHeader);

    if (this.projectExpanded) {
      const treeContainer = document.createElement("div");
      treeContainer.className = "file-tree";

      treeContainer.addEventListener("contextmenu", (e) => {
        if (e.target === treeContainer && this.rootPath) {
          e.preventDefault();
          this.editor.contextMenuManager.openContextMenu(
            "file-explorer-background",
            null,
          );
        }
      });

      if (!this.rootPath) {
        this.renderNoFolderState(treeContainer);
      } else if (this.files.length === 0) {
        this.renderEmptyFolderState(treeContainer);
      } else {
        this.renderFiles(this.files, 0, treeContainer);
      }
      container.appendChild(treeContainer);
    }

    return container;
  }

  restoreScrollState(state) {
    this.pendingScrollTop = Number.isFinite(state?.scrollTop)
      ? Math.max(0, state.scrollTop) : 0;
    const scroller = this.editor.sidebarManager?.leftScroller;
    if (scroller?.menuOBJ) {
      scroller.menuOBJ.scrollTop = this.pendingScrollTop;
      scroller.refresh();
    }
  }

  renderNoFolderState(container) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state-message";
    emptyState.textContent = "You have not yet opened a folder.";

    const openBtn = document.createElement("button");
    openBtn.className = "open-folder-btn";
    openBtn.textContent = "Open Folder";
    openBtn.addEventListener("click", this.selectFolder.bind(this));
    emptyState.appendChild(openBtn);
    container.appendChild(emptyState);
  }

  renderEmptyFolderState(container) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state-message empty-folder-message";
    emptyState.textContent = "Folder empty";
    container.appendChild(emptyState);
  }

  renderFiles(files, depth, container) {
    for (const file of files) {
      if (this.editingState && this.editingState.target === file) {
        this.renderEditableRow(file, depth, container);
        if (file.type === "folder" && file.expanded && file.children) {
          this.renderFiles(file.children, depth + 1, container);
        }
        continue;
      }

      const fileItem = document.createElement("div");
      fileItem.className = `file-item ${file.type}`;
      fileItem.dataset.path = file.path;

      fileItem.style.setProperty("--depth", depth);

      if (file.path === this.activeFilePath) {
        fileItem.classList.add("active-file");
      }

      if (file.type === "folder") {
        const arrowElement = document.createElement("i");
        arrowElement.className = `folder-arrow fi fi-rr-angle-small-right ${file.expanded ? "expanded" : ""}`;
        fileItem.appendChild(arrowElement);

        const iconElement = document.createElement("i");
        iconElement.className = "fi fi-rr-folder file-icon";
        fileItem.appendChild(iconElement);
      } else {
        const spacer = document.createElement("span");
        spacer.className = "file-spacer";
        fileItem.appendChild(spacer);

        const iconElement = document.createElement("i");
        iconElement.className = `${this.getFileIcon(file.name)} file-icon`;
        fileItem.appendChild(iconElement);
      }

      const nameElement = document.createElement("span");
      nameElement.className = "file-name";
      nameElement.textContent = file.name;
      fileItem.appendChild(nameElement);

      fileItem.addEventListener("click", (e) => {
        e.stopPropagation();
        if (file.type === "folder") {
          this.toggleFolder(file.path);
        } else {
          this.openFile(file.path);
        }
      });

      fileItem.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();

        const menuName =
          file.type === "folder"
            ? "file-explorer-folder"
            : "file-explorer-file";

        this.editor.contextMenuManager.openContextMenu(menuName, file);
      });

      container.appendChild(fileItem);

      if (file.type === "folder" && file.expanded && file.children) {
        this.renderFiles(file.children, depth + 1, container);
      }
    }
  }

  renderEditableRow(file, depth, container) {
    const fileItem = document.createElement("div");
    fileItem.className = `file-item ${file.type} editing`;
    fileItem.style.setProperty("--depth", depth);

    const spacer = document.createElement("span");
    spacer.className = "file-spacer";
    fileItem.appendChild(spacer);

    const iconElement = document.createElement("i");
    iconElement.className =
      file.type === "folder"
        ? "fi fi-rr-folder file-icon"
        : `${this.getFileIcon(file.name || "")} file-icon`;
    fileItem.appendChild(iconElement);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "file-name-input";
    input.value = file.name || "";
    input.spellcheck = false;
    fileItem.appendChild(input);
    container.appendChild(fileItem);

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
    this.activeFilePath = path;
    this.refresh();
  }

  async onOpen() {
    const expandedSet = this.getExpandedPaths(this.files);
    await this.loadFiles(expandedSet);
    this.refresh();
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
    this.editor.statesManager.persistenceSuspended = true;
    try {
      await this.editor.tabManager.closeFiles({ skipPrepare: true });
      this.editor.searchSidebar?.resetWorkspace?.();
      if (this.rootPath) await this.closeProject({ switching: true });

      this.isLoaded = false;
      if (!(await this.loadProject(folderPath))) return false;
    } finally {
      this.editor.statesManager.persistenceSuspended = false;
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
        if (file.path === folderPath && file.type === "folder") {
          file.expanded = !file.expanded;
          if (file.expanded && (!file.children || file.children.length === 0)) {
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
    if (folderPath === this.rootPath) {
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

  async deleteEntry(file) {
    const label = file.type === "folder" ? "folder" : "file";
    if (!confirm(`Are you sure you want to delete ${label} "${file.name}"?`)) {
      return;
    }

    try {
      if (
        file.type === "file" &&
        typeof this.editor.tabManager.prepareFilesForDeletion === "function" &&
        !(await this.editor.tabManager.prepareFilesForDeletion(file.path))
      ) {
        return;
      }
      let result = await this.fileOperations.delete(file.path, false);
      if (
        !result?.success &&
        file.type === "folder" &&
        result.code === "FOLDER_NOT_EMPTY"
      ) {
        if (
          !confirm(
            `Folder "${file.name}" is not empty.\n\n` +
              "Deleting it will permanently delete all files and subfolders inside it.\n\n" +
              "Do you really want to continue?",
          )
        ) {
          return;
        }
        if (
          typeof this.editor.tabManager.prepareFilesForDeletion ===
            "function" &&
          !(await this.editor.tabManager.prepareFilesForDeletion(file.path))
        ) {
          return;
        }
        result = await this.fileOperations.delete(file.path, true);
      }
      if (!result?.success) {
        alert(
          result?.code === "FOLDER_NOT_EMPTY"
            ? `Folder "${file.name}" is not empty.`
            : result?.error || "Unable to delete the item.",
        );
        return;
      }

      this.editor.tabManager.markFileAsDeleted(file.path);

      const parentPath = NCEPath.dirname(file.path);
      await this.refreshFolder(parentPath);
    } catch (error) {
      console.error("Error deleting entry:", error);
    }
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
