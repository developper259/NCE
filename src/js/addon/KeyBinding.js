class KeyBinding {
	constructor(e) {
		this.editor = e;

		this.func = {
			"save": this.control_save,
			"open_file": this.control_open_file,
			"new_file": this.control_new_file,
			"close_file": this.control_close_file,
			"close_all_file": this.control_close_all_file,
			"copy": this.control_copy,
			"paste": this.control_paste,
			"cut": this.control_cut,
			"undo": this.control_undo,
			"redo": this.control_redo,
			"find": this.control_find,
			"replace": this.control_replace,
			"open_command": this.control_open_command,
			"delete_line": this.control_delete_line,
			"select_all": this.control_select_all,

			"Escape": this.key_escape,
			"Tab": this.key_tab,
			"Delete": this.key_delete,
			"Backspace": this.key_backspace,
			"Enter": this.key_enter,
			"ArrowUp": this.key_arrow_up,
			"ArrowDown": this.key_arrow_down,
			"ArrowLeft": this.key_arrow_left,
			"ArrowRight": this.key_arrow_right,
			"Home": this.key_home,
			"End": this.key_end,
			"Insert": this.key_insert
		};

		setInterval(() => {
			if (!this.editor.fileManager.activeFile) return;
			const currentLines = JSON.stringify(this.editor.lineController.lines);
			const currentCursor = {row: this.editor.cursor.row, column: this.editor.cursor.column};
			if (this.editor.fileManager.activeFile.indexHistory < 1) this.editor.fileManager.activeFile.indexHistory = 1;
			if (this.editor.fileManager.activeFile.indexHistory != 1) return;
			if (this.editor.fileManager.activeFile.history.length > 100) this.editor.fileManager.activeFile.history.shift();

			
			if (this.editor.fileManager.activeFile.history.length === 0 || this.editor.fileManager.activeFile.history[this.editor.fileManager.activeFile.history.length - 1].lines !== currentLines) {
				this.editor.fileManager.activeFile.history.push({lines: currentLines, cursor: null});
			}
			this.editor.fileManager.activeFile.history[this.editor.fileManager.activeFile.history.length - 1].cursor = currentCursor;
		}, 1000);

		addEvent('onWrite', this.onWrite.bind(this), this.editor.output);
	}

	exec (key, e) {
		let s = false;
		let c = false;
		let m = false;
		let a = false;
		
		if (e != undefined) {
			s = e.shiftKey; 
			c = e.ctrlKey;
			m = e.metaKey;
			a = e.altKey;
		}
		if (this.func[key.action]) {
			console.log(`Executing action: ${key.action} (${key.description})`);
			this.func[key.action].call(this, s, c, m, a);
		}else if (this.func[key.key]) { 
			console.log(`Executing action: ${key.key}`);
			this.func[key.key].call(this, s, c, m, a);
		}
	}

	onWrite() {
		this.editor.fileManager.activeFile.indexHistory = 1;
	}

	// Control functions
	control_save(s, c, m, a) {
		if (!this.editor.fileManager.activeFile) return;
		if (s) {
			this.editor.fileManager.activeFile.saveAs();
		}else{
			this.editor.fileManager.activeFile.save();
		}
	}
	async control_open_file(s, c, m, a) {
		const file = await this.editor.fileManager.selectFiles();
		
		this.editor.fileManager.openFiles(file);
	}
	control_new_file(s, c, m, a) {
		this.editor.fileManager.createEmptyFile();
	}
	control_close_file(s, c, m, a) {
		if (this.editor.fileManager.files.length != 0) this.editor.fileManager.closeActiveFile();
		else this.editor.api.quit();
	}

	control_close_all_file(s, c, m, a) {
		this.editor.api.quit();
	}
	async control_copy(s, c, m, a) {
		let txt = this.editor.selectController.containsSelected;
		
		if (!txt) {
			txt = this.editor.lineController.lines[this.editor.cursor.row - 1];
		}
		try {
			await navigator.clipboard.writeText(txt);
			console.log("Texte copié dans le presse-papiers.");
		} catch (err) {
			console.error("Erreur lors de la copie : ", err);
		}
	}

	async control_paste(s, c, m, a) {
		try {
			const text = await navigator.clipboard.readText();
			console.log(text);
			this.editor.writerController.write(text);
		} catch (err) {
			console.error("Erreur lors du collage : ", err);
		}
	}

	async control_cut(s, c, m, a) {
		let txt = this.editor.selectController.containsSelected;
		this.control_copy();
		if (txt) this.key_backspace();
		else {
			if (this.editor.lineController.maxIndex != this.editor.cursor.row)
				this.editor.lineController.supLine(this.editor.cursor.row - 1);
			else this.editor.lineController.changeLine('', this.editor.cursor.row - 1);
			this.editor.cursor.setCursorPosition(this.editor.cursor.row, 0);
		}
	}
	control_undo(s, c, m, a) {
		if (!this.editor.fileManager.activeFile.history) return;

		console.log(this.editor.fileManager.activeFile.history, this.editor.fileManager.activeFile.indexHistory);

		if (!this.editor.fileManager.activeFile.history[this.editor.fileManager.activeFile.history.length - (this.editor.fileManager.activeFile.indexHistory + 1)]) return;

		this.editor.fileManager.activeFile.indexHistory += 1;
		this.editor.lineController.lines = JSON.parse(this.editor.fileManager.activeFile.history[this.editor.fileManager.activeFile.history.length - this.editor.fileManager.activeFile.indexHistory].lines);
		this.editor.cursor.setCursorPosition(this.editor.fileManager.activeFile.history[this.editor.fileManager.activeFile.history.length - this.editor.fileManager.activeFile.indexHistory].cursor.row, this.editor.fileManager.activeFile.history[this.editor.fileManager.activeFile.history.length - this.editor.fileManager.activeFile.indexHistory].cursor.column);
		this.editor.lineController.refresh();
        CALLEVENT('onChange');
	}

	control_redo(s, c, m, a) {
		if (!this.editor.fileManager.activeFile.history) return;
		
		if (!this.editor.fileManager.activeFile.history[this.editor.fileManager.activeFile.history.length - (this.editor.fileManager.activeFile.indexHistory - 1)]) return;

		this.editor.fileManager.activeFile.indexHistory -= 1;
		this.editor.lineController.lines = JSON.parse(this.editor.fileManager.activeFile.history[this.editor.fileManager.activeFile.history.length - this.editor.fileManager.activeFile.indexHistory].lines);
		this.editor.cursor.setCursorPosition(this.editor.fileManager.activeFile.history[this.editor.fileManager.activeFile.history.length - this.editor.fileManager.activeFile.indexHistory].cursor.row, this.editor.fileManager.activeFile.history[this.editor.fileManager.activeFile.history.length - this.editor.fileManager.activeFile.indexHistory].cursor.column);
		this.editor.lineController.refresh();
        CALLEVENT('onChange');
	}

	control_find(s, c, m, a) {
	}
	control_replace(s, c, m, a) {
	}
	control_open_command(s, c, m, a) {
		if (this.editor.panel instanceof CMD) this.editor.panel.close();
		else this.editor.Ccmd.open();
	}
	control_delete_line(s, c, m, a) {
		console.log(this.editor.cursor.row);
		this.editor.lineController.supLine(this.editor.cursor.row - 1);
		this.editor.cursor.setCursorPosition(this.editor.cursor.row, this.editor.cursor.column);
	}
	control_select_all(s, c, m, a) {
		this.editor.selectController.selectAll(true);
	}

	// Key functions
	key_escape(s, c, m, a) {
		if (this.editor.panel == undefined) return;
		else this.editor.panel.close();
	}
	key_tab(s, c, m, a) {
		this.editor.writerController.write("\t");
	}
	key_delete(s, c, m, a) {
		if (m || a) return;
		this.editor.fileManager.activeFile.historyX = undefined;
		let x = this.editor.cursor.column;
		let y = this.editor.cursor.row;

		let cursor;

		if (!this.editor.selectController.containsSelected) {
			let newLine = "";
			const l = this.editor.lineController.lines[y - 1];
			if (c) {
				if (s) {
					if (x == 0) {
						y -= 1;
						x = this.editor.lineController.getLineLength(y - 1);
						newLine = l + this.editor.lineController.lines[y];
						this.editor.lineController.supLine(y);
					}else {
						newLine = this.editor.lineController.sliceLine(y - 1, 0, x);
						x = newLine.length;
					}
				}else{
					cursor = this.editor.writerController.deleteWord(x, y);
				}
			}else{
				x = x + 1;
				if (this.editor.lineController.getLetter(y - 1, x + 1) == '\t') x += CONFIG_GET('tab_width') - 1;
				cursor = this.editor.writerController.delete(x, y);	
			}
		}else{
			cursor = this.editor.writerController.deleteSelection();
		}

		this.editor.cursor.setCursorPosition(cursor.row, cursor.column);
	}
	key_backspace(s, c, m, a) {
		if (m || a) return;
		this.editor.fileManager.activeFile.historyX = undefined;
		let x = this.editor.cursor.column;
		let y = this.editor.cursor.row;

		let cursor;

		if (!this.editor.selectController.containsSelected) {
			let newLine = "";
			const l = this.editor.lineController.lines[y - 1];
			if (c) {
				if (s) {
					if (x == 0) {
						y -= 1;
						x = this.editor.lineController.getLineLength(y - 1);
						newLine = this.editor.lineController.lines[y - 1] + l;
						this.editor.lineController.supLine(y);
					}else {
						newLine = this.editor.lineController.sliceLine(y - 1, x);
						x = 0;
					}
					this.editor.lineController.changeLine(newLine, y - 1);
					this.editor.cursor.setCursorPosition(y, x);
					return;
				}else{
					if (x == 0 && y == 1) return;
					cursor = this.editor.writerController.deleteWord(x, y);
				}
			}else{
				if (x == 0 && y == 1) return;
				cursor = this.editor.writerController.delete(x, y);	
			}
		}else{
			cursor = this.editor.writerController.deleteSelection();
		}

		this.editor.cursor.setCursorPosition(cursor.row, cursor.column);
	}
	key_enter(s, c, m, a) {
		this.editor.writerController.write("\n");
	}
	key_arrow_up(s, c, m, a) {
		let x = this.editor.cursor.column;
		let y = this.editor.cursor.row;

		if (s) {
			if (this.editor.selectController.containsSelected.length == 0) {
				this.editor.selectController.startSelect = {
					column: x,
					row: y,
				};
			}
			this.editor.selectController.isMouseDown = true;
		}else if (this.editor.selectController.containsSelected.length != 0) {
			this.editor.selectController.unSelectAll();
			return;
		}


		if (this.editor.fileManager.activeFile.historyX == undefined) this.editor.fileManager.activeFile.historyX = x;

		if (y == 1) {
			if (this.editor.fileManager.activeFile.historyX != 0) this.editor.fileManager.activeFile.historyX = 0;
			else {
				this.editor.selectController.isMouseDown = false;
				return;
			}
		}else y -= 1;

		this.editor.cursor.setCursorPosition(y, this.editor.fileManager.activeFile.historyX);
		if (s){
			this.editor.selectController.move();
			this.editor.selectController.isMouseDown = false;
		}
	}
	key_arrow_down(s, c, m, a) {
		let x = this.editor.cursor.column;
		let y = this.editor.cursor.row;

		if (s) {
			if (this.editor.selectController.containsSelected.length == 0) {
				this.editor.selectController.startSelect = {
					column: x,
					row: y,
				};
			}
			this.editor.selectController.isMouseDown = true;
		}else if (this.editor.selectController.containsSelected.length != 0) {
			this.editor.selectController.unSelectAll();
			return;
		}

		if (this.editor.fileManager.activeFile.historyX == undefined) this.editor.fileManager.activeFile.historyX = x;

		if (y == this.editor.lineController.maxIndex) {
			if (this.editor.fileManager.activeFile.historyX != this.editor.lineController.getLineLength(y - 1)) 
				this.editor.fileManager.activeFile.historyX = this.editor.lineController.getLineLength(y - 1);
			else {
				this.editor.selectController.isMouseDown = false;
				return;
			}
		} else y += 1

		this.editor.cursor.setCursorPosition(y, this.editor.fileManager.activeFile.historyX);

		if (s){
			this.editor.selectController.move();
			this.editor.selectController.isMouseDown = false;
		}
	}
	key_arrow_left(s, c, m, a) {
		this.editor.fileManager.activeFile.historyX = undefined;
		let x = this.editor.cursor.column;
		let y = this.editor.cursor.row;

		if (s) {
			if (this.editor.selectController.containsSelected.length == 0) {
				this.editor.selectController.startSelect = {
					column: x,
					row: y,
				};
			}
			this.editor.selectController.isMouseDown = true;
		}else if (this.editor.selectController.containsSelected.length != 0) {
			this.editor.selectController.unSelectAll();
			return;
		}
		
		if (y == 1 && x == 0) return;

		if (a) {
			const l = this.editor.lineController.lines[y - 1];
			const words = this.editor.writerController.splitWordView(l);
			let count = 0;

			for (let i = 0; i < words.length; i++) {
				const word = words[i];

				if (x - (count + word.length) <= 0) {
					x = count;
					break;
				}
				count += word.length;
			}
		}else if (m) {
			this.key_home(s, c, m, a);
			return;
		}else{
			if (x == 0) {
				y -= 1;
				x = this.editor.lineController.getLineLength(y - 1);
			}else {
				if (this.editor.lineController.getLetter(y - 1, x - 1) == '\t') x -= CONFIG_GET('tab_width');
				else x -= 1
			}
		}

		this.editor.cursor.setCursorPosition(y, x);

		if (s){
			this.editor.selectController.move();
			this.editor.selectController.isMouseDown = false;
		}
	}
	key_arrow_right(s, c, m, a) {
		this.editor.fileManager.activeFile.historyX = undefined;
		let x = this.editor.cursor.column;
		let y = this.editor.cursor.row;

		if (s) {
			if (this.editor.selectController.containsSelected.length == 0) {
				this.editor.selectController.startSelect = {
					column: x,
					row: y,
				};
			}
			this.editor.selectController.isMouseDown = true;
		}else if (this.editor.selectController.containsSelected.length != 0) {
			this.editor.selectController.unSelectAll();
			return;
		}

		if (y == this.editor.lineController.maxIndex && x == this.editor.lineController.getLineLength(y - 1)) return;

		if (c || a) {
			const l = this.editor.lineController.lines[y - 1];
			const words = this.editor.writerController.splitWordView(l);
			let count = 0;

			for (let i = 0; i < words.length; i++) {
				const word = words[i];
				count += word.length;

				if (x - count < 0) {
					x = count;
					break;
				}
			}
		}else if (m) {
			this.key_end(s, c, m, a);
			return;
		}else{
			let length = this.editor.lineController.getLineLength(y - 1);

			if (x == length) {
				y += 1;
				x = 0;
			}else {
				if (this.editor.lineController.getLetter(y - 1, x + 1) == '\t') x += CONFIG_GET('tab_width');
				else x += 1
			}
		}

		this.editor.cursor.setCursorPosition(y, x);

		if (s) {
			this.editor.selectController.move();
			this.editor.selectController.isMouseDown = false;
		}
	}
	key_home(s, c, m, a) {
		let y = this.editor.cursor.row;
		this.editor.cursor.setCursorPosition(y, 0);
	}
	key_end(s, c, m, a) {
		let y = this.editor.cursor.row;
		let x = this.editor.lineController.getLineLength(this.editor.cursor.row - 1);
		this.editor.cursor.setCursorPosition(y, x);
	}
	key_insert(s, c, m, a) {
		let wc = this.editor.writerController;
		wc.setInsertMode(!wc.insertMode);
	}
}