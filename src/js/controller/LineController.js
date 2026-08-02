class LineController {
  constructor(editor) {
    this.editor = editor;

    this.lineN = getElement(".line-numbers");

    this.outputWidth = 0;
    this.outputHeight = 0;

    this.dirtyLines = new Set();
    this.marginChars = 10;
    this.marginLines = 3;

    this.outputScroller = new OutputScroller(editor);
    this.outputScroller.setLineController(this);
  }

  // --- Getters et Setters ---

  get lines() {
    if (!this.editor.tabManager.activeFile) return [];
    return this.editor.tabManager.activeFile.lines || [];
  }

  set lines(value) {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.tabManager.activeFile.lines = value;
  }

  get index() {
    if (!this.editor.tabManager.activeFile) return 0;
    return this.editor.tabManager.activeFile.index || 0;
  }

  set index(value) {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.tabManager.activeFile.index = value;
  }

  get maxLineLength() {
    if (!this.editor.tabManager.activeFile) return 0;
    return this.editor.tabManager.activeFile.maxLineLength || 0;
  }

  set maxLineLength(value) {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.tabManager.activeFile.maxLineLength = value;
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

  get maxCharactersPerLine() {
    return (
      parseInt(this.outputWidth / this.editor.letterSize) + this.marginChars
    );
  }

  get maxViewLines() {
    return parseInt(this.outputHeight / this.editor.posY) + this.marginLines;
  }

  get maxCharacters() {
    return Math.max(0, parseInt(this.outputWidth / this.editor.letterSize) - 1);
  }

  get maxLines() {
    return parseInt(this.outputHeight / this.editor.posY);
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

  isSized() {
    return this.outputHeight !== 0 && this.outputWidth !== 0;
  }

  // --- Gestion des Scrollers ---

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

  // -------------------

  measureOutputWidth() {
    const fromEditor = this.editor.editorOBJ.clientWidth - this.editor.baseX;
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

    if (!this.editor.isOnRefresh) {
      this.markDirtyAll();
      this.refresh();
    }
  }

  loadContent(content, totalLines) {
    const textLines = content.split("\n");
    this.lines = textLines.map((text) => new LineNode(text));
    this.totalLines = totalLines || this.lines.length;

    if (this.outputScroller) {
      this.outputScroller.updateNbItem();
    }
  }

  setTotalLines(totalLines) {
    this.totalLines = totalLines;
  }

  appendLines(newLines) {
    const lineNodes = newLines.map((text) => new LineNode(text));
    this.lines = this.lines.concat(lineNodes);
    this.setTotalLines(this.lines.length);

    if (this.outputScroller) {
      this.outputScroller.updateNbItem();
    }
  }

  getContent() {
    return this.lines.map((line) => line.getText()).join("\n");
  }

  getLineLength(row) {
    if (row >= this.lines.length || !this.lines[row]) return 0;
    const l = this.lines[row].getText().replace(/ |\t/g, "");
    return l.length;
  }

  getViewLineLength(i) {
    if (i < 0 || i >= this.lines.length || !this.lines[i]) return 0;
    const text = this.lines[i].getText();
    return (
      text.length +
      getOccurrence("\t", text) * CONFIG_GET("tab_width") -
      getOccurrence("\t", text)
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
    this.lines.splice(index, 0, new LineNode(txt));
    this.markDirtyFrom(index);
  }

  changeLine(txt, index) {
    if (index >= 0 && index < this.lines.length) {
      this.lines[index].setText(txt);
      this.markDirty(index);
    }
  }

  supLine(index) {
    if (index >= 0 && index < this.lines.length) {
      this.markDirtyFrom(index);
      this.lines.splice(index, 1);
    }
  }

  clear() {
    this.lines = [new LineNode("")];
    this.markDirtyFrom(0);
  }

  markDirtyAll() {
    if (this.lines.length === 0) return;
    this.setTotalLines(this.lines.length);
    this.markDirtyFrom(0, false);
    this.editor.highlightController.markDirtyAll(true);
  }

  markDirtyFrom(dataIndex, isHighlight = true) {
    if (this.lines.length === 0) return;
    this.setTotalLines(this.lines.length);
    const start = Math.max(dataIndex, this.startIndex);
    const end = Math.min(
      this.lines.length,
      this.startIndex + this.maxViewLines,
    );

    for (let i = start; i < end; i++) {
      this.dirtyLines.add(this.lines[i]);
    }

    if (isHighlight) this.editor.highlightController.markDirtyFrom(dataIndex);
  }

  markDirty(index) {
    if (this.lines.length === 0) return;
    this.setTotalLines(this.lines.length);
    this.dirtyLines.add(this.lines[index]);
    this.editor.highlightController.markDirty(index);
  }

  getSlicedLine(line) {
    if (this.offsetX > 0) {
      const tabWidth = CONFIG_GET("tab_width");
      let visualPos = 0;
      let charIndex = 0;

      while (charIndex < line.length && visualPos < this.offsetX) {
        visualPos += line[charIndex] === "\t" ? tabWidth : 1;
        charIndex++;
      }

      line = visualPos < this.offsetX ? "" : line.slice(charIndex);
    }

    if (line.length > this.maxCharactersPerLine) {
      line = line.slice(0, this.maxCharactersPerLine);
    }

    return line;
  }

  refreshOutput() {
    if (this.dirtyLines.size === 0) return;

    this.dirtyLines.forEach((lineNode) => {
      const dataIndex = this.lines.indexOf(lineNode);
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

    let lineNode = this.lines[dataIndex];
    let line = this.getSlicedLine(lineNode.getText());

    if (line.length > this.maxLineLength) this.maxLineLength = line.length;

    if (child.textContent !== line) {
      let lineOBJ = this.createLineOBJ(line, screenIndex);
      if (!lineOBJ) return;

      lineOBJ.dataset.line = dataIndex;
      child.replaceWith(lineOBJ);

      this.editor.highlightController.setLineNode(dataIndex, lineOBJ);
      if (!lineNode.isHighlight)
        this.editor.highlightController.markDirty(dataIndex);
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
        const lineNode = this.lines[dataIndex];
        const line = this.getSlicedLine(lineNode.getText());

        if (line.length > this.maxLineLength) this.maxLineLength = line.length;

        lineOBJ = this.createLineOBJ(line, i);
      }

      lineOBJ.dataset.line = dataIndex;
      fragment.appendChild(lineOBJ);

      this.editor.highlightController.setLineNode(dataIndex, lineOBJ);
    }

    this.editor.highlightController.markDirtyAll(true);
    this.editor.output.replaceChildren(fragment);
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
    if (this.lines.length === 0) return 50;

    const maxLineNumber = this.lines.length;
    const maxDigits = maxLineNumber.toString().length;

    return Math.max(50, maxDigits * 10 + 15);
  }

  updateLineNumberWidth() {
    const width = this.calculateLineNumberWidth();
    this.lineN.style.width = `${width}px`;
    this.editor.updateBaseX(width);
  }

  createLineOBJ(line, row) {
    const lineOBJ = this.editor.writerController.textToOBJ(line, row);
    if (!lineOBJ) return;

    lineOBJ.style.position = "absolute";
    lineOBJ.style.top = `${this.getLineTop(row)}px`;
    lineOBJ.style.left = "0px";
    lineOBJ.dataset.line = row;

    return lineOBJ;
  }

  getLineOBJ(row) {
    return this.editor.output.children[row - 1];
  }

  getLineNumberOBJ(dataIndex) {
    const screenIndex = dataIndex - this.startIndex;
    if (screenIndex >= 0 && screenIndex < this.lineN.children.length) {
      return this.lineN.children[screenIndex];
    }
    return null;
  }

  getWordsOBJ(row) {
    if (row === undefined) return;
    const l = this.getLineOBJ(row);
    return l ? l.children : undefined;
  }

  getWordOBJ(row, index) {
    if (row == null || index == null) return;
    const l = this.getLineOBJ(row);
    if (!l) return;
    return l.children[index];
  }

  refresh(forcedInit = false) {
    if (!this.editor.tabManager.activeFile) return;
    if (this.lines.length === 0) this.lines = [new LineNode("")];
    if (this.index !== this.editor.cursor.row)
      this.index = this.editor.cursor.row;

    if (forcedInit) this.initLineOutput();
    else this.refreshOutput();

    this.refreshNumberLines();
    
    this.outputScroller.updateNbItem();

    this.editor.cursor.updateCaretPosition();
    this.editor.selectController.refreshSelectionDOM();
    this.editor.highlightController.refresh();
  }

  onClickNumberLine(e) {
    try {
      const i = parseInt(e.target.dataset.line, 10);
      if (isNaN(i)) return;

      const isLineSelected = this.editor.selectController.selectedLines.has(i);
      this.editor.selectController.unSelectAll();

      if (!isLineSelected) {
        this.editor.selectController.selectLine(i, true);
      } else {
        this.editor.cursor.setCursorPosition(i + 1, 0);
      }
    } catch (error) {
      console.error(error);
    }
  }

  hide() {
    this.lineN.replaceChildren();
    this.editor.output.replaceChildren();

    this.lineN.style.display = "none";
    this.editor.output.style.display = "none";

    const cursor = getElement(".editor-caret");
    if (cursor) cursor.style.display = "none";

    const selectOutput = getElement(".editor-select-output");
    if (selectOutput) selectOutput.replaceChildren();

    this.outputScroller.hide();
  }

  show() {
    this.lineN.style.display = "block";
    this.editor.output.style.display = "block";

    const cursor = getElement(".editor-caret");
    if (cursor) cursor.style.display = "block";

    this.outputScroller.show();

    if (!this.editor.isOnRefresh) {
      this.initLineOutput();
      this.initNumberLines();
      this.editor.highlightController.refresh();
    }
  }
}
