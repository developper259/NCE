class LineController {
  constructor(editor) {
    this.editor = editor;

    this.lineN = document.querySelector(".line-numbers");

    this.dirtyLines = new Set();

    this.initScroller();
  }

  getScrollOffsetY() {
    return this.startIndex * this.editor.posY + this.offsetY;
  }

  getMaxStartIndex() {
    if (!this.lines || this.lines.length === 0) return 0;
    return Math.max(0, this.lines.length - this.maxLines);
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
    this.editor.output.style.transform = "";
    this.lineN.style.transform = "";
    this.refreshLinePositions();
  }

  resetScroll() {
    this.startIndex = 0;
    this.offsetY = 0;
    if (this.scroller) this.scroller.setScrollRatio(0);
    this.applyScrollTransform();
  }

  clampScrollState() {
    if (!this.lines || this.lines.length === 0) {
      this.startIndex = 0;
      this.offsetY = 0;
      return;
    }

    const posY = this.editor.posY;
    const maxStart = this.getMaxStartIndex();
    if (this.startIndex > maxStart) this.startIndex = maxStart;
    if (this.startIndex < 0) this.startIndex = 0;

    const viewportHeight = this.editor.output.clientHeight;
    const totalHeight = this.lines.length * posY;
    const maxOffsetY = Math.max(
      0,
      totalHeight - this.startIndex * posY - viewportHeight,
    );
    if (this.offsetY > maxOffsetY) this.offsetY = maxOffsetY;
    if (this.offsetY < 0) this.offsetY = 0;
  }

  getScrollRatioFromState() {
    if (!this.lines || this.lines.length === 0) return 0;

    const posY = this.editor.posY;
    const viewportHeight = this.editor.output.clientHeight;
    const totalHeight = this.lines.length * posY;
    const maxScrollY = Math.max(0, totalHeight - viewportHeight);
    if (maxScrollY === 0) return 0;

    return (this.startIndex * posY + this.offsetY) / maxScrollY;
  }

  restoreScroll() {
    if (!this.editor.tabManager.activeFile) return;

    this.clampScrollState();
    this.scroller.setScrollRatio(this.getScrollRatioFromState());
    this.applyScrollTransform();
    this.scroller.refresh();
    this.editor.cursor.updateCaretPosition();
    this.editor.selectController.refreshSelectPositions();
  }

  applyScrollFromRatio(scrollRatio) {
    if (!this.lines || this.lines.length === 0) return;

    if (!this.scroller.calcIsActive()) {
      if (this.startIndex !== 0 || this.offsetY !== 0) {
        this.resetScroll();
        this.markDirtyAll();
        this.refreshOutput();
        this.refreshNumberLines();
        this.editor.cursor.updateCaretPosition();
        this.editor.selectController.refreshSelectPositions();
      }
      return;
    }

    const posY = this.editor.posY;
    const totalHeight = this.lines.length * posY;
    const viewportHeight = this.editor.output.clientHeight;
    const maxScrollY = Math.max(0, totalHeight - viewportHeight);
    const maxStartIndex = this.getMaxStartIndex();

    scrollRatio = Math.max(0, Math.min(scrollRatio, 1));
    this.scroller.setScrollRatio(scrollRatio);

    const currentScrollY = scrollRatio * maxScrollY;
    let newStartIndex = Math.min(
      Math.floor(currentScrollY / posY),
      maxStartIndex,
    );
    let newOffsetY = currentScrollY - newStartIndex * posY;

    const maxOffsetY = Math.max(
      0,
      totalHeight - newStartIndex * posY - viewportHeight,
    );
    if (newOffsetY > maxOffsetY) newOffsetY = maxOffsetY;

    const startIndexChanged = this.startIndex !== newStartIndex;

    this.startIndex = newStartIndex;
    this.offsetY = newOffsetY;
    this.applyScrollTransform();
    this.editor.cursor.updateCaretPosition();
    this.editor.selectController.refreshSelectPositions();

    if (startIndexChanged) {
      this.markDirtyAll();
      this.refreshOutput();
      this.refreshNumberLines();
    }
  }

  initScroller() {
    this.scroller = this.editor.scrollerManager.createScroller(
      this.editor.editorOBJ,
      this.editor.scrollerManager.VERTICAL_TYPE,
      false,
    );
    this.editor.scrollerManager.addScroller(this.scroller);
    this.scroller.onRefresh = () => {
      this.refresh();
    };

    this.scroller.nbItem = this.lines?.length || 0;
    this.scroller.heightByItem = this.editor.posY;

    this.scroller.calculProp = () => {
      if (!this.lines || this.lines.length === 0) return 0;
      const visibleLines = this.maxLines;
      const totalLines = this.lines.length;
      if (totalLines <= visibleLines) return 100;
      return (visibleLines / totalLines) * 100;
    };

    this.scroller.calcIsActive = () => {
      if (!this.lines || this.lines.length === 0) return false;
      return this.lines.length > this.maxLines;
    };

    this.scroller.onScroll = (scrollRatio) => {
      this.applyScrollFromRatio(scrollRatio);
    };
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

  get longuerLine() {
    if (!this.editor.tabManager.activeFile) return;
    return this.editor.tabManager.activeFile?.longuerLine;
  }

  set longuerLine(value) {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.tabManager.activeFile.longuerLine = value;
  }

  get maxCharactersPerLine() {
    return (
      parseInt(this.editor.output.clientWidth / this.editor.letterSize) + 5
    ); // + marge
  }

  get maxViewLines() {
    return parseInt(this.editor.output.clientHeight / this.editor.posY) + 5; // + marge
  }

  get maxCharacters() {
    return (
      parseInt(this.editor.output.clientWidth / this.editor.letterSize) - 1
    ); // - marge
  }

  get maxLines() {
    return parseInt(this.editor.output.clientHeight / this.editor.posY);
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
    this.lines = [""];
    this.markDirtyLineFrom(0);
  }

  markDirtyAll() {
    this.markDirtyLineFrom(0);
  }

  markDirtyLineFrom(dataIndex) {
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
    if (line.length > this.maxCharactersPerLine) {
      line = line.slice(0, this.maxCharactersPerLine);
    }

    let lineOBJ = this.createLineOBJ(line, screenIndex);
    if (!lineOBJ) return;

    lineOBJ.dataset.line = dataIndex;

    if (child.textContent !== lineOBJ.textContent) {
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
        if (line.length > this.longuerLine) this.longuerLine = line.length;
        if (line.length > this.maxCharactersPerLine)
          line = line.slice(0, this.maxCharactersPerLine);

        lineOBJ = this.createLineOBJ(line, i);
      }

      lineOBJ.dataset.line = dataIndex;
      fragment.appendChild(lineOBJ);
    }

    this.editor.output.replaceChildren(fragment);
    this.scroller.nbItem = this.lines.length;
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

    this.scroller.nbItem = this.lines.length;
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

    this.scroller.nbItem = this.lines.length;
    this.applyScrollFromRatio(this.scroller.scrollRatio);
    this.scroller.refresh();
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
}
