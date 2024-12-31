class Cursor {
    constructor(e) {
        this.editor = e;
        this._row = undefined;
        this._column = undefined;
        this.mX = 10;
        this.mY = 7;
        this.mpY = 21;
        this.mpX = 10;
        this.leterSize = 12;
        this.cD = document.querySelector(".editor-caret");
    }

    get row() {
        return this.editor.fileManager.activeFile?.row;
    }

    set row(value) {
        if (this.editor.fileManager.activeFile) {
            this.editor.fileManager.activeFile.row = value;
        }
    }

    get column() {
        return this.editor.fileManager.activeFile?.column;
    }

    set column(value) {
        if (this.editor.fileManager.activeFile) {
            this.editor.fileManager.activeFile.column = value;
        }
    }

    rowToY(row) {
        return baseY + posY * row - this.mpY;
    }

    columnToX(column) {
        return baseX + (column - 1) * this.leterSize + 1;
    }

    yToRow(y) {
        return roundY((y - baseY) / posY) + 1;
    }

    xToColumn(x) {
        return roundX((x - baseX) / this.leterSize) + 1;
    }

    onClick(event) {
		if (!this.editor.fileManager.activeFile) return;
        const x = event.clientX - this.editor.output.getBoundingClientRect().left - this.mX;
        const y = event.clientY - this.editor.output.getBoundingClientRect().top - this.mY;

        let row = this.yToRow(y);
        let column = this.xToColumn(x);

        if (row <= 0) row = 1;
        if (row > this.editor.lineController.maxIndex) {
            row = this.editor.lineController.maxIndex;
        }

        const line = this.editor.lineController.lines[row - 1];
        const lineLength = line.length + (getOccurrence('\t', line) * CONFIG_GET('tab_width')) - getOccurrence('\t', line);
        if (column > lineLength) column = lineLength;

        if (this.row !== row || this.column !== column) {
            CALLEVENT("cursormove", { row, column });
        }

        this.row = row;
        this.column = column;

        this.setCursorPosition(this.row, this.column);
    }

    setCursorPosition(row, column) {
		if (!this.editor.fileManager.activeFile) return;
        if (row <= 0) row = 1;
        if (row > this.editor.lineController.maxIndex) {
            row = this.editor.lineController.maxIndex;
        }

        const line = this.editor.lineController.lines[row - 1];
        let lineLength = 0;
        if (line) {
            lineLength = this.editor.lineController.getLineLength(row - 1);
        }

        if (column > lineLength) {
            column = lineLength;
        }

        if (line.includes('\t')) {
            let i = 0;
            for (let c of line) {
                if (c === '\t') {
                    if (column > i && column < (i + CONFIG_GET('tab_width'))) {
                        column = ((column - i) / CONFIG_GET('tab_width')) >= 0.5 ? i + CONFIG_GET('tab_width') : i;
                        break;
                    } else {
                        i += CONFIG_GET('tab_width');
                    }
                } else {
                    i++;
                }
            }
        }

        const placeY = this.rowToY(row) - 4;
        const placeX = this.columnToX(column);

        this.cD.style.display = 'block';
        this.cD.style.left = `${placeX}px`;
        this.cD.style.top = `${placeY}px`;

        this.row = row;
        this.column = column;

        this.editor.lineController.setFocusLine(this.row);
        CALLEVENT("cursorchange", { row, column });

        this.editor.selected = true;
    }

    getCursorPosition() {
        return [this.row, this.column];
    }

    getBeforeLetter() {
        const line = this.editor.lineController.lines[this.row - 1];
        return line[this.column];
    }

    getAfterLetter() {
        const line = this.editor.lineController.lines[this.row - 1];
        return line[this.column + 1];
    }

    getLine() {
        return this.editor.lineController.lines[this.row - 1];
    }

    getBeforeLine() {
        return this.editor.lineController.lines[this.row - 2];
    }

    getAfterLine() {
        return this.editor.lineController.lines[this.row];
    }

    getIndexWord() {
        const line = this.editor.lineController.lines[this.row - 1];
        const words = this.editor.writerController.splitWord(line);
        let count = 0;

        for (let i = 0; i < words.length; i++) {
            const word = words[i];
            count += word.length;
            if (this.column - count <= 0) return i;
        }
    }

    getWord() {
        const line = this.editor.lineController.lines[this.row - 1];
        const words = this.editor.writerController.splitWord(line);
        return words[this.getIndexWord()];
    }

    getBeforeWord() {
        const line = this.editor.lineController.lines[this.row - 1];
        const words = this.editor.writerController.splitWord(line);
        return words[this.getIndexWord() - 1];
    }

    getAfterWord() {
        const line = this.editor.lineController.lines[this.row - 1];
        const words = this.editor.writerController.splitWord(line);
        return words[this.getIndexWord() + 1];
    }
}
