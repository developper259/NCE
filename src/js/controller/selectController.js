class SelectController {
  constructor(e) {
    this.editor = e;
    this.clickTime = 500;
    this.selectOutput = getElement(".editor-select-output");
    this.initEventListeners();
  }

  get isMouseDown() {
    if (!this.editor.fileManager.activeFile) return;
    return this.editor.fileManager.activeFile.isMouseDown;
  }

  set isMouseDown(value) {
    if (!this.editor.fileManager.activeFile) return;
    this.editor.fileManager.activeFile.isMouseDown = value;
  }

  get containsSelected() {
    if (!this.editor.fileManager.activeFile) return;
    return this.editor.fileManager.activeFile.containsSelected;
  }

  set containsSelected(value) {
    if (!this.editor.fileManager.activeFile) return;
    this.editor.fileManager.activeFile.containsSelected = value;
  }

  get lastClick() {
    if (!this.editor.fileManager.activeFile) return;
    return this.editor.fileManager.activeFile.lastClick;
  }

  set lastClick(value) {
    if (!this.editor.fileManager.activeFile) return;
    this.editor.fileManager.activeFile.lastClick = value;
  }

  get clickCount() {
    if (!this.editor.fileManager.activeFile) return;
    return this.editor.fileManager.activeFile.clickCount;
  }

  set clickCount(value) {
    if (!this.editor.fileManager.activeFile) return;
    this.editor.fileManager.activeFile.clickCount = value;
  }

  get HstartSelect() {
    if (!this.editor.fileManager.activeFile) return;
    return this.editor.fileManager.activeFile.HstartSelect;
  }

  set HstartSelect(value) {
    if (!this.editor.fileManager.activeFile) return;
    this.editor.fileManager.activeFile.HstartSelect = value;
  }

  get startSelect() {
    if (!this.editor.fileManager.activeFile) return;
    return this.editor.fileManager.activeFile.startSelect;
  }

  set startSelect(value) {
    if (!this.editor.fileManager.activeFile) return;
    this.editor.fileManager.activeFile.startSelect = value;
  }

  get endSelect() {
    if (!this.editor.fileManager.activeFile) return;
    return this.editor.fileManager.activeFile.endSelect;
  }

  set endSelect(value) {
    if (!this.editor.fileManager.activeFile) return;
    this.editor.fileManager.activeFile.endSelect = value;
  }

  getTextSelectedLine(index) {
    if (index == undefined) return;
    let lineOBJ = this.getSelectOBJLine(index);

    if (lineOBJ == undefined) return undefined;

    return lineOBJ.dataset.value;
  }

  refreshContaisSelected() {
    if (!this.editor.fileManager.activeFile) return;

    this.containsSelected = "";
    let count = this.getNumberLineSelected();
    if (!count) return;

    const els = this.getSelectOBJ();
    if (!els || !els.length) return;

    const parts = [];
    for (let i = 0; i < els.length; i++) {
      const v = els[i].dataset?.value;
      if (v !== undefined) parts.push(v);
    }
    this.containsSelected = parts.join("\n");
  }

  refreshStartEndSelect() {
    /*let els = [];

		for (let i = 0; i < this.editor.lineController.maxIndex; i++) {
			let el = this.getSelectOBJLine(i);
			if (el) els.push(el);
		}

		let i = 0;
		let lastEl;
		let lastElW;
		let lastElX;

		let nextEl;
		let nextElW;
		let nextElX;

		for (let el of els) {
			el.removeAttribute("class");
			let classes = el.classList;
			classes.add("selected");

			// 1 element selected
			if (els.length == 1) classes.add("selected-all");
			// more element selected
			else {
				if (i != 0) {
					lastElW = parseInt(window.getComputedStyle(lastEl).width);
					lastElX = parseInt(window.getComputedStyle(lastEl).left, 10);
				}
				let elW = parseInt(window.getComputedStyle(el).width);
				let elX = parseInt(window.getComputedStyle(el).left, 10);
				if (i != els.length - 1) {
					nextEl = els[i + 1];
					nextElW = parseInt(window.getComputedStyle(nextEl).width);
					nextElX = parseInt(window.getComputedStyle(nextEl).left, 10);
				}

				if (i == 0) {
					classes.add("selected-start");
				} else {
					if (lastElX > elX) {
						classes.add("selected-top-left");
					}

					if (elX + elW > lastElW + lastElX) {
						classes.add("selected-top-right");
					}

					if (elX + elW > nextElW + nextElX) {
						classes.add("selected-bottom-right");
					}

					if (i == els.length - 1) {
						classes.add("selected-bottom");
					}
				}
			}
			lastEl = el;
			i++;
		}*/
    this.refreshContaisSelected();
  }

  refreshSelectLine(row, length) {
    if (!this.editor.fileManager.activeFile) return;
    if (row == undefined || length == undefined) return;
    let obj = this.getSelectOBJLine(row);
    if (!obj) return;

    let width = length * this.editor.letterSize;
    obj.style.width = width + "px ";
    let column =
      this.editor.cursor.xToColumn(
        parseInt(window.getComputedStyle(obj).left, 10) - this.editor.baseX
      ) - 1;

    const vec1 = this.editor.cursor.getPositionReverse(row + 1, column);
    const vec2 = this.editor.cursor.getPositionReverse(
      row + 1,
      column + length
    );
    obj.dataset.value = this.editor.lineController.lines[row].slice(
      vec1.column,
      vec2.column
    );
  }

  refreshSelectLineReverse(row, length) {
    if (!this.editor.fileManager.activeFile) return;
    if (row == undefined || length == undefined) return;
    let obj = this.getSelectOBJLine(row);
    if (!obj) return;

    let width = length * this.editor.letterSize;
    let lengthInit =
      parseInt(window.getComputedStyle(obj).width, 10) / this.editor.letterSize;
    let column =
      this.editor.cursor.xToColumn(
        parseInt(window.getComputedStyle(obj).left, 10) - this.editor.baseX
      ) -
      (length - lengthInit);
    let x = this.editor.cursor.columnToX(column);

    obj.style.left = x + "px";
    obj.style.width = width + "px";

    const vec1 = this.editor.cursor.getPositionReverse(row + 1, column - 1);
    const vec2 = this.editor.cursor.getPositionReverse(
      row + 1,
      column + length
    );
    obj.dataset.value = this.editor.lineController.lines[row].slice(
      vec1.column,
      vec2.column
    );
  }

  createSelectEl(column, length, row, classes, value) {
    if (!this.editor.fileManager.activeFile) return;
    let div = document.createElement("div");
    let difY = 4;

    let x = this.editor.cursor.columnToX(column);
    let y = this.editor.cursor.rowToY(row + 1) - difY;
    let width = length * this.editor.letterSize;
    let height = this.editor.cursor.mpY + difY;

    div.className = classes;
    div.dataset.line = row;
    div.dataset.value = value;

    div.style.position = "absolute";
    div.style.left = x + "px";
    div.style.top = y + "px";
    div.style.width = width + "px";
    div.style.height = height + "px";

    this.selectOutput.appendChild(div);
  }

  getNumberLineSelected() {
    if (!this.editor.fileManager.activeFile) return;
    return this.selectOutput.children.length;
  }

  getSelectOBJLine(row) {
    if (!this.editor.fileManager.activeFile) return;
    if (row == undefined) return;
    const children = this.selectOutput ? this.selectOutput.children : null;
    if (!children || !children.length) return undefined;

    for (let i = 0; i < children.length; i++) {
      const el = children[i];
      if (!el.classList || !el.classList.contains("selected")) continue;
      const line = parseInt(el.dataset.line, 10);
      if (line === row) return el;
    }
    return undefined;
  }

  getSelectOBJ() {
    if (!this.editor.fileManager.activeFile) return;
    const children = this.selectOutput ? this.selectOutput.children : null;
    if (!children || !children.length) return [];

    const els = [];
    for (let i = 0; i < children.length; i++) {
      const el = children[i];
      if (el.classList && el.classList.contains("selected")) els.push(el);
    }

    els.sort((a, b) => {
      const aLine = parseInt(a.dataset.line, 10);
      const bLine = parseInt(b.dataset.line, 10);
      return aLine - bLine;
    });
    return els;
  }

  unSelectAll() {
    if (!this.editor.fileManager.activeFile) return;
    this.containsSelected = "";

    if (this.selectOutput) {
      this.selectOutput.innerHTML = "";
    } else {
      let els = this.getSelectOBJ();

      for (let el of els) {
        el.remove();
      }
    }

    CALLEVENT("onSelect", {
      start: undefined,
      end: undefined,
      contains: "",
    });
  }

  selectAll(cursorChange) {
    if (!this.editor.fileManager.activeFile) return;
    this.unSelectAll();
    for (let i = 0; i < this.editor.lineController.maxIndex; i++) {
      this.selectLine(i, cursorChange);
    }

    CALLEVENT("onSelect", {
      start: this.startSelect,
      end: this.endSelect,
      contains: this.containsSelected,
    });
  }

  selectWord(wordOBJ, cursorChange) {
    if (!this.editor.fileManager.activeFile) return;
    if (wordOBJ == undefined) return;
    const rect = wordOBJ.getBoundingClientRect();
    const editorRect = this.editor.output.getBoundingClientRect();

    let x = this.editor.cursor.xToColumn(rect.left - editorRect.left);
    let y = this.editor.cursor.yToRow(rect.top - editorRect.top) - 1;

    this.createSelectEl(
      x,
      wordOBJ.innerText.length,
      y,
      "selected",
      wordOBJ.innerText
    );
    const pos = this.editor.cursor.getPositionReverse(
      y,
      x + wordOBJ.innerText.length - 1
    );
    if (cursorChange) this.editor.cursor.setCursorPosition(y + 1, pos.column);

    CALLEVENT("onSelect", {
      start: this.startSelect,
      end: this.endSelect,
      contains: this.containsSelected,
    });
  }

  unSelectLine(index) {
    if (!this.editor.fileManager.activeFile) return;
    if (index == undefined) return;
    let els = this.getSelectOBJ();
    for (let el of els) {
      if (el.dataset.line == index) el.remove();
    }
  }

  selectLine(index, cursorChange) {
    if (!this.editor.fileManager.activeFile) return;
    if (index == undefined) return;
    this.unSelectLine(index);
    let line = this.editor.lineController;
    if (!line.lines[index] && line.lines.length == 1) return;
    let length = this.editor.cursor.getPosition(
      index + 1,
      line.lines[index].length
    ).column;
    if (length == 0) length = 1;

    this.createSelectEl(1, length, index, "selected", line.lines[index]);
    let x = 0;
    if (index == line.lines.length - 1) x = length;
    if (cursorChange) {
      if (index != this.editor.lineController.maxIndex - 1)
        this.editor.cursor.setCursorPosition(index + 2, x);
      else this.editor.cursor.setCursorPosition(index + 1, length);
    }

    CALLEVENT("onSelect", {
      start: this.startSelect,
      end: this.endSelect,
      contains: this.containsSelected,
    });
  }

  cursorDisabled(event) {
    if (!this.editor.fileManager.activeFile) return;
    let els = this.getSelectOBJ();

    for (let el of els) {
      let classes = el.classList;
      classes.add("selected-afk");
    }
  }

  cursorEnabled(event) {
    if (!this.editor.fileManager.activeFile) return;
    const els = this.getSelectOBJ();
    if (!els || !els.length) return;

    for (const el of els) {
      if (el.classList && el.classList.contains("selected-afk")) {
        el.classList.remove("selected-afk");
      }
    }
  }

  calcClick() {
    var currentTime = new Date().getTime();

    if (this.HstartSelect == undefined) this.HstartSelect = this.startSelect;
    else if (
      this.startSelect.column != this.HstartSelect.column ||
      this.startSelect.row != this.HstartSelect.row
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

  mouseClick(event) {
    if (!this.editor.fileManager.activeFile) return;
    this.calcClick();

    if ((this.clickCount > 1 && this.clickCount < 5) || this.clickCount > 4) {
      this.unSelectAll();
    }

    if (this.clickCount == 2) {
      const word = this.editor.lineController.getWordOBJ(
        this.editor.cursor.row,
        this.editor.cursor.getIndexWord()
      );
      if (!word) return;
      this.selectWord(word, true);
    } else if (this.clickCount == 3) {
      this.selectLine(this.editor.cursor.row - 1, true);
    } else if (this.clickCount >= 4) {
      this.selectAll(true);
    }
  }

  mouseDown(event) {
    if (!this.editor.fileManager.activeFile) return;
    if (event.button == 2) {
      //event right click
      return;
    }

    this.editor.keyBinding.historyX = undefined;

    if (new Date().getTime() - this.lastClickTime > this.clickTime)
      if (this.containsSelected.length > 0) this.unSelectAll();

    this.editor.cursor.onClick(event);
    const pos = this.editor.cursor.getCursorPositionReverse();
    if (!pos) return;

    this.startSelect = {
      column: pos.column,
      row: pos.row,
    };
    this.endSelect = {};
    this.isMouseDown = true;

    this.mouseClick(event);
  }

  mouseUp() {
    if (!this.editor.fileManager.activeFile) return;
    this.isMouseDown = false;
    const pos = this.editor.cursor.getCursorPositionReverse();

    this.endSelect = {
      column: pos.column,
      row: pos.row,
    };
  }

  mouseMove(event) {
    if (!this.editor.fileManager.activeFile) return;
    if (this.isMouseDown) {
      this.clickCount = 0;
      this.editor.cursor.onClick(event);

      this.move();
    }
  }

  move() {
    if (!this.editor.fileManager.activeFile) return;
    const pos = this.editor.cursor.getCursorPositionReverse();
    let c = pos.column;
    let r = pos.row;

    if (this.endSelect && this.endSelect.column == c && this.endSelect.row == r)
      return;

    this.endSelect = {
      column: c,
      row: r,
    };
    
    if (this.startSelect.row == this.endSelect.row)
      this.calculSelectSimpleLine();
    else this.calculSelectMultiLine();

    CALLEVENT("onSelect", {
      start: this.startSelect,
      end: this.endSelect,
      contains: this.containsSelected,
    });
  }

  calculSelectSimpleLine() {
    let x = 0;
    let length = 0;
    let y = this.startSelect.row - 1;
    let mode = 0;
    let content;

    if (this.startSelect.column === this.endSelect.column) {
      this.unSelectAll();
      return;
    }
    const vec1 = this.editor.cursor.getPosition(
      this.startSelect.row,
      this.startSelect.column
    );
    const vec2 = this.editor.cursor.getPosition(
      this.endSelect.row,
      this.endSelect.column
    );
    if (this.startSelect.column < this.endSelect.column) {
      x = vec1.column;
      length = vec2.column - vec1.column;
      mode = 1;
      content = this.editor.lineController.lines[y].slice(
        this.startSelect.column,
        this.endSelect.column
      );
    } else {
      x = vec2.column;
      length = vec1.column - vec2.column;
      mode = 2;
      content = this.editor.lineController.lines[y].slice(
        this.endSelect.column,
        this.startSelect.column
      );
    }

    if (this.getNumberLineSelected() > 1) this.unSelectAll();

    if (this.getSelectOBJLine(y) == undefined) {
      this.createSelectEl(x + 1, length, y, "selected", content);
      return;
    }

    if (mode == 1) this.refreshSelectLine(y, length);
    else this.refreshSelectLineReverse(y, length);
  }

  calculSelectMultiLine() {
  if (!this.editor.fileManager.activeFile) return;

  const lc = this.editor.lineController;
  const cur = this.editor.cursor;

  // Normalize selection to top/bottom
  const startIsTop = this.startSelect.row <= this.endSelect.row;
  const topRow = startIsTop ? this.startSelect.row : this.endSelect.row;
  const bottomRow = startIsTop ? this.endSelect.row : this.startSelect.row;
  const topColView = startIsTop ? this.startSelect.column : this.endSelect.column;
  const bottomColView = startIsTop ? this.endSelect.column : this.startSelect.column;

  const yStart = topRow - 1;
  const yEnd = bottomRow - 1;

  // Convert view columns to raw indices for slicing (handles tabs)
  const topRaw = cur.getPositionReverse(topRow, topColView)?.column ?? 0;
  const bottomRaw = cur.getPositionReverse(bottomRow, bottomColView)?.column ?? 0;

  const lineStart = lc.lines[yStart] ?? "";
  const lineEnd = lc.lines[yEnd] ?? "";

  // Compute view lengths for rendering
  const startViewLen = Math.max(0, (lc.getViewLineLength ? lc.getViewLineLength(yStart) : lineStart.length) - topColView);
  const endViewLen = Math.max(0, bottomColView);

  // Compute values to store in dataset (raw indices)
  const contentStart = startViewLen > 0 ? lineStart.slice(topRaw) : "";
  const contentEnd = endViewLen > 0 ? lineEnd.slice(0, bottomRaw) : "";

  // Update start line selection
  const lineOBJStart = this.getSelectOBJLine(yStart);
  if (startViewLen > 0) {
    if (lineOBJStart) lineOBJStart.remove();
    this.createSelectEl(topColView + 1, startViewLen, yStart, "selected", contentStart);
  } else if (lineOBJStart) {
    lineOBJStart.remove();
  }

  // Update end line selection
  const lineOBJEnd = this.getSelectOBJLine(yEnd);
  if (endViewLen > 0) {
    if (lineOBJEnd) lineOBJEnd.remove();
    this.createSelectEl(1, endViewLen, yEnd, "selected", contentEnd);
  } else if (lineOBJEnd) {
    lineOBJEnd.remove();
  }

  // Middle lines: select entire line
  for (let i = 0; i < lc.maxIndex; i++) {
    if (i === yStart || i === yEnd) continue;

    const isBetween = (yStart < i && i < yEnd) || (yStart > i && i > yEnd);
    const lineOBJ = this.getSelectOBJLine(i);

    if (isBetween) {
      const expectedLen = (lc.lines[i] || "").length;
      const currentValue = this.getTextSelectedLine(i) || "";
      const width = lineOBJ ? parseInt(window.getComputedStyle(lineOBJ).width, 10) : 0;

      if (!lineOBJ || currentValue.length !== expectedLen || width === 0) {
        this.selectLine(i, false);
      }
    } else if (lineOBJ) {
      lineOBJ.remove();
    }
  }
}

  initEventListeners() {
    addEvent("mousedown", this.mouseDown.bind(this), this.editor.output);
    addEvent("mouseup", this.mouseUp.bind(this), document);
    addEvent("mousemove", this.mouseMove.bind(this), this.editor.output);
    addEvent("cursordisabled", this.cursorDisabled.bind(this), document);
    addEvent("cursorenabled", this.cursorEnabled.bind(this), document);
    addEvent(
      "onSelect",
      this.refreshStartEndSelect.bind(this),
      this.editor.output
    );
  }
}
