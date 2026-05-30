class LineController {
  constructor(editor) {
    this.editor = editor;
    this.maxCharactersPerLine =
      parseInt(this.editor.output.clientWidth / this.editor.letterSize) + 10; // + marge
    this.maxViewLines =
      parseInt(this.editor.output.clientHeight / this.editor.posY) + 25; // + marge

    this.maxCharacters =
      parseInt(this.editor.output.clientWidth / this.editor.letterSize) - 1; // - marge
    this.maxLines =
      parseInt(this.editor.output.clientHeight / this.editor.posY);

    this.lineN = document.querySelector(".line-numbers");
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

  get maxIndex() {
    if (!this.editor.fileManager.activeFile) return;
    return this.editor.fileManager.activeFile?.maxIndex;
  }

  set maxIndex(value) {
    if (!this.editor.fileManager.activeFile) return;
    this.editor.fileManager.activeFile.maxIndex = value;
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
    this.maxIndex = this.lines.length;
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
  getViewContent() {
    return this.lines || [];
  }

  getViewNumberLines() {
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
    this.lines = [
      ...this.lines.slice(0, index),
      txt,
      ...this.lines.slice(index),
    ];
  }

  changeLine(txt, index) {
    this.lines[index] = txt;
  }

  supLine(index) {
    if (index > this.maxIndex || index < 0) return;
    this.maxIndex -= 1;
    this.lines.splice(index, 1);
  }

  refreshLine() {
    if (!this.editor.fileManager.activeFile) return;

    const lines = this.getViewContent();

    this.editor.output.innerHTML = "";
    for (let i = 0; i < Math.min(lines.length, this.maxViewLines); i++) {
      if (!lines[i]) continue;
      if (lines[i].length > this.longuerLine)
        this.longuerLine = lines[i].length;

      let line = lines[i]
      if (line.length > this.maxCharacters) line = line.slice(0, this.maxCharacters);
      let lineOBJ = this.createLineOBJ(lines[i], i + 1);

      this.editor.output.appendChild(lineOBJ);

      const x = 0;
      const y = this.editor.baseY + this.editor.posY * i;

      lineOBJ.style.position = "absolute";
      lineOBJ.style.top = y + "px";
      lineOBJ.style.left = x + "px";
    }
    if (this.lines.length === 0)
      this.editor.output.innerHTML = '<div class="line editor-select"></div>';
  }
  refreshNumberLines() {
    if (!this.editor.fileManager.activeFile) return;

    let children = this.lineN.children;

    if (children.length === 0) this.initNumberLines();

    if (children.length === this.getViewNumberLines()) return;

    const diff = children.length - this.getViewNumberLines();

    if (diff > 0) {
      for (let i = 0; i < diff; i++) {
        this.lineN.lastElementChild.remove();
      }
    }else{
      const fragment = document.createDocumentFragment();

      for (let i = 0; i < (diff * -1); i++) {
        const lNode = this.createLineNode(children.length + i);
        fragment.appendChild(lNode);
      }

      this.lineN.appendChild(fragment);
    }
  }

  initNumberLines() {
    if (!this.editor.fileManager.activeFile) return;
    let linesN = this.lineN.querySelectorAll(".line-el");

    const fragment = document.createDocumentFragment();
    
    this.lineN.innerHTML = ""; 
    const l = this.getViewNumberLines();

    for (let i = 0; i < l; i++) {
      const lNode = this.createLineNode(i);
      fragment.appendChild(lNode);
    }

    // Un seul accès au DOM réel
    this.lineN.appendChild(fragment);
  }
  
  createLineNode(index) {
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
    const html = this.editor.writerController.toHTML(line);
    let element = createElement(html);
    element.dataset.line = row;
    return element;
  }

  getLineOBJ(row) {
    const line = getElement(".editor-output .line[data-line='" + row + "']");
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
    const words = l.querySelectorAll(".line-word");
    return words;
  }

  getWordOBJ(row, column) {
    if (row == null || column == null) return;
    const l = this.getLineOBJ(row);
    if (!l) return;
    const words = l.querySelectorAll(".line-word");
    return words[column];
  }

  refresh() {
    if (!this.editor.fileManager.activeFile) return;
    if (this.lines.length === 0) this.lines = [''];
    if (this.index !== this.editor.cursor.row) this.index = this.editor.cursor.row;
    if (this.lines.length !== this.maxIndex) this.maxIndex = this.lines.length;

    this.refreshLine();
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
