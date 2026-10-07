class MarkdownViewScroller {
  constructor(editor, viewport, scrollerHost, content) {
    this.editor = editor;
    this.viewport = viewport;
    this.content = content;
    this.vScroller = null;
    this.mutationObserver = null;
    this.resizeObserver = null;
    this.onViewportScroll = () => this.syncFromViewport();

    const manager = editor.scrollerManager;
    if (!manager || !viewport || !content) return;

    this.vScroller = manager.createScroller(
      scrollerHost,
      manager.VERTICAL_TYPE,
      false,
    );
    this.vScroller.wheelTarget = viewport;
    this.vScroller.onRefresh = () => {};
    this.vScroller.calcIsActive = () =>
      viewport.scrollHeight > viewport.clientHeight + 1;
    this.vScroller.calculProp = () => viewport.scrollHeight > 0
      ? Math.min(100, (viewport.clientHeight / viewport.scrollHeight) * 100)
      : 100;
    this.vScroller.onScroll = (ratio) => {
      const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      viewport.scrollTop = Math.round(Math.max(0, Math.min(1, ratio)) * maxScroll);
    };
    this.vScroller.onScrollEnd = () => this.syncFromViewport();
    manager.addScroller(this.vScroller);

    viewport.addEventListener("scroll", this.onViewportScroll, { passive: true });
    if (typeof MutationObserver === "function") {
      this.mutationObserver = new MutationObserver(() => this.refresh());
      this.mutationObserver.observe(content, { childList: true, subtree: true });
    }
    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver((entries) => {
        this.refresh({
          invalidateMetrics: entries?.some((entry) => entry.target === viewport),
        });
      });
      this.resizeObserver.observe(viewport);
      this.resizeObserver.observe(content);
    }
    this.refresh();
  }

  syncFromViewport({ invalidateMetrics = false } = {}) {
    if (!this.vScroller) return;
    const maxScroll = Math.max(
      0,
      this.viewport.scrollHeight - this.viewport.clientHeight,
    );
    this.vScroller.setScrollRatio(
      maxScroll > 0 ? this.viewport.scrollTop / maxScroll : 0,
    );
    const manager = this.editor.scrollerManager;
    if (invalidateMetrics && manager?.invalidateScroller) {
      manager.invalidateScroller(this.vScroller);
    } else if (manager?.refreshScroller) {
      manager.refreshScroller(this.vScroller);
    }
    else this.vScroller.refresh();
  }

  refresh({ invalidateMetrics = false } = {}) {
    this.syncFromViewport({ invalidateMetrics });
  }

  destroy() {
    this.viewport?.removeEventListener("scroll", this.onViewportScroll);
    this.mutationObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.mutationObserver = null;
    this.resizeObserver = null;
    const manager = this.editor.scrollerManager;
    if (manager?.destroyScroller) manager.destroyScroller(this.vScroller);
    else this.vScroller?.destroy?.();
    this.vScroller = null;
    this.viewport = null;
    this.content = null;
  }
}
