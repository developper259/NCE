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
    const totalLoopLength = Math.max(visibleSelections.length, currentDOMNodes.length);
    const classNameTarget = !this.editor.selected ? "selected selected-afk" : "selected";

    for (let i = 0; i < totalLoopLength; i++) {
      if (i < visibleSelections.length) {
        const { row, info } = visibleSelections[i];
        const fileRow = row + 1;

        const x = cursor.columnToX(info.startCol);
        const y = cursor.rowToY(fileRow) - difY;
        const width = info.length * this.editor.letterSize;
        const height = cursor.mpY + difY;

        const rawLine = this.editor.lineController.lines[row] || "";
        const vec1 = cursor.getReelPosition(fileRow, info.startCol - 1);
        const vec2 = cursor.getReelPosition(fileRow, info.startCol - 1 + info.length);
        const value = rawLine.slice(vec1.column, vec2.column);

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
    const sortedRows = Array.from(this.selectedLines.keys()).sort((a, b) => a - b);
    const cursor = this.editor.cursor;

    for (const row of sortedRows) {
      const info = this.selectedLines.get(row);
      const rawLine = this.editor.lineController.lines[row] || "";
      const vec1 = cursor.getReelPosition(row + 1, info.startCol - 1);
      const vec2 = cursor.getReelPosition(row + 1, info.startCol - 1 + info.length);
      parts.push(rawLine.slice(vec1.column, vec2.column));
    }

    this.containsSelected = parts.join("\n");
  }

  getTextSelectedLine(index) {
    if (index === undefined) return undefined;
    const info = this.selectedLines.get(index);
    if (!info) return undefined;

    const rawLine = this.editor.lineController.lines[index] || "";
    const vec1 = this.editor.cursor.getReelPosition(index + 1, info.startCol - 1);
    const vec2 = this.editor.cursor.getReelPosition(index + 1, info.startCol - 1 + info.length);
    return rawLine.slice(vec1.column, vec2.column);
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
    if (!line.lines[index] && line.lines.length === 1) return;
    
    let length = this.editor.cursor.getPosition(index + 1, line.lines[index].length).column;
    if (length === 0) length = 1;

    this.selectedLines.set(index, { startCol: 1, length: length });

    let x = 0;
    if (index === line.lines.length - 1) x = length;
    if (cursorChange) {
      if (index !== this.editor.lineController.lines.length - 1)
        this.editor.cursor.setCursorPosition(index + 2, x);
      else this.editor.cursor.setCursorPosition(index + 1, length);
    }

    this.refreshSelectionDOM();

    this.editor.events.callEvent(Events.ON_SELECT, {
      start: this.startSelect,
      end: this.endSelect,
      contains: this.containsSelected,
    });
  }

  selectAll() {
    if (!this.editor.tabManager.activeFile) return;
    this.selectedLines.clear();

    const lc = this.editor.lineController;
    for (let i = 0; i < lc.lines.length; i++) {
      let length = this.editor.cursor.getPosition(i + 1, lc.lines[i].length).column;
      if (length === 0) length = 1;
      this.selectedLines.set(i, { startCol: 1, length: length });
    }

    this.refreshSelectionDOM();

    this.editor.events.callEvent(Events.ON_SELECT, {
      start: this.startSelect,
      end: this.endSelect,
      contains: this.containsSelected,
    });
  }

  selectWord(wordOBJ, cursorChange) {
    if (!this.editor.tabManager.activeFile || wordOBJ === undefined) return;
    this.selectedLines.clear();

    const rect = wordOBJ.getBoundingClientRect();
    const editorRect = this.editor.output.getBoundingClientRect();

    const x = this.editor.cursor.xToColumn(rect.left - editorRect.left);
    const y = this.editor.cursor.yToRow(rect.top - editorRect.top) - 1;

    this.selectedLines.set(y, { startCol: x, length: wordOBJ.innerText.length });
    
    const pos = this.editor.cursor.getReelPosition(y, x + wordOBJ.innerText.length - 1);
    if (cursorChange) this.editor.cursor.setCursorPosition(y + 1, pos.column);

    this.refreshSelectionDOM();

    this.editor.events.callEvent(Events.ON_SELECT, {
      start: this.startSelect,
      end: this.endSelect,
      contains: this.containsSelected,
    });
  }

  calculSelectSimpleLine() {
    this.selectedLines.clear();
    const y = this.startSelect.row - 1;

    if (this.startSelect.column === this.endSelect.column) {
      this.refreshSelectionDOM();
      return;
    }

    const startCol = Math.min(this.startSelect.column, this.endSelect.column);
    const endCol = Math.max(this.startSelect.column, this.endSelect.column);
    const length = endCol - startCol;

    this.selectedLines.set(y, { startCol: startCol + 1, length: length });
    this.refreshSelectionDOM();
  }

  calculSelectMultiLine() {
    if (!this.editor.tabManager.activeFile) return;
    this.selectedLines.clear();

    const lc = this.editor.lineController;
    const startIsTop = this.startSelect.row <= this.endSelect.row;
    const topRow = startIsTop ? this.startSelect.row : this.endSelect.row;
    const bottomRow = startIsTop ? this.endSelect.row : this.startSelect.row;
    const topColView = startIsTop ? this.startSelect.column : this.endSelect.column;
    const bottomColView = startIsTop ? this.endSelect.column : this.startSelect.column;

    const yStart = topRow - 1;
    const yEnd = bottomRow - 1;

    const lineStart = lc.lines[yStart] ?? "";
    const startViewLen = Math.max(0, (lc.getViewLineLength ? lc.getViewLineLength(yStart) : lineStart.length) - topColView);
    if (startViewLen > 0) {
      this.selectedLines.set(yStart, { startCol: topColView + 1, length: startViewLen });
    }

    for (let i = yStart + 1; i < yEnd; i++) {
      const lineLen = (lc.lines[i] ?? "").length;
      const viewLen = lc.getViewLineLength ? lc.getViewLineLength(i) : lineLen;
      this.selectedLines.set(i, { startCol: 1, length: viewLen === 0 ? 1 : viewLen });
    }

    const endViewLen = Math.max(0, bottomColView);
    if (endViewLen > 0) {
      this.selectedLines.set(yEnd, { startCol: 1, length: endViewLen });
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
      const word = this.editor.lineController.getWordOBJ(
        this.editor.cursor.row,
        this.editor.cursor.getIndexWord()
      );
      if (!word) return;
      this.selectWord(word, true);
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
      if (this.containsSelected.length > 0 && this.editor.selected) this.unSelectAll();
    }

    this.editor.cursor.onClick(event);
    const pos = this.editor.cursor.getCursorReelPosition();
    if (!pos) return;

    this.startSelect = { column: pos.column, row: pos.row };
    this.endSelect = {};
    this.isMouseDown = true;

    this.mouseClick(event);
  }

  mouseUp() {
    if (!this.editor.tabManager.activeFile) return;
    this.isMouseDown = false;
    const pos = this.editor.cursor.getCursorReelPosition();
    if (!pos) return;

    this.endSelect = { column: pos.column, row: pos.row };
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
    const pos = this.editor.cursor.getCursorReelPosition();
    let c = pos.column;
    let r = pos.row;

    if (this.endSelect && this.endSelect.column === c && this.endSelect.row === r)
      return;

    this.endSelect = { column: c, row: r };
    
    if (this.startSelect.row === this.endSelect.row)
      this.calculSelectSimpleLine();
    else 
      this.calculSelectMultiLine();

    this.editor.events.callEvent(Events.ON_SELECT, {
      start: this.startSelect,
      end: this.endSelect,
      contains: this.containsSelected,
    });
  }

  getSelectOBJ() {
    if (!this.selectOutput) return [];
    return Array.from(this.selectOutput.children).filter(el => 
      el.classList && el.classList.contains("selected") && el.style.display !== "none"
    );
  }

  initEventListeners() {
    addEvent("mousedown", this.mouseDown.bind(this), this.editor.output);
    addEvent("mouseup", this.mouseUp.bind(this), document);
    addEvent("mousemove", this.mouseMove.bind(this), this.editor.output);
  }
}