class Langague extends Command {
	constructor(e) {
		super(e);

		this.value = 0;
		this.values = [];

		for (let i = 0; i < this.editor.languages.length; i++) {
			this.values.push(this.editor.languages[i].name);
		}

		this.searchTitle = "Select Language";

		this.trees = {
			top: [{ title: "NDL", author: ["most used"] }],
			all: this.generateDicAll(this.values),
		};

		this.onSelect = this.onSelect.bind(this);
	}

	onSelect(title) {
		for (let i = 0; i < this.values.length; i++) {
			if (this.values[i] === title) {
				this.close();
				this.value = i;
				this.editor.fileManager.setLanguage(this.editor.languages[i]);
			}
		}
		this.editor.bottomBar.refresh();
	}

	refresh() {
		if (!this.editor.fileManager.activeFile) return;
		const l = this.editor.fileManager.activeFile.language;

		for (let i = 0; i < this.values.length; i++) {
			if (this.values[i] === l.name) {
				this.value = i;
			}
		}
	}

}
