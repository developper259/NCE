class DOMManager {
  constructor(editor) {
    this.editor = editor;
    this.elementCache = new Map();
    this.fastNodeCache = new WeakMap();
    this.documentRootFast = this.wrapFastNode(document.documentElement);
    window.__domManager = this;

    // =====================================================
    // WINDOW
    // =====================================================

    this.window = {
      width: 0,
      height: 0,
    };

    // =====================================================
    // EDITOR
    // =====================================================

    this.editorDimensions = {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    };

    // =====================================================
    // OUTPUT
    // =====================================================

    this.output = {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    };

    // =====================================================
    // LINE NUMBERS
    // =====================================================

    this.lineNumbers = {
      width: 0,
    };

    // =====================================================
    // TEXT
    // =====================================================

    this.text = {
      lineHeight: 0,
      letterWidth: 0,
    };

    // =====================================================
    // SCROLL
    // =====================================================

    this.scroll = {
      vertical: {
        width: 0,
        height: 0,
      },

      horizontal: {
        width: 0,
        height: 0,
      },
    };

    // =====================================================
    // STATE
    // =====================================================

    this.initialized = false;

    this.lastWindowWidth = 0;
    this.lastWindowHeight = 0;
    this.layoutFrame = null;
    this.pendingLayout = this.createLayoutState();

    this.outputRect = { left: 0, top: 0, width: 0, height: 0 };
    this.sidebarRect = {
      left: { width: 0 },
      right: { width: 0 },
    };
    this.sidebarMetricsValid = { left: false, right: false };
    this.sidebarResizer = { width: 48 };
  }

  // =========================================================
  // INIT
  // =========================================================

  init() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;

    this.measureWindow();
    this.measureElements();
    this.calculate();
    this.apply();
  }

  destroy() {
    if (this.layoutFrame !== null) this.cancelFrame(this.layoutFrame);
    this.layoutFrame = null;
    this.pendingLayout = this.createLayoutState();
    this.initialized = false;
  }

  createLayoutState() {
    return {
      window: false,
      sidebar: false,
      bottomPanel: false,
      sidebarPosition: null,
      sidebarPositionSet: new Set(),
      apply: false,
    };
  }

  // =========================================================
  // WINDOW
  // =========================================================

  measureWindow() {
    this.window.width = window.innerWidth;
    this.window.height = window.innerHeight;

    this.lastWindowWidth = this.window.width;
    this.lastWindowHeight = this.window.height;
  }

  resize() {
    this.scheduleLayout({ window: true });
  }

  getElement(selector, root = document) {
    if (!selector) {
      return null;
    }

    const key = `${root === document ? "document" : root.id || "root"}:${selector}`;
    if (!this.elementCache.has(key)) {
      this.elementCache.set(key, root.querySelector(selector));
    }

    return this.elementCache.get(key);
  }

  getElements(selector, root = document) {
    if (!selector) {
      return [];
    }

    return Array.from(root.querySelectorAll(selector));
  }

  measureElement(el) {
    if (!el) {
      return {
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        right: 0,
        bottom: 0,
        clientWidth: 0,
        clientHeight: 0,
        scrollWidth: 0,
        scrollHeight: 0,
        scrollLeft: 0,
        scrollTop: 0,
      };
    }

    const rect = el.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width || el.offsetWidth || 0,
      height: rect.height || el.offsetHeight || 0,
      right: rect.right,
      bottom: rect.bottom,
      clientWidth: el.clientWidth || rect.width || 0,
      clientHeight: el.clientHeight || rect.height || 0,
      scrollWidth: el.scrollWidth || 0,
      scrollHeight: el.scrollHeight || 0,
      scrollLeft: el.scrollLeft || 0,
      scrollTop: el.scrollTop || 0,
    };
  }

  getElementMetrics(el) {
    return this.measureElement(el);
  }

  createElement(tagName) {
    return document.createElement(tagName);
  }

  createFastElement(tagName) {
    if (typeof FastDOMNode === "undefined") {
      throw new Error("FastDOMNode must be loaded before createFastElement");
    }
    const element = document.createElement(tagName);
    const fastNode = new FastDOMNode(element);
    this.fastNodeCache.set(element, fastNode);
    return fastNode;
  }

  wrapFastNode(node) {
    if (!node) return null;
    if (typeof FastDOMNode === "undefined") return null;
    if (node instanceof FastDOMNode) return node;
    if (typeof node !== "object" || !node.style) return null;
    let fastNode = this.fastNodeCache.get(node);
    if (!fastNode) {
      fastNode = new FastDOMNode(node);
      this.fastNodeCache.set(node, fastNode);
    }
    return fastNode;
  }

  createTextNode(text) {
    return document.createTextNode(text === null || text === undefined ? "" : String(text));
  }

  createFragment() {
    return document.createDocumentFragment();
  }

  replaceChildren(parent, ...children) {
    parent.replaceChildren(...children);
  }

  requestFrame(callback) {
    return requestAnimationFrame(callback);
  }

  scheduleLayout({
    window: windowChanged = false,
    sidebar = false,
    bottomPanel = false,
    sidebarPosition = null,
    apply = false,
  } = {}) {
    this.editor?.performanceMetrics?.increment("layout.requests");
    const pending = this.pendingLayout;
    pending.window ||= windowChanged;
    pending.sidebar ||= sidebar || windowChanged;
    pending.bottomPanel ||= bottomPanel;
    pending.apply ||= apply;
    if (pending.sidebar) {
      if (
        windowChanged ||
        (sidebar && sidebarPosition !== "left" && sidebarPosition !== "right")
      ) {
        pending.sidebarPosition = "all";
        pending.sidebarPositionSet.clear();
      } else if (pending.sidebarPosition !== "all" && sidebarPosition) {
        pending.sidebarPositionSet.add(sidebarPosition);
        pending.sidebarPosition = pending.sidebarPositionSet.size === 1
          ? sidebarPosition
          : "all";
      }
    }

    if (this.layoutFrame !== null) return this.layoutFrame;
    this.editor?.performanceMetrics?.increment("layout.frames");
    this.layoutFrame = this.requestFrame(() => {
      this.layoutFrame = null;
      this.flushLayout();
    });
    return this.layoutFrame;
  }

  flushLayout() {
    this.editor?.performanceMetrics?.increment("layout.flushes");
    const pending = this.pendingLayout;
    this.pendingLayout = this.createLayoutState();
    const hasGeometryWork = pending.window || pending.sidebar ||
      pending.bottomPanel;
    if (!hasGeometryWork && !pending.apply) return false;

    if (pending.window) {
      this.measureWindow();
      this.editor?.bottomPanelManager?.onViewportResize?.();
      this.editor?.sidebarManager?.syncEditorLayout?.(null, { schedule: false });
    } else if (pending.bottomPanel) {
      this.editor?.bottomPanelManager?.onViewportResize?.();
    }
    if (pending.window || pending.bottomPanel)
      this.editor?.bottomPanelManager?.applyLayout?.();
    if (hasGeometryWork) {
      this.measureElements();
      this.calculate();
    }
    this.apply();

    if (pending.window) {
      this.editor?.lineController?.resize?.({ deferScrollerRefresh: true });
      this.editor?.scrollerManager?.refreshAll?.();
      this.editor?.bottomPanelManager?.onLayoutResize?.();
      return true;
    }

    if (pending.bottomPanel) {
      this.editor?.lineController?.resize?.({ deferScrollerRefresh: true });
      this.editor?.scrollerManager?.refreshActive?.();
    }

    if (pending.sidebar) {
      const position = pending.sidebarPosition === "all"
        ? null
        : pending.sidebarPosition;
      this.editor?.sidebarManager?.refreshLayout?.(position);
      this.editor?.bottomPanelManager?.onLayoutResize?.();
      return true;
    }
    if (pending.bottomPanel) {
      this.editor?.bottomPanelManager?.onLayoutResize?.();
      return true;
    }
    return true;
  }

  cancelFrame(id) {
    cancelAnimationFrame(id);
  }

  measureElements() {
    const editor = this.editor;

    if (!editor) {
      return;
    }

    const editorMetrics = this.measureElement(
      editor.editorOBJ || this.getElement(".editor"),
    );
    const outputMetrics = this.measureElement(
      editor.output || this.getElement(".editor-output"),
    );

    this.editorDimensions.width = editorMetrics.width || this.window.width;
    this.editorDimensions.height = editorMetrics.height || this.window.height;

    this.outputRect = outputMetrics;
    this.output.width =
      outputMetrics.width ||
      Math.max(0, this.editorDimensions.width - this.output.x);
    // The output is translated while scrolling and can contain an extra
    // virtualized row. Its own box is therefore not a reliable viewport
    // measurement. The editor is the clipping viewport.
    this.output.height = editorMetrics.clientHeight || editorMetrics.height;

    this.measureSidebar("left");
    this.measureSidebar("right");
  }

  getOutputRect() {
    const editor = this.editor?.editorOBJ || this.getElement(".editor");
    if (editor) {
      const editorRect = editor.getBoundingClientRect();
      const left = editorRect.left + this.output.x;
      const top = editorRect.top;
      const width = Math.max(0, editorRect.width - this.output.x);
      const height = editorRect.height;

      this.outputRect = {
        ...this.outputRect,
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
      };
    }

    return { ...this.outputRect };
  }

  getSidebarWidth(side) {
    if (side !== "left" && side !== "right") return 0;
    if (!this.sidebarMetricsValid[side]) this.measureSidebar(side);
    return this.sidebarRect[side].width || 0;
  }

  measureSidebar(side) {
    if (side !== "left" && side !== "right") return 0;
    const selector = side === "left" ? ".sidebar-left" : ".sidebar-right";
    const metrics = this.measureElement(this.getElement(selector));
    this.sidebarRect[side] = metrics;
    this.sidebarMetricsValid[side] = true;
    return metrics.width || 0;
  }

  invalidateSidebarMetrics(side) {
    if (side === "left" || side === "right") {
      this.sidebarMetricsValid[side] = false;
      return;
    }
    this.sidebarMetricsValid.left = false;
    this.sidebarMetricsValid.right = false;
  }

  // =========================================================
  // CALCULATE
  // =========================================================

  calculate() {
    const editor = this.editor;

    if (!editor) {
      return;
    }

    // =====================================================
    // DIMENSIONS DE BASE DE L'EDITOR
    // =====================================================

    const baseX = Number.isFinite(editor.baseX) ? editor.baseX : 50;

    const baseY = Number.isFinite(editor.baseY) ? editor.baseY : 2;

    const lineHeight = Number.isFinite(editor.posY) ? editor.posY : 23;

    const letterWidth = Number.isFinite(editor.letterSize)
      ? editor.letterSize
      : 10.8;

    // =====================================================
    // TEXT
    // =====================================================

    this.text.lineHeight = lineHeight;

    this.text.letterWidth = letterWidth;

    // =====================================================
    // LINE NUMBERS
    // =====================================================

    this.lineNumbers.width = Math.max(0, baseX - 10);

    // =====================================================
    // EDITOR
    // =====================================================

    this.editorDimensions.x = 0;

    this.editorDimensions.y = 0;

    this.editorDimensions.width = Math.max(
      0,
      this.editorDimensions.width || this.window.width,
    );

    this.editorDimensions.height = Math.max(
      0,
      this.editorDimensions.height || this.window.height,
    );

    // =====================================================
    // OUTPUT
    // =====================================================

    this.output.x = baseX;

    this.output.y = baseY;

    this.output.width = Math.max(0, this.editorDimensions.width - baseX);

    this.output.height = Math.max(0, this.editorDimensions.height);
  }

  // =========================================================
  // LINE NUMBER WIDTH
  // =========================================================

  setLineNumberWidth(width) {
    if (!Number.isFinite(width)) {
      return;
    }

    width = Math.max(0, width);

    const outputX = width + 10;
    const outputWidth = Math.max(
      0,
      this.editorDimensions.width - outputX,
    );
    const changed = this.lineNumbers.width !== width ||
      this.output.x !== outputX || this.output.width !== outputWidth;

    this.lineNumbers.width = width;
    this.output.x = outputX;
    this.output.width = outputWidth;

    if (changed) this.scheduleApply();
  }

  scheduleApply() {
    this.scheduleLayout({ apply: true });
  }

  getLineNumberWidth() {
    return this.lineNumbers.width;
  }

  // =========================================================
  // APPLY
  // =========================================================

  apply() {
    const root = this.documentRootFast;
    if (!root) return;

    root.setCSSVariable("--nce-window-width", `${this.window.width}px`);
    root.setCSSVariable("--nce-window-height", `${this.window.height}px`);
    root.setCSSVariable("--nce-editor-x", `${this.editorDimensions.x}px`);
    root.setCSSVariable("--nce-editor-y", `${this.editorDimensions.y}px`);
    root.setCSSVariable("--nce-editor-width", `${this.editorDimensions.width}px`);
    root.setCSSVariable("--nce-editor-height", `${this.editorDimensions.height}px`);
    root.setCSSVariable("--nce-output-x", `${this.output.x}px`);
    root.setCSSVariable("--nce-output-y", `${this.output.y}px`);
    root.setCSSVariable("--nce-output-width", `${this.output.width}px`);
    root.setCSSVariable("--nce-output-height", `${this.output.height}px`);
    root.setCSSVariable("--nce-line-number-width", `${this.lineNumbers.width}px`);
    root.setCSSVariable("--nce-line-height", `${this.text.lineHeight}px`);
    root.setCSSVariable("--nce-letter-width", `${this.text.letterWidth}px`);
  }

  // =========================================================
  // GETTERS
  // =========================================================

  getWindowWidth() {
    return this.window.width;
  }

  getWindowHeight() {
    return this.window.height;
  }

  getEditorWidth() {
    return this.editorDimensions.width;
  }

  getEditorHeight() {
    return this.editorDimensions.height;
  }

  getEditorX() {
    return this.editorDimensions.x;
  }

  getEditorY() {
    return this.editorDimensions.y;
  }

  getOutputX() {
    return this.output.x;
  }

  getOutputY() {
    return this.output.y;
  }

  getOutputWidth() {
    return this.output.width;
  }

  getOutputHeight() {
    return this.output.height;
  }

  getLineHeight() {
    return this.text.lineHeight;
  }

  getLetterWidth() {
    return this.text.letterWidth;
  }

  // =========================================================
  // OBJECT GETTERS
  // =========================================================

  getWindowDimensions() {
    return {
      width: this.window.width,

      height: this.window.height,
    };
  }

  getEditorDimensions() {
    return {
      x: this.editorDimensions.x,

      y: this.editorDimensions.y,

      width: this.editorDimensions.width,

      height: this.editorDimensions.height,
    };
  }

  getOutputDimensions() {
    return {
      x: this.output.x,

      y: this.output.y,

      width: this.output.width,

      height: this.output.height,
    };
  }

  getLineNumberDimensions() {
    return {
      width: this.lineNumbers.width,
    };
  }

  getTextDimensions() {
    return {
      lineHeight: this.text.lineHeight,

      letterWidth: this.text.letterWidth,
    };
  }

  getScrollDimensions() {
    return {
      vertical: {
        width: this.scroll.vertical.width,

        height: this.scroll.vertical.height,
      },

      horizontal: {
        width: this.scroll.horizontal.width,

        height: this.scroll.horizontal.height,
      },
    };
  }
}
