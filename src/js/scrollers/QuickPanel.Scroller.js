class QuickPanelScroller {
  constructor(editor, quickPanel) {
    this.editor = editor;
    this.quickPanel = quickPanel;

    this.viewport = null;
    this.layer = null;
    this.layerFast = null;
    this.vScroller = null;

    this.items = [];
    this.entries = [];
    this.itemEntryIndexes = [];
    this.rowHeight = 0;
    this.totalVirtualHeight = 0;
    this.viewportHeight = 0;
    this.scrollY = 0;
    this.startIndex = 0;
    this.endIndex = 0;
    this.renderStart = 0;
    this.renderEnd = 0;
    this.overscan = 4;
    this.frame = null;
    this.needsMeasure = true;
    this.active = false;
    this.forceRender = true;
    this.renderedRows = new Map();
    this.pendingEnsureIndex = null;
    this.lastTotalVirtualHeight = -1;

    this._onWheel = (event) => this.handleWheel(event);
    this._resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => this.scheduleRender(true))
      : null;
    this._hasWheelListener = false;
  }

  attach(viewport, layer) {
    if (this.viewport === viewport && this.layer === layer) return;

    this.detachViewport();
    this.viewport = viewport;
    this.layer = layer;
    this.layerFast = this.editor.domManager?.wrapFastNode?.(layer) || null;

    const manager = this.editor.scrollerManager;
    if (manager && viewport) {
      this.vScroller = manager.createScroller(
        viewport,
        manager.VERTICAL_TYPE,
        false,
        { compact: true },
      );
      this.vScroller.wheelTarget = viewport;
      this.vScroller._onWheel = this._onWheel;
      this.vScroller.calculProp = () => this.totalVirtualHeight > 0
        ? Math.min(100, this.viewportHeight / this.totalVirtualHeight * 100)
        : 100;
      this.vScroller.calcIsActive = () => this.isScrollable();
      this.vScroller.onScroll = (ratio) => this.setScrollRatio(ratio);
      this.vScroller.onRefresh = () => {};
      manager.addScroller(this.vScroller);
    } else if (viewport) {
      viewport.addEventListener("wheel", this._onWheel, { passive: false });
      this._hasWheelListener = true;
    }

    this.scheduleRender(true);
  }

  detachViewport() {
    if (this._hasWheelListener) {
      this.viewport?.removeEventListener("wheel", this._onWheel);
      this._hasWheelListener = false;
    }
    if (this.vScroller) {
      const manager = this.editor.scrollerManager;
      if (manager?.destroyScroller) manager.destroyScroller(this.vScroller);
      else this.vScroller.destroy?.();
      this.vScroller = null;
    }
    if (this.viewport) this._resizeObserver?.unobserve(this.viewport);
  }

  setItems(items) {
    this.items = Array.isArray(items) ? items : [];
    this.entries = [];
    this.itemEntryIndexes = new Array(this.items.length);

    let previousSection = null;
    let hasRenderedItem = false;
    for (let itemIndex = 0; itemIndex < this.items.length; itemIndex += 1) {
      const item = this.items[itemIndex];
      if (item.separatorBefore && hasRenderedItem) {
        this.entries.push({ type: "separator" });
      }

      const section = item.section || null;
      if (section && section !== previousSection) {
        this.entries.push({ type: "section", section });
      }
      previousSection = section;

      this.itemEntryIndexes[itemIndex] = this.entries.length;
      this.entries.push({ type: "item", itemIndex });
      hasRenderedItem = true;
    }

    this.clearRenderedRows();
    this.scrollY = 0;
    this.pendingEnsureIndex = null;
    this.totalVirtualHeight = this.entries.length * this.rowHeight;
    this.startIndex = 0;
    this.endIndex = 0;
    this.renderStart = 0;
    this.renderEnd = 0;
    this.forceRender = true;
    this.needsMeasure = true;
    this.scheduleRender();
  }

  clear() {
    this.items = [];
    this.entries = [];
    this.itemEntryIndexes = [];
    this.totalVirtualHeight = 0;
    this.scrollY = 0;
    this.pendingEnsureIndex = null;
    this.startIndex = 0;
    this.endIndex = 0;
    this.renderStart = 0;
    this.renderEnd = 0;
    this.forceRender = true;
    this.clearRenderedRows();
    this.layerFast?.setHeight(0);
    this.editor.scrollerManager?.deactivateScroller?.(this.vScroller);
  }

  clearRenderedRows() {
    for (const row of this.renderedRows.values()) {
      if (row === this.quickPanel.hoveredItem) {
        this.quickPanel.clearHoveredItem(row);
      }
      row.remove();
    }
    this.renderedRows.clear();
  }

  getMaxScrollY() {
    return Math.max(0, this.totalVirtualHeight - this.viewportHeight);
  }

  isScrollable() {
    return this.active && this.entries.length > 0 &&
      this.totalVirtualHeight > this.viewportHeight;
  }

  setScrollY(value) {
    const numericValue = Number(value);
    const next = Number.isFinite(numericValue)
      ? Math.max(0, Math.min(numericValue, this.getMaxScrollY()))
      : 0;
    if (next === this.scrollY) return false;
    this.scrollY = next;
    this.scheduleRender();
    return true;
  }

  setScrollRatio(ratio) {
    const numericRatio = Number(ratio);
    const normalized = Number.isFinite(numericRatio)
      ? Math.max(0, Math.min(1, numericRatio))
      : 0;
    this.setScrollY(normalized * this.getMaxScrollY());
  }

  ensureIndexVisible(itemIndex) {
    if (!Number.isInteger(itemIndex) || itemIndex < 0 ||
      itemIndex >= this.itemEntryIndexes.length) return false;

    if (this.viewportHeight <= 0 || this.rowHeight <= 0) {
      this.pendingEnsureIndex = itemIndex;
      this.scheduleRender(true);
      return false;
    }

    const entryIndex = this.itemEntryIndexes[itemIndex];
    const itemTop = entryIndex * this.rowHeight;
    const itemBottom = itemTop + this.rowHeight;
    return this.setScrollY(this.getScrollYForItem(itemTop, itemBottom));
  }

  getScrollYForItem(itemTop, itemBottom) {
    let nextScrollY = this.scrollY;
    if (itemTop < this.scrollY) nextScrollY = itemTop;
    else if (itemBottom > this.scrollY + this.viewportHeight) {
      nextScrollY = itemBottom - this.viewportHeight;
    }
    return Math.max(0, Math.min(nextScrollY, this.getMaxScrollY()));
  }

  updateSelection(previousItemIndex, nextItemIndex) {
    const previousEntryIndex = this.itemEntryIndexes[previousItemIndex];
    const nextEntryIndex = this.itemEntryIndexes[nextItemIndex];
    this.renderedRows.get(previousEntryIndex)?.setAttribute("aria-selected", "false");
    this.renderedRows.get(nextEntryIndex)?.setAttribute("aria-selected", "true");
  }

  handleWheel(event) {
    if (!this.vScroller?.active && this.editor.scrollerManager) return;
    if (!this.isScrollable() || event.shiftKey) return;
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;

    const delta = Number(event.deltaY);
    if (!Number.isFinite(delta) || delta === 0) return;
    const pixels = event.deltaMode === 1
      ? delta * this.rowHeight
      : event.deltaMode === 2
        ? delta * this.viewportHeight
        : delta;
    const next = Math.max(0, Math.min(this.scrollY + pixels, this.getMaxScrollY()));
    if (next === this.scrollY) return;

    event.preventDefault();
    event.stopPropagation();
    this.setScrollY(next);
  }

  scheduleRender(measure = false) {
    this.needsMeasure ||= measure;
    if (!this.active || this.frame !== null || !this.viewport || !this.layerFast) return;

    const requestFrame = this.editor.domManager?.requestFrame ||
      (typeof requestAnimationFrame === "function" ? requestAnimationFrame : null);
    if (!requestFrame) return;
    this.frame = requestFrame(() => {
      this.frame = null;
      this.update();
    });
  }

  measureViewport() {
    const metrics = this.editor.domManager?.getElementMetrics?.(this.viewport);
    this.viewportHeight = Math.max(
      0,
      Number(metrics?.clientHeight ?? this.viewport?.clientHeight) || 0,
    );

    const computedStyle = typeof window !== "undefined"
      ? window.getComputedStyle?.(this.viewport)
      : null;
    const cssRowHeight = Number.parseFloat(
      computedStyle?.getPropertyValue?.("--quick-panel-row-height") || "",
    );
    if (Number.isFinite(cssRowHeight) && cssRowHeight > 0) {
      this.rowHeight = cssRowHeight;
      this.totalVirtualHeight = this.entries.length * this.rowHeight;
    }
  }

  update() {
    if (!this.active || !this.viewport || !this.layerFast) return;

    const measured = this.needsMeasure;
    const previousViewportHeight = this.viewportHeight;
    const previousTotalHeight = this.totalVirtualHeight;
    if (measured) {
      this.measureViewport();
      this.needsMeasure = false;
    }

    if (this.pendingEnsureIndex !== null) {
      const itemIndex = this.pendingEnsureIndex;
      this.pendingEnsureIndex = null;
      const entryIndex = this.itemEntryIndexes[itemIndex];
      if (entryIndex !== undefined) {
        const itemTop = entryIndex * this.rowHeight;
        this.scrollY = this.getScrollYForItem(itemTop, itemTop + this.rowHeight);
      }
    }

    this.scrollY = Math.max(0, Math.min(this.scrollY, this.getMaxScrollY()));
    const rowHeight = this.rowHeight;
    const start = rowHeight > 0 && this.viewportHeight > 0
      ? Math.floor(this.scrollY / rowHeight)
      : 0;
    const end = rowHeight > 0 && this.viewportHeight > 0
      ? Math.min(
          this.entries.length,
          Math.ceil((this.scrollY + this.viewportHeight) / rowHeight),
        )
      : 0;
    const renderStart = Math.max(0, start - this.overscan);
    const renderEnd = Math.min(this.entries.length, end + this.overscan);

    this.startIndex = start;
    this.endIndex = end;
    this.renderStart = renderStart;
    this.renderEnd = renderEnd;
    this.layerFast.setHeight(this.totalVirtualHeight);
    this.layerFast.setTransform(`translate3d(0, -${this.scrollY}px, 0)`);

    if (measured || previousTotalHeight !== this.totalVirtualHeight ||
      this.forceRender || renderStart !== this._renderedStart ||
      renderEnd !== this._renderedEnd) {
      this.renderRange(renderStart, renderEnd);
      this.forceRender = false;
      this._renderedStart = renderStart;
      this._renderedEnd = renderEnd;
    }

    const totalChanged = this.lastTotalVirtualHeight !== this.totalVirtualHeight;
    if (this.vScroller) {
      this.vScroller.nbItem = this.entries.length;
      this.vScroller.heightByItem = this.rowHeight;
      const maxScrollY = this.getMaxScrollY();
      this.vScroller.setScrollRatio(maxScrollY > 0 ? this.scrollY / maxScrollY : 0);
      if (measured || totalChanged || previousViewportHeight !== this.viewportHeight) {
        this.vScroller.refreshMetrics();
      }
      this.vScroller.refresh();
    }

    this.lastTotalVirtualHeight = this.totalVirtualHeight;
  }

  renderRange(start, end) {
    for (const [entryIndex, row] of this.renderedRows) {
      if (entryIndex >= start && entryIndex < end) continue;
      if (row === this.quickPanel.hoveredItem) {
        this.quickPanel.clearHoveredItem(row);
      }
      row.remove();
      this.renderedRows.delete(entryIndex);
    }

    let nextChild = this.layer.firstChild;
    for (let entryIndex = start; entryIndex < end; entryIndex += 1) {
      let row = this.renderedRows.get(entryIndex);
      if (!row) {
        row = this.quickPanel.createVirtualRow(
          this.entries[entryIndex],
          this.items.length,
        );
        this.renderedRows.set(entryIndex, row);
      }

      const rowFast = this.editor.domManager?.wrapFastNode?.(row);
      rowFast?.setStyle("position", "absolute");
      rowFast?.setTop(entryIndex * this.rowHeight);
      rowFast?.setLeft(0);
      rowFast?.setWidth("100%");
      rowFast?.setHeight(this.rowHeight);

      if (row !== nextChild) this.layer.insertBefore(row, nextChild);
      nextChild = row.nextSibling;
    }
  }

  refresh() {
    this.scheduleRender(true);
  }

  suspend() {
    this.active = false;
    if (this.viewport) this._resizeObserver?.unobserve(this.viewport);
    if (this.frame !== null) {
      const cancelFrame = this.editor.domManager?.cancelFrame ||
        (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : null);
      cancelFrame?.(this.frame);
      this.frame = null;
    }
    this.editor.scrollerManager?.deactivateScroller?.(this.vScroller);
  }

  resume() {
    if (this.active) {
      this.scheduleRender(true);
      return;
    }
    this.active = true;
    if (this.viewport) this._resizeObserver?.observe(this.viewport);
    this.scheduleRender(true);
  }

  destroy() {
    this.suspend();
    this.detachViewport();
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this.clearRenderedRows();
    this.viewport = null;
    this.layer = null;
    this.layerFast = null;
  }
}
