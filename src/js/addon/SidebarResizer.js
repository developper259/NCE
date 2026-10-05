class SidebarResizer {
  constructor(editor) {
    this.editor = editor;
    this.isResizing = false;
    this.currentResizer = null;
    this.startX = 0;
    this.startWidth = 0;
    this.minWidth = 200;
    this.maxWidth = 500;

    this.init();
  }

  init() {
    this.createResizers();
    this.attachEventListeners();
    this.updateResizerPositions();
    this.updateResizerVisibility();
  }

  createResizers() {
    this.leftResizer = document.createElement("div");
    this.leftResizer.className = "sidebar-resizer sidebar-resizer-left";
    this.editor.domManager
      .getElement(".main-section")
      .appendChild(this.leftResizer);

    this.rightResizer = document.createElement("div");
    this.rightResizer.className = "sidebar-resizer sidebar-resizer-right";
    this.editor.domManager
      .getElement(".main-section")
      .appendChild(this.rightResizer);
  }

  attachEventListeners() {
    this.leftResizer.addEventListener("mousedown", (e) =>
      this.startResize(e, "left"),
    );

    this.rightResizer.addEventListener("mousedown", (e) =>
      this.startResize(e, "right"),
    );

    document.addEventListener("mousemove", (e) => this.resize(e));
    document.addEventListener("mouseup", () => this.stopResize());
  }

  startResize(e, side) {
    this.isResizing = true;
    this.currentResizer = side;
    this.startX = e.clientX;

    this.startWidth = this.editor.domManager.getSidebarWidth(side);

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    e.preventDefault();
  }

  resize(e) {
    if (!this.isResizing) return;

    const deltaX = e.clientX - this.startX;
    let newWidth;

    if (this.currentResizer === "left") {
      newWidth = this.startWidth + deltaX;
    } else {
      newWidth = this.startWidth - deltaX;
    }

    newWidth = Math.max(this.minWidth, Math.min(this.maxWidth, newWidth));

    this.applyWidth(newWidth, this.currentResizer);
  }

  stopResize() {
    if (!this.isResizing) return;

    this.isResizing = false;
    this.currentResizer = null;

    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }

  applyWidth(width, side) {
    const sidebar =
      side === "left"
        ? this.editor.domManager.getElement(".sidebar-left")
        : this.editor.domManager.getElement(".sidebar-right");

    if (sidebar) {
      sidebar.style.width = width + "px";
    }
    this.editor.domManager.invalidateSidebarMetrics(side);

    this.editor.sidebarManager.width = width;
    this.editor.sidebarManager.syncEditorLayout();

    this.updateResizerPositions();
    this.updateResizerVisibility();

    this.editor.sidebarManager.scheduleSidebarRefresh(side);
  }

  updateResizerPositions() {
    const sideBarSelectorWidth = this.editor.domManager.sidebarResizer.width;
    const leftSidebarWidth = this.editor.domManager.getSidebarWidth("left");

    this.leftResizer.style.left =
      sideBarSelectorWidth + leftSidebarWidth - 3 + "px";

    const rightSidebarWidth = this.editor.domManager.getSidebarWidth("right");
    this.rightResizer.style.right = rightSidebarWidth - 3 + "px";
  }

  updateResizerVisibility() {
    const leftSidebar = this.editor.domManager.getElement(".sidebar-left");
    const rightSidebar = this.editor.domManager.getElement(".sidebar-right");

    this.leftResizer.style.display = leftSidebar.classList.contains("open")
      ? "block"
      : "none";

    this.rightResizer.style.display = rightSidebar.classList.contains("open")
      ? "block"
      : "none";
  }

  reset() {
    const defaultWidth = 250;
    this.applyWidth(defaultWidth, "left");
    this.applyWidth(defaultWidth, "right");
  }
}
