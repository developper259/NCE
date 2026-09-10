class QuickOpen {
  constructor(editor) {
    this.editor = editor;
    this.cachedRoot = "";
    this.cachedFiles = null;
    this.cacheGeneration = 0;
  }

  invalidate(rootPath) {
    if (!rootPath || NCEPath.equals(rootPath, this.cachedRoot)) {
      this.cachedRoot = "";
      this.cachedFiles = null;
      this.cacheGeneration++;
    }
  }

  async getFiles(rootPath) {
    if (this.cachedFiles && NCEPath.equals(rootPath, this.cachedRoot))
      return this.cachedFiles;
    const generation = ++this.cacheGeneration;
    const response = await this.editor.api.listProjectFiles(rootPath);
    if (generation !== this.cacheGeneration ||
        !NCEPath.equals(rootPath, this.editor.fileExplorer?.rootPath)) return [];
    if (!response?.success) return [];
    this.cachedRoot = rootPath;
    this.cachedFiles = response.entries.map((entry) => ({
      id: entry.path,
      label: entry.relativePath,
      data: entry,
    }));
    return this.cachedFiles;
  }

  filter(files, query) {
    if (!query) return files;
    const score = (name) => {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      return name === query || stem === query ? 0
        : name.startsWith(query) ? 1 : name.includes(query) ? 2 : 3;
    };
    return files.filter((item) => item.label.toLowerCase().includes(query))
      .sort((left, right) =>
        score(left.data.name.toLowerCase()) - score(right.data.name.toLowerCase()) ||
        left.label.localeCompare(right.label));
  }

  open() {
    const panel = this.editor.quickPanel;
    if (!panel) return false;
    if (panel.isOpen("quick-open")) {
      panel.input?.focus();
      return true;
    }
    const rootPath = this.editor.fileExplorer?.rootPath || "";
    return panel.open({
      id: "quick-open",
      mode: "pick",
      title: "Quick Open",
      placeholder: "Search files...",
      items: rootPath ? () => this.getFiles(rootPath) : [],
      reloadOnInput: false,
      renderLimit: 100,
      preserveLabelCase: true,
      filterItems: (items, query) => this.filter(items, query),
      emptyMessage: (query) => !rootPath ? "Open a project first."
        : query.trim() ? "No matching files." : "No files found.",
      onAccept: (item) => this.editor.tabManager.openFileWithPath(item.data.path),
    });
  }
}
