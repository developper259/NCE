class SettingsScroller {
  constructor(editor, viewport, content) {
    this.editor = editor;
    this.viewport = viewport;
    this.content = content;
    this.vScroller = null;
    this.mutationObserver = null;
    this.resizeObserver = null;
    this.suspended = false;
    this.scrollTop = 0;
    this.clientHeight = 0;
    this.scrollHeight = 0;
  }

  updateMetrics() {
    if (!this.content) return;

    const metrics = this.editor.domManager.getElementMetrics(this.content);
    this.scrollTop = metrics.scrollTop;
    this.clientHeight = metrics.clientHeight;
    this.scrollHeight = metrics.scrollHeight;
  }

  init() {
    if (
      this.vScroller ||
      !this.editor.scrollerManager ||
      !this.viewport ||
      !this.content
    ) {
      return;
    }

    this.updateMetrics();
    this.vScroller = this.editor.scrollerManager.createScroller(
      this.viewport,
      this.editor.scrollerManager.VERTICAL_TYPE,
      false,
    );
    this.vScroller.wheelTarget = this.content;
    this.vScroller.onRefresh = () => {};
    this.vScroller.calculProp = () => {
      if (!this.scrollHeight || !this.clientHeight) return 100;
      if (this.scrollHeight <= this.clientHeight) return 100;
      return (this.clientHeight / this.scrollHeight) * 100;
    };
    this.vScroller.calcIsActive = () =>
      this.scrollHeight > this.clientHeight;
    this.vScroller.onScroll = (scrollRatio) => {
      const maxScrollTop = Math.max(
        0,
        this.scrollHeight - this.clientHeight,
      );
      this.scrollTop = scrollRatio * maxScrollTop;
      this.content.scrollTop = this.scrollTop;
    };
    const maxScrollTop = Math.max(0, this.scrollHeight - this.clientHeight);
    this.vScroller.setScrollRatio(
      maxScrollTop > 0 ? this.scrollTop / maxScrollTop : 0,
    );
    this.editor.scrollerManager.addScroller(this.vScroller);

    this.mutationObserver = new MutationObserver(() => this.scheduleObserverRefresh());
    this.mutationObserver.observe(this.content, {
      childList: true,
      subtree: true,
    });
    this.resizeObserver = new ResizeObserver(() => this.scheduleObserverRefresh());
    this.resizeObserver.observe(this.content);

  }

  scheduleObserverRefresh() {
    if (!this.vScroller || this.suspended) return false;
    const manager = this.editor.scrollerManager;
    if (!manager?.scheduleObserverRefresh) {
      this.refresh();
      return true;
    }
    return manager.scheduleObserverRefresh(this, () => this.refresh());
  }

  refresh({ invalidateMetrics = false } = {}) {
    this.editor.scrollerManager?.cancelObserverRefresh?.(this);
    if (!this.vScroller || this.suspended) return;

    this.updateMetrics();
    const maxScrollTop = this.scrollHeight - this.clientHeight;
    const ratio = maxScrollTop > 0 ? this.scrollTop / maxScrollTop : 0;
    this.vScroller.setScrollRatio(ratio);
    const manager = this.editor.scrollerManager;
    if (invalidateMetrics && manager?.invalidateScroller)
      manager.invalidateScroller(this.vScroller);
    else if (manager?.refreshScroller) manager.refreshScroller(this.vScroller);
    else {
      this.vScroller.refreshMetrics();
      this.vScroller.refresh();
    }
  }

  suspend() {
    if (!this.vScroller || this.suspended) return;
    this.suspended = true;
    this.editor.scrollerManager?.cancelObserverRefresh?.(this);
    this.mutationObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.editor.scrollerManager?.deactivateScroller?.(this.vScroller);
  }

  resume() {
    if (!this.vScroller || !this.suspended) return;
    this.suspended = false;
    this.editor.scrollerManager?.activateScroller?.(this.vScroller, {
      deferRefresh: true,
    });
    this.mutationObserver?.observe(this.content, { childList: true, subtree: true });
    this.resizeObserver?.observe(this.content);
    this.refresh({ invalidateMetrics: true });
  }

  destroy() {
    this.editor.scrollerManager?.cancelObserverRefresh?.(this);
    this.suspend();
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
