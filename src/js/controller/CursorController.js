class CursorController {
  constructor(e) {
    this.editor = e;
    this.caretFast = e.domManager?.wrapFastNode?.(e.cD) || null;
    this._row = 0;
    this._column = 0;
    this.mX = 10; // diff X axis
    this.mY = 7; // diff Y axis
    this.mpY = 19; // diff on calcul Y axis
    this.mpX = 10; // diff on calcul X axis
    this.viewPositionCache = null;
    this.renderedTextIndexCache = new WeakMap();

    this.caretFast?.setHeight(this.editor.posY);
    this.caretFast?.setStyle("marginLeft", `${this.mpX}px`);
  }

  get row() {
    return this.editor.tabManager.activeFile?.row;
  }

  set row(value) {
    if (this.editor.tabManager.activeFile) {
      this.editor.tabManager.activeFile.row = value;
    }
  }

  get column() {
    return this.editor.tabManager.activeFile?.column;
  }

  set column(value) {
    if (this.editor.tabManager.activeFile) {
      this.editor.tabManager.activeFile.column = value;
    }
  }

  enable() {
    if (this.editor.cD) {
      this.caretFast?.setDisplay("block");
    }
  }

  disable() {
    if (this.editor.cD) {
      this.caretFast?.setDisplay("none");
    }
  }

  rowToY(row) {
    const lc = this.editor.lineController;
    const displayIndex = lc.getDisplayIndexForCursor(row);
    const screenRow = displayIndex - lc.startIndex;
    return lc.getLineTop(screenRow) + 4;
  }

  columnToX(viewColumn) {
    const offsetXChars = this.editor.lineController.offsetX || 0;
    return (
      this.editor.baseX +
      (viewColumn - 1 - offsetXChars) * this.editor.letterSize +
      1
    );
  }

  getCaretPosition(row, column) {
    const lineController = this.editor.lineController;
    const viewPosition = this.getViewPosition(row, column);
    const viewColumn = viewPosition.column;
    let renderedX = null;

    const displayIndex = lineController.getDisplayIndexForCursor(row);
    const screenIndex = displayIndex - lineController.startIndex;
    const lineElement = this.editor.output.children?.[screenIndex];
    const renderMeta = lineElement?.__nceRenderMeta;
    if (lineElement && renderMeta?.documentIndex === row - 1) {
      const startVisual = Number.isFinite(renderMeta.startVisual)
        ? renderMeta.startVisual
        : lineController.offsetX || 0;
      const endVisual = Number.isFinite(renderMeta.endVisual)
        ? renderMeta.endVisual
        : Number.POSITIVE_INFINITY;
      const text = lineElement.textContent || "";
      const visualOffset = Math.trunc(viewColumn - startVisual);

      if (visualOffset >= 0 && viewColumn <= endVisual) {
        const fontStatus = document.fonts?.status || "";
        let renderedLine = this.renderedTextIndexCache.get(lineElement);
        if (
          !renderedLine || renderedLine.text !== text ||
          renderedLine.fontStatus !== fontStatus
        ) {
          renderedLine = {
            text,
            fontStatus,
            index: typeof TextPositionIndex === "function"
              ? new TextPositionIndex(text, 1)
              : null,
            caretXByTextOffset: new Map(),
          };
          this.renderedTextIndexCache.set(lineElement, renderedLine);
        }
        const textOffset = renderedLine.index
          ? renderedLine.index.visualToReal(visualOffset, "nearest")
          : Math.min(visualOffset, text.length);
        if (textOffset <= text.length) {
          const cachedX = renderedLine.caretXByTextOffset.get(textOffset);
          if (Number.isFinite(cachedX)) {
            renderedX = this.editor.baseX + cachedX;
          } else {
            const walker = document.createTreeWalker(
              lineElement,
              typeof NodeFilter === "undefined" ? 4 : NodeFilter.SHOW_TEXT,
            );
            let textNode = walker.nextNode();
            let lastTextNode = null;
            let remaining = textOffset;
            while (textNode) {
              lastTextNode = textNode;
              const nodeLength = textNode.nodeValue?.length || 0;
              if (remaining <= nodeLength) break;
              remaining -= nodeLength;
              textNode = walker.nextNode();
            }
            if (!textNode && lastTextNode) {
              textNode = lastTextNode;
              remaining = textNode.nodeValue?.length || 0;
            }
            if (textNode) {
              const range = document.createRange();
              range.setStart(
                textNode,
                Math.min(remaining, textNode.nodeValue?.length || 0),
              );
              range.collapse(true);
              const textRect = range.getBoundingClientRect();
              const lineRect = lineElement.getBoundingClientRect();
              if (
                Number.isFinite(textRect.left) &&
                Number.isFinite(lineRect.left)
              ) {
                const caretX = textRect.left - lineRect.left;
                renderedLine.caretXByTextOffset.set(textOffset, caretX);
                renderedX = this.editor.baseX + caretX;
              }
            }
          }
        }
      }
    }

    return {
      left: renderedX === null
        ? this.columnToX(viewColumn)
        : renderedX - this.mpX,
      contentLeft: renderedX === null
        ? this.columnToX(viewColumn) + this.mpX
        : renderedX,
      top: this.rowToY(row) - 4 - lineController.offsetY,
      viewColumn,
    };
  }

  yToRow(y) {
    return roundY((y - this.editor.baseY) / this.editor.posY) + 1;
  }

  xToColumn(x) {
    return roundX(x / this.editor.letterSize);
  }

  columnFromSelectObj(obj) {
    const offsetXChars = this.editor.lineController.offsetX || 0;
    return (
      this.xToColumn(
        parseInt(window.getComputedStyle(obj).left, 10) - this.editor.baseX,
      ) + offsetXChars
    );
  }

  lengthFromSelectObj(obj) {
    return (
      parseInt(window.getComputedStyle(obj).width, 10) / this.editor.letterSize
    );
  }

  isNewPosition(row, realColumn) {
    return this.column !== realColumn || this.row !== row;
  }

  normalizePosition(row, column) {
    const lc = this.editor.lineController;

    if (row > lc.lines.length - 1) row = lc.lines.length;
    if (row <= 0) row = 1;

    const line = lc.lines[row - 1] ? lc.lines[row - 1].getText() : "";
    if (column < 0) column = 0;
    if (column > line.length) column = line.length;
    const lineNode = lc.lines[row - 1];
    const positionIndex = lineNode?.getPositionIndex?.();
    if (positionIndex) column = positionIndex.normalize(column, "nearest");
    else if (typeof normalizeTextBoundary === "function")
      column = normalizeTextBoundary(line, column, "nearest");

    return { row: row, column: column };
  }

  positionFromClientCoordinates(clientX, clientY, clampToViewport = false) {
    const rect = this.editor.domManager.getOutputRect();
    const right = Number.isFinite(rect.right)
      ? rect.right
      : rect.left + rect.width;
    const bottom = Number.isFinite(rect.bottom)
      ? rect.bottom
      : rect.top + rect.height;
    if (clampToViewport) {
      clientX = Math.max(rect.left, Math.min(clientX, right - 1));
      clientY = Math.max(rect.top, Math.min(clientY, bottom - 1));
    }
    const localX = clientX - rect.left;
    const lineController = this.editor.lineController;
    const scrollOffsetY = lineController.getScrollOffsetY();
    const lineHeight = lineController.getLineHeight() || this.editor.posY;
    // Mouse coordinates are viewport-local CSS pixels. Add the current vertical
    // scroll position before mapping through display rows so diff placeholders,
    // fractional scrolling, and measured font metrics share one coordinate space.
    const contentY = clientY - rect.top + scrollOffsetY;
    const displayIndex = lineHeight > 0
      ? Math.floor(contentY / lineHeight)
      : this.yToRow(contentY - this.mY) - 1;
    const displayRow = lineController.getDisplayRow(displayIndex);
    if (!displayRow) {
      const displayLineCount = this.editor.lineController.getDisplayLineCount();
      const lastDocumentRow = this.editor.lineController.lines.length;
      if (displayIndex < displayLineCount || lastDocumentRow === 0) return;

      const lastLine = this.editor.lineController.lines[lastDocumentRow - 1];
      const lastLineText = lastLine?.getText?.();
      return this.normalizePosition(lastDocumentRow, lastLineText?.length || 0);
    }
    if (displayRow.documentIndex === null) return;
    const targetRow = displayRow.documentIndex + 1;
    const scrollOffsetXChars = lineController.offsetX || 0;
    const targetViewColumn = this.xToColumn(localX) + scrollOffsetXChars;
    return this.getPosition(targetRow, targetViewColumn);
  }

  onClick(event, options = {}) {
    if (!this.editor.tabManager.activeFile) return;
    if (
      !this.editor.tabManager.activeFile ||
      this.editor.tabManager.activeFile.loadError
    )
      return;
    this.editor.keyBinding.historyX = undefined;

    const posReal = this.positionFromClientCoordinates(
      event.clientX,
      event.clientY,
      options.clampToViewport === true,
    );
    if (!posReal) return;

    // Reapply even an unchanged position so clicks can restore focus and show
    // the caret after it was hidden or the editor lost focus.
    this.setCursorPosition(posReal.row, posReal.column, options);

    return posReal;
  }

  setCursorPosition(r, c, options = {}) {
    if (!this.editor.tabManager.activeFile) return;
    if (
      !this.editor.tabManager.activeFile ||
      this.editor.tabManager.activeFile.loadError
    )
      return;

    const { row, column } = this.normalizePosition(r, c);

    this.editor.focusOutput();

    if (this.isNewPosition(row, column)) {
      this.row = row;
      this.column = column;

      this.editor.lineController.setFocusLine(this.row);
      this.editor.setSelected(true);

      if (!this.editor.isOnInit && options.emitEvent !== false) {
        this.editor.events.callEvent(Events.CURSOR_CHANGE, {
          row: this.row,
          column: this.column,
        });
      }
    }

    if (options.syncMultiCursor !== false)
      this.editor.multiCursorController?.syncPrimaryFromCursor?.(row, column);

    if (!this.editor.isOnInit && options.ensureVisible !== false)
      this.ensureCursorVisible();
    this.updateCaretPosition();
    if (options.renderMultiCursor !== false)
      this.editor.multiCursorController?.refreshOverlays?.();
  }

  ensureCursorVisible() {
    const lc = this.editor.lineController;
    if (!lc?.outputScroller || !this.editor.tabManager.activeFile) return false;

    const displayIndex = lc.getDisplayIndexForCursor(this.row);
    if (displayIndex < lc.startIndex) {
      lc.scrollTo(displayIndex);
    } else if (displayIndex >= lc.startIndex + lc.maxViewLines) {
      lc.scrollTo(displayIndex - lc.maxViewLines + 1);
    }

    const viewColumn = this.getViewPosition(this.row, this.column).column;
    const visibleColumns = Math.max(
      1,
      Math.floor(
        lc.outputScroller.getVisibleHorizontalWidth() / this.editor.letterSize,
      ),
    );
    const margin = Math.min(3, Math.max(0, visibleColumns - 1));
    let nextOffset = lc.offsetX;

    if (viewColumn < lc.offsetX + margin) {
      nextOffset = Math.max(0, viewColumn - margin);
    } else if (viewColumn > lc.offsetX + visibleColumns - margin - 1) {
      nextOffset = viewColumn - visibleColumns + margin + 1;
    }

    return lc.outputScroller.setHorizontalOffset(nextOffset);
  }

  isRowVisible(row) {
    const lc = this.editor.lineController;
    const displayIndex = lc.getDisplayIndexForCursor(row);
    const screenRow = displayIndex - lc.startIndex;
    if (screenRow < 0 || screenRow >= lc.maxViewLines) return false;

    const top = lc.getLineTop(screenRow) - lc.offsetY;
    const bottom = top + this.editor.posY;
    const viewport = lc.getViewportHeight();
    return bottom > 0 && top < viewport;
  }

  updateCaretPosition() {
    if (!this.editor.tabManager.activeFile) {
      this.disable();
      return;
    }

    if (!this.isRowVisible(this.row)) {
      this.disable();
      return;
    }

    const { left, top } = this.getCaretPosition(this.row, this.column);

    this.enable();
    this.caretFast?.setLeft(left);
    this.caretFast?.setTop(top);
  }

  getViewPosition(row, realColumn) {
    if (!this.editor.tabManager.activeFile) return { row: 1, column: 0 };

    const lc = this.editor.lineController;
    row = Math.max(1, Math.min(row, lc.lines.length));

    const lineNode = lc.lines[row - 1];
    if (!lineNode) return { row, column: 0 };

    const line = lineNode.getText();
    const safeRealCol = Math.max(0, Math.min(realColumn, line.length));
    const tabWidth = typeof SETTINGS_GET === "function"
      ? SETTINGS_GET("editor.tabWidth")
      : 4;
    const cached = this.viewPositionCache;
    if (
      cached && cached.lineNode === lineNode && cached.row === row &&
      cached.column === safeRealCol && cached.textVersion === lineNode.textVersion &&
      cached.tabWidth === tabWidth
    ) return { row, column: cached.viewColumn };
    const positionIndex = lineNode.getPositionIndex?.();
    const viewColumn = positionIndex
      ? positionIndex.realToVisual(safeRealCol)
      : realColumnToViewColumn(line, safeRealCol);
    this.viewPositionCache = {
      lineNode,
      row,
      column: safeRealCol,
      textVersion: lineNode.textVersion,
      tabWidth,
      viewColumn,
    };

    return { row: row, column: viewColumn };
  }

  getPosition(row, viewColumn) {
    if (!this.editor.tabManager.activeFile) return { row: 1, column: 0 };

    const lc = this.editor.lineController;
    row = Math.max(1, Math.min(row, lc.lines.length));

    const lineNode = lc.lines[row - 1];
    if (!lineNode) return { row, column: 0 };

    const line = lineNode.getText();
    const positionIndex = lineNode.getPositionIndex?.();
    return {
      row: row,
      column: positionIndex
        ? positionIndex.visualToReal(viewColumn)
        : viewColumnToRealColumn(line, viewColumn),
    };
  }

  getCursorPosition() {
    return { row: this.row, column: this.column };
  }

  getCursorReelPosition() {
    return { row: this.row, column: this.column };
  }

  getBeforeLetter() {
    const pos = this.getCursorPosition();
    const line = this.getLine();
    if (!line || pos.column <= 0) return undefined;

    return line[pos.column - 1];
  }

  getAfterLetter() {
    const pos = this.getCursorPosition();
    const line = this.getLine();
    if (!line || pos.column >= line.length) return undefined;

    return line[pos.column];
  }

  getLine() {
    if (!this.editor.lineController?.lines) return "";
    const lineNode = this.editor.lineController.lines[this.row - 1];
    return lineNode ? lineNode.getText() : "";
  }

  getBeforeLine() {
    if (!this.editor.lineController?.lines) return undefined;
    const lineNode = this.editor.lineController.lines[this.row - 2];
    return lineNode ? lineNode.getText() : undefined;
  }

  getAfterLine() {
    if (!this.editor.lineController?.lines) return undefined;
    const lineNode = this.editor.lineController.lines[this.row];
    return lineNode ? lineNode.getText() : undefined;
  }

  getIndexWord() {
    const line = this.getLine();
    if (!line) return -1;
    const lineNode = this.editor.lineController.lines[this.row - 1];
    const runs = this.editor.writerController.getWordRuns(lineNode || line);
    if (!runs.length) return -1;
    let low = 0;
    let high = runs.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (runs[mid].end <= this.column) low = mid + 1;
      else high = mid;
    }
    return Math.min(runs.length - 1, low);
  }

  getWord() {
    const line = this.getLine();
    if (!line) return undefined;

    const index = this.getIndexWord();
    const run = this.editor.writerController.getWordRuns(
      this.editor.lineController.lines[this.row - 1] || line,
    )[index];
    return run ? line.slice(run.start, run.end) : undefined;
  }

  getBeforeWord() {
    const line = this.getLine();
    if (!line) return undefined;

    const index = this.getIndexWord();
    const runs = this.editor.writerController.getWordRuns(
      this.editor.lineController.lines[this.row - 1] || line,
    );
    const run = index > 0 ? runs[index - 1] : null;
    return run ? line.slice(run.start, run.end) : undefined;
  }

  getAfterWord() {
    const line = this.getLine();
    if (!line) return undefined;

    const index = this.getIndexWord();
    const runs = this.editor.writerController.getWordRuns(
      this.editor.lineController.lines[this.row - 1] || line,
    );
    const run = index !== -1 && index < runs.length - 1 ? runs[index + 1] : null;
    return run ? line.slice(run.start, run.end) : undefined;
  }
}
