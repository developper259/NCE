roundY = (nb) => {
	var r = nb;
	while (nb > 1) {
		nb--;
	}
	r -= nb;
	if (nb >= 0.65) nb = 1;
	else nb = 0;

	return r + nb;
};

roundX = (nb) => {
	if (nb < 0) return -1;
	if (nb < 1) return 0;
	var r = nb;
	while (nb > 1) {
		nb--;
	}
	r -= nb;
	if (nb >= 0.65) nb = 1;
	else nb = 0;

	return r + nb;
};

getElement = (str) => {
	return document.querySelector(str);
};

getElements = (str) => {
	return nodeToArray(document.querySelectorAll(str));
};

nodeToArray = (node) => {
	let r = [];

	for (let n of node) {
		r.push(n);
	}

	return r;
};

getOccurrence = (c, str) => {
	return str.split(c).length - 1;
};

class Editor {
	constructor() {
		this.output = document.querySelector(".editor-output");

		this.selected = false;
		this.panel = undefined;

		this.languages = [
            new PlainText(this),
            new Javascript(this),
        ];

		this.api = window.api;

		this.writerController = new WriterController(this);
		this.lineController = new LineController(this);
		this.selectController = new SelectController(this);
		this.keyBindingController = new keyBindingController(this);
		this.languageController = new LanguageController(this);

		this.fileManager = new FileManager(this);

		this.keyBinding = new KeyBinding(this);
		this.cursor = new Cursor(this);

		this.command = new Command(this);
		this.Ccmd = new CMD(this);
		this.Clangague = new Langague(this);
		this.Cconfig_space = new Config_space(this);
		this.bottomBar = new BottomBar(this);

		this.test = new Test(this);

		addEvent("click", this.onClick.bind(this), document);
	}

	refreshAll() {
		this.bottomBar.refresh();
		if (this.lineController) this.lineController.refresh();
		if (this.selectController) this.selectController.refreshStartEndSelect();
		this.fileManager.refresh();
		if (this.fileManager.activeFile) this.fileManager.activeFile.language.refreshAll();
	}

	onClick(e) {
		const t = e.target;
		const c = t.classList;
		if (c.contains("editor-select") || c.contains("editor-el") || c.contains("editor")) {
			this.selected = true;
			CALLEVENT("cursorenabled");
		} else {
			if (c.contains("command-el") || c.contains("command-el-title")) return;
			this.selected = false;
			CALLEVENT("cursordisabled");
		}
	}
}

var editor = null;

window.addEventListener("load", (event) => {
	editor = new Editor();
});
