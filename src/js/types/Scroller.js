class Scroller {
  constructor(e) {
    this.editor = e;
    this.id = 0;
    this.scrollX = 0;
    this.scrollY = 0;
    this.type = 0;
    this.active = true;
    this.isBody = true;
    this.isRendering = false;

    this.parentOBJ = null;
    this.wheelTarget = null;
    this.scrollerOBJ = null;
    this.itemOBJ = null;
    this.scrollerFast = null;
    this.itemFast = null;

    this.scrollerOBJHeight = 0;
    this.scrollerOBJWidth = 0;
    this.itemOBJHeight = 0;
    this.itemOBJWidth = 0;
    this.parentOBJHeight = 0;
    this.parentOBJWidth = 0;

    this.scrollRatio = 0;
    this.targetScrollRatio = 0;
    this._rafId = null;
    this._scrollEndTimer = null;

    this.strength = 0.5;
    this.renderMargin = 5;

    this.nbItem = 0;
    this.heightByItem = 0;

    this.isHovered = false;
    this.dragOffset = 0;

    this.calculProp = () => 0;
    this.calcIsActive = () => false;
    this.onRefresh = () => {};
    this.onScroll = () => {};
    this.onScrollEnd = () => {};

    this._onMouseMove = this.handleMouseMove.bind(this);
    this._onMouseUp = this.handleMouseUp.bind(this);
    this._onWheel = this.handleWheel.bind(this);
    this._onThumbDown = null;
    this._onMouseEnter = null;
    this._onMouseLeave = null;
  }

  hide() {
    this.scrollerFast?.toggleClass("page-scroller-inactive", true);
  }

  show() {
    this.scrollerFast?.toggleClass("page-scroller-inactive", false);
  }

  calcul(diff) {
    return Math.max(100 * Math.pow(0.99, diff), 3);
  }

  setScrollRatio(ratio) {
    const clamped = Math.max(0, Math.min(ratio, 1));
    this.scrollRatio = clamped;
    this.targetScrollRatio = clamped;
  }

  scheduleScrollRender() {
    if (this._scrollEndTimer) clearTimeout(this._scrollEndTimer);
    this._scrollEndTimer = setTimeout(() => {
      this._scrollEndTimer = null;
      this.onScrollEnd();
    }, 100);

    if (this._rafId !== null) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this.renderScrollFrame();
    });
  }

  renderScrollFrame() {
    if (!this.active) return;

    this.scrollRatio = this.targetScrollRatio;

    const metrics = this.readThumbMetrics();
    if (metrics) this.writeThumbPosition(metrics);

    this.onScroll(this.scrollRatio);
  }

  refreshMetrics() {
    const scrollerMetrics = this.editor.domManager.getElementMetrics(
      this.scrollerOBJ,
    );
    const itemMetrics = this.editor.domManager.getElementMetrics(this.itemOBJ);
    const parentMetrics = this.editor.domManager.getElementMetrics(
      this.parentOBJ,
    );

    this.scrollerOBJHeight = scrollerMetrics.clientHeight;
    this.scrollerOBJWidth = scrollerMetrics.clientWidth;
    this.itemOBJHeight = itemMetrics.clientHeight;
    this.itemOBJWidth = itemMetrics.clientWidth;
    this.parentOBJHeight = parentMetrics.clientHeight;
    this.parentOBJWidth = parentMetrics.clientWidth;
  }

  readThumbMetrics() {
    if (!this.scrollerOBJ || !this.itemOBJ) return null;

    const isVertical = this.type === this.editor.scrollerManager.VERTICAL_TYPE;

    if (isVertical) {
      return {
        isVertical: true,
        maxScroll: this.scrollerOBJHeight - this.itemOBJHeight,
      };
    }

    return {
      isVertical: false,
      maxScroll: this.scrollerOBJWidth - this.itemOBJWidth,
    };
  }

  writeThumbPosition(metrics) {
    if (metrics.maxScroll <= 0) return;

    const pos = this.scrollRatio * metrics.maxScroll;
    if (metrics.isVertical) {
      this.itemFast?.setTop(pos);
    } else {
      this.itemFast?.setLeft(pos);
    }
  }

  init() {
    if (this.scrollerOBJ || this.itemOBJ) return;

    this.scrollerOBJ = document.createElement("div");
    this.itemOBJ = document.createElement("div");
    this.scrollerFast = this.editor.domManager.wrapFastNode(this.scrollerOBJ);
    this.itemFast = this.editor.domManager.wrapFastNode(this.itemOBJ);

    this.scrollerFast.setClassName("page-scroller");
    this.itemFast.setClassName("page-scroller-item");

    this.scrollerFast.setStyle("transition", "opacity 0.2s ease-in-out");
    this.scrollerFast.setOpacity(0);

    this.scrollerFast.toggleClass("page-scroller-body", this.isBody);
    this.scrollerFast.toggleClass("page-scroller-inactive", !this.active);

    if (this.type === this.editor.scrollerManager.VERTICAL_TYPE) {
      this.scrollerFast.addClass("page-scroller-vertical");
    } else {
      this.scrollerFast.addClass("page-scroller-horizontal");
    }

    this.scrollerFast.setProperty("id", String(this.id));
    this.scrollerFast.appendChild(this.itemFast);
    this.editor.domManager.wrapFastNode(this.parentOBJ)?.appendChild(this.scrollerFast);

    this.addScrollListeners();
    this.refresh();
  }

  updateVisibility() {
    if (!this.scrollerOBJ) return;
    if (this.active && (this.isHovered || this.isDragging)) {
      this.scrollerFast?.setOpacity(1);
    } else {
      this.scrollerFast?.setOpacity(0);
    }
  }

  refresh() {
    if (!this.calcIsActive()) {
      this.setActive(false);
      return;
    }

    this.setActive(true);

    const proportion = this.calculProp();
    const isVertical = this.type === this.editor.scrollerManager.VERTICAL_TYPE;
    const track = isVertical ? this.scrollerOBJHeight : this.scrollerOBJWidth;
    const size = Math.max((proportion / 100) * track, 20);

    if (isVertical) {
      this.itemFast?.setHeight(size);
      this.itemOBJHeight = size;
    } else {
      this.itemFast?.setWidth(size);
      this.itemOBJWidth = size;
    }

    const metrics = this.readThumbMetrics();
    if (metrics) this.writeThumbPosition(metrics);
  }

  setActive(mode) {
    this.active = mode;
    if (!this.scrollerOBJ) return;
    this.scrollerFast?.toggleClass("page-scroller-inactive", !mode);

    this.updateVisibility();
  }

  addScrollListeners() {
    this.isDragging = false;
    this._onThumbDown = (e) => {
      this.isDragging = true;

      if (this.editor && this.editor.sidebarResizer) {
        this.editor.domManager.wrapFastNode(this.editor.sidebarResizer.leftResizer)?.setDisplay("none");
        this.editor.domManager.wrapFastNode(this.editor.sidebarResizer.rightResizer)?.setDisplay("none");
      }

      const itemRect = this.editor.domManager.getElementMetrics(this.itemOBJ);
      const isVertical =
        this.type === this.editor.scrollerManager.VERTICAL_TYPE;
      this.dragOffset = isVertical
        ? e.clientY - itemRect.top
        : e.clientX - itemRect.left;

      this.updateVisibility();
      e.preventDefault();
    };
    this.itemOBJ.addEventListener("mousedown", this._onThumbDown);

    this._onMouseEnter = () => {
      this.isHovered = true;
      this.updateVisibility();
    };

    this._onMouseLeave = () => {
      this.isHovered = false;
      this.updateVisibility();
    };
    this.parentOBJ.addEventListener("mouseenter", this._onMouseEnter);
    this.parentOBJ.addEventListener("mouseleave", this._onMouseLeave);

    document.addEventListener("mousemove", this._onMouseMove);
    document.addEventListener("mouseup", this._onMouseUp);
    const wheelTarget = this.wheelTarget || this.parentOBJ;
    wheelTarget.addEventListener("wheel", this._onWheel, { passive: false });
  }

  destroy() {
    if (this._rafId !== null) cancelAnimationFrame(this._rafId);
    if (this._scrollEndTimer) clearTimeout(this._scrollEndTimer);
    this.itemOBJ?.removeEventListener("mousedown", this._onThumbDown);
    this.parentOBJ?.removeEventListener("mouseenter", this._onMouseEnter);
    this.parentOBJ?.removeEventListener("mouseleave", this._onMouseLeave);
    document.removeEventListener("mousemove", this._onMouseMove);
    document.removeEventListener("mouseup", this._onMouseUp);
    (this.wheelTarget || this.parentOBJ)?.removeEventListener("wheel", this._onWheel);
    this.scrollerFast?.remove();
    this.scrollerOBJ = null;
    this.itemOBJ = null;
    this.scrollerFast = null;
    this.itemFast = null;
  }

  handleMouseMove(e) {
    if (!this.isDragging || !this.active) return;

    const rect = this.editor.domManager.getElementMetrics(this.scrollerOBJ);
    const isVertical = this.type === this.editor.scrollerManager.VERTICAL_TYPE;

    if (isVertical) {
      const maxScroll = this.scrollerOBJHeight - this.itemOBJHeight;
      if (maxScroll <= 0) return;

      const newTop = Math.max(
        0,
        Math.min(e.clientY - rect.top - this.dragOffset, maxScroll),
      );
      this.targetScrollRatio = newTop / maxScroll;
    } else {
      const maxScroll = this.scrollerOBJWidth - this.itemOBJWidth;
      if (maxScroll <= 0) return;

      const newLeft = Math.max(
        0,
        Math.min(e.clientX - rect.left - this.dragOffset, maxScroll),
      );
      this.targetScrollRatio = newLeft / maxScroll;
    }

    this.scheduleScrollRender();
  }

  handleMouseUp() {
    if (this.isDragging) this.onScrollEnd();
    this.isDragging = false;

    if (this.editor && this.editor.sidebarResizer) {
      this.editor.sidebarResizer.updateResizerVisibility();
    }

    this.updateVisibility();
  }

  handleWheel(e) {
    if (!this.active) return;

    const isVertical = this.type === this.editor.scrollerManager.VERTICAL_TYPE;
    if (isVertical && !e.shiftKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      return;
    }

    if (
      !isVertical &&
      !e.shiftKey &&
      Math.abs(e.deltaX) <= Math.abs(e.deltaY)
    ) {
      return;
    }

    const delta = isVertical ? e.deltaY : e.shiftKey ? e.deltaY : e.deltaX;
    if (!isVertical && delta === 0) return;

    e.preventDefault();
    if (!isVertical && delta !== 0) e.stopPropagation();
    const dimension = isVertical
      ? this.scrollerOBJHeight
      : this.scrollerOBJWidth;
    const itemSize = isVertical ? this.itemOBJHeight : this.itemOBJWidth;

    const maxScroll = dimension - itemSize;
    if (maxScroll <= 0) return;

    let dynamicStrength = this.strength;
    if (this.nbItem > 0) {
      if (this.nbItem < 50) {
        dynamicStrength = 1.0;
      } else if (this.nbItem > 500) {
        dynamicStrength = 0.1;
      } else {
        dynamicStrength = 1.0 - ((this.nbItem - 50) / 450) * 0.5;
      }
    }

    this.targetScrollRatio = Math.max(
      0,
      Math.min(
        this.targetScrollRatio + (delta * dynamicStrength) / dimension,
        1,
      ),
    );
    this.scheduleScrollRender();
  }

  getIntervalItem() {
    if (
      this.nbItem === undefined ||
      this.nbItem === null ||
      this.heightByItem === undefined ||
      this.heightByItem === null ||
      this.heightByItem === 0
    ) {
      return { start: 0, end: 0 };
    }

    const visibleItems = Math.ceil(this.parentOBJHeight / this.heightByItem);
    const maxScrollIndex = Math.max(0, this.nbItem - visibleItems);
    let start =
      Math.floor(this.scrollRatio * maxScrollIndex) - this.renderMargin;
    let end = Math.min(start + visibleItems, this.nbItem) + this.renderMargin;

    if (start < 0) start = 0;
    if (end > this.nbItem) end = this.nbItem;

    return { start, end };
  }
}
