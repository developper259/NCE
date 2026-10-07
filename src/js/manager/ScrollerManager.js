class ScrollerManager {
  constructor(e) {
    this.editor = e;

    this.VERTICAL_TYPE = 0; // |
    this.HORIZONTAL_TYPE = 1; // -

    this.scrollers = [];
    this.nextScrollerId = 0;
    this.destroyedScrollers = new WeakSet();
    this.observerRefreshFrame = null;
    this.observerRefreshCallbacks = new Map();
    this.activeDrag = null;
    this.dragDocument = null;
    this.dragWindow = null;
    this.onDragPointerMove = (event) => this.handleDragPointerMove(event);
    this.onDragPointerUp = (event) => this.handleDragPointerUp(event);
    this.onDragPointerCancel = (event) => this.handleDragPointerCancel(event);
    this.onDragLostPointerCapture = (event) => this.handleDragLostPointerCapture(event);
    this.onDragWindowBlur = () => this.finishDrag();
    this.parentRemovalObserver = null;
    this.observeParentRemoval();
  }

  observeParentRemoval() {
    if (this.parentRemovalObserver || typeof MutationObserver !== "function" ||
        typeof document === "undefined" || !document.documentElement) return;
    this.parentRemovalObserver = new MutationObserver((records) => {
      const removedNodes = [];
      for (const record of records) {
        for (const node of record.removedNodes || []) removedNodes.push(node);
      }
      if (!removedNodes.length) return;
      for (const scroller of [...this.scrollers]) {
        const parent = scroller.parentOBJ;
        if (parent?.isConnected === false && removedNodes.some((node) =>
          node === parent || node.contains?.(parent),
        )) this.destroyScroller(scroller);
      }
    });
    this.parentRemovalObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  refreshAll() {
    if (this.editor.isOnInit) {
      for (const scroller of this.scrollers) scroller._metricsDirty = true;
      return 0;
    }

    let refreshed = 0;
    for (const scroller of [...this.scrollers]) {
      if (scroller.parentOBJ?.isConnected === false) {
        this.destroyScroller(scroller);
        continue;
      }
      scroller._metricsDirty = true;
      if (scroller._suspended) {
        this.editor?.performanceMetrics?.increment(
          "scrollers.skippedHiddenRefreshes",
        );
        continue;
      }
      if (this.refreshScroller(scroller, { forceMetrics: true })) refreshed += 1;
    }
    return refreshed;
  }

  refreshActive() {
    if (this.editor.isOnInit) return 0;
    let refreshed = 0;
    for (const scroller of [...this.scrollers]) {
      if (scroller.parentOBJ?.isConnected === false) {
        this.destroyScroller(scroller);
        continue;
      }
      if (scroller._suspended || !scroller.active) continue;
      if (this.refreshScroller(scroller)) refreshed += 1;
    }
    return refreshed;
  }

  refreshScroller(scroller, {
    forceMetrics = false,
    includeSuspended = false,
    measureInactive = false,
  } = {}) {
    if (!scroller || !this.scrollers.includes(scroller)) return false;
    if (scroller.parentOBJ?.isConnected === false) {
      this.destroyScroller(scroller);
      return false;
    }
    if (this.editor.isOnInit) {
      scroller._metricsDirty = true;
      return false;
    }
    if (scroller._suspended && !includeSuspended) {
      scroller._metricsDirty = true;
      return false;
    }

    const needsMetrics = forceMetrics || scroller._metricsDirty !== false;
    if (!scroller.active && !measureInactive) {
      scroller.refresh();
      this.editor?.performanceMetrics?.increment("scrollers.refreshes");
      if (!scroller.active) {
        if (needsMetrics) scroller._metricsDirty = true;
        return true;
      }
    }

    if (needsMetrics) {
      this.editor?.performanceMetrics?.increment("scrollers.metricReads");
      scroller.refreshMetrics();
    }
    scroller.refresh();
    this.editor?.performanceMetrics?.increment("scrollers.refreshes");
    return true;
  }

  invalidateScroller(scroller) {
    if (!scroller || !this.scrollers.includes(scroller)) return false;
    scroller._metricsDirty = true;
    return this.refreshScroller(scroller);
  }

  scheduleObserverRefresh(owner, callback) {
    if (!owner || typeof callback !== "function") return false;
    this.observerRefreshCallbacks.set(owner, callback);
    if (this.observerRefreshFrame !== null) return true;

    const requestFrame = this.editor?.domManager?.requestFrame ||
      (typeof requestAnimationFrame === "function" ? requestAnimationFrame : null);
    if (!requestFrame) {
      this.observerRefreshCallbacks.delete(owner);
      callback();
      return true;
    }

    this.observerRefreshFrame = requestFrame(() => {
      this.observerRefreshFrame = null;
      const owners = [...this.observerRefreshCallbacks.keys()];
      for (const pendingOwner of owners) {
        const pendingCallback = this.observerRefreshCallbacks.get(pendingOwner);
        if (!pendingCallback) continue;
        this.observerRefreshCallbacks.delete(pendingOwner);
        pendingCallback();
      }
    });
    return true;
  }

  cancelObserverRefresh(owner) {
    if (!owner || !this.observerRefreshCallbacks.delete(owner)) return false;
    if (this.observerRefreshCallbacks.size === 0 && this.observerRefreshFrame !== null) {
      const cancelFrame = this.editor?.domManager?.cancelFrame ||
        (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : null);
      cancelFrame?.(this.observerRefreshFrame);
      this.observerRefreshFrame = null;
    }
    return true;
  }

  cancelObserverRefreshes() {
    this.observerRefreshCallbacks.clear();
    if (this.observerRefreshFrame === null) return;
    const cancelFrame = this.editor?.domManager?.cancelFrame ||
      (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : null);
    cancelFrame?.(this.observerRefreshFrame);
    this.observerRefreshFrame = null;
  }

  addScroller(scroller) {
    if (!scroller || scroller._destroyed) return null;
    if (this.scrollers.includes(scroller)) return scroller;
    this.observeParentRemoval();
    scroller.id = this.nextScrollerId++;
    scroller.manager = this;
    scroller._suspended = false;
    scroller._metricsDirty = true;
    this.scrollers.push(scroller);
    try {
      scroller.init();
    } catch (error) {
      this.removeScroller(scroller);
      scroller.destroy?.();
      throw error;
    }
    this.refreshScroller(scroller, {
      forceMetrics: true,
      measureInactive: true,
    });
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

  activateScroller(scroller, { deferRefresh = false } = {}) {
    if (!scroller || !this.scrollers.includes(scroller)) return false;
    const wasSuspended = scroller._suspended;
    scroller._suspended = false;
    if (wasSuspended) scroller._metricsDirty = true;
    if (wasSuspended || !scroller.active) scroller.setActive(true);
    if (!deferRefresh) {
      this.refreshScroller(scroller, { measureInactive: true });
    }
    return true;
  }

  deactivateScroller(scroller) {
    if (!scroller || !this.scrollers.includes(scroller)) return false;
    scroller._suspended = true;
    scroller._metricsDirty = true;
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
    if (this.dragDocument || this.dragWindow) return;
    if (typeof document !== "undefined") {
      this.dragDocument = document;
      this.dragDocument.addEventListener("pointermove", this.onDragPointerMove);
      this.dragDocument.addEventListener("pointerup", this.onDragPointerUp);
      this.dragDocument.addEventListener("pointercancel", this.onDragPointerCancel);
      this.dragDocument.addEventListener(
        "lostpointercapture",
        this.onDragLostPointerCapture,
      );
    }
    if (typeof window !== "undefined") {
      this.dragWindow = window;
      this.dragWindow.addEventListener("blur", this.onDragWindowBlur);
    }
  }

  detachDragListeners() {
    if (this.dragDocument) {
      this.dragDocument.removeEventListener("pointermove", this.onDragPointerMove);
      this.dragDocument.removeEventListener("pointerup", this.onDragPointerUp);
      this.dragDocument.removeEventListener("pointercancel", this.onDragPointerCancel);
      this.dragDocument.removeEventListener(
        "lostpointercapture",
        this.onDragLostPointerCapture,
      );
    }
    this.dragDocument = null;
    this.dragWindow?.removeEventListener("blur", this.onDragWindowBlur);
    this.dragWindow = null;
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
    this.cancelObserverRefreshes();
    for (const scroller of [...this.scrollers]) this.destroyScroller(scroller);
    this.parentRemovalObserver?.disconnect();
    this.parentRemovalObserver = null;
  }

  createScroller(parent, type, isBody, options = {}) {
    const s = new Scroller(this.editor, options);
    s.parentOBJ = parent;
    s.type = type;
    s.isBody = isBody;
    s.manager = this;
    s._suspended = false;
    s._metricsDirty = true;
    return s;
  }

  getScrollerById(id) {
    return this.scrollers.find((s) => s.id === id);
  }
  getScrollerByParent(parent) {
    return this.scrollers.find((s) => s.parentOBJ === parent);
  }
}
