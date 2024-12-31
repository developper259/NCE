class CMD extends Command {
	constructor(e) {
		super(e);

		this.values = ["save file", "open file", "close file"];
		this.actionValue = ["save", "open_file", "close_file"];

		this.trees = {
			top: [],
			all: this.generateDicAll(this.values),
		};
	}

	onSelect(title) {
		for (let i = 0; i < this.values.length; i++) {
			if (this.values[i] === title) {
				this.close();
				this.editor.keyBinding.exec(this.actionValue[i], null);
			}
		}
	}
}
