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
        .replace(/\\/g, '/')
        .replace(/\/$/, '') 
        .split('/')
        .filter(segment => segment.length > 0);

    this.rootPath = projectPath;
    this.projectName = segments.pop() || "Project";
    
    await this.loadFiles();
    this.refresh();
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

    this.activeFilePath = filePath;

    this.editor.tabManager.openFileWithPath(filePath);

    this.refresh();

    const newTreeContainer = this.element?.querySelector(".file-tree");
    if (newTreeContainer) {
      newTreeContainer.scrollTop = scrollTop;
    }
  }

  getFileIcon(filename) {
    const ext = filename.split(".").pop().toLowerCase();
    const icons = {
      js: "fi fi-brands-js",
      jsx: "fi fi-brands-react",
      ts: "fi fi-brands-js",
      tsx: "fi fi-brands-react",
      html: "fi fi-brands-html5",
      css: "fi fi-brands-css3",
      scss: "fi fi-brands-sass",
      sass: "fi fi-brands-sass",
      less: "fi fi-brands-less",
      json: "fi fi-rr-file-code",
      xml: "fi fi-rr-file-code",
      yaml: "fi fi-rr-file-code",
      yml: "fi fi-rr-file-code",
      md: "fi fi-brands-markdown",
      txt: "fi fi-rr-file-text",
      png: "fi fi-rr-image",
      svg: "fi fi-rr-image",
      jpg: "fi fi-rr-image",
      jpeg: "fi fi-rr-image",
      gif: "fi fi-rr-image",
      ico: "fi fi-rr-image",
      webp: "fi fi-rr-image",
      pdf: "fi fi-rr-file-pdf",
      doc: "fi fi-rr-file-word",
      docx: "fi fi-rr-file-word",
      xls: "fi fi-rr-file-excel",
      xlsx: "fi fi-rr-file-excel",
      ppt: "fi fi-rr-file-powerpoint",
      pptx: "fi fi-rr-file-powerpoint",
      zip: "fi fi-rr-file-zip",
      rar: "fi fi-rr-file-zip",
      tar: "fi fi-rr-file-zip",
      gz: "fi fi-rr-file-zip",
      mp3: "fi fi-rr-file-audio",
      mp4: "fi fi-rr-file-video",
      wav: "fi fi-rr-file-audio",
      ogg: "fi fi-rr-file-audio",
      mov: "fi fi-rr-file-video",
      avi: "fi fi-rr-file-video",
      mkv: "fi fi-rr-file-video",
      py: "fi fi-brands-python",
      rb: "fi fi-brands-ruby",
      php: "fi fi-brands-php",
      java: "fi fi-brands-java",
      go: "fi fi-brands-golang",
      rs: "fi fi-brands-rust",
      cpp: "fi fi-rr-file-code",
      c: "fi fi-rr-file-code",
      h: "fi fi-rr-file-code",
      cs: "fi fi-brands-c-sharp",
      swift: "fi fi-brands-swift",
      kt: "fi fi-brands-kotlin",
      vue: "fi fi-brands-vue",
      svelte: "fi fi-brands-svelte",
      angular: "fi fi-brands-angular",
      dockerfile: "fi fi-brands-docker",
      docker: "fi fi-brands-docker",
      gitignore: "fi fi-brands-git",
      env: "fi fi-rr-file-code",
      lock: "fi fi-rr-lock",
      sql: "fi fi-rr-database",
      db: "fi fi-rr-database",
      sqlite: "fi fi-rr-database",
      sh: "fi fi-brands-linux",
      bash: "fi fi-brands-linux",
      zsh: "fi fi-brands-linux",
      ps1: "fi fi-brands-powershell",
      bat: "fi fi-brands-windows",
      cmd: "fi fi-brands-windows",
      exe: "fi fi-brands-windows",
      dll: "fi fi-brands-windows",
      app: "fi fi-brands-apple",
      dmg: "fi fi-brands-apple",
      apk: "fi fi-brands-android",
      ipa: "fi fi-brands-apple",
      deb: "fi fi-brands-linux",
      rpm: "fi fi-brands-linux",
      ttf: "fi fi-rr-font",
      otf: "fi fi-rr-font",
      woff: "fi fi-rr-font",
      woff2: "fi fi-rr-font",
      eot: "fi fi-rr-font",
    };
    return icons[ext] || "fi fi-rr-file";
  }
}
