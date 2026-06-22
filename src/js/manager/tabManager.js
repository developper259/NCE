class tabManager {
  constructor(e) {
    this.editor = e;
    this.files = []; //opened files
    this.activeFile = null; //file on editor
    this.emptyName = "New file";

    this.refresh();
  }

  getFileIndexByID(id) {
    return this.files.findIndex((file) => file.id == id);
  }
  getFileByID(id) {
    return this.files.find((file) => file.id == id);
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
    for (let file of files) {
      if (
        this.activeFile &&
        !this.activeFile.hasPath() &&
        file.hasPath() &&
        this.activeFile.isEmpty()
      ) {
        this.activeFile.replaceFile(file);
        this.setFocusFile(this.activeFile);
      } else {
        this.files.push(file);
        this.setFocusFile(file);
      }

      this.activeFile.setIsSaved(true);
      await this.activeFile.loadContent();

      const l = this.editor.languageController.getLanaguage(this.activeFile);
      this.setLanguage(l);
    }
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
    this.editor.refreshAll();
  }

  closeActiveFile() {
    if (this.activeFile) {
      this.closeFile(this.activeFile.id);
    }
  }

  setFocusFile(file) {
    if (!file) return;
    this.activeFile = file;

    this.editor.cursor.setCursorPosition(file.row, file.column);

    this.editor.refreshAll();
  }

  createEmptyFile() {
    let node = new FileNode(this.editor, this.files.length, this.emptyName, "");
    this.openFile(node);

    return node;
  }

  async selectFile() {
    const file = await this.editor.api.selectFile();
    if (file) {
      let name = file.split("/").pop();
      let node = new FileNode(this.editor, this.files.length, name, file);
      return node;
    }

    return undefined;
  }

  async selectFiles() {
    const files = await this.editor.api.selectFiles();
    let result = [];
    let id = this.files.length;

    if (files) {
      for (let file of files) {
        let name = file.split("/").pop();
        let node = new FileNode(this.editor, id, name, file);
        id++;
        result.push(node);
      }
    }

    return result;
  }

  async selectNewFile() {
    const file = await this.editor.api.selectNewFile(this.emptyName);

    if (file) {
      let name = file.split("/").pop();
      let node = new FileNode(this.editor, this.files.length, name, file);
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
        '<span class="file-el-btn file-saved"><img src="../assets/icons/close.svg" alt="close" class="file-el-btn-img"></span>';
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
      this.editor.reactive();
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
    let id = e.target.parentElement.id;
    if (!id && e.target.classList.contains("file-el-title")) {
      id = e.target.parentElement.id;
      if (!id) return;
    }
    this.closeFile(id);
  }

  getTab(id) {
    return getElement(`.file-manager .file-el[id="${id}"]`);
  }

  setLanguage(language) {
    if (this.activeFile) {
      this.activeFile.language = language;
      this.editor.refreshAll();
    }
  }
}
