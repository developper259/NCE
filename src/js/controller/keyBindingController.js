class keyBindingController {
	constructor(e) {
		this.editor = e;

		this.bindEditor = (key) => {
			if (key.length == 1) this.editor.writerController.write(key);
			if (CONFIG_KEYBINDING_CONTAINSKEY(key)) {
				this.editor.keyBinding.exec(CONFIG_KEYBINDING_GET_KEY(key));
			}
		};

		this.bind = (key) => {
			if (CONFIG_KEYBINDING_CONTAINSKEY(key)) {
				let item = CONFIG_KEYBINDING_GET_KEY(key);
				if (item.in_editor == false) this.editor.keyBinding.exec(item);
			}
		};

		this.onKey = (e) => {
			let key = "";
			if (e.key.length == 1) {
				if (e.ctrlKey) key += "Ctrl+";
				if (e.shiftKey) key += "Shift+";
				if (e.altKey) key += "Alt+";
				if (e.metaKey) key += "Meta+";
			}

			key += e.key;
			
			if (this.editor.selected) {
				this.bindEditor(key);
			}else{
				this.bind(key);
			}
		}
		addEvent("keydown", this.onKey);
	}
}