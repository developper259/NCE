class WriterController {
	constructor(e) {
		this.editor = e;
		this.insertMode = false;
		this.separator = [
			" ",
			"!",
			'"',
			"#",
			"$",
			"%",
			"&",
			"'",
			"(",
			")",
			"*",
			"+",
			",",
			"-",
			".",
			"/",
			":",
			";",
			"<",
			"=",
			">",
			"?",
			"@",
			"[",
			"]",
			"^",
			"_",
			"`",
			"{",
			"|",
			"}",
			"~",
			"\t",
		];

		this.setInsertMode = (mode) => {
			this.insertMode = mode;
			if (mode) this.editor.cursor.cD.classList.add("insert-mode");
			else if (this.editor.cursor.cD.classList.contains("insert-mode"))
				this.editor.cursor.cD.classList.remove("insert-mode");
		};

		this.splitWord = (txt) => {
			let oldChar = "";
			let tableSplit = [];
			for (let char of txt) {
				if (this.separator.includes(char)) {
					if (this.separator.includes(oldChar)) {
						tableSplit[tableSplit.length - 1] += char;
					} else {
						tableSplit.push(char);
					}
				} else {
					if (!tableSplit.length || this.separator.includes(oldChar)) {
						tableSplit.push(char);
					} else {
						tableSplit[tableSplit.length - 1] += char;
					}
				}
				oldChar = char;
			}
			tableSplit = tableSplit.filter(function (chaine) {
				return chaine.length !== 0;
			});

			return tableSplit;
		};

		this.splitWordView = (txt) => {
			let oldChar = "";
			let tableSplit = [];
			for (let char of txt) {
				if (this.separator.includes(char)) {
					let c = char.replace(/\t/g, '_'.repeat(CONFIG_GET('tab_width')));
					if (this.separator.includes(oldChar)) {
						tableSplit[tableSplit.length - 1] += c;
					} else {
						tableSplit.push(c);
					}
				} else {
					if (!tableSplit.length || this.separator.includes(oldChar)) {
						tableSplit.push(char);
					} else {
						tableSplit[tableSplit.length - 1] += char;
					}
				}
				oldChar = char;
			}
			tableSplit = tableSplit.filter(function (chaine) {
				return chaine.length !== 0;
			});

			return tableSplit;
		};


		this.toHTML = (txt) => {
			let result = '<div class="line editor-select">$value</div>';

			let resultWords = "";

			let words = this.splitWordView(txt);

			for (let word of words) {
				if (word != "") {
					let classes = "line-word editor-select";
					resultWords += `<span class="${classes}">${word}</span>`;
				}
			}

			return result.replace("$value", resultWords);
		};

		this.write = (txt) => {
			this.editor.keyBinding.historyX = undefined;
			this.editor.keyBinding.indexHistory = 1;

			let x = this.editor.cursor.column;
			let y = this.editor.cursor.row - 1;

			if (this.editor.selectController.containsSelected) {
				let cursor = this.deleteSelection();
				x = cursor.column;
				y = cursor.row - 1;
			}
			let line = this.editor.lineController.lines[y];
			const l = this.editor.lineController;

			if (!txt.includes("\n")) {
				if (txt == undefined) newLine = '';

				let newLine;
				if (!this.insertMode || txt.length > 1) 
					newLine = l.sliceLine(y, 0, x) + txt + l.sliceLine(y, x);
				else if (txt.length == 1 && this.insertMode) {
					newLine = line.substring(0, x) + txt + line.substring(x+1);
				}
				this.editor.lineController.changeLine(newLine, y);

				x += txt.length + (getOccurrence('\t', txt) * CONFIG_GET('tab_width')) - getOccurrence('\t', txt);
				this.editor.cursor.setCursorPosition(y + 1, x);
			}else{
				let newLines = txt.split("\n");

				for (let i = 0; i < newLines.length; i++) {
					let newLine = newLines[i];
					if (newLine == undefined) newLine = '';

					if (i == 0) {
						newLine = l.sliceLine(y, 0, x) + newLine;
						this.editor.lineController.changeLine(newLine, y);
					}else if (i == newLines.length - 1) {
						newLine = newLine + l.sliceLine(y, x);
						this.editor.lineController.addLine(newLine, y + i);
						x = newLine.length;
					}else{
						this.editor.lineController.addLine(newLine, y + i);
					}
				}
				this.editor.cursor.setCursorPosition(y + newLines.length, x);
			}
		};

		this.delete = (x, y) => { // return {colum: ..., row: ...}
			let cursor = {column: x, row: y};
			let newLine = "";
			const l = this.editor.lineController;

			if (cursor.column == 0) {
				cursor.row -= 1;
				cursor.column = this.editor.lineController.getLineLength(cursor.row - 1);
				newLine = l.lines[cursor.row - 1] + l.lines[y - 1];
				this.editor.lineController.supLine(cursor.row);
			}else {
				let Nx = cursor.column - 1;
				if (this.editor.lineController.getLetter(y - 1, Nx) == '\t') Nx = cursor.column - CONFIG_GET('tab_width');
				newLine = l.sliceLine(y - 1, 0, Nx) + l.sliceLine(y - 1, cursor.column);
				cursor.column = Nx;
			}

			this.editor.lineController.changeLine(newLine, cursor.row - 1);

			return cursor;
		};

		this.deleteWord = (x, y) => { // return {colum: ..., row: ...}
			let cursor = {column: x, row: y};
			const l = this.editor.lineController;
			const line = l.lines[y - 1];
			let newLine = "";

			if (cursor.column == 0) {
				cursor.row -= 1;
				cursor.column = this.editor.lineController.getLineLength(cursor.row - 1);
				newLine = this.editor.lineController.lines[cursor.row - 1] + line;
				this.editor.lineController.supLine(cursor.row);
			}else {
				const words = this.splitWordView(line);
				const wordsT = this.splitWord(line); // words true
				let newLineT = "";
				let count = 0;
				let cX = 0;
				let lastWord;
				
				for (let i = 0; i < words.length; i++) {
					const word = words[i];
					const wordT = wordsT[i];  // word true
					cX = cursor.column - (count + word.length);

					if (cX <= 0) {
						lastWord = word;
						break;
					}else{
						newLine += word;
						newLineT += wordT;
					}
					count += word.length;
				}

				if (cX != 0) {
					newLineT += lastWord.slice(y - 1, lastWord.length - (cX * - 1)) + l.sliceLine(y - 1, newLine.length + lastWord.length);
					cursor.column -= lastWord.length - (cX * - 1);
					newLine = newLineT;
				}else{
					newLineT += l.sliceLine(y - 1, newLine.length + lastWord.length);
					cursor.column -= lastWord.length;
					newLine = newLineT;
				}
			}
			this.editor.lineController.changeLine(newLine, cursor.row - 1);

			return cursor;
		};

		this.deleteSelection = () => {	// return {colum: ..., row: ...}
			let objs = this.editor.selectController.getSelectOBJ();
			let cursor = {column: 0, row: 0};

			objs.sort((a, b) => {
				let aLine = a.dataset.line;
				let bLine = b.dataset.line;
				return bLine - aLine;
			});

			let rest = "";
			let i = 0;

			for (let obj of objs) {
				let nbLine = parseInt(obj.dataset.line);
				let column = this.editor.cursor.xToColumn(parseInt(window.getComputedStyle(obj).left, 10)) - 1;
				let width = parseInt(window.getComputedStyle(obj).width, 10) / this.editor.cursor.leterSize;
				const l = this.editor.lineController;
				
				let newLine = l.sliceLine(nbLine, 0, column) + l.sliceLine(nbLine, column + width);

				if (i != objs.length - 1) {
					if (newLine != "") rest = newLine + rest;
					this.editor.lineController.supLine(nbLine);
				}else{
					this.editor.lineController.changeLine(newLine + rest, nbLine);
					cursor.row = nbLine + 1;
					if (objs.length != 1) cursor.column = newLine.length;
					else cursor.column = column;
				}
				i++;
			}
			this.editor.selectController.unSelectAll();
			return cursor;
		};
	}
}


