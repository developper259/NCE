class DOMManager {
  constructor(editor) {
    this.editor = editor;
    this.elementCache = new Map();
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

    this.outputRect = { left: 0, top: 0, width: 0, height: 0 };
    this.sidebarRect = {
      left: { width: 0 },
      right: { width: 0 },
    };
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
    if (!this.initialized) {
      return;
    }

    this.initialized = false;
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
    const width = window.innerWidth;
    const height = window.innerHeight;

    const editorEl = this.editor && this.editor.editorOBJ;
    const editorHeight = editorEl
      ? editorEl.getBoundingClientRect().height
      : height;

    const outputEl = this.editor && this.editor.output;
    const outputHeight = outputEl
      ? outputEl.getBoundingClientRect().height
      : editorHeight;

    const shouldRefresh =
      width !== this.lastWindowWidth ||
      height !== this.lastWindowHeight ||
      editorHeight !== this.editorDimensions.height ||
      outputHeight !== this.output.height;

    if (!shouldRefresh) {
      return;
    }

    this.window.width = width;
    this.window.height = height;

    this.lastWindowWidth = width;
    this.lastWindowHeight = height;

    this.measureElements();
    this.calculate();
    this.apply();

    if (this.editor && this.editor.lineController) {
      this.editor.lineController.resize();
    }
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
      scrollTop: el.scrollTop || 0,
    };
  }

  getElementMetrics(el) {
    return this.measureElement(el);
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

    this.sidebarRect.left = this.measureElement(
      this.getElement(".sidebar-left"),
    );
    this.sidebarRect.right = this.measureElement(
      this.getElement(".sidebar-right"),
    );
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
    const target =
      side === "left"
        ? this.getElement(".sidebar-left")
        : this.getElement(".sidebar-right");

    if (target) {
      return target.offsetWidth || 0;
    }

    if (side === "left") {
      return this.sidebarRect.left.width || 0;
    }

    if (side === "right") {
      return this.sidebarRect.right.width || 0;
    }

    return 0;
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

    this.lineNumbers.width = width;

    this.output.x = width + 10;

    this.output.width = Math.max(
      0,
      this.editorDimensions.width - this.output.x,
    );

    this.apply();
  }

  getLineNumberWidth() {
    return this.lineNumbers.width;
  }

  // =========================================================
  // APPLY
  // =========================================================

  apply() {
    const root = document.documentElement;

    root.style.setProperty("--nce-window-width", `${this.window.width}px`);

    root.style.setProperty("--nce-window-height", `${this.window.height}px`);

    root.style.setProperty("--nce-editor-x", `${this.editorDimensions.x}px`);

    root.style.setProperty("--nce-editor-y", `${this.editorDimensions.y}px`);

    root.style.setProperty(
      "--nce-editor-width",
      `${this.editorDimensions.width}px`,
    );

    root.style.setProperty(
      "--nce-editor-height",
      `${this.editorDimensions.height}px`,
    );

    root.style.setProperty("--nce-output-x", `${this.output.x}px`);

    root.style.setProperty("--nce-output-y", `${this.output.y}px`);

    root.style.setProperty("--nce-output-width", `${this.output.width}px`);

    root.style.setProperty("--nce-output-height", `${this.output.height}px`);

    root.style.setProperty(
      "--nce-line-number-width",
      `${this.lineNumbers.width}px`,
    );

    root.style.setProperty("--nce-line-height", `${this.text.lineHeight}px`);

    root.style.setProperty("--nce-letter-width", `${this.text.letterWidth}px`);
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
