class LineController {
  constructor(editor) {
    this.editor = editor;

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

  get diffRows() {
    return this.editor.tabManager.activeFile?.diffRows || null;
  }

  getDisplayRows() {
    if (Array.isArray(this.diffRows) && this.diffRows.length > 0) {
      return this.diffRows;
    }
    return this.lines.map((line, documentIndex) => ({
      type: "unchanged",
      text: line.getText(),
      documentIndex,
    }));
  }

  getDisplayRow(displayIndex) {
    return this.getDisplayRows()[displayIndex] || null;
  }

  getDisplayIndexForDocument(documentIndex) {
    const displayIndex = this.getDisplayRows().findIndex(
      (row) => row.documentIndex === documentIndex,
    );
    return displayIndex >= 0 ? displayIndex : documentIndex;
  }

  getDisplayIndexForCursor(documentRow) {
    return this.getDisplayIndexForDocument(documentRow - 1);
  }

  getDisplayLineCount() {
    return this.getDisplayRows().length;
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
    const horizontalScroller = this.outputScroller?.hScroller;
    const horizontalHeight = horizontalScroller?.calcIsActive()
      ? horizontalScroller.scrollerOBJ?.offsetHeight || 10
      : 0;
    const availableHeight = Math.max(
      lineHeight,
      this.outputHeight - horizontalHeight + lineHeight,
    );

    return Math.max(1, parseInt(availableHeight / lineHeight));
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
    const horizontalScroller = this.outputScroller?.hScroller;
    const horizontalHeight = horizontalScroller?.calcIsActive()
      ? horizontalScroller.scrollerOBJ?.offsetHeight || 10
      : 0;
    const availableHeight = Math.max(
      lineHeight,
      this.outputHeight - horizontalHeight + lineHeight,
    );

    return parseInt(availableHeight / lineHeight);
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

    const overflow = this.getDisplayLineCount() - this.maxLines;

    if (overflow <= 0) {
      return 0;
    }

    return overflow;
  }

  getLineTop(screenIndex) {
    const baseY = this.editor.domManager
      ? this.editor.domManager.getOutputY()
      : this.editor.baseY;

    const lineHeight = this.editor.domManager
      ? this.editor.domManager.getLineHeight()
      : this.editor.posY;

    return lineHeight * screenIndex;
  }
  getOutputTransform() {
    const y = -this.offsetY;

    return `translate(0px, ${y}px)`;
  }

  applyOutputTransform() {
    const transform = this.getOutputTransform();

    this.editor.output.style.transform = transform;
    this.editor.lineNumberOutput.style.transform = transform;
    this.editor.selectOutput.style.transform = transform;
    this.editor.searchOutput.style.transform = transform;
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
    if (this.editor.tabManager.activeFile) {
      this.editor.tabManager.activeFile.diffRows = null;
    }

    this.totalLines = totalLines || this.lines.length;
    this.maxLineLength = 0;

    for (let i = 0; i < this.lines.length; i++) {
      const currentLineLength = this.getViewLineLength(i);
      if (currentLineLength > this.maxLineLength) {
        this.maxLineLength = currentLineLength;
      }
    }

    this.updateLineNumberWidth();

    if (this.outputScroller) {
      this.outputScroller.updateNbItem();
      this.outputScroller.refresh();
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

    return this.getViewTextLength(this.lines[i].getText());
  }

  getViewTextLength(text) {
    return getVisualTextLength(text);
  }

  refreshTabWidth() {
    this.maxLineLength = 0;

    for (let i = 0; i < this.lines.length; i++) {
      this.maxLineLength = Math.max(
        this.maxLineLength,
        this.getViewLineLength(i),
      );
    }

    this.markDirtyAll();
    this.refresh(true);
  }

  getViewNumberLines() {
    if (!this.lines) {
      return 0;
    }

    const visibleLines = this.getDisplayLineCount() - this.startIndex;

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

  clearDiffRows() {
    if (this.editor.tabManager.activeFile) {
      this.editor.tabManager.activeFile.diffRows = null;
    }
  }

  recalculatePersistentDiff() {
    const file = this.editor.tabManager.activeFile;
    if (!file || !file.diffActive || !file.diffSnapshot) {
      return;
    }
    const currentContent = this.getContent();
    const agent = this.editor.agent || this.editor.api?.agent;
    if (agent && typeof agent.markFileDiffHighlights === "function") {
      agent.markFileDiffHighlights(file.diffSnapshot, currentContent, file);
      this.markDirtyAll();
      if (this.outputScroller) {
        this.outputScroller.updateNbItem();
      }
      this.refresh(true);
    }
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
    let startChar = 0;
    let visualStart = 0;
    const tabWidth = normalizeTabWidth(CONFIG_GET("tab_width"));

    if (this.offsetX > 0) {
      while (startChar < line.length && visualStart < this.offsetX) {
        visualStart += line[startChar] === "\t" ? tabWidth : 1;
        startChar++;
      }
    }

    const maxWidth = this.maxCharactersPerLine;
    let visibleWidth = 0;
    let endChar = startChar;
    while (endChar < line.length) {
      const charWidth = line[endChar] === "\t" ? tabWidth : 1;
      if (visibleWidth + charWidth > maxWidth) break;
      visibleWidth += charWidth;
      endChar++;
    }

    return {
      text: line.slice(startChar, endChar),
      startChar,
      leftPaddingColumns: Math.max(0, visualStart - this.offsetX),
    };
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

      const displayIndex = this.getDisplayIndexForDocument(dataIndex);
      const screenIndex = displayIndex - this.startIndex;

      if (screenIndex >= 0 && screenIndex < this.renderedLineCount) {
        this.refreshLineOutput(screenIndex);
      }
    });

    const firstEmptyIndex = Math.max(
      0,
      this.getDisplayLineCount() - this.startIndex,
    );

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

    const displayIndex = this.startIndex + screenIndex;
    const displayRow = this.getDisplayRow(displayIndex);

    const child = this.editor.output.children[screenIndex];

    if (!child) {
      return;
    }

    if (!displayRow) {
      child.replaceChildren();

      child.removeAttribute("data-line");

      return;
    }

    const documentIndex = displayRow.documentIndex;
    const lineNode = documentIndex === null ? null : this.lines[documentIndex];
    const fullText = displayRow.text;

    const currentLineLength = this.getViewTextLength(fullText);

    if (currentLineLength > this.maxLineLength) {
      this.maxLineLength = currentLineLength;
    }

    let line = this.getSlicedLine(fullText);

    if (child.dataset.sourceText !== line.text) {
      let lineOBJ = this.createLineOBJ(line, screenIndex);

      if (!lineOBJ) {
        return;
      }

      lineOBJ.dataset.line = documentIndex === null ? "" : documentIndex;
      lineOBJ.dataset.displayLine = displayIndex;

      child.replaceWith(lineOBJ);

      if (documentIndex !== null) {
        this.editor.highlightController.setLineNode(documentIndex, lineOBJ);
      }

      if (lineNode && !lineNode.isHighlight) {
        if (documentIndex !== null) {
          this.editor.highlightController.markDirty(documentIndex);
        }
      }
    }
  }

  initLineOutput() {
    if (!this.editor.tabManager.activeFile) {
      return;
    }

    const fragment = document.createDocumentFragment();

    for (let i = 0; i < this.renderedLineCount; i++) {
      const displayIndex = this.startIndex + i;
      const displayRow = this.getDisplayRow(displayIndex);

      let lineOBJ;

      if (!displayRow) {
        lineOBJ = this.createLineOBJ(null, i);
      } else {
        const documentIndex = displayRow.documentIndex;
        const fullText = displayRow.text;
        const currentLineLength = this.getViewTextLength(fullText);

        if (currentLineLength > this.maxLineLength) {
          this.maxLineLength = currentLineLength;
        }

        const line = this.getSlicedLine(fullText);

        lineOBJ = this.createLineOBJ(line, i);

        lineOBJ.dataset.line = documentIndex === null ? "" : documentIndex;
        lineOBJ.dataset.displayLine = displayIndex;

        if (documentIndex !== null) {
          this.editor.highlightController.setLineNode(documentIndex, lineOBJ);
        }
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

    let children = this.editor.lineNumberOutput.children;

    const targetCount = this.getViewNumberLines();

    const diff = children.length - targetCount;

    if (diff > 0) {
      for (let i = 0; i < diff; i++) {
        this.editor.lineNumberOutput.lastElementChild.remove();
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

      this.editor.lineNumberOutput.appendChild(fragment);
    }

    for (let i = 0; i < children.length; i++) {
      const span = children[i];

      const displayIndex = this.startIndex + i;
      const displayRow = this.getDisplayRow(displayIndex);

      span.textContent =
        displayRow?.documentIndex === null
          ? ""
          : displayRow
            ? displayRow.documentIndex + 1
            : "";

      span.dataset.line =
        displayRow?.documentIndex === null
          ? ""
          : (displayRow?.documentIndex ?? "");
      span.dataset.displayLine = displayIndex;

      span.style.top = `${this.getLineTop(i)}px`;

      if (displayRow?.documentIndex === this.index - 1) {
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

    this.editor.lineNumberOutput.replaceChildren(fragment);

    this.updateLineNumberWidth();
  }

  createNumberLineOBJ(screenIndex, dataIndex) {
    const span = document.createElement("span");

    span.classList.add("line-el", "editor-el");

    const displayRow = this.getDisplayRow(dataIndex);

    if (displayRow?.documentIndex === this.index - 1) {
      span.classList.add("line-selected");
    }

    span.style.top = `${this.getLineTop(screenIndex)}px`;

    span.textContent =
      displayRow?.documentIndex === null
        ? ""
        : displayRow
          ? displayRow.documentIndex + 1
          : "";

    span.dataset.line =
      displayRow?.documentIndex === null
        ? ""
        : (displayRow?.documentIndex ?? "");
    span.dataset.displayLine = dataIndex;

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

    this.editor.lineNumberOutput.style.width = `${width}px`;

    this.editor.updateBaseX(width);
  }

  getVisibleTokens(tokens, slicedLine) {
    if (!tokens || !slicedLine) return null;
    const startChar = slicedLine.startChar;

    const endChar = startChar + slicedLine.text.length;

    const visible = [];

    for (const token of tokens) {
      const tokenStart = token.column - 1;
      const tokenEnd = tokenStart + token.value.length;

      if (tokenEnd <= startChar || tokenStart >= endChar) continue;

      const from = Math.max(startChar, tokenStart);
      const to = Math.min(endChar, tokenEnd);

      visible.push({
        ...token,
        value: token.value.slice(from - tokenStart, to - tokenStart),
        column: from - startChar + 1,
      });
    }

    return visible;
  }

  createLineOBJ(slicedLine, screenIndex) {
    const displayIndex = this.startIndex + screenIndex;
    const displayRow = this.getDisplayRow(displayIndex);
    const lineNode =
      displayRow?.documentIndex === null
        ? null
        : this.lines[displayRow?.documentIndex];
    const displayText = slicedLine?.text ?? displayRow?.text ?? "";
    const diffSegments =
      displayRow?.type === "removed"
        ? [{ type: "removed", text: displayText }]
        : null;
    const diffState = displayRow?.type || null;
    const tokens = lineNode?.getTokens();
    const visibleTokens = this.getVisibleTokens(tokens, slicedLine);

    const lineOBJ = this.editor.writerController.textToOBJ(
      displayText,
      visibleTokens,
      diffSegments,
    );

    lineOBJ.dataset.sourceText = displayText;

    if (diffState) {
      lineOBJ.classList.add(`line-${diffState}`);
    }

    lineOBJ.style.position = "absolute";
    lineOBJ.style.top = `${this.getLineTop(screenIndex)}px`;
    const leftPaddingColumns = slicedLine?.leftPaddingColumns || 0;
    lineOBJ.style.left = `${leftPaddingColumns * this.editor.letterSize}px`;

    return lineOBJ;
  }

  getLineOBJ(row) {
    return this.editor.output.children[row - 1];
  }

  getLineNumberOBJ(dataIndex) {
    const screenIndex =
      this.getDisplayIndexForDocument(dataIndex) - this.startIndex;

    if (
      screenIndex >= 0 &&
      screenIndex < this.editor.lineNumberOutput.children.length
    ) {
      return this.editor.lineNumberOutput.children[screenIndex];
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
    this.updateLineNumberWidth();

    this.outputScroller.updateNbItem();
    this.outputScroller.refresh();
    this.applyScrollTransform();

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
    this.editor.lineNumberOutput.replaceChildren();

    this.editor.output.replaceChildren();

    this.editor.lineNumberOutput.style.display = "none";

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
    this.editor.lineNumberOutput.style.display = "block";

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
