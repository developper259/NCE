class SearchController {
  constructor(editor) {
    this.editor = editor;

    this.searchBar = null;
    this.input = null;
    this.counter = null;

    this.previousButton = null;
    this.nextButton = null;
    this.closeButton = null;

    this.searchSelection = getElement(".editor-search-highlight");

    this.results = [];
    this.currentIndex = -1;

    this.isOpen = false;

    this.init();
  }

  init() {
    this.initSearchBar();

    addEvent("input", this.onInput.bind(this), this.input);
    addEvent("keydown", this.onInputKey.bind(this), this.input);

    addEvent("click", this.onPreviousClick.bind(this), this.previousButton);

    addEvent("click", this.onNextClick.bind(this), this.nextButton);

    addEvent("click", this.onCloseClick.bind(this), this.closeButton);
  }

  initSearchBar() {
    this.searchBar = getElement(".editor-search-bar");

    this.input = this.searchBar.querySelector(".search-bar-input");

    this.counter = this.searchBar.querySelector(".search-bar-counter");

    this.previousButton = this.searchBar.querySelector(".search-bar-previous");

    this.nextButton = this.searchBar.querySelector(".search-bar-next");

    this.closeButton = this.searchBar.querySelector(".search-bar-close");
  }

  open() {
    if (!this.editor.tabManager.activeFile) return;

    this.isOpen = true;

    this.searchBar.classList.add("search-bar-visible");

    this.input.focus({
      preventScroll: true,
    });

    this.input.select();

    this.search(this.input.value);
  }

  close() {
    this.isOpen = false;

    this.searchBar.classList.remove("search-bar-visible");

    this.clearResults();

    this.input.blur();

    this.editor.setSelected(true);

    this.editor.cursorController.updateCaretPosition();
  }

  toggle() {
    if (this.isOpen) {
      this.close();
      return;
    }

    this.open();
  }

  onInput() {
    this.search(this.input.value);
  }

  onInputKey(e) {
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

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();

      this.close();
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

  search(query) {
    this.clearResults();

    query = query || "";

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

    if (this.results.length > 0) {
      this.currentIndex = 0;

      this.goToResult(false, true);
    }

    this.refreshSelectionDOM();

    this.updateCounter();
  }

  next() {
    if (this.results.length === 0) return;

    this.currentIndex = (this.currentIndex + 1) % this.results.length;

    this.goToResult(true, true);
  }

  previous() {
    if (this.results.length === 0) return;

    this.currentIndex =
      (this.currentIndex - 1 + this.results.length) % this.results.length;

    this.goToResult(true, false);
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

    console.log(part, isNext, middle, screenRow, maxLines);

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
    const resultIndex = result.row - 1;

    const visibleLines = Math.max(1, lineController.maxLines);

    const centeredStartIndex = resultIndex - Math.floor(visibleLines / 2);

    lineController.scrollTo(centeredStartIndex);
  }

  clearResults() {
    this.results = [];

    this.currentIndex = -1;

    if (this.searchSelection) {
      this.searchSelection.replaceChildren();
    }

    this.updateCounter();
  }

  refreshSelectionDOM() {
    if (!this.searchSelection) return;

    if (!this.isOpen || this.results.length === 0) {
      this.searchSelection.replaceChildren();
      return;
    }

    const cursor = this.editor.cursorController;

    const visibleResults = this.results.filter((result) =>
      cursor.isRowVisible(result.row),
    );

    const currentDOMNodes = this.searchSelection.children;

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

        this.searchSelection.appendChild(div);
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
