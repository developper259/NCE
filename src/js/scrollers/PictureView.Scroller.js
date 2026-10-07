class PictureViewScroller {
  constructor(editor, viewport, scrollerHost) {
    this.editor = editor;
    this.viewport = viewport;
    this.zoomed = false;
    this.vScroller = null;
    this.hScroller = null;
    this.resizeObserver = null;
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
    viewport.addEventListener("scroll", this.onViewportScroll, { passive: true });
    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(() => this.refresh());
      this.resizeObserver.observe(viewport);
      const image = viewport.querySelector(".picture-view-image");
      if (image) this.resizeObserver.observe(image);
    }
    this.refresh();
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

  syncFromViewport() {
    for (const [scroller, vertical] of [[this.vScroller, true], [this.hScroller, false]]) {
      if (!scroller) continue;
      const client = vertical ? this.viewport.clientHeight : this.viewport.clientWidth;
      const scroll = vertical ? this.viewport.scrollHeight : this.viewport.scrollWidth;
      const position = vertical ? this.viewport.scrollTop : this.viewport.scrollLeft;
      const maxScroll = Math.max(0, scroll - client);
      scroller.setScrollRatio(maxScroll ? position / maxScroll : 0);
      scroller.refreshMetrics();
      scroller.refresh();
    }
  }

  refresh() {
    this.syncFromViewport();
  }

  setZoomed(zoomed) {
    this.zoomed = zoomed;
    this.refresh();
  }

  destroy() {
    this.viewport?.removeEventListener("scroll", this.onViewportScroll);
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
