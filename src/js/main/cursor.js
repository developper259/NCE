class Cursor {
	constructor(e) {
		this.editor = e;
		this.mX = 10;
		this.mY = 7;
		this.mpY = 21;
		this.mpX = 10;
		this.leterSize = 12;
		this.cD = document.querySelector(".editor-caret");
		//y
		this.row = 1;
		//x
		this.column = 0;

		this.rowToY = (row) => {
			return baseY + posY * row - this.mpY;
		};
		this.columnToX = (column) => {
			return baseX + (column - 1) * this.leterSize + 1;
		};
		this.yToRow = (y) => {
			return roundY((y - baseY) / posY) + 1;
		};
		this.xToColumn = (x) => {
			return roundX((x - baseX) / this.leterSize) + 1;
		};

		this.onClick = (event) => {
			const x =
				event.clientX -
				this.editor.output.getBoundingClientRect().left -
				this.mX;
			const y =
				event.clientY -
				this.editor.output.getBoundingClientRect().top -
				this.mY;

			let row = this.yToRow(y);
			let column = this.xToColumn(x);

			if (row <= 0) row = 1;
			if (row > this.editor.lineController.maxIndex)
				row = this.editor.lineController.maxIndex;

			const line = this.editor.lineController.lines[row - 1];
			const l = line.length + (getOccurrence('\t', line) * CONFIG_GET('tab_width')) - getOccurrence('\t', line);
			if (column > l) column = l;

			if (this.row != row || this.column != column)
				CALLEVENT("cursormove", { row: row, column: column });
			this.row = row;
			this.column = column;

			this.setCursorPosition(this.row, this.column);
		};
		this.setCursorPosition = (row, column) => {
			if (row <= 0) row = 1;
			if (row > this.editor.lineController.maxIndex)
				row = this.editor.lineController.maxIndex;
			const line = this.editor.lineController.lines[row - 1];
			let l = 0;
			if (line) l = this.editor.lineController.getLineLength(row - 1);
			if (column > l) column = l;

			if (line.includes('\t')) {
				let i = 0;
				for (let c of line) {
					if (c == '\t') {
						if (column > i && column < (i + CONFIG_GET('tab_width'))) {
							if ((column - i) / CONFIG_GET('tab_width') >= 0.5) column = i + CONFIG_GET('tab_width');
							else column = i;
							break;
						}else i += CONFIG_GET('tab_width');
					}else i++;
				}
			}

			const placeY = this.rowToY(row) - 4;
			const placeX = this.columnToX(column);

			this.cD.style.display = 'block';
			this.cD.style.left = placeX + "px";
			this.cD.style.top = placeY + "px";

			this.row = row;
			this.column = column;

			this.editor.lineController.setFocusLine(this.row);
			CALLEVENT("cursorchange", { row: row, column: column });

			this.editor.selected = true;
		};

		this.getCursorPosition = () => {
			return [this.row, this.column];
		};

		this.getBeforeLetter = () => {
			const l = this.editor.lineController.lines[this.row - 1];
			return l[this.column];
		};
		this.getAfterLetter = () => {
			const l = this.editor.lineController.lines[this.row - 1];
			return l[this.column + 1];
		};
		this.getLine = () => {
			const l = this.editor.lineController.lines[this.row - 1];
			return l;
		};
		this.getBeforeLine = () => {
			const l = this.editor.lineController.lines[this.row - 2];
			return l;
		};
		this.getAfterLine = () => {
			const l = this.editor.lineController.lines[this.row];
			return l;
		};
		this.getIndexWord = () => {
			const l = this.editor.lineController.lines[this.row - 1];
			const words = this.editor.writerController.splitWord(l);
			let count = 0;

			for (let i = 0; i < words.length; i++) {
				const word = words[i];
				count += word.length;
				if (this.column - count <= 0) return i;
			}
		};
		this.getWord = () => {
			const l = this.editor.lineController.lines[this.row - 1];
			const words = this.editor.writerController.splitWord(l);

			return words[this.getIndexWord()];
		};
		this.getBeforeWord = () => {
			const l = this.editor.lineController.lines[this.row - 1];
			const words = this.editor.writerController.splitWord(l);

			return words[this.getIndexWord() - 1];
		};
		this.getAfterWord = () => {
			const l = this.editor.lineController.lines[this.row - 1];
			const words = this.editor.writerController.splitWord(l);

			return words[this.getIndexWord() + 1];
		};
	}
}