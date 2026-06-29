class Sidebar {
  constructor(id, title, icon) {
    this.id = id;
    this.title = title;
    this.icon = icon;
    this.isOpen = false;
    this.element = null;
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
    return '';
  }

  refresh() {
    if (this.element && this.isOpen) {
      this.element.innerHTML = this.render();
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
