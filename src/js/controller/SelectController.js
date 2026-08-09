class SelectController {
  constructor(e) {
    this.editor = e;
    this.clickTime = 500;
    this.selectOutput = getElement(".editor-select-output");
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

    const realStart = this.editor.cursor.getPosition(
      firstRow + 1,
      startInfo.startCol - 1,
    ).column;
    const realEnd = this.editor.cursor.getPosition(
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

  refreshSelectionDOM() {
    if (!this.editor.tabManager.activeFile || !this.selectOutput) return;

    const cursor = this.editor.cursor;
    const difY = 4;

    this.refreshContaisSelected();

    const visibleSelections = [];
    this.selectedLines.forEach((info, row) => {
      const fileRow = row + 1;
      if (cursor.isRowVisible(fileRow)) {
        visibleSelections.push({ row, info });
      }
    });

    const currentDOMNodes = this.selectOutput.children;
    const totalLoopLength = Math.max(
      visibleSelections.length,
      currentDOMNodes.length,
    );
    const classNameTarget = !this.editor.selected
      ? "selected selected-afk"
      : "selected";

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
          this.selectOutput.appendChild(div);
        }

        div.className = classNameTarget;
        div.dataset.line = row;

        div.style.display = "";
        div.style.left = `${x}px`;
        div.style.top = `${y}px`;
        div.style.width = `${width}px`;
        div.style.height = `${height}px`;
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
    const cursor = this.editor.cursor;

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

    const realStart = this.editor.cursor.getPosition(
      index + 1,
      info.startCol - 1,
    ).column;
    const realEnd = this.editor.cursor.getPosition(
      index + 1,
      info.startCol - 1 + info.length,
    ).column;

    return rawLine.slice(realStart, realEnd);
  }

  getNumberLineSelected() {
    return this.selectedLines.size;
  }

  unSelectAll() {
    if (!this.editor.tabManager.activeFile) return;
    this.containsSelected = "";
    this.selectedLines.clear();

    if (this.selectOutput) {
      const currentDOMNodes = this.selectOutput.children;
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
    const viewLen = this.editor.cursor.getViewPosition(
      index + 1,
      lineLengthReal,
    ).column;
    let length = viewLen === 0 ? 1 : viewLen;

    this.selectedLines.set(index, { startCol: 1, length: length });

    this.startSelect = { row: index + 1, column: 0 };
    this.endSelect = { row: index + 1, column: lineLengthReal };

    if (cursorChange) {
      if (index !== this.editor.lineController.lines.length - 1)
        this.editor.cursor.setCursorPosition(index + 2, 0);
      else this.editor.cursor.setCursorPosition(index + 1, lineLengthReal);
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
      const viewLen = this.editor.cursor.getViewPosition(i + 1, realLen).column;
      let length = viewLen === 0 ? 1 : viewLen;

      this.selectedLines.set(i, { startCol: 1, length: length });
    }

    const lastLine = lc.lines.length - 1;
    const lastLineNode = lc.lines[lastLine];
    const lastLineLengthReal = lastLineNode ? lastLineNode.getText().length : 0;

    this.startSelect = { row: 1, column: 0 };
    this.endSelect = { row: lastLine + 1, column: lastLineLengthReal };

    this.refreshSelectionDOM();

    if (cursorChange) {
      this.editor.cursor.setCursorPosition(lastLine + 1, lastLineLengthReal);
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

    const rowIndex = this.editor.cursor.row - 1;
    const colIndex = this.editor.cursor.column;

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

    const viewStart = this.editor.cursor.getViewPosition(
      rowIndex + 1,
      startReal,
    ).column;
    const viewEnd = this.editor.cursor.getViewPosition(
      rowIndex + 1,
      startReal + lengthReal,
    ).column;
    const lengthVisual = viewEnd - viewStart;

    if (lengthReal > 0) {
      this.selectedLines.set(rowIndex, {
        startCol: viewStart + 1,
        length: lengthVisual,
      });

      this.startSelect = { row: rowIndex + 1, column: startReal };
      this.endSelect = { row: rowIndex + 1, column: startReal + lengthReal };

      if (cursorChange) {
        this.editor.cursor.setCursorPosition(
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

    const viewStart = this.editor.cursor.getViewPosition(
      y + 1,
      startReal,
    ).column;
    const viewEnd = this.editor.cursor.getViewPosition(y + 1, endReal).column;

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
    const topVisualStart = this.editor.cursor.getViewPosition(
      topRow,
      topRealCol,
    ).column;
    const topVisualEnd = this.editor.cursor.getViewPosition(
      topRow,
      topRealLen,
    ).column;
    const startLineLen = topVisualEnd - topVisualStart;

    if (startLineLen > 0) {
      this.selectedLines.set(yStart, {
        startCol: topVisualStart + 1,
        length: startLineLen,
      });
    }

    for (let i = yStart + 1; i < yEnd; i++) {
      const realLen = lc.lines[i] ? lc.lines[i].getText().length : 0;
      const lineLenVis = this.editor.cursor.getViewPosition(
        i + 1,
        realLen,
      ).column;
      this.selectedLines.set(i, {
        startCol: 1,
        length: lineLenVis === 0 ? 1 : lineLenVis,
      });
    }

    const bottomVisualLen = this.editor.cursor.getViewPosition(
      bottomRow,
      bottomRealCol,
    ).column;
    if (bottomVisualLen >= 0) {
      this.selectedLines.set(yEnd, {
        startCol: 1,
        length: bottomVisualLen,
      });
    }

    this.refreshSelectionDOM();
  }

  calcClick() {
    const currentTime = new Date().getTime();
    if (this.HstartSelect === undefined) this.HstartSelect = this.startSelect;
    else if (
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
      this.selectLine(this.editor.cursor.row - 1, true);
    } else if (this.clickCount >= 4) {
      this.selectAll(true);
    }
  }

  mouseDown(event) {
    if (!this.editor.tabManager.activeFile || event.button === 2) return;

    this.editor.keyBinding.historyX = undefined;

    if (new Date().getTime() - this.lastClickTime > this.clickTime) {
      if (this.containsSelected.length > 0 && this.editor.selected)
        this.unSelectAll();
    }

    this.editor.cursor.onClick(event);
    const c = this.editor.cursor.column;
    const r = this.editor.cursor.row;

    this.startSelect = { column: c, row: r };
    this.endSelect = { column: c, row: r };
    this.isMouseDown = true;

    this.mouseClick(event);
  }

  mouseUp() {
    if (!this.editor.tabManager.activeFile) return;
    this.isMouseDown = false;
    this.endSelect = {
      column: this.editor.cursor.column,
      row: this.editor.cursor.row,
    };
  }

  mouseMove(event) {
    if (!this.editor.tabManager.activeFile) return;
    if (this.isMouseDown) {
      this.clickCount = 0;
      this.editor.cursor.onClick(event);
      this.move();
    }
  }

  move() {
    if (!this.editor.tabManager.activeFile) return;
    let c = this.editor.cursor.column;
    let r = this.editor.cursor.row;

    if (
      this.endSelect &&
      this.endSelect.column === c &&
      this.endSelect.row === r
    )
      return;

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
    if (!this.selectOutput) return [];
    return Array.from(this.selectOutput.children).filter(
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
