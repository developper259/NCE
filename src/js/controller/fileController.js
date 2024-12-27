class FileController {
  constructor(e) {
    this.editor = e;

    this.openFiles = async (files) => {
        let contents = await this.getFileContents(files);

        for (const [key, value] of Object.entries(contents)) {
          this.editor.lineController.lines = value.split('\n');
          this.editor.lineController.refresh();
          this.editor.cursor.setCursorPosition(1, 0);
        }
    };

    this.getFileContents = async (file) => {
        let contents = await this.editor.api.getFileContent(file);
        let result = {};

        for (const [key, value] of Object.entries(contents)) {
            let name = key.split('/').pop();
            result[name] = value.toString();
        }

        console.log(result);

        return result;
    }

    this.selectFiles = async () => {
        let file = await this.editor.api.selectFile();

        return file;
    };
  }
}