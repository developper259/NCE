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

    this.syncDimensions();
  }

  get lines() {
    if (!this.editor.tabManager.activeFile) {
      return [];
    }

    return this.editor.tabManager.activeFile.lines || [];
  }

  set lines(value) {
    if (!this.editor.tabManager.activeFile) {
      return;
    }

    this.editor.tabManager.activeFile.lines = value;
  }

  get index() {
    if (!this.editor.tabManager.activeFile) {
      return 0;
    }

    return this.editor.tabManager.activeFile.index || 0;
  }

  set index(value) {
    if (!this.editor.tabManager.activeFile) {
      return;
    }

    this.editor.tabManager.activeFile.index = value;
  }

  get maxLineLength() {
    if (!this.editor.tabManager.activeFile) {
      return 0;
    }

    return this.editor.tabManager.activeFile.maxLineLength || 0;
  }

  set maxLineLength(value) {
    if (!this.editor.tabManager.activeFile) {
      return;
    }

    this.editor.tabManager.activeFile.maxLineLength = value;
  }

  get totalLines() {
    if (!this.editor.tabManager.activeFile) {
      return 0;
    }

    return this.editor.tabManager.activeFile.totalLines ?? 0;
  }

  set totalLines(value) {
    if (!this.editor.tabManager.activeFile) {
      return;
    }

    this.editor.tabManager.activeFile.totalLines = value;
  }

  get startIndex() {
    if (!this.editor.tabManager.activeFile) {
      return 0;
    }

    return this.editor.tabManager.activeFile.startIndex ?? 0;
  }

  set startIndex(value) {
    if (!this.editor.tabManager.activeFile) {
      return;
    }

    this.editor.tabManager.activeFile.startIndex = value;
  }

  get offsetY() {
    if (!this.editor.tabManager.activeFile) {
      return 0;
    }

    return this.editor.tabManager.activeFile.offsetY ?? 0;
  }

  set offsetY(value) {
    if (!this.editor.tabManager.activeFile) {
      return;
    }

    this.editor.tabManager.activeFile.offsetY = value;
  }

  get offsetX() {
    if (!this.editor.tabManager.activeFile) {
      return 0;
    }

    return this.editor.tabManager.activeFile.offsetX ?? 0;
  }

  set offsetX(value) {
    if (!this.editor.tabManager.activeFile) {
      return;
    }

    this.editor.tabManager.activeFile.offsetX = value;
  }

  syncDimensions() {
    const dimensions = this.editor.domManager;

    if (!dimensions) {
      return;
    }

    this.outputWidth = dimensions.getOutputWidth();

    this.outputHeight = dimensions.getOutputHeight();
  }

  get maxCharactersPerLine() {
    const letterWidth = this.editor.domManager
      ? this.editor.domManager.getLetterWidth()
      : this.editor.letterSize;

    return parseInt(this.outputWidth / letterWidth) + this.marginChars;
  }

  get maxViewLines() {
    const lineHeight = this.editor.domManager
      ? this.editor.domManager.getLineHeight()
      : this.editor.posY;

    return Math.max(1, parseInt(this.outputHeight / lineHeight));
  }

  get renderedLineCount() {
    return this.maxViewLines + 1;
  }

  get maxCharacters() {
    const letterWidth = this.editor.domManager
      ? this.editor.domManager.getLetterWidth()
      : this.editor.letterSize;

    return Math.max(0, parseInt(this.outputWidth / letterWidth) - 1);
  }

  get maxLines() {
    const lineHeight = this.editor.domManager
      ? this.editor.domManager.getLineHeight()
      : this.editor.posY;

    return parseInt(this.outputHeight / lineHeight);
  }

  getScrollOffsetY() {
    const lineHeight = this.editor.domManager
      ? this.editor.domManager.getLineHeight()
      : this.editor.posY;

    return this.startIndex * lineHeight + this.offsetY;
  }

  getMaxStartIndex() {
    if (this.totalLines === 0) {
      return 0;
    }

    const overflow = this.totalLines - this.maxLines;

    if (overflow <= 0) {
      return 0;
    }

    return overflow + this.marginLines;
  }

  getLineTop(screenIndex) {
      const baseY = this.editor.domManager
          ? this.editor.domManager.getOutputY()
          : this.editor.baseY;

      const lineHeight = this.editor.domManager
          ? this.editor.domManager.getLineHeight()
          : this.editor.posY;

      return baseY + lineHeight * screenIndex;
  }

  applyOutputTransform() {
    const x = -this.offsetX * this.editor.domManager.getLetterWidth();
    const y = -this.offsetY;

    this.editor.output.style.transform = `translate(${x}px, ${y}px)`;
  }

  isSized() {
    return this.outputHeight !== 0 && this.outputWidth !== 0;
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

  measureOutputWidth() {
    if (this.editor.domManager) {
      return this.editor.domManager.getOutputWidth();
    }

    return this.outputWidth;
  }

  resizeWidth() {
    this.syncDimensions();

    this.markDirtyAll();

    this.refresh();
  }

  resize() {
    this.syncDimensions();

    if (this.outputScroller) {
      this.outputScroller.clampScrollState();
    }

    if (!this.editor.isOnRefresh) {
      this.markDirtyAll();

      this.refresh(true);
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
    if (row >= this.lines.length || !this.lines[row]) {
      return 0;
    }

    const l = this.lines[row].getText().replace(/ |	/g, "");

    return l.length;
  }

  getViewLineLength(i) {
    if (i < 0 || i >= this.lines.length || !this.lines[i]) {
      return 0;
    }

    const text = this.lines[i].getText();

    return (
      text.length +
      getOccurrence("\t", text) * CONFIG_GET("tab_width") -
      getOccurrence("\t", text)
    );
  }

  getViewNumberLines() {
    if (!this.lines) {
      return 0;
    }

    const visibleLines = this.lines.length - this.startIndex;

    return Math.max(0, Math.min(visibleLines, this.renderedLineCount));
  }

  setFocusLine(index) {
    const oldLine = this.editor.domManager.getElement(".line-selected");

    if (oldLine != null) {
      oldLine.classList.remove("line-selected");
    }

    const newLine = this.getLineNumberOBJ(index - 1);

    if (newLine == null) {
      return;
    }

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
      this.lines.splice(index, 1);

      this.markDirtyFrom(index);
    }
  }

  clear() {
    this.lines = [new LineNode("")];

    this.markDirtyFrom(0);
  }

  markDirtyAll() {
    if (this.lines.length === 0) {
      return;
    }

    this.setTotalLines(this.lines.length);

    this.markDirtyFrom(0, false);

    this.editor.highlightController.markDirtyAll(true);
  }

  markDirtyFrom(dataIndex, isHighlight = true) {
    if (this.lines.length === 0) {
      return;
    }

    this.setTotalLines(this.lines.length);

    const start = Math.max(dataIndex, this.startIndex);

    const end = Math.min(
      this.lines.length,
      this.startIndex + this.renderedLineCount,
    );

    for (let i = start; i < end; i++) {
      this.dirtyLines.add(this.lines[i]);
    }

    if (isHighlight) {
      this.editor.highlightController.markDirtyFrom(dataIndex);
    }
  }

  markDirty(index) {
    if (this.lines.length === 0) {
      return;
    }

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
    if (this.dirtyLines.size === 0) {
      return;
    }

    this.dirtyLines.forEach((lineNode) => {
      const dataIndex = this.lines.indexOf(lineNode);

      if (dataIndex < 0) {
        return;
      }

      const screenIndex = dataIndex - this.startIndex;

      if (screenIndex >= 0 && screenIndex < this.renderedLineCount) {
        this.refreshLineOutput(screenIndex);
      }
    });

    const firstEmptyIndex = Math.max(0, this.lines.length - this.startIndex);

    const outputLength = this.editor.output.children.length;

    for (
      let screenIndex = firstEmptyIndex;
      screenIndex < outputLength;
      screenIndex++
    ) {
      const child = this.editor.output.children[screenIndex];

      if (!child) {
        continue;
      }

      child.replaceChildren();

      child.removeAttribute("data-line");
    }

    this.dirtyLines.clear();
  }

  refreshLineOutput(screenIndex) {
    if (screenIndex >= this.renderedLineCount) {
      return;
    }

    const dataIndex = this.startIndex + screenIndex;

    const child = this.editor.output.children[screenIndex];

    if (!child) {
      return;
    }

    if (dataIndex >= this.lines.length) {
      child.replaceChildren();

      child.removeAttribute("data-line");

      return;
    }

    let lineNode = this.lines[dataIndex];

    let fullText = lineNode.getText();

    const currentLineLength = this.getViewLineLength(dataIndex);

    if (currentLineLength > this.maxLineLength) {
      this.maxLineLength = currentLineLength;
    }

    let line = this.getSlicedLine(fullText);

    if (child.textContent !== line) {
      let lineOBJ = this.createLineOBJ(line, screenIndex);

      if (!lineOBJ) {
        return;
      }

      lineOBJ.dataset.line = dataIndex;

      child.replaceWith(lineOBJ);

      this.editor.highlightController.setLineNode(dataIndex, lineOBJ);

      if (!lineNode.isHighlight) {
        this.editor.highlightController.markDirty(dataIndex);
      }
    }
  }

  initLineOutput() {
    if (!this.editor.tabManager.activeFile) {
      return;
    }

    const fragment = document.createDocumentFragment();

    for (let i = 0; i < this.renderedLineCount; i++) {
      const dataIndex = this.startIndex + i;

      let lineOBJ;

      if (dataIndex >= this.lines.length) {
        lineOBJ = this.createLineOBJ("", i);
      } else {
        const lineNode = this.lines[dataIndex];

        const fullText = lineNode.getText();

        const currentLineLength = this.getViewLineLength(dataIndex);

        if (currentLineLength > this.maxLineLength) {
          this.maxLineLength = currentLineLength;
        }

        const line = this.getSlicedLine(fullText);

        lineOBJ = this.createLineOBJ(line, i);

        lineOBJ.dataset.line = dataIndex;

        this.editor.highlightController.setLineNode(dataIndex, lineOBJ);
      }

      fragment.appendChild(lineOBJ);
    }

    this.editor.highlightController.markDirtyAll(true);

    this.editor.output.replaceChildren(fragment);
  }

  refreshNumberLines() {
    if (!this.editor.tabManager.activeFile) {
      return;
    }

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
    if (!this.editor.tabManager.activeFile) {
      return;
    }

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
    if (this.lines.length === 0) {
      return 50;
    }

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

    if (!lineOBJ) {
      return;
    }

    lineOBJ.style.position = "absolute";

    lineOBJ.style.top = `${this.getLineTop(row)}px`;

    lineOBJ.style.left = "0px";

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
    if (row === undefined) {
      return;
    }

    const l = this.getLineOBJ(row);

    return l ? l.children : undefined;
  }

  getWordOBJ(row, index) {
    if (row == null || index == null) {
      return;
    }

    const l = this.getLineOBJ(row);

    if (!l) {
      return;
    }

    return l.children[index];
  }

  refresh(forcedInit = false) {
    if (!this.editor.tabManager.activeFile) {
      return;
    }

    if (this.lines.length === 0) {
      this.lines = [new LineNode("")];
    }

    if (this.index !== this.editor.cursorController.row) {
      this.index = this.editor.cursorController.row;
    }

    if (forcedInit) {
      this.initLineOutput();
    } else {
      this.refreshOutput();
    }

    this.refreshNumberLines();

    this.outputScroller.updateNbItem();

    this.editor.cursorController.updateCaretPosition();

    this.editor.selectController.refreshSelectionDOM();

    this.editor.searchController.refreshSelectionDOM();

    this.editor.highlightController.refresh();
  }

  onClickNumberLine(e) {
    try {
      const i = parseInt(e.target.dataset.line, 10);

      if (isNaN(i)) {
        return;
      }

      const isLineSelected = this.editor.selectController.selectedLines.has(i);

      this.editor.selectController.unSelectAll();

      if (!isLineSelected) {
        this.editor.selectController.selectLine(i, true);
      } else {
        this.editor.cursorController.setCursorPosition(i + 1, 0);
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

    if (cursor) {
      cursor.style.display = "none";
    }

    const selectOutput = getElement(".editor-select-highlight");

    if (selectOutput) {
      selectOutput.replaceChildren();
    }

    this.outputScroller.hide();
  }

  show() {
    this.lineN.style.display = "block";

    this.editor.output.style.display = "block";

    const cursor = getElement(".editor-caret");

    if (cursor) {
      cursor.style.display = "block";
    }

    this.outputScroller.show();

    if (!this.editor.isOnRefresh) {
      this.initLineOutput();

      this.initNumberLines();

      this.editor.highlightController.refresh();
    }
  }
}
