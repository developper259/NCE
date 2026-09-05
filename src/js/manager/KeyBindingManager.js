class KeyBindingManager {
  constructor(e) {
    this.editor = e;
    this.isComposing = false;

    addEvent("keydown", this.onKey.bind(this));
    addEvent("compositionstart", this.onCompositionStart.bind(this));
    addEvent("compositionend", this.onCompositionEnd.bind(this));
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

  isAgentMessageTarget(target) {
    return (
      target instanceof Element &&
      Boolean(target.closest(".agent-sidebar-messages"))
    );
  }

  bindEditor(key, e) {
    if (CONFIG_KEYBINDING_CONTAINSKEY(key)) {
      this.editor.keyBinding.exec(CONFIG_KEYBINDING_GET_KEY(key), e);
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      if (this.editor.tabManager.activeFile && e.key.length == 1) {
        const handled = this.editor.smartTypingController?.handleCharacter(
          e.key,
          e,
        );
        if (!handled) this.editor.writerController.write(e.key);
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
    if (this.isComposing || e.isComposing || e.keyCode === 229) return;

    if (this.isAgentMessageTarget(e.target)) {
      const isModifier = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (isModifier && (key === "c" || key === "a")) return;
    }

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

  onCompositionStart() {
    this.isComposing = true;
  }

  onCompositionEnd() {
    this.isComposing = false;
  }
}
