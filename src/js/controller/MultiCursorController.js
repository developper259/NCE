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
    if (file._multiSelectionsNormalized === true &&
        file._multiSelections.length === 1 &&
        file._multiSelections[0]?.id === primaryId) return file._multiSelections;
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

  getSelectionOverlaySegment(range, displayIndex, viewportStart, viewportEnd) {
    const lineController = this.editor.lineController;
    const displayRow = lineController.getDisplayRow(displayIndex);
    if (!Number.isInteger(displayRow?.documentIndex)) return null;

    const row = displayRow.documentIndex + 1;
    if (row < range.start.row || row > range.end.row) return null;
    const file = this.editor.tabManager?.activeFile;
    const text = file?.lines[row - 1]?.getText?.() || "";
    const realStart = row === range.start.row ? range.start.column : 0;
    const realEnd = row === range.end.row ? range.end.column : text.length;
    const visualStart = this.getOverlayViewPosition(row, realStart).column;
    const visualEnd = this.getOverlayViewPosition(row, realEnd).column;
    const leftColumn = Math.max(visualStart, viewportStart);
    const rightColumn = Math.min(
      Math.max(visualEnd, visualStart + 1),
      viewportEnd,
    );

    if (rightColumn <= leftColumn) return null;
    return { row, leftColumn, rightColumn };
  }

  getOverlayViewPosition(row, column) {
    return this.overlayViewPositionCache?.get(row)?.get(column) ||
      this.editor.cursorController.getViewPosition(row, column);
  }

  setSelectionCornerRadii(node, { topLeft, topRight, bottomLeft, bottomRight }) {
    const fast = this.selectionFastNodes.get(node);
    if (fast) {
      fast.setStyle("borderTopLeftRadius", topLeft ? "4px" : "0px");
      fast.setStyle("borderTopRightRadius", topRight ? "4px" : "0px");
      fast.setStyle("borderBottomLeftRadius", bottomLeft ? "4px" : "0px");
      fast.setStyle("borderBottomRightRadius", bottomRight ? "4px" : "0px");
      return;
    }
    node.style.borderTopLeftRadius = topLeft ? "4px" : "0px";
    node.style.borderTopRightRadius = topRight ? "4px" : "0px";
    node.style.borderBottomLeftRadius = bottomLeft ? "4px" : "0px";
    node.style.borderBottomRightRadius = bottomRight ? "4px" : "0px";
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
    if (!existing) return;
    const active = { row, column };
    const legacyAnchor = file._selectionRange || file._selectedLines?.size
      ? file.startSelect || existing.anchor || active
      : active;
    if (!existing.anchor) existing.anchor = {};
    if (!existing.active) existing.active = {};
    existing.anchor.row = legacyAnchor.row;
    existing.anchor.column = legacyAnchor.column;
    existing.active.row = active.row;
    existing.active.column = active.column;
    existing.preferredVisualColumn = null;
    if (file._multiSelectionsNormalized === true && file._multiSelections.length === 1)
      return;
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
    const columnsByRow = new Map();
    const addPosition = (position) => {
      let columns = columnsByRow.get(position.row);
      if (!columns) columnsByRow.set(position.row, columns = new Set());
      if (columns.has(position.column)) return false;
      columns.add(position.column);
      return true;
    };
    for (const selection of selections) {
      if (!this.isSelected(selection)) addPosition(selection.active);
    }
    for (const selection of selections) {
      const targetRow = selection.active.row + delta;
      if (targetRow < 1 || targetRow > file.lines.length) continue;
      const visualColumn = selection.preferredVisualColumn ??
        this.editor.cursorController.getViewPosition(
          selection.active.row,
          selection.active.column,
        ).column;
      const position = this.editor.cursorController.getPosition(targetRow, visualColumn);
      if (!addPosition(position)) continue;
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

  createOccurrenceExclusionIndex(file) {
    const intervalsByRow = new Map();
    const fullySelectedRows = [];
    const addInterval = (row, start, end) => {
      const intervals = intervalsByRow.get(row) || [];
      intervals.push({ start, end });
      intervalsByRow.set(row, intervals);
    };

    for (const selection of this.getSelections(file)) {
      if (!this.isSelected(selection)) continue;
      const { start, end } = this.getRange(selection);
      if (start.row === end.row) {
        addInterval(start.row, start.column, end.column);
      } else {
        addInterval(start.row, start.column, Number.POSITIVE_INFINITY);
        addInterval(end.row, 0, end.column);
        if (end.row - start.row > 1)
          fullySelectedRows.push({ start: start.row + 1, end: end.row - 1 });
      }
    }

    for (const [row, intervals] of intervalsByRow) {
      intervals.sort((left, right) => left.start - right.start || left.end - right.end);
      const merged = [];
      for (const interval of intervals) {
        const previous = merged[merged.length - 1];
        if (!previous || interval.start > previous.end) {
          merged.push({ ...interval });
        } else {
          previous.end = Math.max(previous.end, interval.end);
        }
      }
      intervalsByRow.set(row, merged);
    }
    fullySelectedRows.sort((left, right) => left.start - right.start);
    const mergedRows = [];
    for (const range of fullySelectedRows) {
      const previous = mergedRows[mergedRows.length - 1];
      if (!previous || range.start > previous.end + 1) {
        mergedRows.push({ ...range });
      } else {
        previous.end = Math.max(previous.end, range.end);
      }
    }
    return { intervalsByRow, fullySelectedRows: mergedRows };
  }

  isOccurrenceExcluded(row, start, end, index) {
    const rows = index.fullySelectedRows;
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (rows[middle].start <= row) low = middle + 1;
      else high = middle;
    }
    if (low > 0 && rows[low - 1].end >= row) return true;

    const intervals = index.intervalsByRow.get(row) || [];
    low = 0;
    high = intervals.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (intervals[middle].end <= start) low = middle + 1;
      else high = middle;
    }
    return low < intervals.length && intervals[low].start < end;
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
    const exclusionIndex = excludeSelections
      ? this.createOccurrenceExclusionIndex(file)
      : null;
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
          const overlaps = exclusionIndex && this.isOccurrenceExcluded(
            row,
            range.start.column,
            range.end.column,
            exclusionIndex,
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
    if (!this.isSelected(primary)) {
      const lineNode = file.lines[primary.active.row - 1];
      const word = this.editor.writerController.getWordRangeAt(
        lineNode || "",
        primary.active.column,
      );
      if (word && word.end > word.start) {
        const currentWordRange = {
          start: { row: primary.active.row, column: word.start },
          end: { row: primary.active.row, column: word.end },
        };
        const selections = this.getSelections(file).map((selection) =>
          selection.id === primary.id
            ? {
              ...selection,
              anchor: { ...currentWordRange.start },
              active: { ...currentWordRange.end },
              preferredVisualColumn: null,
            }
            : selection,
        );
        if (!this.setSelections(selections, {
          primaryId: primary.id,
          render: true,
          ensureVisible: true,
        })) return false;
        this.editor.cursorController?.setCursorPosition?.(
          currentWordRange.end.row,
          currentWordRange.end.column,
          {
            emitEvent: false,
            syncMultiCursor: false,
            renderMultiCursor: false,
          },
        );
        this.editor.selectController?.refreshSelectionDOM?.();
        return true;
      }
      return false;
    }
    const occurrences = this.findOccurrences(query, {
      after: this.getRange(primary).end,
      excludeSelections: true,
    });
    const next = occurrences[0];
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
    if (selections.length <= 1) {
      if (this.renderedCarets > 0) this.hidePool(this.caretPool, 0);
      if (this.renderedSelections > 0) this.hidePool(this.selectionPool, 0);
      this.renderedCarets = 0;
      this.renderedSelections = 0;
      return;
    }
    const startIndex = lineController.startIndex || 0;
    const viewportLines = Number.isFinite(lineController.maxViewLines)
      ? lineController.maxViewLines
      : (lineController.renderedLineCount || 0);
    const visibleCount = Math.min(
      viewportLines + 1,
      lineController.getDisplayLineCount() - startIndex,
    );
    const endIndex = Math.min(lineController.getDisplayLineCount(), startIndex + visibleCount);
    let caretCount = 0;
    let selectionCount = 0;
    const viewportStart = lineController.offsetX || 0;
    const viewportEnd = viewportStart + (lineController.maxCharactersPerLine || Number.MAX_SAFE_INTEGER);
    const selectionSegments = new Map();
    const segmentsByDisplayIndex = new Map();
    const caretRects = [];
    const selectionRects = [];
    const viewPositionsByRow = new Map();
    const caretPositionsByRow = new Map();
    this.overlayViewPositionCache = viewPositionsByRow;
    const getCachedPosition = (cache, row, column, read) => {
      let rowCache = cache.get(row);
      if (!rowCache) cache.set(row, rowCache = new Map());
      if (rowCache.has(column)) return rowCache.get(column);
      const position = read(row, column);
      rowCache.set(column, position);
      return position;
    };
    const getCaretPosition = (row, column) => getCachedPosition(
      caretPositionsByRow,
      row,
      column,
      (line, offset) => cursor.getCaretPosition(line, offset),
    );

    for (const selection of selections) {
      if (!this.isSelected(selection)) continue;
      const range = this.getRange(selection);
      const firstDisplay = Math.max(
        startIndex,
        lineController.getDisplayIndexForCursor(range.start.row),
      );
      const lastDisplay = Math.min(
        endIndex - 1,
        lineController.getDisplayIndexForCursor(range.end.row),
      );
      const segments = [];
      for (let displayIndex = firstDisplay; displayIndex <= lastDisplay; displayIndex++) {
        const segment = this.getSelectionOverlaySegment(
          range,
          displayIndex,
          viewportStart,
          viewportEnd,
        );
        if (!segment) continue;
        segment.displayIndex = displayIndex;
        segments.push(segment);
        const rowSegments = segmentsByDisplayIndex.get(displayIndex) || [];
        rowSegments.push(segment);
        segmentsByDisplayIndex.set(displayIndex, rowSegments);
      }
      selectionSegments.set(selection.id, segments);
    }

    const edgeIndexByDisplayIndex = new Map();
    for (const [displayIndex, rowSegments] of segmentsByDisplayIndex) {
      const starts = new Set();
      const ends = new Set();
      const intervals = rowSegments
        .map(({ leftColumn, rightColumn }) => ({ start: leftColumn, end: rightColumn }))
        .sort((left, right) => left.start - right.start || left.end - right.end);
      const merged = [];
      for (const interval of intervals) {
        starts.add(interval.start);
        ends.add(interval.end);
        const previous = merged[merged.length - 1];
        if (!previous || interval.start > previous.end) {
          merged.push({ ...interval });
        } else {
          previous.end = Math.max(previous.end, interval.end);
        }
      }
      edgeIndexByDisplayIndex.set(displayIndex, { starts, ends, intervals: merged });
    }
    const coversPoint = (displayIndex, point, { includeStart, includeEnd }) => {
      const intervals = edgeIndexByDisplayIndex.get(displayIndex)?.intervals || [];
      let low = 0;
      let high = intervals.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (includeStart ? intervals[middle].start <= point : intervals[middle].start < point)
          low = middle + 1;
        else high = middle;
      }
      const interval = intervals[low - 1];
      return Boolean(interval && (includeEnd ? interval.end >= point : interval.end > point));
    };

    for (const selection of selections) {
      if (selection.id === primaryId) continue;
      const position = selection.active;
      const displayIndex = lineController.getDisplayIndexForCursor(position.row);
      if (displayIndex >= startIndex && displayIndex < endIndex) {
        const caretPosition = getCaretPosition(position.row, position.column);
        if (
          caretPosition.viewColumn >= viewportStart &&
          caretPosition.viewColumn <= viewportEnd
        ) {
          caretRects.push({
            left: caretPosition.left,
            top: caretPosition.top,
            width: 2,
            height: cursor.editor.posY,
          });
        }
      }
      if (!this.isSelected(selection)) continue;

      for (const segment of selectionSegments.get(selection.id) || []) {
        const { displayIndex, row, leftColumn, rightColumn } = segment;
        const edgeIndex = edgeIndexByDisplayIndex.get(displayIndex);
        const connectedOnLeft = edgeIndex?.ends.has(leftColumn) || false;
        const connectedOnRight = edgeIndex?.starts.has(rightColumn) || false;
        const topLeftConnected = Boolean(
          connectedOnLeft || coversPoint(displayIndex - 1, leftColumn, {
            includeStart: true,
            includeEnd: false,
          }),
        );
        const topRightConnected = Boolean(
          connectedOnRight || coversPoint(displayIndex - 1, rightColumn, {
            includeStart: false,
            includeEnd: true,
          }),
        );
        const bottomLeftConnected = Boolean(
          connectedOnLeft || coversPoint(displayIndex + 1, leftColumn, {
            includeStart: true,
            includeEnd: false,
          }),
        );
        const bottomRightConnected = Boolean(
          connectedOnRight || coversPoint(displayIndex + 1, rightColumn, {
            includeStart: false,
            includeEnd: true,
          }),
        );
        const startPosition = cursor.getPosition(row, leftColumn);
        const endPosition = cursor.getPosition(row, rightColumn);
        const left = getCaretPosition(row, startPosition.column).contentLeft;
        const right = getCaretPosition(row, endPosition.column).contentLeft;
        const top = cursor.rowToY(row) - 4;
        const width = right > left ? right - left : this.editor.letterSize;
        selectionRects.push({
          left,
          top,
          width,
          height: cursor.mpY + 4,
          cornerRadii: {
            topLeft: !topLeftConnected,
            topRight: !topRightConnected,
            bottomLeft: !bottomLeftConnected,
            bottomRight: !bottomRightConnected,
          },
        });
      }
    }
    for (const rect of caretRects) {
      const node = this.getPooledNode(
        this.caretPool,
        caretCount++,
        "editor-caret editor-secondary-caret",
        this.caretFastNodes,
        this.editor.multiCursorCaretOutput,
      );
      this.setNodeRect(
        node,
        rect.left,
        rect.top,
        rect.width,
        rect.height,
        this.caretFastNodes,
      );
    }
    for (const rect of selectionRects) {
      const node = this.getPooledNode(
        this.selectionPool,
        selectionCount++,
        "selected editor-secondary-selection",
        this.selectionFastNodes,
        this.editor.multiCursorSelectionOutput,
      );
      this.setNodeRect(
        node,
        rect.left,
        rect.top,
        rect.width,
        rect.height,
        this.selectionFastNodes,
      );
      this.setSelectionCornerRadii(node, rect.cornerRadii);
    }
    this.hidePool(this.caretPool, caretCount);
    this.hidePool(this.selectionPool, selectionCount);
    this.renderedCarets = caretCount;
    this.renderedSelections = selectionCount;
    this.overlayViewPositionCache = null;
  }

  getPooledNode(pool, index, className, fastNodes, parent) {
    let node = pool[index];
    if (!node) {
      node = document.createElement("div");
      node.className = className;
      node.style.position = "absolute";
      if (className.split(/\s+/).includes("editor-secondary-caret")) {
        node.style.marginLeft = `${this.editor.cursorController.mpX}px`;
      }
      parent.appendChild(node);
      pool.push(node);
    }
    const fast = fastNodes.get(node) || this.editor.domManager?.wrapFastNode?.(node) || null;
    if (fast) fastNodes.set(node, fast);
    if (fast) fast.setDisplay("block");
    else node.style.display = "block";
    return node;
  }

  setNodeRect(node, left, top, width, height, fastNodes) {
    const fast = fastNodes?.get(node);
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
      const fast = this.caretFastNodes.get(node) || this.selectionFastNodes.get(node);
      if (fast) fast.setDisplay("none");
      else node.style.display = "none";
    }
  }
}
