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

  getShortcutKey(eventKey, e) {
    let key = "";
    if (["Control", "Meta", "Shift", "Alt"].includes(eventKey)) return eventKey;
    if (e.ctrlKey) key += "Ctrl+";
    if (e.metaKey) key += "Meta+";
    if (e.shiftKey) key += "Shift+";
    if (e.altKey) key += "Alt+";
    return key + eventKey;
  }

  bindNativeInput(key, e) {
    if (
      [
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "Backspace",
        "Delete",
        "Enter",
        "Tab",
      ].includes(e.key) &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      return false;
    }
    if (!CONFIG_KEYBINDING_CONTAINSKEY(key)) return false;
    const item = CONFIG_KEYBINDING_GET_KEY(key);
    if (item?.in_editor !== false) {
      if (!this.executeNativeInputAction(item?.action, e.target)) return false;
      e.preventDefault();
      e.stopPropagation();
      return true;
    }
    this.editor.keyBinding.exec(item, e);
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  executeNativeInputAction(action, target) {
    const element =
      target instanceof Element
        ? target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']")
        : null;
    if (!element) return false;

    if (["copy", "cut", "undo", "redo"].includes(action)) {
      return document.execCommand(action) === true;
    }

    if (action === "select_all") {
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) {
        element.select();
      } else {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return true;
    }

    if (action !== "paste") return false;
    const readClipboard = async () => {
      try {
        return await navigator.clipboard.readText();
      } catch (browserError) {
        if (typeof window.api?.readClipboardText === "function") {
          return window.api.readClipboardText();
        }
        throw browserError;
      }
    };
    void readClipboard().then((text) => {
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) {
        const start = element.selectionStart ?? element.value.length;
        const end = element.selectionEnd ?? start;
        element.setRangeText(text, start, end, "end");
        element.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        element.focus();
        document.execCommand("insertText", false, text);
      }
    }).catch((error) => console.error("Native input paste error:", error));
    return true;
  }

  executeAction(action, modifiers = {}) {
    const item = CONFIG_KEYBINDING_GET_ACTION(action);
    if (!item) return false;

    this.editor.keyBinding.exec(item, {
      shiftKey: modifiers.shiftKey === true,
      ctrlKey: modifiers.ctrlKey === true,
      metaKey: modifiers.metaKey === true,
      altKey: modifiers.altKey === true,
    });
    return true;
  }

  onKey(e) {
    if (this.isComposing || e.isComposing || e.keyCode === 229) return;
    const eventKey = CONFIG_KEYBINDING_EVENT_KEY(e);
    if (!eventKey) return;

    // Skip when a shortcut capture is active in settings
    if (document.querySelector(".setting-shortcut-btn.listening")) return;

    if (this.isAgentMessageTarget(e.target)) {
      const isModifier = e.metaKey || e.ctrlKey;
      const key = eventKey.toLowerCase();
      if (isModifier && (key === "c" || key === "a")) return;
    }

    if (!document.hasFocus()) return;

    const key = this.getShortcutKey(eventKey, e);
    if (this.isNativeInputTarget(e.target) && eventKey !== "Escape") {
      this.bindNativeInput(key, e);
      return;
    }

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
