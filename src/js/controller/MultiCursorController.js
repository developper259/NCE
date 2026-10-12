const MULTI_CURSOR_LIMIT = 1024;
const MULTI_OCCURRENCE_LIMIT = MULTI_CURSOR_LIMIT;
const MULTI_OCCURRENCE_SCAN_LIMIT = 16 * 1024 * 1024;

function compareCursorPositions(left, right) {
  return left.row - right.row || left.column - right.column;
}

class MultiCursorController {
  constructor(editor) {
    this.editor = editor;
    this.nextId = 1;
    this.caretPool = [];
    this.selectionPool = [];
    this.caretFastNodes = new WeakMap();
    this.selectionFastNodes = new WeakMap();
    this.renderedCarets = 0;
    this.renderedSelections = 0;
  }

  isEligible(file = this.editor.tabManager?.activeFile) {
    return Boolean(
      file && (file.type === undefined || file.type === "file") &&
      !file.loadError && file.largeFileMode !== true &&
      (!file.loadingState || file.loadingState.status === "loaded") &&
      file.diffActive !== true,
    );
  }

  createPrimary(file) {
    const row = Number.isSafeInteger(file?.row) && file.row > 0 ? file.row : 1;
    const column = Number.isSafeInteger(file?.column) && file.column >= 0
      ? file.column
      : 0;
    let anchor = { row, column };
    let active = { row, column };
    if (file?._selectionRange) {
      anchor = file.startSelect || file._selectionRange.start;
      active = file.endSelect || { row, column };
    } else if (file?.startSelect && file?.endSelect) {
      anchor = file.startSelect;
      active = file.endSelect;
    }
    const id = this.allocateId(file);
    return [{ id, anchor: { ...anchor }, active: { ...active }, preferredVisualColumn: null }];
  }

  allocateId(file) {
    const id = Number.isSafeInteger(file?._multiCursorNextId) && file._multiCursorNextId > 0
      ? file._multiCursorNextId
      : this.nextId++;
    if (file) file._multiCursorNextId = id + 1;
    this.nextId = Math.max(this.nextId, id + 1);
    return id;
  }

  getSelections(file = this.editor.tabManager?.activeFile) {
    if (!file) return [];
    if (!Array.isArray(file._multiSelections) || file._multiSelections.length === 0) {
      const primary = this.createPrimary(file);
      file._multiSelections = primary;
      file._multiCursorPrimaryId = primary[0].id;
      file._multiSelectionsNormalized = true;
    } else if (file._multiSelectionsNormalized !== true) {
      const normalized = this.normalizeSelections(
        file,
        file._multiSelections,
        file._multiCursorPrimaryId,
      );
      file._multiSelections = normalized.selections;
      file._multiCursorPrimaryId = normalized.primaryId;
      file._multiSelectionsNormalized = true;
      if (file === this.editor.tabManager?.activeFile) this.syncLegacyPrimary(file);
    }
    const primaryId = file._multiCursorPrimaryId;
    if (!file._multiSelections.some((item) => item?.id === primaryId))
      file._multiCursorPrimaryId = file._multiSelections[0]?.id;
    return file._multiSelections;
  }

  getPrimarySelection(file = this.editor.tabManager?.activeFile) {
    const selections = this.getSelections(file);
    const primaryId = file?._multiCursorPrimaryId;
    return selections.find((selection) => selection.id === primaryId) || selections[0] || null;
  }

  getSecondarySelections(file = this.editor.tabManager?.activeFile) {
    const primary = this.getPrimarySelection(file);
    return this.getSelections(file).filter((selection) => selection !== primary);
  }

  hasMultipleCursors(file = this.editor.tabManager?.activeFile) {
    return this.getSelections(file).length > 1;
  }

  hasMultipleSelections(file = this.editor.tabManager?.activeFile) {
    return this.getSelections(file).filter((item) =>
      compareCursorPositions(item.anchor, item.active) !== 0,
    ).length > 1;
  }

  isSelected(selection) {
    return Boolean(selection && compareCursorPositions(selection.anchor, selection.active) !== 0);
  }

  getRange(selection) {
    if (!selection) return null;
    return compareCursorPositions(selection.anchor, selection.active) <= 0
      ? { start: selection.anchor, end: selection.active }
      : { start: selection.active, end: selection.anchor };
  }

  normalizePosition(file, position) {
    if (!position || !Number.isFinite(position.row) || !Number.isFinite(position.column))
      return null;
    const lines = file?.lines;
    if (!Array.isArray(lines) || lines.length === 0) return null;
    const row = Math.max(1, Math.min(Math.trunc(position.row), lines.length));
    const lineNode = lines[row - 1];
    const text = lineNode?.getText?.() || "";
    let column = Math.max(0, Math.min(Math.trunc(position.column), text.length));
    const index = lineNode?.getPositionIndex?.();
    if (index) column = index.normalize(column, "nearest");
    else if (typeof normalizeTextBoundary === "function")
      column = normalizeTextBoundary(text, column, "nearest");
    return { row, column };
  }

  normalizeSelections(file, values, primaryId = file?._multiCursorPrimaryId) {
    if (!file || !Array.isArray(values)) return { selections: [], primaryId: null };
    const normalized = [];
    const usedIds = new Set();
    for (const value of values.slice(0, MULTI_CURSOR_LIMIT)) {
      if (!value || typeof value !== "object") continue;
      const anchor = this.normalizePosition(file, value.anchor || value.active);
      const active = this.normalizePosition(file, value.active || value.anchor);
      if (!anchor || !active) continue;
      let id = Number.isSafeInteger(value.id) && value.id > 0 ? value.id : this.allocateId(file);
      if (usedIds.has(id)) id = this.allocateId(file);
      usedIds.add(id);
      normalized.push({
        id,
        anchor,
        active,
        preferredVisualColumn: Number.isFinite(value.preferredVisualColumn) &&
          value.preferredVisualColumn >= 0
          ? Math.trunc(value.preferredVisualColumn)
          : null,
      });
    }
    if (!normalized.length) {
      const primary = this.createPrimary(file);
      return { selections: primary, primaryId: primary[0].id };
    }

    const requestedPrimary = normalized.find((item) => item.id === primaryId) || normalized[0];
    normalized.sort((left, right) => {
      const leftRange = this.getRange(left);
      const rightRange = this.getRange(right);
      return compareCursorPositions(leftRange.start, rightRange.start) ||
        compareCursorPositions(leftRange.end, rightRange.end) || left.id - right.id;
    });

    const merged = [];
    let resultingPrimaryId = requestedPrimary.id;
    for (const current of normalized) {
      const previous = merged[merged.length - 1];
      if (!previous || !this.rangesConflict(previous, current)) {
        merged.push(current);
        continue;
      }
      const previousRange = this.getRange(previous);
      const currentRange = this.getRange(current);
      const unionStart = compareCursorPositions(previousRange.start, currentRange.start) <= 0
        ? previousRange.start : currentRange.start;
      const unionEnd = compareCursorPositions(previousRange.end, currentRange.end) >= 0
        ? previousRange.end : currentRange.end;
      const primaryIsMerged = previous.id === requestedPrimary.id || current.id === requestedPrimary.id;
      const keep = previous.id === requestedPrimary.id
        ? previous
        : current.id === requestedPrimary.id ? current : previous;
      const forward = compareCursorPositions(keep.anchor, keep.active) <= 0;
      keep.anchor = { ...(forward ? unionStart : unionEnd) };
      keep.active = { ...(forward ? unionEnd : unionStart) };
      keep.preferredVisualColumn = null;
      if (primaryIsMerged) resultingPrimaryId = keep.id;
      merged[merged.length - 1] = keep;
    }
    return { selections: merged, primaryId: resultingPrimaryId };
  }

  rangesConflict(left, right) {
    const a = this.getRange(left);
    const b = this.getRange(right);
    const aCollapsed = compareCursorPositions(a.start, a.end) === 0;
    const bCollapsed = compareCursorPositions(b.start, b.end) === 0;
    if (aCollapsed && bCollapsed) return compareCursorPositions(a.start, b.start) === 0;
    if (aCollapsed) return compareCursorPositions(a.start, b.start) >= 0 && compareCursorPositions(a.start, b.end) <= 0;
    if (bCollapsed) return compareCursorPositions(b.start, a.start) >= 0 && compareCursorPositions(b.start, a.end) <= 0;
    return compareCursorPositions(b.start, a.end) < 0;
  }

  setSelections(values, options = {}) {
    const file = options.file || this.editor.tabManager?.activeFile;
    if (!file) return false;
    const normalized = this.normalizeSelections(
      file,
      values,
      options.primaryId ?? file._multiCursorPrimaryId,
    );
    if (!normalized.selections.length) return false;
    file._multiSelections = normalized.selections;
    file._multiCursorPrimaryId = normalized.primaryId;
    file._multiSelectionsNormalized = true;
    file._multiCursorNextId = Math.max(
      Number(file._multiCursorNextId) || 1,
      ...normalized.selections.map((item) => item.id + 1),
    );
    this.syncLegacyPrimary(file, { preserveLineSelection: options.preserveLineSelection === true });
    if (file === this.editor.tabManager?.activeFile) {
      const primary = this.getPrimarySelection(file);
      this.editor.lineController?.setFocusLine?.(primary.active.row);
      if (options.ensureVisible) this.editor.cursorController?.ensureCursorVisible?.();
      if (options.render !== false) {
        this.editor.selectController?.refreshSelectionDOM?.();
        this.refreshOverlays();
      }
      if (options.emitEvent) {
        this.editor.events?.callEvent?.(Events.CURSOR_CHANGE, {
          row: primary.active.row,
          column: primary.active.column,
        });
        this.editor.events?.callEvent?.(Events.ON_SELECT, {
          start: primary.anchor,
          end: primary.active,
        });
      }
    }
    return true;
  }

  syncLegacyPrimary(file, { preserveLineSelection = false } = {}) {
    const primary = this.getPrimarySelection(file);
    if (!primary) return;
    file.row = primary.active.row;
    file.column = primary.active.column;
    file.startSelect = this.isSelected(primary) ? { ...primary.anchor } : undefined;
    file.endSelect = { ...primary.active };
    if (!preserveLineSelection) {
      file._selectedLines?.clear?.();
      file._selectionRange = this.isSelected(primary) ? this.getRange(primary) : null;
    }
    file._selectionTextCache = null;
    file.containsSelected = "";
  }

  syncPrimaryFromCursor(row, column) {
    const file = this.editor.tabManager?.activeFile;
    if (!file) return;
    const existing = this.getPrimarySelection(file);
    const active = this.normalizePosition(file, { row, column });
    if (!existing || !active) return;
    const legacyAnchor = file._selectionRange || file._selectedLines?.size
      ? file.startSelect || existing.anchor
      : active;
    existing.anchor = { ...legacyAnchor };
    existing.active = { ...active };
    existing.preferredVisualColumn = null;
    const normalized = this.normalizeSelections(file, file._multiSelections, existing.id);
    file._multiSelections = normalized.selections;
    file._multiCursorPrimaryId = normalized.primaryId;
  }

  setPrimarySelection(anchor, active, {
    preserveSecondary = false,
    preserveLineSelection = false,
    render = true,
  } = {}) {
    const file = this.editor.tabManager?.activeFile;
    if (!file) return false;
    const existing = this.getSelections(file);
    const primary = this.getPrimarySelection(file);
    const values = preserveSecondary
      ? existing.filter((item) => item.id !== primary?.id)
      : [];
    values.push({
      id: primary?.id || this.allocateId(file),
      anchor,
      active,
      preferredVisualColumn: null,
    });
    return this.setSelections(values, {
      primaryId: primary?.id,
      preserveLineSelection,
      render,
    });
  }

  collapseToPrimary({ preserveSelection = false, render = true } = {}) {
    const file = this.editor.tabManager?.activeFile;
    const primary = this.getPrimarySelection(file);
    if (!file || !primary) return false;
    const position = { ...primary.active };
    return this.setSelections([{
      id: primary.id,
      anchor: preserveSelection ? primary.anchor : position,
      active: position,
      preferredVisualColumn: null,
    }], { primaryId: primary.id, render });
  }

  addCursor(position, { toggle = false, ensureVisible = false } = {}) {
    const file = this.editor.tabManager?.activeFile;
    if (!this.isEligible(file)) return false;
    const active = this.normalizePosition(file, position);
    if (!active) return false;
    const selections = this.getSelections(file);
    const primary = this.getPrimarySelection(file);
    const existing = selections.find((item) =>
      compareCursorPositions(item.anchor, item.active) === 0 &&
      compareCursorPositions(item.active, active) === 0,
    );
    if (toggle && existing && existing.id !== primary?.id) {
      return this.setSelections(
        selections.filter((item) => item.id !== existing.id),
        { primaryId: primary?.id, render: true },
      );
    }
    if (existing) return false;
    if (selections.length >= MULTI_CURSOR_LIMIT) return false;
    const viewPosition = this.editor.cursorController?.getViewPosition?.(
      active.row,
      active.column,
    );
    return this.setSelections([
      ...selections,
      {
        id: this.allocateId(file),
        anchor: active,
        active,
        preferredVisualColumn: viewPosition?.column ?? null,
      },
    ], { primaryId: primary?.id, render: true, ensureVisible });
  }

  addCursorAtClientCoordinates(clientX, clientY, options = {}) {
    const position = this.editor.cursorController?.positionFromClientCoordinates?.(
      clientX,
      clientY,
      true,
    );
    if (!position) return false;
    return this.addCursor(position, options);
  }

  addCursorsVertically(delta) {
    const file = this.editor.tabManager?.activeFile;
    if (!this.isEligible(file) || !Number.isInteger(delta) || Math.abs(delta) !== 1)
      return false;
    const selections = this.getSelections(file);
    if (selections.length >= MULTI_CURSOR_LIMIT) return false;
    const primary = this.getPrimarySelection(file);
    const additions = [];
    for (const selection of selections) {
      const targetRow = selection.active.row + delta;
      if (targetRow < 1 || targetRow > file.lines.length) continue;
      const visualColumn = selection.preferredVisualColumn ??
        this.editor.cursorController.getViewPosition(
          selection.active.row,
          selection.active.column,
        ).column;
      const position = this.editor.cursorController.getPosition(targetRow, visualColumn);
      if (selections.some((item) =>
        !this.isSelected(item) && compareCursorPositions(item.active, position) === 0,
      ) || additions.some((item) => compareCursorPositions(item.active, position) === 0))
        continue;
      additions.push({
        id: this.allocateId(file),
        anchor: position,
        active: position,
        preferredVisualColumn: visualColumn,
      });
      if (selections.length + additions.length >= MULTI_CURSOR_LIMIT) break;
    }
    if (!additions.length) return false;
    return this.setSelections([...selections, ...additions], {
      primaryId: primary?.id,
      render: true,
      ensureVisible: true,
    });
  }

  removeSecondaryCursors({ preservePrimarySelection = true } = {}) {
    return this.collapseToPrimary({
      preserveSelection: preservePrimarySelection,
      render: true,
    });
  }

  clearForFile(file) {
    if (!file) return;
    file._multiSelections = null;
    file._multiCursorPrimaryId = null;
    if (file === this.editor.tabManager?.activeFile) this.refreshOverlays();
  }

  getSelectionText(selection, file = this.editor.tabManager?.activeFile) {
    if (!this.isSelected(selection) || !file) return "";
    const range = this.getRange(selection);
    return this.editor.writerController?.getTextInRange?.(range.start, range.end) || "";
  }

  getSelectedTexts({ includeEmpty = false } = {}) {
    return this.getSelections().filter((selection) =>
      this.isSelected(selection),
    ).map((selection) => this.getSelectionText(selection)).filter((text) =>
      includeEmpty || text.length > 0,
    );
  }

  moveAll(direction, { extend = false } = {}) {
    const file = this.editor.tabManager?.activeFile;
    if (!this.isEligible(file)) return false;
    const selections = this.getSelections(file);
    if (selections.length < 2) return false;
    const primaryBefore = this.getPrimarySelection(file);
    const moved = selections.map((selection) => {
      const range = this.getRange(selection);
      let target = { ...selection.active };
      if (!extend && this.isSelected(selection) &&
          (direction.startsWith("left") || direction.startsWith("right"))) {
        target = { ...(direction.startsWith("left") ? range.start : range.end) };
      } else if (direction === "left" || direction === "left-word") {
        if (direction === "left-word") {
          const lineNode = file.lines[target.row - 1];
          const column = this.editor.writerController.getPreviousWordBoundary(lineNode, target.column);
          if (column < target.column) target.column = column;
          else if (target.row > 1) {
            target.row--;
            target.column = file.lines[target.row - 1]?.getText?.().length || 0;
          }
        } else {
        target = this.positionByCharacter(target, -1);
        }
      } else if (direction === "right" || direction === "right-word") {
        if (direction === "right-word") {
          const lineNode = file.lines[target.row - 1];
          const text = lineNode?.getText?.() || "";
          const column = this.editor.writerController.getNextWordBoundary(lineNode || text, target.column);
          if (column > target.column) target.column = column;
          else if (target.row < file.lines.length) {
            target.row++;
            target.column = 0;
          }
        } else {
        target = this.positionByCharacter(target, 1);
        }
      } else if (direction === "up" || direction === "down") {
        target = this.positionByVisualRow(selection, direction === "up" ? -1 : 1);
      } else if (direction === "home" || direction === "end") {
        const line = file.lines[target.row - 1]?.getText?.() || "";
        target.column = direction === "home" ? 0 : line.length;
      }
      return {
        ...selection,
        anchor: extend ? { ...selection.anchor } : target,
        active: target,
        preferredVisualColumn: direction === "up" || direction === "down"
          ? (selection.preferredVisualColumn ?? this.editor.cursorController.getViewPosition(selection.active.row, selection.active.column).column)
          : null,
      };
    });
    const primary = this.getPrimarySelection(file);
    const changed = this.setSelections(moved, {
      primaryId: primary?.id,
      ensureVisible: true,
      render: false,
    });
    if (changed) {
      const active = this.getPrimarySelection(file)?.active;
      this.editor.cursorController?.setCursorPosition?.(active.row, active.column, {
        emitEvent: false,
        syncMultiCursor: false,
      });
      this.refreshOverlays();
      this.editor.selectController?.refreshSelectionDOM?.();
      this.editor.events?.callEvent?.(Events.CURSOR_CHANGE, {
        row: active.row,
        column: active.column,
      });
      this.editor.events?.callEvent?.(Events.ON_SELECT, {
        start: primaryBefore?.anchor,
        end: active,
      });
    }
    return changed;
  }

  positionByCharacter(position, direction) {
    const lines = this.editor.lineController.lines;
    const lineNode = lines[position.row - 1];
    const text = lineNode?.getText?.() || "";
    if (direction < 0) {
      if (position.column > 0) {
        const index = lineNode?.getPositionIndex?.();
        return {
          row: position.row,
          column: index?.previous(position.column) ??
            (typeof previousGraphemeBoundary === "function"
              ? previousGraphemeBoundary(text, position.column)
              : Math.max(0, position.column - 1)),
        };
      }
      if (position.row > 1) return { row: position.row - 1, column: lines[position.row - 2]?.getText?.().length || 0 };
      return position;
    }
    if (position.column < text.length) {
      const index = lineNode?.getPositionIndex?.();
      return {
        row: position.row,
        column: index?.next(position.column) ??
          (typeof nextGraphemeBoundary === "function"
            ? nextGraphemeBoundary(text, position.column)
            : Math.min(text.length, position.column + 1)),
      };
    }
    if (position.row < lines.length) return { row: position.row + 1, column: 0 };
    return position;
  }

  positionByVisualRow(selection, delta) {
    const file = this.editor.tabManager.activeFile;
    const row = selection.active.row + delta;
    if (row < 1 || row > file.lines.length) return { ...selection.active };
    const desired = selection.preferredVisualColumn ??
      this.editor.cursorController.getViewPosition(
        selection.active.row,
        selection.active.column,
      ).column;
    const position = this.editor.cursorController.getPosition(row, desired);
    return { row: position.row, column: position.column };
  }

  getOccurrenceQuery(primary = this.getPrimarySelection()) {
    if (!primary) return "";
    if (this.isSelected(primary)) return this.getSelectionText(primary);
    const lineNode = this.editor.lineController.lines[primary.active.row - 1];
    const word = this.editor.writerController.getWordRangeAt(
      lineNode || "",
      primary.active.column,
    );
    if (!word || word.end <= word.start) return "";
    return lineNode.getText().slice(word.start, word.end);
  }

  findOccurrences(query, { after = null, excludeSelections = false } = {}) {
    const file = this.editor.tabManager?.activeFile;
    if (!this.isEligible(file) || typeof query !== "string" || !query || query.includes("\n")) return [];
    const lines = file.lines;
    const occurrences = [];
    let scanned = 0;
    const startPosition = after || { row: 1, column: 0 };
    const startRow = Math.max(1, Math.min(startPosition.row, lines.length));
    const startColumn = Math.max(0, startPosition.column);
    const ranges = excludeSelections ? this.getSelections(file).map((item) => this.getRange(item)) : [];
    const scanPart = (row, from, stopAtLimit) => {
      const text = lines[row - 1]?.getText?.() || "";
      const limit = stopAtLimit ? startColumn : text.length;
      const scanStart = Math.min(from, limit);
      const remainingBudget = MULTI_OCCURRENCE_SCAN_LIMIT - scanned;
      if (remainingBudget <= 0 || scanStart > limit - query.length) return;
      const scanEnd = Math.min(limit, scanStart + remainingBudget + query.length - 1);
      const searchableText = text.slice(scanStart, scanEnd);
      let at = 0;
      scanned += scanEnd - scanStart;
      while (at <= searchableText.length - query.length && occurrences.length < MULTI_OCCURRENCE_LIMIT) {
        const relative = searchableText.indexOf(query, at);
        if (relative < 0) break;
        const found = scanStart + relative;
        if (found + query.length > limit) break;
        const lineNode = lines[row - 1];
        const index = lineNode?.getPositionIndex?.();
        const start = { row, column: index?.normalize(found, "nearest") ?? found };
        const endOffset = found + query.length;
        const end = { row, column: index?.normalize(endOffset, "nearest") ?? endOffset };
        if (end.column - start.column === query.length && text.slice(start.column, end.column) === query) {
          const range = { start, end };
          const overlaps = ranges.some((existing) =>
            compareCursorPositions(range.start, existing.end) < 0 &&
            compareCursorPositions(existing.start, range.end) < 0,
          );
          if (!overlaps) occurrences.push(range);
        }
        at = relative + Math.max(1, query.length);
      }
    };
    for (let row = startRow; row <= lines.length && occurrences.length < MULTI_OCCURRENCE_LIMIT; row++)
      scanPart(row, row === startRow ? startColumn : 0, false);
    for (let row = 1; row <= startRow && occurrences.length < MULTI_OCCURRENCE_LIMIT; row++)
      scanPart(row, 0, row === startRow);
    return occurrences;
  }

  addNextOccurrence() {
    const file = this.editor.tabManager?.activeFile;
    const primary = this.getPrimarySelection(file);
    if (this.getSelections(file).length >= MULTI_CURSOR_LIMIT) return false;
    const query = this.getOccurrenceQuery(primary);
    if (!primary || !query) return false;
    const range = this.getRange(primary);
    const hadSelection = this.isSelected(primary);
    let currentWordRange = null;
    let after = range.end;
    if (!hadSelection) {
      const lineNode = file.lines[primary.active.row - 1];
      const word = this.editor.writerController.getWordRangeAt(
        lineNode || "",
        primary.active.column,
      );
      if (word && word.end > word.start) {
        currentWordRange = {
          start: { row: primary.active.row, column: word.start },
          end: { row: primary.active.row, column: word.end },
        };
        after = currentWordRange.end;
      }
    }
    const occurrences = this.findOccurrences(query, {
      after,
      excludeSelections: true,
    });
    const next = occurrences.find((candidate) => !currentWordRange ||
      compareCursorPositions(candidate.start, currentWordRange.start) !== 0 ||
      compareCursorPositions(candidate.end, currentWordRange.end) !== 0,
    );
    if (!next) return false;
    return this.setSelections([
      ...this.getSelections(file),
      {
        id: this.allocateId(file),
        anchor: next.start,
        active: next.end,
        preferredVisualColumn: null,
      },
    ], { primaryId: primary.id, render: true, ensureVisible: false });
  }

  selectAllOccurrences() {
    const file = this.editor.tabManager?.activeFile;
    const primary = this.getPrimarySelection(file);
    const query = this.getOccurrenceQuery(primary);
    if (!primary || !query) return false;
    const occurrences = this.findOccurrences(query);
    if (!occurrences.length) return false;
    const oldPrimaryRange = this.getRange(primary);
    const matchingPrimary = occurrences.find((range) =>
      compareCursorPositions(range.start, oldPrimaryRange.start) === 0 &&
      compareCursorPositions(range.end, oldPrimaryRange.end) === 0,
    ) || occurrences[0];
    const selections = occurrences.map((range) => ({
      id: this.allocateId(file),
      anchor: range.start,
      active: range.end,
      preferredVisualColumn: null,
    }));
    const primarySelection = selections.find((selection) =>
      compareCursorPositions(selection.anchor, matchingPrimary.start) === 0,
    ) || selections[0];
    return this.setSelections(selections, {
      primaryId: primarySelection.id,
      render: true,
    });
  }

  refreshOverlays() {
    if (!this.editor.multiCursorCaretOutput || !this.editor.multiCursorSelectionOutput) return;
    const file = this.editor.tabManager?.activeFile;
    if (!this.isEligible(file)) {
      this.hidePool(this.caretPool, 0);
      this.hidePool(this.selectionPool, 0);
      this.renderedCarets = 0;
      this.renderedSelections = 0;
      return;
    }
    const cursor = this.editor.cursorController;
    const lineController = this.editor.lineController;
    const selections = this.getSelections(file);
    const primaryId = file._multiCursorPrimaryId;
    const startIndex = lineController.startIndex || 0;
    const visibleCount = lineController.renderedLineCount || lineController.maxViewLines || 0;
    const endIndex = Math.min(lineController.getDisplayLineCount(), startIndex + visibleCount);
    let caretCount = 0;
    let selectionCount = 0;
    const viewportStart = lineController.offsetX || 0;
    const viewportEnd = viewportStart + (lineController.maxCharactersPerLine || Number.MAX_SAFE_INTEGER);

    for (const selection of selections) {
      if (selection.id === primaryId) continue;
      if (!this.isSelected(selection)) {
        const position = selection.active;
        const displayIndex = lineController.getDisplayIndexForCursor(position.row);
        const screenRow = displayIndex - startIndex;
        if (screenRow < 0 || screenRow >= visibleCount) continue;
        const viewColumn = cursor.getViewPosition(position.row, position.column).column;
        if (viewColumn < viewportStart || viewColumn > viewportEnd) continue;
        const node = this.getPooledNode(this.caretPool, caretCount++, "editor-secondary-caret", this.caretFastNodes, this.editor.multiCursorCaretOutput);
        const top = cursor.rowToY(position.row) - 4 - lineController.offsetY;
        const left = cursor.columnToX(viewColumn);
        this.setNodeRect(node, left, top, 2, cursor.mpY);
        continue;
      }
      const range = this.getRange(selection);
      const firstDisplay = lineController.getDisplayIndexForCursor(range.start.row);
      const lastDisplay = lineController.getDisplayIndexForCursor(range.end.row);
      const first = Math.max(startIndex, firstDisplay);
      const last = Math.min(endIndex - 1, lastDisplay);
      for (let displayIndex = first; displayIndex <= last; displayIndex++) {
        const displayRow = lineController.getDisplayRow(displayIndex);
        if (!Number.isInteger(displayRow?.documentIndex)) continue;
        const row = displayRow.documentIndex + 1;
        const text = file.lines[row - 1]?.getText?.() || "";
        const realStart = row === range.start.row ? range.start.column : 0;
        const realEnd = row === range.end.row ? range.end.column : text.length;
        const visualStart = cursor.getViewPosition(row, realStart).column;
        const visualEnd = cursor.getViewPosition(row, realEnd).column;
        const leftColumn = Math.max(visualStart, viewportStart);
        const rightColumn = Math.min(visualEnd, viewportEnd);
        if (rightColumn < leftColumn || (rightColumn === leftColumn && realStart !== realEnd)) continue;
        const node = this.getPooledNode(this.selectionPool, selectionCount++, "selected editor-secondary-selection", this.selectionFastNodes, this.editor.multiCursorSelectionOutput);
        const left = cursor.columnToX(leftColumn + 1);
        const top = cursor.rowToY(row) - 4 - lineController.offsetY;
        const width = Math.max(1, rightColumn - leftColumn) * this.editor.letterSize;
        this.setNodeRect(node, left, top, width, cursor.mpY);
      }
    }
    this.hidePool(this.caretPool, caretCount);
    this.hidePool(this.selectionPool, selectionCount);
    this.renderedCarets = caretCount;
    this.renderedSelections = selectionCount;
  }

  getPooledNode(pool, index, className, fastNodes, parent) {
    let node = pool[index];
    if (!node) {
      node = document.createElement("div");
      node.className = className;
      node.style.position = "absolute";
      parent.appendChild(node);
      pool.push(node);
    }
    node.className = className;
    const fast = fastNodes.get(node) || this.editor.domManager?.wrapFastNode?.(node) || null;
    if (fast) fastNodes.set(node, fast);
    if (fast) fast.setDisplay("block");
    else node.style.display = "block";
    return node;
  }

  setNodeRect(node, left, top, width, height) {
    const fast = this.editor.domManager?.wrapFastNode?.(node);
    if (fast) {
      fast.setLeft(left);
      fast.setTop(top);
      fast.setWidth(width);
      fast.setHeight(height);
    } else {
      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
      node.style.width = `${width}px`;
      node.style.height = `${height}px`;
    }
  }

  hidePool(pool, start) {
    for (let index = start; index < pool.length; index++) {
      const node = pool[index];
      const fast = this.editor.domManager?.wrapFastNode?.(node);
      if (fast) fast.setDisplay("none");
      else node.style.display = "none";
    }
  }
}
