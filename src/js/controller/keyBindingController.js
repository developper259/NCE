class keyBindingController {
	constructor(e) {
		this.editor = e;
		addEvent("keydown", this.onKey.bind(this));
	}

	bindEditor(key, e) {
		if (CONFIG_KEYBINDING_CONTAINSKEY(key)) {
			this.editor.keyBinding.exec(CONFIG_KEYBINDING_GET_KEY(key), e);
		} else {
			if (e.ctrlKey || e.metaKey) return;
			if (e.key.length == 1) this.editor.writerController.write(e.key);
		}
	}

	bind(key, e) {
		if (CONFIG_KEYBINDING_CONTAINSKEY(key)) {
			let item = CONFIG_KEYBINDING_GET_KEY(key);
			if (item.in_editor == false) {
				this.editor.keyBinding.exec(item, e);
			}
		}
	}

	onKey(e) {
		let key = "";
		if (e.key.length == 1) {
			if (e.ctrlKey) key += "Ctrl+";
			if (e.metaKey) key += "Meta+";
			if (e.shiftKey) key += "Shift+";
			if (e.altKey) key += "Alt+";
		}

		key += e.key;

		if (this.editor.selected) {
			this.bindEditor(key, e);
		} else {
			this.bind(key, e);
		}
	}
}