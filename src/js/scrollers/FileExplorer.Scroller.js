class FileExplorerScroller {
  constructor(editor, explorer) {
    this.editor = editor;
    this.explorer = explorer;
    this.viewport = null;
    this.layer = null;
    this.host = editor.sidebarManager?.leftSidebar || null;
    this.vScroller = null;
    this.rowHeight = explorer.constructor.ROW_HEIGHT;
    this.scrollTop = 0;
    this.startIndex = 0;
    this.offsetY = 0;
    this.totalVisibleRows = 0;
    this.maxViewRows = 0;
    this.renderedRowCount = 0;
    this.viewportHeight = 0;
    this.active = false;
    this.frame = null;
    this.renderedStart = -1;
    this.renderedCount = -1;
    this._onWheel = (event) => {
      if (!this.active || !this.calcIsActive()) return;
      if (event.shiftKey && Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      event.stopPropagation();
      const pixels = event.deltaMode === 1 ? delta * this.rowHeight :
        event.deltaMode === 2 ? delta * this.viewportHeight : delta;
      this.setScrollTop(this.scrollTop + pixels);
    };
    this._resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => this.scheduleRender(true)) : null;
  }

  init() {
    if (this.vScroller || !this.host || !this.editor.scrollerManager) return;
    const manager = this.editor.scrollerManager;
    this.vScroller = manager.createScroller(this.host, manager.VERTICAL_TYPE, false);
    // Wheel events on the viewport retain their pixel delta, including trackpads.
    this.vScroller.wheelTarget = this.vScroller.parentOBJ;
    this.vScroller.calculProp = () => !this.calcIsActive() ? 100 :
      this.viewportHeight / (this.totalVisibleRows * this.rowHeight) * 100;
    this.vScroller.calcIsActive = () => this.active && this.calcIsActive();
    this.vScroller.onScroll = (ratio) => this.setScrollRatio(ratio);
    this.vScroller.onRefresh = () => {};
    manager.addScroller(this.vScroller);
    this.vScroller.setActive(false);
  }

  attach(viewport, layer) {
    if (this.viewport !== viewport) {
      this.viewport?.removeEventListener("wheel", this._onWheel);
      if (this.viewport) this._resizeObserver?.unobserve(this.viewport);
    this.viewport = viewport;
    this.layer = layer;
      this.renderedStart = -1;
      this.renderedCount = -1;
      viewport?.addEventListener("wheel", this._onWheel, { passive: false });
      if (viewport) this._resizeObserver?.observe(viewport);
      else {
        this.totalVisibleRows = 0;
        this.vScroller?.setActive(false);
      }
    }
    this.init();
    this.scheduleRender(true);
  }

  resume() {
    this.active = true;
    this.scheduleRender(true);
  }

  suspend() {
    this.active = false;
    this.vScroller?.setActive(false);
  }

  calcIsActive() {
    return this.viewportHeight > 0 &&
      this.totalVisibleRows * this.rowHeight > this.viewportHeight;
  }

  getMaxScrollTop() {
    if (!this.calcIsActive()) return 0;
    return Math.max(0, this.totalVisibleRows * this.rowHeight - this.viewportHeight);
  }

  setScrollRatio(ratio) {
    this.setScrollTop(Math.max(0, Math.min(1, ratio)) * this.getMaxScrollTop());
  }

  setScrollTop(value) {
    const next = Number.isFinite(value) ? Math.max(0, Math.min(value, this.getMaxScrollTop())) : 0;
    if (next === this.scrollTop) return;
    this.scrollTop = next;
    this.startIndex = Math.floor(next / this.rowHeight);
    this.offsetY = next - this.startIndex * this.rowHeight;
    this.explorer.onVirtualScroll?.();
    this.scheduleRender();
  }

  refresh() {
    this.scheduleRender(true);
  }

  scheduleRender(measure = false) {
    this.needsMeasure ||= measure;
    if (this.frame !== null) return;
    const request = this.editor.domManager?.requestFrame || requestAnimationFrame;
    this.frame = request(() => {
      this.frame = null;
      this.update();
    });
  }

  update() {
    if (!this.viewport || !this.layer) return;
    // Read before writing to the render layer or scrollbar.
    const needsMeasure = this.needsMeasure;
    const previousTotal = this.totalVisibleRows;
    if (needsMeasure) {
      this.viewportHeight = this.editor.domManager.getElementMetrics(this.viewport).clientHeight;
      this.needsMeasure = false;
    }
    this.maxViewRows = this.viewportHeight > 0 ? Math.ceil(this.viewportHeight / this.rowHeight) : 0;
    this.totalVisibleRows = this.explorer.visibleRows?.length || 0;
    this.renderedRowCount = Math.min(this.totalVisibleRows, this.maxViewRows + 1);
    if (this.vScroller && (needsMeasure || previousTotal !== this.totalVisibleRows)) {
      this.vScroller.refreshMetrics();
    }
    const clamped = Math.min(this.scrollTop, this.getMaxScrollTop());
    this.scrollTop = clamped;
    this.startIndex = Math.floor(clamped / this.rowHeight);
    this.offsetY = clamped - this.startIndex * this.rowHeight;
    const count = Math.min(this.renderedRowCount, this.totalVisibleRows - this.startIndex);
    if (this.renderedStart !== this.startIndex || this.renderedCount !== count || this.forceRows) {
      this.explorer.renderVirtualRows(this.startIndex, count);
      this.renderedStart = this.startIndex;
      this.renderedCount = count;
      this.forceRows = false;
    }
    this.layer.style.transform = `translate3d(0, -${this.offsetY}px, 0)`;
    if (this.vScroller) {
      this.vScroller.nbItem = this.totalVisibleRows;
      this.vScroller.heightByItem = this.rowHeight;
      this.vScroller.setScrollRatio(this.getMaxScrollTop() ? clamped / this.getMaxScrollTop() : 0);
      if (needsMeasure || previousTotal !== this.totalVisibleRows) this.vScroller.refresh();
      else this.vScroller.writeThumbPosition(this.vScroller.readThumbMetrics());
    }
  }

  invalidateRows() {
    this.forceRows = true;
    this.scheduleRender(true);
  }

  destroy() {
    this.suspend();
    if (this.frame !== null) (this.editor.domManager?.cancelFrame || cancelAnimationFrame)(this.frame);
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
  }
}
