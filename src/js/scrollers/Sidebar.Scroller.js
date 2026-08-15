class SidebarScroller {
  constructor(editor, sidebarOBJ, menuOBJ) {
    this.editor = editor;
    this.sidebarOBJ = sidebarOBJ;
    this.menuOBJ = menuOBJ;
    this.vScroller = null;
    this._observer = null;
    this._resizeObserver = null;

    this.scrollTop = 0;
    this.clientHeight = 0;
    this.scrollHeight = 0;
  }

  updateMetrics() {
    if (!this.menuOBJ) return;
    this.scrollTop = this.menuOBJ.scrollTop;
    this.clientHeight = this.menuOBJ.clientHeight;
    this.scrollHeight = this.menuOBJ.scrollHeight;
  }

  init() {
    if (!this.editor.scrollerManager || !this.sidebarOBJ || !this.menuOBJ)
      return;
    if (this.vScroller) return;

    this.updateMetrics();

    this.vScroller = this.editor.scrollerManager.createScroller(
      this.sidebarOBJ,
      this.editor.scrollerManager.VERTICAL_TYPE,
      false,
    );
    this.editor.scrollerManager.addScroller(this.vScroller);

    this.vScroller.onRefresh = () => {};

    this.vScroller.calculProp = () => {
      if (!this.scrollHeight || !this.clientHeight) return 100;
      if (this.scrollHeight <= this.clientHeight) return 100;
      return (this.clientHeight / this.scrollHeight) * 100;
    };

    this.vScroller.calcIsActive = () => {
      return this.scrollHeight > this.clientHeight;
    };

    this.vScroller.onScroll = (scrollRatio) => {
      const maxScrollTop = this.scrollHeight - this.clientHeight;
      const newScrollTop = scrollRatio * Math.max(0, maxScrollTop);

      this.scrollTop = newScrollTop;
      this.menuOBJ.scrollTop = newScrollTop;
    };

    this._observer = new MutationObserver(() => {
      this.updateMetrics();
      this.refresh();
    });
    this._observer.observe(this.menuOBJ, { childList: true, subtree: true });

    this._resizeObserver = new ResizeObserver(() => {
      this.updateMetrics();
      this.refresh();
    });
    this._resizeObserver.observe(this.menuOBJ);

    this.refresh();
  }

  refresh() {
    if (!this.vScroller) return;

    const maxScrollTop = this.scrollHeight - this.clientHeight;
    const ratio = maxScrollTop > 0 ? this.scrollTop / maxScrollTop : 0;
    this.vScroller.setScrollRatio(ratio);

    this.vScroller.refreshMetrics();
    this.vScroller.refresh();
  }

  destroy() {
    if (this._observer) this._observer.disconnect();
    if (this._resizeObserver) this._resizeObserver.disconnect();
  }
}
