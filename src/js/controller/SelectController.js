class SelectController {
  constructor(e) {
    this.editor = e;
    this.clickTime = 500;
    this.selectionAutoScrollFrame = null;
    this.dragClientPosition = null;
    this.selectionFastNodes = new WeakMap();
    this.initEventListeners();
  }

  getSelectionFastNode(node) {
    if (!node) return null;
    let fastNode = this.selectionFastNodes.get(node);
    if (!fastNode) {
      fastNode = this.editor.domManager?.wrapFastNode?.(node) || null;
      if (fastNode) this.selectionFastNodes.set(node, fastNode);
    }
    return fastNode;
  }

  setSelectionNodeStyle(node, name, value) {
    const fastNode = this.getSelectionFastNode(node);
    if (fastNode) return fastNode.setStyle(name, value);
    node.style[name] = value;
  }

  setSelectionNodeDisplay(node, value) {
    const fastNode = this.getSelectionFastNode(node);
    if (fastNode) return fastNode.setDisplay(value);
    node.style.display = value;
  }

  get selectedLines() {
    if (!this.editor.tabManager.activeFile) return new Map();
    return this.editor.tabManager.activeFile._selectedLines;
  }

  get isMouseDown() {
    if (!this.editor.tabManager.activeFile) return false;
    return this.editor.tabManager.activeFile.isMouseDown;
  }

  set isMouseDown(value) {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.tabManager.activeFile.isMouseDown = value;
  }

  get containsSelected() {
    if (!this.editor.tabManager.activeFile) return "";
    return this.getSelectedText();
  }

  set containsSelected(value) {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.tabManager.activeFile.containsSelected = value;
    this.editor.tabManager.activeFile._selectionTextCache = value;
  }

  get lastClick() {
    if (!this.editor.tabManager.activeFile) return null;
    return this.editor.tabManager.activeFile.lastClick;
  }

  set lastClick(value) {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.tabManager.activeFile.lastClick = value;
  }

  get clickCount() {
    if (!this.editor.tabManager.activeFile) return 0;
    return this.editor.tabManager.activeFile.clickCount;
  }

  set clickCount(value) {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.tabManager.activeFile.clickCount = value;
  }

  get HstartSelect() {
    if (!this.editor.tabManager.activeFile) return null;
    return this.editor.tabManager.activeFile.HstartSelect;
  }

  set HstartSelect(value) {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.tabManager.activeFile.HstartSelect = value;
  }

  get startSelect() {
    if (!this.editor.tabManager.activeFile) return null;
    return this.editor.tabManager.activeFile.startSelect;
  }

  set startSelect(value) {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.tabManager.activeFile.startSelect = value;
  }

  get endSelect() {
    if (!this.editor.tabManager.activeFile) return null;
    return this.editor.tabManager.activeFile.endSelect;
  }

  set endSelect(value) {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.tabManager.activeFile.endSelect = value;
  }

  setLogicalSelectionFromEndpoints() {
    const file = this.editor.tabManager.activeFile;
    if (!file || !this.startSelect || !this.endSelect) return;
    const a = { row: this.startSelect.row, column: this.startSelect.column };
    const b = { row: this.endSelect.row, column: this.endSelect.column };
    const ordered = a.row < b.row || (a.row === b.row && a.column <= b.column)
      ? { start: a, end: b }
      : { start: b, end: a };
    this.selectedLines.clear();
    file._selectionTextCache = null;
    file.containsSelected = "";
    file._selectionRange =
      ordered.start.row === ordered.end.row &&
      ordered.start.column === ordered.end.column
        ? null
        : ordered;
  }

  emitSelectionChange() {
    const payload = { start: this.startSelect, end: this.endSelect };
    Object.defineProperty(payload, "contains", {
      enumerable: true,
      get: () => this.hasActiveSelection() ? this.getSelectedText() : "",
    });
    this.editor.events.callEvent(Events.ON_SELECT, payload);
  }

  getLogicalSelection() {
    const range = this.editor.tabManager.activeFile?._selectionRange;
    if (range) {
      return {
        startRow: range.start.row,
        startColumn: range.start.column,
        endRow: range.end.row,
        endColumn: range.end.column,
      };
    }
    if (!this.selectedLines || this.selectedLines.size === 0) return null;

    const rows = Array.from(this.selectedLines.keys()).sort((a, b) => a - b);

    const firstRow = rows[0];
    const lastRow = rows[rows.length - 1];

    const startInfo = this.selectedLines.get(firstRow);
    const endInfo = this.selectedLines.get(lastRow);

    const realStart = this.editor.cursorController.getPosition(
      firstRow + 1,
      startInfo.startCol - 1,
    ).column;

    const realEnd = this.editor.cursorController.getPosition(
      lastRow + 1,
      endInfo.startCol - 1 + endInfo.length,
    ).column;

    return {
      startRow: firstRow + 1,
      startColumn: realStart,
      endRow: lastRow + 1,
      endColumn: realEnd,
    };
  }

  hasLineSelection(index) {
    if (this.selectedLines.has(index)) return true;
    const range = this.editor.tabManager.activeFile?._selectionRange;
    return !!range && index + 1 >= range.start.row && index + 1 <= range.end.row;
  }

  setSelection(start, end, { emitEvent = true } = {}) {
    if (!this.editor.tabManager.activeFile || !start || !end) return;
    this.editor.tabManager.activeFile._selectionRange = null;
    this.editor.tabManager.activeFile._selectionTextCache = null;

    const cursor = this.editor.cursorController;
    const normalizedStart = cursor.normalizePosition(start.row, start.column);
    const normalizedEnd = cursor.normalizePosition(end.row, end.column);

    this.startSelect = normalizedStart;
    this.endSelect = normalizedEnd;
    cursor.setCursorPosition(normalizedEnd.row, normalizedEnd.column, {
      emitEvent,
    });

    if (normalizedStart.row === normalizedEnd.row) {
      this.calculSelectSimpleLine();
    } else {
      this.calculSelectMultiLine();
    }

    if (emitEvent) this.emitSelectionChange();
  }

  refreshSelectionDOM() {
    if (!this.editor.tabManager.activeFile || !this.editor.selectOutput) return;

    const cursor = this.editor.cursorController;
    const lc = this.editor.lineController;
    const difY = 4;
    const radius = "4px";
    const visibleSelections = [];
    const startIndex = lc.startIndex || 0;
    const displayLineCount = typeof lc.getDisplayLineCount === "function"
      ? lc.getDisplayLineCount()
      : lc.lines.length;
    const visibleRows = Math.max(0, Math.min(
      lc.renderedLineCount || lc.maxViewLines || displayLineCount,
      displayLineCount - startIndex,
    ));
    for (let screenIndex = 0; screenIndex < visibleRows; screenIndex++) {
      const displayIndex = startIndex + screenIndex;
      const displayRow = typeof lc.getDisplayRow === "function"
        ? lc.getDisplayRow(displayIndex)
        : { documentIndex: displayIndex };
      if (!displayRow || displayRow.documentIndex === null) continue;
      const row = displayRow.documentIndex;
      const info = this.getSelectionInfoForLine(row);
      if (info) visibleSelections.push({ row, info });
    }

    const currentDOMNodes = this.editor.selectOutput.children;

    const totalLoopLength = Math.max(
      visibleSelections.length,
      currentDOMNodes.length,
    );

    for (let i = 0; i < totalLoopLength; i++) {
      if (i < visibleSelections.length) {
        const { row, info } = visibleSelections[i];
        const fileRow = row + 1;
        const visibleStart = Math.max(info.startCol - 1, lc.offsetX || 0);
        const visibleEnd = Math.min(
          info.startCol - 1 + Math.max(1, info.length),
          (lc.offsetX || 0) + (lc.maxCharactersPerLine || Number.MAX_SAFE_INTEGER),
        );
        if (visibleEnd <= visibleStart) {
          const hidden = currentDOMNodes[i];
          if (hidden) this.setSelectionNodeDisplay(hidden, "none");
          continue;
        }
        const x = cursor.columnToX(visibleStart + 1);
        // A zero-length logical selection can still represent the caret at
        // EOL (notably when selecting a newline). Keep it visible as one
        // character cell without changing the logical/copy range.
        const width = Math.max(1, visibleEnd - visibleStart) * this.editor.letterSize;

        const y = cursor.rowToY(fileRow) - difY;
        const height = cursor.mpY + difY;

        let div = currentDOMNodes[i];

        if (!div) {
          div = document.createElement("div");
          this.setSelectionNodeStyle(div, "position", "absolute");

          this.editor.selectOutput.appendChild(div);
        }

        const fastNode = this.getSelectionFastNode(div);
        if (fastNode) {
          fastNode.setClassName("selected");
          fastNode.setDataset("line", row);
        } else {
          div.className = "selected";
          div.dataset.line = row;
        }

        this.setSelectionNodeDisplay(div, "");
        const xFast = this.getSelectionFastNode(div);
        if (xFast) {
          xFast.setLeft(x);
          xFast.setTop(y);
          xFast.setWidth(width);
          xFast.setHeight(height);
        } else {
          div.style.left = `${x}px`;
          div.style.top = `${y}px`;
          div.style.width = `${width}px`;
          div.style.height = `${height}px`;
        }

        const currentLeft = visibleStart + 1;
        const currentRight = visibleEnd + 1;

        const previousInfo = this.getSelectionInfoForLine(row - 1);

        const nextInfo = this.getSelectionInfoForLine(row + 1);

        this.setSelectionNodeStyle(div, "borderTopLeftRadius", "0");
        this.setSelectionNodeStyle(div, "borderTopRightRadius", "0");
        this.setSelectionNodeStyle(div, "borderBottomLeftRadius", "0");
        this.setSelectionNodeStyle(div, "borderBottomRightRadius", "0");

        let topLeftConnected = false;
        let topRightConnected = false;

        if (previousInfo) {
          const previousLeft = previousInfo.startCol;
          const previousRight =
            previousInfo.startCol + Math.max(1, previousInfo.length);

          topLeftConnected =
            previousLeft <= currentLeft && previousRight > currentLeft;

          topRightConnected =
            previousLeft < currentRight && previousRight >= currentRight;
        }

        if (!topLeftConnected) {
          this.setSelectionNodeStyle(div, "borderTopLeftRadius", radius);
        }

        if (!topRightConnected) {
          this.setSelectionNodeStyle(div, "borderTopRightRadius", radius);
        }

        let bottomLeftConnected = false;
        let bottomRightConnected = false;

        if (nextInfo) {
          const nextLeft = nextInfo.startCol;
          const nextRight = nextInfo.startCol + Math.max(1, nextInfo.length);

          bottomLeftConnected =
            nextLeft <= currentLeft && nextRight > currentLeft;

          bottomRightConnected =
            nextLeft < currentRight && nextRight >= currentRight;
        }

        if (!bottomLeftConnected) {
          this.setSelectionNodeStyle(div, "borderBottomLeftRadius", radius);
        }

        if (!bottomRightConnected) {
          this.setSelectionNodeStyle(div, "borderBottomRightRadius", radius);
        }
      } else {
        if (currentDOMNodes[i]) {
          this.setSelectionNodeDisplay(currentDOMNodes[i], "none");
        }
      }
    }
  }

  refreshSelectPositions() {
    this.refreshSelectionDOM();
  }

  getSelectionInfoForLine(row) {
    const range = this.editor.tabManager.activeFile?._selectionRange;
    if (!range) return this.selectedLines.get(row) || null;
    const lines = this.editor.lineController.lines;
    const first = range.start.row - 1;
    const last = range.end.row - 1;
    if (row < first || row > last || row < 0 || row >= lines.length) return null;
    const text = lines[row]?.getText() || "";
    const realStart = row === first ? range.start.column : 0;
    const realEnd = row === last ? range.end.column : text.length;
    const visualStart = this.editor.cursorController.getViewPosition(row + 1, realStart).column;
    const visualEnd = this.editor.cursorController.getViewPosition(row + 1, realEnd).column;
    return { startCol: visualStart + 1, length: Math.max(0, visualEnd - visualStart) };
  }

  refreshContaisSelected() {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.tabManager.activeFile.containsSelected = "";
    this.editor.tabManager.activeFile._selectionTextCache = null;
  }

  getTextSelectedLine(index) {
    if (index === undefined) return undefined;

    const range = this.editor.tabManager.activeFile?._selectionRange;
    if (range) {
      const first = range.start.row - 1;
      const last = range.end.row - 1;
      if (index < first || index > last) return undefined;
      const text = this.editor.lineController.lines[index]?.getText() || "";
      return text.slice(index === first ? range.start.column : 0,
        index === last ? range.end.column : text.length);
    }

    const info = this.selectedLines.get(index);

    if (!info) return undefined;

    const lineNode = this.editor.lineController.lines[index];

    const rawLine = lineNode ? lineNode.getText() : "";

    const realStart = this.editor.cursorController.getPosition(
      index + 1,
      info.startCol - 1,
    ).column;

    const realEnd = this.editor.cursorController.getPosition(
      index + 1,
      info.startCol - 1 + info.length,
    ).column;

    return rawLine.slice(realStart, realEnd);
  }

  getNumberLineSelected() {
    const range = this.editor.tabManager.activeFile?._selectionRange;
    if (range) return Math.max(0, range.end.row - range.start.row + 1);
    return this.selectedLines.size;
  }

  hasActiveSelection() {
    if (this.editor.tabManager.activeFile?._selectionRange) return true;
    return this.selectedLines.size > 0;
  }

  getSelectedText() {
    const file = this.editor.tabManager.activeFile;
    if (!file) return "";
    if (file._selectionTextCache !== null) return file._selectionTextCache;
    const range = file._selectionRange;
    if (range) {
      const lines = this.editor.lineController.lines;
      const parts = [];
      for (let row = range.start.row; row <= range.end.row; row++) {
        const text = lines[row - 1]?.getText() || "";
        const start = row === range.start.row ? range.start.column : 0;
        const end = row === range.end.row ? range.end.column : text.length;
        parts.push(text.slice(start, end));
      }
      file._selectionTextCache = parts.join("\n");
      return file._selectionTextCache;
    }
    if (!this.selectedLines.size) return file.containsSelected || "";
    const parts = [];
    const cursor = this.editor.cursorController;
    const rows = Array.from(this.selectedLines.keys()).sort((a, b) => a - b);
    for (const row of rows) {
      const info = this.selectedLines.get(row);
      const line = this.editor.lineController.lines[row]?.getText() || "";
      const start = cursor.getPosition(row + 1, info.startCol - 1).column;
      const end = cursor.getPosition(row + 1, info.startCol - 1 + info.length).column;
      parts.push(line.slice(start, end));
    }
    file._selectionTextCache = parts.join("\n");
    return file._selectionTextCache;
  }

  getSelectionLength() {
    const range = this.getLogicalSelection();
    if (!range) return 0;
    const lines = this.editor.lineController.lines;
    if (range.startRow === range.endRow)
      return Math.max(0, range.endColumn - range.startColumn);
    const firstIndex = range.startRow - 1;
    const lastIndex = range.endRow - 1;
    const firstLength = lines[firstIndex]?.getText().length || 0;
    const middleLength = this.editor.lineController.sumLineTextLengths?.(
      firstIndex + 1,
      lastIndex,
    ) ?? lines.slice(firstIndex + 1, lastIndex)
      .reduce((sum, line) => sum + (line?.getText?.().length || 0), 0);
    return Math.max(0, firstLength - range.startColumn) + middleLength +
      Math.max(0, range.endColumn) + (range.endRow - range.startRow);
  }

  unSelectAll({ emitEvent = true } = {}) {
    if (!this.editor.tabManager.activeFile) return;

    this.containsSelected = "";
    this.selectedLines.clear();
    this.editor.tabManager.activeFile._selectionRange = null;
    this.editor.tabManager.activeFile._selectionTextCache = null;
    this.startSelect = undefined;
    this.endSelect = undefined;

    if (this.editor.selectOutput) {
      const currentDOMNodes = this.editor.selectOutput.children;

      for (let i = 0; i < currentDOMNodes.length; i++) {
        this.setSelectionNodeDisplay(currentDOMNodes[i], "none");
      }
    }

    if (emitEvent) this.emitSelectionChange();
  }

  unSelectLine(index) {
    if (!this.editor.tabManager.activeFile || index === undefined) return;

    const range = this.editor.tabManager.activeFile._selectionRange;
    if (range && index + 1 >= range.start.row && index + 1 <= range.end.row) {
      this.editor.tabManager.activeFile._selectionRange = null;
      this.startSelect = undefined;
      this.endSelect = undefined;
    }

    this.selectedLines.delete(index);
    this.editor.tabManager.activeFile._selectionTextCache = null;

    this.refreshSelectionDOM();
  }

  selectLine(index, cursorChange) {
    if (!this.editor.tabManager.activeFile || index === undefined) return;
    this.editor.tabManager.activeFile._selectionRange = null;
    this.editor.tabManager.activeFile._selectionTextCache = null;
    this.editor.tabManager.activeFile.containsSelected = "";

    const line = this.editor.lineController;

    const lineNode = line.lines[index];

    if (!lineNode && line.lines.length === 1) return;

    const lineLengthReal = lineNode ? lineNode.getText().length : 0;

    const viewLen = this.editor.cursorController.getViewPosition(
      index + 1,
      lineLengthReal,
    ).column;

    let length = viewLen === 0 ? 1 : viewLen;

    this.selectedLines.set(index, {
      startCol: 1,
      length: length,
    });

    this.startSelect = {
      row: index + 1,
      column: 0,
    };

    this.endSelect = {
      row: index + 1,
      column: lineLengthReal,
    };

    if (cursorChange) {
      if (index !== this.editor.lineController.lines.length - 1) {
        this.editor.cursorController.setCursorPosition(index + 2, 0);
      } else {
        this.editor.cursorController.setCursorPosition(
          index + 1,
          lineLengthReal,
        );
      }
    }

    this.refreshSelectionDOM();

    this.emitSelectionChange();
  }

  selectAll(cursorChange) {
    if (!this.editor.tabManager.activeFile) return;

    this.selectedLines.clear();
    this.editor.tabManager.activeFile._selectionTextCache = null;

    const lc = this.editor.lineController;

    const lastLine = lc.lines.length - 1;

    const lastLineNode = lc.lines[lastLine];

    const lastLineLengthReal = lastLineNode ? lastLineNode.getText().length : 0;

    this.startSelect = {
      row: 1,
      column: 0,
    };

    this.endSelect = {
      row: lastLine + 1,
      column: lastLineLengthReal,
    };
    this.setLogicalSelectionFromEndpoints();
    this.editor.tabManager.activeFile.containsSelected = "";

    this.refreshSelectionDOM();

    if (cursorChange) {
      this.editor.cursorController.setCursorPosition(
        lastLine + 1,
        lastLineLengthReal,
      );
    }

    this.emitSelectionChange();
  }

  selectWord(cursorChange) {
    if (!this.editor.tabManager.activeFile) return;

    this.selectedLines.clear();
    this.editor.tabManager.activeFile._selectionRange = null;
    this.editor.tabManager.activeFile._selectionTextCache = null;
    this.editor.tabManager.activeFile.containsSelected = "";

    const rowIndex = this.editor.cursorController.row - 1;

    const colIndex = this.editor.cursorController.column;

    const lineNode = this.editor.lineController.lines[rowIndex];

    const lineText = lineNode ? lineNode.getText() : "";

    if (!lineText) return;

    const word = this.editor.writerController.getWordRangeAt(lineNode || lineText, colIndex);
    const startReal = word.start;
    const lengthReal = word.end - word.start;

    if (lengthReal > 0) {
      this.startSelect = {
        row: rowIndex + 1,
        column: startReal,
      };

      this.endSelect = {
        row: rowIndex + 1,
        column: startReal + lengthReal,
      };
      this.setLogicalSelectionFromEndpoints();

      if (cursorChange) {
        this.editor.cursorController.setCursorPosition(
          rowIndex + 1,
          startReal + lengthReal,
        );
      }

      this.refreshSelectionDOM();

      this.emitSelectionChange();
    }
  }

  calculSelectSimpleLine() {
    this.setLogicalSelectionFromEndpoints();
    this.refreshSelectionDOM();
  }

  calculSelectMultiLine() {
    if (!this.editor.tabManager.activeFile) return;
    this.setLogicalSelectionFromEndpoints();
    this.refreshSelectionDOM();
  }

  calcClick() {
    const currentTime = new Date().getTime();

    if (this.HstartSelect === undefined) {
      this.HstartSelect = this.startSelect;
    } else if (
      this.startSelect.column !== this.HstartSelect.column ||
      this.startSelect.row !== this.HstartSelect.row
    ) {
      this.HstartSelect = this.startSelect;

      this.lastClickTime = currentTime;

      this.clickCount = 1;

      return;
    }

    if (currentTime - this.lastClickTime < this.clickTime) {
      this.clickCount++;
    } else {
      this.clickCount = 1;
    }

    this.lastClickTime = currentTime;
  }

  mouseClick() {
    if (!this.editor.tabManager.activeFile) return;

    this.calcClick();

    if (this.clickCount > 1) {
      this.unSelectAll();
    }

    if (this.clickCount === 2) {
      this.selectWord(true);
    } else if (this.clickCount === 3) {
      this.selectLine(this.editor.cursorController.row - 1, true);
    } else if (this.clickCount >= 4) {
      this.selectAll(true);
    }
  }

  mouseDown(event) {
    if (!this.editor.tabManager.activeFile || event.button === 2) return;

    this.editor.keyBinding.historyX = undefined;

    // A new unshifted pointer gesture always ends the previous selection.
    // clickCount/HstartSelect remain independent so double/triple click keeps
    // working from the new cursor position.
    if (!event.shiftKey && this.hasActiveSelection()) this.unSelectAll();

    this.editor.cursorController.onClick(event);

    const c = this.editor.cursorController.column;

    const r = this.editor.cursorController.row;

    this.startSelect = { column: c, row: r };
    this.endSelect = { column: c, row: r };
    this.isMouseDown = true;

    this.mouseClick(event);

    if (!this.startSelect) {
      this.startSelect = { column: c, row: r };
      this.endSelect = { column: c, row: r };
    }
  }

  mouseUp() {
    if (!this.editor.tabManager.activeFile) return;

    this.isMouseDown = false;
    this.stopAutoScroll();

    this.endSelect = {
      column: this.editor.cursorController.column,

      row: this.editor.cursorController.row,
    };
  }

  mouseMove(event) {
    if (!this.editor.tabManager.activeFile) return;

    if (this.isMouseDown) {
      this.dragClientPosition = { x: event.clientX, y: event.clientY };
      this.clickCount = 0;

      this.updateDragPosition();

      this.updateAutoScroll();

    }
  }

  updateDragPosition() {
    if (!this.dragClientPosition || !this.editor.tabManager.activeFile) return;
    this.editor.cursorController.onClick(
      { clientX: this.dragClientPosition.x, clientY: this.dragClientPosition.y },
      { clampToViewport: true, ensureVisible: false },
    );

    this.move();
  }

  getOutsideDistances() {
    if (!this.dragClientPosition) return null;
    const rect = this.editor.domManager.getOutputRect();
    const right = Number.isFinite(rect.right) ? rect.right : rect.left + rect.width;
    const bottom = Number.isFinite(rect.bottom) ? rect.bottom : rect.top + rect.height;
    return {
      x: this.dragClientPosition.x < rect.left
        ? this.dragClientPosition.x - rect.left
        : this.dragClientPosition.x > right ? this.dragClientPosition.x - right : 0,
      y: this.dragClientPosition.y < rect.top
        ? this.dragClientPosition.y - rect.top
        : this.dragClientPosition.y > bottom ? this.dragClientPosition.y - bottom : 0,
    };
  }

  getAutoScrollStep(distance, unit) {
    if (distance === 0) return 0;
    return Math.sign(distance) * Math.min(3, Math.max(1, Math.ceil(Math.abs(distance) / unit)));
  }

  updateAutoScroll() {
    const outside = this.getOutsideDistances();
    if (!this.isMouseDown || !outside || (outside.x === 0 && outside.y === 0)) {
      this.stopAutoScroll();
      return;
    }
    if (this.selectionAutoScrollFrame === null) {
      this.selectionAutoScrollFrame = requestAnimationFrame(() => this.autoScroll());
    }
  }

  autoScroll() {
    this.selectionAutoScrollFrame = null;
    if (!this.isMouseDown || !this.editor.tabManager.activeFile) return;
    const outside = this.getOutsideDistances();
    if (!outside || (outside.x === 0 && outside.y === 0)) return;
    const lc = this.editor.lineController;
    const vertical = this.getAutoScrollStep(outside.y, this.editor.posY || 23);
    const horizontal = this.getAutoScrollStep(
      outside.x,
      Math.max(1, this.editor.letterSize * 4),
    );
    if (vertical) lc.scrollTo(lc.startIndex + vertical);
    if (horizontal) lc.outputScroller.setHorizontalOffset(lc.offsetX + horizontal);
    this.updateDragPosition();
    this.updateAutoScroll();
  }

  stopAutoScroll() {
    if (this.selectionAutoScrollFrame !== null) {
      cancelAnimationFrame(this.selectionAutoScrollFrame);
      this.selectionAutoScrollFrame = null;
    }
    this.dragClientPosition = null;
  }

  cancelMouseGesture() {
    if (!this.isMouseDown) return;
    this.mouseUp();
  }

  move() {
    if (!this.editor.tabManager.activeFile) return;

    let c = this.editor.cursorController.column;

    let r = this.editor.cursorController.row;

    if (!this.startSelect) {
      this.startSelect = this.endSelect || { column: c, row: r };
    }

    if (
      this.endSelect &&
      this.endSelect.column === c &&
      this.endSelect.row === r
    ) {
      return;
    }

    this.endSelect = { column: c, row: r };

    if (this.startSelect.row === this.endSelect.row)
      this.calculSelectSimpleLine();
    else this.calculSelectMultiLine();

    this.emitSelectionChange();
  }

  getSelectOBJ() {
    if (!this.editor.selectOutput) return [];

    return Array.from(this.editor.selectOutput.children).filter(
      (el) =>
        el.classList &&
        el.classList.contains("selected") &&
        el.style.display !== "none",
    );
  }

  initEventListeners() {
    addEvent("mousedown", this.mouseDown.bind(this), [
      this.editor.output,
      this.editor.cD,
    ]);

    addEvent("mouseup", this.mouseUp.bind(this), document);

    addEvent("mousemove", this.mouseMove.bind(this), document);
    if (typeof window !== "undefined")
      addEvent("blur", this.cancelMouseGesture.bind(this), window);
  }
}
