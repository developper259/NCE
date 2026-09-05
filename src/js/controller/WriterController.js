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
        let c = expandTabsForDisplay(char);
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
          document.createTextNode(
            expandTabsForDisplay(txt.slice(index, tokenStart)),
          ),
        );
      }

      const span = document.createElement("span");
      span.className = `token editor-select ${token.type}`;
      span.textContent = expandTabsForDisplay(token.value);

      fragment.appendChild(span);

      index = tokenStart + token.value.length;
    }

    if (index < txt.length) {
      fragment.appendChild(
        document.createTextNode(expandTabsForDisplay(txt.slice(index))),
      );
    }

    return fragment;
  }

  textToOBJ(txt, tokens = null, diffSegments = null) {
    const lineDiv = document.createElement("div");
    lineDiv.className = "line editor-select";

    let fragment;

    if (Array.isArray(diffSegments) && diffSegments.length > 0) {
      fragment = document.createDocumentFragment();
      for (const segment of diffSegments) {
        const span = document.createElement("span");
        span.className = segment.type
          ? `diff-segment diff-${segment.type}`
          : "diff-segment";
        span.textContent = expandTabsForDisplay(segment.text ?? "");
        fragment.appendChild(span);
      }
    } else if (tokens && tokens.length !== 0) {
      fragment = this.tokenToDOM(txt, tokens);
    } else {
      const value = document.createTextNode(expandTabsForDisplay(txt ?? ""));

      fragment = document.createDocumentFragment();
      fragment.appendChild(value);
    }

    lineDiv.appendChild(fragment);
    return lineDiv;
  }

  write(txt) {
    if (!this.editor.tabManager.activeFile || txt === undefined) return;
    this.editor.keyBinding.historyX = undefined;
    const cursor = this.editor.cursorController;
    const selection = this.getSelectionRange();
    const start = selection?.start || {
      row: cursor.row,
      column: cursor.column,
    };
    const end = selection?.end || start;
    const afterText =
      this.insertMode && !selection && txt.length === 1
        ? this.editor.lineController.lines[start.row - 1]
            .getText()
            .slice(start.column, start.column + 1)
        : "";
    const editEnd = afterText ? this.advancePosition(start, afterText) : end;
    return this.applyRangeEdit(start, editEnd, txt, {
      source: txt.includes("\n") ? "enter" : "typing",
      insertModeText: afterText,
    });
  }

  getSelectionRange() {
    const select = this.editor.selectController;
    if (!select?.hasActiveSelection?.()) return null;
    const start = select.startSelect;
    const end = {
      row: this.editor.cursorController.row,
      column: this.editor.cursorController.column,
    };
    if (
      start.row > end.row ||
      (start.row === end.row && start.column > end.column)
    ) {
      return { start: end, end: start };
    }
    return { start, end };
  }

  getTextInRange(start, end) {
    const lines = this.editor.lineController.lines;
    if (start.row === end.row) {
      return lines[start.row - 1].getText().slice(start.column, end.column);
    }
    const result = [lines[start.row - 1].getText().slice(start.column)];
    for (let row = start.row + 1; row < end.row; row++)
      result.push(lines[row - 1].getText());
    result.push(lines[end.row - 1].getText().slice(0, end.column));
    return result.join("\n");
  }

  advancePosition(start, text) {
    const parts = String(text || "").split("\n");
    return parts.length === 1
      ? { row: start.row, column: start.column + parts[0].length }
      : {
          row: start.row + parts.length - 1,
          column: parts[parts.length - 1].length,
        };
  }

  applyRangeEdit(start, end, text, options = {}) {
    const file = this.editor.tabManager.activeFile;
    const lineController = this.editor.lineController;
    if (!file || !lineController || typeof text !== "string") return null;

    const beforeText = this.getTextInRange(start, end);
    const cursorBefore = {
      row: this.editor.cursorController.row,
      column: this.editor.cursorController.column,
    };
    const selectionBefore = this.getSelectionRange();
    const lines = lineController.lines.map((line) => line.getText());
    const replacement = text.split("\n");
    const prefix = lines[start.row - 1].slice(0, start.column);
    const suffix = lines[end.row - 1].slice(end.column);
    replacement[0] = prefix + replacement[0];
    replacement[replacement.length - 1] += suffix;
    lines.splice(start.row - 1, end.row - start.row + 1, ...replacement);
    file.lines.splice(
      start.row - 1,
      end.row - start.row + 1,
      ...replacement.map((line) => new LineNode(line)),
    );
    file.totalLines = file.lines.length;
    file.maxLineLength = 0;
    if (options.preserveViewport === false) {
      file.startIndex = 0;
      file.offsetY = 0;
      file.offsetX = 0;
    }

    const cursorAfter = options.cursor || this.advancePosition(start, text);
    file.row = cursorAfter.row;
    file.column = cursorAfter.column;
    this.editor.selectController.unSelectAll();
    if (options.selection)
      this.editor.selectController.setSelection(
        options.selection.start,
        options.selection.end,
      );
    lineController.markDirtyFrom(start.row - 1);
    lineController.refresh(false);
    this.editor.cursorController.setCursorPosition(
      cursorAfter.row,
      cursorAfter.column,
    );
    if (options.ensureVisible) this.ensureCursorVisible(cursorAfter.row);

    const entry = {
      start: { ...start },
      beforeText,
      afterText: text,
      cursorBefore,
      cursorAfter: { ...cursorAfter },
      selectionBefore,
      selectionAfter: options.selection || null,
      source: options.source || "edit",
      timestamp: Date.now(),
    };
    if (options.recordHistory !== false)
      this.editor.historyController?.record(entry);
    this.editor.events.callEvent(Events.ON_CHANGE, {
      action: options.source || "edit",
      beforeText,
      afterText: text,
      beforeRow: start.row,
      beforeColumn: start.column,
      afterRow: cursorAfter.row,
      afterColumn: cursorAfter.column,
    });
    return { row: cursorAfter.row, column: cursorAfter.column };
  }

  ensureCursorVisible(row) {
    const lineController = this.editor.lineController;
    const displayIndex = lineController.getDisplayIndexForCursor(row);
    const viewportLines = Math.max(1, lineController.maxViewLines);
    const centeredStart = displayIndex - Math.floor(viewportLines / 2);
    const screenIndex = displayIndex - lineController.startIndex;
    const isVisible = screenIndex >= 0 && screenIndex < viewportLines;

    if (
      !isVisible ||
      Math.abs(screenIndex - Math.floor(viewportLines / 2)) > 1
    ) {
      lineController.scrollTo(centeredStart);
    }
  }

  delete(column, row) {
    if (
      !this.editor.tabManager.activeFile ||
      this.editor.lineController.lines.length === 0
    )
      return;

    if (column === 0) {
      if (row === 1) return;
      const previousLine = this.editor.lineController.lines[row - 2].getText();
      return this.deleteRange(
        { row: row - 1, column: previousLine.length },
        { row, column: 0 },
      );
    }
    return this.deleteRange({ row, column: column - 1 }, { row, column });
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

    const deleteStart = { row, column: cursor.column };
    const deleteEnd = { row, column };
    return this.deleteRange(deleteStart, deleteEnd);
  }

  deleteSelection() {
    const selectCtrl = this.editor.selectController;
    const cursor = this.editor.cursorController;

    if (!selectCtrl || !selectCtrl.hasActiveSelection?.()) return null;

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
    return this.applyRangeEdit(start, end, "", { source: "delete" });
  }

  replaceRange(text, startLine, startColumn, endLine, endColumn, options = {}) {
    const lines = this.editor.lineController.lines;
    if (!lines.length) return null;
    const startRow = Math.min(
      Math.max(1, Number(startLine) || 1),
      lines.length,
    );
    const endRow = Math.min(
      Math.max(startRow, Number(endLine) || startRow),
      lines.length,
    );
    const startCol = Math.min(
      Math.max(0, Number(startColumn) || 0),
      lines[startRow - 1].getText().length,
    );
    const endCol = Math.min(
      Math.max(0, Number(endColumn) || 0),
      lines[endRow - 1].getText().length,
    );
    return this.applyRangeEdit(
      { row: startRow, column: startCol },
      { row: endRow, column: endCol },
      text,
      { ...options, source: options.source || "replace" },
    );
  }

  insertTextAt(text, row, column) {
    if (
      !this.editor.tabManager.activeFile ||
      this.editor.lineController.lines.length === 0
    )
      return;

    return this.applyRangeEdit({ row, column }, { row, column }, text, {
      source: "insert",
    });
  }
}
