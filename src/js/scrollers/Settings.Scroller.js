class SettingsScroller {
  constructor(editor, viewport, content) {
    this.editor = editor;
    this.viewport = viewport;
    this.content = content;
    this.vScroller = null;
    this.mutationObserver = null;
    this.resizeObserver = null;
    this.scrollTop = 0;
    this.clientHeight = 0;
    this.scrollHeight = 0;
  }

  updateMetrics() {
    if (!this.content) return;

    const metrics = this.editor.domManager.getElementMetrics(this.content);
    this.scrollTop = metrics.scrollTop;
    this.clientHeight = metrics.clientHeight;
    this.scrollHeight = metrics.scrollHeight;
  }

  init() {
    if (
      this.vScroller ||
      !this.editor.scrollerManager ||
      !this.viewport ||
      !this.content
    ) {
      return;
    }

    this.updateMetrics();
    this.vScroller = this.editor.scrollerManager.createScroller(
      this.viewport,
      this.editor.scrollerManager.VERTICAL_TYPE,
      false,
    );
    this.vScroller.wheelTarget = this.content;
    this.editor.scrollerManager.addScroller(this.vScroller);

    this.vScroller.onRefresh = () => {};
    this.vScroller.calculProp = () => {
      if (!this.scrollHeight || !this.clientHeight) return 100;
      if (this.scrollHeight <= this.clientHeight) return 100;
      return (this.clientHeight / this.scrollHeight) * 100;
    };
    this.vScroller.calcIsActive = () =>
      this.scrollHeight > this.clientHeight;
    this.vScroller.onScroll = (scrollRatio) => {
      const maxScrollTop = Math.max(
        0,
        this.scrollHeight - this.clientHeight,
      );
      this.scrollTop = scrollRatio * maxScrollTop;
      this.content.scrollTop = this.scrollTop;
    };

    this.mutationObserver = new MutationObserver(() => this.refresh());
    this.mutationObserver.observe(this.content, {
      childList: true,
      subtree: true,
    });
    this.resizeObserver = new ResizeObserver(() => this.refresh());
    this.resizeObserver.observe(this.content);

    this.refresh();
  }

  refresh() {
    if (!this.vScroller) return;

    this.updateMetrics();
    const maxScrollTop = this.scrollHeight - this.clientHeight;
    const ratio = maxScrollTop > 0 ? this.scrollTop / maxScrollTop : 0;
    this.vScroller.setScrollRatio(ratio);
    this.vScroller.refreshMetrics();
    this.vScroller.refresh();
  }

  destroy() {
    this.mutationObserver?.disconnect();
    this.resizeObserver?.disconnect();
  }
}
