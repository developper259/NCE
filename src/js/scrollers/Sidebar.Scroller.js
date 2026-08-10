class SidebarScroller {
  constructor(editor, sidebarOBJ, menuOBJ) {
    this.editor = editor;
    this.sidebarOBJ = sidebarOBJ;
    this.menuOBJ = menuOBJ;
    this.vScroller = null;
    this._observer = null;
  }

  init() {
    if (!this.editor.scrollerManager || !this.sidebarOBJ || !this.menuOBJ)
      return;
    if (this.vScroller) return;

    this.vScroller = this.editor.scrollerManager.createScroller(
      this.sidebarOBJ,
      this.editor.scrollerManager.VERTICAL_TYPE,
      false,
    );
    this.editor.scrollerManager.addScroller(this.vScroller);

    this.vScroller.onRefresh = () => {};

    this.vScroller.calculProp = () => {
      const { scrollHeight, clientHeight } = this.menuOBJ;
      if (!scrollHeight || !clientHeight) return 100;
      if (scrollHeight <= clientHeight) return 100;
      return (clientHeight / scrollHeight) * 100;
    };

    this.vScroller.calcIsActive = () => {
      const { scrollHeight, clientHeight } = this.menuOBJ;
      return scrollHeight > clientHeight;
    };

    this.vScroller.onScroll = (scrollRatio) => {
      const maxScrollTop =
        this.menuOBJ.scrollHeight - this.menuOBJ.clientHeight;
      this.menuOBJ.scrollTop = scrollRatio * Math.max(0, maxScrollTop);
    };

    this._observer = new MutationObserver(() => this.refresh());
    this._observer.observe(this.menuOBJ, { childList: true, subtree: true });

    this.refresh();
  }

  refresh() {
    if (!this.vScroller) return;

    const maxScrollTop = this.menuOBJ.scrollHeight - this.menuOBJ.clientHeight;
    const ratio = maxScrollTop > 0 ? this.menuOBJ.scrollTop / maxScrollTop : 0;
    this.vScroller.setScrollRatio(ratio);

    this.vScroller.refreshMetrics();
    this.vScroller.refresh();
  }
}
