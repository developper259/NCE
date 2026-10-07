class PictureView {
  static MAX_ZOOM = 300;
  static WHEEL_ZOOM_SENSITIVITY = 0.006;
  static supportedExtensions = new Set([
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".ico",
  ]);
  static previewableExtensions = new Set([...PictureView.supportedExtensions, ".svg"]);

  static isSupportedPath(path) {
    return typeof path === "string" &&
      PictureView.supportedExtensions.has(NCEPath.basename(path).match(/\.[^.]+$/)?.[0]?.toLowerCase());
  }

  static isPreviewablePath(path) {
    return typeof path === "string" &&
      PictureView.previewableExtensions.has(NCEPath.basename(path).match(/\.[^.]+$/)?.[0]?.toLowerCase());
  }

  isPreviewablePath(path) {
    return PictureView.isPreviewablePath(path);
  }

  constructor(editor) {
    this.editor = editor;
    this.host = editor.domManager.getElement(".picture-view-host");
    this.image = this.host?.querySelector(".picture-view-image");
    this.status = this.host?.querySelector(".picture-view-status");
    this.content = this.host?.querySelector(".picture-view-content");
    this.viewport = this.host?.querySelector(".picture-view-viewport");
    this.scroller = null;
    this.zoom = "fit";
    this.loadGeneration = 0;
    this.objectUrl = null;
    this.path = null;
    this.image?.addEventListener("load", () => {
      if (this.image?.src === this.objectUrl) this.onImageLoad();
    });
    this.image?.addEventListener("error", () => {
      if (this.image?.src === this.objectUrl) this.onImageError();
    });
    this.viewport?.addEventListener("wheel", (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const delta = event.deltaMode === 1
        ? event.deltaY * 16
        : event.deltaMode === 2
          ? event.deltaY * this.viewport.clientHeight
          : event.deltaY;
      this.zoomAtPoint(delta, event.clientX, event.clientY);
    }, { passive: false, capture: true });
  }

  show(tab) {
    if (!this.host) return;
    this.host.hidden = false;
    const alreadyInitialized = Boolean(this.scroller);
    if (!this.scroller && this.viewport)
      this.scroller = new PictureViewScroller(this.editor, this.viewport, this.host);
    if (alreadyInitialized) this.scroller?.resume();
    if (tab?.path && tab.path !== this.path) void this.load(tab);
  }

  hide() {
    this.scroller?.suspend();
    if (this.host) this.host.hidden = true;
  }

  setStatus(message, state) {
    if (!this.status) return;
    this.status.textContent = message;
    this.status.dataset.state = state;
    this.status.hidden = !message;
  }

  async load(tabOrPath) {
    const path = typeof tabOrPath === "string" ? tabOrPath : tabOrPath?.path;
    const generation = ++this.loadGeneration;
    this.path = path || null;
    this.releaseObjectUrl();
    if (this.image) this.image.removeAttribute("src");
    if (!path || !PictureView.isPreviewablePath(path)) {
      this.setStatus("Unable to open image.", "error");
      return false;
    }
    this.setStatus("Loading image…", "loading");
    try {
      const result = await this.editor.api.readImageFile(path);
      if (generation !== this.loadGeneration) return false;
      if (!result?.success || !result.data || typeof result.mimeType !== "string") {
        this.setStatus("Unable to open image.", "error");
        return false;
      }
      const blob = new Blob([result.data], { type: result.mimeType });
      const url = URL.createObjectURL(blob);
      if (generation !== this.loadGeneration) {
        URL.revokeObjectURL(url);
        return false;
      }
      this.objectUrl = url;
      this.image.src = url;
      return true;
    } catch {
      if (generation === this.loadGeneration) this.setStatus("Unable to open image.", "error");
      return false;
    }
  }

  onImageLoad() {
    this.setStatus("", "loaded");
    this.applyZoom();
  }

  onImageError() {
    this.releaseObjectUrl();
    this.setStatus("Unable to open image.", "error");
  }

  zoomAtPoint(deltaY, clientX, clientY) {
    if (!this.image?.naturalWidth || !this.image?.naturalHeight || !this.viewport) return;
    const viewportRect = this.viewport.getBoundingClientRect();
    const imageRect = this.image.getBoundingClientRect();
    const pointerX = Number.isFinite(clientX) ? clientX : viewportRect.left + viewportRect.width / 2;
    const pointerY = Number.isFinite(clientY) ? clientY : viewportRect.top + viewportRect.height / 2;
    const imageX = imageRect.width ? (pointerX - imageRect.left) / imageRect.width : 0.5;
    const imageY = imageRect.height ? (pointerY - imageRect.top) / imageRect.height : 0.5;
    const currentZoom = this.zoom === "fit"
      ? (imageRect.width / this.image.naturalWidth) * 100
      : this.zoom;
    const minimumZoom = Math.min(
      100,
      (this.viewport.clientWidth * 0.9 / this.image.naturalWidth) * 100,
      (this.viewport.clientHeight * 0.9 / this.image.naturalHeight) * 100,
    );
    // Scale continuously with trackpad movement so small pinch updates stay smooth.
    const nextZoom = Math.max(minimumZoom, Math.min(PictureView.MAX_ZOOM,
      currentZoom * Math.exp(-deltaY * PictureView.WHEEL_ZOOM_SENSITIVITY),
    ));
    if (Math.abs(nextZoom - currentZoom) < 0.001) return;

    if (nextZoom <= minimumZoom + 0.001) {
      this.zoom = "fit";
      this.viewport.scrollLeft = 0;
      this.viewport.scrollTop = 0;
      this.applyZoom();
      return;
    }

    this.zoom = nextZoom;
    this.applyZoom(false);
    const resizedImage = this.image.getBoundingClientRect();
    const localX = pointerX - viewportRect.left;
    const localY = pointerY - viewportRect.top;
    const desiredPointX = resizedImage.left - viewportRect.left + imageX * resizedImage.width;
    const desiredPointY = resizedImage.top - viewportRect.top + imageY * resizedImage.height;
    this.viewport.scrollLeft += desiredPointX - localX;
    this.viewport.scrollTop += desiredPointY - localY;
    this.scroller?.refresh();
  }

  applyZoom(refreshScroller = true) {
    if (!this.image) return;
    const fit = this.zoom === "fit";
    this.image.classList.toggle("fit", fit);
    this.content?.classList.toggle("zoomed", !fit);
    this.scroller?.setZoomed(!fit);
    this.image.style.width = fit
      ? "auto"
      : `${this.image.naturalWidth * this.zoom / 100}px`;
    this.image.style.height = "auto";
    if (refreshScroller) this.scroller?.refresh();
  }

  releaseObjectUrl() {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  invalidate(path) {
    if (!path || NCEPath.equals(path, this.path)) {
      this.path = null;
      this.releaseObjectUrl();
      this.image?.removeAttribute("src");
      if (this.editor.tabManager.activeTab?.type === TAB_TYPES.PICTURE)
        void this.load(this.editor.tabManager.activeTab);
    }
  }

  clear() {
    ++this.loadGeneration;
    this.releaseObjectUrl();
    this.path = null;
    this.image?.removeAttribute("src");
    this.zoom = "fit";
    if (this.viewport) {
      this.viewport.scrollLeft = 0;
      this.viewport.scrollTop = 0;
    }
    this.applyZoom();
    this.setStatus("", "idle");
  }

  close(tab) {
    if (tab?.path && NCEPath.equals(tab.path, this.path)) this.clear();
  }

  destroy() {
    this.clear();
    this.scroller?.destroy();
  }
}
