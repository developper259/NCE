class Config_space extends Command {
	constructor(e) {
		super(e);

		this.value = CONFIG_GET('tab_width') - 1;
		this.values = ["Spaces: 1", "Spaces: 2", "Spaces: 3", "Spaces: 4", "Spaces: 5", "Spaces: 6", "Spaces: 7", "Spaces: 8"];
		this.realValues = [1, 2, 3, 4, 5, 6, 7, 8];

		this.trees = {
			top: [{ title: this.values[this.value], author: ["currently used"] }],
			all: this.generateDicAll(this.values),
		};
	}

	onSelect(title) {
		for (let i = 0; i < this.values.length; i++) {
			if (this.values[i] === title) {
				this.close();
				this.value = i;
				CONFIG_SET('tab_width', this.realValues[i]);
			}
		}
		this.trees.top[0].title = this.values[this.value];
		this.editor.bottomBar.refresh();
		this.editor.lineController.refresh();
	}
}
