class LineController {
  constructor(editor) {
    this.editor = editor;

    this.lineN = document.querySelector(".line-numbers");

    this.outputWidth = this.editor.output.clientWidth;
    this.outputHeight = this.editor.output.clientHeight;

    this.dirtyLines = new Set();
    this.marginChars = 10;
    this.marginLines = 3;

    this.initScroller();
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

    const viewportHeight = this.outputHeight;
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
    const viewportHeight = this.outputHeight;
    const totalHeight = this.lines.length * posY;
    const maxScrollY = Math.max(0, totalHeight - viewportHeight);
    if (maxScrollY === 0) return 0;

    return (this.startIndex * posY + this.offsetY) / maxScrollY;
  }

  getHorizontalScrollRatioFromState() {
    if (!this.lines || this.lines.length === 0) return 0;

    const maxLineLength = this.maxLineLength + this.marginChars;
    const visibleWidthPixels = this.outputWidth - this.editor.baseX;
    const visibleWidthChars = visibleWidthPixels / this.editor.letterSize;
    const maxScrollX = Math.max(0, maxLineLength - visibleWidthChars);
    if (maxScrollX === 0) return 0;

    return this.offsetX / maxScrollX;
  }

  restoreScroll() {
    if (!this.editor.tabManager.activeFile) return;

    this.scroller.nbItem = this.lines.length;
    this.hScroller.nbItem = this.maxLineLength;

    this.clampScrollState();

    this.scroller.refresh();
    this.hScroller.refresh();

    if (this.scroller.calcIsActive()) {
      this.scroller.setActive(true);
    }
    if (this.hScroller.calcIsActive()) {
      this.hScroller.setActive(true);
    }

    this.scroller.setScrollRatio(this.getScrollRatioFromState());
    this.applyScrollTransform();

    const vMetrics = this.scroller.readThumbMetrics();
    if (vMetrics) this.scroller.writeThumbPosition(vMetrics);
    this.scroller.refresh();

    this.hScroller.setScrollRatio(this.getHorizontalScrollRatioFromState());
    this.applyHorizontalScrollFromRatio(this.hScroller.scrollRatio);

    const hMetrics = this.hScroller.readThumbMetrics();
    if (hMetrics) this.hScroller.writeThumbPosition(hMetrics);
    this.hScroller.refresh();

    this.markDirtyAll();
    this.refreshOutput();
    this.refreshNumberLines();

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
    const viewportHeight = this.outputHeight;
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
    // Vertical scroller
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

    // Horizontal scroller
    this.hScroller = this.editor.scrollerManager.createScroller(
      this.editor.editorOBJ,
      this.editor.scrollerManager.HORIZONTAL_TYPE,
      false,
    );
    this.editor.scrollerManager.addScroller(this.hScroller);
    this.hScroller.onRefresh = () => {
      this.refresh();
    };

    this.hScroller.nbItem = 1000;
    this.hScroller.heightByItem = 1;

    this.hScroller.calculProp = () => {
      if (!this.lines || this.lines.length === 0) return 0;

      const maxLineLength = this.maxLineLength + this.marginChars;
      const visibleWidthPixels = this.outputWidth - this.editor.baseX;
      const visibleWidthChars = visibleWidthPixels / this.editor.letterSize;

      if (maxLineLength <= visibleWidthChars) return 100;
      return (visibleWidthChars / maxLineLength) * 100;
    };

    this.hScroller.calcIsActive = () => {
      if (!this.lines || this.lines.length === 0) return false;

      const maxLineLength = this.maxLineLength + this.marginChars;
      const visibleWidthPixels = this.outputWidth - this.editor.baseX;
      const visibleWidthChars = visibleWidthPixels / this.editor.letterSize;

      return maxLineLength > visibleWidthChars;
    };

    this.hScroller.onScroll = (scrollRatio) => {
      this.applyHorizontalScrollFromRatio(scrollRatio);
    };
  }

  applyHorizontalScrollFromRatio(scrollRatio) {
    if (!this.lines || this.lines.length === 0) return;

    if (!this.hScroller.calcIsActive()) {
      if (this.offsetX !== 0) {
        this.offsetX = 0;
        this.markDirtyAll();
        this.refreshOutput();
        this.editor.cursor.updateCaretPosition();
        this.editor.selectController.refreshSelectPositions();
      }
      return;
    }

    const maxLineLength = this.maxLineLength + this.marginChars;
    const visibleWidthPixels = this.outputWidth - this.editor.baseX;
    const visibleWidthChars = visibleWidthPixels / this.editor.letterSize;

    const maxScrollX = Math.max(0, maxLineLength - visibleWidthChars);

    scrollRatio = Math.max(0, Math.min(scrollRatio, 1));
    this.hScroller.setScrollRatio(scrollRatio);

    const currentScrollX = scrollRatio * maxScrollX;
    const newOffsetX = Math.round(currentScrollX);

    if (this.offsetX !== newOffsetX) {
      this.offsetX = newOffsetX;
      this.markDirtyAll();
      this.refreshOutput();
      this.editor.cursor.updateCaretPosition();
      this.editor.selectController.refreshSelectPositions();
    }
  }

  scrollTo(row, column) {
    if (!this.lines || this.lines.length === 0) return;

    let verticalChanged = false;
    let horizontalChanged = false;

    if (row !== undefined && row !== null && !isNaN(row)) {
      row = Math.max(0, Math.min(row, this.lines.length - 1));
      const maxStartIndex = this.getMaxStartIndex();

      this.startIndex = Math.min(row, maxStartIndex);
      this.offsetY = 0;
      verticalChanged = true;
    }

    if (column !== undefined && column !== null && !isNaN(column)) {
      const activeRow =
        row !== undefined && row !== null && !isNaN(row)
          ? row
          : this.editor.cursor?.row || 0;

      const safeRow = Math.max(0, Math.min(activeRow, this.lines.length - 1));
      const line = this.lines[safeRow] || "";
      column = Math.max(0, Math.min(column, line.length));

      const tabWidth = CONFIG_GET("tab_width");
      let visualPos = 0;
      for (let i = 0; i < column; i++) {
        visualPos += line[i] === "\t" ? tabWidth : 1;
      }

      const cachedWidth = this.outputWidth;
      const visibleWidthPixels = cachedWidth - this.editor.baseX;
      const visibleWidthChars = Math.floor(
        visibleWidthPixels / this.editor.letterSize,
      );

      const maxLineLength = this.maxLineLength + this.marginChars;
      const maxScrollX = Math.max(0, maxLineLength - visibleWidthChars);

      this.offsetX = Math.min(visualPos, maxScrollX);
      horizontalChanged = true;
    }

    if (verticalChanged) {
      this.scroller.setScrollRatio(this.getScrollRatioFromState());
      this.applyScrollTransform();
    }

    if (horizontalChanged) {
      this.hScroller.setScrollRatio(this.getHorizontalScrollRatioFromState());
      this.applyHorizontalScrollFromRatio(this.hScroller.scrollRatio);
    }

    if (verticalChanged || horizontalChanged) {
      this.markDirtyAll();
      this.refreshOutput();
      this.refreshNumberLines();

      this.scroller.refresh();
      this.hScroller.refresh();
      this.editor.cursor.updateCaretPosition();
      this.editor.selectController.refreshSelectPositions();
    }
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
    return parseInt(this.outputWidth / this.editor.letterSize) - 1; // - marge
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

  resizeWidth() {
    this.outputWidth = this.editor.output.clientWidth;
    this.markDirtyAll();
    this.scroller.refresh();
    this.hScroller.refresh();
  }

  resize() {
    this.outputWidth = this.editor.output.clientWidth;
    this.outputHeight = this.editor.output.clientHeight;
    this.markDirtyAll();
    this.refresh();
  }

  loadContent(content, totalLines) {
    this.lines = content.split("\n");
    this.totalLines = totalLines || this.lines.length;

    if (this.scroller) {
      this.scroller.nbItem = this.lines.length;
    }
    if (this.hScroller) {
      this.hScroller.nbItem = this.maxLineLength;
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
    if (this.hScroller) {
      this.hScroller.nbItem = this.maxLineLength;
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

    this.scroller.nbItem = this.lines.length;

    this.scroller.setScrollRatio(this.getScrollRatioFromState());
    this.applyScrollFromRatio(this.scroller.scrollRatio);
    this.scroller.refresh();

    if (this.scroller.calcIsActive()) {
      this.scroller.setActive(true);
    }

    this.hScroller.nbItem = this.maxLineLength;
    this.hScroller.setScrollRatio(this.getHorizontalScrollRatioFromState());
    this.applyHorizontalScrollFromRatio(this.hScroller.scrollRatio);
    this.hScroller.refresh();
    if (this.hScroller.calcIsActive()) {
      this.hScroller.setActive(true);
    }

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
    this.initLineOutput();
    this.initNumberLines();
    this.lineN.style.display = "block";
    this.editor.output.style.display = "block";
    const cursor = getElement(".editor-caret");
    cursor.style.display = "block";
  }
}
