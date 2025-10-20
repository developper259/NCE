class LineController {
  constructor(editor) {
    this.editor = editor;
    this.maxViewLine =
      parseInt(this.editor.output.clientWidth / this.editor.letterSize) + 5; // + marge
    this.maxCharactersPerLine =
      parseInt(this.editor.output.clientHeight / this.editor.posY) + 25; // + marge

    this.maxLines =
      parseInt(this.editor.output.clientWidth / this.editor.letterSize) - 1; // - marge
    this.maxCharacters =
      parseInt(this.editor.output.clientHeight / this.editor.posY) - 2; // 102 - marge
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
    if (!this.lines) return [];
    return Array.from({ length: this.lines.length }, (_, i) => i + 1);
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

    this.refresh();

    CALLEVENT("onChange");
  }

  changeLine(txt, index) {
    this.lines[index] = txt;

    this.refresh();

    CALLEVENT("onChange");
  }

  supLine(index) {
    if (index > this.maxIndex) return;
    this.maxIndex -= 1;
    this.lines.splice(index, 1);

    this.refresh();

    CALLEVENT("onChange");
  }

  refreshLine() {
    if (!this.editor.fileManager.activeFile) return;

    if (this.lines.length !== this.maxIndex) this.maxIndex = this.lines.length;

    const lines = this.getViewContent();

    this.editor.output.innerHTML = "";
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      if (lines[i].length > this.longuerLine)
        this.longuerLine = lines[i].length;
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
    const lineN = document.querySelector(".line-numbers");
    let linesN = lineN.querySelectorAll(".line-el");

    if (this.index === 0) this.index = this.editor.cursor.row;
    if (this.maxIndex === 0) this.maxIndex = this.lines.length;
    if (this.maxIndex === 0) this.maxIndex = 1;

    if (this.maxIndex !== linesN.length) {
      let innerHTML = "";

      const l = this.getViewNumberLines();

      for (let i = 0; i < l.length; i++)
        innerHTML += `<span class="line-el editor-el">${l[i]}</span>`;

      lineN.innerHTML = innerHTML;

      linesN = lineN.querySelectorAll(".line-el");

      for (let i = 0; i < linesN.length; i++) {
        const line = linesN[i];

        const y = this.editor.baseY + this.editor.posY * i;
        line.style.top = y + "px";

        addEvent("click", () => {
          let lineOBJ = this.editor.selectController.getSelectOBJLine(i);
          this.editor.selectController.unSelectAll();

          if (lineOBJ === undefined)
            this.editor.selectController.selectLine(i, true);
          else this.editor.cursor.setCursorPosition(i + 1, 0);
        }, line);
      }
    }
    this.setFocusLine(this.index);
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
    this.refreshLine();
    this.refreshNumberLines();
  }
}
