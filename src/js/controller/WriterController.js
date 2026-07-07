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
    if (!this.editor.tabManager.activeFile) return;
    return this.editor.tabManager.activeFile?.insertMode;
  }

  set insertMode(mode) {
    if (!this.editor.tabManager.activeFile) return;

    this.editor.tabManager.activeFile.insertMode = mode;
    if (mode) {
      this.editor.cursor.cD.classList.add("insert-mode");
    } else if (this.editor.cursor.cD.classList.contains("insert-mode")) {
      this.editor.cursor.cD.classList.remove("insert-mode");
    }
  }

  splitWord(txt) {
    if (txt === undefined) return;
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
    if (txt === undefined) return;
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

  textToOBJ(txt) {
    if (txt === undefined) return;
    const words = this.splitWord(txt);
    const lineDiv = document.createElement("div");
    lineDiv.className = "line editor-select";

    const fragment = document.createDocumentFragment();

    for (const word of words) {
      if (word.length > 0) {
        const span = document.createElement("span");
        span.className = "line-word editor-select";
        span.textContent = word;
        fragment.appendChild(span);
      }
    }

    lineDiv.appendChild(fragment);
    return lineDiv;
  }

  write(txt) {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.keyBinding.historyX = undefined;
    this.editor.keyBinding.indexHistory = 1;

    const pos = this.editor.cursor.getCursorReelPosition();
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
      const newX = x + txt.length;
      this.editor.lineController.changeLine(newLine, y - 1);

      this.editor.lineController.refresh();
      this.editor.cursor.setCursorPosition(y, newX);

      this.editor.events.callEvent(Events.ON_CHANGE, {
        action: "insert",
        text: txt,
        beforeRow: y,
        beforeColumn: x,
        afterRow: y,
        afterColumn: newX,
      });

      return;
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
      this.editor.lineController.refresh();
      const lastLineLength = newLines[newLines.length - 1].length;
      this.editor.cursor.setCursorPosition(
        y + newLines.length - 1,
        lastLineLength,
      );

      this.editor.events.callEvent(Events.ON_CHANGE, {
        action: "insert",
        text: txt,
        beforeRow: y,
        beforeColumn: x,
        afterRow: y + newLines.length - 1,
        afterColumn: lastLineLength,
      });
    }
  }

  delete(x, y) {
    if (this.editor.lineController.lines.length == 0) return;
    if (!this.editor.tabManager.activeFile) return;
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
    this.editor.lineController.refresh();

    this.editor.events.callEvent(Events.ON_CHANGE, {
      action: "delete",
      text: line[x - 1] || "",
      beforeRow: cursor.row,
      beforeColumn: cursor.column,
      afterRow: y,
      afterColumn: x,
    });

    return cursor;
  }

  deleteWord(x, y) {
    if (this.editor.lineController.lines.length == 0) return;
    if (!this.editor.tabManager.activeFile) return;
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
    this.editor.lineController.refresh();

    this.editor.events.callEvent(Events.ON_CHANGE, {
      action: "delete",
      text: lastWord || "",
      beforeRow: cursor.row,
      beforeColumn: cursor.column,
      afterRow: y,
      afterColumn: x,
    });

    return cursor;
  }

  deleteSelection() {
    if (this.editor.lineController.lines.length == 0) return;
    if (!this.editor.tabManager.activeFile) return;
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

      let column = this.editor.cursor.columnFromSelectObj(obj) - 1;
      let width = Math.ceil(this.editor.cursor.lengthFromSelectObj(obj));
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
    this.editor.lineController.refresh();

    this.editor.events.callEvent(Events.ON_CHANGE, {
      action: "delete",
      text: rest,
      beforeRow: cursor.row,
      beforeColumn: cursor.column,
      afterRow: cursor.row,
      afterColumn: cursor.column,
    });

    return cursor;
  }

  deleteRange(startRow, startColumn, endRow, endColumn) {
    if (this.editor.lineController.lines.length == 0) return;
    if (!this.editor.tabManager.activeFile) return;

    if (startRow > endRow || (startRow === endRow && startColumn > endColumn)) {
      [startRow, startColumn, endRow, endColumn] = [
        endRow,
        endColumn,
        startRow,
        startColumn,
      ];
    }

    const lines = this.editor.lineController.lines;

    // Calculate deleted text BEFORE modifying lines
    const deletedText =
      startRow === endRow
        ? lines[startRow - 1].slice(startColumn, endColumn)
        : lines.slice(startRow - 1, endRow).join("\n");

    if (startRow === endRow) {
      const line = lines[startRow - 1];
      const newLine = line.slice(0, startColumn) + line.slice(endColumn);
      this.editor.lineController.changeLine(newLine, startRow - 1);
    } else {
      const firstLine = lines[startRow - 1];
      const lastLine = lines[endRow - 1];

      const newFirstLine = firstLine.slice(0, startColumn);
      const newLastLine = lastLine.slice(endColumn);
      const combinedLine = newFirstLine + newLastLine;

      this.editor.lineController.changeLine(combinedLine, startRow - 1);

      for (let i = endRow - 1; i > startRow; i--) {
        this.editor.lineController.supLine(i);
      }
    }

    this.editor.lineController.refresh();

    if (!this.editor.historyController.isHistory) {
      this.editor.events.callEvent(Events.ON_CHANGE, {
        action: "delete",
        text: deletedText,
        beforeRow: startRow,
        beforeColumn: startColumn,
        afterRow: startRow,
        afterColumn: startColumn,
      });
    }

    return { row: startRow, column: startColumn };
  }

  insertTextAt(text, row, column) {
    if (this.editor.lineController.lines.length == 0) return;
    if (!this.editor.tabManager.activeFile) return;

    const lines = this.editor.lineController.lines;
    const lineIndex = row - 1;

    if (!text.includes("\n")) {
      const line = lines[lineIndex];
      const newLine = line.slice(0, column) + text + line.slice(column);
      this.editor.lineController.changeLine(newLine, lineIndex);

      this.editor.lineController.refresh();

      if (!this.editor.historyController.isHistory) {
        this.editor.events.callEvent(Events.ON_CHANGE, {
          action: "insert",
          text: text,
          beforeRow: row,
          beforeColumn: column,
          afterRow: row,
          afterColumn: column + text.length,
        });
      }

      return { row, column: column + text.length };
    } else {
      const newLines = text.split("\n");
      const currentLine = lines[lineIndex];

      const firstPart = currentLine.slice(0, column) + newLines[0];
      this.editor.lineController.changeLine(firstPart, lineIndex);

      for (let i = 1; i < newLines.length - 1; i++) {
        this.editor.lineController.addLine(newLines[i], lineIndex + i - 1);
      }

      const lastPart =
        newLines[newLines.length - 1] + currentLine.slice(column);
      this.editor.lineController.addLine(
        lastPart,
        lineIndex + newLines.length - 2,
      );

      this.editor.lineController.refresh();

      const newRow = row + newLines.length - 1;
      const newColumn =
        newLines[newLines.length - 1].length + currentLine.slice(column).length;

      if (!this.editor.historyController.isHistory) {
        this.editor.events.callEvent(Events.ON_CHANGE, {
          action: "insert",
          text: text,
          beforeRow: row,
          beforeColumn: column,
          afterRow: newRow,
          afterColumn: newColumn,
        });
      }

      return { row: newRow, column: newColumn };
    }
  }
}
