class HistoryController {
  constructor(editor) {
    this.editor = editor;
    this.states = new WeakMap();
    this.isReplaying = false;
    this.maxEntries = 1000;
    this.maxTextBudget = 2 * 1024 * 1024;
    // Keep the ordinary history bounded while allowing one transaction near
    // WriterController's 32 MiB batch insertion limit to remain undoable.
    this.maxSingleEntryTextBudget = 34 * 1024 * 1024;
  }

  getState(file = this.editor.tabManager.activeFile) {
    if (!file) return null;
    let state = this.states.get(file);
    if (!state) {
      state = { entries: [], index: 0, savedIndex: 0, textBudget: 0 };
      this.states.set(file, state);
    }
    return state;
  }

  record(entry) {
    if (this.isReplaying || !entry) return;
    if (entry.type === "batch") {
      if (!Array.isArray(entry.edits) || !entry.edits.some((edit) =>
        edit.beforeText !== edit.afterText ||
        JSON.stringify(edit.beforeLineEndings) !== JSON.stringify(edit.afterLineEndings),
      )) return;
    } else if (entry.beforeText === entry.afterText) return;
    const file = this.editor.tabManager.activeFile;
    const state = this.getState(file);
    if (!state) return;
    if (!this.canRecordEntry(entry, file, state)) return false;

    if (state.index < state.entries.length) {
      for (const removed of state.entries.splice(state.index)) state.textBudget -= this.entrySize(removed);
      if (state.savedIndex > state.index) state.savedIndex = -1;
    }

    const previous = state.entries[state.index - 1];
    if (entry.type === "batch") {
      if (this.canGroupBatchTyping(previous, entry, state)) {
        const previousSize = this.entrySize(previous);
        const previousById = new Map(previous.edits.map((edit) => [edit.cursorId, edit]));
        for (const edit of entry.edits) {
          const previousEdit = previousById.get(edit.cursorId);
          previousEdit.afterText += edit.afterText;
          previousEdit.afterLineEndings.push(...edit.afterLineEndings);
        }
        previous.selectionsAfter = entry.selectionsAfter;
        previous.primaryIdAfter = entry.primaryIdAfter;
        previous.cursorAfter = entry.cursorAfter;
        previous.timestamp = entry.timestamp;
        state.textBudget += this.entrySize(previous) - previousSize;
      } else {
        state.entries.push(entry);
        state.index += 1;
        state.textBudget += this.entrySize(entry);
      }
      this.trim(state);
      this.updateSavedState(file, state);
      return true;
    }
    const canGroup =
      entry.source === "typing" &&
      previous?.source === "typing" &&
      entry.beforeText === "" &&
      previous.afterText !== "" &&
      state.index !== state.savedIndex &&
      previous.start.row === entry.start.row &&
      previous.start.column + previous.afterText.length === entry.start.column;

    if (canGroup) {
      previous.afterText += entry.afterText;
      state.textBudget += this.entrySize(entry);
      previous.cursorAfter = entry.cursorAfter;
    } else {
      state.entries.push(entry);
      state.index += 1;
      state.textBudget += this.entrySize(entry);
    }

    this.trim(state);
    this.updateSavedState(file, state);
    return true;
  }

  canRecordEntry(entry, file = this.editor.tabManager.activeFile, state = this.getState(file)) {
    if (!entry || !state) return false;
    const previous = state.entries[state.index - 1];
    let retainedSize = this.entrySize(entry);
    if (entry.type === "batch" && this.canGroupBatchTyping(previous, entry, state)) {
      // A grouped batch keeps the original before-text and adds this transaction's
      // after-text. Summing is conservative because it also counts the repeated
      // selection snapshots that grouping replaces.
      retainedSize += this.entrySize(previous);
    } else if (
      entry.type !== "batch" && entry.source === "typing" &&
      previous?.source === "typing" && entry.beforeText === "" &&
      previous.afterText !== "" && state.index !== state.savedIndex &&
      previous.start.row === entry.start.row &&
      previous.start.column + previous.afterText.length === entry.start.column
    ) {
      retainedSize += this.entrySize(previous);
    }
    return retainedSize <= this.maxSingleEntryTextBudget;
  }

  entrySize(entry) {
    if (entry?.type === "batch") {
      let size = 0;
      for (const edit of entry.edits || []) {
        size += String(edit.beforeText || "").length + String(edit.afterText || "").length;
        size += (edit.beforeLineEndings || []).reduce((sum, ending) => sum + ending.length, 0);
        size += (edit.afterLineEndings || []).reduce((sum, ending) => sum + ending.length, 0);
      }
      size += ((entry.selectionsBefore?.length || 0) + (entry.selectionsAfter?.length || 0)) * 48;
      return size;
    }
    return (
      String(entry.beforeText || "").length +
      String(entry.afterText || "").length
    );
  }

  trim(state) {
    while (
      state.entries.length > this.maxEntries ||
      (state.textBudget > this.maxTextBudget && state.entries.length > 1)
    ) {
      const removed = state.entries.shift();
      state.textBudget -= this.entrySize(removed);
      state.index = Math.max(0, state.index - 1);
      if (state.savedIndex >= 0) state.savedIndex -= 1;
      if (state.savedIndex < 0) state.savedIndex = -1;
    }
  }

  updateSavedState(file, state, { clearRecovery = true } = {}) {
    if (!file) return;
    const isSaved = state.savedIndex >= 0 && state.index === state.savedIndex;
    file.setIsSaved(isSaved);
    if (isSaved && clearRecovery)
      void file.clearRecoverySnapshot?.();
  }

  markSaved(file = this.editor.tabManager.activeFile) {
    const state = this.getState(file);
    if (!state) return;
    state.savedIndex = state.index;
    this.updateSavedState(file, state, { clearRecovery: false });
  }

  markUnsavedBaseline(file = this.editor.tabManager.activeFile) {
    const state = this.getState(file);
    if (!state) return;
    state.savedIndex = -1;
    this.updateSavedState(file, state, { clearRecovery: false });
  }

  clear(file = this.editor.tabManager.activeFile) {
    if (!file) return;
    this.states.set(file, {
      entries: [],
      index: 0,
      savedIndex: 0,
      textBudget: 0,
    });
    file.setIsSaved(true);
  }

  canUndo(file = this.editor.tabManager.activeFile) {
    return Boolean(this.getState(file)?.index > 0);
  }

  canRedo(file = this.editor.tabManager.activeFile) {
    const state = this.getState(file);
    return Boolean(state && state.index < state.entries.length);
  }

  isAtSavePoint(file = this.editor.tabManager.activeFile) {
    const state = this.getState(file);
    return Boolean(
      state && state.savedIndex >= 0 && state.index === state.savedIndex,
    );
  }

  async undo() {
    const file = this.editor.tabManager.activeFile;
    if (file?.isDiffView) return false;
    const state = this.getState(file);
    if (!state || state.index === 0) return false;
    const entry = state.entries[state.index - 1];
    if (!(await this.replay(entry, false))) return false;
    state.index -= 1;
    this.updateSavedState(file, state);
    return true;
  }

  async redo() {
    const file = this.editor.tabManager.activeFile;
    if (file?.isDiffView) return false;
    const state = this.getState(file);
    if (!state || state.index >= state.entries.length) return false;
    const entry = state.entries[state.index];
    if (!(await this.replay(entry, true))) return false;
    state.index += 1;
    this.updateSavedState(file, state);
    return true;
  }

  async replay(entry, redo) {
    if (entry?.type === "batch") return this.replayBatch(entry, redo);
    const text = redo ? entry.afterText : entry.beforeText;
    const replaced = redo ? entry.beforeText : entry.afterText;
    const end = this.editor.writerController.advancePosition(
      entry.start,
      replaced,
    );
    this.isReplaying = true;
    try {
      const result = this.editor.writerController.applyRangeEdit(entry.start, end, text, {
        recordHistory: false,
        lineEndings: redo ? entry.afterLineEndings : entry.beforeLineEndings,
        source: "history",
        ensureVisible: true,
        cursor: redo ? entry.cursorAfter : entry.cursorBefore,
        selection: redo ? entry.selectionAfter : entry.selectionBefore,
      });
      return result !== null;
    } finally {
      this.isReplaying = false;
    }
  }

  canGroupBatchTyping(previous, entry, state) {
    if (
      previous?.type !== "batch" || previous.source !== "typing" ||
      entry.source !== "typing" || state.index === state.savedIndex ||
      previous.edits.length !== entry.edits.length ||
      !this.sameSelectionSnapshot(previous.selectionsAfter, entry.selectionsBefore)
    ) return false;
    const priorById = new Map(previous.edits.map((edit) => [edit.cursorId, edit]));
    return entry.edits.every((edit) => {
      const prior = priorById.get(edit.cursorId);
      return prior && prior.beforeText === "" && edit.beforeText === "" &&
        !edit.afterText.includes("\n") &&
        !prior.afterText.includes("\n") && prior.cursorAtEnd !== false;
    });
  }

  sameSelectionSnapshot(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length)
      return false;
    const rightById = new Map(right.map((selection) => [selection.id, selection]));
    return left.every((selection) => {
      const candidate = rightById.get(selection.id);
      return candidate &&
        selection.anchor.row === candidate.anchor.row &&
        selection.anchor.column === candidate.anchor.column &&
        selection.active.row === candidate.active.row &&
        selection.active.column === candidate.active.column;
    });
  }

  replayBatch(entry, redo) {
    const writer = this.editor.writerController;
    const edits = [];
    for (let index = 0; index < entry.edits.length; index++) {
      const edit = entry.edits[index];
      let start = { ...edit.start };
      if (!redo) {
        for (let previousIndex = 0; previousIndex < index; previousIndex++)
          start = this.transformPositionAfterEdit(start, entry.edits[previousIndex]);
      }
      const sourceText = redo ? edit.beforeText : edit.afterText;
      const replacementText = redo ? edit.afterText : edit.beforeText;
      edits.push({
        id: edit.id,
        cursorId: edit.cursorId,
        start,
        end: writer.advancePosition(start, sourceText),
        text: replacementText,
        lineEndings: redo ? edit.afterLineEndings : edit.beforeLineEndings,
      });
    }
    this.isReplaying = true;
    try {
      const result = writer.applyBatchEdits(edits, {
        recordHistory: false,
        source: "history",
        ensureVisible: true,
        resultSelections: redo ? entry.selectionsAfter : entry.selectionsBefore,
        resultPrimaryId: redo ? entry.primaryIdAfter : entry.primaryIdBefore,
      });
      return result !== null;
    } finally {
      this.isReplaying = false;
    }
  }

  transformPositionAfterEdit(position, edit) {
    const compare = (left, right) => left.row - right.row || left.column - right.column;
    const end = this.editor.writerController.advancePosition(edit.start, edit.beforeText);
    if (compare(position, end) < 0) return position;
    const replacement = String(edit.afterText || "").split("\n");
    const removedRows = end.row - edit.start.row;
    const rowDelta = replacement.length - 1 - removedRows;
    if (position.row > end.row) return { row: position.row + rowDelta, column: position.column };
    if (position.row < end.row) return position;
    if (replacement.length === 1) {
      return {
        row: edit.start.row,
        column: edit.start.column + replacement[0].length + (position.column - end.column),
      };
    }
    return {
      row: edit.start.row + replacement.length - 1,
      column: replacement[replacement.length - 1].length + (position.column - end.column),
    };
  }
}
