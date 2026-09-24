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
    this.currentIndex = -1;
    this.query = "";

    this.isOpen = false;
    this.replaceExpanded = false;

    this.init();
  }

  init() {
    this.initSearchBar();

    addEvent("input", this.onInput.bind(this), this.input);
    addEvent("keydown", this.onInputKey.bind(this), this.input);
    addEvent("input", this.saveActiveTabState.bind(this), this.replaceInput);

    addEvent("click", this.onPreviousClick.bind(this), this.previousButton);

    addEvent("click", this.onNextClick.bind(this), this.nextButton);

    addEvent("click", this.onCloseClick.bind(this), this.closeButton);
    addEvent("click", this.toggleReplace.bind(this), this.expandButton);
    addEvent("click", this.replaceNext.bind(this), this.replaceNextButton);
    addEvent("click", this.replaceAll.bind(this), this.replaceAllButton);
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
    for (const result of [...this.results].reverse()) {
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

    this.currentIndex = -1;

    if (this.editor.searchOutput) {
      this.editor.searchOutput.replaceChildren();
    }

    this.updateCounter();
  }

  refreshSelectionDOM() {
    if (!this.editor.searchOutput) return;

    if (!this.isOpen || this.results.length === 0) {
      this.editor.searchOutput.replaceChildren();
      return;
    }

    const cursor = this.editor.cursorController;

    const visibleResults = this.results.filter((result) =>
      cursor.isRowVisible(result.row),
    );

    const currentDOMNodes = this.editor.searchOutput.children;

    const totalLength = Math.max(visibleResults.length, currentDOMNodes.length);

    for (let i = 0; i < totalLength; i++) {
      if (i >= visibleResults.length) {
        if (currentDOMNodes[i]) {
          currentDOMNodes[i].style.display = "none";
        }

        continue;
      }

      const result = visibleResults[i];

      const viewStart = cursor.getViewPosition(
        result.row,
        result.column,
      ).column;

      const viewEnd = cursor.getViewPosition(
        result.row,
        result.column + result.length,
      ).column;

      const x = cursor.columnToX(viewStart + 1);

      const width = Math.max(1, viewEnd - viewStart) * this.editor.letterSize;

      const y = cursor.rowToY(result.row) - 4;

      const height = cursor.mpY + 4;

      let div = currentDOMNodes[i];

      if (!div) {
        div = document.createElement("div");

        div.style.position = "absolute";

        this.editor.searchOutput.appendChild(div);
      }

      const resultIndex = this.results.indexOf(result);

      div.className =
        resultIndex === this.currentIndex
          ? "search-match search-match-active"
          : "search-match";

      div.dataset.resultIndex = resultIndex;

      div.style.display = "";

      div.style.left = `${x}px`;

      div.style.top = `${y}px`;

      div.style.width = `${width}px`;

      div.style.height = `${height}px`;
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
