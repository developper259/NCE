class FileManager {
	constructor(e) {
		this.editor = e;
		this.files = [];   //opened files
    	this.folders = [];
		this.activeFile = null;   //file on editor

		this.emptyName = 'New file';

		this.openFile = (file) => {
			if (!file) return;
			this.openFiles([file]);
		};

    	this.openFiles = async (files) => {
			for (let file of files) {
				await file.loadContent();

				if (this.activeFile && this.activeFile.isEmpty() && !file.isEmpty()) {
					this.activeFile.replaceFile(file);
					this.setFocusFile(this.activeFile);
				} else {
					this.files.push(file);
					this.setFocusFile(file);
				}
			}
			this.editor.refreshAll();
    	};

		this.closeFiles = () => {
			this.files = [];
			this.editor.refreshAll();
		};

		this.closeFile = (id) => {
			if (id == this.activeFile.id) {
				if (this.files.length != 1) {
					if (id == 0) this.setFocusFile(this.files[this.files.length - 1]);
					else this.setFocusFile(this.files[id - 1]);
				}
			}

			if (this.files.length != 1) 
				this.files.splice(id, 1);
			else {
				this.files = [];
				this.activeFile = null;

				this.editor.writerController = null;
				this.editor.lineController = null;
				this.editor.selectController = null;
				this.editor.cursor = null;
			}
			this.editor.refreshAll();
		};

		this.closeActiveFile = () => {
			if (this.activeFile) {
				this.closeFile(this.activeFile.id);
			}
		};

		this.setFocusFile = (file) => {
			if (!file) return;
			this.activeFile = file;

			this.editor.writerController = this.activeFile.writerController;
			this.editor.lineController = this.activeFile.lineController;
			this.editor.selectController = this.activeFile.selectController;
			this.editor.cursor = this.activeFile.cursor;

			this.editor.cursor.setCursorPosition(this.editor.cursor.row, this.editor.cursor.column);

			this.editor.refreshAll();
		};

		this.createEmptyFile = () => {
			let node = new FileNode(this.editor, this.files.length, this.emptyName, '');
			this.openFile(node);

			return node;
		};

    	this.selectFile = async () => {
     	   const file = await this.editor.api.selectFile();
			if (file) {
				let name = file.split('/').pop();
				let node = new FileNode(this.editor, this.files.length, name, file);
				return node;
			}

    	    return undefined;
    	};

		this.selectFiles = async () => {
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
    	};

		this.selectNewFile = async () => {
     	   	const file = await this.editor.api.selectNewFile(this.emptyName);

			if (file) {
				let name = file.split('/').pop();
				let node = new FileNode(this.editor, this.files.length, name, file);
				return node
			}

    	    return undefined;
    	};

    	this.toHTMLFile = (file) => {
			if (!file) return '';
			let arg = '';
			if (this.activeFile && this.activeFile.id === file.id) arg = 'file-active';

 			let html = `<li class="file-el ${arg}" id="${file.id}">
							<span class="file-el-title">${file.name}</span>
							<div class="file-el-btn material-symbols-outlined">close</div>
						</li>`;

			return html;
    	};

    	this.refresh = () => {
			let ul = getElement('.file-manager .files-ul');

			let html = '';

			for (let i = 0; i < this.files.length; i++) {
				html += this.toHTMLFile(this.files[i]);
			}

			ul.innerHTML = html;

			addEvent('click', this.onClick, getElements('.file-el'));
			addEvent('click', this.onClickClose, getElements('.file-el-btn'));

			if (this.files.length == 0) {
				let editor = getElement('.editor-output');
				let selectOutput = getElement('.editor-select-output');
				let lineNumber = getElement('.line-numbers');
				let cursor = getElement('.editor-caret');
				
				editor.innerHTML = '';
				selectOutput.innerHTML = '';
				lineNumber.innerHTML = '';
				cursor.style.display = 'none';
			}
		};

		this.onClick = (e) => {
			let id = e.target.id;
			if (!id && e.target.classList.contains('file-el-title')) {
				id = e.target.parentElement.id;
				if (!id) return;
			}
			let file = this.files[id];
			this.setFocusFile(file);
		};

		this.onClickClose = (e) => {
			let id = e.target.parentElement.id;
			if (!id) return;
			this.closeFile(id);
		};

		this.refresh();
  	};
}