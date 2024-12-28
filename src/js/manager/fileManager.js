class FileManager {
	constructor(e) {
		this.editor = e;
		this.files = [];   //opened files
    	this.folders = [];
		this.activeFile = null;   //file on editor

    	this.openFiles = async (files) => {
			for (let file of files) {
				this.files.push(file);
				this.selectFile(file);
			}
			this.refresh();
    	};

		this.closeFiles = () => {
			this.files = [];
			this.refresh();
		};

		this.closeFile = (id) => {
			if (!id) return;
			if (id == this.activeFile.id) {
				if (id == 0) this.activeFile = this.files[this.files.length - 1];
				else this.activeFile = this.files[id - 1];
			}
			if (this.files.length != 1) 
				this.files.splice(id, 1);
			else {
				this.files = [];
				this.activeFile = null;
			}
			this.refresh();
		};

		this.closeActiveFile = () => {
			if (this.activeFile) {
				this.closeFile(this.activeFile.id);
			}
		};

		this.selectFile = (file) => {
			if (!file) return;
			if (this.activeFile && this.activeFile.id == file.id) return;
			this.activeFile = file;
			this.refresh();
		};

		this.createEmptyFile = () => {
			let name = 'new file';
			let node = new FileNode(this.editor, this.files.length, name, '');
			this.openFiles([node]);

			return node;
		};

    	this.selectFiles = async () => {
     	   const files = await this.editor.api.selectFile();
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

    	this.loadFile = (file) => {

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
		};

		this.onClick = (e) => {
			let id = e.target.id;
			if (!id && e.target.classList.contains('file-el-title')) {
				id = e.target.parentElement.id;
				if (!id) return;
			}
			let file = this.files[id];
			this.selectFile(file);
		};

		this.onClickClose = (e) => {
			let id = e.target.parentElement.id;
			if (!id) return;
			this.closeFile(id);
		};

		this.refresh();
  	};
}