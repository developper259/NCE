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

  openFile(file) {
    if (!file) return;
    this.openFiles([file]);
  }

  async openFiles(files) {
    if (files.length === 0) return;
    let lastAddedFile = null;

    for (let file of files) {
      if (file.path) {
        const f = this.getFileByPath(file.path);
        if (f) {
          continue;
        }
      }

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
      this.setFocusFile(lastAddedFile);

      this.activeFile.setIsSaved(true);
      this.editor.lineController.restoreScroll();
      this.editor.refreshAll();
    }

    this.editor.events.callEvent(Events.ON_OPEN_FILE, {
      files: files,
      activeFile: lastAddedFile,
    });
  }

  closeFiles() {
    this.files = [];
    this.activeFile = undefined;
    this.editor.refreshAll();
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
      if (this.files.length != 1) {
        const index = this.getFileIndexByID(id);
        if (index == 0) this.setFocusFile(this.files[index + 1]);
        else this.setFocusFile(this.files[index - 1]);
      }
    }

    if (this.files.length != 1) this.removeFileByID(id);
    else {
      this.closeFiles();
    }
    this.editor.events.callEvent(Events.ON_CLOSE_FILE, {
      file: file,
      activeFile: this.activeFile,
    });
    this.editor.refreshAll();
  }

  closeActiveFile() {
    if (this.activeFile) {
      this.closeFile(this.activeFile.id);
    }
  }

  async setFocusFile(file) {
    if (!file) return;
    this.activeFile = file;

    this.editor.fileExplorer.setActiveFile(file.path);

    if (!file.isLoaded) {
      await file.loadContent();
    }

    this.editor.cursor.setCursorPosition(file.row, file.column);

    this.editor.refreshAll();
  }

  openFileWithPath(path) {
    let name = path.split("/").pop();
    let node = new FileNode(this.editor, this.getNextID(), name, path);
    this.openFile(node);
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

  toHTMLFile(file) {
    if (!file) return "";
    let arg = "";
    if (this.activeFile && this.activeFile.id === file.id) arg = "file-active";

    let btn = "";
    if (file.isSaved)
      btn =
        '<span class="file-el-btn file-saved"><img src="../../assets/icons/close.svg" alt="close" class="file-el-btn-img"></span>';
    else btn = '<div class="file-el-btn file-unsaved"></div>';

    let html = `<li class="file-el ${arg}" id="${file.id}">
						<span class="file-el-title">${file.name}</span>
						${btn}
					</li>`;

    return html;
  }

  refresh() {
    let ul = getElement(".file-manager .files-ul");

    let html = "";

    for (let i = 0; i < this.files.length; i++) {
      let file = this.files[i];

      html += this.toHTMLFile(file);
    }

    ul.innerHTML = html;

    if (this.files.length == 0) {
      this.editor.reset();
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
