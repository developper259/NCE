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

nodeToArray = (node) => {
	let r = [];

	for (let n of node) {
		r.push(n);
	}

	return r;

};

getElements = (str) => {
	return nodeToArray(document.querySelectorAll(str));
};

getOccurrence = (c, str) => {
	return str.split(c).length - 1;
};

class Editor {
	constructor() {
		this.output = document.querySelector(".editor-output");
		this.writerController = new WriterController(this);
		this.lineController = new lineController(this);
		this.selectController = new SelectController(this);
		this.keyBindingController = new keyBindingController(this);

		this.keyBinding = new KeyBinding(this);
		this.cursor = new Cursor(this);

		this.command = new Command(this);
		this.Ccmd = new CMD(this);
		this.Clangague = new Langague(this);
		this.Cconfig_space = new Config_space(this);
		this.bottomBar = new BottomBar(this);

		this.test = new Test(this);


		this.selected = false;
		this.panel = undefined;

		this.cursor.setCursorPosition(1, 0);

		addEvent("click", this.onClick.bind(this), document);
	}
	onClick(e) {
		const t = e.target;
		const c = t.classList;
		if (c.contains("editor-select") || c.contains("editor-el") || c.contains("editor")) {
			this.selected = true;
			this.output.dispatchEvent(new CustomEvent("cursorenabled"));
		} else {
			this.selected = false;
			this.lineController.setFocusLine(0);
			this.output.dispatchEvent(new CustomEvent("cursordisabled"));
		}
	}
}

var editor = null;

window.addEventListener("load", (event) => {
	editor = new Editor();
});
