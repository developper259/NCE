class SearchController {
  constructor(editor) {
    this.editor = editor;

    this.searchBar = null;
    this.input = null;
    this.counter = null;

    this.previousButton = null;
    this.nextButton = null;
    this.closeButton = null;
    this.expandButton = null;
    this.replaceInput = null;
    this.replaceContainer = null;
    this.replaceActions = null;

    this.results = [];
    this.resultsByRow = new Map();
    this.searchFastNodes = new WeakMap();
    this.currentIndex = -1;
    this.query = "";

    this.isOpen = false;
    this.replaceExpanded = false;

    this.init();
  }

  init() {
    this.initSearchBar();

    addEvent("keydown", this.onInputKey.bind(this), this.input);
  }

  getSearchFastNode(node) {
    if (!node) return null;
    let fastNode = this.searchFastNodes.get(node);
    if (!fastNode) {
      fastNode = this.editor.domManager?.wrapFastNode?.(node) || null;
      if (fastNode) this.searchFastNodes.set(node, fastNode);
    }
    return fastNode;
  }

  initSearchBar() {
    this.searchBar = this.editor.domManager.getElement(".editor-search-bar");

    this.input = this.editor.domManager.getElement(
      ".search-bar-input",
      this.searchBar,
    );

    this.counter = this.editor.domManager.getElement(
      ".search-bar-counter",
      this.searchBar,
    );

    this.previousButton = this.editor.domManager.getElement(
      ".search-bar-previous",
      this.searchBar,
    );

    this.nextButton = this.editor.domManager.getElement(
      ".search-bar-next",
      this.searchBar,
    );

    this.closeButton = this.editor.domManager.getElement(
      ".search-bar-close",
      this.searchBar,
    );
    this.expandButton = this.editor.domManager.getElement(".search-bar-expand", this.searchBar);
    this.replaceInput = this.editor.domManager.getElement(".search-bar-replace-input", this.searchBar);
    this.replaceContainer = this.editor.domManager.getElement(".search-bar-replace-container", this.searchBar);
    this.replaceActions = this.editor.domManager.getElement(".search-bar-replace-actions", this.searchBar);
    this.replaceButton = this.editor.domManager.getElement(".search-bar-replace", this.searchBar);
    this.replaceNextButton = this.editor.domManager.getElement(".search-bar-replace-next", this.searchBar);
    this.replaceAllButton = this.editor.domManager.getElement(".search-bar-replace-all", this.searchBar);
  }

  focusInput() {
    if (!this.input || !this.isOpen) return;

    this.input.focus({
      preventScroll: true,
    });

    this.input.select();

    this.editor.cursorController.disable();
  }

  open(options = {}) {
    if (!this.editor.tabManager.activeFile) return;

    // Get selected text if requested and selection exists
    let initialQuery = this.query;
    if (options.useSelection) {
      const selectedText = this.editor.selectController?.containsSelected;
      if (
        selectedText &&
        typeof selectedText === "string" &&
        selectedText.trim()
      ) {
        // Only use single-line selections to avoid breaking the search
        if (!selectedText.includes("\n")) {
          initialQuery = selectedText;
        }
      }
    }

    this.isOpen = true;

    this.searchBar.classList.add("search-bar-visible");
    this.applyReplaceExpandedState();

    if (!options.useSelection) this.input.value = this.query;

    // Set the input value before focusing if we have a selection
    if (options.useSelection && initialQuery !== this.input.value) {
      this.input.value = initialQuery;
      this.query = initialQuery;
    }

    this.focusInput();

    const activeFile = this.editor.tabManager.activeFile;
    const savedIndex = activeFile?.searchCurrentIndex;
    this.search(this.input.value);

    if (this.results.length > 0) {
      this.currentIndex = Number.isInteger(savedIndex)
        ? Math.min(Math.max(savedIndex, 0), this.results.length - 1)
        : 0;
      this.goToResult(false, true);
    }
    this.saveActiveTabState();
  }

  close() {
    this.saveActiveTabState();
    this.isOpen = false;

    this.searchBar.classList.remove("search-bar-visible");
    this.searchBar.classList.remove("search-bar-expanded");
    this.replaceExpanded = false;
    this.applyReplaceExpandedState();
    this.replaceContainer.hidden = true;
    this.replaceActions.hidden = true;

    this.clearResults();

    this.input.blur();

    this.editor.setSelected(true);

    this.editor.cursorController.updateCaretPosition();
  }

  toggle(options = {}) {
    if (this.isOpen) {
      // If already open and we have a selection, update the query
      if (options.useSelection) {
        const selectedText = this.editor.selectController?.containsSelected;
        if (
          selectedText &&
          typeof selectedText === "string" &&
          selectedText.trim()
        ) {
          if (!selectedText.includes("\n")) {
            this.input.value = selectedText;
            this.query = selectedText;
            this.search(selectedText);
            if (this.results.length > 0) {
              this.currentIndex = 0;
              this.goToResult(true, true);
            }
          }
        }
      }
      this.focusInput();
      return;
    }

    this.open(options);
  }

  onInput() {
    this.query = this.input.value || "";
    this.search(this.input.value);

    this.currentIndex = this.results.length > 0 ? 0 : -1;
    this.goToResult(true, true);
    this.saveActiveTabState();
  }

  onInputKey(e) {
    if (e.target instanceof HTMLInputElement) {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();

        if (e.shiftKey) {
          this.previous();
        } else {
          this.next();
        }

        return;
      }
    }
  }

  onPreviousClick() {
    this.previous();
  }

  onNextClick() {
    this.next();
  }

  onCloseClick() {
    this.close();
  }

  toggleReplace() {
    this.replaceExpanded = !this.replaceExpanded;
    const expanded = this.replaceExpanded;
    this.applyReplaceExpandedState();
    if (expanded) this.replaceInput.focus({ preventScroll: true });
  }

  saveActiveTabState(tab = this.editor.tabManager.activeFile) {
    if (!tab || tab.type !== TAB_TYPES.FILE) return;
    tab.searchReplaceValue = this.replaceInput?.value || "";
    tab.searchCurrentIndex = Number.isInteger(this.currentIndex)
      ? this.currentIndex
      : -1;
  }

  restoreTabState(tab) {
    if (!tab || tab.type !== TAB_TYPES.FILE) return;
    this.input.value = this.query;
    this.replaceInput.value = typeof tab.searchReplaceValue === "string"
      ? tab.searchReplaceValue
      : "";
    this.search(this.input.value);
    const savedIndex = Number.isInteger(tab.searchCurrentIndex)
      ? tab.searchCurrentIndex
      : -1;
    this.currentIndex = this.results.length > 0
      ? Math.min(Math.max(savedIndex, 0), this.results.length - 1)
      : -1;
    this.updateCounter();
    this.refreshSelectionDOM();
  }

  applyReplaceExpandedState() {
    const expanded = this.replaceExpanded;
    this.searchBar.classList.toggle("search-bar-expanded", expanded);
    this.replaceContainer.hidden = !expanded;
    this.replaceActions.hidden = !expanded;
    this.expandButton.setAttribute("aria-expanded", String(expanded));
    this.expandButton.querySelector("i")?.classList.toggle("fi-rr-angle-small-down", !expanded);
    this.expandButton.querySelector("i")?.classList.toggle("fi-rr-angle-small-up", expanded);
  }

  getWorkspaceState() {
    return {
      query: this.query,
      isVisible: this.isOpen === true,
      isExpanded: this.replaceExpanded === true,
      expandButtonActivated:
        this.expandButton?.getAttribute("aria-expanded") === "true",
    };
  }

  restoreWorkspaceState(state) {
    this.isOpen = state?.isVisible === true &&
      Boolean(this.editor.tabManager.activeFile);
    this.replaceExpanded =
      state?.isExpanded === true || state?.expandButtonActivated === true;
    this.query = typeof state?.query === "string" ? state.query : this.query;

    this.searchBar.classList.toggle("search-bar-visible", this.isOpen);
    this.searchBar.classList.remove("search-bar-expanded");
    this.applyReplaceExpandedState();
    this.restoreTabState(this.editor.tabManager.activeFile);
  }

  replaceCurrent() {
    const result = this.results[this.currentIndex];
    if (!result) return;
    this.editor.writerController.replaceRange(
      this.replaceInput.value, result.row, result.column,
      result.row, result.column + result.length,
    );
    this.search(this.input.value);
    this.saveActiveTabState();
  }

  replaceNext() {
    this.replaceCurrent();
    if (this.results.length) this.next();
  }

  replaceAll() {
    const replacement = this.replaceInput.value;
    for (let index = this.results.length - 1; index >= 0; index--) {
      const result = this.results[index];
      this.editor.writerController.replaceRange(
        replacement, result.row, result.column,
        result.row, result.column + result.length,
      );
    }
    this.search(this.input.value);
    this.currentIndex = this.results.length ? 0 : -1;
    this.saveActiveTabState();
    this.refreshSelectionDOM();
  }

  search(query) {
    this.clearResults();

    query = query || "";
    this.query = query;

    if (!query) {
      this.updateCounter();
      return;
    }

    if (!this.editor.tabManager.activeFile) {
      this.updateCounter();
      return;
    }

    const lines = this.editor.lineController.lines;

    const normalizedQuery = query.toLocaleLowerCase();

    for (let i = 0; i < lines.length; i++) {
      const lineNode = lines[i];

      if (!lineNode) continue;

      const text = lineNode.getText();

      if (!text) continue;

      const normalizedText = text.toLocaleLowerCase();

      let start = 0;

      while (start < normalizedText.length) {
        const index = normalizedText.indexOf(normalizedQuery, start);

        if (index === -1) break;

        this.results.push({
          row: i + 1,

          column: index,

          length: query.length,
        });

        start = index + Math.max(query.length, 1);
      }
    }

    this.resultsByRow.clear();
    for (let index = 0; index < this.results.length; index++) {
      const row = this.results[index].row;
      const range = this.resultsByRow.get(row);
      if (range) range.end = index + 1;
      else this.resultsByRow.set(row, { start: index, end: index + 1 });
    }

    this.refreshSelectionDOM();

    this.updateCounter();
  }

  next() {
    if (this.results.length === 0) return;

    this.editor.isButtonChangePosition = true;

    this.currentIndex = (this.currentIndex + 1) % this.results.length;
    this.saveActiveTabState();

    this.goToResult(true, true);

    this.editor.focusOutput();
  }

  previous() {
    if (this.results.length === 0) return;

    this.editor.isButtonChangePosition = true;

    this.currentIndex =
      (this.currentIndex - 1 + this.results.length) % this.results.length;
    this.saveActiveTabState();

    this.goToResult(true, false);

    this.editor.focusOutput();
  }

  goToResult(allowScroll = true, isNext = false) {
    const result = this.results[this.currentIndex];

    if (!result) return;

    const screenRow = result.row - 1 - this.editor.lineController.startIndex;

    const maxLines = this.editor.lineController.maxLines;
    const middle = Math.floor(maxLines / 3);
    let part = 2;

    if (screenRow <= middle) part = 1;
    else if (screenRow >= maxLines - middle) part = 3;

    if (isNext && part === 1) part = 2;
    else if (!isNext && part === 3) part = 2;

    if (allowScroll && (!this.isResultVisible(result) || part !== 2)) {
      this.scrollToResult(result);
    }

    this.editor.cursorController.setCursorPosition(
      result.row,
      result.column + result.length,
    );

    this.refreshSelectionDOM();

    this.updateCounter();
  }

  isResultVisible(result) {
    return this.editor.cursorController.isRowVisible(result.row);
  }

  scrollToResult(result) {
    const lineController = this.editor.lineController;
    const documentIndex = result.row - 1;
    const displayIndex =
      lineController.getDisplayIndexForDocument(documentIndex);
    const resultIndex = displayIndex >= 0 ? displayIndex : documentIndex;

    const visibleLines = Math.max(1, lineController.maxLines);

    const centeredStartIndex = resultIndex - Math.floor(visibleLines / 2);

    lineController.scrollTo(centeredStartIndex);
  }

  clearResults() {
    this.results = [];
    this.resultsByRow.clear();

    this.currentIndex = -1;

    if (this.editor.searchOutput) {
      for (const node of this.editor.searchOutput.children || []) {
        const fastNode = this.getSearchFastNode(node);
        if (fastNode) fastNode.setDisplay("none");
        else node.style.display = "none";
      }
    }

    this.updateCounter();
  }

  refreshSelectionDOM() {
    if (!this.editor.searchOutput) return;

    if (!this.isOpen || this.results.length === 0) {
      for (const node of this.editor.searchOutput.children || []) {
        const fastNode = this.getSearchFastNode(node);
        if (fastNode) fastNode.setDisplay("none");
        else node.style.display = "none";
      }
      return;
    }

    const cursor = this.editor.cursorController;
    const lc = this.editor.lineController;
    const visibleResults = [];
    const visibleLineCount = Math.max(0, Math.min(
      lc.renderedLineCount || lc.maxViewLines || 1,
      lc.getDisplayLineCount() - lc.startIndex,
    ));
    const viewportStart = lc.offsetX || 0;
    const viewportEnd = viewportStart + lc.maxCharactersPerLine;

    for (let screenIndex = 0; screenIndex < visibleLineCount; screenIndex++) {
      const displayRow = lc.getDisplayRow(lc.startIndex + screenIndex);
      if (!displayRow || displayRow.documentIndex === null) continue;
      const row = displayRow.documentIndex + 1;
      const lineNode = lc.lines[displayRow.documentIndex];
      const positionIndex = lineNode?.getPositionIndex?.();
      if (!positionIndex) continue;
      const rowRange = this.resultsByRow.get(row);
      if (!rowRange) continue;
      const { start: rowStart, end: rowEnd } = rowRange;
      const visibleRealStart = positionIndex.visualToReal(viewportStart, "previous");
      let matchLow = rowStart;
      let matchHigh = rowEnd;
      while (matchLow < matchHigh) {
        const mid = (matchLow + matchHigh) >>> 1;
        if (this.results[mid].column < visibleRealStart) matchLow = mid + 1;
        else matchHigh = mid;
      }
      const firstMatch = Math.max(rowStart, matchLow - 1);
      for (let index = firstMatch; index < rowEnd; index++) {
        const result = this.results[index];
        const viewStart = positionIndex.realToVisual(result.column);
        if (viewStart >= viewportEnd) break;
        const viewEnd = positionIndex.realToVisual(result.column + result.length);
        if (viewEnd <= viewportStart) continue;
        visibleResults.push({ result, resultIndex: index, viewStart, viewEnd, screenIndex });
      }
    }

    const currentDOMNodes = this.editor.searchOutput.children;

    const totalLength = Math.max(visibleResults.length, currentDOMNodes.length);

    for (let i = 0; i < totalLength; i++) {
      if (i >= visibleResults.length) {
        if (currentDOMNodes[i]) {
          const fastNode = this.getSearchFastNode(currentDOMNodes[i]);
          if (fastNode) fastNode.setDisplay("none");
          else currentDOMNodes[i].style.display = "none";
        }

        continue;
      }

      const { result, resultIndex, viewStart, viewEnd, screenIndex } = visibleResults[i];
      const clippedStart = Math.max(viewStart, viewportStart);
      const clippedEnd = Math.min(viewEnd, viewportEnd);
      const x = cursor.columnToX(clippedStart + 1);
      const width = Math.max(1, clippedEnd - clippedStart) * this.editor.letterSize;
      const y = lc.getLineTop(screenIndex);

      const height = cursor.mpY + 4;

      let div = currentDOMNodes[i];

      if (!div) {
        div = document.createElement("div");
        const fastNode = this.getSearchFastNode(div);
        if (fastNode) fastNode.setStyle("position", "absolute");
        else div.style.position = "absolute";

        this.editor.searchOutput.appendChild(div);
      }

      const fastNode = this.getSearchFastNode(div);
      const className = resultIndex === this.currentIndex
        ? "search-match search-match-active"
        : "search-match";
      const meta = { x, y, width, height, resultIndex, className };
      const oldMeta = div.__nceSearchMeta;
      if (fastNode) {
        fastNode.setClassName(className);
        fastNode.setDataset("resultIndex", resultIndex);
        fastNode.setDisplay("");
        if (!oldMeta || oldMeta.x !== x) fastNode.setLeft(x);
        if (!oldMeta || oldMeta.y !== y) fastNode.setTop(y);
        if (!oldMeta || oldMeta.width !== width) fastNode.setWidth(width);
        if (!oldMeta || oldMeta.height !== height) fastNode.setHeight(height);
      } else {
        div.className = className;
        div.dataset.resultIndex = resultIndex;
        div.style.display = "";
        if (!oldMeta || oldMeta.x !== x) div.style.left = `${x}px`;
        if (!oldMeta || oldMeta.y !== y) div.style.top = `${y}px`;
        if (!oldMeta || oldMeta.width !== width) div.style.width = `${width}px`;
        if (!oldMeta || oldMeta.height !== height) div.style.height = `${height}px`;
      }
      div.__nceSearchMeta = meta;
    }
  }

  updateCounter() {
    if (!this.counter) return;

    if (this.results.length === 0) {
      this.counter.textContent = this.input?.value ? "0/0" : "";

      return;
    }

    this.counter.textContent = `${this.currentIndex + 1}/${this.results.length}`;
  }

  refresh() {
    if (!this.isOpen) return;

    this.search(this.input.value);
  }

  onFileChange() {
    if (!this.isOpen) return;

    this.search(this.input.value);
  }
}
