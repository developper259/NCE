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

  tokenToDOM(txt, tokens) {
    const fragment = document.createDocumentFragment();

    if (!txt) return fragment;

    let index = 0;

    for (const token of tokens) {
      const tokenStart = token.column - 1;

      if (tokenStart > index) {
        fragment.appendChild(
          document.createTextNode(txt.slice(index, tokenStart)),
        );
      }

      const span = document.createElement("span");
      span.className = `token editor-select ${token.type}`;
      span.textContent = token.value;

      fragment.appendChild(span);

      index = tokenStart + token.value.length;
    }

    if (index < txt.length) {
      fragment.appendChild(document.createTextNode(txt.slice(index)));
    }

    return fragment;
  }

  textToOBJ(txt, tokens = null) {
    const lineDiv = document.createElement("div");
    lineDiv.className = "line editor-select";

    let fragment;

    if (tokens && tokens.length !== 0) {
      fragment = this.tokenToDOM(txt, tokens);
    } else {
      const value = document.createTextNode(txt ?? "");

      fragment = document.createDocumentFragment();
      fragment.appendChild(value);
    }

    lineDiv.appendChild(fragment);
    return lineDiv;
  }

  write(txt) {
    if (!this.editor.tabManager.activeFile || txt === undefined) return;
    this.editor.keyBinding.historyX = undefined;

    const lc = this.editor.lineController;
    let row = this.editor.cursorController.row;
    let column = this.editor.cursorController.column;

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

      this.editor.cursorController.setCursorPosition(row, newColumn);

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

    this.editor.cursorController.setCursorPosition(endRow, lastLineLength);

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
    const cursor = this.editor.cursorController;

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

    this.editor.events.callEvent(Events.ON_CHANGE, {
      action: "delete",
      beforeRow: start.row,
      beforeColumn: start.column,
      afterRow: end.row,
      afterColumn: end.column,
    });

    return { row: newRow, column: newCol };
  }

  replaceRange(text, startLine, startColumn, endLine, endColumn) {
    const file = this.editor.tabManager.activeFile;
    const lineController = this.editor.lineController;

    if (!file || !lineController || typeof text !== "string") return null;

    const lines = lineController.lines.map((line) => line.getText());
    if (lines.length === 0) return null;

    const startRow = Math.min(
      Math.max(1, Number(startLine) || 1),
      lines.length,
    );
    const endRow = Math.min(
      Math.max(startRow, Number(endLine) || startRow),
      lines.length,
    );
    const startText = lines[startRow - 1] || "";
    const endText = lines[endRow - 1] || "";
    const startCol = Math.min(
      Math.max(0, Number(startColumn) || 0),
      startText.length,
    );
    const endCol = Math.min(
      Math.max(0, Number(endColumn) || 0),
      endText.length,
    );

    const replacement = text.split("\n");
    const prefix = startText.slice(0, startCol);
    const suffix = endText.slice(endCol);
    const replacementLines = replacement.slice();
    replacementLines[0] = prefix + replacementLines[0];
    replacementLines[replacementLines.length - 1] += suffix;

    lines.splice(startRow - 1, endRow - startRow + 1, ...replacementLines);
    file.lines = lines.map((line) => new LineNode(line));
    file.totalLines = file.lines.length;
    file.maxLineLength = 0;
    file.startIndex = 0;
    file.offsetY = 0;
    file.offsetX = 0;

    const lastLine = replacementLines.length - 1;
    const cursorRow = startRow + lastLine;
    const cursorColumn = replacementLines[lastLine].length - suffix.length;

    file.row = cursorRow;
    file.column = cursorColumn;
    lineController.markDirtyAll();
    lineController.refresh(true);
    this.editor.selectController?.unSelectAll();
    this.editor.events.callEvent(Events.ON_CHANGE, {
      action: "replace",
      text,
      beforeRow: startRow,
      beforeColumn: startCol,
      afterRow: cursorRow,
      afterColumn: cursorColumn,
    });

    return { row: cursorRow, column: cursorColumn };
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
