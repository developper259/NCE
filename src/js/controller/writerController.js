class WriterController {
  constructor(e) {
    this.editor = e;
    this.separator = [
      " ",
      "!",
      '"',
      "#",
      "$",
      "%",
      "&",
      "'",
      "(",
      ")",
      "*",
      "+",
      ",",
      "-",
      ".",
      "/",
      ":",
      ";",
      "<",
      "=",
      ">",
      "?",
      "@",
      "[",
      "]",
      "^",
      "`",
      "{",
      "|",
      "}",
      "~",
      "\t",
    ];
  }

  get insertMode() {
    if (!this.editor.fileManager.activeFile) return;
    return this.editor.fileManager.activeFile?.insertMode;
  }

  set insertMode(mode) {
    if (!this.editor.fileManager.activeFile) return;

    this.editor.fileManager.activeFile.insertMode = mode;
    if (mode) {
      this.editor.cursor.cD.classList.add("insert-mode");
    } else if (this.editor.cursor.cD.classList.contains("insert-mode")) {
      this.editor.cursor.cD.classList.remove("insert-mode");
    }
  }

  splitWord(txt) {
    let oldChar = "";
    let tableSplit = [];
    for (let char of txt) {
      if (this.separator.includes(char)) {
        /*if (this.separator.includes(oldChar)) {
					tableSplit[tableSplit.length - 1] += char;
				} else {*/
        tableSplit.push(char);
        //}
      } else {
        if (!tableSplit.length || this.separator.includes(oldChar)) {
          tableSplit.push(char);
        } else {
          tableSplit[tableSplit.length - 1] += char;
        }
      }
      oldChar = char;
    }
    tableSplit = tableSplit.filter(function (chaine) {
      return chaine.length !== 0;
    });

    return tableSplit;
  }

  splitWordView(txt) {
    let oldChar = "";
    let tableSplit = [];
    for (let char of txt) {
      if (this.separator.includes(char)) {
        let c = char.replace(/\t/g, "_".repeat(CONFIG_GET("tab_width")));
        /*if (this.separator.includes(oldChar)) {
					tableSplit[tableSplit.length - 1] += c;
				} else {*/
        tableSplit.push(c);
        //}
      } else {
        if (!tableSplit.length || this.separator.includes(oldChar)) {
          tableSplit.push(char);
        } else {
          tableSplit[tableSplit.length - 1] += char;
        }
      }
      oldChar = char;
    }
    tableSplit = tableSplit.filter(function (chaine) {
      return chaine.length !== 0;
    });

    return tableSplit;
  }

  toHTML(txt, id = "") {
    let resultWords = "";

    let words = this.splitWordView(txt);

    for (let word of words) {
      if (word != "") {
        let classes = "line-word editor-select";
        resultWords += `<span class="${classes}">${word}</span>`;
      }
    }

    let result = `<div class="line editor-select">${resultWords}</div>`;

    return result;
  }

  write(txt) {
    if (!this.editor.fileManager.activeFile) return;
    this.editor.keyBinding.historyX = undefined;
    this.editor.keyBinding.indexHistory = 1;

    const pos = this.editor.cursor.getCursorPositionReverse();
    if (!pos) return;
    let x = pos.column;
    let y = pos.row;

    if (this.editor.selectController.containsSelected) {
      let cursor = this.deleteSelection();
      x = cursor.column;
      y = cursor.row - 1;
    }

    const line = this.editor.lineController.lines[y - 1];

    if (!txt.includes("\n")) {
      if (txt == undefined) newLine = "";

      let newLine;
      if (!this.insertMode || txt.length > 1)
        if (line != undefined)
          newLine = line.slice(0, x) + txt + line.slice(x, line.length);
        else newLine = txt;
      else if (txt.length == 1 && this.insertMode) {
        newLine = line.substring(0, x) + txt + line.substring(x + 1);
      }
      x += txt.length;
      this.editor.lineController.changeLine(newLine, y - 1);
      this.editor.cursor.setCursorPosition(y, x);
    } else {
      let newLines = txt.split("\n");

      for (let i = 0; i < newLines.length; i++) {
        let newLine = newLines[i];
        if (newLine == undefined) newLine = "";

        if (i == 0) {
          newLine = line.slice(0, x) + newLine;
          this.editor.lineController.changeLine(newLine, y - 1);
        } else if (i == newLines.length - 1) {
          newLine = newLine + line.slice(x, line.length);
          this.editor.lineController.addLine(newLine, y + i - 1);
          x = 0;
        } else {
          this.editor.lineController.addLine(newLine, y + i - 1);
        }
      }
      this.editor.cursor.setCursorPosition(y + newLines.length - 1, x);
    }

    CALLEVENT("onChange", {
      beforeRow: y,
      beforeColumn: x,
      afterRow: y,
      afterColumn: x,
    });
    CALLEVENT("onWrite", {
      beforeRow: y,
      beforeColumn: x,
      afterRow: y,
      afterColumn: x,
    });
  }

  delete(x, y) {
    if (!this.editor.fileManager.activeFile) return;
    let newLine = "";
    const line = this.editor.lineController.lines[y - 1];
    let cursor = { column: x, row: y };

    if (cursor.column == 0) {
      if (cursor.row == 1) return;
      cursor.row -= 1;
      cursor.column = this.editor.lineController.lines[cursor.row - 1].length;
      newLine = this.editor.lineController.lines[cursor.row - 1] + line;
      this.editor.lineController.supLine(y - 1);
    } else {
      let Nx = cursor.column - 1;
      newLine = line.slice(0, Nx) + line.slice(cursor.column);
      cursor.column = Nx;
    }

    this.editor.lineController.changeLine(newLine, cursor.row - 1);

    CALLEVENT("onChange", {
      beforeRow: y,
      beforeColumn: x,
      afterRow: cursor.row,
      afterColumn: cursor.column,
    });
    CALLEVENT("onWrite", {
      beforeRow: y,
      beforeColumn: x,
      afterRow: cursor.row,
      afterColumn: cursor.column,
    });

    return cursor;
  }

  deleteWord(x, y) {
    if (!this.editor.fileManager.activeFile) return;
    let cursor = { column: x, row: y };

    const line = this.editor.lineController.lines[y - 1];
    let newLine = "";

    if (cursor.column == 0) {
      if (cursor.row == 1) return;
      cursor.row -= 1;
      cursor.column = this.editor.lineController.lines[cursor.row - 1].length;
      newLine = this.editor.lineController.lines[cursor.row - 1] + line;
      this.editor.lineController.supLine(y);
    } else {
      const words = this.splitWord(line);
      let count = 0;
      let cX = 0;
      let lastWord;

      for (let i = 0; i < words.length; i++) {
        const word = words[i];
        cX = cursor.column - (count + word.length);

        if (cX <= 0) {
          lastWord = word;
          break;
        } else {
          newLine += word;
        }
        count += word.length;
      }

      if (cX != 0) {
        newLine +=
          lastWord.slice(lastWord.length - cX * -1) +
          line.slice(newLine.length + lastWord.length);
        cursor.column -= lastWord.length - cX * -1;
      } else {
        newLine += line.slice(newLine.length + lastWord.length);
        cursor.column -= lastWord.length;
      }
    }
    this.editor.lineController.changeLine(newLine, cursor.row - 1);

    CALLEVENT("onChange", {
      beforeRow: y,
      beforeColumn: x,
      afterRow: cursor.row,
      afterColumn: cursor.column,
    });
    CALLEVENT("onWrite", {
      beforeRow: y,
      beforeColumn: x,
      afterRow: cursor.row,
      afterColumn: cursor.column,
    });

    return cursor;
  }

  deleteSelection() {
    if (!this.editor.fileManager.activeFile) return;
    let objs = this.editor.selectController.getSelectOBJ();
    let cursor = this.editor.cursor.getCursorPosition();
    if (!cursor) return;

    objs.sort((a, b) => {
      let aLine = a.dataset.line;
      let bLine = b.dataset.line;
      return bLine - aLine;
    });

    let rest = "";
    let i = 0;

    for (let obj of objs) {
      let nbLine = parseInt(obj.dataset.line);
      let line = this.editor.lineController.lines[nbLine];
      let column =
        this.editor.cursor.xToColumn(
          parseInt(window.getComputedStyle(obj).left, 10) - this.editor.baseX
        ) - 1;
      let width = Math.ceil(
        parseInt(window.getComputedStyle(obj).width, 10) /
          this.editor.letterSize
      );

      let newLine = line.slice(0, column) + line.slice(column + width);
      if (i != objs.length - 1) {
        if (newLine != "") rest = newLine + rest;
        this.editor.lineController.supLine(nbLine);
      } else {
        this.editor.lineController.changeLine(newLine + rest, nbLine);
        cursor.row = nbLine + 1;
        if (objs.length != 1) cursor.column = newLine.length;
        else cursor.column = column;
      }
      i++;
    }
    this.editor.selectController.unSelectAll();

    CALLEVENT("onChange", {
      beforeRow: cursor.row,
      beforeColumn: cursor.column,
      afterRow: cursor.row,
      afterColumn: cursor.column,
    });
    CALLEVENT("onWrite", {
      beforeRow: cursor.row,
      beforeColumn: cursor.column,
      afterRow: cursor.row,
      afterColumn: cursor.column,
    });

    return cursor;
  }
}
