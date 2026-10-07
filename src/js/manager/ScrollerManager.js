class ScrollerManager {
  constructor(e) {
    this.editor = e;

    this.VERTICAL_TYPE = 0; // |
    this.HORIZONTAL_TYPE = 1; // -

    this.scrollers = [];
    this.nextScrollerId = 0;
    this.destroyedScrollers = new WeakSet();
    this.activeDrag = null;
    this.dragDocument = null;
    this.onDragPointerMove = (event) => this.handleDragPointerMove(event);
    this.onDragPointerUp = (event) => this.handleDragPointerUp(event);
    this.onDragPointerCancel = (event) => this.handleDragPointerCancel(event);
    this.onDragLostPointerCapture = (event) => this.handleDragLostPointerCapture(event);
  }

  refreshAll() {
    if (this.editor.isOnInit) return;
    for (const scroller of [...this.scrollers]) {
      scroller.refreshMetrics();
      scroller.refresh();
    }
  }

  addScroller(scroller) {
    if (!scroller || scroller._destroyed) return null;
    if (this.scrollers.includes(scroller)) return scroller;
    scroller.id = this.nextScrollerId++;
    scroller.manager = this;
    this.scrollers.push(scroller);
    try {
      scroller.init();
    } catch (error) {
      this.removeScroller(scroller);
      scroller.destroy?.();
      throw error;
    }
    this.refreshAll();
    return scroller;
  }

  removeScroller(scroller) {
    if (!scroller) return false;
    if (this.activeDrag?.scroller === scroller) {
      this.finishDrag({ notifyEnd: false });
    }
    let removed = false;
    let index = this.scrollers.indexOf(scroller);
    while (index !== -1) {
      this.scrollers.splice(index, 1);
      removed = true;
      index = this.scrollers.indexOf(scroller);
    }
    if (scroller.manager === this) scroller.id = null;
    return removed;
  }

  destroyScroller(scroller) {
    if (!scroller || this.destroyedScrollers.has(scroller)) return false;
    if (!this.scrollers.includes(scroller) && scroller.manager !== this) return false;
    this.destroyedScrollers.add(scroller);
    this.removeScroller(scroller);
    scroller.destroy?.();
    return true;
  }

  activateScroller(scroller) {
    if (!scroller || !this.scrollers.includes(scroller)) return false;
    scroller.setActive(true);
    return true;
  }

  deactivateScroller(scroller) {
    if (!scroller || !this.scrollers.includes(scroller)) return false;
    if (this.activeDrag?.scroller === scroller) {
      this.finishDrag({ notifyEnd: false });
    }
    scroller.setActive(false);
    return true;
  }

  startDrag(scroller, event) {
    if (
      this.activeDrag ||
      !scroller ||
      !this.scrollers.includes(scroller) ||
      scroller._destroyed ||
      event?.pointerId === undefined ||
      event?.pointerId === null ||
      event?.isPrimary === false ||
      (event?.button !== undefined && event.button !== 0)
    ) {
      return false;
    }

    const captureTarget = event.currentTarget || scroller.itemOBJ;
    if (!captureTarget || !scroller.handlePointerDown(event)) return false;

    this.activeDrag = {
      scroller,
      captureTarget,
      pointerId: event.pointerId,
    };
    this.attachDragListeners();
    try {
      captureTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // The document pipeline still handles the pointer while it remains in
      // the renderer if pointer capture is unavailable for this target.
    }
    return true;
  }

  attachDragListeners() {
    if (this.dragDocument || typeof document === "undefined") return;
    this.dragDocument = document;
    this.dragDocument.addEventListener("pointermove", this.onDragPointerMove);
    this.dragDocument.addEventListener("pointerup", this.onDragPointerUp);
    this.dragDocument.addEventListener("pointercancel", this.onDragPointerCancel);
    this.dragDocument.addEventListener(
      "lostpointercapture",
      this.onDragLostPointerCapture,
    );
  }

  detachDragListeners() {
    if (!this.dragDocument) return;
    this.dragDocument.removeEventListener("pointermove", this.onDragPointerMove);
    this.dragDocument.removeEventListener("pointerup", this.onDragPointerUp);
    this.dragDocument.removeEventListener("pointercancel", this.onDragPointerCancel);
    this.dragDocument.removeEventListener(
      "lostpointercapture",
      this.onDragLostPointerCapture,
    );
    this.dragDocument = null;
  }

  isActiveDragEvent(event) {
    return Boolean(
      this.activeDrag && event?.pointerId === this.activeDrag.pointerId,
    );
  }

  handleDragPointerMove(event) {
    if (!this.isActiveDragEvent(event)) return false;
    this.activeDrag.scroller.handlePointerMove(event);
    return true;
  }

  handleDragPointerUp(event) {
    if (!this.isActiveDragEvent(event)) return false;
    return this.finishDrag();
  }

  handleDragPointerCancel(event) {
    if (!this.isActiveDragEvent(event)) return false;
    return this.finishDrag();
  }

  handleDragLostPointerCapture(event) {
    if (!this.isActiveDragEvent(event)) return false;
    return this.finishDrag({ releaseCapture: false });
  }

  finishDrag({ notifyEnd = true, releaseCapture = true } = {}) {
    const drag = this.activeDrag;
    if (!drag) return false;
    this.activeDrag = null;
    this.detachDragListeners();

    if (releaseCapture) {
      try {
        const hasCapture = drag.captureTarget.hasPointerCapture;
        if (!hasCapture || hasCapture.call(drag.captureTarget, drag.pointerId)) {
          drag.captureTarget.releasePointerCapture?.(drag.pointerId);
        }
      } catch {
        // Capture may already have been released by the browser.
      }
    }

    drag.scroller.handlePointerUp({
      notifyEnd: notifyEnd && !drag.scroller._destroyed,
    });
    return true;
  }

  destroyAll() {
    for (const scroller of [...this.scrollers]) this.destroyScroller(scroller);
  }

  createScroller(parent, type, isBody, options = {}) {
    const s = new Scroller(this.editor, options);
    s.parentOBJ = parent;
    s.type = type;
    s.isBody = isBody;
    s.manager = this;
    return s;
  }

  getScrollerById(id) {
    return this.scrollers.find((s) => s.id === id);
  }
  getScrollerByParent(parent) {
    return this.scrollers.find((s) => s.parentOBJ === parent);
  }
}
