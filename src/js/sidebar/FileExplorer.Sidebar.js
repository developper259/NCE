class FileExplorer extends Sidebar {
  constructor(editor) {
    super("file-explorer", "File Explorer", "fi fi-rr-folder", "left" ,editor);

    this.activeFilePath = null;
    this.files = [];
    this.rootPath = "";
    this.projectName = "";

    this.projectExpanded = true;
    this.isLoaded = false;

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
      this.handleFileSystemChanges(data);
    });
  }

  handleFileSystemChanges(changes) {
    if (!this.rootPath || !Array.isArray(changes) || changes.length === 0) {
      return;
    }

    for (const change of changes) {
      if (change.event === "change") {
        this.editor.tabManager.reloadFileFromDisk(change.filePath);
      } else if (change.event === "unlink" || change.event === "unlinkDir") {
        this.editor.tabManager.markFileAsDeleted(change.filePath);
      }
    }

    const dirPaths = new Set(changes.map((change) => change.dirPath));

    if (dirPaths.has(this.rootPath)) {
      this.loadFiles(this.getExpandedPaths(this.files)).then(() => {
        this.refresh();
      });
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
    if (!this.rootPath) return;
    try {
      const items = await window.api.getFolderContent(this.rootPath);
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
    } catch (error) {
      console.error("Error loading files:", error);
      this.files = [];
    }
  }

  async loadProject(projectPath) {
    if (!projectPath) return;
    const segments = projectPath
      .replace(/\\/g, "/")
      .replace(/\/$/, "")
      .split("/")
      .filter((segment) => segment.length > 0);

    this.rootPath = projectPath;
    this.projectName = segments.pop() || "Project";

    await window.api.startWatching(projectPath);

    await this.loadFiles();
    this.refresh();

    this.editor.events.callEvent(Events.ON_OPEN_PROJECT, {
      rootPath: this.rootPath,
      projectName: this.projectName,
    });
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

  async closeProject() {
    if (!this.rootPath) return;

    await window.api.stopWatching();

    const previousRootPath = this.rootPath;
    const previousProjectName = this.projectName;

    this.rootPath = "";
    this.projectName = "";
    this.files = [];
    this.activeFilePath = null;
    this.isLoaded = false;
    this.clipboard = null;
    this.editingState = null;

    this.refresh();

    if (Events.ON_CLOSE_PROJECT) {
      this.editor.events.callEvent(Events.ON_CLOSE_PROJECT, {
        rootPath: previousRootPath,
        projectName: previousProjectName,
      });
    }
  }

  render() {
    if (this.activeFilePath) {
      if (!this.editor.tabManager.getFileByPath(this.activeFilePath)) {
        this.activeFilePath = null;
      }
    }

    const container = document.createElement("div");
    container.className = "file-explorer-container";

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

      if (this.files.length === 0) {
        const emptyState = document.createElement("div");
        emptyState.className = "empty-state-message";
        emptyState.textContent = "You have not yet opened a folder.";

        const openBtn = document.createElement("button");
        openBtn.className = "open-folder-btn";
        openBtn.textContent = "Open Folder";
        openBtn.addEventListener("click", this.selectFolder.bind(this));

        emptyState.appendChild(openBtn);
        treeContainer.appendChild(emptyState);
      } else {
        this.renderFiles(this.files, 0, treeContainer);
      }
      container.appendChild(treeContainer);
    }

    return container;
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

    let settled = false;
    const settle = (commit) => {
      if (settled) return;
      settled = true;
      if (commit) {
        this.commitEdit(input.value, file);
      } else {
        this.editingState = null;
        if (file.isNew) this.removePlaceholder(file);
        this.refresh();
      }
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        settle(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        settle(false);
      }
    });
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("blur", () => settle(true));

    requestAnimationFrame(() => {
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
    if (folderPath) {
      this.isLoaded = false;
      this.loadProject(folderPath);
    }
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
    if (!expandedSet || !files || expandedSet.length === 0) return;
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
    this.editingState = { mode: "create", target: placeholder };
    this.refresh();
  }

  startRename(file) {
    this.editingState = { mode: "rename", target: file };
    this.refresh();
  }

  async commitEdit(rawValue, target) {
    const name = rawValue.trim();

    if (!name) {
      this.editingState = null;
      if (target.isNew) this.removePlaceholder(target);
      this.refresh();
      return;
    }

    if (target.isNew) {
      const parentPath = target.parentPath;
      this.editingState = null;
      try {
        const result =
          target.type === "folder"
            ? await this.fileOperations.createFolder(parentPath, name)
            : await this.fileOperations.createFile(parentPath, name);

        if (!result?.success) {
          alert(result?.error || "Impossible de créer l'élément.");
          this.removePlaceholder(target);
          this.refresh();
          return;
        }

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
        this.removePlaceholder(target);
        this.refresh();
      }
      return;
    }

    this.editingState = null;

    if (name === target.name) {
      this.refresh();
      return;
    }

    const parentDir = target.path.substring(0, target.path.lastIndexOf("/"));
    const newPath = `${parentDir}/${name}`;

    try {
      const result = await this.fileOperations.rename(target.path, newPath);
      if (!result?.success) {
        alert(result?.error || "Impossible de renommer l'élément.");
        this.refresh();
        return;
      }

      if (this.activeFilePath === target.path) {
        this.activeFilePath = newPath;
      }
      this.editor.tabManager.updateFilePath(target.path, newPath);

      target.name = name;
      target.path = newPath;
      this.refresh();
    } catch (error) {
      console.error("Error renaming entry:", error);
      this.refresh();
    }
  }

  async deleteEntry(file) {
    const label = file.type === "folder" ? "folder" : "file";
    if (!confirm(`Are you sure you want to delete ${label} "${file.name}"?`)) {
      return;
    }

    try {
      const result = await this.fileOperations.delete(file.path);
      if (!result?.success) {
        alert(result?.error || "Impossible de supprimer l'élément.");
        return;
      }

      this.editor.tabManager.markFileAsDeleted(file.path);

      const parentPath = file.path.substring(0, file.path.lastIndexOf("/"));
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
        targetFolderPath.startsWith(`${this.clipboard.path}/`))
    ) {
      alert("You can't paste a folder into itself.");
      return;
    }

    let destPath = `${targetFolderPath}/${this.clipboard.name}`;

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
        destPath = `${targetFolderPath}/${base} copy${ext}`;
      }

      const result =
        this.clipboard.mode === "cut"
          ? await this.fileOperations.move(this.clipboard.path, destPath)
          : await this.fileOperations.copy(this.clipboard.path, destPath);

      if (!result?.success) {
        alert(result?.error || "Impossible de coller l'élément.");
        return;
      }

      const sourceParent = this.clipboard.path.substring(
        0,
        this.clipboard.path.lastIndexOf("/"),
      );

      if (this.clipboard.mode === "cut") {
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
      const parentPath = file.path.substring(0, file.path.lastIndexOf("/"));
      await this.refreshFolder(parentPath);
    } catch (error) {
      console.error("Error duplicating entry:", error);
    }
  }
}
