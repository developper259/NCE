class SearchResultsScroller {
  constructor(editor, renderItem, onNearEnd = () => {}) {
    this.editor = editor;
    this.renderItem = renderItem;
    this.onNearEnd = onNearEnd;
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
      if (!this.vScroller?.active || event.shiftKey) return;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (!event.deltaY) return;

      event.preventDefault();
      event.stopPropagation();
      const delta = event.deltaMode === 1
        ? event.deltaY * 16
        : event.deltaMode === 2
          ? event.deltaY * this.viewportHeight
          : event.deltaY;
      this.setScrollY(this.scrollY + delta);
    };

    this._resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => this.scheduleRender(true))
      : null;
  }

  attach(viewport, layer) {
    if (this.viewport !== viewport || this.layer !== layer) {
      this.viewport?.removeEventListener("wheel", this._onWheel);
      if (this.viewport) this._resizeObserver?.unobserve(this.viewport);

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
    if (this.vScroller || !this.viewport || !this.editor.scrollerManager) return;

    const manager = this.editor.scrollerManager;
    this.vScroller = manager.createScroller(
      this.viewport,
      manager.VERTICAL_TYPE,
      false,
    );
    this.vScroller.wheelTarget = this.viewport;
    // The virtual viewport needs pixel-based wheel movement; keep Scroller's
    // thumb dragging while routing wheel deltas through this virtual range.
    this.vScroller._onWheel = this._onWheel;
    this.vScroller.calculProp = () => this.totalVirtualHeight > 0
      ? Math.min(100, (this.viewportHeight / this.totalVirtualHeight) * 100)
      : 100;
    this.vScroller.calcIsActive = () => !this.suspended &&
      this.viewportHeight > 0 && this.totalVirtualHeight > this.viewportHeight;
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
    if (resetScroll) this.scrollY = 0;
    this.scheduleRender(true);
  }

  getMaxScrollY() {
    return Math.max(0, this.totalVirtualHeight - this.viewportHeight);
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

    const needsMeasure = this.needsMeasure;
    const previousHeight = this.viewportHeight;
    const previousTotalHeight = this._measuredTotalVirtualHeight;
    if (needsMeasure) {
      this.viewportHeight = this.editor.domManager
        .getElementMetrics(this.viewport).clientHeight;
      this.needsMeasure = false;
    }

    this.scrollY = Math.max(0, Math.min(this.scrollY, this.getMaxScrollY()));
    const maxScrollY = this.getMaxScrollY();
    const ratio = maxScrollY > 0 ? this.scrollY / maxScrollY : 0;

    if (this.vScroller) {
      this.vScroller.nbItem = this.items.length;
      this.vScroller.heightByItem = 1;
      this.vScroller.setScrollRatio(ratio);
      if (needsMeasure || previousHeight !== this.viewportHeight ||
        previousTotalHeight !== this.totalVirtualHeight) {
        this.vScroller.refreshMetrics();
      }
    }

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

    this._measuredTotalVirtualHeight = this.totalVirtualHeight;
    if (this.vScroller) {
      this.vScroller.refresh();
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
    this.vScroller?.setActive(false);
  }

  resume() {
    this.suspended = false;
    if (this.viewport) this._resizeObserver?.observe(this.viewport);
    this.scheduleRender(true);
  }

  destroy() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.viewport?.removeEventListener("wheel", this._onWheel);
    this._resizeObserver?.disconnect();
    this.vScroller?.destroy();
    const scrollers = this.editor.scrollerManager?.scrollers;
    if (scrollers) {
      const index = scrollers.indexOf(this.vScroller);
      if (index !== -1) scrollers.splice(index, 1);
    }
    this.vScroller = null;
    this.viewport = null;
    this.layer = null;
    this.layerFast = null;
  }
}
