class KeyBinding {
	constructor(e) {
		this.editor = e;

		this.func = {
			"save": this.control_save,
			"open_file": this.control_open_file,
			"new_file": this.control_new_file,
			"close_file": this.control_close_file,
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

		this.exec = (key) => {
			if (this.func[key.action]) {
				console.log(`Executing action: ${key.action} (${key.description})`);
				this.func[key.action].call(this);
			}else if (this.func[key.key]) { 
				console.log(`Executing action: ${key.key}`);
				this.func[key.key].call(this);
			}else {
				console.log(`No action found for key: ${key ? key.key : 'undefined'}`);
			}
		};
	}

	// Control functions
	control_save() {}
	control_open_file() {}
	control_new_file() {}
	control_close_file() {}
	async control_copy() {
		const selectedText = this.editor.selectController.containsSelected;
		if (selectedText) {
			try {
				await navigator.clipboard.writeText(selectedText);
				console.log("Texte copié dans le presse-papiers.");
			} catch (err) {
				console.error("Erreur lors de la copie : ", err);
			}
		} else {
			console.log("Aucun texte sélectionné pour la copie.");
		}
	}

	async control_paste() {
		try {
			const text = await navigator.clipboard.readText();
			this.editor.writerController.write(text);
		} catch (err) {
			console.error("Erreur lors du collage : ", err);
		}
	}

	async control_cut() {
		this.control_copy();
		this.key_backspace();
	}
	control_undo() {}
	control_redo() {}
	control_find() {}
	control_replace() {}
	control_open_command() {
		
	}
	control_delete_line() {}
	control_select_all() {
		this.editor.selectController.selectAll();
	}

	// Key functions
	key_escape() {
		if (this.editor.panel == undefined) return;
		else this.editor.panel.close();
	}
	key_tab() {
		this.editor.writerController.write("\t");
	}
	key_delete() {}
	key_backspace() {
		
	}
	key_enter() {
		this.editor.writerController.write("\n");
	}
	key_arrow_up() {}
	key_arrow_down() {}
	key_arrow_left() {}
	key_arrow_right() {}
	key_home() {}
	key_end() {}
	key_insert() {}
}
