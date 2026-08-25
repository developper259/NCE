class tabManager {
  constructor(e) {
    this.editor = e;
    this.files = []; //opened files
    this.activeFile = null; //file on editor
    this.emptyName = "New file";

    this.tabsOBJ = getElement(".file-manager");

    this.idCounter = 0;

    this.refresh();
  }

  getNextID() {
    this.idCounter++;
    return this.idCounter;
  }

  getFileIndexByID(id) {
    return this.files.findIndex((file) => file.id == id);
  }

  getFileByID(id) {
    return this.files.find((file) => file.id == id);
  }

  getFileByPath(path) {
    return this.files.find((file) => file.path == path);
  }

  removeFileByID(id) {
    const index = this.getFileIndexByID(id);
    if (index !== -1) {
      this.files.splice(index, 1);
    }
  }

  async updateFilePath(oldPath, newPath) {
    if (!oldPath || !newPath) return;
    let changed = false;

    for (const file of this.files) {
      if (!file.path) continue;

      if (file.path === oldPath) {
        file.path = newPath;
        file.name = newPath.split("/").pop();
        changed = true;

        await file.loadLanguage();
        this.editor.highlightController.reset();
      } else if (file.path.startsWith(`${oldPath}/`)) {
        file.path = newPath + file.path.slice(oldPath.length);
        changed = true;

        await file.loadLanguage();
        this.editor.highlightController.reset();
      }
    }

    if (changed) this.refresh();
  }

  markFileAsDeleted(path) {
    if (!path) return;
    let changed = false;

    for (const file of this.files) {
      if (!file.path) continue;

      if (file.path === path || file.path.startsWith(`${path}/`)) {
        file.setIsSaved(false);
        changed = true;
      }
    }

    if (changed) this.refresh();
  }

  async openFile(file) {
    if (!file) return;
    return this.openFiles([file]);
  }

  async openFiles(files, isSetFocusFile = true) {
    if (files.length === 0) return;
    let lastAddedFile = null;

    for (let file of files) {
      if (file.path) {
        const f = this.getFileByPath(file.path);
        if (f) {
          lastAddedFile = f;
          continue;
        }
      }

      if (!file.language) await file.loadLanguage();

      if (
        file.hasPath() &&
        this.activeFile &&
        !this.activeFile.hasPath() &&
        this.activeFile.isEmpty()
      ) {
        this.activeFile.replaceFile(file);
        lastAddedFile = this.activeFile;
      } else {
        this.files.push(file);
        lastAddedFile = file;
      }
    }
    if (lastAddedFile) {
      if (isSetFocusFile) await this.setFocusFile(lastAddedFile);

      this.activeFile.setIsSaved(true);
    }

    this.editor.events.callEvent(Events.ON_OPEN_FILE, {
      files: files,
      activeFile: lastAddedFile,
    });
    if (!isSetFocusFile) this.editor.refreshAll();
  }

  closeFiles() {
    requestAnimationFrame(() => {
      delete this.files;
      this.files = [];

      this.activeFile = undefined;
      this.editor.fileExplorer.activeFilePath = null;

      this.editor.searchController.close();

      this.editor.events.callEvent(Events.ON_CLOSE_FILE, {
        file: null,
        activeFile: undefined,
      });

      if (!this.editor.isOnInit) this.editor.refreshAll();
    });
  }

  async closeFile(id) {
    const file = this.getFileByID(id);
    if (!file) return;

    if (!file.isSaved) {
      if (!(file.isEmpty() && !file.hasPath())) {
        const choice = await this.editor.savePopupManager.confirmClose(id);
        if (choice === "cancel") return;
        if (choice === "save") {
          if (this.activeFile?.id !== id) this.setFocusFile(file);
          await file.save();
          if (!file.isSaved) return;
        }
      }
    }

    if (id == this.activeFile.id) {
      if (this.files.length > 1) {
        const index = this.getFileIndexByID(id);
        if (index == 0) this.setFocusFile(this.files[index + 1]);
        else this.setFocusFile(this.files[index - 1]);
      }
    }

    if (this.files.length > 1) this.removeFileByID(id);
    else {
      this.closeFiles();
      return;
    }

    this.editor.events.callEvent(Events.ON_CLOSE_FILE, {
      file: file,
      activeFile: this.activeFile,
    });
    if (!this.editor.isOnInit) this.editor.refreshAll();
  }

  closeActiveFile() {
    if (this.activeFile) {
      this.closeFile(this.activeFile.id);
    }
  }

  async setFocusFile(file) {
    if (!file) return;
    this.activeFile = file;

    this.editor.lineController.dirtyLines.clear();
    this.editor.highlightController.dirtyLines.clear();

    this.editor.fileExplorer.setActiveFile(file.path);

    if (!file.isLoaded) {
      await file.loadContent();
    }

    this.editor.cursorController.setCursorPosition(file.row, file.column);

    if (!this.editor.isOnInit) this.editor.refreshAll();
  }

  async reloadFileFromDisk(path) {
    if (!path) return;

    const file = this.getFileByPath(path);
    if (!file) return;

    if (!file.isSaved) {
      return;
    }

    try {
      if (file === this.activeFile) {
        this.editor.fileLoader.cancelLoading(file.path);
        file.isLoaded = false;

        await file.loadContent();

        this.editor.lineController.markDirtyAll();
        this.editor.lineController.refresh(true);
        this.editor.scrollerManager.refreshAll();
      } else {
        file.isLoaded = false;
      }
    } catch (error) {
      console.error("Error reloading file from disk:", error);
    }
  }

  async openFileWithPath(path) {
    let name = path.split("/").pop();
    let node = new FileNode(this.editor, this.getNextID(), name, path);
    return this.openFile(node);
  }

  createEmptyFile() {
    let node = new FileNode(this.editor, this.getNextID(), this.emptyName, "");
    node.isLoaded = true;
    this.openFile(node);

    return node;
  }

  async selectFile() {
    const file = await this.editor.api.selectFile();
    if (file) {
      let name = file.split("/").pop();
      let node = new FileNode(this.editor, this.getNextID(), name, file);
      return node;
    }

    return undefined;
  }

  async selectFiles() {
    const files = await this.editor.api.selectFiles();
    let result = [];

    if (files) {
      for (let file of files) {
        let name = file.split("/").pop();
        let node = new FileNode(this.editor, this.getNextID(), name, file);
        result.push(node);
      }
    }

    return result;
  }

  async selectNewFile() {
    const file = await this.editor.api.selectNewFile(this.emptyName);

    if (file) {
      let name = file.split("/").pop();
      let node = new FileNode(this.editor, this.getNextID(), name, file);
      return node;
    }

    return undefined;
  }

  createFileOBJ(file) {
    if (!file) return null;

    const li = document.createElement("li");
    li.className = "file-el";
    if (this.activeFile && this.activeFile.id === file.id) {
      li.classList.add("file-active");
    }
    li.id = file.id;

    const titleSpan = document.createElement("span");
    titleSpan.className = "file-el-title";
    titleSpan.textContent = file.name;
    li.appendChild(titleSpan);

    if (file.isSaved) {
      const btnSpan = document.createElement("span");
      btnSpan.className = "file-el-btn file-saved";

      const img = document.createElement("img");
      img.src = "../../assets/icons/close.svg";
      img.alt = "close";
      img.className = "file-el-btn-img";

      btnSpan.appendChild(img);
      li.appendChild(btnSpan);
    } else {
      const btnDiv = document.createElement("div");
      btnDiv.className = "file-el-btn file-unsaved";
      li.appendChild(btnDiv);
    }

    return li;
  }

  refresh() {
    const ul = getElement(".file-manager .files-ul");
    if (!ul) return;

    const fragment = document.createDocumentFragment();

    for (let i = 0; i < this.files.length; i++) {
      const file = this.files[i];
      const fileEl = this.createFileOBJ(file);
      if (fileEl) {
        fragment.appendChild(fileEl);
      }
    }

    ul.replaceChildren(fragment);

    if (this.files.length === 0) {
      if (!this.editor.isOnInit) this.editor.reset();
    } else {
      if (!this.editor.isActive) this.editor.reactive();
    }
  }

  onClick(e) {
    let id = parseInt(e.target.id);
    if (!id && e.target.classList.contains("file-el-title")) {
      id = e.target.parentElement.id;
      if (!id) return;
    }
    let file = this.getFileByID(id);
    this.setFocusFile(file);
  }

  onClickClose(e) {
    const parent = e.target.parentElement;
    let id = parent.id;
    if (!id && e.target.classList.contains("file-el-btn-img")) {
      id = parent.parentElement.id;
      if (!id) return;
    }
    this.closeFile(id);
  }

  getTab(id) {
    return getElement(`.file-manager .file-el[id="${id}"]`);
  }

  hide() {
    if (this.tabsOBJ) {
      this.tabsOBJ.classList.remove("box-bottom");
    }
  }

  show() {
    if (this.tabsOBJ) {
      this.tabsOBJ.classList.add("box-bottom");
    }
  }
}
