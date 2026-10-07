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

  getWordRangeAt(lineOrText, column) {
    const text = typeof lineOrText === "string" ? lineOrText : lineOrText?.getText?.() || "";
    const lineNode = typeof lineOrText === "string" ? null : lineOrText;
    const index = lineNode?.getPositionIndex?.() ||
      (typeof TextPositionIndex === "function"
        ? new TextPositionIndex(text, SETTINGS_GET("editor.tabWidth"))
        : null);
    if (index) return index.getWordRangeAt(column, this.separator);
    if (!text) return { start: 0, end: 0, separator: false };
    const offset = Math.max(0, Math.min(Number(column) || 0, text.length));
    let start = offset;
    let end = offset;
    const isSeparator = (char) => this.separator.includes(char);
    while (start > 0 && !isSeparator(text[start - 1])) start--;
    while (end < text.length && !isSeparator(text[end])) end++;
    if (start === end && end < text.length) end++;
    return { start, end, separator: isSeparator(text[start]) };
  }

  getPreviousWordBoundary(lineOrText, column) {
    const lineNode = typeof lineOrText === "string" ? null : lineOrText;
    const text = lineNode?.getText?.() ?? (typeof lineOrText === "string" ? lineOrText : "");
    const index = lineNode?.getPositionIndex?.() ||
      (typeof TextPositionIndex === "function"
        ? new TextPositionIndex(text, SETTINGS_GET("editor.tabWidth"))
        : null);
    if (index) return index.previousWordBoundary(column, this.separator);
    let position = Math.max(0, Math.min(Number(column) || 0, text.length));
    while (position > 0 && this.separator.includes(text[position - 1])) position--;
    while (position > 0 && !this.separator.includes(text[position - 1])) position--;
    return position;
  }

  getNextWordBoundary(lineOrText, column) {
    const lineNode = typeof lineOrText === "string" ? null : lineOrText;
    const text = lineNode?.getText?.() ?? (typeof lineOrText === "string" ? lineOrText : "");
    const index = lineNode?.getPositionIndex?.() ||
      (typeof TextPositionIndex === "function"
        ? new TextPositionIndex(text, SETTINGS_GET("editor.tabWidth"))
        : null);
    if (index) return index.nextWordBoundary(column, this.separator);
    let position = Math.max(0, Math.min(Number(column) || 0, text.length));
    if (position >= text.length) return text.length;
    const separator = this.separator.includes(text[position]);
    position++;
    while (position < text.length && separator === this.separator.includes(text[position]))
      position++;
    return position;
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
      const tokenClasses = String(token.className || token.type || "")
        .split(/\s+/)
        .filter(Boolean)
        .map((className) =>
          className.startsWith("nsh-") ? className : `nsh-${className}`,
        )
        .join(" ");
      span.className = `token editor-select ${tokenClasses}`.trim();
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
      let offset = 0;
      let tokenIndex = 0;
      for (const segment of diffSegments) {
        const segmentText = String(segment.text ?? "");
        const span = document.createElement("span");
        span.className = segment.type
          ? `diff-segment diff-${segment.type}`
          : "diff-segment";
        if (tokens?.length) {
          const segmentEnd = offset + segmentText.length;
          while (tokenIndex < tokens.length) {
            const token = tokens[tokenIndex];
            const end =
              (Number(token.column) || 1) -
              1 +
              String(token.value ?? "").length;
            if (end > offset) break;
            tokenIndex++;
          }
          const segmentTokens = [];
          for (let index = tokenIndex; index < tokens.length; index++) {
            const token = tokens[index];
            const start = (Number(token.column) || 1) - 1;
            if (start >= segmentEnd) break;
            const end = start + String(token.value ?? "").length;
            const from = Math.max(start, offset);
            const to = Math.min(end, segmentEnd);
            if (from < to)
              segmentTokens.push({
                ...token,
                column: from - offset + 1,
                value: segmentText.slice(from - offset, to - offset),
              });
          }
          span.appendChild(this.tokenToDOM(segmentText, segmentTokens));
        } else {
          span.textContent = expandTabsForDisplay(segmentText);
        }
        fragment.appendChild(span);
        offset += segmentText.length;
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

  projectTokens(tokens, oldText, newText, lineNumber, edit = null) {
    if (!Array.isArray(tokens) || tokens.length === 0) return tokens;
    if (oldText === newText) return tokens;

    let editStart = edit?.start ?? 0;
    let oldEnd = edit?.end ?? oldText.length;
    let newEnd = edit ? editStart + edit.text.length : newText.length;
    if (!edit) {
      const sharedLimit = Math.min(oldText.length, newText.length);
      while (editStart < sharedLimit && oldText[editStart] === newText[editStart]) editStart++;
      oldEnd = oldText.length;
      newEnd = newText.length;
      while (oldEnd > editStart && newEnd > editStart && oldText[oldEnd - 1] === newText[newEnd - 1]) {
        oldEnd--;
        newEnd--;
      }
    }

    const delta = newEnd - editStart - (oldEnd - editStart);
    const projected = [];
    for (const token of tokens) {
      const tokenStart = Math.max(0, (Number(token.column) || 1) - 1);
      const tokenEnd = tokenStart + String(token.value || "").length;
      let start = tokenStart;
      let end = tokenEnd;

      if (tokenStart >= oldEnd) {
        start += delta;
        end += delta;
      } else if (tokenEnd > editStart) {
        start = Math.min(tokenStart, editStart);
        end = Math.max(editStart, tokenEnd + delta, newEnd);
      }

      start = Math.max(0, Math.min(start, newText.length));
      end = Math.max(start, Math.min(end, newText.length));
      if (end === start) continue;
      projected.push({
        ...token,
        line: lineNumber,
        column: start + 1,
        value: newText.slice(start, end),
      });
    }
    return projected;
  }

  mutateLineRange(startIndex, oldCount, replacementTexts, edit = null) {
    const lines = this.editor.lineController.lines;
    const existing = lines.slice(startIndex, startIndex + oldCount);
    const reuseCount = Math.min(existing.length, replacementTexts.length);
    const replacementNodes = [];

    for (let index = 0; index < reuseCount; index++) {
      const line = existing[index];
      const oldText = line.getText();
      const newText = replacementTexts[index];
      line.setTokens(
        this.projectTokens(
          line.getTokens(),
          oldText,
          newText,
          startIndex + index + 1,
          reuseCount === 1 && replacementTexts.length === 1 ? edit : null,
        ),
      );
      line.setText(newText, reuseCount === 1 && replacementTexts.length === 1 ? edit : null);
      replacementNodes.push(line);
    }

    for (let index = reuseCount; index < replacementTexts.length; index++) {
      replacementNodes.push(new LineNode(replacementTexts[index]));
    }

    if (oldCount !== replacementNodes.length) {
      lines.splice(startIndex, oldCount, ...replacementNodes);
    }
    return replacementNodes;
  }

  applyRangeEdit(start, end, text, options = {}) {
    const file = this.editor.tabManager.activeFile;
    const lineController = this.editor.lineController;
    if (
      !file ||
      file.loadError ||
      (file.loadingState && file.loadingState.status !== "loaded") ||
      !lineController ||
      typeof text !== "string"
    )
      return null;

    file.editVersion = (file.editVersion || 0) + 1;
    const beforeText = this.getTextInRange(start, end);
    const cursorBefore = {
      row: this.editor.cursorController.row,
      column: this.editor.cursorController.column,
    };
    const selectionBefore = this.getSelectionRange();
    const lines = lineController.lines;
    const normalizedText = text.replace(/\r\n/g, "\n");
    const replacement = normalizedText.split("\n");
    text = normalizedText;
    const prefix = lines[start.row - 1].getText().slice(0, start.column);
    const suffix = lines[end.row - 1].getText().slice(end.column);
    replacement[0] = prefix + replacement[0];
    replacement[replacement.length - 1] += suffix;
    const removed = lines.slice(start.row - 1, end.row);
    const oldEndings = (file.lineEndings || []).slice(
      start.row - 1,
      end.row - 1,
    );
    const newEndings =
      options.lineEndings ||
      Array(replacement.length - 1).fill(file.eol || "\n");
    // Separators within the replaced range belong to that edit; the separator
    // after its last line remains attached to the surviving suffix.
    if (!file.lineEndings) file.lineEndings = [];
    file.lineEndings.splice(start.row - 1, end.row - start.row, ...newEndings);
    if (file.syntaxMetrics) {
      file.syntaxMetrics.logicalLength += replacement.length - removed.length;
      for (const line of removed) {
        const length = line.getText().length;
        file.syntaxMetrics.logicalLength -= length;
        if (length > 1000) file.syntaxMetrics.longLineCount--;
      }
      for (const line of replacement) {
        file.syntaxMetrics.logicalLength += line.length;
        if (line.length > 1000) file.syntaxMetrics.longLineCount++;
      }
    }
    const lineEdit = start.row === end.row && replacement.length === 1
      ? { start: start.column, end: end.column, text: normalizedText }
      : null;
    const replacementNodes = this.mutateLineRange(
      start.row - 1,
      end.row - start.row + 1,
      replacement,
      lineEdit,
    );
    file.totalLines = file.lines.length;
    lineController.syncLineLengthsForEdit?.(start.row - 1, removed, replacementNodes);
    if (options.preserveViewport === false) {
      file.startIndex = 0;
      file.offsetY = 0;
      file.offsetX = 0;
    }

    const cursorAfter = options.cursor || this.advancePosition(start, text);
    file.row = cursorAfter.row;
    file.column = cursorAfter.column;
    this.editor.selectController.unSelectAll({ emitEvent: false });
    if (options.selection)
      this.editor.selectController.setSelection(
        options.selection.start,
        options.selection.end,
        { emitEvent: false },
      );
    lineController.markDirtyFrom(start.row - 1);
    this.editor.cursorController.setCursorPosition(
      cursorAfter.row,
      cursorAfter.column,
      { emitEvent: false },
    );
    if (options.ensureVisible) this.ensureCursorVisible(cursorAfter.row);

    const entry = {
      start: { ...start },
      beforeText,
      beforeLineEndings: oldEndings,
      afterLineEndings: newEndings,
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
      nshUpdate: {
        startLine: start.row - 1,
        deletedLines: end.row - start.row + 1,
        insertedLines: replacement,
      },
      beforeRow: start.row,
      beforeColumn: start.column,
      afterRow: cursorAfter.row,
      afterColumn: cursorAfter.column,
    });
    lineController.refresh(false);
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
    const lineNode = this.editor.lineController.lines[row - 1];
    const line = lineNode?.getText() || "";
    return this.deleteRange(
      {
        row,
        column:
          typeof previousGraphemeBoundary === "function"
            ? (lineNode?.getPositionIndex?.()?.previous(column) ?? previousGraphemeBoundary(line, column))
            : column - 1,
      },
      { row, column },
    );
  }

  deleteWord(column, row) {
    if (
      !this.editor.tabManager.activeFile ||
      this.editor.lineController.lines.length === 0
    )
      return;

    let cursor = { column, row };
    const lineNode = this.editor.lineController.lines[row - 1];
    const startColumn = this.getPreviousWordBoundary(lineNode, cursor.column);
    return this.deleteRange({ row, column: startColumn }, { row, column });
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

    if (!newCursor) selectCtrl.unSelectAll();

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
