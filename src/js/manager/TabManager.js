class tabManager {
  constructor(e) {
    this.editor = e;
    this.files = []; //opened files
    this.activeFile = null; //file on editor
    this.emptyName = "New file";

    this.tabsOBJ = getElement(".file-manager");

    this.idCounter = 0;
    this.focusGeneration = 0;

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
    return this.files.find((file) => NCEPath.equals(file.path, path));
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
      if (!file.path || !NCEPath.isInside(file.path, oldPath)) continue;
      // Complete the old-path load before moving its identity.
      if (file.loadingState?.status === "loading") {
        this.editor.fileLoader.cancelLoading(file.path);
        file.isLoaded = false;
        file.contentGeneration++;
      }
      file.path = NCEPath.rebase(file.path, oldPath, newPath);
      file.name = NCEPath.basename(file.path);
      changed = true;
      await this.editor.highlightController.changeLanguage(file,
        await this.editor.highlightController.detectLanguage(file.name));
      if (file === this.activeFile && !file.isLoaded) await this.setFocusFile(file);
    }

    if (changed) {
      this.editor.fileExplorer.setActiveFile(this.activeFile?.path);
      this.refresh();
    }
  }

  markFileAsDeleted(path) {
    if (!path) return;
    let changed = false;

    for (const file of this.files) {
      if (!file.path) continue;

      if (NCEPath.isInside(file.path, path)) {
        file.deletedFromDisk = true;
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

      // Focusing an already-open tab must not mark unsaved edits as saved.
    }

    this.editor.events.callEvent(Events.ON_OPEN_FILE, {
      files: files,
      activeFile: lastAddedFile,
    });
    if (!isSetFocusFile) this.editor.refreshAll();
  }

  async prepareForQuit() {
    const dirtyFiles = this.files.filter(
      (file) => !file.isSaved && !(file.isEmpty() && !file.hasPath()),
    );

    for (const file of dirtyFiles) {
      const choice = await this.editor.savePopupManager.confirmClose(file.id);
      if (choice === "cancel") return false;
      if (choice === "save" && (!(await file.save()) || !file.isSaved)) return false;
    }

    return true;
  }

  async closeFiles() {
    if (!(await this.prepareForQuit())) return false;
    for (const file of this.files) this.editor.fileLoader.cancelLoading(file.path);
    this.editor.highlightController.closeAllFiles();
    this.files = [];
    this.activeFile = undefined;
    this.editor.fileExplorer.activeFilePath = null;
    this.editor.searchController.close();
    this.editor.events.callEvent(Events.ON_CLOSE_FILE, {
      file: null,
      activeFile: undefined,
    });
    if (!this.editor.isOnInit) this.editor.refreshAll();
    return true;
  }

  async closeFile(id) {
    const file = this.getFileByID(id);
    if (!file) return;

    if (!file.isSaved) {
      if (!(file.isEmpty() && !file.hasPath())) {
        const choice = await this.editor.savePopupManager.confirmClose(id);
        if (choice === "cancel") return;
        if (choice === "save") {
          if (this.activeFile?.id !== id) await this.setFocusFile(file);
          await file.save();
          if (!file.isSaved) return;
        }
      }
    }

    if (id == this.activeFile?.id) {
      if (this.files.length > 1) {
        const index = this.getFileIndexByID(id);
        if (index == 0) await this.setFocusFile(this.files[index + 1]);
        else await this.setFocusFile(this.files[index - 1]);
      }
    }

    this.editor.fileLoader.cancelLoading(file.path);
    file.contentGeneration++;
    await this.editor.highlightController.closeFile(file);
    this.removeFileByID(id);
    if (!this.files.length) {
      this.activeFile = undefined;
      this.editor.fileExplorer.activeFilePath = null;
      this.editor.searchController.close();
    }

    this.editor.events.callEvent(Events.ON_CLOSE_FILE, {
      file: file,
      activeFile: this.activeFile,
    });
    if (!this.editor.isOnInit) this.editor.refreshAll();
  }

  async closeActiveFile() {
    if (this.activeFile) {
      return this.closeFile(this.activeFile.id);
    }
    return false;
  }

  async setFocusFile(file) {
    if (!file) return;
    const focusGeneration = ++this.focusGeneration;
    this.activeFile = file;

    this.editor.lineController.dirtyLines.clear();
    this.editor.highlightController.dirtyLines.clear();

    this.editor.fileExplorer.setActiveFile(file.path);

    if (!file.isLoaded) {
      await file.loadLanguage();
      await file.loadContent();
    }

    if (focusGeneration !== this.focusGeneration) return;

    await this.editor.highlightController.openFile(file);

    if (focusGeneration !== this.focusGeneration) return;

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
      this.editor.fileLoader.cancelLoading(file.path);
      file.contentGeneration++;
      await this.editor.highlightController.invalidateFile(file);
      if (file === this.activeFile) {
        file.isLoaded = false;

        await file.loadLanguage();
        await file.loadContent();
        await this.editor.highlightController.openFile(file);

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
    let name = NCEPath.basename(path);
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
      let name = NCEPath.basename(file);
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
        let name = NCEPath.basename(file);
        let node = new FileNode(this.editor, this.getNextID(), name, file);
        result.push(node);
      }
    }

    return result;
  }

  async selectNewFile() {
    return this.editor.api.selectNewFile(this.activeFile?.name || this.emptyName);
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

    // Auto Save owns persistence while enabled. Keep the close affordance
    // stable instead of flashing the transient unsaved dot during its write.
    if (file.isSaved || (file.autoSave === true && !file.deletedFromDisk)) {
      const btnSpan = document.createElement("span");
      btnSpan.className = "file-el-btn file-saved";

      const img = document.createElement("img");
      img.src = "../assets/icons/close.svg";
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
    this.editor.titleBar?.refresh();

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
