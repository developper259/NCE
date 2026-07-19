class LineController {
  constructor(editor) {
    this.editor = editor;

    this.lineN = document.querySelector(".line-numbers");

    this.outputWidth = 0;
    this.outputHeight = 0;

    this.dirtyLines = new Set();
    this.marginChars = 10;
    this.marginLines = 3;

    this.outputScroller = new OutputScroller(editor);
    this.outputScroller.setLineController(this);

    this.outputWidth = this.measureOutputWidth();
    this.outputHeight =
      this.editor.output.clientHeight || this.editor.editorOBJ.clientHeight;
  }

  getScrollOffsetY() {
    return this.startIndex * this.editor.posY + this.offsetY;
  }

  getMaxStartIndex() {
    if (this.totalLines === 0) return 0;
    return Math.max(0, this.totalLines - this.maxLines);
  }

  getLineTop(screenIndex) {
    return this.editor.baseY + this.editor.posY * screenIndex - this.offsetY;
  }

  refreshLinePositions() {
    const outputLen = this.editor.output.children.length;
    const lineLen = this.lineN.children.length;
    const tops = new Array(Math.max(outputLen, lineLen));

    for (let i = 0; i < tops.length; i++) {
      tops[i] = `${this.getLineTop(i)}px`;
    }

    for (let i = 0; i < outputLen; i++) {
      this.editor.output.children[i].style.top = tops[i];
    }
    for (let i = 0; i < lineLen; i++) {
      this.lineN.children[i].style.top = tops[i];
    }
  }

  applyScrollTransform() {
    this.outputScroller.applyScrollTransform();
  }

  resetScroll() {
    this.outputScroller.resetScroll();
  }

  clampScrollState() {
    this.outputScroller.clampScrollState();
  }

  getScrollRatioFromState() {
    return this.outputScroller.getVerticalScrollRatioFromState();
  }

  restoreScroll() {
    this.outputScroller.restoreScroll();
  }

  applyScrollFromRatio(scrollRatio) {
    this.outputScroller.applyVerticalScrollFromRatio(scrollRatio);
  }

  applyHorizontalScrollFromRatio(scrollRatio) {
    this.outputScroller.applyHorizontalScrollFromRatio(scrollRatio);
  }

  scrollTo(row, column) {
    this.outputScroller.scrollTo(row, column);
  }

  // Getters et Setters
  get lines() {
    if (!this.editor.tabManager.activeFile) return;
    return this.editor.tabManager.activeFile?.lines;
  }

  set lines(value) {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.tabManager.activeFile.lines = value;
  }

  get index() {
    if (!this.editor.tabManager.activeFile) return;
    return this.editor.tabManager.activeFile?.index;
  }

  set index(value) {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.tabManager.activeFile.index = value;
  }

  get maxLineLength() {
    if (!this.editor.tabManager.activeFile) return;
    return this.editor.tabManager.activeFile?.maxLineLength;
  }

  set maxLineLength(value) {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.tabManager.activeFile.maxLineLength = value;
  }

  get maxCharactersPerLine() {
    return (
      parseInt(this.outputWidth / this.editor.letterSize) + this.marginChars
    ); // + marge
  }

  get maxViewLines() {
    return parseInt(this.outputHeight / this.editor.posY) + this.marginLines; // + marge
  }

  get maxCharacters() {
    return Math.max(0, parseInt(this.outputWidth / this.editor.letterSize) - 1);
  }

  get maxLines() {
    return parseInt(this.outputHeight / this.editor.posY);
  }

  get totalLines() {
    if (!this.editor.tabManager.activeFile) return 0;
    return this.editor.tabManager.activeFile.totalLines ?? 0;
  }

  set totalLines(value) {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.tabManager.activeFile.totalLines = value;
  }

  get startIndex() {
    if (!this.editor.tabManager.activeFile) return 0;
    return this.editor.tabManager.activeFile.startIndex ?? 0;
  }

  set startIndex(value) {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.tabManager.activeFile.startIndex = value;
  }

  get offsetY() {
    if (!this.editor.tabManager.activeFile) return 0;
    return this.editor.tabManager.activeFile.offsetY ?? 0;
  }

  set offsetY(value) {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.tabManager.activeFile.offsetY = value;
  }

  get offsetX() {
    if (!this.editor.tabManager.activeFile) return 0;
    return this.editor.tabManager.activeFile.offsetX ?? 0;
  }

  set offsetX(value) {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.tabManager.activeFile.offsetX = value;
  }

  measureOutputWidth() {
    const fromEditor =
      this.editor.editorOBJ.clientWidth - this.editor.baseX;
    if (fromEditor > 0) return fromEditor;
    return Math.max(0, this.editor.output.clientWidth);
  }

  resizeWidth() {
    const width = this.measureOutputWidth();
    if (width > 0) this.outputWidth = width;
    this.markDirtyAll();
    this.refresh();
  }

  resize() {
    const width = this.measureOutputWidth();
    if (width > 0) this.outputWidth = width;
    this.outputHeight =
      this.editor.output.clientHeight || this.editor.editorOBJ.clientHeight;
    this.markDirtyAll();
    this.refresh();
  }

  loadContent(content, totalLines) {
    this.lines = content.split("\n");
    this.totalLines = totalLines || this.lines.length;

    if (this.outputScroller) {
      this.outputScroller.updateNbItem();
    }
  }

  setTotalLines(totalLines) {
    this.totalLines = totalLines;
  }

  appendLines(newLines) {
    if (!this.lines) {
      this.lines = newLines;
    } else {
      this.lines = this.lines.concat(newLines);
    }
    this.setTotalLines(this.lines.length);
    if (this.outputScroller) {
      this.outputScroller.updateNbItem();
    }
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
    this.lines = [""];
    this.markDirtyLineFrom(0);
  }

  markDirtyAll() {
    if (!this.lines || this.lines.length === 0) return;
    this.setTotalLines(this.lines.length);
    this.markDirtyLineFrom(0);
  }

  markDirtyLineFrom(dataIndex) {
    if (!this.lines || this.lines.length === 0) return;
    this.setTotalLines(this.lines.length);
    const start = Math.max(dataIndex, this.startIndex);
    const end = Math.min(
      this.lines.length,
      this.startIndex + this.maxViewLines,
    );
    for (let i = start; i < end; i++) {
      this.dirtyLines.add(i);
    }
  }

  markDirtyLine(index) {
    if (!this.lines || this.lines.length === 0) return;
    this.setTotalLines(this.lines.length);
    this.dirtyLines.add(index);
  }

  refreshOutput() {
    if (this.dirtyLines.size === 0) return;

    this.dirtyLines.forEach((dataIndex) => {
      const screenIndex = dataIndex - this.startIndex;
      if (screenIndex >= 0 && screenIndex < this.maxViewLines) {
        this.refreshLineOutput(screenIndex);
      }
    });

    this.dirtyLines.clear();
  }

  refreshLineOutput(screenIndex) {
    if (screenIndex >= this.maxViewLines) return;

    const dataIndex = this.startIndex + screenIndex;
    const child = this.editor.output.children[screenIndex];
    if (!child) return;

    if (dataIndex >= this.lines.length) {
      child.replaceChildren();
      child.removeAttribute("data-line");
      return;
    }

    let line = this.lines[dataIndex];

    if (this.offsetX > 0) {
      const tabWidth = CONFIG_GET("tab_width");
      let visualPos = 0;
      let charIndex = 0;

      while (charIndex < line.length && visualPos < this.offsetX) {
        if (line[charIndex] === "\t") {
          visualPos += tabWidth;
        } else {
          visualPos += 1;
        }
        charIndex++;
      }

      if (visualPos < this.offsetX) {
        line = "";
      } else {
        line = line.slice(charIndex);
      }
    }

    if (line.length > this.maxLineLength) this.maxLineLength = line.length;

    if (line.length > this.maxCharactersPerLine) {
      line = line.slice(0, this.maxCharactersPerLine);
    }

    if (child.textContent !== line) {
      let lineOBJ = this.createLineOBJ(line, screenIndex);
      if (!lineOBJ) return;

      lineOBJ.dataset.line = dataIndex;
      child.replaceWith(lineOBJ);
    }
  }

  initLineOutput() {
    if (!this.editor.tabManager.activeFile) return;

    const fragment = document.createDocumentFragment();

    for (let i = 0; i < this.maxViewLines; i++) {
      const dataIndex = this.startIndex + i;
      let lineOBJ;

      if (dataIndex >= this.lines.length) {
        lineOBJ = this.createLineOBJ("", i);
      } else {
        let line = this.lines[dataIndex];

        if (line.length > this.maxLineLength) this.maxLineLength = line.length;

        if (this.offsetX > 0) {
          const tabWidth = CONFIG_GET("tab_width");
          let visualPos = 0;
          let charIndex = 0;

          while (charIndex < line.length && visualPos < this.offsetX) {
            if (line[charIndex] === "\t") {
              visualPos += tabWidth;
            } else {
              visualPos += 1;
            }
            charIndex++;
          }

          if (visualPos < this.offsetX) {
            line = "";
          } else {
            line = line.slice(charIndex);
          }
        }

        if (line.length > this.maxCharactersPerLine) {
          line = line.slice(0, this.maxCharactersPerLine);
        }

        lineOBJ = this.createLineOBJ(line, i);
      }

      lineOBJ.dataset.line = dataIndex;
      fragment.appendChild(lineOBJ);
    }

    this.editor.output.replaceChildren(fragment);
    this.outputScroller.vScroller.nbItem = this.lines.length;
  }

  refreshNumberLines() {
    if (!this.editor.tabManager.activeFile) return;

    let children = this.lineN.children;
    const targetCount = this.getViewNumberLines();
    const diff = children.length - targetCount;

    if (diff > 0) {
      for (let i = 0; i < diff; i++) {
        this.lineN.lastElementChild.remove();
      }
    } else if (diff < 0) {
      const fragment = document.createDocumentFragment();
      const currentLength = children.length;
      for (let i = 0; i < diff * -1; i++) {
        const screenIndex = currentLength + i;
        const lNode = this.createNumberLineOBJ(
          screenIndex,
          this.startIndex + screenIndex,
        );
        fragment.appendChild(lNode);
      }
      this.lineN.appendChild(fragment);
    }

    for (let i = 0; i < children.length; i++) {
      const span = children[i];
      const dataIndex = this.startIndex + i;

      span.textContent = dataIndex + 1;
      span.dataset.line = dataIndex;
      span.style.top = `${this.getLineTop(i)}px`;

      if (dataIndex === this.index - 1) {
        span.classList.add("line-selected");
      } else {
        span.classList.remove("line-selected");
      }
    }

    this.outputScroller.vScroller.nbItem = this.lines.length;
    this.updateLineNumberWidth();
  }

  initNumberLines() {
    if (!this.editor.tabManager.activeFile) return;

    const fragment = document.createDocumentFragment();
    const l = this.getViewNumberLines();

    for (let i = 0; i < l; i++) {
      const lNode = this.createNumberLineOBJ(i, this.startIndex + i);
      fragment.appendChild(lNode);
    }

    this.lineN.replaceChildren(fragment);
    this.updateLineNumberWidth();
  }

  createNumberLineOBJ(screenIndex, dataIndex) {
    const span = document.createElement("span");

    span.classList.add("line-el", "editor-el");
    if (dataIndex === this.index - 1) {
      span.classList.add("line-selected");
    }

    span.style.top = `${this.getLineTop(screenIndex)}px`;

    span.textContent = dataIndex + 1;
    span.dataset.line = dataIndex;

    return span;
  }

  calculateLineNumberWidth() {
    if (!this.lines || this.lines.length === 0) return 50;

    const maxLineNumber = this.lines.length;
    const maxDigits = maxLineNumber.toString().length;

    const estimatedWidth = Math.max(50, maxDigits * 10 + 15);
    return estimatedWidth;
  }

  updateLineNumberWidth() {
    const width = this.calculateLineNumberWidth();
    this.lineN.style.width = `${width}px`;
    this.editor.updateBaseX(width);
  }

  createLineOBJ(line, row) {
    const obj = this.editor.writerController.textToOBJ(line);

    if (!obj) return;

    const x = 0;

    obj.style.position = "absolute";
    obj.style.top = `${this.getLineTop(row)}px`;
    obj.style.left = x + "px";

    obj.dataset.line = row;
    return obj;
  }

  getLineOBJ(row) {
    const line = this.editor.output.children[row - 1];
    if (!line) return;
    return line;
  }

  getLineNumberOBJ(dataIndex) {
    const screenIndex = dataIndex - this.startIndex;
    if (screenIndex >= 0 && screenIndex < this.lineN.children.length) {
      return this.lineN.children[screenIndex];
    }
    return null;
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
    if (!this.editor.tabManager.activeFile) return;
    if (this.lines.length === 0) this.lines = [""];
    if (this.index !== this.editor.cursor.row)
      this.index = this.editor.cursor.row;

    this.refreshOutput();
    this.refreshNumberLines();

    this.outputScroller.refresh();

    this.editor.cursor.updateCaretPosition();
  }

  onClickNumberLine(e) {
    try {
      const i = parseInt(e.target.dataset.line);
      if (isNaN(i)) return;

      let lineOBJ = this.editor.selectController.getSelectOBJLine(i);
      this.editor.selectController.unSelectAll();

      if (lineOBJ === undefined)
        this.editor.selectController.selectLine(i, true);
      else this.editor.cursor.setCursorPosition(i + 1, 0);
    } catch (error) {
      console.error(error);
      return;
    }
  }

  hide() {
    this.lineN.innerHTML = "";
    this.editor.output.innerHTML = "";

    this.lineN.style.display = "none";
    this.editor.output.style.display = "none";

    const cursor = getElement(".editor-caret");
    cursor.style.display = "none";

    const selectOutput = getElement(".editor-select-output");
    selectOutput.innerHTML = "";
  }

  show() {
    this.lineN.style.display = "block";
    this.editor.output.style.display = "block";

    const width = this.measureOutputWidth();
    if (width > 0) this.outputWidth = width;
    this.outputHeight =
      this.editor.output.clientHeight || this.editor.editorOBJ.clientHeight;

    this.initLineOutput();
    this.initNumberLines();
    const cursor = getElement(".editor-caret");
    cursor.style.display = "block";
  }
}
