class LineController {
  constructor(editor) {
    this.editor = editor;
    this.maxCharactersPerLine =
      parseInt(this.editor.output.clientWidth / this.editor.letterSize) + 10; // + marge
    this.maxViewLines =
      parseInt(this.editor.output.clientHeight / this.editor.posY) + 10; // + marge

    this.maxCharacters =
      parseInt(this.editor.output.clientWidth / this.editor.letterSize) - 1; // - marge
    this.maxLines =
      parseInt(this.editor.output.clientHeight / this.editor.posY);

    this.lineN = document.querySelector(".line-numbers");

    this.dirtyLines = new Set();
  }

  // Getters et Setters
  get lines() {
    if (!this.editor.fileManager.activeFile) return;
    return this.editor.fileManager.activeFile?.lines;
  }

  set lines(value) {
    if (!this.editor.fileManager.activeFile) return;
    this.editor.fileManager.activeFile.lines = value;
  }

  get index() {
    if (!this.editor.fileManager.activeFile) return;
    return this.editor.fileManager.activeFile?.index;
  }

  set index(value) {
    if (!this.editor.fileManager.activeFile) return;
    this.editor.fileManager.activeFile.index = value;
  }

  get longuerLine() {
    if (!this.editor.fileManager.activeFile) return;
    return this.editor.fileManager.activeFile?.longuerLine;
  }

  set longuerLine(value) {
    if (!this.editor.fileManager.activeFile) return;
    this.editor.fileManager.activeFile.longuerLine = value;
  }

  loadContent(content) {
    this.lines = content.split("\n");
  }

  getContent() {
    return this.lines?.join("\n") || "";
  }

  getViewLineLength(i) {
    if (i < 0 || i >= this.lines?.length || !this.lines[i]) return 0;
    return (
      this.lines[i].length +
      getOccurrence("\t", this.lines[i]) * CONFIG_GET("tab_width") -
      getOccurrence("\t", this.lines[i])
    );
  }

  getViewNumberLines() {
    return Math.min(this.lines.length, this.maxViewLines);
  }
  getViewLines() {
    return Math.min(this.lines.length, this.maxViewLines);
  }

  setFocusLine(index) {
    const oldLine = document.querySelector(".line-selected");

    if (oldLine != null) oldLine.classList.remove("line-selected");

    const newLine = this.getLineNumberOBJ(index - 1);

    if (newLine == null) return;

    newLine.classList.add("line-selected");
    this.index = index;
  }

  addLine(txt, index) {
    this.lines.splice(index, 0, txt);
    this.markDirtyLineFrom(index);
  }

  changeLine(txt, index) {
    if (index >= 0 && index < this.lines.length) {
      this.lines[index] = txt;
      this.markDirtyLine(index);
    }
  }

  supLine(index) {
    if (index >= 0 && index < this.lines.length) {
      this.markDirtyLineFrom(index);

      this.lines.splice(index, 1);
    }
  }

  clear() {
    this.lines = [''];
    this.markDirtyLineFrom(0);
  }

  markDirtyLineFrom(index) {
    for (let i = index; i < this.getViewLines(); i++) {
      this.dirtyLines.add(i);
    }
  }

  markDirtyLine(index) {
    this.dirtyLines.add(index);
  }

  refreshOutput() {
    if (this.dirtyLines.size === 0) return;

    for (const index of this.dirtyLines) {
      this.refreshLineOutput(index);
    }
    this.dirtyLines.clear();
  }

  refreshLineOutput(index) {
    if (index >= this.maxViewLines) {
      return;
    }
  
    let lineOBJ = this.createLineOBJ(this.lines[index], index);
    const child = this.editor.output.children[index];
    if (!lineOBJ) {
      child.replaceChildren();
      return;
    }
    if (child.textContent !== lineOBJ.textContent) {
      child.replaceWith(lineOBJ);
    }
  }

  initLineOutput() {
    if (!this.editor.fileManager.activeFile) return;

    const fragment = document.createDocumentFragment();

    for (let i = 0; i < this.maxViewLines; i++) {
      let lineOBJ;
      if (!this.lines[i]) {
        lineOBJ = this.createLineOBJ('', i);
      }else{
        let line = this.lines[i];
        if (line.length > this.longuerLine)
          this.longuerLine = line.length;
  
        if (line.length > this.maxCharactersPerLine) line = line.slice(0, this.maxCharactersPerLine);
        lineOBJ = this.createLineOBJ(this.lines[i], i);
      }

      fragment.appendChild(lineOBJ);
    }
    if (this.lines.length === 0) {
      let lineOBJ = this.createLineOBJ('', 1);
      fragment.appendChild(lineOBJ);
    }

    this.editor.output.replaceChildren(fragment);
  }
  refreshNumberLines() {
    if (!this.editor.fileManager.activeFile) return;

    let children = this.lineN.children;

    if (children.length === this.getViewNumberLines()) return;

    const diff = children.length - this.getViewNumberLines();

    if (diff > 0) {
      for (let i = 0; i < diff; i++) {
        this.lineN.lastElementChild.remove();
      }
    }else{
      const fragment = document.createDocumentFragment();

      for (let i = 0; i < (diff * -1); i++) {
        const lNode = this.createNumberLineOBJ(children.length + i);
        fragment.appendChild(lNode);
      }

      this.lineN.appendChild(fragment);
    }
  }

  initNumberLines() {
    if (!this.editor.fileManager.activeFile) return;

    const fragment = document.createDocumentFragment();
    
    const l = this.getViewNumberLines();

    for (let i = 0; i < l; i++) {
      const lNode = this.createNumberLineOBJ(i);
      fragment.appendChild(lNode);
    }

    this.lineN.replaceChildren(fragment);
  }
  
  createNumberLineOBJ(index) {
    const span = document.createElement("span");
    
    // classes
    span.classList.add("line-el", "editor-el");
    if (index === this.index - 1) {
      span.classList.add("line-selected");
    }
    
    // style
    const y = this.editor.baseY + this.editor.posY * index;
    span.style.top = `${y}px`;
    
    // Contenu
    span.textContent = index + 1;
    
    return span;
  }

  createLineOBJ(line, row) {
    const obj = this.editor.writerController.textToOBJ(line);

    if (!obj) return;
    
    const x = 0;
    const y = this.editor.baseY + this.editor.posY * row;

    obj.style.position = "absolute";
    obj.style.top = y + "px";
    obj.style.left = x + "px";

    obj.dataset.line = row;
    return obj;
  }

  getLineOBJ(row) {
    const line = this.editor.output.children[row - 1];
    if (!line) return;
    return line;
  }

  getLineNumberOBJ(index) {
    const lines = document.querySelectorAll(".line-el");
    if (!lines) return;
    return lines[index];
  }

  getWordsOBJ(row) {
    if (row == undefined) return;
    const l = this.getLineOBJ(row);
    if (!l) return;
    return l.children;
  }

  getWordOBJ(row, index) {
    if (row == null || index == null) return;
    const l = this.getLineOBJ(row);
    if (!l) return;
    const words = l.children;
    return words[index];
  }

  refresh() {
    if (!this.editor.fileManager.activeFile) return;
    if (this.lines.length === 0) this.lines = [''];
    if (this.index !== this.editor.cursor.row) this.index = this.editor.cursor.row;

    this.refreshOutput();
    this.refreshNumberLines();
  }

  onClickNumberLine(e) {
    try {
      const i = parseInt(e.target.textContent) - 1;
      let lineOBJ = this.editor.selectController.getSelectOBJLine(i);
      this.editor.selectController.unSelectAll();
  
      if (lineOBJ === undefined)
        this.editor.selectController.selectLine(i, true);
      else this.editor.cursor.setCursorPosition(i + 1, 0);
    } catch (error) {
      console.error(error);
      return
    }
  }
}
