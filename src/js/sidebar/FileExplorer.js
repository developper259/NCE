class FileExplorer extends Sidebar {
  constructor(editor) {
    super("file-explorer", "File Explorer", "fi fi-rr-folder", editor);
    this.position = "left";

    this.activeFilePath = null;
    this.files = [];
    this.rootPath = "";
    this.projectName = "";

    this.projectExpanded = true;
  }

  async loadFiles() {
    if (!this.rootPath) return;
    try {
      const items = await window.api.getFolderContent(this.rootPath);
      this.files = items.map((item) => ({
        name: item.name,
        type: item.type,
        path: item.path,
        expanded: false,
        children: item.type === "folder" ? [] : undefined,
      }));
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

  render() {
    const container = document.createElement("div");
    container.className = "file-explorer-container";

    // 1. Titre global
    const mainTitle = document.createElement("div");
    mainTitle.className = "sidebar-main-title";
    mainTitle.textContent = "EXPLORER";
    container.appendChild(mainTitle);

    // 2. Header du projet (toujours visible pour pouvoir le rouvrir)
    const projectHeader = document.createElement("div");
    projectHeader.className = "sidebar-project-header";

    // Flèche de collapse (toujours présente pour cliquer)
    const arrow = document.createElement("i");
    arrow.className = `folder-arrow fi fi-rr-angle-small-right ${this.projectExpanded ? "expanded" : ""}`;
    projectHeader.appendChild(arrow);

    // Texte dynamique : nom du projet ou "NO FOLDER OPENED"
    const titleSpan = document.createElement("span");
    titleSpan.textContent = this.projectName
      ? this.projectName.toUpperCase()
      : "NO FOLDER OPENED";
    projectHeader.appendChild(titleSpan);

    projectHeader.addEventListener("click", () => {
      this.projectExpanded = !this.projectExpanded;
      this.refresh();
    });

    container.appendChild(projectHeader);

    // 3. Conteneur du contenu (seulement si projectExpanded est vrai)
    if (this.projectExpanded) {
      const treeContainer = document.createElement("div");
      treeContainer.className = "file-tree";

      if (this.files.length === 0) {
        // --- ÉTAT VIDE ---
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
        // --- ÉTAT REMPLI ---
        this.renderFiles(this.files, 0, treeContainer);
      }
      container.appendChild(treeContainer);
    }

    return container;
  }

  renderFiles(files, depth, container) {
    for (const file of files) {
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

      container.appendChild(fileItem);

      if (file.type === "folder" && file.expanded && file.children) {
        this.renderFiles(file.children, depth + 1, container);
      }
    }
  }

  setActiveFile(path) {
    if (!this.rootPath) return;
    this.activeFilePath = path;
    this.refresh();
  }

  async onOpen() {
    await this.loadFiles();
    this.refresh();
  }

  async selectFolder() {
    const folderPath = await window.api.selectFolder();
    if (folderPath) {
      this.loadProject(folderPath);
    }
  }

  async toggleFolder(folderPath) {
    const treeContainer = this.element?.querySelector(".file-tree");
    const scrollTop = treeContainer ? treeContainer.scrollTop : 0;

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

    const newTreeContainer = this.element?.querySelector(".file-tree");
    if (newTreeContainer) {
      newTreeContainer.scrollTop = scrollTop;
    }
  }

  async openFile(filePath) {
    const treeContainer = this.element?.querySelector(".file-tree");
    const scrollTop = treeContainer ? treeContainer.scrollTop : 0;

    this.editor.tabManager.openFileWithPath(filePath);

    this.setActiveFile(filePath);

    const newTreeContainer = this.element?.querySelector(".file-tree");
    if (newTreeContainer) {
      newTreeContainer.scrollTop = scrollTop;
    }
  }

  getFileIcon(filename) {
    const ext = filename.split(".").pop().toLowerCase();
    return USERCONFIG_FILE_ICONS[ext] || USERCONFIG_FILE_ICONS.default;
  }
}
