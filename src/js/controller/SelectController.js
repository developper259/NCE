class SelectController {
  constructor(e) {
    this.editor = e;
    this.clickTime = 500;
    this.initEventListeners();
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
    return this.editor.tabManager.activeFile.containsSelected;
  }

  set containsSelected(value) {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.tabManager.activeFile.containsSelected = value;
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

  getLogicalSelection() {
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

  setSelection(start, end) {
    if (!this.editor.tabManager.activeFile || !start || !end) return;

    const cursor = this.editor.cursorController;
    const normalizedStart = cursor.normalizePosition(start.row, start.column);
    const normalizedEnd = cursor.normalizePosition(end.row, end.column);

    this.startSelect = normalizedStart;
    this.endSelect = normalizedEnd;
    cursor.setCursorPosition(normalizedEnd.row, normalizedEnd.column);

    if (normalizedStart.row === normalizedEnd.row) {
      this.calculSelectSimpleLine();
    } else {
      this.calculSelectMultiLine();
    }

    this.editor.events.callEvent(Events.ON_SELECT, {
      start: this.startSelect,
      end: this.endSelect,
      contains: this.containsSelected,
    });
  }

  refreshSelectionDOM() {
    if (!this.editor.tabManager.activeFile || !this.editor.selectOutput) return;

    const cursor = this.editor.cursorController;
    const difY = 4;
    const radius = "4px";

    this.refreshContaisSelected();

    const visibleSelections = [];

    this.selectedLines.forEach((info, row) => {
      const fileRow = row + 1;

      if (cursor.isRowVisible(fileRow)) {
        visibleSelections.push({
          row,
          info,
        });
      }
    });

    const currentDOMNodes = this.editor.selectOutput.children;

    const totalLoopLength = Math.max(
      visibleSelections.length,
      currentDOMNodes.length,
    );

    for (let i = 0; i < totalLoopLength; i++) {
      if (i < visibleSelections.length) {
        const { row, info } = visibleSelections[i];
        const fileRow = row + 1;

        const x = cursor.columnToX(info.startCol);
        const width = info.length * this.editor.letterSize;

        const y = cursor.rowToY(fileRow) - difY;
        const height = cursor.mpY + difY;

        let div = currentDOMNodes[i];

        if (!div) {
          div = document.createElement("div");
          div.style.position = "absolute";

          this.editor.selectOutput.appendChild(div);
        }

        div.className = "selected";
        div.dataset.line = row;

        div.style.display = "";
        div.style.left = `${x}px`;
        div.style.top = `${y}px`;
        div.style.width = `${width}px`;
        div.style.height = `${height}px`;

        const currentLeft = info.startCol;
        const currentRight = info.startCol + info.length;

        const previousInfo = this.selectedLines.get(row - 1);

        const nextInfo = this.selectedLines.get(row + 1);

        div.style.borderTopLeftRadius = "0";
        div.style.borderTopRightRadius = "0";
        div.style.borderBottomLeftRadius = "0";
        div.style.borderBottomRightRadius = "0";

        let topLeftConnected = false;
        let topRightConnected = false;

        if (previousInfo) {
          const previousLeft = previousInfo.startCol;
          const previousRight = previousInfo.startCol + previousInfo.length;

          topLeftConnected =
            previousLeft <= currentLeft && previousRight > currentLeft;

          topRightConnected =
            previousLeft < currentRight && previousRight >= currentRight;
        }

        if (!topLeftConnected) {
          div.style.borderTopLeftRadius = radius;
        }

        if (!topRightConnected) {
          div.style.borderTopRightRadius = radius;
        }

        let bottomLeftConnected = false;
        let bottomRightConnected = false;

        if (nextInfo) {
          const nextLeft = nextInfo.startCol;
          const nextRight = nextInfo.startCol + nextInfo.length;

          bottomLeftConnected =
            nextLeft <= currentLeft && nextRight > currentLeft;

          bottomRightConnected =
            nextLeft < currentRight && nextRight >= currentRight;
        }

        if (!bottomLeftConnected) {
          div.style.borderBottomLeftRadius = radius;
        }

        if (!bottomRightConnected) {
          div.style.borderBottomRightRadius = radius;
        }
      } else {
        if (currentDOMNodes[i]) {
          currentDOMNodes[i].style.display = "none";
        }
      }
    }
  }

  refreshSelectPositions() {
    this.refreshSelectionDOM();
  }

  refreshContaisSelected() {
    if (!this.editor.tabManager.activeFile) return;

    this.containsSelected = "";

    if (this.selectedLines.size === 0) return;

    const parts = [];

    const sortedRows = Array.from(this.selectedLines.keys()).sort(
      (a, b) => a - b,
    );

    const cursor = this.editor.cursorController;

    for (const row of sortedRows) {
      const info = this.selectedLines.get(row);

      const lineNode = this.editor.lineController.lines[row];

      const rawLine = lineNode ? lineNode.getText() : "";

      const realStart = cursor.getPosition(row + 1, info.startCol - 1).column;

      const realEnd = cursor.getPosition(
        row + 1,
        info.startCol - 1 + info.length,
      ).column;

      parts.push(rawLine.slice(realStart, realEnd));
    }

    this.containsSelected = parts.join("\n");
  }

  getTextSelectedLine(index) {
    if (index === undefined) return undefined;

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
    return this.selectedLines.size;
  }

  hasActiveSelection() {
    return this.selectedLines.size > 0;
  }

  unSelectAll() {
    if (!this.editor.tabManager.activeFile) return;

    this.containsSelected = "";
    this.selectedLines.clear();

    if (this.editor.selectOutput) {
      const currentDOMNodes = this.editor.selectOutput.children;

      for (let i = 0; i < currentDOMNodes.length; i++) {
        currentDOMNodes[i].style.display = "none";
      }
    }

    this.editor.events.callEvent(Events.ON_SELECT, {
      start: undefined,
      end: undefined,
      contains: "",
    });
  }

  unSelectLine(index) {
    if (!this.editor.tabManager.activeFile || index === undefined) return;

    this.selectedLines.delete(index);

    this.refreshSelectionDOM();
  }

  selectLine(index, cursorChange) {
    if (!this.editor.tabManager.activeFile || index === undefined) return;

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

    this.editor.events.callEvent(Events.ON_SELECT, {
      start: this.startSelect,
      end: this.endSelect,
      contains: this.containsSelected,
    });
  }

  selectAll(cursorChange) {
    if (!this.editor.tabManager.activeFile) return;

    this.selectedLines.clear();

    const lc = this.editor.lineController;

    for (let i = 0; i < lc.lines.length; i++) {
      const lineNode = lc.lines[i];

      const realLen = lineNode ? lineNode.getText().length : 0;

      const viewLen = this.editor.cursorController.getViewPosition(
        i + 1,
        realLen,
      ).column;

      let length = viewLen === 0 ? 1 : viewLen;

      this.selectedLines.set(i, {
        startCol: 1,
        length: length,
      });
    }

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

    this.refreshSelectionDOM();

    if (cursorChange) {
      this.editor.cursorController.setCursorPosition(
        lastLine + 1,
        lastLineLengthReal,
      );
    }

    this.editor.events.callEvent(Events.ON_SELECT, {
      start: this.startSelect,
      end: this.endSelect,
      contains: this.containsSelected,
    });
  }

  selectWord(cursorChange) {
    if (!this.editor.tabManager.activeFile) return;

    this.selectedLines.clear();

    const rowIndex = this.editor.cursorController.row - 1;

    const colIndex = this.editor.cursorController.column;

    const lineNode = this.editor.lineController.lines[rowIndex];

    const lineText = lineNode ? lineNode.getText() : "";

    if (!lineText) return;

    const words = this.editor.writerController.splitWord(lineText);

    if (!words || words.length === 0) return;

    let startReal = 0;
    let currentLength = 0;

    let targetWordIndex = words.length - 1;

    for (let i = 0; i < words.length; i++) {
      const wordLen = words[i].length;

      currentLength += wordLen;

      if (colIndex < currentLength) {
        targetWordIndex = i;
        break;
      }

      startReal += wordLen;
    }

    const lengthReal = words[targetWordIndex].length;

    const viewStart = this.editor.cursorController.getViewPosition(
      rowIndex + 1,
      startReal,
    ).column;

    const viewEnd = this.editor.cursorController.getViewPosition(
      rowIndex + 1,
      startReal + lengthReal,
    ).column;

    const lengthVisual = viewEnd - viewStart;

    if (lengthReal > 0) {
      this.selectedLines.set(rowIndex, {
        startCol: viewStart + 1,
        length: lengthVisual,
      });

      this.startSelect = {
        row: rowIndex + 1,
        column: startReal,
      };

      this.endSelect = {
        row: rowIndex + 1,
        column: startReal + lengthReal,
      };

      if (cursorChange) {
        this.editor.cursorController.setCursorPosition(
          rowIndex + 1,
          startReal + lengthReal,
        );
      }

      this.refreshSelectionDOM();

      this.editor.events.callEvent(Events.ON_SELECT, {
        start: this.startSelect,
        end: this.endSelect,
        contains: this.containsSelected,
      });
    }
  }

  calculSelectSimpleLine() {
    this.selectedLines.clear();

    const y = this.startSelect.row - 1;

    if (this.startSelect.column === this.endSelect.column) {
      this.refreshSelectionDOM();
      return;
    }

    const startReal = Math.min(this.startSelect.column, this.endSelect.column);

    const endReal = Math.max(this.startSelect.column, this.endSelect.column);

    const viewStart = this.editor.cursorController.getViewPosition(
      y + 1,
      startReal,
    ).column;

    const viewEnd = this.editor.cursorController.getViewPosition(
      y + 1,
      endReal,
    ).column;

    this.selectedLines.set(y, {
      startCol: viewStart + 1,
      length: viewEnd - viewStart,
    });

    this.refreshSelectionDOM();
  }

  calculSelectMultiLine() {
    if (!this.editor.tabManager.activeFile) return;

    this.selectedLines.clear();

    const lc = this.editor.lineController;

    const startIsTop = this.startSelect.row <= this.endSelect.row;

    const topRow = startIsTop ? this.startSelect.row : this.endSelect.row;

    const bottomRow = startIsTop ? this.endSelect.row : this.startSelect.row;

    const topRealCol = startIsTop
      ? this.startSelect.column
      : this.endSelect.column;

    const bottomRealCol = startIsTop
      ? this.endSelect.column
      : this.startSelect.column;

    const yStart = topRow - 1;
    const yEnd = bottomRow - 1;

    const topRealLen = lc.lines[yStart] ? lc.lines[yStart].getText().length : 0;

    const topVisualStart = this.editor.cursorController.getViewPosition(
      topRow,
      topRealCol,
    ).column;

    const topVisualEnd = this.editor.cursorController.getViewPosition(
      topRow,
      topRealLen,
    ).column;

    const startLineLen = Math.max(0, topVisualEnd - topVisualStart);

    this.selectedLines.set(yStart, {
      startCol: topVisualStart + 1,
      length: startLineLen,
    });

    for (let i = yStart + 1; i < yEnd; i++) {
      const realLen = lc.lines[i] ? lc.lines[i].getText().length : 0;

      const lineLenVis = this.editor.cursorController.getViewPosition(
        i + 1,
        realLen,
      ).column;

      this.selectedLines.set(i, {
        startCol: 1,
        length: lineLenVis === 0 ? 1 : lineLenVis,
      });
    }

    const bottomVisualLen = this.editor.cursorController.getViewPosition(
      bottomRow,
      bottomRealCol,
    ).column;

    this.selectedLines.set(yEnd, {
      startCol: 1,

      length: Math.max(0, bottomVisualLen),
    });

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

    if (new Date().getTime() - this.lastClickTime > this.clickTime) {
      if (this.containsSelected.length > 0) {
        this.unSelectAll();
      }
    }

    this.editor.cursorController.onClick(event);

    const c = this.editor.cursorController.column;

    const r = this.editor.cursorController.row;

    this.startSelect = { column: c, row: r };
    this.endSelect = { column: c, row: r };
    this.isMouseDown = true;

    this.mouseClick(event);
  }

  mouseUp() {
    if (!this.editor.tabManager.activeFile) return;

    this.isMouseDown = false;

    this.endSelect = {
      column: this.editor.cursorController.column,

      row: this.editor.cursorController.row,
    };
  }

  mouseMove(event) {
    if (!this.editor.tabManager.activeFile) return;

    if (this.isMouseDown) {
      this.clickCount = 0;

      this.editor.cursorController.onClick(event);

      this.move();
    }
  }

  move() {
    if (!this.editor.tabManager.activeFile) return;

    let c = this.editor.cursorController.column;

    let r = this.editor.cursorController.row;

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

    this.editor.events.callEvent(Events.ON_SELECT, {
      start: this.startSelect,
      end: this.endSelect,
      contains: this.containsSelected,
    });
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

    addEvent("mousemove", this.mouseMove.bind(this), this.editor.output);
  }
}
