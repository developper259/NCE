class OutputScroller {
  constructor(editor) {
    this.editor = editor;
    this.lineController = null;
    this.vScroller = null;
    this.hScroller = null;
    this.marginChars = 10;

    this.marginLines = 3;
  }

  setLineController(lineController) {
    this.lineController = lineController;
    this.init();
  }

  hide() {
    this.vScroller.hide();
    this.hScroller.hide();
  }

  show() {
    this.vScroller.show();
    this.hScroller.show();
  }

  getTotalScrollLines() {
    if (!this.lineController) return 0;
    return this.lineController.getDisplayLineCount();
  }

  getEffectiveTotalLines() {
    const totalLines = this.getTotalScrollLines();
    const maxLines = this.lineController.maxLines;

    if (totalLines <= maxLines) {
      return totalLines;
    }

    return totalLines + this.marginLines;
  }

  getVisibleHorizontalWidth() {
    const outputWidth = this.editor.output
      ? this.editor.output.clientWidth ||
        this.editor.output.getBoundingClientRect().width
      : this.lineController.outputWidth || 0;

    return Math.max(0, outputWidth);
  }

  init() {
    // Vertical scroller
    this.vScroller = this.editor.scrollerManager.createScroller(
      this.editor.editorOBJ,
      this.editor.scrollerManager.VERTICAL_TYPE,
      false,
    );
    this.editor.scrollerManager.addScroller(this.vScroller);
    this.vScroller.onRefresh = () => {
      this.lineController.refresh();
    };

    this.vScroller.nbItem = this.getTotalScrollLines();
    this.vScroller.heightByItem = this.editor.posY;

    this.vScroller.calculProp = () => {
      if (this.getTotalScrollLines() === 0) return 0;
      const visibleLines = this.lineController.maxLines;
      const totalLines = this.getEffectiveTotalLines();
      if (totalLines <= visibleLines) return 100;
      return (visibleLines / totalLines) * 100;
    };

    this.vScroller.calcIsActive = () => {
      if (this.getTotalScrollLines() === 0) return false;
      return this.getTotalScrollLines() > this.lineController.maxLines;
    };

    this.vScroller.onScroll = (scrollRatio) => {
      this.applyVerticalScrollFromRatio(scrollRatio);
      this.lineController.refresh(true);
    };

    // Horizontal scroller
    this.hScroller = this.editor.scrollerManager.createScroller(
      this.editor.editorOBJ,
      this.editor.scrollerManager.HORIZONTAL_TYPE,
      false,
    );
    this.hScroller.wheelTarget = this.editor.output;
    this.editor.scrollerManager.addScroller(this.hScroller);
    this.hScroller.onRefresh = () => {
      this.lineController.refresh();
    };

    this.hScroller.heightByItem = 1;

    this.hScroller.calculProp = () => {
      if (this.getTotalScrollLines() === 0) return 0;

      const maxLineLength =
        this.lineController.maxLineLength + this.marginChars;
      const visibleWidthChars =
        this.getVisibleHorizontalWidth() / this.editor.letterSize;

      if (maxLineLength <= visibleWidthChars) return 100;
      return (visibleWidthChars / maxLineLength) * 100;
    };

    this.hScroller.calcIsActive = () => {
      if (this.getTotalScrollLines() === 0) return false;

      const maxLineLength =
        this.lineController.maxLineLength + this.marginChars;
      const visibleWidthChars =
        this.getVisibleHorizontalWidth() / this.editor.letterSize;

      return maxLineLength > visibleWidthChars;
    };

    this.hScroller.onScroll = (scrollRatio) => {
      this.applyHorizontalScrollFromRatio(scrollRatio);
      this.lineController.refresh(true);
    };
  }

  getHorizontalScrollRatioFromState() {
    if (this.getTotalScrollLines() === 0) return 0;

    const maxLineLength = this.lineController.maxLineLength + this.marginChars;
    const visibleWidthChars =
      this.getVisibleHorizontalWidth() / this.editor.letterSize;
    const maxScrollX = Math.max(0, maxLineLength - visibleWidthChars);
    if (maxScrollX === 0) return 0;

    return this.lineController.offsetX / maxScrollX;
  }

  applyHorizontalScrollFromRatio(scrollRatio) {
    if (this.getTotalScrollLines() === 0) return;

    if (!this.hScroller.calcIsActive()) {
      if (this.lineController.offsetX !== 0) {
        this.lineController.offsetX = 0;
        this.applyScrollTransform();
        this.lineController.markDirtyAll();
        this.lineController.refreshOutput();
        this.editor.cursorController.updateCaretPosition();
        this.editor.selectController.refreshSelectPositions();
      }
      return;
    }

    const maxLineLength = this.lineController.maxLineLength + this.marginChars;
    const visibleWidthChars =
      this.getVisibleHorizontalWidth() / this.editor.letterSize;

    const maxScrollX = Math.max(0, maxLineLength - visibleWidthChars);

    scrollRatio = Math.max(0, Math.min(scrollRatio, 1));
    this.hScroller.setScrollRatio(scrollRatio);

    const currentScrollX = scrollRatio * maxScrollX;
    const newOffsetX = Math.round(currentScrollX);

    if (this.lineController.offsetX !== newOffsetX) {
      this.lineController.offsetX = newOffsetX;
      this.applyScrollTransform();
    }
  }

  getVerticalScrollRatioFromState() {
    if (this.getTotalScrollLines() === 0) return 0;

    const posY = this.editor.posY;
    const maxStartIndex = this.getMaxStartIndex();
    if (maxStartIndex === 0) return 0;

    const currentPosition =
      this.lineController.startIndex + this.lineController.offsetY / posY;

    return currentPosition / maxStartIndex;
  }

  applyVerticalScrollFromRatio(scrollRatio) {
    if (this.getTotalScrollLines() === 0) return;

    if (!this.vScroller.calcIsActive()) {
      if (
        this.lineController.startIndex !== 0 ||
        this.lineController.offsetY !== 0
      ) {
        this.resetScroll();
        this.lineController.markDirtyAll();
        this.lineController.refreshOutput();
        this.lineController.refreshNumberLines();
        this.editor.cursorController.updateCaretPosition();
        this.editor.selectController.refreshSelectPositions();
      }
      return;
    }

    const posY = this.editor.posY;
    const maxStartIndex = this.getMaxStartIndex();

    scrollRatio = Math.max(0, Math.min(scrollRatio, 1));
    this.vScroller.setScrollRatio(scrollRatio);

    const scrollPosition = scrollRatio * maxStartIndex;
    let newStartIndex = Math.min(Math.floor(scrollPosition), maxStartIndex);
    let newOffsetY = (scrollPosition - newStartIndex) * posY;

    const startIndexChanged = this.lineController.startIndex !== newStartIndex;

    this.lineController.startIndex = newStartIndex;
    this.lineController.offsetY = newOffsetY;
    this.applyScrollTransform();
  }

  applyScrollTransform() {
    this.editor.lineNumberOutput.style.transform = "";
    this.lineController.applyOutputTransform();
  }

  resetScroll() {
    this.lineController.startIndex = 0;
    this.lineController.offsetY = 0;
    if (this.vScroller) this.vScroller.setScrollRatio(0);
    this.applyScrollTransform();
  }

  clampScrollState() {
    if (this.getTotalScrollLines() === 0) {
      this.lineController.startIndex = 0;
      this.lineController.offsetY = 0;
      return;
    }

    const posY = this.editor.posY;
    const maxStart = this.getMaxStartIndex();
    if (this.lineController.startIndex > maxStart)
      this.lineController.startIndex = maxStart;
    if (this.lineController.startIndex < 0) this.lineController.startIndex = 0;

    const maxOffsetY = Math.max(
      0,
      (maxStart - this.lineController.startIndex) * posY,
    );
    if (this.lineController.offsetY > maxOffsetY)
      this.lineController.offsetY = maxOffsetY;
    if (this.lineController.offsetY < 0) this.lineController.offsetY = 0;
  }

  getMaxStartIndex() {
    if (this.getTotalScrollLines() === 0) return 0;

    const overflow = this.getTotalScrollLines() - this.lineController.maxLines;

    if (overflow <= 0) {
      return 0;
    }

    return overflow;
  }

  restoreScroll() {
    if (!this.editor.tabManager.activeFile) return;

    this.vScroller.nbItem = this.getTotalScrollLines();

    this.clampScrollState();

    if (this.vScroller.calcIsActive()) {
      this.vScroller.setActive(true);
    }
    if (this.hScroller.calcIsActive()) {
      this.hScroller.setActive(true);
    }

    this.vScroller.setScrollRatio(this.getVerticalScrollRatioFromState());
    this.applyScrollTransform();

    const vMetrics = this.vScroller.readThumbMetrics();
    if (vMetrics) this.vScroller.writeThumbPosition(vMetrics);

    this.hScroller.nbItem = this.lineController.maxLineLength;
    this.hScroller.setScrollRatio(this.getHorizontalScrollRatioFromState());
    this.applyHorizontalScrollFromRatio(this.hScroller.scrollRatio);

    const hMetrics = this.hScroller.readThumbMetrics();
    if (hMetrics) this.hScroller.writeThumbPosition(hMetrics);
    this.refresh();
  }

  refresh() {
    if (this.vScroller) this.vScroller.refreshMetrics();
    if (this.hScroller) this.hScroller.refreshMetrics();

    this.vScroller.nbItem = this.getTotalScrollLines();
    this.vScroller.setScrollRatio(this.getVerticalScrollRatioFromState());
    this.applyVerticalScrollFromRatio(this.vScroller.scrollRatio);
    this.vScroller.refresh();

    if (this.vScroller.calcIsActive()) {
      this.vScroller.setActive(true);
    }

    this.hScroller.nbItem = this.lineController.maxLineLength;
    this.hScroller.setScrollRatio(this.getHorizontalScrollRatioFromState());
    this.applyHorizontalScrollFromRatio(this.hScroller.scrollRatio);
    this.hScroller.refresh();
    if (this.hScroller.calcIsActive()) {
      this.hScroller.setActive(true);
    }
  }

  updateNbItem() {
    if (this.getTotalScrollLines() === 0) return;

    this.vScroller.nbItem = this.getTotalScrollLines();
    this.hScroller.nbItem = this.lineController.maxLineLength + 2;
  }

  scrollTo(row, column) {
    if (this.getTotalScrollLines() === 0) return;

    let verticalChanged = false;
    let horizontalChanged = false;

    if (row !== undefined && row !== null && !isNaN(row)) {
      row = Math.max(0, Math.min(row, this.getTotalScrollLines() - 1));
      const maxStartIndex = this.getMaxStartIndex();

      this.lineController.startIndex = Math.min(row, maxStartIndex);
      this.lineController.offsetY = 0;
      verticalChanged = true;
    }

    if (column !== undefined && column !== null && !isNaN(column)) {
      const activeRow =
        row !== undefined && row !== null && !isNaN(row)
          ? row
          : this.editor.cursorController?.row || 0;

      const safeRow = Math.max(
        0,
        Math.min(activeRow, this.lineController.lines.length - 1),
      );
      const lineNode = this.lineController.lines[safeRow];
      const line = lineNode ? lineNode.getText() : "";
      column = Math.max(0, Math.min(column, line.length));

      const visualPos = realColumnToViewColumn(line, column);

      const visibleWidthChars = Math.floor(
        this.getVisibleHorizontalWidth() / this.editor.letterSize,
      );

      const maxLineLength =
        this.lineController.maxLineLength + this.marginChars;
      const maxScrollX = Math.max(0, maxLineLength - visibleWidthChars);

      this.lineController.offsetX = Math.min(visualPos, maxScrollX);
      horizontalChanged = true;
    }

    if (verticalChanged) {
      this.vScroller.setScrollRatio(this.getVerticalScrollRatioFromState());
      this.applyScrollTransform();
    }

    if (horizontalChanged) {
      this.hScroller.setScrollRatio(this.getHorizontalScrollRatioFromState());
      this.applyHorizontalScrollFromRatio(this.hScroller.scrollRatio);
    }

    if (verticalChanged || horizontalChanged) {
      this.lineController.markDirtyAll();
      this.lineController.refreshOutput();
      this.lineController.refreshNumberLines();

      this.vScroller.refresh();
      this.hScroller.refresh();
      this.editor.cursorController.updateCaretPosition();
      this.editor.selectController.refreshSelectPositions();
      this.editor.searchController.refreshSelectionDOM();
    }
  }
}
