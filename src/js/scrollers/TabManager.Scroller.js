class TabManagerScroller {
  constructor(editor, tabManager) {
    this.editor = editor;
    this.tabManager = tabManager;
    this.hScroller = null;
    this.container = editor.domManager.getElement(".file-manager");
    this.content = editor.domManager.getElement(".file-manager .files-ul");

    this.clientWidth = 0;
    this.scrollWidth = 0;
    this.scrollLeft = 0;

    this.onNativeScroll = () => this.syncFromContent();
  }

  init() {
    const manager = this.editor.scrollerManager;
    if (!manager || !this.container || !this.content || this.hScroller) {
      return false;
    }

    this.hScroller = manager.createScroller(
      this.container,
      manager.HORIZONTAL_TYPE,
      false,
      { compact: true },
    );
    // The custom track overlays the list, so listen on the shared container.
    // Wheel events then reach the same scroller over either the tabs or thumb.
    this.hScroller.wheelTarget = this.container;
    this.hScroller.onBeforeRefresh = () => {
      this.measureContent();
      this.hScroller.setScrollRatio(this.getScrollRatio());
    };
    this.hScroller.calculProp = () => {
      if (this.scrollWidth <= 0 || this.clientWidth <= 0) return 100;
      return Math.min(100, (this.clientWidth / this.scrollWidth) * 100);
    };
    this.hScroller.calcIsActive = () =>
      this.clientWidth > 0 && this.scrollWidth > this.clientWidth;
    this.hScroller.onScroll = (ratio) => this.applyScrollRatio(ratio);

    this.content.addEventListener("scroll", this.onNativeScroll, {
      passive: true,
    });
    manager.addScroller(this.hScroller);
    this.refresh();
    return true;
  }

  measureContent() {
    if (!this.content) return;
    const metrics = this.editor.domManager.getElementMetrics(this.content);
    this.clientWidth = metrics.clientWidth;
    this.scrollWidth = metrics.scrollWidth;
    this.scrollLeft = metrics.scrollLeft;
  }

  getMaxScroll() {
    return Math.max(0, this.scrollWidth - this.clientWidth);
  }

  getScrollRatio(scrollLeft = this.scrollLeft) {
    const maxScroll = this.getMaxScroll();
    if (maxScroll <= 0) return 0;
    return Math.max(0, Math.min(scrollLeft / maxScroll, 1));
  }

  getVisibleScrollLeft(element) {
    if (!element || this.clientWidth <= 0) return this.scrollLeft;

    const visibleLeft = this.scrollLeft;
    const visibleRight = visibleLeft + this.clientWidth;
    const tabLeft = Number(element.offsetLeft) || 0;
    const tabWidth = Number(element.offsetWidth) || 0;
    const tabRight = tabLeft + tabWidth;
    let nextScrollLeft = visibleLeft;

    if (tabWidth >= this.clientWidth || tabLeft < visibleLeft) {
      nextScrollLeft = tabLeft;
    } else if (tabRight > visibleRight) {
      nextScrollLeft = tabRight - this.clientWidth;
    }

    return Math.max(0, Math.min(nextScrollLeft, this.getMaxScroll()));
  }

  refresh(ensureElement = null) {
    if (!this.hScroller || !this.content) return false;

    this.measureContent();
    const nextScrollLeft = ensureElement
      ? this.getVisibleScrollLeft(ensureElement)
      : Math.min(this.scrollLeft, this.getMaxScroll());
    const shouldScroll = Math.abs(nextScrollLeft - this.scrollLeft) > 0.5;

    if (shouldScroll) this.content.scrollLeft = nextScrollLeft;
    this.measureContent();

    this.hScroller.refreshMetrics();
    this.hScroller.refresh();
    return true;
  }

  ensureElementVisible(element) {
    return this.refresh(element);
  }

  applyScrollRatio(ratio) {
    if (!this.content) return;
    const maxScroll = this.getMaxScroll();
    const normalizedRatio = Number.isFinite(Number(ratio))
      ? Math.max(0, Math.min(Number(ratio), 1))
      : 0;
    const nextScrollLeft = Math.max(
      0,
      Math.min(normalizedRatio * maxScroll, maxScroll),
    );
    if (Math.abs(nextScrollLeft - this.scrollLeft) <= 0.5) return;

    this.scrollLeft = nextScrollLeft;
    this.content.scrollLeft = nextScrollLeft;
  }

  syncFromContent() {
    if (!this.hScroller || !this.content) return;
    this.measureContent();
    this.hScroller.setScrollRatio(this.getScrollRatio());
    this.hScroller.syncThumbPosition();
  }

  destroy() {
    this.content?.removeEventListener("scroll", this.onNativeScroll);
    const manager = this.editor.scrollerManager;
    if (manager?.destroyScroller) manager.destroyScroller(this.hScroller);
    else this.hScroller?.destroy?.();
    this.hScroller = null;
    this.content = null;
    this.container = null;
  }
}
