class FileNode {
    constructor(e, id, name, path) {
        this.editor = e;
        this.id = id;
        this.name = name;
        this.path = path;
        this.isSaved = true;

		this.historyX = undefined;

		this.history = [];
		this.indexHistory = 1;

		this.writerController = new WriterController(this.editor);
		this.lineController = new LineController(this.editor);
		this.selectController = new SelectController(this.editor);
		this.cursor = new Cursor(this.editor);

        this.isEmpty = () => {
            if (this.path) return false;
            return true;
        };

        this.replaceFile = (file) => {
            this.name = file.name;
            this.path = file.path;
            this.isSaved = file.isSaved;

            this.writerController = file.writerController;
            this.lineController = file.lineController;
            this.selectController = file.selectController;
            this.cursor = file.cursor;

            this.historyX = file.historyX;
            this.history = file.history;
            this.indexHistory = file.indexHistory;
        }

        this.loadContent = async () => {
            if (!this.path) {
                this.lineController.loadContent('');
                return;
            }
            let contents = await this.editor.api.getFileContent([this.path]);

            this.content = contents[this.path].toString();
            this.lineController.loadContent(this.content);
        };

        this.save = async () => {
            if (!this.path) this.saveAs();
            else {
                await this.editor.api.saveFile(this.path, this.lineController.getContent());
            }
            this.isSaved = true;
            this.editor.refreshAll();
        };

        this.saveAs = async () => {
            const file = await this.editor.fileManager.selectNewFile();
            if (!file || file.isEmpty()) return;
            this.path = file.path;
            this.name = file.name;
            this.save();
        };

        this.onChange = () => {
            console.log('change');
            this.isSaved = false;
        };
        
        addEvent('onChange', this.onChange);
    }
}