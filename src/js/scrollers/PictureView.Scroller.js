class PictureViewScroller {
  constructor(editor, viewport, scrollerHost) {
    this.editor = editor;
    this.viewport = viewport;
    this.zoomed = false;
    this.vScroller = null;
    this.hScroller = null;
    this.resizeObserver = null;
    this.observerMetricsInvalid = false;
    this.suspended = false;
    this.viewportListenerAttached = false;
    this.onViewportScroll = () => this.syncFromViewport();

    const manager = editor.scrollerManager;
    if (!manager) return;
    this.vScroller = manager.createScroller(scrollerHost, manager.VERTICAL_TYPE, false);
    this.hScroller = manager.createScroller(scrollerHost, manager.HORIZONTAL_TYPE, false);
    this.vScroller.wheelTarget = viewport;
    this.hScroller.wheelTarget = viewport;
    this.configure(this.vScroller, true);
    this.configure(this.hScroller, false);
    manager.addScroller(this.vScroller);
    manager.addScroller(this.hScroller);
    this.attachViewportListener();
    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver((entries) => {
        this.scheduleObserverRefresh({
          invalidateMetrics: entries?.some((entry) => entry.target === viewport),
        });
      });
      this.resizeObserver.observe(viewport);
      const image = viewport.querySelector(".picture-view-image");
      if (image) this.resizeObserver.observe(image);
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
    if (this.suspended || (!this.vScroller && !this.hScroller)) return false;
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

  configure(scroller, vertical) {
    const viewport = this.viewport;
    const getClient = () => vertical ? viewport.clientHeight : viewport.clientWidth;
    const getScroll = () => vertical ? viewport.scrollHeight : viewport.scrollWidth;
    const getPosition = () => vertical ? viewport.scrollTop : viewport.scrollLeft;
    scroller.calcIsActive = () => this.zoomed && getScroll() > getClient() + 1;
    scroller.calculProp = () => {
      const scroll = getScroll();
      return scroll > 0 ? Math.min(100, (getClient() / scroll) * 100) : 100;
    };
    scroller.onRefresh = () => {};
    scroller.onScroll = (ratio) => {
      const maxScroll = Math.max(0, getScroll() - getClient());
      const position = Math.round(Math.max(0, Math.min(1, ratio)) * maxScroll);
      if (vertical) viewport.scrollTop = position;
      else viewport.scrollLeft = position;
    };
    scroller.onScrollEnd = () => this.syncFromViewport();
    scroller.setScrollRatio(getScroll() > getClient()
      ? getPosition() / (getScroll() - getClient()) : 0);
  }

  syncFromViewport({ invalidateMetrics = false } = {}) {
    if (this.suspended) return;
    for (const [scroller, vertical] of [[this.vScroller, true], [this.hScroller, false]]) {
      if (!scroller) continue;
      const client = vertical ? this.viewport.clientHeight : this.viewport.clientWidth;
      const scroll = vertical ? this.viewport.scrollHeight : this.viewport.scrollWidth;
      const position = vertical ? this.viewport.scrollTop : this.viewport.scrollLeft;
      const maxScroll = Math.max(0, scroll - client);
      scroller.setScrollRatio(maxScroll ? position / maxScroll : 0);
      const manager = this.editor.scrollerManager;
      if (invalidateMetrics && manager?.invalidateScroller) {
        manager.invalidateScroller(scroller);
      } else if (manager?.refreshScroller) {
        manager.refreshScroller(scroller);
      } else {
        if (invalidateMetrics) scroller.refreshMetrics();
        scroller.refresh();
      }
    }
  }

  refresh({ invalidateMetrics = false } = {}) {
    if (this.suspended) return;
    invalidateMetrics ||= this.observerMetricsInvalid;
    this.editor.scrollerManager?.cancelObserverRefresh?.(this);
    this.observerMetricsInvalid = false;
    this.syncFromViewport({ invalidateMetrics });
  }

  setZoomed(zoomed) {
    this.zoomed = zoomed;
  }

  suspend() {
    if (this.suspended) return;
    this.suspended = true;
    this.editor.scrollerManager?.cancelObserverRefresh?.(this);
    this.observerMetricsInvalid = false;
    this.detachViewportListener();
    this.resizeObserver?.disconnect();
    this.editor.scrollerManager?.deactivateScroller?.(this.vScroller);
    this.editor.scrollerManager?.deactivateScroller?.(this.hScroller);
  }

  resume() {
    if (!this.suspended) return;
    this.suspended = false;
    this.editor.scrollerManager?.activateScroller?.(this.vScroller, { deferRefresh: true });
    this.editor.scrollerManager?.activateScroller?.(this.hScroller, { deferRefresh: true });
    this.attachViewportListener();
    this.resizeObserver?.observe(this.viewport);
    const image = this.viewport?.querySelector(".picture-view-image");
    if (image) this.resizeObserver?.observe(image);
    this.refresh({ invalidateMetrics: true });
  }

  destroy() {
    this.editor.scrollerManager?.cancelObserverRefresh?.(this);
    this.observerMetricsInvalid = false;
    this.suspend();
    this.detachViewportListener();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    const manager = this.editor.scrollerManager;
    for (const scroller of [this.vScroller, this.hScroller]) {
      if (manager?.destroyScroller) manager.destroyScroller(scroller);
      else scroller?.destroy?.();
    }
    this.vScroller = null;
    this.hScroller = null;
    this.viewport = null;
  }
}
