class FileNode {
    constructor(e, id, name, path) {
        this.editor = e;
        this.id = id;
        this.name = name;
        this.path = path;
        this.content = '';

        this.loadContent = async () => {
            let contents = await this.editor.api.getFileContent([this.path]);
    
            this.content = contents[this.name].toString();

            console.log(this.content);
        };

        this.save = async () => {
        };
    }
}