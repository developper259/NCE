class SearchSidebar extends Sidebar {
  constructor(editor) {
    super("search", "Search", "fi fi-rr-search", "left", editor);

    this.container = null;
    this.input = null;
    this.replaceInput = null;
    this.replaceRow = null;
    this.replaceExpandButton = null;
    this.replaceExpandIcon = null;
    this.replaceAllButton = null;
    this.searchBox = null;
    this.includeInput = null;
    this.excludeInput = null;
    this.summaryElement = null;
    this.resultsElement = null;
    this.resultsLayer = null;
    this.resultsViewState = null;
    this.resetResultsScroll = true;
    this.resultsScroller = new SearchResultsScroller(
      editor,
      (item) => this.createResultNode(item),
      () => this.loadMoreResults(),
    );
    this.caseButton = null;
    this.wordButton = null;
    this.regexButton = null;

    this.query = "";
    this.include = "";
    this.exclude = "";

    this.caseSensitive = false;
    this.wholeWord = false;
    this.useRegex = false;

    this.results = [];
    this.totalMatches = 0;
    this.filesSearched = 0;
    this.resultsPageSize = 10000;
    this.nextResultsOffset = 0;
    this.hasMoreResults = false;
    this.isLoadingMore = false;

    this.isSearching = false;
    this.searchTimer = null;
    this.workspaceGeneration = 0;
    this.searchGeneration = 0;
    this.activeRequestId = null;
    this.activeSearchSessionId = null;
    this.isReplacing = false;
    this.replaceExpanded = false;
    this.resultOpenController = null;
  }

  render() {
    if (this.container) {
      this.updateView();
      return this.container;
    }

    const container = document.createElement("div");
    container.className = "search-sidebar-container";
    this.container = container;

    const title = document.createElement("div");
    title.className = "sidebar-main-title";
    title.textContent = "SEARCH";
    container.appendChild(title);

    const searchBox = document.createElement("div");
    searchBox.className = "search-sidebar-box";
    this.searchBox = searchBox;

    const inputWrapper = document.createElement("div");
    inputWrapper.className = "search-sidebar-input-wrapper";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "search-sidebar-input";
    input.placeholder = "Search in files";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = this.query;
    this.input = input;

    const options = document.createElement("div");
    options.className = "search-sidebar-options";

    this.caseButton = this.createOptionButton(
      "Aa",
      "Match Case",
      this.caseSensitive,
      () => {
        this.caseSensitive = !this.caseSensitive;
        this.runSearch();
        return this.caseSensitive;
      },
    );

    this.wordButton = this.createOptionButton(
      "ab",
      "Whole Word",
      this.wholeWord,
      () => {
        this.wholeWord = !this.wholeWord;
        this.runSearch();
        return this.wholeWord;
      },
    );

    this.regexButton = this.createOptionButton(
      ".*",
      "Use Regular Expression",
      this.useRegex,
      () => {
        this.useRegex = !this.useRegex;
        this.runSearch();
        return this.useRegex;
      },
    );

    options.append(this.caseButton, this.wordButton, this.regexButton);

    inputWrapper.append(input, options);

    const replaceRow = document.createElement("div");
    replaceRow.className = "search-sidebar-replace-row";
    this.replaceRow = replaceRow;
    replaceRow.hidden = !this.replaceExpanded;
    const replaceExpand = document.createElement("button");
    replaceExpand.type = "button";
    replaceExpand.className = "search-sidebar-expand";
    this.replaceExpandButton = replaceExpand;
    replaceExpand.title = "Show replace input";
    replaceExpand.setAttribute("aria-label", "Show replace input");
    replaceExpand.setAttribute("aria-expanded", "false");
    const replaceExpandIcon = document.createElement("i");
    replaceExpandIcon.className = "fi fi-rr-angle-small-down";
    this.replaceExpandIcon = replaceExpandIcon;
    replaceExpand.appendChild(replaceExpandIcon);

    const replaceInput = document.createElement("input");
    replaceInput.type = "text";
    replaceInput.className = "search-sidebar-replace-input";
    replaceInput.placeholder = "Replace";
    replaceInput.autocomplete = "off";
    replaceInput.spellcheck = false;
    this.replaceInput = replaceInput;
    replaceRow.hidden = !this.replaceExpanded;
    replaceInput.hidden = !this.replaceExpanded;

    const replaceAll = this.createActionButton("Replace All", "⟳", () => this.replaceAll());
    replaceRow.append(replaceInput, replaceAll);
    replaceInput.hidden = !this.replaceExpanded;
    replaceAll.hidden = !this.replaceExpanded;
    this.replaceAllButton = replaceAll;
    searchBox.classList.toggle("search-sidebar-replace-expanded", this.replaceExpanded);
    replaceExpand.setAttribute("aria-expanded", String(this.replaceExpanded));
    replaceExpand.title = this.replaceExpanded ? "Hide replace input" : "Show replace input";
    replaceExpand.setAttribute("aria-label", replaceExpand.title);
    replaceExpandIcon.classList.toggle("fi-rr-angle-small-down", !this.replaceExpanded);
    replaceExpandIcon.classList.toggle("fi-rr-angle-small-up", this.replaceExpanded);

    replaceExpand.addEventListener("click", () => {
      this.replaceExpanded = !this.replaceExpanded;
      searchBox.classList.toggle("search-sidebar-replace-expanded", this.replaceExpanded);
      replaceRow.hidden = !this.replaceExpanded;
      replaceInput.hidden = !this.replaceExpanded;
      replaceAll.hidden = !this.replaceExpanded;
      replaceExpand.setAttribute("aria-expanded", String(this.replaceExpanded));
      replaceExpand.title = this.replaceExpanded ? "Hide replace input" : "Show replace input";
      replaceExpand.setAttribute("aria-label", replaceExpand.title);
      replaceExpandIcon.classList.toggle("fi-rr-angle-small-down", !this.replaceExpanded);
      replaceExpandIcon.classList.toggle("fi-rr-angle-small-up", this.replaceExpanded);
      if (this.replaceExpanded) replaceInput.focus();
    });

    const include = document.createElement("input");
    include.type = "text";
    include.className = "search-sidebar-filter";
    include.placeholder = "files to include (e.g. src/**/*.js)";
    include.value = this.include;
    this.includeInput = include;

    const exclude = document.createElement("input");
    exclude.type = "text";
    exclude.className = "search-sidebar-filter";
    exclude.placeholder = "files to exclude (e.g. **/*.min.js)";
    exclude.value = this.exclude;
    this.excludeInput = exclude;

    searchBox.append(replaceExpand, inputWrapper, replaceRow, include, exclude);
    container.appendChild(searchBox);

    const summary = document.createElement("div");
    summary.className = "search-sidebar-summary";
    summary.textContent = this.getSummaryText();
    this.summaryElement = summary;
    container.appendChild(summary);

    const results = document.createElement("div");
    results.className = "search-sidebar-results";
    this.resultsElement = results;
    const resultsLayer = this.editor.domManager.createFastElement("div");
    resultsLayer.setClassName("search-sidebar-results-layer");
    this.resultsLayer = resultsLayer.domNode;
    this.editor.domManager.wrapFastNode(results)?.appendChild(resultsLayer);
    this.renderResults();
    container.appendChild(results);
    this.resultsScroller.attach(results, this.resultsLayer);

    const scheduleSearch = () => {
      this.cancelResultNavigation();
      this.cancelActiveSearch();
      this.searchGeneration++;
      this.query = input.value;
      this.include = include.value;
      this.exclude = exclude.value;

      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.runSearch(), 180);
    };

    input.addEventListener("input", scheduleSearch);
    include.addEventListener("input", scheduleSearch);
    exclude.addEventListener("input", scheduleSearch);

    replaceInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") this.replaceAll();
    });

    input.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") {
        return;
      }

      input.value = "";
      this.query = "";
      this.clearResults();
      this.refresh();
    });

    return container;
  }

  updateView() {
    if (this.input && this.input.value !== this.query) {
      this.input.value = this.query;
    }
    if (this.summaryElement) {
      this.summaryElement.textContent = this.getSummaryText();
    }
    if (this.resultsElement) {
      this.renderResults();
    }
    if (this.caseButton) {
      this.caseButton.classList.toggle(
        "sidebar-option-active",
        this.caseSensitive,
      );
    }
    if (this.wordButton) {
      this.wordButton.classList.toggle("sidebar-option-active", this.wholeWord);
    }
    if (this.regexButton) {
      this.regexButton.classList.toggle("sidebar-option-active", this.useRegex);
    }
  }

  refresh() {
    if (!this.container) {
      return;
    }
    this.updateView();
  }

  restoreQueryState(state, { runSearch = false } = {}) {
    this.query = typeof state?.query === "string" ? state.query : "";
    this.replaceExpanded = state?.sidebarExpanded === true;
    if (this.input) this.input.value = this.query;
    this.applyReplaceExpandedState();
    this.clearResults();
    if (runSearch && this.isOpen && this.query.trim()) {
      this.runSearch();
    } else {
      this.refresh();
    }
  }

  applyReplaceExpandedState() {
    const expanded = this.replaceExpanded;
    this.searchBox?.classList.toggle("search-sidebar-replace-expanded", expanded);
    if (this.replaceRow) this.replaceRow.hidden = !expanded;
    if (this.replaceInput) this.replaceInput.hidden = !expanded;
    if (this.replaceAllButton) this.replaceAllButton.hidden = !expanded;
    this.replaceExpandButton?.setAttribute("aria-expanded", String(expanded));
    const label = expanded ? "Hide replace input" : "Show replace input";
    if (this.replaceExpandButton) {
      this.replaceExpandButton.title = label;
      this.replaceExpandButton.setAttribute("aria-label", label);
    }
    this.replaceExpandIcon?.classList.toggle("fi-rr-angle-small-down", !expanded);
    this.replaceExpandIcon?.classList.toggle("fi-rr-angle-small-up", expanded);
  }

  createOptionButton(label, title, active, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `search-sidebar-option ${active ? "sidebar-option-active" : ""}`;
    button.textContent = label;
    button.title = title;

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const isActive = onClick();
      if (isActive !== undefined) {
        button.classList.toggle("sidebar-option-active", isActive);
      } else {
        button.classList.toggle("sidebar-option-active");
      }
    });

    return button;
  }

  createActionButton(title, label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-sidebar-action";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  async replaceAll() {
    await this.replaceInFiles();
  }

  async replaceInFiles() {
    if (this.isReplacing || !this.query || !this.replaceInput?.value || !this.editor.api.replaceInFiles) return;
    this.isReplacing = true;
    try {
      const result = await this.editor.api.replaceInFiles(this.editor.fileExplorer.rootPath, this.query, this.replaceInput.value, {
        include: this.include,
        exclude: this.exclude,
        caseSensitive: this.caseSensitive,
        wholeWord: this.wholeWord,
        useRegex: this.useRegex,
        ignoreHiddenDirectories: true,
      });
      if (!result?.success) console.error("Workspace replacement failed:", result?.error);
      await this.runSearch();
    } finally {
      this.isReplacing = false;
    }
  }

  async runSearch() {
    this.cancelResultNavigation();
    if (!this.isOpen) {
      return;
    }

    if (!this.query.trim()) {
      this.clearResults();
      this.refresh();
      return;
    }

    const rootPath = this.editor.fileExplorer.rootPath;
    if (!rootPath) {
      this.clearResults();
      this.refresh();
      return;
    }
    const workspaceGeneration = this.workspaceGeneration;
    const searchGeneration = ++this.searchGeneration;
    const sessionId = `workspace-search-session-${workspaceGeneration}-${searchGeneration}`;
    const requestId = sessionId;
    const previousRequestId = this.activeRequestId;
    const previousSessionId = this.activeSearchSessionId;
    this.activeRequestId = requestId;
    this.activeSearchSessionId = sessionId;
    if (previousRequestId) this.editor.api.cancelSearch?.(previousRequestId);
    if (previousSessionId && previousSessionId !== previousRequestId)
      this.editor.api.cancelSearch?.(previousSessionId);
    this.isLoadingMore = false;
    this.hasMoreResults = false;
    this.nextResultsOffset = 0;
    this.resetResultsScroll = true;

    this.isSearching = true;
    this.refresh();

    try {
      const response = await this.editor.api.searchInFiles(
        rootPath,
        this.query,
        {
          include: this.include,
          exclude: this.exclude,
          caseSensitive: this.caseSensitive,
          wholeWord: this.wholeWord,
          useRegex: this.useRegex,
          ignoreHiddenDirectories: true,
          offset: 0,
          limit: this.resultsPageSize,
          requestId,
          sessionId,
          workspaceGeneration,
        },
      );

      if (
        !this.isOpen ||
        searchGeneration !== this.searchGeneration ||
        workspaceGeneration !== this.workspaceGeneration ||
        !NCEPath.equals(rootPath, this.editor.fileExplorer.rootPath)
      ) {
        return;
      }

      this.results = Array.isArray(response?.results) ? response.results : [];
      this.totalMatches = response?.totalMatches || 0;
      this.filesSearched = response?.filesSearched || 0;
      this.nextResultsOffset = (response?.offset ?? 0) + this.results.length;
      this.hasMoreResults = this.results.length > 0 &&
        (response?.hasMore ?? this.nextResultsOffset < this.totalMatches);
    } catch (error) {
      console.error("Error searching workspace:", error);
      this.clearResults();
    } finally {
      if (searchGeneration === this.searchGeneration) {
        if (this.activeRequestId === requestId) this.activeRequestId = null;
        this.isSearching = false;
        this.refresh();
      }
    }
  }

  clearResults() {
    this.cancelResultNavigation();
    this.cancelActiveSearch();
    this.results = [];
    this.totalMatches = 0;
    this.filesSearched = 0;
    this.nextResultsOffset = 0;
    this.hasMoreResults = false;
    this.isLoadingMore = false;
    this.resetResultsScroll = true;
    this.isSearching = false;
  }

  cancelActiveSearch() {
    if (this.activeRequestId)
      this.editor.api.cancelSearch?.(this.activeRequestId);
    if (
      this.activeSearchSessionId &&
      this.activeSearchSessionId !== this.activeRequestId
    )
      this.editor.api.cancelSearch?.(this.activeSearchSessionId);
    this.activeRequestId = null;
    this.activeSearchSessionId = null;
  }

  async loadMoreResults() {
    if (
      !this.isOpen ||
      this.isSearching ||
      this.isLoadingMore ||
      !this.hasMoreResults ||
      !this.query
    ) {
      return;
    }

    const rootPath = this.editor.fileExplorer.rootPath;
    const workspaceGeneration = this.workspaceGeneration;
    const searchGeneration = this.searchGeneration;
    const offset = this.nextResultsOffset;
    const requestId = `workspace-search-${searchGeneration}-page-${offset}`;
    this.activeRequestId = requestId;
    this.isLoadingMore = true;

    try {
      const response = await this.editor.api.searchInFiles(
        rootPath,
        this.query,
        {
          include: this.include,
          exclude: this.exclude,
          caseSensitive: this.caseSensitive,
          wholeWord: this.wholeWord,
          useRegex: this.useRegex,
          ignoreHiddenDirectories: true,
          offset,
          limit: this.resultsPageSize,
          requestId,
          sessionId: this.activeSearchSessionId,
          workspaceGeneration,
        },
      );

      if (
        !this.isOpen ||
        searchGeneration !== this.searchGeneration ||
        workspaceGeneration !== this.workspaceGeneration ||
        !NCEPath.equals(rootPath, this.editor.fileExplorer.rootPath)
      ) {
        return;
      }

      const pageResults = Array.isArray(response?.results) ? response.results : [];
      this.results = this.results.concat(pageResults);
      this.totalMatches = response?.totalMatches ?? this.totalMatches;
      this.filesSearched = response?.filesSearched ?? this.filesSearched;
      this.nextResultsOffset = (response?.offset ?? offset) + pageResults.length;
      this.hasMoreResults = pageResults.length > 0 &&
        (response?.hasMore ?? this.nextResultsOffset < this.totalMatches);

      this.resetResultsScroll = false;
      this.refresh();
    } catch (error) {
      console.error("Error loading more workspace search results:", error);
    } finally {
      if (searchGeneration === this.searchGeneration) {
        if (this.activeRequestId === requestId) this.activeRequestId = null;
        this.isLoadingMore = false;
        this.refresh();
      }
    }
  }

  resetWorkspace() {
    clearTimeout(this.searchTimer);
    this.workspaceGeneration++;
    this.searchGeneration++;
    this.clearResults();
    this.refresh();
  }

  getSummaryText() {
    if (this.isSearching) {
      return "Searching…";
    }

    if (!this.query) {
      return "Type to search across the workspace";
    }

    if (!this.editor.fileExplorer?.rootPath) {
      return "Open a folder to search";
    }

    if (this.totalMatches === 0) {
      return "No results";
    }

    return `${this.totalMatches} result${
      this.totalMatches > 1 ? "s" : ""
    } in ${this.filesSearched} file${this.filesSearched > 1 ? "s" : ""}`;
  }

  renderResults() {
    const sameView = this.resultsViewState &&
      this.resultsViewState.isSearching === this.isSearching &&
      this.resultsViewState.query === this.query &&
      this.resultsViewState.results === this.results;
    if (sameView) return;

    this.resultsViewState = {
      isSearching: this.isSearching,
      query: this.query,
      results: this.results,
    };

    const items = [];
    if (this.isSearching) {
      items.push({
        type: "placeholder",
        text: "Searching…",
        height: 58,
        rowHeight: 58,
      });
    } else if (this.query && this.results.length === 0) {
      items.push({
        type: "placeholder",
        text: "No results found.",
        height: 58,
        rowHeight: 58,
      });
    } else if (this.query) {
      const groups = new Map();

      for (const result of this.results) {
        if (!groups.has(result.path)) groups.set(result.path, []);
        groups.get(result.path).push(result);
      }

      for (const [filePath, matches] of groups) {
        items.push({
          type: "header",
          filePath,
          name: matches[0].name,
          icon: this.getFileIcon(matches[0].name),
          count: matches.length,
          height: 26,
          rowHeight: 26,
        });

        for (let index = 0; index < matches.length; index++) {
          const match = matches[index];
          const isLastInFile = index === matches.length - 1;
          items.push({
            type: "match",
            match,
            height: 22 + (isLastInFile ? 7 : 0),
            rowHeight: 22,
          });
        }
      }
    }

    this.resultsScroller.setItems(items, {
      resetScroll: this.resetResultsScroll,
    });
    this.resetResultsScroll = true;
  }

  createResultNode(item) {
    const dom = this.editor.domManager;
    const row = dom.createFastElement("div");

    if (item.type === "placeholder") {
      row.setClassName("search-sidebar-placeholder");
      row.setTextContent(item.text);
      return row;
    }

    if (item.type === "header") {
      row.setClassName("search-sidebar-file-header");

      const icon = dom.createFastElement("i");
      icon.setClassName(`${item.icon} search-sidebar-file-icon`);

      const fileName = dom.createFastElement("span");
      fileName.setClassName("search-sidebar-file-name");
      fileName.setTextContent(item.name);
      fileName.setTitle(item.filePath);

      const count = dom.createFastElement("span");
      count.setClassName("search-sidebar-file-count");
      count.setTextContent(item.count);

      row.append(icon, fileName, count);
      return row;
    }

    const { match } = item;
    row.setClassName("search-sidebar-match");
    row.setTitle(`${match.relativePath}:${match.line}`);

    const line = dom.createFastElement("span");
    line.setClassName("search-sidebar-line-number");
    line.setTextContent(match.line);

    const content = dom.createFastElement("span");
    content.setClassName("search-sidebar-line-content");
    this.renderHighlightedText(
      content,
      match.preview,
      match.matchStart,
      match.matchLength,
    );

    row.append(line, content);
    row.addEventListener("click", () => this.openResult(match));
    return row;
  }

  renderHighlightedText(container, text, start, length) {
    const safeText = text || "";
    const safeStart = Math.max(0, Math.min(start ?? 0, safeText.length));
    const safeEnd = Math.max(
      safeStart,
      Math.min(safeStart + (length || 0), safeText.length),
    );

    if (safeStart > 0) {
      container.appendChild(document.createTextNode(safeText.slice(0, safeStart)));
    }

    if (safeEnd > safeStart) {
      const highlight = this.editor.domManager.createFastElement("mark");
      highlight.setTextContent(safeText.slice(safeStart, safeEnd));
      container.appendChild(highlight);
    }

    if (safeEnd < safeText.length) {
      container.appendChild(document.createTextNode(safeText.slice(safeEnd)));
    }
  }

  cancelResultNavigation() {
    this.resultOpenController?.abort();
    this.resultOpenController = null;
  }

  async openResult(result) {
    if (!result?.path) {
      return;
    }

    this.cancelResultNavigation();
    const controller = new AbortController();
    this.resultOpenController = controller;
    const tabManager = this.editor.tabManager;
    let unsubscribeFocus = null;
    try {
      const tab = await tabManager.openFileWithPath(result.path);
      if (!tab || controller.signal.aborted || tabManager.activeTab !== tab) return;
      const file = tab.type === "file" ? tab : tab.textTab;
      if (!file) return;

      unsubscribeFocus = tabManager.onActiveTabChange?.((activeTab) => {
        if (activeTab !== tab) controller.abort();
      });
      const lineReady = await this.editor.fileLoader.waitForLineLoaded(
        file,
        result.line,
        { signal: controller.signal },
      );
      if (
        !lineReady ||
        controller.signal.aborted ||
        this.resultOpenController !== controller ||
        tabManager.activeTab !== tab
      ) return;

      const documentIndex = Math.max(0, result.line - 1);
      const displayIndex =
        this.editor.lineController.getDisplayIndexForDocument(documentIndex);
      this.editor.lineController.scrollTo(
        displayIndex >= 0 ? displayIndex : documentIndex,
      );

      this.editor.cursorController.setCursorPosition(
        result.line,
        result.column,
      );

      this.editor.cursorController.updateCaretPosition();
    } catch (error) {
      if (error?.name !== "AbortError")
        console.error("Error opening search result:", error);
    } finally {
      unsubscribeFocus?.();
      if (this.resultOpenController === controller)
        this.resultOpenController = null;
    }
  }

  getFileIcon(filename) {
    const name = (filename || "").toLowerCase();
    const ext = name.includes(".") ? name.split(".").pop() : name;

    return USERCONFIG_FILE_ICONS[ext] || USERCONFIG_FILE_ICONS.default;
  }

  focusInput() {
    requestAnimationFrame(() => {
      if (this.input) {
        this.input.focus({
          preventScroll: true,
        });

        this.input.select();
      }
    });
  }

  onOpen() {
    this.resultsScroller.resume();
    this.refresh();
    this.focusInput();
    if (this.query.trim() && this.results.length === 0 && !this.isSearching) {
      this.runSearch();
    }
  }

  onClose() {
    clearTimeout(this.searchTimer);
    this.cancelResultNavigation();
    this.cancelActiveSearch();
    this.resultsScroller.suspend();
  }
}
