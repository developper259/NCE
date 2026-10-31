class LspPopover {
  constructor(editor, className = "lsp-popover") {
    this.editor = editor;
    this.element = document.createElement("div");
    this.element.className = className;
    this.element.hidden = true;
    this.element.setAttribute("role", "dialog");
    editor.mainSection?.appendChild(this.element);
  }

  get isVisible() {
    return this.element.hidden === false;
  }

  setContent(content) {
    this.element.replaceChildren();
    if (content instanceof Node) this.element.appendChild(content);
    else if (typeof content === "string") this.element.textContent = content;
  }

  showAt(clientX, clientY, { width = null, align = "left" } = {}) {
    const container = this.editor.mainSection?.getBoundingClientRect();
    if (!container) return;
    this.element.hidden = false;
    if (width) this.element.style.width = `${Math.round(width)}px`;
    else this.element.style.removeProperty("width");
    const rect = this.element.getBoundingClientRect();
    let left = clientX - container.left;
    if (align === "right") left -= rect.width;
    left = Math.max(8, Math.min(left, container.width - rect.width - 8));
    let top = clientY - container.top + 6;
    if (top + rect.height > container.height - 8)
      top = Math.max(8, clientY - container.top - rect.height - 6);
    this.element.style.left = `${Math.round(left)}px`;
    this.element.style.top = `${Math.round(top)}px`;
  }

  hide() {
    if (this.element.hidden) return;
    this.element.hidden = true;
    this.element.replaceChildren();
  }

  destroy() {
    this.element.remove();
  }
}
