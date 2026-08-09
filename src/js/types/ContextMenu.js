class ContextMenuNode {
  constructor(name, callback, keys = null) {
    this.name = name;
    this.callback = callback;
    this.keys = keys;
  }
}
