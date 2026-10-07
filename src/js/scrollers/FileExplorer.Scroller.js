class FileExplorerScroller {
  constructor(editor, explorer) {
    this.editor = editor;
    this.explorer = explorer;
    this.viewport = null;
    this.layer = null;
    this.layerFast = null;
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
    manager.deactivateScroller?.(this.vScroller);
  }

  attach(viewport, layer) {
    if (this.viewport !== viewport || this.layer !== layer) {
      this.viewport?.removeEventListener("wheel", this._onWheel);
      if (this.viewport) this._resizeObserver?.unobserve(this.viewport);
      this.viewport = viewport;
      this.layer = layer;
      this.layerFast = this.editor.domManager?.wrapFastNode?.(layer) || null;
      this.renderedStart = -1;
      this.renderedCount = -1;
      viewport?.addEventListener("wheel", this._onWheel, { passive: false });
      if (viewport) this._resizeObserver?.observe(viewport);
      else {
        this.totalVisibleRows = 0;
        this.editor.scrollerManager?.deactivateScroller?.(this.vScroller);
      }
    }
    this.init();
    this.scheduleRender(true);
  }

  resume() {
    this.active = true;
    this.editor.scrollerManager?.activateScroller?.(this.vScroller, {
      deferRefresh: true,
    });
    this.scheduleRender(true);
  }

  suspend() {
    this.active = false;
    this.editor.scrollerManager?.deactivateScroller?.(this.vScroller);
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
    if (!this.viewport || !this.layerFast) return;
    // Read before writing to the render layer or scrollbar.
    const needsMeasure = this.needsMeasure;
    const previousViewportHeight = this.viewportHeight;
    const previousTotal = this.totalVisibleRows;
    if (needsMeasure) {
      this.viewportHeight = this.editor.domManager.getElementMetrics(this.viewport).clientHeight;
      this.needsMeasure = false;
    }
    this.maxViewRows = this.viewportHeight > 0 ? Math.ceil(this.viewportHeight / this.rowHeight) : 0;
    this.totalVisibleRows = this.explorer.visibleRows?.length || 0;
    this.renderedRowCount = Math.min(this.totalVisibleRows, this.maxViewRows + 1);
    const metricsInvalidated = previousViewportHeight !== this.viewportHeight;
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
    this.layerFast.setTransform(`translate3d(0, -${this.offsetY}px, 0)`);
    if (this.vScroller) {
      this.vScroller.nbItem = this.totalVisibleRows;
      this.vScroller.heightByItem = this.rowHeight;
      this.vScroller.setScrollRatio(this.getMaxScrollTop() ? clamped / this.getMaxScrollTop() : 0);
      if (metricsInvalidated) {
        const manager = this.editor.scrollerManager;
        if (manager?.invalidateScroller) manager.invalidateScroller(this.vScroller);
        else {
          this.vScroller.refreshMetrics();
          this.vScroller.refresh();
        }
      } else {
        const manager = this.editor.scrollerManager;
        if (manager?.refreshScroller) manager.refreshScroller(this.vScroller);
        else if (previousTotal !== this.totalVisibleRows) this.vScroller.refresh();
        else this.vScroller.writeThumbPosition(this.vScroller.readThumbMetrics());
      }
    }
  }

  invalidateRows() {
    this.forceRows = true;
    this.scheduleRender(true);
  }

  destroy() {
    this.suspend();
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
    this.viewport = null;
    this.layer = null;
    this.layerFast = null;
  }
}
