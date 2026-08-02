class WriterController {
  constructor(e) {
    this.editor = e;
    this.separator = [
      " ",
      "!",
      '"',
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
    if (!this.editor.tabManager.activeFile) return false;
    return this.editor.tabManager.activeFile.insertMode;
  }

  set insertMode(mode) {
    if (!this.editor.tabManager.activeFile) return;

    this.editor.tabManager.activeFile.insertMode = mode;
    if (mode) {
      this.editor.cD.classList.add("insert-mode");
    } else {
      this.editor.cD.classList.remove("insert-mode");
    }
  }

  splitWord(txt) {
    if (txt === undefined) return [];
    let oldChar = "";
    let tableSplit = [];

    for (let char of txt) {
      if (this.separator.includes(char)) {
        tableSplit.push(char);
      } else {
        if (!tableSplit.length || this.separator.includes(oldChar)) {
          tableSplit.push(char);
        } else {
          tableSplit[tableSplit.length - 1] += char;
        }
      }
      oldChar = char;
    }

    return tableSplit.filter((chaine) => chaine.length !== 0);
  }

  splitWordView(txt) {
    if (txt === undefined) return [];
    let oldChar = "";
    let tableSplit = [];

    for (let char of txt) {
      if (this.separator.includes(char)) {
        let c = char.replace(/\t/g, " ".repeat(CONFIG_GET("tab_width")));
        tableSplit.push(c);
      } else {
        if (!tableSplit.length || this.separator.includes(oldChar)) {
          tableSplit.push(char);
        } else {
          tableSplit[tableSplit.length - 1] += char;
        }
      }
      oldChar = char;
    }

    return tableSplit.filter((chaine) => chaine.length !== 0);
  }

  textToOBJ(txt, screenIndex) {
    if (txt === undefined) return;

    const words = this.splitWordView(txt);
    const lineDiv = document.createElement("div");
    lineDiv.className = "line editor-select";

    const fragment = document.createDocumentFragment();

    const row = screenIndex + this.editor.lineController.startIndex;
    const lineNode = this.editor.lineController.lines[row];
    const tokens = lineNode ? lineNode.getTokens() : null;

    let { i, a, maxA } = this.editor.highlightController.getStartTokenDetails(
      tokens,
      this.editor.lineController.offsetX,
    );

    for (const word of words) {
      if (word.length > 0) {
        let c = "";
        let token = null;

        const isContentWord = word.trim().length !== 0 && word !== "\t";

        if (tokens) {
          token = tokens[i];
          if (token && isContentWord) {
            c = token.type;
          }
        }

        const span = document.createElement("span");
        span.className = `line-word editor-select ${c}`;
        span.textContent = word;
        fragment.appendChild(span);

        if (tokens && isContentWord) {
          if (token && token.value) {
            maxA = this.editor.highlightController.splitValidWord(
              token.value,
            ).length;
          }
          a++;

          if (a === maxA) {
            i++;
            maxA = 0;
            a = 0;
          }
        }
      }
    }

    lineDiv.appendChild(fragment);
    return lineDiv;
  }

  write(txt) {
    if (!this.editor.tabManager.activeFile || txt === undefined) return;
    this.editor.keyBinding.historyX = undefined;

    const lc = this.editor.lineController;
    let row = this.editor.cursor.row;
    let column = this.editor.cursor.column;

    if (this.editor.selectController.containsSelected) {
      const newPos = this.deleteSelection();
      if (newPos) {
        row = newPos.row;
        column = newPos.column;
      }
    }

    const lineNode = lc.lines[row - 1];
    const line = lineNode ? lineNode.getText() : "";

    if (!txt.includes("\n")) {
      let newLine;

      if (!this.insertMode || txt.length > 1) {
        newLine = line.slice(0, column) + txt + line.slice(column);
      } else if (txt.length === 1 && this.insertMode) {
        newLine = line.substring(0, column) + txt + line.substring(column + 1);
      }

      const newColumn = column + txt.length;
      lc.changeLine(newLine, row - 1);
      lc.refresh();

      this.editor.cursor.setCursorPosition(row, newColumn);

      this.editor.events.callEvent(Events.ON_CHANGE, {
        action: "insert",
        text: txt,
        beforeRow: row,
        beforeColumn: column,
        afterRow: row,
        afterColumn: newColumn,
      });

      return;
    }

    let newLines = txt.split("\n");

    for (let i = 0; i < newLines.length; i++) {
      let currentNewLine = newLines[i] || "";

      if (i === 0) {
        currentNewLine = line.slice(0, column) + currentNewLine;
        lc.changeLine(currentNewLine, row - 1);
      } else if (i === newLines.length - 1) {
        currentNewLine = currentNewLine + line.slice(column);
        lc.addLine(currentNewLine, row + i - 1);
        column = 0;
      } else {
        lc.addLine(currentNewLine, row + i - 1);
      }
    }

    lc.refresh();

    const lastLineLength = newLines[newLines.length - 1].length;
    const endRow = row + newLines.length - 1;

    this.editor.cursor.setCursorPosition(endRow, lastLineLength);

    const screenRow = row - lc.startIndex;
    if (screenRow >= lc.maxLines - lc.marginLines) {
      const targetRow = lc.startIndex + newLines.length;
      lc.scrollTo(targetRow);
    }

    this.editor.events.callEvent(Events.ON_CHANGE, {
      action: "insert",
      text: txt,
      beforeRow: row,
      beforeColumn: column,
      afterRow: endRow,
      afterColumn: lastLineLength,
    });
  }

  delete(column, row) {
    if (
      !this.editor.tabManager.activeFile ||
      this.editor.lineController.lines.length === 0
    )
      return;

    let newLine = "";
    const lineNode = this.editor.lineController.lines[row - 1];
    const line = lineNode.getText();
    let cursor = { column, row };
    let deletedChar = "";

    if (cursor.column === 0) {
      if (cursor.row === 1) return;

      cursor.row -= 1;
      const prevLineNode = this.editor.lineController.lines[cursor.row - 1];
      const prevLine = prevLineNode.getText();

      cursor.column = prevLine.length;
      newLine = prevLine + line;
      deletedChar = "\n";
      this.editor.lineController.supLine(row - 1);
    } else {
      let newCol = cursor.column - 1;
      deletedChar = line[newCol] || "";
      newLine = line.slice(0, newCol) + line.slice(cursor.column);
      cursor.column = newCol;
    }

    this.editor.lineController.changeLine(newLine, cursor.row - 1);
    this.editor.lineController.refresh();

    this.editor.events.callEvent(Events.ON_CHANGE, {
      action: "delete",
      text: deletedChar,
      beforeRow: row,
      beforeColumn: column,
      afterRow: cursor.row,
      afterColumn: cursor.column,
    });

    return cursor;
  }

  deleteWord(column, row) {
    if (
      !this.editor.tabManager.activeFile ||
      this.editor.lineController.lines.length === 0
    )
      return;

    let cursor = { column, row };
    const lineNode = this.editor.lineController.lines[row - 1];
    const line = lineNode.getText();
    let newLine = "";
    let deletedText = "";

    if (cursor.column === 0) {
      return this.delete(column, row);
    } else {
      const words = this.splitWord(line);
      let charCount = 0;
      let remainingDist = 0;
      let lastWord = "";

      for (let i = 0; i < words.length; i++) {
        const word = words[i];
        remainingDist = cursor.column - (charCount + word.length);

        if (remainingDist <= 0) {
          lastWord = word;
          break;
        } else {
          newLine += word;
        }
        charCount += word.length;
      }

      if (remainingDist !== 0) {
        const sliceIndex = lastWord.length + remainingDist;
        deletedText = lastWord.slice(0, sliceIndex);
        newLine +=
          lastWord.slice(sliceIndex) +
          line.slice(newLine.length + lastWord.length);
        cursor.column -= deletedText.length;
      } else {
        deletedText = lastWord;
        newLine += line.slice(newLine.length + lastWord.length);
        cursor.column -= lastWord.length;
      }
    }

    this.editor.lineController.changeLine(newLine, cursor.row - 1);
    this.editor.lineController.refresh();

    this.editor.events.callEvent(Events.ON_CHANGE, {
      action: "delete",
      text: deletedText,
      beforeRow: row,
      beforeColumn: column,
      afterRow: cursor.row,
      afterColumn: cursor.column,
    });

    return cursor;
  }

  deleteSelection() {
    const selectCtrl = this.editor.selectController;
    const cursor = this.editor.cursor;

    if (!selectCtrl || !selectCtrl.containsSelected) return null;

    let start = selectCtrl.startSelect;
    let end = { row: cursor.row, column: cursor.column };

    if (
      start.row > end.row ||
      (start.row === end.row && start.column > end.column)
    ) {
      [start, end] = [end, start];
    }

    const newCursor = this.deleteRange(start, end);

    selectCtrl.unSelectAll();

    return newCursor;
  }

  deleteRange(start, end) {
    if (!this.editor.tabManager.activeFile) return;
    const lc = this.editor.lineController;
    if (!lc || lc.lines.length === 0) return;

    const startRow = Math.max(0, start.row - 1);
    const endRow = Math.max(0, end.row - 1);

    const startLineNode = lc.lines[startRow];
    const endLineNode = lc.lines[endRow];

    if (!startLineNode || !endLineNode) return;

    let startText = startLineNode.getText();
    let endText = endLineNode.getText();

    let newRow = start.row;
    let newCol = start.column;

    if (startRow === endRow) {
      const newLineText =
        startText.slice(0, start.column) + endText.slice(end.column);
      lc.changeLine(newLineText, startRow);
    } else {
      const newLineText =
        startText.slice(0, start.column) + endText.slice(end.column);
      lc.changeLine(newLineText, startRow);

      for (let i = endRow; i > startRow; i--) {
        lc.supLine(i);
      }
    }

    return { row: newRow, column: newCol };
  }

  insertTextAt(text, row, column) {
    if (
      !this.editor.tabManager.activeFile ||
      this.editor.lineController.lines.length === 0
    )
      return;

    const lines = this.editor.lineController.lines;
    const lineIndex = row - 1;

    if (!text.includes("\n")) {
      const lineNode = lines[lineIndex];
      const line = lineNode.getText();
      const newLine = line.slice(0, column) + text + line.slice(column);

      this.editor.lineController.changeLine(newLine, lineIndex);
      this.editor.lineController.refresh();

      this.editor.events.callEvent(Events.ON_CHANGE, {
        action: "insert",
        text: text,
        beforeRow: row,
        beforeColumn: column,
        afterRow: row,
        afterColumn: column + text.length,
      });

      return { row, column: column + text.length };
    } else {
      const newLines = text.split("\n");
      const currentLineNode = lines[lineIndex];
      const currentLine = currentLineNode.getText();

      const firstPart = currentLine.slice(0, column) + newLines[0];
      this.editor.lineController.changeLine(firstPart, lineIndex);

      for (let i = 1; i < newLines.length - 1; i++) {
        this.editor.lineController.addLine(newLines[i], lineIndex + i);
      }

      const lastPart =
        newLines[newLines.length - 1] + currentLine.slice(column);
      this.editor.lineController.addLine(
        lastPart,
        lineIndex + newLines.length - 1,
      );

      this.editor.lineController.refresh();

      const newRow = row + newLines.length - 1;
      const newColumn = newLines[newLines.length - 1].length;

      this.editor.events.callEvent(Events.ON_CHANGE, {
        action: "insert",
        text: text,
        beforeRow: row,
        beforeColumn: column,
        afterRow: newRow,
        afterColumn: newColumn,
      });

      return { row: newRow, column: newColumn };
    }
  }
}
