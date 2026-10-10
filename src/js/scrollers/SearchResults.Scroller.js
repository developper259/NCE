class SearchResultsScroller {
  constructor(editor, renderItem, onNearEnd = () => {}) {
    this.editor = editor;
    this.renderItem = renderItem;
    this.onNearEnd = onNearEnd;
    this.host = null;
    this.viewport = null;
    this.layer = null;
    this.layerFast = null;
    this.vScroller = null;
    this.items = [];
    this.offsets = [];
    this.totalVirtualHeight = 0;
    this.viewportHeight = 0;
    this.scrollY = 0;
    this.visibleStart = -1;
    this.visibleEnd = -1;
    this.itemsVersion = 0;
    this.renderedVersion = -1;
    this.frame = null;
    this.needsMeasure = true;
    this.suspended = false;

    this._onWheel = (event) => {
      if (this.suspended || !this.viewport || event.shiftKey) return;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY) || !event.deltaY) return;

      const viewportHeight = this.readViewportHeight();
      if (viewportHeight !== this.viewportHeight) {
        this.viewportHeight = viewportHeight;
        this.scheduleRender(true);
      }
      if (viewportHeight <= 0 || this.totalVirtualHeight <= viewportHeight) return;

      event.preventDefault();
      event.stopPropagation();
      this.vScroller?.markRecentlyInteracted?.();

      const delta = event.deltaMode === 1
        ? event.deltaY * 16
        : event.deltaMode === 2
          ? event.deltaY * viewportHeight
          : event.deltaY;
      this.setScrollY(this.scrollY + delta);
    };

    this._resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => this.scheduleRender(true))
      : null;
  }

  attach(host, viewport, layer) {
    if (
      this.host !== host ||
      this.viewport !== viewport ||
      this.layer !== layer
    ) {
      this.viewport?.removeEventListener("wheel", this._onWheel);
      if (this.viewport) this._resizeObserver?.unobserve(this.viewport);

      this.host = host;
      this.viewport = viewport;
      this.layer = layer;
      this.layerFast = this.editor.domManager?.wrapFastNode?.(layer) || null;
      this.visibleStart = -1;
      this.visibleEnd = -1;
      this.renderedVersion = -1;

      viewport?.addEventListener("wheel", this._onWheel, { passive: false });
      if (viewport) this._resizeObserver?.observe(viewport);
    }

    this.initScroller();
    this.scheduleRender(true);
  }

  initScroller() {
    if (
      this.vScroller ||
      !this.host?.isConnected ||
      !this.viewport ||
      !this.editor.scrollerManager
    ) return;

    const manager = this.editor.scrollerManager;
    this.vScroller = manager.createScroller(
      this.host,
      manager.VERTICAL_TYPE,
      false,
    );
    this.vScroller.wheelTarget = this.viewport;
    // The custom wheel handler owns virtual scrolling; the Scroller's handler
    // stays disabled so one wheel gesture is never applied twice.
    this.vScroller._onWheel = () => {};
    this.vScroller.calculProp = () => this.totalVirtualHeight > 0
      ? Math.min(100, (this.viewportHeight / this.totalVirtualHeight) * 100)
      : 100;
    this.vScroller.calcIsActive = () => {
      this.viewportHeight = this.readViewportHeight();
      return !this.suspended && this.viewportHeight > 0 &&
        this.totalVirtualHeight > this.viewportHeight;
    };
    this.vScroller.onScroll = (ratio) => {
      this.setScrollY(ratio * this.getMaxScrollY());
    };
    this.vScroller.onRefresh = () => {};
    manager.addScroller(this.vScroller);
  }

  setItems(items, { resetScroll = true } = {}) {
    this.items = Array.isArray(items) ? items : [];
    this.offsets = new Array(this.items.length);
    let offset = 0;
    for (let index = 0; index < this.items.length; index++) {
      this.offsets[index] = offset;
      offset += this.items[index].height;
    }
    this.totalVirtualHeight = offset;
    this.itemsVersion++;
    this.visibleStart = -1;
    this.visibleEnd = -1;
    if (resetScroll) {
      this.scrollY = 0;
    }
    this.scheduleRender(true);
  }

  getMaxScrollY() {
    return Math.max(0, this.totalVirtualHeight - this.viewportHeight);
  }

  readViewportHeight() {
    if (!this.viewport) return 0;
    const measuredHeight = this.editor.domManager?.getElementMetrics?.(
      this.viewport,
    )?.clientHeight;
    return measuredHeight || this.viewport.clientHeight || 0;
  }

  setScrollY(value) {
    const next = Number.isFinite(value)
      ? Math.max(0, Math.min(value, this.getMaxScrollY()))
      : 0;
    if (next === this.scrollY) return;
    this.scrollY = next;
    this.scheduleRender();
  }

  setScrollRatio(ratio) {
    this.setScrollY(Math.max(0, Math.min(1, ratio)) * this.getMaxScrollY());
  }

  scheduleRender(measure = false) {
    this.needsMeasure ||= measure;
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.update();
    });
  }

  findFirstItemEndingAfter(position) {
    let low = 0;
    let high = this.items.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.offsets[middle] + this.items[middle].rowHeight <= position) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  findFirstItemStartingAtOrAfter(position) {
    let low = 0;
    let high = this.items.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.offsets[middle] < position) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  update() {
    if (!this.viewport || !this.layerFast || this.suspended) return;
    // Search.Sidebar builds its DOM before SidebarManager mounts it. Wait until
    // the host is connected so ScrollerManager does not discard the scroller.
    this.initScroller();

    const needsMeasure = this.needsMeasure;
    const previousHeight = this.viewportHeight;
    if (needsMeasure) {
      this.viewportHeight = this.readViewportHeight();
      this.needsMeasure = false;
    }

    this.scrollY = Math.max(0, Math.min(this.scrollY, this.getMaxScrollY()));
    const maxScrollY = this.getMaxScrollY();
    const ratio = maxScrollY > 0 ? this.scrollY / maxScrollY : 0;

    if (this.vScroller) {
      this.vScroller.nbItem = this.items.length;
      this.vScroller.heightByItem = 1;
      this.vScroller.setScrollRatio(ratio);
    }

    const metricsInvalidated = previousHeight !== this.viewportHeight;

    this.layerFast.setHeight(this.totalVirtualHeight);
    this.layerFast.setTransform(`translate3d(0, -${this.scrollY}px, 0)`);

    const start = this.viewportHeight > 0 && this.items.length > 0
      ? this.findFirstItemEndingAfter(this.scrollY)
      : 0;
    const end = this.viewportHeight > 0 && this.items.length > 0
      ? this.findFirstItemStartingAtOrAfter(this.scrollY + this.viewportHeight)
      : 0;

    if (start !== this.visibleStart || end !== this.visibleEnd ||
      this.renderedVersion !== this.itemsVersion) {
      const visible = [];
      for (let index = start; index < end; index++) {
        const item = this.items[index];
        const row = this.renderItem(item);
        const rowFast = this.editor.domManager.wrapFastNode(row);
        rowFast.setStyle("position", "absolute");
        rowFast.setTop(this.offsets[index]);
        rowFast.setLeft(0);
        rowFast.setStyle("width", "100%");
        rowFast.setHeight(item.rowHeight);
        visible.push(rowFast);
      }
      this.layerFast.replaceChildren(...visible);
      this.visibleStart = start;
      this.visibleEnd = end;
      this.renderedVersion = this.itemsVersion;
    }

    if (this.vScroller) {
      const manager = this.editor.scrollerManager;
      if (metricsInvalidated && manager?.invalidateScroller) {
        manager.invalidateScroller(this.vScroller);
      } else if (manager?.refreshScroller) {
        manager.refreshScroller(this.vScroller);
      } else {
        if (metricsInvalidated) this.vScroller.refreshMetrics();
        this.vScroller.refresh();
      }
      const thumbMetrics = this.vScroller.readThumbMetrics();
      if (thumbMetrics) this.vScroller.writeThumbPosition(thumbMetrics);
    }

    if (this.items.length > 0 && this.items.length - end <= 50) {
      this.onNearEnd();
    }
  }

  refresh() {
    this.scheduleRender(true);
  }

  suspend() {
    this.suspended = true;
    this._resizeObserver?.unobserve(this.viewport);
    this.editor.scrollerManager?.deactivateScroller?.(this.vScroller);
  }

  resume() {
    this.suspended = false;
    this.editor.scrollerManager?.activateScroller?.(this.vScroller, {
      deferRefresh: true,
    });
    if (this.viewport) this._resizeObserver?.observe(this.viewport);
    this.scheduleRender(true);
  }

  destroy() {
    if (this.frame !== null) {
      const cancelFrame = this.editor.domManager?.cancelFrame ||
        (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : null);
      cancelFrame?.(this.frame);
      this.frame = null;
    }
    this.viewport?.removeEventListener("wheel", this._onWheel);
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    const manager = this.editor.scrollerManager;
    if (manager?.destroyScroller) manager.destroyScroller(this.vScroller);
    else this.vScroller?.destroy?.();
    this.vScroller = null;
    this.host = null;
    this.viewport = null;
    this.layer = null;
    this.layerFast = null;
  }
}
