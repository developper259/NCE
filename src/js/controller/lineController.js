class LineController {
    constructor(editor) {
        this.editor = editor;
        this.maxViewLine = 36;           // 34 + marge
        this.maxCharactersPerLine = 130; // 102 + marge
    }

    // Getters et Setters
    get lines() {
		if (!this.editor.fileManager.activeFile) return;
        return this.editor.fileManager.activeFile?.lines;
    }

    set lines(value) {
		if (!this.editor.fileManager.activeFile) return;
        this.editor.fileManager.activeFile.lines = value;
    }

    get maxIndex() {
		if (!this.editor.fileManager.activeFile) return;
        return this.editor.fileManager.activeFile?.maxIndex;
    }

    set maxIndex(value) {
		if (!this.editor.fileManager.activeFile) return;
        this.editor.fileManager.activeFile.maxIndex = value;
    }

    get index() {
		if (!this.editor.fileManager.activeFile) return;
        return this.editor.fileManager.activeFile?.index;
    }

    set index(value) {
		if (!this.editor.fileManager.activeFile) return;
        this.editor.fileManager.activeFile.index = value;
    }

    // Méthodes
    loadContent(content) {
        this.lines = content.split("\n");
        this.maxIndex = this.lines.length;
    }

    getContent() {
        return this.lines?.join("\n") || "";
    }

    getLineLength(i) {
        if (i < 0 || i >= this.lines?.length || !this.lines[i]) return 0;
        return this.lines[i].length + (getOccurrence('\t', this.lines[i]) * CONFIG_GET('tab_width')) - getOccurrence('\t', this.lines[i]);
    }
    getTextLength(text) {
        return text.length + (getOccurrence('\t', text) * CONFIG_GET('tab_width')) - getOccurrence('\t', text);
    }

    sliceLine(index, posA, posB) {
        let r = "";

        if (posB === undefined) posB = this.getLineLength(index);

        for (let i = 0; i < posB; i++) {
            const c = this.getLetter(index, i);

            if (posA <= i && i < posB) {
                r += c;
            }
            if (c === '\t') i += CONFIG_GET('tab_width') - 1;
        }

        return r;
    }

    sliceText(text, posA, posB) {
        let r = "";

        if (posB === undefined) posB = this.getTextLength(text);

        for (let i = 0; i < text.length; i++) {
            const c = this.getLetterText(text, i);

            if (posA <= i && i < posB) {
                r += c;
            }
            if (c === '\t') i += CONFIG_GET('tab_width') - 1;
        }

        return r;
    }

    getLetter(y, index) {
        let line = this.lines[y];
        let i = 0;

        if (!line || index >= line.length) return '';

        for (let c of line) {
            if (c === '\t') {
                if (i <= index && index < (i + CONFIG_GET('tab_width'))) {
                    return c;
                } else i += CONFIG_GET('tab_width');
            } else {
                if (i === index) return c;
                else i++;
            }
        }
        return undefined;
    }

    getLetterText(text, index) {
        let i = 0;
        if (!text || index >= text.length) return '';

        for (let c of text) {
            if (c === '\t') {
                if (i <= index && index < (i + CONFIG_GET('tab_width'))) {
                    return c;
                } else i += CONFIG_GET('tab_width');
            } else {
                if (i === index) return c;
                else i++;
            }
        }
        return undefined;
    }

    getViewContent() {
        let scrollY = 1;
        let scrollX = 1;

        const endY = this.maxViewLine * scrollY;
        const endX = this.maxCharactersPerLine * scrollX;

        const startY = endY - this.maxViewLine;
        const startX = endX - this.maxCharactersPerLine;

        let lines = [];

        for (let i = startY; i <= endY; i++) {
            let line = this.sliceLine(i, startX, endX);
            lines.push(line);
        }
        return lines;
    }

    getViewNumberLines() {
        let scrollY = 1;

        const endY = this.maxViewLine * scrollY;
        const startY = endY - this.maxViewLine;

        let lines = []

        for (let i = startY; i <= endY; i++) {
            if (i > this.maxIndex - 1) break;
            lines.push(i+1);
        }

        return lines;
    }

    setFocusLine(index) {
        const oldLine = document.querySelector(".line-selected");

        if (oldLine != null) oldLine.classList.remove("line-selected");

        const newLine = this.getLineNumberOBJ(index - 1);

        if (newLine == null) return;

        newLine.classList.add("line-selected");
        this.index = index;
    }

    addLine(txt, index) {
        this.lines = [
            ...this.lines.slice(0, index),
            txt,
            ...this.lines.slice(index)
        ];

        this.refresh();

        CALLEVENT('onChange');
    }

    changeLine(txt, index) {
        this.lines[index] = txt;

        this.refresh();

        CALLEVENT('onChange');
    }

    supLine(index) {
        if (index > this.maxIndex) return;
        this.maxIndex -= 1;
        this.lines.splice(index, 1);

        this.refresh();

        CALLEVENT('onChange');
    }

    refreshLine() {
		if (!this.editor.fileManager.activeFile) return;

        if (this.lines.length !== this.maxIndex) this.maxIndex = this.lines.length;

        const lines = this.getViewContent();

        this.editor.output.innerHTML = "";
        for (let i = 0; i < lines.length; i++) {
            let lineOBJ = this.createLineOBJ(lines[i]);

            this.editor.output.appendChild(lineOBJ);

            const x = this.editor.baseX;
            const y = this.editor.baseY + this.editor.posY * i;

            lineOBJ.style.position = "absolute";
            lineOBJ.style.top = y + "px";
            lineOBJ.style.left = x + "px";
        }
        if (this.lines.length === 0)
            this.editor.output.innerHTML = '<div class="line editor-select"></div>';
    }

    refreshNumberLines() {
		if (!this.editor.fileManager.activeFile) return;
        const lineN = document.querySelector(".line-numbers");
        let linesN = lineN.querySelectorAll(".line-el");

        if (this.index === 0) this.index = this.editor.cursor.row;
        if (this.maxIndex === 0) this.maxIndex = this.lines.length;
        if (this.maxIndex === 0) this.maxIndex = 1;

        if (this.maxIndex !== linesN.length) {
            let innerHTML = '';

            const l = this.getViewNumberLines();

            for (let i = 0; i < l.length; i++) innerHTML += `<span class="line-el editor-el">${l[i]}</span>`;
            
            lineN.innerHTML = innerHTML;

            linesN = lineN.querySelectorAll(".line-el");

            for (let i = 0; i < linesN.length; i++) {
                const line = linesN[i];

                const y = this.editor.baseY + this.editor.posY * i;
                line.style.top = y + "px";

                line.addEventListener("click", () => {
                    let lineOBJ = this.editor.selectController.getSelectOBJLine(i);
                    this.editor.selectController.unSelectAll();

                    if (lineOBJ === undefined) this.editor.selectController.selectLine(i, true);
                    else this.editor.cursor.setCursorPosition(i + 1, 0);
                });
            }
        }
        this.setFocusLine(this.index);
    }

    createLineOBJ(line) {
        let parser = new DOMParser();

        let doc = parser.parseFromString(
            this.editor.writerController.toHTML(line),
            "text/html",
        );

        return doc
            .createRange()
            .createContextualFragment(doc.body.innerHTML).firstElementChild;
    }

    getLineOBJ(index) {
        const lines = document.querySelectorAll(".editor-output .line");
        if (!lines) return;
        return lines[index];
    }

    getLineNumberOBJ(index) {
        const lines = document.querySelectorAll(".line-el");
        if (!lines) return;
        return lines[index];
    }

    getWordsOBJ(row) {
        if (row == null) return;
        const l = getElements(".line")[row - 1];
        if (!l) return;
        const words = l.querySelectorAll(".line-word");
        return words;
    }

    getWordOBJ(row, column) {
        if (row == null || column == null) return;
        const l = getElements(".line")[row - 1];
        if (!l) return;
        const words = l.querySelectorAll(".line-word");
        return words[column];
    }

    getLetterOBJ(row, column) {
        if (row == null || column == null) return;
        const l = getElements(".line")[row - 1];
        if (!l) return;
        const letters = l.querySelectorAll(".line-letter");
        return letters[column];
    }

    refresh() {
        this.refreshLine();
        this.refreshNumberLines();
    }
}
