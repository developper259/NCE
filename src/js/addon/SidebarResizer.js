class SidebarResizer {
  constructor(editor) {
    this.editor = editor;
    this.isResizing = false;
    this.currentResizer = null;
    this.startX = 0;
    this.startWidth = 0;
    this.minWidth = 150;
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
    // Create left sidebar resizer
    this.leftResizer = document.createElement("div");
    this.leftResizer.className = "sidebar-resizer sidebar-resizer-left";
    document.querySelector(".main-section").appendChild(this.leftResizer);

    // Create right sidebar resizer
    this.rightResizer = document.createElement("div");
    this.rightResizer.className = "sidebar-resizer sidebar-resizer-right";
    document.querySelector(".main-section").appendChild(this.rightResizer);
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

    const sidebar =
      side === "left"
        ? document.querySelector(".sidebar-left")
        : document.querySelector(".sidebar-right");

    this.startWidth = sidebar.offsetWidth;

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
        ? document.querySelector(".sidebar-left")
        : document.querySelector(".sidebar-right");

    sidebar.style.width = width + "px";

    this.updateResizerPositions();
    this.updateResizerVisibility();

    if (side === "left") {
      const fileManager = this.editor.fileManagerOBJ;
      const editor = this.editor.editorOBJ;
      const totalWidth = this.editor.sidebarManager.selectorWidth + width;

      if (fileManager) {
        fileManager.style.left = totalWidth + "px";
      }
      if (editor) {
        editor.style.left = totalWidth + "px";
        editor.style.width = "";
      }
    }
    this.editor.sidebarManager.width = width;
    this.editor.lineController.resizeWidth();
  }

  updateResizerPositions() {
    const leftSidebar = document.querySelector(".sidebar-left");
    const rightSidebar = document.querySelector(".sidebar-right");

    // Position left resizer on the right edge of left sidebar
    const leftSidebarWidth = leftSidebar.offsetWidth;
    this.leftResizer.style.left = 48 + leftSidebarWidth + "px";

    // Position right resizer on the left edge of right sidebar
    const rightSidebarWidth = rightSidebar.offsetWidth;
    this.rightResizer.style.right = rightSidebarWidth + "px";
  }

  updateResizerVisibility() {
    const leftSidebar = document.querySelector(".sidebar-left");
    const rightSidebar = document.querySelector(".sidebar-right");

    // Hide left resizer if left sidebar is not open
    this.leftResizer.style.display = leftSidebar.classList.contains("open")
      ? "block"
      : "none";

    // Hide right resizer if right sidebar is not open
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
