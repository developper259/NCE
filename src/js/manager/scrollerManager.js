class ScrollerManager {
  constructor(e) {
    this.editor = e;

    this.VERTICAL_TYPE = 0; // |
    this.HORIZONTAL_TYPE = 1; // -

    this.scrollers = [];

    addEvent("onEvent", this.onEvent.bind(this), this.editor.output);
  }

  onEvent(event) {
    this.refreshAll();
  }

  refreshAll() {
    for (let scroller of this.scrollers) {
      scroller.refresh();
    }
  }

  addScroller(scroller) {
    if (!scroller) return;
    scroller.id = this.scrollers.length;
    scroller.init();

    this.scrollers.push(scroller);
    this.refreshAll();
  }

  createScroller(parent, target, type, isBody) {
    const s = new Scroller(this.editor);
    s.parentOBJ = getElement(parent);
    s.targetOBJ = getElement(target);
    s.type = type;
    s.isBody = isBody;
    s.id = this.scrollers.length;
    return s;
  }

  getScrollerById(id) {
    return this.scrollers.find((s) => s.id === id);
  }
  getScrollerByParent(parent) {
    return this.scrollers.find((s) => s.parentOBJ === parent);
  }
}
