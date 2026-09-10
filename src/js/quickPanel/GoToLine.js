class GoToLine {
  constructor(editor) {
    this.editor = editor;
  }

  getActiveFile() {
    return this.editor.tabManager?.activeFile || null;
  }

  getTotalLines(file = this.getActiveFile()) {
    return Math.max(1, file?.lines?.length || 1);
  }

  validate(value) {
    const file = this.getActiveFile();
    if (!file) return "No file open.";
    if (file.loadError) return "File is unavailable.";
    if (file.loadingState?.status === "loading") return "File is still loading.";
    const input = String(value ?? "").trim();
    if (!/^[1-9]\d*$/.test(input)) return "Enter a valid line number.";
    const line = Number(input);
    if (!Number.isSafeInteger(line)) return "Enter a valid line number.";
    return null;
  }

  navigate(value) {
    const file = this.getActiveFile();
    if (!file || this.validate(value)) return false;
    const targetLine = Math.min(Number(String(value).trim()), this.getTotalLines(file));
    const cursor = this.editor.cursorController;
    const lineController = this.editor.lineController;
    const isVisible = cursor.isRowVisible(targetLine);
    this.editor.selectController?.unSelectAll?.();
    cursor.setCursorPosition(targetLine, 0, { ensureVisible: isVisible });
    if (!isVisible) {
      const displayIndex = lineController.getDisplayIndexForCursor(targetLine);
      const centeredStart = displayIndex - Math.floor(lineController.maxViewLines / 2);
      lineController.scrollTo(Math.max(0, centeredStart));
    }
    return true;
  }

  open() {
    const panel = this.editor.quickPanel;
    if (!panel) return false;
    if (panel.isOpen("go-to-line")) {
      panel.input?.focus();
      return true;
    }
    const file = this.getActiveFile();
    return panel.open({
      id: "go-to-line",
      mode: "input",
      title: "Go to Line",
      placeholder: "Go to line...",
      message: file ? () => `Line 1 – ${this.getTotalLines()}` : "No file open.",
      validate: (value) => this.validate(value),
      onAccept: (value) => this.navigate(value),
    });
  }
}
