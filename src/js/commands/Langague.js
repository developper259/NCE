class Langague extends Command {
	constructor(e) {
		super(e);

		this.value = 0;
		this.values = ["HTML", "CSS", "JavaScript", "Java", "NDL", "Python"];

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
			}
		}
		this.editor.bottomBar.refresh();
	}

}
