class SidebarScroller {
  constructor(editor, sidebarOBJ, menuOBJ) {
    this.editor = editor;
    this.sidebarOBJ = sidebarOBJ;
    this.menuOBJ = menuOBJ;
    this.vScroller = null;
    this._observer = null;
    this._resizeObserver = null;
    this.suspended = false;
    this._onNativeScroll = () => this.syncFromMenu();

    this.scrollTop = 0;
    this.clientHeight = 0;
    this.scrollHeight = 0;
  }

  updateMetrics() {
    if (!this.menuOBJ) return;

    const domManager = this.editor && this.editor.domManager;
    if (!domManager) {
      this.scrollTop = this.menuOBJ.scrollTop || 0;
      this.clientHeight = this.menuOBJ.clientHeight || 0;
      this.scrollHeight = this.menuOBJ.scrollHeight || 0;
      return;
    }

    const metrics = domManager.getElementMetrics(this.menuOBJ);
    this.scrollTop = metrics.scrollTop;
    this.clientHeight = metrics.clientHeight;
    this.scrollHeight = metrics.scrollHeight;
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
    this.vScroller.wheelTarget = this.menuOBJ;
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

    this.menuOBJ.addEventListener("scroll", this._onNativeScroll, {
      passive: true,
    });
    this._observer = new MutationObserver(() => this.refresh());
    this._observer.observe(this.menuOBJ, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    this._resizeObserver = new ResizeObserver(() =>
      this.refresh({ invalidateMetrics: true }),
    );
    this._resizeObserver.observe(this.menuOBJ);

    this.refresh();
  }

  refresh({ invalidateMetrics = false } = {}) {
    if (!this.vScroller || this.suspended) return;

    this.updateMetrics();
    const maxScrollTop = this.scrollHeight - this.clientHeight;
    const ratio = maxScrollTop > 0 ? this.scrollTop / maxScrollTop : 0;
    this.vScroller.setScrollRatio(ratio);
    const manager = this.editor.scrollerManager;
    if (invalidateMetrics && manager?.invalidateScroller) {
      manager.invalidateScroller(this.vScroller);
    } else if (manager?.refreshScroller) {
      manager.refreshScroller(this.vScroller);
    }
    else {
      this.vScroller.refreshMetrics();
      this.vScroller.refresh();
    }
  }

  syncFromMenu() {
    if (!this.vScroller || !this.menuOBJ || this.suspended) return;
    this.scrollTop = this.menuOBJ.scrollTop || 0;
    const maxScrollTop = this.scrollHeight - this.clientHeight;
    this.vScroller.setScrollRatio(
      maxScrollTop > 0 ? this.scrollTop / maxScrollTop : 0,
    );
    const manager = this.editor.scrollerManager;
    if (manager?.refreshScroller) manager.refreshScroller(this.vScroller);
    else this.vScroller.syncThumbPosition();
  }

  suspend() {
    this.suspended = true;
    this._observer?.disconnect();
    this.editor.scrollerManager?.deactivateScroller?.(this.vScroller);
  }

  resume() {
    if (!this.suspended) return;
    this.suspended = false;
    this.editor.scrollerManager?.activateScroller?.(this.vScroller, {
      deferRefresh: true,
    });
    this._observer?.observe(this.menuOBJ, {
      childList: true, subtree: true, characterData: true,
    });
    this.refresh();
  }

  destroy() {
    this.menuOBJ?.removeEventListener("scroll", this._onNativeScroll);
    if (this._observer) this._observer.disconnect();
    if (this._resizeObserver) this._resizeObserver.disconnect();
    this._observer = null;
    this._resizeObserver = null;
    const manager = this.editor.scrollerManager;
    if (manager?.destroyScroller) manager.destroyScroller(this.vScroller);
    else this.vScroller?.destroy?.();
    this.vScroller = null;
    this.menuOBJ = null;
    this.sidebarOBJ = null;
  }
}
