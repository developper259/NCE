class OutputScroller {
  constructor(editor) {
    this.editor = editor;
    this.lineController = null;
    this.vScroller = null;
    this.hScroller = null;
    this.marginChars = 10;
  }

  setLineController(lineController) {
    this.lineController = lineController;
    this.init();
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

    this.vScroller.nbItem = this.lineController.lines?.length || 0;
    this.vScroller.heightByItem = this.editor.posY;

    this.vScroller.calculProp = () => {
      if (!this.lineController.lines || this.lineController.lines.length === 0)
        return 0;
      const visibleLines = this.lineController.maxLines;
      const totalLines = this.lineController.lines.length;
      if (totalLines <= visibleLines) return 100;
      return (visibleLines / totalLines) * 100;
    };

    this.vScroller.calcIsActive = () => {
      if (!this.lineController.lines || this.lineController.lines.length === 0)
        return false;
      return this.lineController.lines.length > this.lineController.maxLines;
    };

    this.vScroller.onScroll = (scrollRatio) => {
      this.applyVerticalScrollFromRatio(scrollRatio);
    };

    // Horizontal scroller
    this.hScroller = this.editor.scrollerManager.createScroller(
      this.editor.editorOBJ,
      this.editor.scrollerManager.HORIZONTAL_TYPE,
      false,
    );
    this.editor.scrollerManager.addScroller(this.hScroller);
    this.hScroller.onRefresh = () => {
      this.lineController.refresh();
    };

    this.hScroller.nbItem = 1000;
    this.hScroller.heightByItem = 1;

    this.hScroller.calculProp = () => {
      if (!this.lineController.lines || this.lineController.lines.length === 0)
        return 0;

      const maxLineLength =
        this.lineController.maxLineLength + this.marginChars;
      const visibleWidthPixels =
        this.lineController.outputWidth - this.editor.baseX;
      const visibleWidthChars = visibleWidthPixels / this.editor.letterSize;

      if (maxLineLength <= visibleWidthChars) return 100;
      return (visibleWidthChars / maxLineLength) * 100;
    };

    this.hScroller.calcIsActive = () => {
      if (!this.lineController.lines || this.lineController.lines.length === 0)
        return false;

      const maxLineLength =
        this.lineController.maxLineLength + this.marginChars;
      const visibleWidthPixels =
        this.lineController.outputWidth - this.editor.baseX;
      const visibleWidthChars = visibleWidthPixels / this.editor.letterSize;

      return maxLineLength > visibleWidthChars;
    };

    this.hScroller.onScroll = (scrollRatio) => {
      this.applyHorizontalScrollFromRatio(scrollRatio);
    };
  }

  getHorizontalScrollRatioFromState() {
    if (!this.lineController.lines || this.lineController.lines.length === 0)
      return 0;

    const maxLineLength = this.lineController.maxLineLength + this.marginChars;
    const visibleWidthPixels =
      this.lineController.outputWidth - this.editor.baseX;
    const visibleWidthChars = visibleWidthPixels / this.editor.letterSize;
    const maxScrollX = Math.max(0, maxLineLength - visibleWidthChars);
    if (maxScrollX === 0) return 0;

    return this.lineController.offsetX / maxScrollX;
  }

  applyHorizontalScrollFromRatio(scrollRatio) {
    if (!this.lineController.lines || this.lineController.lines.length === 0)
      return;

    if (!this.hScroller.calcIsActive()) {
      if (this.lineController.offsetX !== 0) {
        this.lineController.offsetX = 0;
        this.lineController.markDirtyAll();
        this.lineController.refreshOutput();
        this.editor.cursor.updateCaretPosition();
        this.editor.selectController.refreshSelectPositions();
      }
      return;
    }

    const maxLineLength = this.lineController.maxLineLength + this.marginChars;
    const visibleWidthPixels =
      this.lineController.outputWidth - this.editor.baseX;
    const visibleWidthChars = visibleWidthPixels / this.editor.letterSize;

    const maxScrollX = Math.max(0, maxLineLength - visibleWidthChars);

    scrollRatio = Math.max(0, Math.min(scrollRatio, 1));
    this.hScroller.setScrollRatio(scrollRatio);

    const currentScrollX = scrollRatio * maxScrollX;
    const newOffsetX = Math.round(currentScrollX);

    if (this.lineController.offsetX !== newOffsetX) {
      this.lineController.offsetX = newOffsetX;
      this.lineController.markDirtyAll();
      this.lineController.refreshOutput();
      this.editor.cursor.updateCaretPosition();
      this.editor.selectController.refreshSelectPositions();
    }
  }

  getVerticalScrollRatioFromState() {
    if (!this.lineController.lines || this.lineController.lines.length === 0)
      return 0;

    const posY = this.editor.posY;
    const viewportHeight = this.lineController.outputHeight;
    const totalHeight = this.lineController.lines.length * posY;
    const maxScrollY = Math.max(0, totalHeight - viewportHeight);
    if (maxScrollY === 0) return 0;

    return (
      (this.lineController.startIndex * posY + this.lineController.offsetY) /
      maxScrollY
    );
  }

  applyVerticalScrollFromRatio(scrollRatio) {
    if (!this.lineController.lines || this.lineController.lines.length === 0)
      return;

    if (!this.vScroller.calcIsActive()) {
      if (
        this.lineController.startIndex !== 0 ||
        this.lineController.offsetY !== 0
      ) {
        this.resetScroll();
        this.lineController.markDirtyAll();
        this.lineController.refreshOutput();
        this.lineController.refreshNumberLines();
        this.editor.cursor.updateCaretPosition();
        this.editor.selectController.refreshSelectPositions();
      }
      return;
    }

    const posY = this.editor.posY;
    const totalHeight = this.lineController.lines.length * posY;
    const viewportHeight = this.lineController.outputHeight;
    const maxScrollY = Math.max(0, totalHeight - viewportHeight);
    const maxStartIndex = this.getMaxStartIndex();

    scrollRatio = Math.max(0, Math.min(scrollRatio, 1));
    this.vScroller.setScrollRatio(scrollRatio);

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

    const startIndexChanged = this.lineController.startIndex !== newStartIndex;

    this.lineController.startIndex = newStartIndex;
    this.lineController.offsetY = newOffsetY;
    this.applyScrollTransform();
    this.editor.cursor.updateCaretPosition();
    this.editor.selectController.refreshSelectPositions();

    if (startIndexChanged) {
      this.lineController.markDirtyAll();
      this.lineController.refreshOutput();
      this.lineController.refreshNumberLines();
    }
  }

  applyScrollTransform() {
    this.editor.output.style.transform = "";
    this.lineController.lineN.style.transform = "";
    this.lineController.refreshLinePositions();
  }

  resetScroll() {
    this.lineController.startIndex = 0;
    this.lineController.offsetY = 0;
    if (this.vScroller) this.vScroller.setScrollRatio(0);
    this.applyScrollTransform();
  }

  clampScrollState() {
    if (!this.lineController.lines || this.lineController.lines.length === 0) {
      this.lineController.startIndex = 0;
      this.lineController.offsetY = 0;
      return;
    }

    const posY = this.editor.posY;
    const maxStart = this.getMaxStartIndex();
    if (this.lineController.startIndex > maxStart)
      this.lineController.startIndex = maxStart;
    if (this.lineController.startIndex < 0) this.lineController.startIndex = 0;

    const viewportHeight = this.lineController.outputHeight;
    const totalHeight = this.lineController.lines.length * posY;
    const maxOffsetY = Math.max(
      0,
      totalHeight - this.lineController.startIndex * posY - viewportHeight,
    );
    if (this.lineController.offsetY > maxOffsetY)
      this.lineController.offsetY = maxOffsetY;
    if (this.lineController.offsetY < 0) this.lineController.offsetY = 0;
  }

  getMaxStartIndex() {
    if (this.lineController.totalLines === 0) return 0;
    return Math.max(
      0,
      this.lineController.totalLines - this.lineController.maxLines,
    );
  }

  restoreScroll() {
    if (!this.editor.tabManager.activeFile) return;

    this.vScroller.nbItem = this.lineController.lines.length;

    this.clampScrollState();

    this.vScroller.refresh();
    this.hScroller.refresh();

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
    this.vScroller.refresh();

    this.hScroller.nbItem = this.lineController.maxLineLength;
    this.hScroller.setScrollRatio(this.getHorizontalScrollRatioFromState());
    this.applyHorizontalScrollFromRatio(this.hScroller.scrollRatio);

    const hMetrics = this.hScroller.readThumbMetrics();
    if (hMetrics) this.hScroller.writeThumbPosition(hMetrics);
    this.hScroller.refresh();

    this.lineController.markDirtyAll();
    this.lineController.refreshOutput();
    this.lineController.refreshNumberLines();

    this.editor.cursor.updateCaretPosition();
    this.editor.selectController.refreshSelectPositions();
  }

  refresh() {
    this.vScroller.nbItem = this.lineController.lines.length;
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
    this.vScroller.nbItem = this.lineController.lines.length;
    this.hScroller.nbItem = this.lineController.maxLineLength;
  }

  scrollTo(row, column) {
    if (!this.lineController.lines || this.lineController.lines.length === 0)
      return;

    let verticalChanged = false;
    let horizontalChanged = false;

    if (row !== undefined && row !== null && !isNaN(row)) {
      row = Math.max(0, Math.min(row, this.lineController.lines.length - 1));
      const maxStartIndex = this.getMaxStartIndex();

      this.lineController.startIndex = Math.min(row, maxStartIndex);
      this.lineController.offsetY = 0;
      verticalChanged = true;
    }

    if (column !== undefined && column !== null && !isNaN(column)) {
      const activeRow =
        row !== undefined && row !== null && !isNaN(row)
          ? row
          : this.editor.cursor?.row || 0;

      const safeRow = Math.max(
        0,
        Math.min(activeRow, this.lineController.lines.length - 1),
      );
      const line = this.lineController.lines[safeRow] || "";
      column = Math.max(0, Math.min(column, line.length));

      const tabWidth = CONFIG_GET("tab_width");
      let visualPos = 0;
      for (let i = 0; i < column; i++) {
        visualPos += line[i] === "\t" ? tabWidth : 1;
      }

      const cachedWidth = this.lineController.outputWidth;
      const visibleWidthPixels = cachedWidth - this.editor.baseX;
      const visibleWidthChars = Math.floor(
        visibleWidthPixels / this.editor.letterSize,
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
      this.editor.cursor.updateCaretPosition();
      this.editor.selectController.refreshSelectPositions();
    }
  }
}
