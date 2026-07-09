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
    this.scrollerOBJ = null;
    this.itemOBJ = null;

    this.scrollRatio = 0;
    this.targetScrollRatio = 0;
    this._rafId = null;
    this._scrollEndTimer = null;

    this.strength = 0.5;
    this.renderMargin = 5;

    this.nbItem = 0;
    this.heightByItem = 0;

    this.calculProp = () => 0;
    this.calcIsActive = () => false;
    this.onRefresh = () => {};
    this.onScroll = () => {};
    this.onScrollEnd = () => {};

    this._onMouseMove = this.handleMouseMove.bind(this);
    this._onMouseUp = this.handleMouseUp.bind(this);
    this._onWheel = this.handleWheel.bind(this);
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

  readThumbMetrics() {
    if (!this.scrollerOBJ || !this.itemOBJ) return null;

    const isVertical = this.type === this.editor.scrollerManager.VERTICAL_TYPE;

    if (isVertical) {
      return {
        isVertical: true,
        maxScroll: this.scrollerOBJ.clientHeight - this.itemOBJ.clientHeight,
      };
    }

    return {
      isVertical: false,
      maxScroll: this.scrollerOBJ.clientWidth - this.itemOBJ.clientWidth,
    };
  }

  writeThumbPosition(metrics) {
    if (metrics.maxScroll <= 0) return;

    const pos = this.scrollRatio * metrics.maxScroll;
    if (metrics.isVertical) {
      this.itemOBJ.style.top = `${pos}px`;
    } else {
      this.itemOBJ.style.left = `${pos}px`;
    }
  }

  init() {
    if (this.scrollerOBJ || this.itemOBJ) return;

    this.scrollerOBJ = document.createElement("div");
    this.itemOBJ = document.createElement("div");

    this.scrollerOBJ.classList.add("page-scroller", "box");
    this.itemOBJ.classList.add("page-scroller-item");

    if (this.isBody) this.scrollerOBJ.classList.add("page-scroller-body");
    if (!this.active) this.scrollerOBJ.classList.add("page-scroller-inactive");

    if (this.type === this.editor.scrollerManager.VERTICAL_TYPE) {
      this.scrollerOBJ.classList.add("page-scroller-vertical");
    } else {
      this.scrollerOBJ.classList.add("page-scroller-horizontal");
    }

    this.scrollerOBJ.id = this.id;
    this.scrollerOBJ.appendChild(this.itemOBJ);
    this.parentOBJ.appendChild(this.scrollerOBJ);

    this.addScrollListeners();
    this.refresh();
  }

  refresh() {
    if (!this.calcIsActive()) {
      this.setActive(false);
      return;
    }

    this.setActive(true);

    const proportion = this.calculProp();
    const isVertical = this.type === this.editor.scrollerManager.VERTICAL_TYPE;
    const track = isVertical
      ? this.parentOBJ.clientHeight
      : this.parentOBJ.clientWidth;
    const size = Math.max((proportion / 100) * track, 20);

    if (isVertical) {
      this.itemOBJ.style.height = `${size}px`;
    } else {
      this.itemOBJ.style.width = `${size}px`;
    }

    const metrics = this.readThumbMetrics();
    if (metrics) this.writeThumbPosition(metrics);
  }

  setActive(mode) {
    this.active = mode;
    if (!this.scrollerOBJ) return;
    if (mode) this.scrollerOBJ.classList.remove("page-scroller-inactive");
    else this.scrollerOBJ.classList.add("page-scroller-inactive");
  }

  addScrollListeners() {
    this.isDragging = false;
    this.itemOBJ.addEventListener("mousedown", (e) => {
      this.isDragging = true;
      e.preventDefault();
    });
    document.addEventListener("mousemove", this._onMouseMove);
    document.addEventListener("mouseup", this._onMouseUp);
    this.parentOBJ.addEventListener("wheel", this._onWheel, { passive: false });
  }

  handleMouseMove(e) {
    if (!this.isDragging || !this.active) return;

    const rect = this.scrollerOBJ.getBoundingClientRect();
    const isVertical = this.type === this.editor.scrollerManager.VERTICAL_TYPE;

    if (isVertical) {
      const maxScroll =
        this.scrollerOBJ.clientHeight - this.itemOBJ.clientHeight;
      if (maxScroll <= 0) return;

      const newTop = Math.max(
        0,
        Math.min(
          e.clientY - rect.top - this.itemOBJ.clientHeight / 2,
          maxScroll,
        ),
      );
      this.targetScrollRatio = newTop / maxScroll;
    } else {
      const maxScroll = this.scrollerOBJ.clientWidth - this.itemOBJ.clientWidth;
      if (maxScroll <= 0) return;

      const newLeft = Math.max(
        0,
        Math.min(
          e.clientX - rect.left - this.itemOBJ.clientWidth / 2,
          maxScroll,
        ),
      );
      this.targetScrollRatio = newLeft / maxScroll;
    }

    this.scheduleScrollRender();
  }

  handleMouseUp() {
    if (this.isDragging) this.onScrollEnd();
    this.isDragging = false;
  }

  handleWheel(e) {
    if (!this.active) return;
    e.preventDefault();

    const isVertical = this.type === this.editor.scrollerManager.VERTICAL_TYPE;
    const delta = isVertical ? e.deltaY : e.deltaX;
    const dimension = isVertical
      ? this.scrollerOBJ.clientHeight
      : this.scrollerOBJ.clientWidth;
    const itemSize = isVertical
      ? this.itemOBJ.clientHeight
      : this.itemOBJ.clientWidth;

    const maxScroll = dimension - itemSize;
    if (maxScroll <= 0) return;

    // Dynamic strength based on file size
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

    const visibleItems = Math.ceil(
      this.parentOBJ.clientHeight / this.heightByItem,
    );
    const maxScrollIndex = Math.max(0, this.nbItem - visibleItems);
    let start =
      Math.floor(this.scrollRatio * maxScrollIndex) - this.renderMargin;
    let end = Math.min(start + visibleItems, this.nbItem) + this.renderMargin;

    if (start < 0) start = 0;
    if (end > this.nbItem) end = this.nbItem;

    return { start, end };
  }
}
