class FileManager {
	constructor(e) {
		this.editor = e;
		this.files = [];   //opened files
		this.folders = [];
		this.activeFile = null;   //file on editor

		this.emptyName = 'New file';

		this.refresh();
	}

	openFile(file) {
		if (!file) return;
		this.openFiles([file]);
	}

	async openFiles(files) {
		for (let file of files) {
			if (this.activeFile && this.activeFile.isEmpty() && !file.isEmpty()) {
				this.activeFile.replaceFile(file);
				this.setFocusFile(this.activeFile);
			} else {
				this.files.push(file);
				this.setFocusFile(file);
			}

			this.activeFile.setIsSaved(true);
			await this.activeFile.loadContent();

			const l = this.editor.languageController.getLanaguage(this.activeFile);
			this.setLanguage(l);
		}
		this.editor.refreshAll();
	}

	closeFiles() {
		this.files = [];
		this.activeFile = undefined;
		this.editor.refreshAll();
	}

	closeFile(id) {
		if (id == this.activeFile.id) {
			if (this.files.length != 1) {
				if (id == 0) this.setFocusFile(this.files[this.files.length - 1]);
				else this.setFocusFile(this.files[id - 1]);
			}
		}

		if (this.files.length != 1) 
			this.files.splice(id, 1);
		else {
			this.closeFiles();
		}
		this.editor.refreshAll();
	}

	closeActiveFile() {
		if (this.activeFile) {
			this.closeFile(this.activeFile.id);
		}
	}

	setFocusFile(file) {
		if (!file) return;
		this.activeFile = file;

		this.editor.cursor.setCursorPosition(file.row, file.column);

		this.editor.refreshAll();
	}

	createEmptyFile() {
		let node = new FileNode(this.editor, this.files.length, this.emptyName, '');
		this.openFile(node);

		return node;
	}

	async selectFile() {
		const file = await this.editor.api.selectFile();
		if (file) {
			let name = file.split('/').pop();
			let node = new FileNode(this.editor, this.files.length, name, file);
			return node;
		}

		return undefined;
	}

	async selectFiles() {
		const files = await this.editor.api.selectFiles();
		let result = [];

		if (files) {
			for (let file of files) {
				let name = file.split('/').pop();
				let node = new FileNode(this.editor, this.files.length, name, file);
				result.push(node);
			}
		}

		return result;
	}

	async selectNewFile() {
		const file = await this.editor.api.selectNewFile(this.emptyName);

		if (file) {
			let name = file.split('/').pop();
			let node = new FileNode(this.editor, this.files.length, name, file);
			return node;
		}

		return undefined;
	}

	toHTMLFile(file) {
		if (!file) return '';
		let arg = '';
		if (this.activeFile && this.activeFile.id === file.id) arg = 'file-active';

		let btn = '';
		if (file.isSaved) btn = '<span class="file-el-btn material-symbols-outlined file-saved">close</span>';
		else btn = '<div class="file-el-btn file-unsaved"></div>';

		let html = `<li class="file-el ${arg}" id="${file.id}">
						<span class="file-el-title">${file.name}</span>
						${btn}
					</li>`;

		return html;
	}

	refresh() {
		let ul = getElement('.file-manager .files-ul');

		let html = '';

		for (let i = 0; i < this.files.length; i++) {
			html += this.toHTMLFile(this.files[i]);
		}

		ul.innerHTML = html;

		addEvent('click', this.onClick.bind(this), getElements('.file-el'));
		addEvent('click', this.onClickClose.bind(this), getElements('.file-el-btn'));

		if (this.files.length == 0) {
			let editor = getElement('.editor-output');
			let selectOutput = getElement('.editor-select-output');
			let lineNumber = getElement('.line-numbers');
			let cursor = getElement('.editor-caret');

			let leftBottomBar = getElement('.bottomBar .left');
			let middleBottomBar = getElement('.bottomBar .middle');
			let rightBottomBar = getElement('.bottomBar .right');
			
			editor.innerHTML = '';
			selectOutput.innerHTML = '';
			lineNumber.innerHTML = '';
			cursor.style.display = 'none';
			leftBottomBar.style.display = 'none';
			middleBottomBar.style.display = 'none';
			rightBottomBar.style.display = 'none';
		}
	}

	onClick(e) {
		let id = e.target.id;
		if (!id && e.target.classList.contains('file-el-title')) {
			id = e.target.parentElement.id;
			if (!id) return;
		}
		let file = this.files[id];
		this.setFocusFile(file);
	}

	onClickClose(e) {
		let id = e.target.parentElement.id;
		if (!id) return;
		this.closeFile(id);
	}

	getTab(id) {
		return getElement(`.file-manager .file-el[id="${id}"]`);
	}

	setLanguage(language) {
		if (this.activeFile) {
			this.activeFile.language = language;
			this.editor.refreshAll();
		}
	}
}