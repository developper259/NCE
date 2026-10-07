class LineController {
  constructor(editor) {
    this.editor = editor;
    const wrapFastNode = (node) => editor.domManager?.wrapFastNode?.(node) || null;
    this.outputFast = wrapFastNode(editor.output);
    this.lineNumberFast = wrapFastNode(editor.lineNumberOutput);
    this.selectOutputFast = wrapFastNode(editor.selectOutput);
    this.searchOutputFast = wrapFastNode(editor.searchOutput);

    this.outputWidth = 0;
    this.outputHeight = 0;

    this.dirtyLines = new Set();
    this.diffSegmentOffsetCache = new WeakMap();
    this.diffRowPositionIndexes = new WeakMap();
    this.diffMaxLineLength = 0;
    this.diffMetricsTabWidth = null;
    this.indexedDiffRows = null;
    this.renderGeneration = 0;

    this.marginChars = 10;
    this.marginLines = 3;

    this.outputScroller = new OutputScroller(editor);
    this.outputScroller.setLineController(this);

    this.syncDimensions();
  }

  get lines() {
    if (!this.editor.tabManager.activeFile) {
      return [];
    }

    return this.editor.tabManager.activeFile.lines || [];
  }

  get diffRows() {
    return this.editor.tabManager.activeFile?.diffRows || null;
  }

  getDisplayRows() {
    if (Array.isArray(this.diffRows) && this.diffRows.length > 0) {
      return this.diffRows;
    }
    return this.lines.map((line, documentIndex) => ({
      type: "unchanged",
      text: line.getText(),
      documentIndex,
    }));
  }

  getDisplayRow(displayIndex) {
    if (this.diffRows?.length) return this.diffRows[displayIndex] || null;
    const line = this.lines[displayIndex];
    return line
      ? { type: "unchanged", text: line.getText(), documentIndex: displayIndex }
      : null;
  }

  getDisplayIndexForDocument(documentIndex) {
    if (!this.diffRows?.length) return documentIndex;
    const displayIndex = this.diffRows.findIndex(
      (row) => row.documentIndex === documentIndex,
    );
    return displayIndex >= 0 ? displayIndex : documentIndex;
  }

  getDisplayIndexForCursor(documentRow) {
    return this.getDisplayIndexForDocument(documentRow - 1);
  }

  getDisplayLineCount() {
    return this.diffRows?.length || this.lines.length;
  }

  set lines(value) {
    if (!this.editor.tabManager.activeFile) {
      return;
    }

    this.editor.tabManager.activeFile.lines = value;
  }

  get index() {
    if (!this.editor.tabManager.activeFile) {
      return 0;
    }

    return this.editor.tabManager.activeFile.index || 0;
  }

  set index(value) {
    if (!this.editor.tabManager.activeFile) {
      return;
    }

    this.editor.tabManager.activeFile.index = value;
  }

  get maxLineLength() {
    const file = this.editor.tabManager.activeFile;
    if (!file) return 0;
    this.ensureLineLengthIndex(file);
    this.syncDiffRowCache();
    const maxLength = this.peekMaxLineLength(file);
    const diffMax = this.diffRows?.length ? this.diffMaxLineLength : 0;
    file.maxLineLength = Math.max(maxLength, diffMax);
    return file.maxLineLength;
  }

  set maxLineLength(value) {
    if (!this.editor.tabManager.activeFile) {
      return;
    }

    this.editor.tabManager.activeFile.maxLineLength = value;
    this.editor.tabManager.activeFile.maxLineLengthDirty = false;
  }

  get totalLines() {
    if (!this.editor.tabManager.activeFile) {
      return 0;
    }

    return this.editor.tabManager.activeFile.totalLines ?? 0;
  }

  set totalLines(value) {
    if (!this.editor.tabManager.activeFile) {
      return;
    }

    this.editor.tabManager.activeFile.totalLines = value;
  }

  get startIndex() {
    if (!this.editor.tabManager.activeFile) {
      return 0;
    }

    return this.editor.tabManager.activeFile.startIndex ?? 0;
  }

  set startIndex(value) {
    if (!this.editor.tabManager.activeFile) {
      return;
    }

    this.editor.tabManager.activeFile.startIndex = value;
  }

  get offsetY() {
    if (!this.editor.tabManager.activeFile) {
      return 0;
    }

    return this.editor.tabManager.activeFile.offsetY ?? 0;
  }

  set offsetY(value) {
    if (!this.editor.tabManager.activeFile) {
      return;
    }

    this.editor.tabManager.activeFile.offsetY = value;
  }

  get offsetX() {
    if (!this.editor.tabManager.activeFile) {
      return 0;
    }

    return this.editor.tabManager.activeFile.offsetX ?? 0;
  }

  set offsetX(value) {
    if (!this.editor.tabManager.activeFile) {
      return;
    }

    this.editor.tabManager.activeFile.offsetX = value;
  }

  syncDimensions() {
    const dimensions = this.editor.domManager;

    if (!dimensions) {
      return;
    }

    this.outputWidth = dimensions.getOutputWidth();

    this.outputHeight = dimensions.getOutputHeight();
  }

  get maxCharactersPerLine() {
    const letterWidth = this.editor.domManager
      ? this.editor.domManager.getLetterWidth()
      : this.editor.letterSize;

    return parseInt(this.outputWidth / letterWidth) + (this.marginChars || 0);
  }

  get maxViewLines() {
    return Math.max(
      1,
      Math.ceil(this.getViewportHeight() / this.getLineHeight()),
    );
  }

  get renderedLineCount() {
    return this.maxViewLines + 1;
  }

  get maxCharacters() {
    const letterWidth = this.editor.domManager
      ? this.editor.domManager.getLetterWidth()
      : this.editor.letterSize;

    return Math.max(0, parseInt(this.outputWidth / letterWidth) - 1);
  }

  get maxLines() {
    return Math.max(
      1,
      Math.floor(this.getViewportHeight() / this.getLineHeight()),
    );
  }

  getLineHeight() {
    const measuredHeight = this.editor.domManager
      ? this.editor.domManager.getLineHeight()
      : this.editor.posY;

    return Number.isFinite(measuredHeight) && measuredHeight > 0
      ? measuredHeight
      : 23;
  }

  getFastNode(node) {
    return this.editor.domManager?.wrapFastNode?.(node) || null;
  }

  getViewportHeight() {
    const horizontalScroller = this.outputScroller?.hScroller;
    const horizontalHeight = horizontalScroller?.calcIsActive()
      ? horizontalScroller.scrollerOBJ?.clientHeight ||
        horizontalScroller.scrollerOBJ?.offsetHeight ||
        10
      : 0;

    return Math.max(0, this.outputHeight - horizontalHeight);
  }

  getScrollOffsetY() {
    const lineHeight = this.getLineHeight();

    return this.startIndex * lineHeight + this.offsetY;
  }

  getMaxStartIndex() {
    if (this.totalLines === 0) {
      return 0;
    }

    const overflow =
      this.getDisplayLineCount() + this.getBottomScrollMargin() - this.maxLines;

    return Math.max(0, overflow);
  }

  getBottomScrollMargin() {
    if (this.getDisplayLineCount() <= this.maxLines) {
      return 0;
    }

    return Math.min(this.marginLines, Math.max(0, this.maxLines - 1));
  }

  getLineTop(screenIndex) {
    const baseY = this.editor.domManager
      ? this.editor.domManager.getOutputY()
      : this.editor.baseY;

    const lineHeight = this.getLineHeight();

    return lineHeight * screenIndex;
  }
  getOutputTransform() {
    const y = -this.offsetY;

    return `translate(0px, ${y}px)`;
  }

  getRenderedLayerHeight() {
    return this.renderedLineCount * this.getLineHeight();
  }

  applyOutputTransform() {
    const transform = this.getOutputTransform();

    const height = `${this.getRenderedLayerHeight()}px`;

    this.outputFast?.setHeight(height);
    this.lineNumberFast?.setHeight(height);
    this.selectOutputFast?.setHeight(height);
    this.searchOutputFast?.setHeight(height);

    this.outputFast?.setTransform(transform);
    this.lineNumberFast?.setTransform(transform);
    this.selectOutputFast?.setTransform(transform);
    this.searchOutputFast?.setTransform(transform);
  }

  isSized() {
    return this.outputHeight !== 0 && this.outputWidth !== 0;
  }

  applyScrollTransform() {
    this.outputScroller.applyScrollTransform();
  }

  resetScroll() {
    this.outputScroller.resetScroll();
  }

  clampScrollState() {
    return this.outputScroller.clampScrollState();
  }

  recalculateMaxLineLength() {
    this.rebuildLineLengthIndex();
    return this.peekMaxLineLength();
  }

  ensureLineLengthIndex(file = this.editor.tabManager.activeFile) {
    const tabWidth = SETTINGS_GET("editor.tabWidth");
    if (!file) return;
    if (
      !file._lineLengthRecords ||
      file.maxLineLengthDirty === true ||
      file._lineMetricsTabWidth !== tabWidth ||
      file._lineLengthCount !== file.lines.length
    ) this.rebuildLineLengthIndex(file);
  }

  rebuildLineLengthIndex(file = this.editor.tabManager.activeFile) {
    if (!file) return 0;
    const tabWidth = SETTINGS_GET("editor.tabWidth");
    file._lineLengthRecords = new Map();
    file._lineLengthHeap = [];
    file._lineMetricsTabWidth = tabWidth;
    for (const line of file.lines || []) this.updateLineLengthRecord(line, file);
    file._lineLengthCount = file.lines?.length || 0;
    file.maxLineLengthDirty = false;
    file.maxLineLength = this.peekMaxLineLength(file);
    return file.maxLineLength;
  }

  updateLineLengthRecord(line, file = this.editor.tabManager.activeFile) {
    if (!file || !line) return;
    if (!file._lineLengthRecords) file._lineLengthRecords = new Map();
    if (!file._lineLengthHeap) file._lineLengthHeap = [];
    const previous = file._lineLengthRecords.get(line);
    const tabWidth = SETTINGS_GET("editor.tabWidth");
    const index = line.positionIndex;
    const length = index && index.textVersion === line.textVersion && index.tabWidth === tabWidth
      ? index.visualLength
      : this.getViewTextLength(line.getText());
    if (previous) {
      previous.length = length;
      this.heapFixAt(file._lineLengthHeap, previous.index);
    } else {
      const record = { line, length, index: -1 };
      file._lineLengthRecords.set(line, record);
      this.heapPush(file._lineLengthHeap, record);
    }
  }

  syncLineLengthsForEdit(startIndex, removedLines, replacementLines) {
    const file = this.editor.tabManager.activeFile;
    this.syncLogicalLineLengthsForEdit(startIndex, replacementLines);
    if (!file?._lineLengthRecords || file._lineMetricsTabWidth !== SETTINGS_GET("editor.tabWidth")) {
      if (file) file.maxLineLengthDirty = true;
      return;
    }
    const retained = new Set(replacementLines);
    for (const line of removedLines) {
      if (!retained.has(line)) this.removeLineLengthRecord(line);
    }
    for (const line of replacementLines) this.updateLineLengthRecord(line);
    file._lineLengthCount = this.lines.length;
    file.maxLineLengthDirty = false;
    file.maxLineLength = this.peekMaxLineLength();
  }

  syncLineLengthsForAppend(file, startIndex, appendedLines) {
    if (!file) return;
    if (
      !file._lineLengthRecords || !file._lineLengthHeap ||
      file.maxLineLengthDirty === true ||
      file._lineMetricsTabWidth !== SETTINGS_GET("editor.tabWidth") ||
      file._lineLengthCount !== startIndex
    ) {
      file.maxLineLengthDirty = true;
      return;
    }

    for (const line of appendedLines) this.updateLineLengthRecord(line, file);
    file._lineLengthCount = file.lines.length;
    file.maxLineLengthDirty = false;
    file.maxLineLength = this.peekMaxLineLength(file);
  }

  ensureLogicalLineLengthIndex(file = this.editor.tabManager.activeFile) {
    if (!file) return;
    if (
      file._logicalLineLengths && file._logicalLengthTree &&
      file._logicalLengthCount === file.lines.length
    ) return;

    const count = file.lines.length;
    const values = new Array(count);
    const tree = new Array(count + 1).fill(0);
    for (let index = 0; index < count; index++) {
      const length = file.lines[index]?.getText?.().length || 0;
      values[index] = length;
      const treeIndex = index + 1;
      tree[treeIndex] += length;
      const parent = treeIndex + (treeIndex & -treeIndex);
      if (parent <= count) tree[parent] += tree[treeIndex];
    }
    file._logicalLineLengths = values;
    file._logicalLengthTree = tree;
    file._logicalLengthCount = count;
  }

  fenwickPrefixSum(tree, count) {
    let sum = 0;
    for (let index = Math.max(0, Math.min(count, tree.length - 1)); index > 0; index -= index & -index)
      sum += tree[index];
    return sum;
  }

  syncLogicalLineLengthsForAppend(file, startIndex, appendedLines) {
    if (!file?._logicalLineLengths || !file._logicalLengthTree) return;
    if (
      file._logicalLengthCount !== startIndex ||
      file._logicalLineLengths.length !== startIndex ||
      file._logicalLengthTree.length !== startIndex + 1
    ) {
      file._logicalLineLengths = null;
      file._logicalLengthTree = null;
      file._logicalLengthCount = -1;
      return;
    }

    const values = file._logicalLineLengths;
    const tree = file._logicalLengthTree;
    for (const line of appendedLines) {
      const length = line?.getText?.().length || 0;
      const treeIndex = values.length + 1;
      const rangeStart = treeIndex - (treeIndex & -treeIndex);
      const previousRangeLength = this.fenwickPrefixSum(tree, treeIndex - 1) -
        this.fenwickPrefixSum(tree, rangeStart);
      values.push(length);
      tree.push(previousRangeLength + length);
      file._logicalLengthCount = treeIndex;
    }
  }

  syncLogicalLineLengthsForEdit(startIndex, replacementLines) {
    const file = this.editor.tabManager.activeFile;
    if (!file?._logicalLineLengths || !file._logicalLengthTree) return;
    if (file._logicalLengthCount !== this.lines.length) {
      file._logicalLineLengths = null;
      file._logicalLengthTree = null;
      file._logicalLengthCount = -1;
      return;
    }
    for (let offset = 0; offset < replacementLines.length; offset++) {
      const index = startIndex + offset;
      const line = replacementLines[offset];
      if (this.lines[index] !== line) {
        file._logicalLineLengths = null;
        file._logicalLengthTree = null;
        file._logicalLengthCount = -1;
        return;
      }
      const nextLength = line?.getText?.().length || 0;
      const delta = nextLength - file._logicalLineLengths[index];
      if (!delta) continue;
      file._logicalLineLengths[index] = nextLength;
      for (let treeIndex = index + 1; treeIndex < file._logicalLengthTree.length;) {
        file._logicalLengthTree[treeIndex] += delta;
        treeIndex += treeIndex & -treeIndex;
      }
    }
  }

  sumLineTextLengths(startIndex, endIndex) {
    this.ensureLogicalLineLengthIndex();
    const tree = this.editor.tabManager.activeFile?._logicalLengthTree;
    if (!tree) return 0;
    return this.fenwickPrefixSum(tree, endIndex) - this.fenwickPrefixSum(tree, startIndex);
  }

  heapPush(heap, entry) {
    let index = heap.length;
    heap.push(entry);
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (heap[parent].length >= entry.length) break;
      heap[index] = heap[parent];
      heap[index].index = index;
      index = parent;
    }
    heap[index] = entry;
    entry.index = index;
  }

  heapFixAt(heap, index) {
    if (index < 0 || index >= heap.length) return;
    let entry = heap[index];
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (heap[parent].length >= entry.length) break;
      heap[index] = heap[parent];
      heap[index].index = index;
      index = parent;
    }
    heap[index] = entry;
    entry.index = index;

    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= heap.length) break;
      const child = right < heap.length && heap[right].length > heap[left].length ? right : left;
      if (heap[child].length <= entry.length) break;
      heap[index] = heap[child];
      heap[index].index = index;
      index = child;
    }
    heap[index] = entry;
    entry.index = index;
  }

  removeLineLengthRecord(line, file = this.editor.tabManager.activeFile) {
    const record = file?._lineLengthRecords?.get(line);
    if (!record) return;
    file._lineLengthRecords.delete(line);
    const heap = file._lineLengthHeap;
    const index = record.index;
    if (!heap || index < 0 || heap[index] !== record) return;
    const last = heap.pop();
    record.index = -1;
    if (index < heap.length) {
      heap[index] = last;
      last.index = index;
      this.heapFixAt(heap, index);
    }
  }

  peekMaxLineLength(file = this.editor.tabManager.activeFile) {
    const heap = file?._lineLengthHeap || [];
    return heap[0]?.length || 0;
  }

  getScrollRatioFromState() {
    return this.outputScroller.getVerticalScrollRatioFromState();
  }

  restoreScroll() {
    this.outputScroller.restoreScroll();
  }

  applyScrollFromRatio(scrollRatio) {
    this.outputScroller.applyVerticalScrollFromRatio(scrollRatio);
  }

  applyHorizontalScrollFromRatio(scrollRatio) {
    this.outputScroller.applyHorizontalScrollFromRatio(scrollRatio);
  }

  scrollTo(row, column) {
    this.outputScroller.scrollTo(row, column);
  }

  measureOutputWidth() {
    if (this.editor.domManager) {
      return this.editor.domManager.getOutputWidth();
    }

    return this.outputWidth;
  }

  resizeWidth() {
    this.syncDimensions();

    this.markDirtyAll();

    this.editor.scrollerManager?.invalidateScroller?.(
      this.outputScroller?.vScroller,
    );
    this.editor.scrollerManager?.invalidateScroller?.(
      this.outputScroller?.hScroller,
    );

    this.refresh();
  }

  resize() {
    this.syncDimensions();

    if (this.outputScroller) {
      this.outputScroller.clampScrollState();
    }

    if (!this.editor.isOnRefresh) {
      this.markDirtyAll();

      this.refresh(true);
    }
  }

  loadContent(content, totalLines) {
    const textLines = content.split("\n");

    this.lines = textLines.map((text) => new LineNode(text));
    const activeFile = this.editor.tabManager.activeFile;
    if (activeFile) {
      activeFile._logicalLineLengths = null;
      activeFile._logicalLengthTree = null;
      activeFile._logicalLengthCount = -1;
    }
    if (this.editor.tabManager.activeFile)
      this.editor.tabManager.activeFile.syntaxMetrics = null;
    if (this.editor.tabManager.activeFile) {
      this.editor.tabManager.activeFile.diffRows = null;
    }

    this.totalLines = totalLines || this.lines.length;
    this.rebuildLineLengthIndex();

    this.updateLineNumberWidth();

    if (this.outputScroller) {
      this.outputScroller.updateNbItem();
      this.outputScroller.refresh();
    }
  }

  setTotalLines(totalLines) {
    this.totalLines = totalLines;
  }

  appendLines(newLines) {
    const lineNodes = newLines.map((text) => new LineNode(text));
    const file = this.editor.tabManager.activeFile;
    if (!file) return;
    this.appendLoadedLineNodes(file, lineNodes);

    if (this.outputScroller) {
      this.outputScroller.updateNbItem();
    }
  }

  appendLoadedLines(file, texts) {
    const lineNodes = texts.map((text) => new LineNode(text));
    this.appendLoadedLineNodes(file, lineNodes);
  }

  appendLoadedLineNodes(file, lineNodes) {
    if (!file || !lineNodes.length) return;
    const startIndex = file.lines.length;
    file.lines.push(...lineNodes);
    this.syncLineLengthsForAppend(file, startIndex, lineNodes);
    this.syncLogicalLineLengthsForAppend(file, startIndex, lineNodes);
    file.totalLines = file.lines.length;
    file.syntaxMetrics = null;
  }

  getContent() {
    return this.lines.map((line) => line.getText()).join("\n");
  }

  getLineLength(row) {
    if (row >= this.lines.length || !this.lines[row]) {
      return 0;
    }

    const l = this.lines[row].getText().replace(/ |	/g, "");

    return l.length;
  }

  getViewLineLength(i) {
    if (i < 0 || i >= this.lines.length || !this.lines[i]) {
      return 0;
    }

    const line = this.lines[i];
    const index = line.positionIndex;
    const tabWidth = SETTINGS_GET("editor.tabWidth");
    return index && index.textVersion === line.textVersion && index.tabWidth === tabWidth
      ? index.visualLength
      : this.getViewTextLength(line.getText());
  }

  getViewTextLength(text) {
    const value = typeof text === "string" ? text : "";
    if (typeof TextPositionIndex === "function")
      return TextPositionIndex.getVisualLength(value, SETTINGS_GET("editor.tabWidth"));
    const tabWidth = SETTINGS_GET("editor.tabWidth");
    let visualLength = 0;
    for (let index = 0; index < value.length; index++)
      visualLength += value[index] === "\t" ? tabWidth : 1;
    return visualLength;
  }

  getViewNumberLines() {
    if (!this.lines) {
      return 0;
    }

    const visibleLines = this.getDisplayLineCount() - this.startIndex;

    return Math.max(0, Math.min(visibleLines, this.renderedLineCount));
  }

  setFocusLine(index) {
    this.index = index;

    const selectedLines =
      this.editor.lineNumberOutput?.querySelectorAll(".line-selected");
    if (selectedLines) {
      selectedLines.forEach((line) => this.getFastNode(line)?.toggleClass("line-selected", false));
    }

    const newLine = this.getLineNumberOBJ(index - 1);

    if (newLine == null) {
      return;
    }

    this.getFastNode(newLine)?.toggleClass("line-selected", true);
  }

  clearDiffRows() {
    if (this.editor.tabManager.activeFile) {
      this.editor.tabManager.activeFile.diffRows = null;
    }
    this.diffMaxLineLength = 0;
    this.diffMetricsTabWidth = null;
    this.indexedDiffRows = null;
  }

  syncDiffRowCache() {
    const rows = this.diffRows;
    const tabWidth = SETTINGS_GET("editor.tabWidth");
    if (rows !== this.indexedDiffRows || tabWidth !== this.diffMetricsTabWidth) {
      this.indexedDiffRows = rows;
      this.diffRowPositionIndexes = new WeakMap();
      this.diffMaxLineLength = 0;
      this.diffMetricsTabWidth = tabWidth;
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        const text = String(row?.text ?? "");
        const lineNode = Number.isInteger(row?.documentIndex)
          ? this.lines[row.documentIndex]
          : null;
        const cachedIndex = lineNode?.positionIndex;
        const index = lineNode?.getText?.() === text && cachedIndex &&
          cachedIndex.textVersion === lineNode.textVersion &&
          cachedIndex.tabWidth === Number(tabWidth)
          ? cachedIndex
          : null;
        this.diffMaxLineLength = Math.max(
          this.diffMaxLineLength,
          index?.visualLength ?? this.getViewTextLength(text),
        );
      }
    }
  }

  recalculatePersistentDiff() {
    const file = this.editor.tabManager.activeFile;
    if (!file || !file.diffActive || file.diffSnapshot === null) {
      return;
    }
    const currentContent = this.getContent();
    const agent = this.editor.agent || this.editor.api?.agent;
    if (agent && typeof agent.markFileDiffHighlights === "function") {
      agent.markFileDiffHighlights(file.diffSnapshot, currentContent, file);
      this.markDirtyAll();
      if (this.outputScroller) {
        this.outputScroller.updateNbItem();
      }
      this.refresh(true);
    }
  }

  addLine(txt, index) {
    const line = new LineNode(txt);
    this.lines.splice(index, 0, line);
    this.syncLineLengthsForEdit(index, [], [line]);

    this.markDirtyFrom(index);
  }

  changeLine(txt, index) {
    if (index >= 0 && index < this.lines.length) {
      const line = this.lines[index];
      line.setText(txt);
      this.syncLineLengthsForEdit(index, [line], [line]);

      this.markDirty(index);
    }
  }

  supLine(index) {
    if (index >= 0 && index < this.lines.length) {
      const [removed] = this.lines.splice(index, 1);
      this.syncLineLengthsForEdit(index, [removed], []);

      this.markDirtyFrom(index);
    }
  }

  clear() {
    this.lines = [new LineNode("")];
    const file = this.editor.tabManager.activeFile;
    if (file) {
      file._logicalLineLengths = null;
      file._logicalLengthTree = null;
      file._logicalLengthCount = -1;
    }
    this.rebuildLineLengthIndex();

    this.markDirtyFrom(0);
  }

  markDirtyAll() {
    if (this.lines.length === 0) {
      return;
    }

    this.setTotalLines(this.lines.length);

    this.markDirtyFrom(0, false);

    this.editor.highlightController.markDirtyAll(true);
  }

  markDirtyFrom(dataIndex, isHighlight = true) {
    if (this.lines.length === 0) {
      return;
    }

    this.setTotalLines(this.lines.length);

    const start = Math.max(dataIndex, this.startIndex);

    const end = Math.min(
      this.lines.length,
      this.startIndex + this.renderedLineCount,
    );

    for (let i = start; i < end; i++) {
      this.dirtyLines.add(this.lines[i]);
    }

    if (isHighlight) {
      this.editor.highlightController.markDirtyFrom(dataIndex);
    }
  }

  markDirty(index) {
    if (this.lines.length === 0) {
      return;
    }

    this.setTotalLines(this.lines.length);

    this.dirtyLines.add(this.lines[index]);

    this.editor.highlightController.markDirty(index);
  }

  getSlicedLine(line, lineNode = null, displayRow = null) {
    this.syncDiffRowCache();
    let index = lineNode?.getText?.() === line ? lineNode.getPositionIndex?.() : null;
    if (!index && displayRow && typeof TextPositionIndex === "function") {
      let cached = this.diffRowPositionIndexes.get(displayRow);
      if (
        !cached || cached.text !== line ||
        cached.index.tabWidth !== SETTINGS_GET("editor.tabWidth")
      ) {
        cached = {
          text: line,
          index: new TextPositionIndex(line, SETTINGS_GET("editor.tabWidth")),
        };
        this.diffRowPositionIndexes.set(displayRow, cached);
      }
      index = cached.index;
    }
    if (!index && typeof TextPositionIndex === "function")
      index = new TextPositionIndex(line, SETTINGS_GET("editor.tabWidth"));
    if (index) {
      const slice = {
        ...index.sliceVisualRange(this.offsetX, this.maxCharactersPerLine),
        visualLength: index.visualLength,
      };
      return slice;
    }

    const startChar = Math.min(this.offsetX, line.length);
    const endChar = Math.min(line.length, startChar + this.maxCharactersPerLine);
    return { text: line.slice(startChar, endChar), displayText: line.slice(startChar, endChar), startChar, endChar, segments: [], visualLength: line.length };
  }

  refreshOutput() {
    if (this.dirtyLines.size === 0) {
      return;
    }

    // Only visible rows can produce DOM work. Avoid indexOf across the entire
    // file for each dirty line when editing near the end of a large document.
    const end = Math.min(
      this.getDisplayLineCount(),
      this.startIndex + this.renderedLineCount,
    );
    for (
      let displayIndex = this.startIndex;
      displayIndex < end;
      displayIndex++
    ) {
      const documentIndex = this.diffRows?.length
        ? this.diffRows[displayIndex]?.documentIndex
        : displayIndex;
      if (this.dirtyLines.has(this.lines[documentIndex])) {
        this.refreshLineOutput(displayIndex - this.startIndex);
      }
    }

    const firstEmptyIndex = Math.max(
      0,
      this.getDisplayLineCount() - this.startIndex,
    );

    const outputLength = this.editor.output.children.length;

    for (
      let screenIndex = firstEmptyIndex;
      screenIndex < outputLength;
      screenIndex++
    ) {
      const child = this.editor.output.children[screenIndex];

      if (!child) {
        continue;
      }

      const childFast = this.getFastNode(child);
      childFast?.removeChildren();
      childFast?.removeAttribute("data-line");
    }

    this.dirtyLines.clear();
  }

  isLineOutputCurrent(child, displayRow) {
    if (!child || !displayRow) return false;

    const documentIndex = displayRow.documentIndex;
    const lineNode = documentIndex === null ? null : this.lines[documentIndex];
    const mappedDocumentIndex = documentIndex === null
      ? ""
      : String(documentIndex);
    const renderMeta = child.__nceRenderMeta;
    const tabWidth = typeof SETTINGS_GET === "function"
      ? SETTINGS_GET("editor.tabWidth")
      : 4;

    return child.dataset.line === mappedDocumentIndex &&
      renderMeta?.documentIndex === documentIndex &&
      renderMeta.lineNode === lineNode &&
      renderMeta.displayText === displayRow.text &&
      renderMeta.textVersion === (lineNode?.textVersion || 0) &&
      renderMeta.tokenVersion === (lineNode?.tokensVersion || 0) &&
      renderMeta.diffVersion === (lineNode?.diffVersion || 0) &&
      renderMeta.diffState === (displayRow.type || null) &&
      renderMeta.horizontalOffset === this.offsetX &&
      renderMeta.maxCharactersPerLine === this.maxCharactersPerLine &&
      renderMeta.tabWidth === tabWidth;
  }

  refreshForVerticalScroll(previousStartIndex) {
    if (!this.editor.tabManager.activeFile) return;
    if (this.editor.tabManager.activeFile.loadError) {
      this.refresh();
      return;
    }

    this.applyOutputTransform();
    const delta = this.startIndex - previousStartIndex;
    const children = this.editor.output.children;
    const rowCount = this.renderedLineCount;
    const newlyVisibleDocumentIndexes = [];

    if (delta !== 0 && (children.length !== rowCount || Math.abs(delta) >= rowCount)) {
      this.initLineOutput();
      for (let screenIndex = 0; screenIndex < rowCount; screenIndex++) {
        const displayRow = this.getDisplayRow(this.startIndex + screenIndex);
        if (Number.isInteger(displayRow?.documentIndex))
          newlyVisibleDocumentIndexes.push(displayRow.documentIndex);
      }
    } else if (delta !== 0) {
      if (delta > 0) {
        for (let index = 0; index < delta; index++) {
          const first = this.editor.output.firstElementChild;
          if (!first) break;
          this.editor.output.appendChild(first);
        }
      } else {
        for (let index = 0; index < -delta; index++) {
          const last = this.editor.output.lastElementChild;
          const first = this.editor.output.firstElementChild;
          if (!last || !first) break;
          this.editor.output.insertBefore(last, first);
        }
      }

      this.editor.highlightController.lineNodes.clear();
      for (let screenIndex = 0; screenIndex < rowCount; screenIndex++) {
        const displayIndex = this.startIndex + screenIndex;
        const displayRow = this.getDisplayRow(displayIndex);
        const child = this.editor.output.children[screenIndex];
        if (!child) continue;

        const childFast = this.getFastNode(child);
        childFast?.setTop(this.getLineTop(screenIndex));
        childFast?.setDataset("displayLine", displayIndex);

        if (!displayRow || !this.isLineOutputCurrent(child, displayRow)) {
          this.refreshLineOutput(screenIndex);
        } else if (Number.isInteger(displayRow.documentIndex)) {
          this.editor.highlightController.setLineNode(
            displayRow.documentIndex,
            child,
          );
        }

        if (Number.isInteger(displayRow?.documentIndex)) {
          const lineNode = this.lines[displayRow.documentIndex];
          if (lineNode && lineNode.getTokens() === null &&
              lineNode.getText().trim() !== "")
            newlyVisibleDocumentIndexes.push(displayRow.documentIndex);
        }
      }
    }

    if (delta !== 0) {
      this.refreshNumberLines(false);
    }

    this.editor.cursorController.updateCaretPosition();
    this.editor.selectController.refreshSelectionDOM();
    this.editor.searchController.refreshSelectionDOM();

    if (newlyVisibleDocumentIndexes.length > 0)
      this.editor.highlightController.refreshForVerticalScroll(
        newlyVisibleDocumentIndexes,
      );
  }

  refreshHorizontalViewport() {
    const visibleCount = Math.min(
      this.renderedLineCount,
      this.getDisplayLineCount() - this.startIndex,
      this.editor.output?.children?.length || 0,
    );
    for (let screenIndex = 0; screenIndex < visibleCount; screenIndex++)
      this.refreshLineOutput(screenIndex);
    this.editor.cursorController.updateCaretPosition();
    this.editor.selectController.refreshSelectPositions();
    this.editor.searchController.refreshSelectionDOM();
  }

  refreshLineOutput(screenIndex) {
    if (screenIndex >= this.renderedLineCount) {
      return;
    }

    const displayIndex = this.startIndex + screenIndex;
    const displayRow = this.getDisplayRow(displayIndex);

    const child = this.editor.output.children[screenIndex];

    if (!child) {
      return;
    }

    const childFast = this.getFastNode(child);

    if (!displayRow) {
      childFast?.removeChildren();
      childFast?.removeAttribute("data-line");

      return;
    }

    const documentIndex = displayRow.documentIndex;
    const lineNode = documentIndex === null ? null : this.lines[documentIndex];
    const fullText = displayRow.text;

    if (this.isLineOutputCurrent(child, displayRow)) {
      if (documentIndex !== null)
        this.editor.highlightController.setLineNode(documentIndex, child);
      return;
    }

    let line = this.getSlicedLine(fullText, lineNode, displayRow);
    const mappedDocumentIndex =
      documentIndex === null ? "" : String(documentIndex);
    const mappingChanged = child.dataset.line !== mappedDocumentIndex;

    const tokenVersion = lineNode?.tokensVersion || 0;
    const diffVersion = lineNode?.diffVersion || 0;
    const renderMeta = child.__nceRenderMeta;
    const needsRender = mappingChanged || !renderMeta ||
      renderMeta.documentIndex !== documentIndex ||
      renderMeta.lineNode !== lineNode ||
      renderMeta.displayText !== fullText ||
      renderMeta.startChar !== line.startChar ||
      renderMeta.endChar !== line.endChar ||
      renderMeta.startVisual !== line.startVisual ||
      renderMeta.endVisual !== line.endVisual ||
      renderMeta.horizontalOffset !== this.offsetX ||
      renderMeta.maxCharactersPerLine !== this.maxCharactersPerLine ||
      renderMeta.tabWidth !== (typeof SETTINGS_GET === "function"
        ? SETTINGS_GET("editor.tabWidth")
        : 4) ||
      renderMeta.textVersion !== (lineNode?.textVersion || 0) ||
      renderMeta.tokenVersion !== tokenVersion ||
      renderMeta.diffVersion !== diffVersion ||
      renderMeta.diffState !== (displayRow.type || null);

    if (needsRender) {
      let lineOBJ = this.createLineOBJ(line, screenIndex);

      if (!lineOBJ) {
        return;
      }

      const lineFast = this.getFastNode(lineOBJ);
      lineFast?.setDataset("line", documentIndex === null ? "" : documentIndex);
      lineFast?.setDataset("displayLine", displayIndex);
      lineFast?.setDataset("renderGeneration", this.renderGeneration);
      lineOBJ.__nceRenderMeta = {
        documentIndex,
        lineNode,
        displayText: fullText,
        startChar: line.startChar,
        endChar: line.endChar,
        startVisual: line.startVisual,
        endVisual: line.endVisual,
        horizontalOffset: this.offsetX,
        maxCharactersPerLine: this.maxCharactersPerLine,
        tabWidth: typeof SETTINGS_GET === "function"
          ? SETTINGS_GET("editor.tabWidth")
          : 4,
        textVersion: lineNode?.textVersion || 0,
        tokenVersion,
        diffVersion,
        diffState: displayRow.type || null,
      };

      childFast?.replaceWith(lineOBJ);

      if (documentIndex !== null) {
        this.editor.highlightController.setLineNode(documentIndex, lineOBJ);
      }

    } else if (documentIndex !== null) {
      this.editor.highlightController.setLineNode(documentIndex, child);
    }
  }

  initLineOutput() {
    if (!this.editor.tabManager.activeFile) {
      return;
    }

    this.renderGeneration += 1;

    const fragment = document.createDocumentFragment();
    this.editor.highlightController.lineNodes.clear();

    const loadError = this.editor.tabManager.activeFile.loadError;
    if (loadError) {
      const message = document.createElement("div");
      message.className = "editor-load-error";
      message.textContent =
        loadError.code === "BINARY_FILE"
          ? "Binary file can't be opened"
          : loadError.code === "FILE_TOO_LARGE"
            ? "File is too large to be opened"
            : "File can't be opened";
      fragment.appendChild(message);
      if (this.outputFast) this.outputFast.replaceChildren(fragment);
      else this.editor.output.replaceChildren(fragment);
      this.editor.highlightController.lineNodes.clear();
      return;
    }

    for (let i = 0; i < this.renderedLineCount; i++) {
      const displayIndex = this.startIndex + i;
      const displayRow = this.getDisplayRow(displayIndex);

      let lineOBJ;

      if (!displayRow) {
        lineOBJ = this.createLineOBJ(null, i);
      } else {
        const documentIndex = displayRow.documentIndex;
        const fullText = displayRow.text;
        const lineNode = displayRow.documentIndex === null
          ? null
          : this.lines[displayRow.documentIndex];
        const line = this.getSlicedLine(fullText, lineNode, displayRow);
        const currentLineLength = line.visualLength ?? this.getViewTextLength(fullText);

        lineOBJ = this.createLineOBJ(line, i);

        const lineFast = this.getFastNode(lineOBJ);
        lineFast?.setDataset("line", documentIndex === null ? "" : documentIndex);
        lineFast?.setDataset("displayLine", displayIndex);
        lineFast?.setDataset("renderGeneration", this.renderGeneration);
        lineOBJ.__nceRenderMeta = {
          documentIndex,
          lineNode,
          displayText: fullText,
          startChar: line.startChar,
          endChar: line.endChar,
          startVisual: line.startVisual,
          endVisual: line.endVisual,
          horizontalOffset: this.offsetX,
          maxCharactersPerLine: this.maxCharactersPerLine,
          tabWidth: typeof SETTINGS_GET === "function"
            ? SETTINGS_GET("editor.tabWidth")
            : 4,
          textVersion: lineNode?.textVersion || 0,
          tokenVersion: lineNode?.tokensVersion || 0,
          diffVersion: lineNode?.diffVersion || 0,
          diffState: displayRow.type || null,
        };

        if (documentIndex !== null) {
          this.editor.highlightController.setLineNode(documentIndex, lineOBJ);
        }
      }

      fragment.appendChild(lineOBJ);
    }

    this.editor.highlightController.markDirtyAll(true);

    if (this.outputFast) this.outputFast.replaceChildren(fragment);
    else this.editor.output.replaceChildren(fragment);
  }

  refreshNumberLines(updateWidth = true) {
    if (!this.editor.tabManager.activeFile) {
      return;
    }

    let children = this.editor.lineNumberOutput.children;

    const targetCount = this.getViewNumberLines();

    const diff = children.length - targetCount;

    if (diff > 0) {
      for (let i = 0; i < diff; i++) {
        this.getFastNode(this.editor.lineNumberOutput.lastElementChild)?.remove();
      }
    } else if (diff < 0) {
      const fragment = document.createDocumentFragment();

      const currentLength = children.length;

      for (let i = 0; i < diff * -1; i++) {
        const screenIndex = currentLength + i;

        const lNode = this.createNumberLineOBJ(
          screenIndex,
          this.startIndex + screenIndex,
        );

        fragment.appendChild(lNode);
      }

      if (this.lineNumberFast) this.lineNumberFast.appendChild(fragment);
      else this.editor.lineNumberOutput.appendChild(fragment);
    }

    for (let i = 0; i < children.length; i++) {
      const span = children[i];

      const displayIndex = this.startIndex + i;
      const displayRow = this.getDisplayRow(displayIndex);

      const spanFast = this.getFastNode(span);
      spanFast?.setTextContent(
        displayRow?.documentIndex === null
          ? ""
          : displayRow
            ? displayRow.documentIndex + 1
            : "",
      );

      const lineNumber = displayRow?.documentIndex === null
        ? ""
        : (displayRow?.documentIndex ?? "");
      spanFast?.setDataset("line", lineNumber);
      spanFast?.setDataset("displayLine", displayIndex);
      spanFast?.setTop(this.getLineTop(i));
      spanFast?.toggleClass("line-selected", displayRow?.documentIndex === this.index - 1);
    }

    if (updateWidth) this.updateLineNumberWidth();
  }

  initNumberLines() {
    if (!this.editor.tabManager.activeFile) {
      return;
    }

    const fragment = document.createDocumentFragment();

    const l = this.getViewNumberLines();

    for (let i = 0; i < l; i++) {
      const lNode = this.createNumberLineOBJ(i, this.startIndex + i);

      fragment.appendChild(lNode);
    }

    if (this.lineNumberFast) this.lineNumberFast.replaceChildren(fragment);
    else this.editor.lineNumberOutput.replaceChildren(fragment);

    this.updateLineNumberWidth();
  }

  createNumberLineOBJ(screenIndex, dataIndex) {
    const spanFast = this.editor.domManager.createFastElement("span");
    const span = spanFast.domNode;
    spanFast.addClass("line-el");
    spanFast.addClass("editor-el");

    const displayRow = this.getDisplayRow(dataIndex);

    if (displayRow?.documentIndex === this.index - 1) {
      spanFast.addClass("line-selected");
    }

    spanFast.setTop(this.getLineTop(screenIndex));

    spanFast.setTextContent(
      displayRow?.documentIndex === null
        ? ""
        : displayRow
          ? displayRow.documentIndex + 1
          : "",
    );

    const lineNumber = displayRow?.documentIndex === null
      ? ""
      : (displayRow?.documentIndex ?? "");
    spanFast.setDataset("line", lineNumber);
    spanFast.setDataset("displayLine", dataIndex);

    return span;
  }

  calculateLineNumberWidth() {
    if (this.lines.length === 0) {
      return 50;
    }

    const maxLineNumber = this.lines.length;

    const maxDigits = maxLineNumber.toString().length;

    return Math.max(50, maxDigits * 10 + 15);
  }

  updateLineNumberWidth() {
    const width = this.calculateLineNumberWidth();

    this.lineNumberFast?.setWidth(width);

    this.editor.updateBaseX(width);
  }

  getVisibleTokens(tokens, slicedLine) {
    if (!tokens || !slicedLine) return null;
    const startChar = slicedLine.startChar || 0;
    const endChar = slicedLine.endChar ?? (startChar + slicedLine.text.length);
    const displayText = slicedLine.displayText ?? slicedLine.text;
    let low = 0;
    let high = tokens.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const token = tokens[mid];
      if ((token.column - 1) + token.value.length <= startChar) low = mid + 1;
      else high = mid;
    }

    const visible = [];
    const sourceSegments = slicedLine.segments?.length ? slicedLine.segments : null;
    if (!sourceSegments) {
      for (let index = low; index < tokens.length; index++) {
        const token = tokens[index];
        const tokenStart = (Number(token.column) || 1) - 1;
        if (tokenStart >= endChar) break;
        const tokenEnd = tokenStart + String(token.value || "").length;
        const from = Math.max(startChar, tokenStart);
        const to = Math.min(endChar, tokenEnd);
        if (from >= to) continue;
        const displayStart = from - startChar;
        visible.push({
          ...token,
          value: displayText.slice(displayStart, displayStart + (to - from)),
          column: displayStart + 1,
        });
      }
      return visible;
    }

    let tokenIndex = low;
    for (const segment of sourceSegments) {
      while (tokenIndex < tokens.length) {
        const token = tokens[tokenIndex];
        const tokenEnd = token.column - 1 + String(token.value || "").length;
        if (tokenEnd > segment.realStart) break;
        tokenIndex++;
      }
      for (let index = tokenIndex; index < tokens.length; index++) {
        const token = tokens[index];
        const tokenStart = (Number(token.column) || 1) - 1;
        if (tokenStart >= segment.realEnd) break;
        const tokenEnd = tokenStart + String(token.value || "").length;
        const from = Math.max(segment.realStart, tokenStart);
        const to = Math.min(segment.realEnd, tokenEnd);
        if (from >= to) continue;
        const value = displayText.slice(segment.displayStart, segment.displayEnd);
        const previous = visible[visible.length - 1];
        if (
          previous && previous._sourceToken === token &&
          previous.column - 1 + previous.value.length === segment.displayStart
        ) {
          previous.value += value;
        } else {
          visible.push({ ...token, value, column: segment.displayStart + 1, _sourceToken: token });
        }
      }
    }
    return visible.map(({ _sourceToken, ...token }) => token);
  }

  createLineOBJ(slicedLine, screenIndex) {
    const displayIndex = this.startIndex + screenIndex;
    const displayRow = this.getDisplayRow(displayIndex);
    const lineNode =
      displayRow?.documentIndex === null
        ? null
        : this.lines[displayRow?.documentIndex];
    const displayText = slicedLine?.displayText ?? slicedLine?.text ?? displayRow?.text ?? "";
    const diffSegments =
      displayRow?.type === "removed"
        ? [{ type: "removed", text: displayText }]
        : this.getVisibleDiffSegments(lineNode?.diffSegments, slicedLine);
    const diffState = displayRow?.type || null;
    const tokens = lineNode?.getTokens();
    const visibleTokens = this.getVisibleTokens(tokens, slicedLine);

    const lineOBJ = this.editor.writerController.textToOBJ(
      displayText,
      visibleTokens,
      diffSegments,
    );

    if (diffState) {
      this.getFastNode(lineOBJ)?.addClass(`line-${diffState}`);
    }

    const lineFast = this.getFastNode(lineOBJ);
    lineFast?.setStyle("position", "absolute");
    lineFast?.setTop(this.getLineTop(screenIndex));
    lineFast?.setLeft(0);

    return lineOBJ;
  }

  getVisibleDiffSegments(segments, slicedLine) {
    if (!Array.isArray(segments) || segments.length === 0 || !slicedLine)
      return null;
    const start = slicedLine.startChar || 0;
    const end = slicedLine.endChar ?? (start + slicedLine.text.length);
    this.diffSegmentOffsetCache ||= new WeakMap();
    let cached = this.diffSegmentOffsetCache.get(segments);
    if (!cached || cached.count !== segments.length) {
      const starts = [];
      let offset = 0;
      for (const segment of segments) {
        starts.push(offset);
        offset += String(segment.text ?? "").length;
      }
      cached = { count: segments.length, starts, ends: offset };
      this.diffSegmentOffsetCache.set(segments, cached);
    }
    if (slicedLine.segments?.length) {
      let segmentIndex = 0;
      let low = 0;
      let high = segments.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        const segmentEnd = cached.starts[mid] + String(segments[mid].text ?? "").length;
        if (segmentEnd <= start) low = mid + 1;
        else high = mid;
      }
      segmentIndex = low;
      const visible = [];
      for (const source of slicedLine.segments) {
        while (segmentIndex < segments.length) {
          const sourceEnd = cached.starts[segmentIndex] + String(segments[segmentIndex].text ?? "").length;
          if (sourceEnd > source.realStart) break;
          segmentIndex++;
        }
        const text = slicedLine.displayText.slice(source.displayStart, source.displayEnd);
        if (!text) continue;
        const type = segments[segmentIndex]?.type;
        const previous = visible[visible.length - 1];
        if (previous && previous.type === type) previous.text += text;
        else visible.push({ type, text });
      }
      return visible.length ? visible : null;
    }

    let low = 0;
    let high = segments.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const segmentEnd = cached.starts[mid] + String(segments[mid].text ?? "").length;
      if (segmentEnd <= start) low = mid + 1;
      else high = mid;
    }
    const visible = [];
    let offset = cached.starts[low] || 0;
    for (let index = low; index < segments.length; index++) {
      const segment = segments[index];
      const text = String(segment.text ?? "");
      const from = Math.max(start, offset);
      const to = Math.min(end, offset + text.length);
      if (from < to)
        visible.push({ ...segment, text: text.slice(from - offset, to - offset) });
      offset += text.length;
      if (offset >= end) break;
    }
    return visible.length && visible.map((segment) => segment.text).join("") === slicedLine.text
      ? visible
      : null;
  }

  getLineOBJ(row) {
    return this.editor.output.children[row - 1];
  }

  getLineNumberOBJ(dataIndex) {
    const screenIndex =
      this.getDisplayIndexForDocument(dataIndex) - this.startIndex;

    if (
      screenIndex >= 0 &&
      screenIndex < this.editor.lineNumberOutput.children.length
    ) {
      return this.editor.lineNumberOutput.children[screenIndex];
    }

    return null;
  }

  getWordsOBJ(row) {
    if (row === undefined) {
      return;
    }

    const l = this.getLineOBJ(row);

    return l ? l.children : undefined;
  }

  getWordOBJ(row, index) {
    if (row == null || index == null) {
      return;
    }

    const l = this.getLineOBJ(row);

    if (!l) {
      return;
    }

    return l.children[index];
  }

  refresh(forcedInit = false) {
    if (!this.editor.tabManager.activeFile) {
      return;
    }

    if (this.editor.tabManager.activeFile.loadError) {
      this.renderLoadError();
      return;
    }
    this.lineNumberFast?.setDisplay("block");
    this.outputFast?.setDisplay("block");
    this.outputFast?.removeClass("editor-load-error-output");
    this.selectOutputFast?.setDisplay("block");
    this.searchOutputFast?.setDisplay("block");

    if (this.lines.length === 0) {
      this.lines = [new LineNode("")];
    }

    // The model may have shrunk since the last frame. Clamp before choosing
    // dirty rows so the DOM is always projected from the current viewport.
    if (this.outputScroller.clampScrollState()) {
      this.editor.highlightController.lineNodes.clear();
      this.markDirtyAll();
    }

    if (this.index !== this.editor.cursorController.row) {
      this.index = this.editor.cursorController.row;
    }

    if (forcedInit) {
      this.initLineOutput();
    } else {
      this.refreshOutput();
    }

    this.refreshNumberLines();
    this.updateLineNumberWidth();

    this.outputScroller.updateNbItem();
    this.outputScroller.refresh();
    this.applyScrollTransform();

    this.editor.cursorController.updateCaretPosition();

    this.editor.selectController.refreshSelectionDOM();

    this.editor.searchController.refreshSelectionDOM();

    this.editor.highlightController.refresh();
  }

  onClickNumberLine(e) {
    try {
      const i = parseInt(e.target.dataset.line, 10);

      if (isNaN(i)) {
        return;
      }

      const isLineSelected = this.editor.selectController.hasLineSelection?.(i) ??
        this.editor.selectController.selectedLines.has(i);

      this.editor.selectController.unSelectAll();

      if (!isLineSelected) {
        this.editor.selectController.selectLine(i, true);
      } else {
        this.editor.cursorController.setCursorPosition(i + 1, 0);
      }
    } catch (error) {
      console.error(error);
    }
  }

  hide() {
    this.lineNumberFast?.removeChildren();
    this.outputFast?.removeChildren();
    this.lineNumberFast?.setDisplay("none");
    this.outputFast?.setDisplay("none");
    this.editor.cursorController?.caretFast?.setDisplay("none");
    this.selectOutputFast?.removeChildren();

    this.outputScroller.hide();
  }

  renderLoadError() {
    const file = this.editor.tabManager.activeFile;
    if (!file?.loadError) return;

    this.lineNumberFast?.removeChildren();
    this.lineNumberFast?.setDisplay("none");
    this.outputFast?.setDisplay("block");
    this.outputFast?.addClass("editor-load-error-output");
    this.outputFast?.removeChildren();

    const message = this.editor.domManager.createFastElement("div");
    message.setClassName("editor-load-error");
    message.setTextContent(
      file.loadError.code === "BINARY_FILE"
        ? "Binary file can't be opened"
        : file.loadError.code === "FILE_TOO_LARGE"
          ? "File is too large to be opened"
          : "File can't be opened",
    );
    this.outputFast?.appendChild(message);

    this.selectOutputFast?.removeChildren();
    this.selectOutputFast?.setDisplay("none");
    this.searchOutputFast?.removeChildren();
    this.searchOutputFast?.setDisplay("none");
    this.editor.cursorController?.caretFast?.setDisplay("none");
    this.outputScroller.hide();
  }

  show() {
    if (this.editor.tabManager.activeFile?.loadError) {
      this.renderLoadError();
      return;
    }
    this.lineNumberFast?.setDisplay("block");
    this.outputFast?.setDisplay("block");
    this.selectOutputFast?.setDisplay("block");
    this.searchOutputFast?.setDisplay("block");
    this.outputFast?.removeClass("editor-load-error-output");

    this.editor.cursorController?.caretFast?.setDisplay("block");

    this.outputScroller.show();

    if (!this.editor.isOnRefresh) {
      this.initLineOutput();

      this.initNumberLines();

      this.editor.highlightController.refresh();
    }
  }
}
