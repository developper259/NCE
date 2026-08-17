class SearchSidebar extends Sidebar {
  constructor(editor) {
    super("search", "Search", "fi fi-rr-search", "left", editor);

    this.container = null;
    this.input = null;
    this.includeInput = null;
    this.excludeInput = null;
    this.summaryElement = null;
    this.resultsElement = null;
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

    this.isSearching = false;
    this.searchTimer = null;
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

    searchBox.append(inputWrapper, include, exclude);
    container.appendChild(searchBox);

    const summary = document.createElement("div");
    summary.className = "search-sidebar-summary";
    summary.textContent = this.getSummaryText();
    this.summaryElement = summary;
    container.appendChild(summary);

    const results = document.createElement("div");
    results.className = "search-sidebar-results";
    this.resultsElement = results;
    this.renderResults(results);
    container.appendChild(results);

    const scheduleSearch = () => {
      this.query = input.value;
      this.include = include.value;
      this.exclude = exclude.value;

      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.runSearch(), 180);
    };

    input.addEventListener("input", scheduleSearch);
    include.addEventListener("input", scheduleSearch);
    exclude.addEventListener("input", scheduleSearch);

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
    if (this.summaryElement) {
      this.summaryElement.textContent = this.getSummaryText();
    }
    if (this.resultsElement) {
      this.resultsElement.innerHTML = "";
      this.renderResults(this.resultsElement);
    }
    if (this.caseButton) {
      this.caseButton.classList.toggle("sidebar-option-active", this.caseSensitive);
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

  async runSearch() {
    if (!this.isOpen) {
      return;
    }

    this.query = this.query.trim();

    if (!this.query) {
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
        },
      );

      if (!this.isOpen) {
        return;
      }

      this.results = response?.results || [];
      this.totalMatches = response?.totalMatches || 0;
      this.filesSearched = response?.filesSearched || 0;
    } catch (error) {
      console.error("Error searching workspace:", error);
      this.clearResults();
    } finally {
      this.isSearching = false;
      this.refresh();
    }
  }

  clearResults() {
    this.results = [];
    this.totalMatches = 0;
    this.filesSearched = 0;
    this.isSearching = false;
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

  renderResults(container) {
    if (this.isSearching) {
      const loading = document.createElement("div");
      loading.className = "search-sidebar-placeholder";
      loading.textContent = "Searching…";
      container.appendChild(loading);
      return;
    }

    if (!this.query) {
      const placeholder = document.createElement("div");
      placeholder.className = "search-sidebar-placeholder";
      placeholder.textContent = "Search";
      container.appendChild(placeholder);
      return;
    }

    if (this.results.length === 0) {
      const empty = document.createElement("div");
      empty.className = "search-sidebar-placeholder";
      empty.textContent = "No results found.";
      container.appendChild(empty);
      return;
    }

    const groups = new Map();

    for (const result of this.results) {
      if (!groups.has(result.path)) {
        groups.set(result.path, []);
      }

      groups.get(result.path).push(result);
    }

    for (const [filePath, matches] of groups) {
      const group = document.createElement("div");
      group.className = "search-sidebar-file-group";

      const header = document.createElement("div");
      header.className = "search-sidebar-file-header";

      const icon = document.createElement("i");
      icon.className = `${this.getFileIcon(
        matches[0].name,
      )} search-sidebar-file-icon`;

      const fileName = document.createElement("span");
      fileName.className = "search-sidebar-file-name";
      fileName.textContent = matches[0].name;
      fileName.title = filePath;

      const count = document.createElement("span");
      count.className = "search-sidebar-file-count";
      count.textContent = matches.length;

      header.append(icon, fileName, count);
      group.appendChild(header);

      for (const match of matches) {
        const row = document.createElement("div");
        row.className = "search-sidebar-match";
        row.title = `${match.relativePath}:${match.line}`;

        const line = document.createElement("span");
        line.className = "search-sidebar-line-number";
        line.textContent = match.line;

        const content = document.createElement("span");
        content.className = "search-sidebar-line-content";

        this.renderHighlightedText(
          content,
          match.preview,
          match.matchStart,
          match.matchLength,
        );

        row.append(line, content);

        row.addEventListener("click", () => {
          this.openResult(match);
        });

        group.appendChild(row);
      }

      container.appendChild(group);
    }
  }

  renderHighlightedText(container, text, start, length) {
    const safeText = text || "";
    const safeStart = Math.max(0, Math.min(start ?? 0, safeText.length));
    const safeEnd = Math.max(
      safeStart,
      Math.min(safeStart + (length || 0), safeText.length),
    );

    if (safeStart > 0) {
      container.appendChild(
        document.createTextNode(safeText.slice(0, safeStart)),
      );
    }

    if (safeEnd > safeStart) {
      const highlight = document.createElement("mark");
      highlight.textContent = safeText.slice(safeStart, safeEnd);
      container.appendChild(highlight);
    }

    if (safeEnd < safeText.length) {
      container.appendChild(document.createTextNode(safeText.slice(safeEnd)));
    }
  }

  async openResult(result) {
    if (!result?.path) {
      return;
    }

    try {
      this.editor.tabManager.openFileWithPath(result.path);

      for (let i = 0; i < 30; i++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));

        if (
          this.editor.tabManager.activeFile?.path === result.path &&
          this.editor.lineController.lines.length > 0
        ) {
          break;
        }
      }

      this.editor.lineController.scrollTo(Math.max(0, result.line - 1));

      this.editor.cursorController.setCursorPosition(
        result.line,
        result.column,
      );

      this.editor.cursorController.updateCaretPosition();
    } catch (error) {
      console.error("Error opening search result:", error);
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
    this.refresh();
    this.focusInput();
  }

  onClose() {
    clearTimeout(this.searchTimer);
  }
}