class MarkdownView {
  static supportedExtensions = new Set([".md"]);

  static isSupportedPath(path) {
    return typeof path === "string" &&
      MarkdownView.supportedExtensions.has(NCEPath.basename(path).match(/\.[^.]+$/)?.[0]?.toLowerCase());
  }

  isSupportedPath(path) {
    return MarkdownView.isSupportedPath(path);
  }

  constructor(editor) {
    this.editor = editor;
    this.host = editor.domManager.getElement(".markdown-view-host");
    this.viewport = this.host?.querySelector(".markdown-view-viewport");
    this.content = this.viewport?.querySelector(".markdown-preview-content");
    this.status = this.host?.querySelector(".markdown-view-status");
    this.scroller = this.host && this.viewport
      ? new MarkdownViewScroller(editor, this.viewport, this.host, this.content)
      : null;
    this.renderer = new MarkdownRenderer({
      getHighlightController: () => this.editor.highlightController,
      readImageFile: (reference, context) =>
        this.editor.api?.readImageFile?.(reference, context),
    });
    this.generation = 0;
    this.path = null;
    this.renderedMarkdown = null;
    this.renderedPath = null;
    this.renderedWorkspaceRoot = null;
  }

  show(tab) {
    if (!this.host || !tab?.path || !this.isSupportedPath(tab.path)) return;
    this.host.hidden = false;
    this.scroller?.refresh();
    const generation = ++this.generation;
    this.path = tab.path;
    void this.renderTab(tab, generation);
  }

  async renderTab(tab, generation) {
    let textTab = tab.textTab || this.editor.tabManager.getFileByPath(tab.path);
    if (!textTab) {
      textTab = new FileNode(this.editor, tab.id, tab.name, tab.path);
      tab.textTab = textTab;
    }

    this.setStatus("Loading Markdown…");
    if (!textTab.isLoaded) {
      await textTab.loadLanguage();
      await textTab.loadContent();
    }
    if (generation !== this.generation || tab !== this.editor.tabManager.activeTab) return;
    if (textTab.largeFileMode === true) {
      this.setStatus("Markdown Preview is unavailable in Large File Mode.", true);
      await this.editor.tabManager.switchActiveTabView("text");
      return;
    }
    if (textTab.loadingState?.status === "loading") {
      try {
        await this.editor.fileLoader.waitForFileLoaded(textTab);
      } catch {}
    }
    if (generation !== this.generation || tab !== this.editor.tabManager.activeTab) return;

    if (textTab.loadError) {
      this.renderedMarkdown = null;
      this.content?.replaceChildren();
      this.setStatus("Unable to open Markdown file.", true);
      return;
    }

    this.setStatus("");
    const markdown = textTab.serializeContent();
    const workspaceRoot = this.editor.fileExplorer?.rootPath || null;
    if (markdown !== this.renderedMarkdown || tab.path !== this.renderedPath ||
        workspaceRoot !== this.renderedWorkspaceRoot) {
      this.renderer.render(markdown, this.content, {
        mode: MarkdownRenderer.MODES.WORKSPACE_PREVIEW,
        sourcePath: tab.path,
        workspaceRoot,
        highlightImmediately: true,
      });
      this.renderedMarkdown = markdown;
      this.renderedPath = tab.path;
      this.renderedWorkspaceRoot = workspaceRoot;
    }
    this.scroller?.refresh();
  }

  setStatus(message, error = false) {
    if (!this.status) return;
    this.status.textContent = message;
    this.status.hidden = !message;
    this.status.dataset.state = error ? "error" : "loading";
  }

  hide() {
    ++this.generation;
    if (this.host) this.host.hidden = true;
  }

  invalidate(path) {
    if (!path || NCEPath.equals(path, this.path)) {
      this.renderedMarkdown = null;
      this.renderedPath = null;
      this.renderedWorkspaceRoot = null;
      const tab = this.editor.tabManager.activeTab;
      if (tab?.type === TAB_TYPES.MARKDOWN && NCEPath.equals(tab.path, this.path))
        this.show(tab);
    }
  }

  clear() {
    ++this.generation;
    this.path = null;
    this.renderedMarkdown = null;
    this.renderedPath = null;
    this.renderedWorkspaceRoot = null;
    if (this.content) {
      this.renderer.destroy(this.content);
      this.content.replaceChildren();
    }
    this.setStatus("");
    if (this.host) this.host.hidden = true;
    this.scroller?.refresh();
  }

  close(tab) {
    if (tab?.path && NCEPath.equals(tab.path, this.path)) this.clear();
  }

  destroy() {
    this.clear();
    this.scroller?.destroy();
  }
}
