class MarkdownViewScroller {
  constructor(editor, viewport, scrollerHost, content) {
    this.editor = editor;
    this.viewport = viewport;
    this.content = content;
    this.vScroller = null;
    this.mutationObserver = null;
    this.resizeObserver = null;
    this.observerMetricsInvalid = false;
    this.suspended = false;
    this.viewportListenerAttached = false;
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

    this.attachViewportListener();
    if (typeof MutationObserver === "function") {
      this.mutationObserver = new MutationObserver(() =>
        this.scheduleObserverRefresh(),
      );
      this.mutationObserver.observe(content, { childList: true, subtree: true });
    }
    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver((entries) => {
        this.scheduleObserverRefresh({
          invalidateMetrics: entries?.some((entry) => entry.target === viewport),
        });
      });
      this.resizeObserver.observe(viewport);
      this.resizeObserver.observe(content);
    }
  }

  attachViewportListener() {
    if (!this.viewport || this.viewportListenerAttached) return;
    this.viewport.addEventListener("scroll", this.onViewportScroll, { passive: true });
    this.viewportListenerAttached = true;
  }

  detachViewportListener() {
    if (!this.viewport || !this.viewportListenerAttached) return;
    this.viewport.removeEventListener("scroll", this.onViewportScroll);
    this.viewportListenerAttached = false;
  }

  scheduleObserverRefresh({ invalidateMetrics = false } = {}) {
    if (!this.vScroller || this.suspended) return false;
    this.observerMetricsInvalid ||= invalidateMetrics;
    const manager = this.editor.scrollerManager;
    if (!manager?.scheduleObserverRefresh) {
      const shouldInvalidate = this.observerMetricsInvalid;
      this.observerMetricsInvalid = false;
      this.refresh({ invalidateMetrics: shouldInvalidate });
      return true;
    }
    return manager.scheduleObserverRefresh(this, () => {
      const shouldInvalidate = this.observerMetricsInvalid;
      this.observerMetricsInvalid = false;
      this.refresh({ invalidateMetrics: shouldInvalidate });
    });
  }

  syncFromViewport({ invalidateMetrics = false } = {}) {
    if (!this.vScroller || this.suspended) return;
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
    if (this.suspended) return;
    invalidateMetrics ||= this.observerMetricsInvalid;
    this.editor.scrollerManager?.cancelObserverRefresh?.(this);
    this.observerMetricsInvalid = false;
    this.syncFromViewport({ invalidateMetrics });
  }

  suspend() {
    if (!this.vScroller || this.suspended) return;
    this.suspended = true;
    this.editor.scrollerManager?.cancelObserverRefresh?.(this);
    this.observerMetricsInvalid = false;
    this.detachViewportListener();
    this.mutationObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.editor.scrollerManager?.deactivateScroller?.(this.vScroller);
  }

  resume() {
    if (!this.vScroller || !this.suspended) return;
    this.suspended = false;
    this.editor.scrollerManager?.activateScroller?.(this.vScroller, { deferRefresh: true });
    this.attachViewportListener();
    this.mutationObserver?.observe(this.content, { childList: true, subtree: true });
    this.resizeObserver?.observe(this.viewport);
    this.resizeObserver?.observe(this.content);
    this.refresh({ invalidateMetrics: true });
  }

  destroy() {
    this.editor.scrollerManager?.cancelObserverRefresh?.(this);
    this.observerMetricsInvalid = false;
    this.suspend();
    this.detachViewportListener();
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
