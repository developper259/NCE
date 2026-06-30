class Sidebar {
  constructor(id, title, icon, editor) {
    this.id = id;
    this.title = title;
    this.icon = icon;
    this.isOpen = false;
    this.element = null;
    this.editor = editor;
  }

  open() {
    this.isOpen = true;
    this.onOpen();
  }

  close() {
    this.isOpen = false;
    this.onClose();
  }

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  render() {
    return document.createElement("div");
  }

  refresh() {
    if (this.element && this.isOpen) {
      this.element.innerHTML = '';
      const content = this.render();

      if (content instanceof Node) {
        this.element.appendChild(content);
      } else {
        this.element.innerHTML = content;
      }
    }
  }

  onOpen() {
    // Override in subclasses
  }

  onClose() {
    // Override in subclasses
  }

  setElement(element) {
    this.element = element;
  }
}