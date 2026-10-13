const MAX_BATCH_EDIT_COUNT = 1024;
const MAX_BATCH_INSERTED_TEXT = 32 * 1024 * 1024;

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
    const multi = this.editor.multiCursorController;
    const multiSelections = multi?.getSelections?.() || [];
    if (multiSelections.length > 1) {
      const edits = multiSelections.map((selection) => {
        const range = multi.getRange(selection);
        let end = range.end;
        let insertModeText = "";
        if (this.insertMode && !multi.isSelected(selection) && txt.length === 1) {
          const lineNode = this.editor.lineController.lines[range.start.row - 1];
          const line = lineNode?.getText?.() || "";
          if (range.start.column < line.length) {
            const index = lineNode?.getPositionIndex?.();
            end = {
              row: range.start.row,
              column: index?.next(range.start.column) ??
                (typeof nextGraphemeBoundary === "function"
                  ? nextGraphemeBoundary(line, range.start.column)
                  : range.start.column + 1),
            };
            insertModeText = line.slice(range.start.column, end.column);
          }
        }
        return {
          id: selection.id,
          start: range.start,
          end,
          text: txt,
          insertModeText,
          cursorId: selection.id,
        };
      });
      return this.applyBatchEdits(edits, {
        source: txt.includes("\n") ? "enter" : "typing",
        primaryId: this.editor.tabManager.activeFile._multiCursorPrimaryId,
      });
    }
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
    const multi = this.editor.multiCursorController;
    const primary = multi?.getPrimarySelection?.();
    if (primary && multi.isSelected(primary)) return multi.getRange(primary);
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

  comparePositions(left, right) {
    return left.row - right.row || left.column - right.column;
  }

  mapPositionThroughReplacement(position, start, end, replacementText) {
    const replacementEnd = this.advancePosition(start, replacementText);
    if (this.comparePositions(position, end) < 0) return replacementEnd;
    if (position.row > end.row) {
      return {
        row: replacementEnd.row + position.row - end.row,
        column: position.column,
      };
    }
    return {
      row: replacementEnd.row,
      column: replacementEnd.column + position.column - end.column,
    };
  }

  mapPositionAfterPreviousEdit(position, previousEnd, previousMappedEnd) {
    if (!previousEnd || !previousMappedEnd) return { ...position };
    if (position.row > previousEnd.row) {
      return {
        row: previousMappedEnd.row + position.row - previousEnd.row,
        column: position.column,
      };
    }
    if (position.row === previousEnd.row) {
      return {
        row: previousMappedEnd.row,
        column: previousMappedEnd.column + position.column - previousEnd.column,
      };
    }
    return { ...position };
  }

  mapPositionThroughBatch(position, edits) {
    let mapped = { ...position };
    let previousEnd = null;
    let previousMappedEnd = null;
    for (const edit of edits) {
      if (this.comparePositions(position, edit.start) < 0) break;
      const start = this.mapPositionAfterPreviousEdit(
        edit.start,
        previousEnd,
        previousMappedEnd,
      );
      const end = this.mapPositionAfterPreviousEdit(
        edit.end,
        previousEnd,
        previousMappedEnd,
      );
      if (this.comparePositions(position, edit.end) < 0)
        return this.advancePosition(start, edit.text);
      mapped = this.mapPositionAfterPreviousEdit(
        position,
        previousEnd,
        previousMappedEnd,
      );
      mapped = this.mapPositionThroughReplacement(
        mapped,
        start,
        end,
        edit.text,
      );
      previousEnd = edit.end;
      previousMappedEnd = this.advancePosition(start, edit.text);
    }
    return mapped;
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

    const lines = lineController.lines;
    const isValidPosition = (position) =>
      position && Number.isSafeInteger(position.row) &&
      Number.isSafeInteger(position.column) && position.row >= 1 &&
      position.row <= lines.length && position.column >= 0 &&
      position.column <= (lines[position.row - 1]?.getText?.().length ?? -1);
    if (!isValidPosition(start) || !isValidPosition(end) ||
        this.comparePositions(start, end) > 0) return null;

    const beforeText = this.getTextInRange(start, end);
    const cursorBefore = {
      row: this.editor.cursorController.row,
      column: this.editor.cursorController.column,
    };
    const selectionBefore = this.getSelectionRange();
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
    const newEndings = options.lineEndings === undefined
      ? beforeText === normalizedText
        ? [...oldEndings]
        : Array(replacement.length - 1).fill(file.eol || "\n")
      : options.lineEndings;
    if (!Array.isArray(newEndings) ||
        newEndings.length !== replacement.length - 1 ||
        newEndings.some((ending) =>
          ending !== "\n" && ending !== "\r\n" && ending !== "\r",
        )) return null;
    if (beforeText === normalizedText &&
        oldEndings.length === newEndings.length &&
        oldEndings.every((ending, index) => ending === newEndings[index])) {
      const cursorAfter = options.cursor || this.advancePosition(start, text);
      const multi = this.editor.multiCursorController;
      const primary = multi?.getPrimarySelection?.(file);
      if (primary && multi.isSelected?.(primary)) {
        const result = {
          ...primary,
          anchor: { ...cursorAfter },
          active: { ...cursorAfter },
          preferredVisualColumn: null,
        };
        return this.applySelectionOnly([result], primary.id, file, {
          ensureVisible: true,
        });
      }

      if (selectionBefore) {
        this.editor.selectController?.unSelectAll?.({ emitEvent: false });
        this.editor.cursorController.setCursorPosition(
          cursorAfter.row,
          cursorAfter.column,
          { emitEvent: false, syncMultiCursor: false, renderMultiCursor: false },
        );
        this.editor.selectController?.refreshSelectionDOM?.();
        return { row: cursorAfter.row, column: cursorAfter.column };
      }
      return null;
    }

    const cursorAfter = options.cursor || this.advancePosition(start, text);
    const entry = {
      start: { ...start },
      beforeText,
      beforeLineEndings: [...oldEndings],
      afterLineEndings: [...newEndings],
      afterText: text,
      cursorBefore,
      cursorAfter: { ...cursorAfter },
      selectionBefore,
      selectionAfter: options.selection || null,
      source: options.source || "edit",
      timestamp: Date.now(),
    };
    const history = this.editor.historyController;
    if (
      options.recordHistory !== false &&
      typeof history?.canRecordEntry === "function" &&
      !history.canRecordEntry(entry, file)
    ) return null;

    file.editVersion = (file.editVersion || 0) + 1;
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

    if (options.recordHistory !== false)
      history?.record(entry);
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

  applySelectionOnly(selections, primaryId, file, { ensureVisible = true } = {}) {
    const multi = this.editor.multiCursorController;
    const current = multi?.getSelections?.(file) || [];
    const samePosition = (left, right) =>
      left?.row === right?.row && left?.column === right?.column;
    const sameSelection = (left, right) => left?.id === right?.id &&
      samePosition(left.anchor, right.anchor) &&
      samePosition(left.active, right.active) &&
      left.preferredVisualColumn === right.preferredVisualColumn;
    const unchanged = file?._multiCursorPrimaryId === primaryId &&
      current.length === selections.length &&
      current.every((selection, index) => sameSelection(selection, selections[index]));
    if (unchanged) return null;

    if (multi?.setSelections) {
      if (!multi.setSelections(selections, {
        file,
        primaryId,
        render: false,
        emitEvent: true,
      })) return null;
    }
    const primary = multi?.getPrimarySelection?.(file);
    if (!primary) return null;
    this.editor.cursorController.setCursorPosition(
      primary.active.row,
      primary.active.column,
      {
        emitEvent: false,
        ensureVisible,
        syncMultiCursor: false,
        renderMultiCursor: false,
      },
    );
    this.editor.selectController?.refreshSelectionDOM?.();
    multi.refreshOverlays?.();
    return { row: primary.active.row, column: primary.active.column };
  }

  applyBatchEdits(edits, options = {}) {
    const file = this.editor.tabManager.activeFile;
    const lineController = this.editor.lineController;
    const multi = this.editor.multiCursorController;
    if (
      !file || file.loadError || file.largeFileMode === true || file.diffActive === true ||
      (file.loadingState && file.loadingState.status !== "loaded") ||
      !lineController || !Array.isArray(edits) || edits.length === 0 ||
      edits.length > MAX_BATCH_EDIT_COUNT || typeof multi?.normalizePosition !== "function"
    ) return null;

    const capturedEditVersion = Number(file.editVersion) || 0;
    const originalLines = lineController.lines;
    if (!originalLines.length) return null;
    const normalized = [];
    const ids = new Set();
    let insertedTextLength = 0;
    const isValidPosition = (position) => {
      if (!position || !Number.isSafeInteger(position.row) ||
          !Number.isSafeInteger(position.column) || position.row < 1 ||
          position.row > originalLines.length) return false;
      const text = originalLines[position.row - 1]?.getText?.();
      return typeof text === "string" && position.column >= 0 && position.column <= text.length;
    };
    for (const candidate of edits) {
      if (!candidate || typeof candidate.text !== "string") return null;
      const rawEnd = candidate.end || candidate.start;
      if (!isValidPosition(candidate.start) || !isValidPosition(rawEnd)) return null;
      const first = multi.normalizePosition(file, candidate.start);
      const last = multi.normalizePosition(file, rawEnd);
      if (!first || !last) return null;
      const ordered = first.row < last.row ||
        (first.row === last.row && first.column <= last.column)
        ? { start: first, end: last }
        : { start: last, end: first };
      const cursorId = Number.isSafeInteger(candidate.cursorId)
        ? candidate.cursorId
        : null;
      if (cursorId !== null && ids.has(cursorId)) return null;
      if (cursorId !== null) ids.add(cursorId);
      const text = candidate.text.replace(/\r\n?/g, "\n");
      insertedTextLength += text.length;
      if (insertedTextLength > MAX_BATCH_INSERTED_TEXT) return null;
      const startLine = originalLines[ordered.start.row - 1];
      const endLine = originalLines[ordered.end.row - 1];
      if (!startLine || !endLine) return null;
      const beforeText = this.getTextInRange(ordered.start, ordered.end);
      if (typeof beforeText !== "string") return null;
      const oldLineEndings = [];
      for (let index = ordered.start.row - 1; index < ordered.end.row - 1; index++)
        oldLineEndings.push(file.lineEndings?.[index] || file.eol || "\n");
      let insertedCount = 0;
      for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1))
        insertedCount++;
      let newLineEndings = candidate.lineEndings;
      if (newLineEndings !== undefined) {
        if (!Array.isArray(newLineEndings) || newLineEndings.length !== insertedCount ||
            newLineEndings.some((ending) => ending !== "\n" && ending !== "\r\n" && ending !== "\r"))
          return null;
        newLineEndings = [...newLineEndings];
      } else {
        newLineEndings = beforeText === text
          ? [...oldLineEndings]
          : Array(insertedCount).fill(file.eol || "\n");
      }
      normalized.push({
        id: candidate.id ?? cursorId,
        cursorId,
        start: ordered.start,
        end: ordered.end,
        text,
        beforeText,
        beforeLineEndings: oldLineEndings,
        afterLineEndings: newLineEndings,
        cursorOffset: Number.isSafeInteger(candidate.cursorOffset)
          ? Math.max(0, Math.min(candidate.cursorOffset, text.length))
          : null,
        cursorOffsetSource: Number.isSafeInteger(candidate.cursorOffsetSource)
          ? Math.max(0, candidate.cursorOffsetSource)
          : null,
      });
    }
    normalized.sort((left, right) =>
      left.start.row - right.start.row || left.start.column - right.start.column ||
      left.end.row - right.end.row || left.end.column - right.end.column,
    );
    const effective = normalized.filter((edit) =>
      edit.beforeText !== edit.text ||
      edit.beforeLineEndings.length !== edit.afterLineEndings.length ||
      edit.beforeLineEndings.some((ending, index) =>
        ending !== edit.afterLineEndings[index],
      ),
    );
    const effectiveEdits = new Set(effective);
    // Empty boundary operations remain part of the selection snapshot but are
    // not document edits and must not collide with a neighboring deletion.
    for (let index = 1; index < effective.length; index++) {
      const previous = effective[index - 1];
      const current = effective[index];
      const previousCollapsed = previous.start.row === previous.end.row &&
        previous.start.column === previous.end.column;
      const currentCollapsed = current.start.row === current.end.row &&
        current.start.column === current.end.column;
      const order = previous.end.row - current.start.row ||
        previous.end.column - current.start.column;
      if (
        order > 0 ||
        (order === 0 && previousCollapsed && currentCollapsed) ||
        (previousCollapsed && order === 0 && !currentCollapsed) ||
        (currentCollapsed && order === 0 && !previousCollapsed)
      ) return null;
    }

    const selectionBefore = multi.getSelections(file).map((selection) => ({
      id: selection.id,
      anchor: { ...selection.anchor },
      active: { ...selection.active },
      preferredVisualColumn: selection.preferredVisualColumn,
    }));
    const primaryIdBefore = file._multiCursorPrimaryId;
    const cursorBefore = { row: file.row, column: file.column };
    const groups = [];
    for (const edit of effective) {
      let group = groups[groups.length - 1];
      if (!group || edit.start.row > group.endRow) {
        group = {
          startRow: edit.start.row,
          endRow: edit.end.row,
          edits: [],
        };
        groups.push(group);
      } else {
        group.endRow = Math.max(group.endRow, edit.end.row);
      }
      group.edits.push(edit);
    }

    let cumulativeLineDelta = 0;
    for (const group of groups) {
      const plan = this.buildBatchGroupPlan(file, group);
      if (!plan) return null;
      group.plan = plan;
      group.resultStartRow = group.startRow + cumulativeLineDelta;
      cumulativeLineDelta += plan.replacementTexts.length -
        (group.endRow - group.startRow + 1);
    }

    const placements = new Map();
    for (const group of groups) {
      for (const [cursorId, local] of group.plan.placements) {
        placements.set(cursorId, {
          row: group.resultStartRow + local.row - 1,
          column: local.column,
        });
      }
    }
    for (const edit of normalized) {
      if (effectiveEdits.has(edit) || edit.cursorId === null) continue;
      const start = this.mapPositionThroughBatch(edit.start, effective);
      const cursorOffset = edit.cursorOffset ?? edit.text.length;
      placements.set(
        edit.cursorId,
        this.advancePosition(start, edit.text.slice(0, cursorOffset)),
      );
    }
    const results = options.resultSelections || selectionBefore.map((selection) => {
      const active = placements.get(selection.id) || this.mapPositionThroughBatch(
        selection.active,
        effective,
      );
      const anchor = placements.has(selection.id)
        ? active
        : this.mapPositionThroughBatch(selection.anchor, effective);
      return {
        ...selection,
        anchor: { ...anchor },
        active: { ...active },
        preferredVisualColumn: placements.has(selection.id)
          ? null
          : selection.preferredVisualColumn,
      };
    });
    if (!results.length) return null;
    const requestedPrimaryId = options.resultPrimaryId ?? primaryIdBefore;
    const primaryIdAfter = results.some((selection) => selection.id === requestedPrimaryId)
      ? requestedPrimaryId
      : results[0].id;
    const primaryResult = results.find((selection) => selection.id === primaryIdAfter) ||
      results[0];
    if (effective.length === 0)
      return this.applySelectionOnly(results, primaryIdAfter, file, {
        ensureVisible: options.ensureVisible === true,
      });
    const historyEdits = effective.map((edit) => ({
      id: edit.id,
      cursorId: edit.cursorId,
      start: { ...edit.start },
      beforeText: edit.beforeText,
      afterText: edit.text,
      cursorAtEnd: edit.cursorOffset === null || edit.cursorOffset >= edit.text.length,
      beforeLineEndings: [...edit.beforeLineEndings],
      afterLineEndings: [...edit.afterLineEndings],
    }));
    const beforeText = effective.map((edit) => edit.beforeText).join("\n");
    const afterText = effective.map((edit) => edit.text).join("\n");
    const historyEntry = {
      type: "batch",
      edits: historyEdits,
      selectionsBefore: selectionBefore,
      selectionsAfter: results.map((selection) => ({
        id: selection.id,
        anchor: { ...selection.anchor },
        active: { ...selection.active },
        preferredVisualColumn: selection.preferredVisualColumn,
      })),
      primaryIdBefore,
      primaryIdAfter,
      cursorBefore,
      cursorAfter: { ...primaryResult.active },
      source: options.source || "batch",
      timestamp: Date.now(),
    };
    const history = this.editor.historyController;
    if (
      options.recordHistory !== false &&
      typeof history?.canRecordEntry === "function" &&
      !history.canRecordEntry(historyEntry, file)
    ) return null;
    const nshUpdates = groups.map((group) => ({
      startLine: group.startRow - 1,
      deletedLines: group.endRow - group.startRow + 1,
      insertedLines: group.plan.replacementTexts,
    }));

    if ((Number(file.editVersion) || 0) !== capturedEditVersion) return null;
    file.editVersion = capturedEditVersion + 1;

    const beforeLineCount = originalLines.length;
    const syntaxMetrics = file.syntaxMetrics;
    if (syntaxMetrics) {
      for (const group of groups) {
        const oldLines = originalLines.slice(group.startRow - 1, group.endRow);
        syntaxMetrics.logicalLength += group.plan.replacementTexts.length - oldLines.length;
        for (const line of oldLines) {
          const length = line.getText().length;
          syntaxMetrics.logicalLength -= length;
          if (length > 1000) syntaxMetrics.longLineCount--;
        }
        for (const text of group.plan.replacementTexts) {
          syntaxMetrics.logicalLength += text.length;
          if (text.length > 1000) syntaxMetrics.longLineCount++;
        }
      }
    }

    const changedGroups = [];
    for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex--) {
      const group = groups[groupIndex];
      const oldCount = group.endRow - group.startRow + 1;
      const removed = originalLines.slice(group.startRow - 1, group.endRow);
      const onlyEdit = group.edits.length === 1 ? group.edits[0] : null;
      const lineEdit = onlyEdit && onlyEdit.start.row === onlyEdit.end.row &&
        group.plan.replacementTexts.length === 1
        ? { start: onlyEdit.start.column, end: onlyEdit.end.column, text: onlyEdit.text }
        : null;
      const replacementNodes = this.mutateLineRange(
        group.startRow - 1,
        oldCount,
        group.plan.replacementTexts,
        lineEdit,
      );
      if (!file.lineEndings) file.lineEndings = [];
      file.lineEndings.splice(
        group.startRow - 1,
        oldCount - 1,
        ...group.plan.afterLineEndings,
      );
      changedGroups.push({
        startIndex: group.startRow - 1,
        removed,
        replacementNodes,
        oldCount,
      });
    }
    file.totalLines = file.lines.length;
    if (typeof lineController.syncLineLengthsForBatch === "function")
      lineController.syncLineLengthsForBatch(changedGroups, beforeLineCount);
    else {
      for (const group of changedGroups)
        lineController.syncLineLengthsForEdit?.(
          group.startIndex,
          group.removed,
          group.replacementNodes,
        );
    }

    multi.setSelections(results, {
      file,
      primaryId: primaryIdAfter,
      render: false,
    });
    const primaryAfter = multi.getPrimarySelection(file);
    lineController.markDirtyFrom(Math.min(...groups.map((group) => group.startRow - 1)));
    this.editor.cursorController.setCursorPosition(
      primaryAfter.active.row,
      primaryAfter.active.column,
      { emitEvent: false, ensureVisible: options.ensureVisible === true, syncMultiCursor: false, renderMultiCursor: false },
    );
    if (options.ensureVisible) this.ensureCursorVisible(primaryAfter.active.row);

    if (options.recordHistory !== false) {
      historyEntry.selectionsAfter = multi.getSelections(file).map((selection) => ({
        id: selection.id,
        anchor: { ...selection.anchor },
        active: { ...selection.active },
        preferredVisualColumn: selection.preferredVisualColumn,
      }));
      historyEntry.primaryIdAfter = file._multiCursorPrimaryId;
      historyEntry.cursorAfter = { row: primaryAfter.active.row, column: primaryAfter.active.column };
      history?.record(historyEntry);
    }
    this.editor.events.callEvent(Events.ON_CHANGE, {
      action: options.source || "batch",
      beforeText,
      afterText,
      nshUpdates,
      nshUpdate: nshUpdates.length === 1 ? nshUpdates[0] : null,
      batch: true,
      beforeRow: cursorBefore.row,
      beforeColumn: cursorBefore.column,
      afterRow: primaryAfter.active.row,
      afterColumn: primaryAfter.active.column,
    });
    lineController.refresh(false);
    return { row: primaryAfter.active.row, column: primaryAfter.active.column };
  }

  buildBatchGroupPlan(file, group) {
    const lines = file.lines;
    const firstLine = group.startRow - 1;
    const sourceLines = lines.slice(firstLine, group.endRow);
    if (!sourceLines.length) return null;
    const offsets = [0];
    const sourceParts = [];
    for (const line of sourceLines) {
      const text = line?.getText?.();
      if (typeof text !== "string") return null;
      sourceParts.push(text);
      offsets.push(offsets[offsets.length - 1] + text.length + 1);
    }
    offsets.pop();
    const sourceText = sourceParts.join("\n");
    const newlineOffsets = [];
    let searchFrom = 0;
    for (let index = 0; index < sourceParts.length - 1; index++) {
      const at = sourceText.indexOf("\n", searchFrom);
      if (at < 0) return null;
      newlineOffsets.push(at);
      searchFrom = at + 1;
    }
    const sourceEndings = newlineOffsets.map((_, index) =>
      file.lineEndings?.[firstLine + index] || file.eol || "\n",
    );
    const toOffset = (position) =>
      offsets[position.row - group.startRow] + position.column;
    const lowerBound = (values, value) => {
      let low = 0, high = values.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (values[middle] < value) low = middle + 1;
        else high = middle;
      }
      return low;
    };
    const outputChunks = [];
    const afterLineEndings = [];
    const placements = new Map();
    let outputPosition = { row: 1, column: 0 };
    let outputOffset = 0;
    const appendText = (text) => {
      if (!text) return;
      outputChunks.push(text);
      outputOffset += text.length;
      let from = 0;
      let newline = text.indexOf("\n", from);
      if (newline < 0) {
        outputPosition.column += text.length;
        return;
      }
      while (newline >= 0) {
        outputPosition.row++;
        outputPosition.column = 0;
        from = newline + 1;
        newline = text.indexOf("\n", from);
      }
      outputPosition.column = text.length - from;
    };
    const appendSource = (start, end) => {
      if (end <= start) return;
      appendText(sourceText.slice(start, end));
      let lineBreak = lowerBound(newlineOffsets, start);
      while (lineBreak < newlineOffsets.length && newlineOffsets[lineBreak] < end) {
        afterLineEndings.push(sourceEndings[lineBreak]);
        lineBreak++;
      }
    };
    let sourceOffset = 0;
    for (const edit of group.edits) {
      const start = toOffset(edit.start);
      const end = toOffset(edit.end);
      if (start < sourceOffset || end < start || end > sourceText.length) return null;
      appendSource(sourceOffset, start);
      const beforeReplacement = { ...outputPosition };
      if (edit.cursorId !== null) {
        let placement = null;
        if (edit.cursorOffsetSource !== null) {
          const cursorEnd = Math.min(end, start + edit.cursorOffsetSource);
          placement = this.advancePosition(
            beforeReplacement,
            sourceText.slice(start, cursorEnd),
          );
        } else if (edit.cursorOffset !== null) {
          placement = this.advancePosition(
            beforeReplacement,
            edit.text.slice(0, edit.cursorOffset),
          );
        } else {
          placement = this.advancePosition(beforeReplacement, edit.text);
        }
        placements.set(edit.cursorId, placement);
      }
      appendText(edit.text);
      afterLineEndings.push(...edit.afterLineEndings);
      sourceOffset = end;
    }
    appendSource(sourceOffset, sourceText.length);
    const replacementText = outputChunks.join("");
    const replacementTexts = replacementText.split("\n");
    if (afterLineEndings.length !== replacementTexts.length - 1) return null;
    return { replacementTexts, afterLineEndings, placements };
  }

  deleteBackwardAtSelections({ word = false } = {}) {
    const multi = this.editor.multiCursorController;
    const selections = multi?.getSelections?.() || [];
    if (selections.length < 2) return null;
    const edits = selections.map((selection) => {
      const range = multi.getRange(selection);
      let start = range.start;
      const end = range.end;
      if (multi.isSelected(selection)) return {
        start, end, text: "", cursorId: selection.id, id: selection.id,
      };
      if (word) {
        const lineNode = this.editor.lineController.lines[end.row - 1];
        start = { row: end.row, column: this.getPreviousWordBoundary(lineNode, end.column) };
      } else if (end.column > 0) {
        const lineNode = this.editor.lineController.lines[end.row - 1];
        const index = lineNode?.getPositionIndex?.();
        start = {
          row: end.row,
          column: index?.previous(end.column) ??
            (typeof previousGraphemeBoundary === "function"
              ? previousGraphemeBoundary(lineNode?.getText?.() || "", end.column)
              : Math.max(0, end.column - 1)),
        };
      } else if (end.row > 1) {
        const previous = this.editor.lineController.lines[end.row - 2];
        start = { row: end.row - 1, column: previous?.getText?.().length || 0 };
      }
      return { start, end, text: "", cursorId: selection.id, id: selection.id };
    });
    return this.applyBatchEdits(edits, {
      source: word ? "delete-word" : "delete",
      primaryId: this.editor.tabManager.activeFile._multiCursorPrimaryId,
    });
  }

  deleteForwardAtSelections() {
    const multi = this.editor.multiCursorController;
    const selections = multi?.getSelections?.() || [];
    if (selections.length < 2) return null;
    const lines = this.editor.lineController.lines;
    const edits = selections.map((selection) => {
      const range = multi.getRange(selection);
      if (multi.isSelected(selection)) return {
        start: range.start, end: range.end, text: "", cursorId: selection.id, id: selection.id,
      };
      const start = { ...selection.active };
      const text = lines[start.row - 1]?.getText?.() || "";
      let end = start;
      if (start.column < text.length) {
        const index = lines[start.row - 1]?.getPositionIndex?.();
        end = {
          row: start.row,
          column: index?.next(start.column) ??
            (typeof nextGraphemeBoundary === "function"
              ? nextGraphemeBoundary(text, start.column)
              : start.column + 1),
        };
      } else if (start.row < lines.length) {
        end = { row: start.row + 1, column: 0 };
      }
      return { start, end, text: "", cursorId: selection.id, id: selection.id };
    });
    return this.applyBatchEdits(edits, {
      source: "delete",
      primaryId: this.editor.tabManager.activeFile._multiCursorPrimaryId,
    });
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
