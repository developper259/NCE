class SelectController {
	constructor(e) {
		this.editor = e;
		this.isMouseDown = false;
		this.containsSelected = "";

		this.lastClick = 0;
		this.clickCount = 0;

		this.clickTime = 500;

		this.HstartSelect = undefined; // historique start select
		this.startSelect = undefined;
		this.endSelect = undefined;

		this.selectOutput = getElement(".editor-select-output");

		this.createSelectEl = (column, length, row, classes, value) => {
			let div = document.createElement("div");
			let difY = 4;

			let x = this.editor.cursor.columnToX(column);
			let y = this.editor.cursor.rowToY(row + 1) - difY;
			let width = length * this.editor.cursor.leterSize;
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
		};

		this.getNumberLineSelected = () => {
			let n = 0;
			for (var i = 0; i < this.editor.lineController.maxIndex; i++) {
				if (this.getSelectOBJLine(i)) n++;
			}
			return n;
		};

		this.getSelectOBJLine = (row) => {
			let obj = getElement(".selected[data-line='" + row + "']");
			if (obj == null) return undefined;
			return obj;
		};
		this.getSelectOBJ = () => {
			let els = getElements(".selected");
			els.sort((a, b) => {
				let aLine = a.dataset.line;
				let bLine = b.dataset.line;
				return aLine - bLine;
			});
			return els;
		};

		this.refreshSelectLine = (row, length) => {
			let obj = this.getSelectOBJLine(row);
			if (!obj) return;

			let width = length * this.editor.cursor.leterSize;
			obj.style.width = width + "px ";
			let column = this.editor.cursor.xToColumn(parseInt(window.getComputedStyle(obj).left, 10)) - 1;
			obj.dataset.value = this.editor.lineController.sliceLine(obj.dataset.line, column, column + length);
		};

		this.refreshSelectLineReverse = (row, length) => {
			let obj = this.getSelectOBJLine(row);
			if (!obj) return;

			let width = length * this.editor.cursor.leterSize;
			let lengthInit =
				parseInt(window.getComputedStyle(obj).width, 10) /
				this.editor.cursor.leterSize;
			let column =
				this.editor.cursor.xToColumn(
					parseInt(window.getComputedStyle(obj).left, 10),
				) -
				(length - lengthInit);
			let x = this.editor.cursor.columnToX(column);

			obj.style.left = x + "px";
			obj.style.width = width + "px";

			obj.dataset.value = this.editor.lineController.sliceLine(obj.dataset.line, column - 1, column + length - 1);
		};

		this.unSelectAll = () => {
			this.containsSelected = "";
			this.selectOutput.innerHTML = "";
		};

		this.selectAll = (cursorChange) => {
			this.unSelectAll();
			for (let i = 0; i < this.editor.lineController.maxIndex; i++) {
				this.selectLine(i, cursorChange);
			}

			CALLEVENT("onSelect", {
				start: this.startSelect,
				end: this.endSelect,
				contains: this.containsSelected,
			});
		};

		this.selectWord = (wordOBJ, cursorChange) => {
			const rect = wordOBJ.getBoundingClientRect();
			const editorRect = this.editor.output.getBoundingClientRect();

			let x = this.editor.cursor.xToColumn(rect.left - editorRect.left);
			let y = this.editor.cursor.yToRow(rect.top - editorRect.top);

			y -= 1;

			this.createSelectEl(
				x,
				wordOBJ.innerText.length,
				y,
				"selected",
				wordOBJ.innerText,
			);
			if (cursorChange) this.editor.cursor.setCursorPosition(
				y + 1,
				x + wordOBJ.innerText.length - 1,
			);

			CALLEVENT("onSelect", {
				start: this.startSelect,
				end: this.endSelect,
				contains: this.containsSelected,
			});
		};

		this.unSelectLine = (index) => {
			let els = this.getSelectOBJ();
			for (let el of els) {
				if (el.dataset.line == index) el.remove();
			}
		};
		this.selectLine = (index, cursorChange) => {
			this.unSelectLine(index);
			let line = this.editor.lineController;
			let length = line.getLineLength(index);
			if (length == 0) length = 1;

			this.createSelectEl(
				1,
				length,
				index,
				"selected",
				line.lines[index],
			);
			let x = 0;
			if (index == line.lines.length - 1) x = line.getLineLength(index - 1);
			if (cursorChange) {
				if (index != this.editor.lineController.maxIndex - 1) this.editor.cursor.setCursorPosition(index + 2, x);
				else this.editor.cursor.setCursorPosition(index + 1, this.editor.lineController.getLineLength(index));
			}

			CALLEVENT("onSelect", {
						start: this.startSelect,
						end: this.endSelect,
						contains: this.containsSelected,
					});
		};

		this.getTextSelectedLine = (index) => {
			let lineOBJ = this.getSelectOBJLine(index);

			if (lineOBJ == undefined) return undefined;

			return lineOBJ.dataset.value;
		};

		this.refreshContaisSelected = () => {
			this.containsSelected = "";
			let count = 0

			for (let i in this.editor.lineController.lines) {
				let t = this.getTextSelectedLine(i);
				if (t != undefined){
					this.containsSelected += t;
					count++;
				
					if (count != this.getNumberLineSelected())
					this.containsSelected += "\n";
				}
			}
		};
		this.refreshStartEndSelect = () => {
			let els = [];

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
						nextEl = els[i+1];
						nextElW = parseInt(window.getComputedStyle(nextEl).width);
						nextElX = parseInt(window.getComputedStyle(nextEl).left, 10);
					}

					if (i == 0) {
						classes.add("selected-start");
					}else{
						if (lastElX > elX) {
							classes.add("selected-top-left")
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
			}
			this.refreshContaisSelected();
		};
		this.cursorDisabled = (event) => {
			let els = this.getSelectOBJ();

			for (let el of els) {
				let classes = el.classList;
				classes.add("selected-afk");
			}
		};
		this.cursorEnabled = (event) => {
			let els = getElements(".selected-afk");

			for (let el of els) {
				let classes = el.classList;
				classes.remove("selected-afk");
			}
		};
		this.calcClick = () => {
			var currentTime = new Date().getTime();

			if (this.HstartSelect == undefined) this.HstartSelect = this.startSelect;
			else if (this.startSelect.column != this.HstartSelect.column || this.startSelect.row != this.HstartSelect.row) {
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
		};
		this.mouseClick = (event) => {
			this.calcClick();

			if (this.clickCount > 1 && this.clickCount < 5 || this.clickCount > 4) {
				this.unSelectAll();
			}

			if (this.clickCount == 2) {
				const word = this.editor.lineController.getWordOBJ(
					this.editor.cursor.row,
					this.editor.cursor.getIndexWord(),
				);
				
				this.selectWord(word, true);
			} else if (this.clickCount == 3) {
				this.selectLine(this.editor.cursor.row - 1, true);
			} else if (this.clickCount >= 4) {
				this.selectAll(true);
			}
		};
		this.mouseDown = (event) => {
			if (event.button == 2) {
				//event right click
				return;
			}

			this.editor.keyBinding.historyX = undefined;

			if (new Date().getTime() - this.lastClickTime > this.clickTime)
				this.unSelectAll();

			this.editor.cursor.onClick(event);

			this.startSelect = {
				column: this.editor.cursor.column,
				row: this.editor.cursor.row,
			};
			this.endSelect = {};
			this.isMouseDown = true;

			this.mouseClick(event);
		};
		this.mouseUp = () => {
			this.isMouseDown = false;

			this.endSelect = {
				column: this.editor.cursor.column,
				row: this.editor.cursor.row,
			};
		};
		this.mouseMove = (event) => {
			if (this.isMouseDown) {
				this.clickCount = 0;
				this.editor.cursor.onClick(event);

				this.move();
			}
		};

		this.move = () => {
			let c = this.editor.cursor.column;
			let r = this.editor.cursor.row;

			if (this.endSelect && this.endSelect.column == c && this.endSelect.row == r) return;

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
		};

		this.calculSelectSimpleLine = () => {
			let x = 0;
			let length = 0;
			let y = this.startSelect.row - 1;
			let mode = 0;

			if (this.startSelect.column === this.endSelect.column) {
				this.unSelectAll();
				return;
			}

			if (this.startSelect.column < this.endSelect.column) {
				x = this.startSelect.column;
				length = this.endSelect.column - this.startSelect.column;
				mode = 1;
			} else {
				x = this.endSelect.column;
				length = this.startSelect.column - this.endSelect.column;
				let mode = 2;
			}

			if (this.getNumberLineSelected() > 1) this.unSelectAll();

			if (this.getSelectOBJLine(y) == undefined) {
				this.createSelectEl(
					x + 1,
					length,
					y,
					"selected",
					'',
				);
			}
			
			if (mode == 1) this.refreshSelectLine(y, length);
			else this.refreshSelectLineReverse(y, length);
		};

		this.calculSelectMultiLine = () => {
			let xStart;
			let lengthStart;
			let yStart;
			let contentStart;

			let xEnd;
			let lengthEnd;
			let yEnd;
			let contentEnd;

			if (this.startSelect.row < this.endSelect.row) {
				xStart = this.startSelect.column;
				yStart = this.startSelect.row - 1;
				lengthStart = this.editor.lineController.getLineLength(yStart) - xStart;
				contentStart = this.editor.lineController.sliceLine(yStart, xStart);

				xEnd = 0;
				lengthEnd = this.endSelect.column;
				yEnd = this.endSelect.row - 1;
				contentEnd = this.editor.lineController.sliceLine(yEnd, 0,lengthEnd);
			} else {
				xStart = 0;
				yStart = this.startSelect.row - 1;
				lengthStart = this.startSelect.column;
				contentStart = this.editor.lineController.sliceLine(yStart, 0, lengthStart);

				xEnd = this.endSelect.column;
				yEnd = this.endSelect.row - 1;
				lengthEnd = this.editor.lineController.getLineLength(yEnd) - xEnd;
				contentEnd = this.editor.lineController.sliceLine(yEnd, xEnd);
			}

			let lineContentStart = this.getTextSelectedLine(yStart);
			let lineContentEnd = this.getTextSelectedLine(yEnd);

			let lineOBJStart = this.getSelectOBJLine(yStart);
			let lineOBJEnd = this.getSelectOBJLine(yEnd);

			if (lineContentStart != contentStart) {
				if (lineOBJStart) lineOBJStart.remove();
				this.createSelectEl(
					xStart + 1,
					lengthStart,
					yStart,
					"selected",
					contentStart,
				);
			}

			if (lineContentEnd != contentEnd || contentEnd.length == 0) {
				if (lineOBJEnd) lineOBJEnd.remove();

				this.createSelectEl(xEnd + 1, lengthEnd, yEnd, "selected", contentEnd);
			}

			for (var i = 0; i < this.editor.lineController.maxIndex; i++) {
				if (i != yStart && i != yEnd) {
					let lineOBJ = this.getSelectOBJLine(i);
					let contentLine = this.getTextSelectedLine(i);
					if ((yStart < i && i < yEnd) || (yStart > i && i > yEnd)) {
						if (
							lineOBJ == undefined ||
							contentLine.length != this.editor.lineController.getLineLength(i)
						)
							this.selectLine(i, false);
					} else {
						if (lineOBJ) lineOBJ.remove();
					}
				}
			}
		};

		addEvent("mousedown", this.mouseDown, this.editor.output);
		addEvent("mouseup", this.mouseUp, document);
		addEvent("mousemove", this.mouseMove, this.editor.output);
		addEvent("cursordisabled", this.cursorDisabled, document);
		addEvent("cursorenabled", this.cursorEnabled, document);
		addEvent("onSelect", this.refreshStartEndSelect, this.editor.output);
	}
}