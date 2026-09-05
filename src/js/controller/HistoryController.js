class HistoryController {
  constructor(editor) {
    this.editor = editor;
    this.states = new WeakMap();
    this.isReplaying = false;
    this.maxEntries = 1000;
    this.maxTextBudget = 2 * 1024 * 1024;
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
    if (this.isReplaying || !entry || entry.beforeText === entry.afterText)
      return;
    const file = this.editor.tabManager.activeFile;
    const state = this.getState(file);
    if (!state) return;

    if (state.index < state.entries.length) {
      state.entries.splice(state.index);
      if (state.savedIndex > state.index) state.savedIndex = -1;
    }

    const previous = state.entries[state.index - 1];
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
      previous.cursorAfter = entry.cursorAfter;
    } else {
      state.entries.push(entry);
      state.index += 1;
      state.textBudget += this.entrySize(entry);
    }

    this.trim(state);
    this.updateSavedState(file, state);
  }

  entrySize(entry) {
    return (
      String(entry.beforeText || "").length +
      String(entry.afterText || "").length
    );
  }

  trim(state) {
    while (
      state.entries.length > this.maxEntries ||
      state.textBudget > this.maxTextBudget
    ) {
      const removed = state.entries.shift();
      state.textBudget -= this.entrySize(removed);
      state.index = Math.max(0, state.index - 1);
      if (state.savedIndex >= 0) state.savedIndex -= 1;
      if (state.savedIndex < 0) state.savedIndex = -1;
    }
  }

  updateSavedState(file, state) {
    if (!file) return;
    file.setIsSaved(state.savedIndex >= 0 && state.index === state.savedIndex);
  }

  markSaved(file = this.editor.tabManager.activeFile) {
    const state = this.getState(file);
    if (!state) return;
    state.savedIndex = state.index;
    this.updateSavedState(file, state);
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
    const state = this.getState(file);
    if (!state || state.index === 0) return false;
    const entry = state.entries[state.index - 1];
    state.index -= 1;
    await this.replay(entry, false);
    this.updateSavedState(file, state);
    return true;
  }

  async redo() {
    const file = this.editor.tabManager.activeFile;
    const state = this.getState(file);
    if (!state || state.index >= state.entries.length) return false;
    const entry = state.entries[state.index];
    state.index += 1;
    await this.replay(entry, true);
    this.updateSavedState(file, state);
    return true;
  }

  async replay(entry, redo) {
    const text = redo ? entry.afterText : entry.beforeText;
    const replaced = redo ? entry.beforeText : entry.afterText;
    const end = this.editor.writerController.advancePosition(
      entry.start,
      replaced,
    );
    this.isReplaying = true;
    try {
      this.editor.writerController.applyRangeEdit(entry.start, end, text, {
        recordHistory: false,
        source: "history",
        ensureVisible: true,
        cursor: redo ? entry.cursorAfter : entry.cursorBefore,
        selection: redo ? entry.selectionAfter : entry.selectionBefore,
      });
    } finally {
      this.isReplaying = false;
    }
  }
}
