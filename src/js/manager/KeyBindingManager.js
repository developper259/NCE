class KeyBindingManager {
  constructor(e) {
    this.editor = e;

    addEvent("keydown", this.onKey.bind(this));
  }

  isNativeInputTarget(target) {
    if (!target) return false;

    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      return true;
    }

    if (target instanceof HTMLElement && target.isContentEditable) {
      return true;
    }

    if (
      target instanceof Element &&
      target.closest(
        "input, textarea, select, [contenteditable='true'], [contenteditable='']",
      )
    ) {
      return true;
    }

    return false;
  }

  bindEditor(key, e) {
    if (CONFIG_KEYBINDING_CONTAINSKEY(key)) {
      this.editor.keyBinding.exec(CONFIG_KEYBINDING_GET_KEY(key), e);
    } else {
      if (this.editor.tabManager.activeFile && e.key.length == 1) {
        this.editor.writerController.write(e.key);
      }
    }

    e.preventDefault();
    e.stopPropagation();
  }

  bind(key, e) {
    if (CONFIG_KEYBINDING_CONTAINSKEY(key)) {
      const item = CONFIG_KEYBINDING_GET_KEY(key);

      if (item.in_editor == false) {
        this.editor.keyBinding.exec(item, e);
      }

      e.preventDefault();
      e.stopPropagation();
    }
  }

  onKey(e) {
    if (
      (this.isNativeInputTarget(e.target) && e.key !== "Escape") ||
      !document.hasFocus()
    ) {
      e.stopPropagation();

      return;
    }

    let key = "";

    if (e.key.length == 1) {
      if (e.ctrlKey) key += "Ctrl+";
      if (e.metaKey) key += "Meta+";
      if (e.shiftKey) key += "Shift+";
      if (e.altKey) key += "Alt+";
    }

    key += e.key;

    if (this.editor.selected) {
      this.bindEditor(key, e);
    } else {
      this.bind(key, e);
    }
  }
}
